import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { readInvoicePdf } from '../infrastructure/invoice-pdf';
import { pickInvoiceNumberFromText } from '../automation/invoice-pdf';
import { AppError, STAGES, MAX_INVOICES, object, parseInput, parseCredentials, preflight, moneyToCents, jobInvoices, invoiceFileName,
  type Credentials, type Invoice, type Job, type WorkerRequest, type WorkerEvent } from '../domain/job';
import { JobStore } from '../infrastructure/job-store';
import type { Advisor } from '../infrastructure/deepseek';
import { invoiceLimitProblems, invoicePartiesFromText } from '../domain/invoice-rules';
import { failureByCode, FAILURE_MESSAGES, type SiteProfile } from '../domain/workflow';
import { buildPlan, type ReimbursementPlan } from '../domain/reimbursement-plan';
import { readPlan, writePlan } from '../infrastructure/reimbursement-plan-store';
import { sessionStatePath } from '../automation/session-state';

export const LOCAL_OWNER = 'local';
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
function assertInvoiceName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length > 180 || !/\.pdf$/i.test(name)
    || /[\/\\\u0000-\u001f]/.test(name)) throw new AppError(400, '请上传 PDF 文件，文件名不能包含路径。');
}

/** Preserve the original basename for both current and legacy OA upload paths.
 * The internal archive stays compatible with existing jobs. */
function prepareNamedInvoice(job: Job, workDir: string): string {
  if (!job.invoice) throw new AppError(400, '任务缺少发票。');
  assertInvoiceName(job.invoice.name);
  const buffer = fs.readFileSync(path.join(workDir, 'invoice.pdf'));
  if (createHash('sha256').update(buffer).digest('hex') !== job.invoice.sha256) {
    throw new AppError(409, '发票文件已发生变化，请停止并检查本地数据。');
  }
  const uploadDir = path.join(workDir, 'upload');
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const file = path.join(uploadDir, job.invoice.name);
  fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' });
  return file;
}
export type LaunchWorker = (request: WorkerRequest, onEvent: (event: WorkerEvent) => void,
  onExit: () => void) => { stop(): void; completeManual?(): void };

export function launchWorker(request: WorkerRequest, onEvent: (event: WorkerEvent) => void, onExit: () => void) {
  // A fresh child process owns all legacy globals, environment, browser and debug artifacts.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'LANG',
    'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_EXECUTABLE_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.env.OA_NETWORK_CAPTURE === 'true') env.OA_NETWORK_CAPTURE_FILE = path.join(request.workDir, 'network.jsonl');
  const rememberedState = request.sessionStateFile || sessionStatePath();
  if (rememberedState) {
    env.OA_REMEMBER_SESSION = 'true';
    env.OA_SESSION_STATE_PATH = rememberedState;
  }
  const child: ChildProcess = fork(path.join(__dirname, '../worker.js'), [], {
    cwd: request.workDir, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;
  const finish = () => {
    if (exited) return;
    exited = true;
    clearTimeout(killTimer);
    onExit();
  };
  child.on('message', message => onEvent(message as WorkerEvent));
  child.once('error', finish);
  child.once('exit', finish);
  child.send(request, error => { if (error) child.kill('SIGTERM'); });
  return { completeManual() { if (!exited && child.connected) child.send({ type: 'manual-complete' }); }, stop() {
    if (exited) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
  } };
}

function decodePdf(value: unknown): { name: string; base64: string; buffer: Buffer } {
  const upload = object(value);
  assertInvoiceName(upload.name);
  if (typeof upload.base64 !== 'string' || upload.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.base64)) {
    throw new AppError(400, 'PDF 文件编码无效或超过 8 MB。');
  }
  const buffer = Buffer.from(upload.base64, 'base64');
  if (buffer.length > MAX_PDF_BYTES || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new AppError(400, '文件不是有效 PDF，或超过 8 MB。');
  }
  return { name: upload.name, base64: upload.base64, buffer };
}

/** A PDF holding several invoices (each on one or more consecutive pages with its number)
 * becomes one PDF per invoice, as if each had been chosen as its own file in OA's upload
 * dialog; pages without an invoice number (itineraries, notices) are left out. A PDF with
 * a single invoice is returned as it is. */
export async function splitInvoicePdf(value: unknown): Promise<{ parts: Array<{ name: string; base64: string; invoice: Invoice }>; skipped: number[] }> {
  const upload = decodePdf(value);
  let pages: string[];
  try { pages = (await readInvoicePdf(upload.buffer)).pages; } catch (cause) {
    const error = new AppError(400, 'PDF 无法解析。请使用未加密、可提取文字的全电发票。');
    error.cause = cause;
    throw error;
  }
  const groups: Array<{ number: string; pages: number[] }> = [];
  const skipped: number[] = [];
  pages.forEach((text, index) => {
    const number = pickInvoiceNumberFromText(text, null);
    if (!number) { skipped.push(index + 1); return; }
    const last = groups[groups.length - 1];
    if (last?.number === number && last.pages[last.pages.length - 1] === index - 1) last.pages.push(index);
    else groups.push({ number, pages: [index] });
  });
  if (groups.length <= 1) {
    const { invoice } = await inspectInvoice(upload);
    return { parts: [{ name: upload.name, base64: upload.base64, invoice }], skipped: [] };
  }
  if (groups.length > MAX_INVOICES) throw new AppError(400, `该 PDF 含 ${groups.length} 张发票，一张报销单最多 ${MAX_INVOICES} 张。`);
  const source = await PDFDocument.load(upload.buffer);
  const stem = upload.name.replace(/\.pdf$/i, '').slice(0, 140);
  const parts = [];
  for (const group of groups) {
    const doc = await PDFDocument.create();
    for (const page of await doc.copyPages(source, group.pages)) doc.addPage(page);
    const name = `${stem}-第${group.pages.map(page => page + 1).join('、')}页.pdf`;
    const base64 = Buffer.from(await doc.save()).toString('base64');
    const { invoice } = await inspectInvoice({ name, base64 });
    if (invoice.number !== group.number) throw new AppError(400, `第 ${group.pages[0] + 1} 页拆出后识别的发票号不一致，请手工拆分该 PDF。`);
    parts.push({ name, base64, invoice });
  }
  return { parts, skipped };
}

export async function inspectInvoice(value: unknown): Promise<{ invoice: Invoice; buffer: Buffer }> {
  const upload = decodePdf(value);
  const { buffer } = upload;
  let number: string | null;
  let amount: string | undefined;
  let parties: { seller?: string; date?: string };
  try {
    const parsed = await readInvoicePdf(buffer);
    number = pickInvoiceNumberFromText(parsed.text || '', null);
    amount = parsed.amount;
    parties = invoicePartiesFromText(parsed.text || '');
  } catch (cause) {
    const error = new AppError(400, 'PDF 无法解析。请使用未加密、可提取文字的全电发票。');
    error.cause = cause;
    throw error;
  }
  if (!number) throw new AppError(400, '无法从 PDF 内容唯一识别 20 位全电发票号码：可能是扫描件、其他票种，或一页上有多张发票。');
  const invoice: Invoice = { name: upload.name, sha256: createHash('sha256').update(buffer).digest('hex'), number, size: buffer.length, amount, ...parties };

  return { invoice, buffer };
}

/** Cookies handed to a worker live only for that run. */
function discardSessionFile(file: string | undefined): void {
  if (file) fs.rmSync(file, { force: true });
}

export class JobService {
  private queue: Array<{ id: string; credentials?: Credentials; sessionStateFile?: string }> = [];
  private active?: { id: string; worker: ReturnType<LaunchWorker>; timer: NodeJS.Timeout };
  private reviewInFlight = new Set<string>();
  private planInFlight = new Set<string>();
  private closing = false;

  constructor(readonly store: JobStore, readonly advisor: Advisor, readonly liveEnabled: boolean,
    private readonly launcher: LaunchWorker = launchWorker, private readonly timeoutMs = 20 * 60_000,
    readonly siteProfile?: SiteProfile) {}

  /** `folder`: OA folder invoices the server has just read; an `invoices` item `{ folderId, number }` must be one of them. */
  async create(value: unknown, trusted: { folder?: Invoice[] } = {}): Promise<Job> {
    const data = object(value);
    if (data.mode !== 'demo' && data.mode !== 'live') throw new AppError(400, '请选择演示或真实 OA 模式。');
    if (data.action !== undefined && data.action !== 'save' && data.action !== 'submit') throw new AppError(400, '执行范围不正确。');
    const rawInput = object(data.input);
    const files: Array<{ invoice: Invoice; buffer?: Buffer }> = [];
    if (data.mode === 'live') {
      const uploads = data.invoices === undefined ? [data.invoice] : data.invoices;
      if (!Array.isArray(uploads) || !uploads.length || uploads.length > MAX_INVOICES) throw new AppError(400, `每张报销单可关联 1–${MAX_INVOICES} 张发票。`);
      for (const upload of uploads) {
        const item = object(upload);
        if (item.folderId === undefined) { files.push(await inspectInvoice(upload)); continue; }
        const picked = trusted.folder?.find(invoice => invoice.folderId === item.folderId && invoice.number === item.number);
        if (!picked) throw new AppError(400, '票夹中的发票须在报销页面选择并经 OA 核对。');
        files.push({ invoice: picked });
      }
      const numbers = files.map(file => file.invoice.number), hashes = files.flatMap(file => file.buffer ? [file.invoice.sha256] : []);
      if (new Set(numbers).size !== files.length || new Set(hashes).size !== hashes.length) throw new AppError(400, '同一张发票上传了多次。');
      const problems = invoiceLimitProblems(files.map(({ invoice }) => ({ number: invoice.number, seller: invoice.seller, date: invoice.date,
        faceCents: invoice.amount ? moneyToCents(invoice.amount) : null, usedCents: invoice.balance ? moneyToCents(invoice.balance) : undefined })));
      if (problems.length) throw new AppError(400, problems.join('\n'));
    }
    const [invoice = null, ...extraInvoices] = files.map(file => file.invoice);
    const amounts = files.map(file => file.invoice.balance ?? file.invoice.amount);
    const total = amounts.length && amounts.every(Boolean)
      ? amounts.reduce((sum, amount) => sum + moneyToCents(amount!), 0) : undefined;
    const totalText = total === undefined ? undefined : `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`;
    const input = parseInput({ ...rawInput, amount: rawInput.amount === undefined || rawInput.amount === '' ? totalText : rawInput.amount });
    if (total !== undefined && moneyToCents(input.amount) > total) throw new AppError(400, '实报金额不能超过发票金额合计。');
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(), ownerId: LOCAL_OWNER, mode: data.mode, action: data.action === 'save' ? 'save' : 'submit', status: 'draft', createdAt: now, updatedAt: now,
      input, invoice, ...(extraInvoices.length ? { extraInvoices } : {}),
      checks: preflight(input, invoice, data.mode === 'demo', extraInvoices),
      events: [{ at: now, message: '任务已创建，材料预检完成，等待确认执行。' }],
    };
    const dir = this.store.directory(job.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    files.forEach((file, index) => { if (file.buffer) fs.writeFileSync(path.join(dir, invoiceFileName(index)), file.buffer, { mode: 0o600 }); });
    this.store.save(job);
    return job;
  }

  /** sessionStateFile: a private storageState inside this job's directory, from a login
   * the local server already performed; the browser reuses it instead of logging in. */
  start(id: string, value: unknown, sessionStateFile?: string): Job {
    try {
      return this.enqueue(id, value, sessionStateFile);
    } catch (error) {
      discardSessionFile(sessionStateFile);
      throw error;
    }
  }

  private enqueue(id: string, value: unknown, sessionStateFile?: string): Job {
    if (this.closing) throw new AppError(503, '服务正在关闭。');
    const job = this.store.get(id, LOCAL_OWNER);
    if (sessionStateFile && path.dirname(path.resolve(sessionStateFile)) !== path.resolve(this.store.directory(id))) {
      throw new AppError(500, '登录状态文件位置不正确。');
    }
    if (['queued', 'running', 'waiting_manual', 'waiting_review'].includes(job.status)) {
      if (sessionStateFile) throw new AppError(409, '该任务已在执行。');
      return job;
    }
    if (job.status !== 'draft') throw new AppError(409, '该任务已执行或结束，不允许自动重放。');
    const data = object(value);
    if (data.confirmed !== true) throw new AppError(400, '请先确认报销信息及执行范围。');
    if (sessionStateFile && data.loginMode !== 'manual') throw new AppError(400, '使用已有登录时不再提交账号密码。');
    if (this.planInFlight.has(id)) throw new AppError(409, '报销 JSON 正在生成，请完成后核对再执行。');
    if (job.plan) {
      readPlan(this.store.directory(id), job);
      if (data.planSha256 !== job.plan.sha256) throw new AppError(409, '报销 JSON 版本已变化，请查看最新方案后重新确认。');
    }
    let credentials: Credentials | undefined;
    const loginMode = data.loginMode ?? (data.credentials ? 'credentials' : 'manual');
    if (loginMode !== 'manual' && loginMode !== 'credentials') throw new AppError(400, '登录方式不正确。');
    if (job.mode === 'live') {
      if (!this.liveEnabled) throw new AppError(403, '真实 OA 执行未启用，请在 .env 中设置 OA_LIVE_ENABLED=true 并重启服务。');
      if (loginMode === 'credentials') credentials = parseCredentials(data.credentials);
      if (!job.invoice) throw new AppError(400, '任务缺少发票。');
      if (jobInvoices(job).some(invoice => invoice.folderId) && (!sessionStateFile || process.env.OA_HTTP_FILL === 'false')) throw new AppError(400, '票夹中的发票只能从报销页面（接口填写）办理。');
      if (job.input.payeeKind === 'bank' && (!sessionStateFile || process.env.OA_HTTP_FILL === 'false' || process.env.OA_HTTP_SUBMIT === 'false')) {
        throw new AppError(400, '银行转账只能从报销页面（接口填写和提交）办理。');
      }
      jobInvoices(job).forEach((invoice, index) => {
        if (invoice.folderId) return;
        const file = fs.readFileSync(path.join(this.store.directory(id), invoiceFileName(index)));
        if (createHash('sha256').update(file).digest('hex') !== invoice.sha256) throw new AppError(409, '发票文件已发生变化，请停止并检查本地数据。');
      });
      if (job.extraInvoices?.length && !sessionStateFile) throw new AppError(400, '多张发票只能从报销页面（接口填写）办理。');
    }
    if (this.queue.length >= 50) throw new AppError(429, '等待任务过多，请稍后再试。');
    const queued = this.store.update(id, LOCAL_OWNER, current => {
      current.status = 'queued';
      current.loginMode = loginMode;
      current.events.push({ at: new Date().toISOString(), message: '用户已确认执行，任务进入队列。' });
    });
    this.queue.push({ id, credentials, sessionStateFile });
    this.pump();
    return this.store.get(queued.id, LOCAL_OWNER);
  }

  cancel(id: string): Job {
    const job = this.store.get(id, LOCAL_OWNER);
    if (!['draft', 'queued', 'running', 'waiting_manual', 'waiting_review'].includes(job.status)) throw new AppError(409, '该任务已结束。');
    for (const item of this.queue) if (item.id === id) discardSessionFile(item.sessionStateFile);
    this.queue = this.queue.filter(item => item.id !== id);
    const updated = this.store.update(id, LOCAL_OWNER, current => {
      current.status = ['running', 'waiting_manual', 'waiting_review'].includes(job.status) ? 'interrupted' : 'cancelled';
      current.events.push({ at: new Date().toISOString(), message: ['running', 'waiting_manual', 'waiting_review'].includes(job.status)
        ? '用户停止执行。已经发生的 OA 操作不会回滚，请核对现有单据。' : '任务已取消，未开始执行。' });
    });
    if (this.active?.id === id) this.active.worker.stop();
    return updated;
  }

  completeManual(id: string, value: unknown): Job {
    const job = this.store.get(id, LOCAL_OWNER);
    if (job.status !== 'waiting_manual' || this.active?.id !== id || !this.active.worker.completeManual) {
      throw new AppError(409, '当前任务没有正在等待的 OA 人工确认。');
    }
    if (object(value).confirmed !== true) throw new AppError(400, '请先在学校 OA 完成流转确认，再明确反馈。');
    const updated = this.store.update(id, LOCAL_OWNER, current => {
      current.status = 'running';
      current.events.push({ at: new Date().toISOString(), message: '用户反馈已在学校 OA 完成人工确认，开始记录或核验结果。' });
    });
    this.active.worker.completeManual();
    return updated;
  }

  async review(id: string, value: unknown): Promise<Job> {
    const data = object(value);
    if (data.consent !== true) throw new AppError(400, '请确认向 DeepSeek 发送具体问题、用途、报销说明和金额。');
    if (typeof data.question !== 'string' || !data.question.trim() || data.question.length > 500) {
      throw new AppError(400, '请填写具体业务歧义（最多 500 字），无需对确定性操作调用模型。');
    }
    const job = this.store.get(id, LOCAL_OWNER);
    if (job.status !== 'draft') throw new AppError(409, '仅可检查待执行的草稿任务。');
    if (this.reviewInFlight.has(id)) throw new AppError(409, '此任务的辅助检查正在进行。');
    this.reviewInFlight.add(id);
    try {
      const advisory = { ...await this.advisor.review(job.input, data.question.trim()), question: data.question.trim() };
      return this.store.update(id, LOCAL_OWNER, current => {
        current.advisory = advisory;
        current.events.push({ at: new Date().toISOString(), message: 'DeepSeek 辅助检查完成，建议供人工参考。' });
      });
    } finally { this.reviewInFlight.delete(id); }
  }

  getPlan(id: string): ReimbursementPlan {
    const job = this.store.get(id, LOCAL_OWNER);
    if (!job.plan) throw new AppError(404, '该任务尚未生成报销 JSON。');
    return readPlan(this.store.directory(id), job);
  }

  async generatePlan(id: string, value: unknown): Promise<Job> {
    if (this.closing) throw new AppError(503, '服务正在关闭。');
    if (object(value).consent !== true) throw new AppError(400, '请同意将用途、说明、金额、附件数、经费参数和票面金额发送至 DeepSeek。');
    const job = this.store.get(id, LOCAL_OWNER);
    if (job.status !== 'draft' || job.mode !== 'live' || !job.invoice) throw new AppError(409, '仅可为已上传发票的真实 OA 草稿生成方案。');
    if (job.extraInvoices?.length) throw new AppError(409, '报销 JSON 方案目前只支持单张发票。');
    if (!this.advisor.generatePlan) throw new AppError(503, '当前 AI 接口未启用方案生成。');
    if (this.planInFlight.has(id)) throw new AppError(409, '报销 JSON 正在生成，请勿重复请求。');
    this.planInFlight.add(id);
    try {
      const file = fs.readFileSync(path.join(this.store.directory(id), 'invoice.pdf'));
      if (createHash('sha256').update(file).digest('hex') !== job.invoice.sha256) throw new AppError(409, '发票文件已改变，请核对原文件。');
      const draft = await this.advisor.generatePlan(job.input, job.invoice.amount);
      const current = this.store.get(id, LOCAL_OWNER);
      if (this.closing || current.status !== 'draft' || JSON.stringify(current.input) !== JSON.stringify(job.input)
        || JSON.stringify(current.invoice) !== JSON.stringify(job.invoice) || current.action !== job.action) {
        throw new AppError(409, '任务状态或参数已变化，本次生成结果未保存。');
      }
      let version = (current.plan?.version || 0) + 1;
      const directory = this.store.directory(id);
      while (fs.existsSync(path.join(directory, `reimbursement.v${version}.json`))) version++;
      const plan = writePlan(directory, buildPlan(current, draft, version));
      return this.store.update(id, LOCAL_OWNER, updated => {
        updated.plan = plan;
        updated.events.push({ at: new Date().toISOString(), message: `DeepSeek 报销 JSON v${version} 已生成并通过参数校验，等待核对执行。` });
      });
    } finally { this.planInFlight.delete(id); }
  }

  reconcile(id: string, value: unknown): Job {
    const job = this.store.get(id, LOCAL_OWNER);
    const data = object(value);
    if (job.mode !== 'live' || !['needs_review', 'failed', 'interrupted'].includes(job.status)) {
      throw new AppError(409, '当前任务不需要人工核验。');
    }
    if (this.active?.id === id) throw new AppError(409, '执行进程尚未完全退出，请稍后核验。');
    if (data.confirmed !== true || !['saved', 'not_saved'].includes(String(data.outcome))) {
      throw new AppError(400, '请先在 OA 核对单据，并明确确认保存结果。');
    }
    return this.store.update(id, LOCAL_OWNER, current => {
      current.status = data.outcome === 'saved' ? 'verified' : 'released';
      current.events.push({ at: new Date().toISOString(), message: data.outcome === 'saved'
        ? '用户已在 OA 人工核验保存结果。此记录不代表已提交或审批通过。'
        : '用户已确认 OA 中没有需保留的报销单，释放本地票据占用；可另建任务，旧记录保留。' });
    });
  }

  private pump(): void {
    if (this.active || this.closing) return;
    const next = this.queue.shift();
    if (!next) return;
    const job = this.store.update(next.id, LOCAL_OWNER, current => {
      current.status = 'running';
      current.events.push({ at: new Date().toISOString(), message: current.mode === 'demo'
        ? '演示开始，所有步骤均为模拟。'         : next.sessionStateFile ? current.action === 'save'
          ? '沿用本页刚完成的学校登录，直接调用 OA 接口填写并保存，不打开浏览器。'
          : process.env.OA_HTTP_SUBMIT === 'false'
            ? '沿用本页刚完成的学校登录，先调用 OA 接口填写并保存，再由浏览器回读核对后提交。'
            : '沿用本页刚完成的学校登录，直接调用 OA 接口填写、保存，回读核对后提交流转，不打开浏览器。'
          : current.loginMode === 'manual'
          ? '正在启动独立浏览器。请在学校认证页面完成登录，成功后自动继续；等待上限 5 分钟。'
          : '正在启动独立浏览器；如遇验证码，请在浏览器内完成。' });
    });
    const onEvent = (event: WorkerEvent) => {
      if (!event || !['running', 'waiting_manual', 'waiting_review'].includes(this.store.get(job.id, LOCAL_OWNER).status)) return;
      this.store.update(job.id, LOCAL_OWNER, current => {
        if (current.status === 'waiting_review' && event.type !== 'failure') return;
        if (event.type === 'stage' && STAGES.includes(event.stage) && ['started', 'completed', 'skipped'].includes(event.state)) {
          current.events.push({ at: new Date().toISOString(), message: event.state === 'started' ? '正在执行' : event.state === 'skipped' ? '已跳过' : '步骤完成',
            stage: event.stage, state: event.state, evidence: event.evidence?.slice(0, 300) });
        } else if (event.type === 'inspection_required' && current.mode === 'live') {
          const code = event.failure?.code;
          current.failure = failureByCode(code && Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'unexpected');
          current.status = 'waiting_review';
          current.events.push({ at: new Date().toISOString(),
            stage: STAGES.includes(event.stage as typeof STAGES[number]) ? event.stage as typeof STAGES[number] : undefined,
            message: current.failure.message,
            evidence: `${current.failure.recovery} 自动操作已停止，浏览器最多保留 5 分钟供查看；可关闭浏览器或点击停止执行。` });
        } else if (event.type === 'submission_validated' && current.mode === 'live' && current.action === 'submit') {
          try {
            if (!current.submissionSummary && /^A\d{1,40}$/.test(event.summary.documentNumber)
              && moneyToCents(event.summary.amount.replace(/[,\s￥¥]/g, '')) === moneyToCents(current.input.amount)) {
              current.submissionSummary = { documentNumber: event.summary.documentNumber, amount: current.input.amount };
              current.events.push({ at: new Date().toISOString(), stage: 'confirm submission',
                message: '表单与流转路线已核对，将只发送一次最终提交。' });
            }
          } catch { /* A malformed or mismatching summary cannot authorize a verified result. */ }
        } else if (event.type === 'manual_required' && current.mode === 'live') {
          current.status = 'waiting_manual';
          current.manualSummary = event.summary;
          current.events.push({ at: new Date().toISOString(), message: '请在已打开的学校 OA 浏览器中完成流转确认，完成后回工作台反馈。浏览器保持打开。' });
        } else if (event.type === 'result' && event.result && typeof event.result.documentNumber === 'string'
          && typeof event.result.amount === 'string') {
          current.result = { ...event.result, documentNumber: event.result.documentNumber.slice(0, 100), amount: event.result.amount.slice(0, 30) };
          const receipt = event.result.receipt;
          let verifiedSubmission = false;
          try {
            verifiedSubmission = current.action === 'submit' && event.result.action === 'submit' && event.result.verification === 'receipt'
              && Boolean(receipt && receipt.documentNumber === event.result.documentNumber
                && receipt.documentNumber === (current.submissionSummary || current.manualSummary)?.documentNumber
                && (receipt.source === 'reloaded_oa_page' ? this.siteProfile?.receipt.submittedStatuses.includes(receipt.status)
                  : receipt.source === 'oa_owner_list' && receipt.status === '提交')
                && moneyToCents(event.result.amount.replace(/[,\s￥¥]/g, '')) === moneyToCents(current.input.amount)
                && moneyToCents(receipt.amount) === moneyToCents(current.input.amount));
          } catch { /* Invalid receipts cannot mark a task submitted. */ }
          if (current.action === 'submit' && event.result.verification === 'receipt' && !verifiedSubmission) {
            current.result.verification = 'unverified';
            delete current.result.receipt;
          }
          current.status = current.mode === 'demo' ? 'completed' : verifiedSubmission
            ? 'submitted' : event.result.verification === 'user_confirmed' ? 'verified' : 'needs_review';
          current.events.push({ at: new Date().toISOString(), message: current.mode === 'demo'
            ? '演示完成，未创建真实 OA 单据。' : current.status === 'submitted' ? '已刷新 OA 并核对单据号、金额和流程状态，流转结果已核验。'
              : current.status === 'verified' ? '用户已确认完成 OA 操作。未配置自动回执，仅记录人工确认。'
                : current.action === 'submit' ? '提交结果尚未取得可靠 OA 回执，禁止自动重试。' : '保存操作结束，请在 OA 核验单据及保存结果。' });
        } else if (event.type === 'failure') {
          const code = event.failure?.code;
          current.failure = failureByCode(code && Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'unexpected');
          current.status = current.failure.uncertain ? 'needs_review' : 'failed';
          current.events.push({ at: new Date().toISOString(), message: current.failure.message, evidence: current.failure.recovery });
        }
      });
    };
    const onExit = () => {
      discardSessionFile(next.sessionStateFile);
      if (['running', 'waiting_manual', 'waiting_review'].includes(this.store.get(job.id, LOCAL_OWNER).status)) this.store.update(job.id, LOCAL_OWNER, current => {
        const wasReview = current.status === 'waiting_review';
        current.status = wasReview && current.failure ? current.failure.uncertain ? 'needs_review' : 'failed' : 'interrupted';
        current.events.push({ at: new Date().toISOString(), message: wasReview
          ? '浏览器查看已结束，任务保持失败状态，不自动重放。' : '执行进程意外退出，请核对 OA 现有单据。' });
      });
      if (this.active?.id === job.id) { clearTimeout(this.active.timer); this.active = undefined; }
      setImmediate(() => this.pump());
    };
    try {
      const workDir = this.store.directory(job.id);
      // Re-read after queueing as well: a changed plan cannot launch a browser.
      if (job.plan) job.input = readPlan(workDir, job).input;
      const invoicePath = job.mode === 'live' ? prepareNamedInvoice(job, workDir) : '';
      const worker = this.launcher({ job, credentials: next.credentials, workDir: this.store.directory(job.id),
        invoicePath, siteProfile: this.siteProfile, ...(next.sessionStateFile ? { sessionStateFile: next.sessionStateFile } : {}) },
      onEvent, onExit);
      const timer = setTimeout(() => {
        if (['running', 'waiting_manual', 'waiting_review'].includes(this.store.get(job.id, LOCAL_OWNER).status)) this.cancel(job.id);
        else worker.stop();
      }, this.timeoutMs);
      timer.unref();
      this.active = { id: job.id, worker, timer };
    } catch { onEvent({ type: 'failure' }); onExit(); }
    // Neither credentials nor raw automation logs are persisted or returned by the API.
    next.credentials = undefined;
  }

  shutdown(): void {
    this.closing = true;
    for (const item of [...this.queue]) this.cancel(item.id);
    if (this.active) {
      const current = this.store.get(this.active.id, LOCAL_OWNER);
      if (['running', 'waiting_manual', 'waiting_review'].includes(current.status)) this.cancel(current.id);
      else this.active.worker.stop();
    }
  }
}
