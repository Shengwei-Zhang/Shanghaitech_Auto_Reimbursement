import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, invoiceFileName, jobInvoices, MAX_INVOICES, object, type FormTarget, type Invoice, type Stage, type WorkerEvent,
  type WorkerRequest } from '../domain/job';
import type { OaHttpClient } from '../automation/http-login';
import { createReimbursementHttp, isBlankApplyMoneyHttp, listApplyMoneyTodosHttp, openFormHttp, openOwnerQueryHttp, searchBudgetHttp,
  type ApplyMoneyTodo, type HttpForm, type QueryDocument } from '../automation/http-bpm';
import { writeSessionState, type StorageState } from '../automation/session-state';
import { inspectInvoice, LOCAL_OWNER, type JobService, type LaunchWorker } from '../application/job-service';
import type { JobStore } from '../infrastructure/job-store';
import { BudgetSearchError } from '../automation/budget-search';
import { cents, fillFormHttp, formInvoiceCount, fundingTabs, HttpFillError, type FillStep } from '../automation/http-fill';
import { HttpSubmitError, submitFormHttp, type HttpSubmitExpectation } from '../automation/http-submit';
import { failureByCode, type FailureCode } from '../domain/workflow';
import { Created, type FormType } from './form-routes';
import { record, type FormHost } from './oa-session';

const DOCUMENT_NUMBER = /^A\d{1,32}$/;
const FUNDING_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** The login plus the OA folder re-read every 报销类型 uses for picked invoices. */
export interface ApplyMoneyHost extends FormHost {
  /** The page's login status (with the opened 用款申请单), the answer to create and select. */
  status(): Record<string, unknown>;
  pickedInvoices(picks: Array<{ folderId: string; number: string }>): Promise<Invoice[]>;
}

/** The job service a 用款申请单 runs in (attached by app.ts): one page → one live job. */
export interface ApplyMoneyJobs { service: JobService; store: JobStore }

/** 用款申请单: its blank forms, its budget query, and its fill and submission as jobs of the job service.
 * Nothing here is shared with another 报销类型; it borrows only the login (ApplyMoneyHost). */
export class ApplyMoneyApi {
  form?: HttpForm;
  /** Listed 用款申请单 checked blank; selection is limited to these. */
  private todos = new Map<string, ApplyMoneyTodo>();
  /** Every listed 用款申请单, checked one by one through checkForm. */
  private candidates = new Map<string, ApplyMoneyTodo>();
  private creating = false;
  private jobs?: ApplyMoneyJobs;

  /** `owner`: whose jobs this browser's 用款申请单 become ('local' on one's own computer). */
  constructor(private readonly host: ApplyMoneyHost, private readonly owner: () => string = () => LOCAL_OWNER) {}

  private get ownerId(): string {
    return this.owner();
  }

  /** The login ended: nothing listed or opened under it is kept. */
  reset(): void {
    this.form = undefined;
    this.todos.clear();
    this.candidates.clear();
  }

  useJobs(jobs: ApplyMoneyJobs): void {
    this.jobs = jobs;
  }

  /** Todo 用款申请单 from the portal (one quick read); none is usable until checkForm says blank. */
  async forms() {
    try {
      const todos = await this.host.read(reader => listApplyMoneyTodosHttp(reader));
      this.candidates = new Map(todos.map(todo => [todo.documentNumber, todo]));
      this.todos = new Map();
      return { forms: todos.map(todo => ({ documentNumber: todo.documentNumber, date: todo.date })) };
    } catch (error) { this.host.fail(error); }
  }

  /** One listed form: an empty 报销单查询 row, and nothing in the editor either (an
   * interrupted fill leaves funding or invoices while that row is still empty). */
  async checkForm(documentNumber: unknown): Promise<{ documentNumber: string; blank: boolean }> {
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.candidates.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前的用款申请单列表中，请刷新列表。');
    try {
      const blank = await this.host.read(async reader => await isBlankApplyMoneyHttp(reader, todo) && !await this.formContent(reader, todo));
      if (blank) this.todos.set(documentNumber, todo);
      else this.todos.delete(documentNumber);
      return { documentNumber, blank };
    } catch (error) { this.host.fail(error); }
  }

  /** What the editor already holds ('' when nothing): linked invoices or a saved funding item. */
  private async formContent(client: OaHttpClient, todo: ApplyMoneyTodo): Promise<string> {
    const form = await openFormHttp(client, todo.target);
    const linked = await formInvoiceCount(client, form);
    if (linked) return `已关联 ${linked} 张发票`;
    const funds = fundingTabs((await client.request(form.url)).text).length;
    return funds ? `已选过 ${funds} 个经费项目` : '';
  }

  async create(body: unknown) {
    if (record(body).confirmed !== true) throw new AppError(400, '新建用款申请单需要明确确认。');
    const client = this.host.session();
    if (this.creating) throw new AppError(409, '正在新建用款申请单，请勿重复提交。');
    this.creating = true;
    try {
      this.form = await this.host.serial(() => createReimbursementHttp(client, 'applyMoney'));
      return this.host.status();
    } catch (error) { this.host.fail(error); }
    finally { this.creating = false; }
  }

  async select(body: unknown) {
    const { documentNumber } = record(body);
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.todos.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前可用的用款申请单列表中，请刷新列表。');
    try {
      this.form = await this.host.serial(async () => {
        if (!await isBlankApplyMoneyHttp(this.host.session(), todo)) {
          this.todos.delete(documentNumber);
          throw new AppError(409, '该用款申请单已经填写了内容，不再是空单，请刷新列表。');
        }
        return openFormHttp(this.host.session(), todo.target);
      });
      return this.host.status();
    } catch (error) { this.host.fail(error); }
  }

  /** What a browser run needs to continue this login on the chosen form. A listed form
   * is re-checked to be still blank; null documentNumber means a new 用款申请单. */
  async handoff(documentNumber: unknown): Promise<{ target?: FormTarget; storageState: StorageState }> {
    const client = this.host.session();
    if (documentNumber === null) return { storageState: client.jar.toStorageState() };
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.todos.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前可用的用款申请单列表中，请刷新列表。');
    try {
      if (!await this.host.read(reader => isBlankApplyMoneyHttp(reader, todo))) {
        this.todos.delete(documentNumber);
        throw new AppError(409, '该用款申请单已经填写了内容，不再是空单，请刷新列表。');
      }
      const detail = await this.host.read(reader => this.formContent(reader, todo));
      if (detail) {
        this.todos.delete(documentNumber);
        throw new AppError(409, `该用款申请单${detail}（主表金额仍为空），不是空单；请改选其他单据或在 OA 中处理。`);
      }
    } catch (error) {
      if (error instanceof HttpFillError) throw new AppError(502, error.message);
      this.host.fail(error);
    }
    // Handed to a job: a second submission with this form waits for a refreshed list, so two
    // queued jobs never both take it before the first one writes to it.
    this.todos.delete(documentNumber);
    return { target: { bizId: todo.target.bizId, taskId: todo.target.taskId, documentNumber },
      storageState: client.jar.toStorageState() };
  }

  /** A handed-off form whose job was not created or not started is selectable again. */
  release(documentNumber: string): void {
    const todo = this.candidates.get(documentNumber);
    if (todo) this.todos.set(documentNumber, todo);
  }

  /** One page → one live job: the chosen blank form (or a new one), the inputs and the
   * invoice; the browser continues the page's school login instead of logging in again. */
  async submit(value: unknown, liveEnabled: boolean) {
    const jobs = this.jobs;
    if (!jobs) throw new AppError(500, '任务服务未启动。');
    const { service, store } = jobs;
    const data = object(value);
    if (data.confirmed !== true) throw new AppError(400, '请先确认全部报销信息。');
    if (data.action !== 'save' && data.action !== 'submit') throw new AppError(400, '请选择只保存，或保存后提交流转。');
    if (!liveEnabled) throw new AppError(403, '真实 OA 执行未启用，请在 .env 中设置 OA_LIVE_ENABLED=true 并重启服务。');
    const uploads = data.invoices === undefined ? [data.invoice] : data.invoices;
    if (!Array.isArray(uploads) || !uploads.length || uploads.length > MAX_INVOICES) throw new AppError(400, `每张报销单可关联 1–${MAX_INVOICES} 张发票。`);
    const numbers: string[] = [];
    const picks: Array<{ folderId: string; number: string }> = [];
    for (const upload of uploads) {
      const item = object(upload);
      let number: string;
      if (item.folderId !== undefined) {
        if (typeof item.folderId !== 'string' || !/^\d{1,32}$/.test(item.folderId) || typeof item.number !== 'string' || !/^\d{20}$/.test(item.number)) {
          throw new AppError(400, '票夹发票参数无效。');
        }
        picks.push({ folderId: item.folderId, number: item.number });
        number = item.number;
      } else {
        const { invoice } = await inspectInvoice(upload);
        if (!invoice.number) throw new AppError(400, '未能从 PDF 识别发票号码，无法核对是否已报销。');
        number = invoice.number;
      }
      if (numbers.includes(number)) throw new AppError(400, `同一张发票（${number}）选择了多次。`);
      numbers.push(number);
    }
    const folder = await this.host.pickedInvoices(picks);
    const { target, storageState } = await this.handoff(data.documentNumber ?? null);
    const { formMode: _mode, target: _target, ...input } = object(data.input);
    const job = await service.create({ mode: 'live', action: data.action, invoices: uploads,
      input: { ...input, ...(target ? { formMode: 'target', target } : { formMode: 'new' }) } }, { folder }, this.ownerId)
      .catch(error => { if (target) this.release(target.documentNumber); throw error; });
    const file = path.join(store.directory(job.id), 'oa-session.json');
    try {
      await writeSessionState(storageState, file);
      const started = service.start(job.id, { confirmed: true, loginMode: 'manual' }, file, this.ownerId);
      this.host.formStarted('用款申请单');
      return started;
    } catch (error) {
      fs.rmSync(file, { force: true });
      service.cancel(job.id, this.ownerId);
      if (target) this.release(target.documentNumber);
      throw error instanceof AppError ? error : new AppError(500, '未能启动执行，任务已取消，没有操作 OA。');
    }
  }

  /** The saved form's submission as the page's own requests, then the 报销单查询 status as
   * receipt. queryAdvance goes out at most once; an unclear outcome is never retried. */
  private async submitSaved(client: OaHttpClient, form: HttpForm, expect: HttpSubmitExpectation, onEvent: (event: WorkerEvent) => void) {
    let phase: Stage = 'prepare submission', advancing = false;
    const stage = (state: 'started' | 'completed' | 'skipped', evidence?: string) => onEvent({ type: 'stage', stage: phase, state, evidence });
    const move = (next: Stage) => { if (next !== phase) { stage('completed'); phase = next; } };
    stage('started', '接口已保存本单，正在用接口回读核对并提交（不启动浏览器）。');
    let route = '';
    try {
      const result = await this.host.serial(() => submitFormHttp(client, form, expect, {
        progress: (step, message) => { move(step === 'advance' ? 'confirm submission' : 'prepare submission'); stage('started', message); },
        validated: summary => { advancing = true; onEvent({ type: 'submission_validated', summary }); },
      }));
      route = `；审批路线：${result.route.map(item => `${item.step} ${item.handler}`).join('、')}`;
      stage('completed', 'OA 已接受提交请求。');
    } catch (error) {
      const failure = error instanceof HttpSubmitError ? error : undefined;
      const detail = failure?.response ? `（${failure.response}）` : '';
      if (failure?.code === 'authentication' || (error as { code?: string })?.code === 'authentication') {
        this.host.reset();
      } else if (failure ? failure.code === 'unknown' : advancing) {
        // queryAdvance went out with an unfamiliar reply: only 报销单查询 can tell what happened.
        stage('skipped', `${failure?.message ?? '接口提交发生异常。'}${detail} 改以“报销单查询”的单据状态为准。`);
      } else {
        const sent = failure ? failure.sent : advancing;
        const row = sent ? await this.host.serial(() => this.host.ownerStatus(client, form.documentNumber)).catch(() => undefined) : undefined;
        const code: FailureCode = sent ? (failure?.code === 'rejected' && row?.status === '预制' ? 'http_submit_rejected' : 'submission_unknown')
          : failure?.code === 'route_unverified' ? 'submission_route_unverified' : 'http_submit_blocked';
        stage('skipped', `已停止：${failure?.message ?? '接口提交发生异常。'}${detail}`);
        onEvent({ type: 'failure', failure: failureByCode(code) });
        return;
      }
      if (!this.host.current()) {
        stage('skipped', `已停止：${failure?.message ?? '学校 OA 登录已失效。'}`);
        onEvent({ type: 'failure', failure: failureByCode(advancing ? 'submission_unknown' : 'http_submit_blocked') });
        return;
      }
    }
    phase = 'verify submission';
    stage('started', '正在“报销单查询”中核对本单状态。');
    const row = await this.host.serial(() => this.host.ownerStatus(client, form.documentNumber, '提交')).catch(() => undefined);
    if (row?.status !== '提交' || cents(row.amount) !== cents(expect.amount)) {
      stage('skipped', `报销单查询显示状态“${row?.status ?? '未读取到'}”，金额 ${row?.amount ?? '—'}。`);
      onEvent({ type: 'failure', failure: failureByCode('submission_unknown') });
      return;
    }
    stage('completed', `报销单查询显示 ${form.documentNumber} 状态“提交”，金额 ${row.amount} 元${route}。`);
    onEvent({ type: 'result', result: { documentNumber: form.documentNumber, amount: expect.amount, action: 'submit', verification: 'receipt',
      receipt: { documentNumber: form.documentNumber, amount: row.amount, status: row.status, verifiedAt: new Date().toISOString(), source: 'oa_owner_list' } } });
  }

  /** LaunchWorker for a live job from this page: the whole fill runs as the captured BPM
   * requests on this login, reported with the browser worker's stages. A submit job is
   * then submitted with the page's requests too (OA_HTTP_SUBMIT=false hands the saved
   * form to `submitWith`, whose browser re-reads it and clicks 提交). */
  fillJob(request: WorkerRequest, onEvent: (event: WorkerEvent) => void, onExit: () => void, submitWith?: LaunchWorker) {
    let stopped = false, created = false;
    let current: Stage | undefined;
    let browser: ReturnType<LaunchWorker> | undefined;
    const stage = (name: Stage, state: 'started' | 'completed' | 'skipped', evidence?: string) =>
      onEvent({ type: 'stage', stage: name, state, evidence });
    const run = async () => {
      const { job } = request;
      const input = job.input, target = input.target;
      const httpSubmit = process.env.OA_HTTP_SUBMIT !== 'false';
      if (!job.invoice?.number || (job.action !== 'save' && !httpSubmit && !(submitWith && request.sessionStateFile))) {
        throw new HttpFillError('invalid_input');
      }
      const invoices = jobInvoices(job).map((invoice, index) => {
        if (invoice.folderId) return { fileName: invoice.name, number: invoice.number, folderId: invoice.folderId };
        const bytes = fs.readFileSync(index ? path.join(request.workDir, invoiceFileName(index)) : request.invoicePath);
        if (createHash('sha256').update(bytes).digest('hex') !== invoice.sha256) throw new HttpFillError('invalid_input');
        return { fileName: invoice.name, bytes, number: invoice.number };
      });
      const client = this.host.session();
      stage(target ? 'select reimbursement form' : 'create reimbursement form', 'started');
      created = !target;
      const form = await this.host.serial(() => target ? openFormHttp(client, target) : createReimbursementHttp(client, 'applyMoney'));
      if (target?.documentNumber && form.documentNumber !== target.documentNumber) throw new HttpFillError('response_invalid');
      stage(target ? 'select reimbursement form' : 'create reimbursement form', 'completed', `已打开 ${form.documentNumber}（接口方式，不启动浏览器）。`);
      const stages: Record<FillStep, Stage> = { funding: 'select funding item', upload: 'attach invoice', invoice: 'attach invoice',
        payment: 'configure payment', save: 'save reimbursement' };
      const result = await this.host.serial(() => fillFormHttp(client, form, {
        fundingKind: input.fundingKindKeyword === '我负责的项目' ? 'responsible' : 'authorized',
        fundingCode: input.fundingKeyword, budgetName: input.budgetKeyword, amount: input.amount,
        attachmentCount: input.attachmentCount, purpose: input.purpose, reason: input.reason, payeeCode: input.payeeCode,
        payeeKind: input.payeeKind, supplierCode: input.supplierCode, remitPurpose: input.remitPurpose,
        invoices,
      }, { stopped: () => stopped, progress: (step, message) => {
        if (stages[step] === current) return onEvent({ type: 'stage', stage: current, state: 'started', evidence: message });
        if (current) stage(current, 'completed');
        current = stages[step];
        stage(current, 'started', message);
      } }));
      if (current) stage(current, 'completed');
      stage('verify saved form', 'completed', `保存回执：报销 ${result.bizData.reimbursementAmount} 元，结算 ${result.bizData.settlementAmount} 元，`
        + `附件 ${result.bizData.attachmentNumber} 张，收款人 ${result.payeeName}。`);
      if (job.action === 'submit' && httpSubmit) {
        if (stopped) throw new HttpFillError('stopped');
        await this.submitSaved(client, form, { fundingCode: input.fundingKeyword, budgetName: input.budgetKeyword, amount: input.amount,
          attachmentCount: input.attachmentCount, payeeCode: input.payeeCode, payeeKind: input.payeeKind, supplierCode: input.supplierCode,
          invoiceNumbers: invoices.map(item => item.number),
          reason: input.reason, managerId: result.managerId || undefined }, onEvent);
        return false;
      }
      if (job.action === 'submit' && submitWith && request.sessionStateFile) {
        if (stopped) throw new HttpFillError('stopped');
        stage('prepare submission', 'started', '接口已保存本单，正在启动浏览器：先逐项回读核对，再点击“提交”和流转确认。');
        await writeSessionState(client.jar.toStorageState(), request.sessionStateFile);
        const target = { bizId: form.context.bizId, taskId: form.context.taskId, documentNumber: form.documentNumber };
        browser = submitWith({ ...request, submitOnly: true, job: { ...job, input: { ...input, formMode: 'target', target } } }, onEvent, onExit);
        return true;
      }
      for (const name of ['prepare submission', 'confirm submission', 'verify submission'] as const) stage(name, 'skipped', '本次仅保存。');
      onEvent({ type: 'result', result: { documentNumber: form.documentNumber, amount: input.amount, action: 'save', verification: 'unverified' } });
      return false;
    };
    run().then(handedOff => { if (!handedOff) onExit(); }, async error => {
      // OA also answers a request it refuses with a redirect, which reads as "登录已失效". Only a
      // session that no longer opens 报销单查询 is really gone; then the whole login is dropped.
      let refused = false;
      if ((error as { code?: string })?.code === 'authentication') {
        const client = this.host.current();
        const alive = client ? await this.host.serial(() => openOwnerQueryHttp(client)).then(() => true, () => false) : false;
        if (alive) refused = true;
        else this.host.reset();
      }
      const fill = error instanceof HttpFillError ? error : undefined;
      const message = refused ? `学校 OA 拒绝了这一步的请求（登录仍然有效），已停止填写。`
        : fill?.message ?? (error instanceof AppError ? error.message : '接口填写发生异常。');
      onEvent({ type: 'stage', stage: current ?? 'prepare reimbursement form', state: 'skipped', evidence: `已停止：${message}` });
      // A fill error knows whether the form was written; a new form it never wrote to stays a blank draft.
      const partial = fill ? Boolean(fill.partial) : created || current !== undefined;
      onEvent({ type: 'failure', failure: failureByCode(partial ? 'http_fill_partial' : 'http_fill_rejected') });
      onExit();
    });
    return {
      stop() { stopped = true; browser?.stop(); },
      completeManual() { browser?.completeManual?.(); },
    };
  }

  /** 支出项目 of a fund for a 用款申请单, with OA's shown balance. */
  async budgets(params: URLSearchParams) {
    const fundingCode = params.get('fundingCode') || '';
    if (!FUNDING_CODE.test(fundingCode)) throw new AppError(400, '经费编号无效。');
    try {
      const query = (reader: OaHttpClient, page: QueryDocument) => searchBudgetHttp(reader, page, { fundingItemsCode: fundingCode, pagesize: 100 });
      // A single "登录超时" can be transient; only a repeated one ends the login.
      const result = await this.host.read((reader, page) => query(reader, page).catch(error => {
        if (error instanceof BudgetSearchError && error.code === 'authentication') return query(reader, page);
        throw error;
      }));
      if (!result.outlays) throw new AppError(502, '预算科目接口返回了无法识别的结构。');
      return { fundingCode, total: result.outlays.total ?? result.outlays.rows.length,
        balance: result.outlays.showAmount ?? '',
        subjects: result.outlays.rows.map(row => ({ code: row.expenditureItemCode, name: row.expenditureItemName,
          quotaCode: row.quotaCode, quotaName: row.quotaName, balance: row.showAmount })) };
    } catch (error) { this.host.fail(error); }
  }

  /** The 报销类型 as the server registry sees it; routes under /api/oa/ (forms, select, budgets) and /api/oa/submit. */
  get type(): FormType {
    return { name: '用款申请单', route: async (method, url, body, context) => {
      switch (`${method} ${url.pathname}`) {
        case 'POST /api/oa/submit': return new Created({ job: await this.submit(await body(), context.liveEnabled) });
        case 'GET /api/oa/forms': return this.forms();
        case 'GET /api/oa/forms/check': return this.checkForm(url.searchParams.get('documentNumber'));
        case 'POST /api/oa/forms': return this.create(await body());
        case 'POST /api/oa/select': return this.select(await body());
        case 'GET /api/oa/budgets': return this.budgets(url.searchParams);
        default: return undefined;
      }
    } };
  }
}
