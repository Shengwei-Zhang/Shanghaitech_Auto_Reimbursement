import { AppError, invoiceFileName, jobInvoices, type FormTarget } from '../domain/job';
import { establishBpmSession, HttpLoginError, IDS_ORIGIN, loginWithPassword, OaHttpClient } from '../automation/http-login';
import { CreateReimbursementError, createReimbursementHttp, isBlankApplyMoneyHttp, listApplyMoneyTodosHttp, openFormHttp,
  openOwnerQueryHttp, searchBudgetHttp, searchFundingHttp, searchOwnerHttp, type ApplyMoneyTodo, type HttpForm, type QueryDocument } from '../automation/http-bpm';
import { writeSessionState, type StorageState } from '../automation/session-state';
import type { LaunchWorker } from '../application/job-service';
import { OpenReimbursementError } from '../automation/open-reimbursement';
import { ReimbursementListError } from '../automation/reimbursement-list';
import { FundingSearchError, FUNDING_KINDS } from '../automation/funding-search';
import { BudgetSearchError } from '../automation/budget-search';
import { TaskSearchError } from '../automation/task-search';
import { checkInvoiceClaimHttp, claimMessage, listFolderInvoicesHttp, InvoiceClaimError, type FolderInvoice, type InvoiceClaim } from '../automation/invoice-claim';
import { cents, fillFormHttp, formInvoiceCount, fundingTabs, HttpFillError, type FillStep } from '../automation/http-fill';
import { HttpSubmitError, submitFormHttp, type HttpSubmitExpectation } from '../automation/http-submit';
import { combinePrintPages, fetchPrintPageHttp, listPrintableHttp, printPermissionHttp, PrintError } from '../automation/http-print';
import { PayeeError, searchSuppliersHttp } from '../automation/http-payee';
import { handleTravelRoute, TravelApi } from './travel-api';
import { randomBytes } from 'node:crypto';
import { renderPrintPdf } from '../infrastructure/print-pdf';

/** A print document served under its token: the HTML page to print, or a PDF to save. */
export interface PrintFile { body: string | Buffer; type: string; filename?: string }
import type { Invoice, Stage, WorkerEvent, WorkerRequest } from '../domain/job';
import { failureByCode, type FailureCode } from '../domain/workflow';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface LoginHooks {
  client?: OaHttpClient;
  /** Called only when CAS asks for a captcha; resolves with the user's answer. */
  solveCaptcha?: (image: Buffer) => Promise<string>;
}
export type PasswordLogin = (username: string, password: string, hooks?: LoginHooks) => Promise<OaHttpClient>;

const CAPTCHA_WAIT_MS = 3 * 60_000;
const CAPTCHA_ANSWER = /^[A-Za-z0-9]{1,10}$/;

function captchaImage(bytes: Buffer): string {
  const type = bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg'
    : bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : '';
  if (!type || bytes.length > 200_000) throw new HttpLoginError('login_page_unrecognized', '验证码图片');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

const DOCUMENT_NUMBER = /^A\d{1,32}$/;
const FUNDING_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '请求格式无效。');
  return body as Record<string, unknown>;
}

/** Each login runs the full CAS → portal → BPM exchange on the server and replaces
 * any previous school session. The password is used only for that exchange. */
export const defaultLogin: PasswordLogin = async (username, password, hooks = {}) => {
  const client = await loginWithPassword({ username, password, ...hooks });
  await establishBpmSession(client);
  return client;
};

export interface LoginEvidence { at: string; userAccount: string; userName: string; savedPassword: boolean; steps: string[] }

export interface SavedCredentials { username: string; password: string }

/** OA_USERNAME / OA_PASSWORD from .env, for test use; the password never leaves the server. */
export function savedCredentials(env: NodeJS.ProcessEnv = process.env): SavedCredentials | undefined {
  const username = env.OA_USERNAME?.trim() ?? '', password = env.OA_PASSWORD ?? '';
  return /^\w{1,32}$/.test(username) && password && password.length <= 128 ? { username, password } : undefined;
}

/** One school session per local server, held only in memory. */
export class OaApi {
  private client?: OaHttpClient;
  private login?: LoginEvidence;
  private form?: HttpForm;
  private direct?: QueryDocument;
  /** Listed 用款申请单 checked blank; selection is limited to these. */
  private todos = new Map<string, ApplyMoneyTodo>();
  /** Every listed 用款申请单, checked one by one through checkForm. */
  private candidates = new Map<string, ApplyMoneyTodo>();
  private creating = false;
  /** Read-only page queries (funds, budgets, blank forms, folders, printing) run on a second BPM
   * session of the same school login, with a queue of their own, so they never wait for a job that
   * holds the main session for minutes. `shared` = no second session could be opened. */
  private reader?: OaHttpClient;
  private shared = false;
  private readQueue: Promise<unknown> = Promise.resolve();
  /** Bills of the last print list: bizId → bill code and print rule ('check' turns 'yes' once OA allows it). */
  /** 境内差旅单, kept apart from the 用款申请单 jobs; it borrows only this login. */
  readonly travel = new TravelApi({
    session: () => this.session(), serial: task => this.serial(task), read: task => this.read(task), reset: () => this.reset(),
    fail: error => this.fail(error), ownerStatus: (client, billCode, until) => this.ownerStatus(client, billCode, until),
  });
  private printable = new Map<string, { billCode: string; print: 'yes' | 'no' | 'check' }>();
  /** Built print documents, served once each under an unguessable token for 10 minutes. */
  private printed = new Map<string, PrintFile & { expires: number }>();
  /** A login paused on the CAS captcha; the password stays only in that login's closure. */
  private captcha?: { client: OaHttpClient; login: Promise<OaHttpClient>; savedPassword: boolean;
    answer: (text: string) => void; cancel: (error: Error) => void; timer: NodeJS.Timeout };
  /** BPM answers overlapping requests on one session with "登录超时" (live 2026-10-15),
   * so every call to it waits for the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A read-only task on the reading session with its 报销单查询 page (ST00 用款申请单 context).
   * A session OA has dropped is opened again once; without a second session, the main one serves. */
  private read<T>(task: (client: OaHttpClient, page: QueryDocument) => Promise<T>): Promise<T> {
    if (this.shared) return this.serial(async () => task(this.session(), await this.readPage(this.session())));
    const run = async () => {
      if (!this.reader) {
        const reader = this.session().fork();
        try { this.direct = await this.readPage(reader, true); }
        catch {
          // The CAS login did not open a second BPM session: fall back to the main one.
          this.shared = true;
          return this.serial(async () => task(this.session(), await this.readPage(this.session(), true)));
        }
        this.reader = reader;
      }
      return task(this.reader, await this.readPage(this.reader));
    };
    const job = this.readQueue.then(() => run().catch(error => {
      if ((error as { code?: string })?.code !== 'authentication' || !this.reader) throw error;
      this.reader = undefined;
      this.direct = undefined;
      return run();
    }));
    this.readQueue = job.catch(() => undefined);
    return job;
  }

  private async readPage(client: OaHttpClient, fresh = false): Promise<QueryDocument> {
    if (fresh) this.direct = undefined;
    this.direct ??= { ...await openOwnerQueryHttp(client), context: { accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
    return this.direct;
  }

  constructor(private readonly signInWith: PasswordLogin = defaultLogin,
    private readonly saved: SavedCredentials | undefined = savedCredentials()) {}

  private session(): OaHttpClient {
    if (!this.client) throw new AppError(401, '请先登录学校 OA。');
    return this.client;
  }

  private reset(): void {
    this.dropCaptcha();
    this.client = undefined;
    this.login = undefined;
    this.form = undefined;
    this.direct = undefined;
    this.reader = undefined;
    this.shared = false;
    this.todos.clear();
    this.candidates.clear();
    this.printable.clear();
    this.printed.clear();
  }

  private fail(error: unknown): never {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string })?.code === 'authentication') {
      this.reset();
      throw new AppError(401, '学校 OA 登录已失效，请重新登录。');
    }
    if (error instanceof HttpLoginError || error instanceof CreateReimbursementError || error instanceof OpenReimbursementError
      || error instanceof ReimbursementListError || error instanceof FundingSearchError || error instanceof BudgetSearchError
      || error instanceof TaskSearchError || error instanceof InvoiceClaimError || error instanceof PrintError || error instanceof PayeeError) {
      throw new AppError(error instanceof HttpLoginError && error.code === 'credentials_rejected' ? 401 : 502, error.message);
    }
    throw new AppError(502, '学校 OA 请求未完成，请检查校园网络/VPN 后重试。');
  }

  status() {
    return { loggedIn: Boolean(this.client), login: this.login ?? null, form: this.form ? describeForm(this.form) : null,
      savedUsername: this.saved?.username ?? null };
  }

  private dropCaptcha(): void {
    if (!this.captcha) return;
    clearTimeout(this.captcha.timer);
    this.captcha.cancel(new AppError(409, '登录已取消，请重新登录。'));
    this.captcha = undefined;
  }

  /** Second half of a login that stopped on the captcha. */
  private async answerCaptcha(answer: unknown) {
    const pending = this.captcha;
    if (!pending) throw new AppError(409, '验证码已失效，请重新点击登录。');
    if (typeof answer !== 'string' || !CAPTCHA_ANSWER.test(answer.trim())) throw new AppError(400, '请输入图片中的验证码。');
    clearTimeout(pending.timer);
    this.captcha = undefined;
    pending.answer(answer.trim());
    return this.finishLogin(pending.login, pending.savedPassword);
  }

  async refreshCaptcha() {
    const pending = this.captcha;
    if (!pending) throw new AppError(409, '验证码已失效，请重新点击登录。');
    try {
      const image = await pending.client.request(`${IDS_ORIGIN}/authserver/getCaptcha.htl?${Date.now()}`);
      return { captcha: { image: captchaImage(image.bytes) } };
    } catch (error) { this.fail(error); }
  }

  private async finishLogin(login: Promise<OaHttpClient>, savedPassword: boolean) {
    try {
      const client = await login;
      if (!client.account) throw new HttpLoginError('portal_unverified');
      this.client = client;
      this.login = { at: new Date().toISOString(), userAccount: client.account.userAccount, userName: client.account.userName,
        savedPassword,
        steps: ['统一身份认证（CAS）接受账号密码并签发登录票据', `门户 getLoginUser 确认账号 ${client.account.userAccount}`,
          'BPM 报销系统单点登录完成并取得页面令牌'] };
      return this.status();
    } catch (error) { this.fail(error); }
  }

  async signIn(body: unknown) {
    const input = record(body);
    if (input.captcha !== undefined) return this.answerCaptcha(input.captcha);
    const useSaved = input.useSaved === true;
    if (useSaved && !this.saved) throw new AppError(400, '.env 中没有设置 OA_USERNAME / OA_PASSWORD。');
    const username = useSaved ? this.saved!.username : input.username;
    const password = useSaved ? this.saved!.password : input.password;
    if (typeof username !== 'string' || !/^\w{1,32}$/.test(username.trim()) || typeof password !== 'string'
      || !password || password.length > 128) throw new AppError(400, '请输入学号/工号和密码。');
    this.reset();
    const client = new OaHttpClient();
    let asked!: (image: Buffer) => void, answer!: (text: string) => void, cancel!: (error: Error) => void;
    const askedFor = new Promise<Buffer>(resolve => { asked = resolve; });
    const answered = new Promise<string>((resolve, reject) => { answer = resolve; cancel = reject; });
    const login = this.signInWith(username.trim(), password, { client, solveCaptcha: image => { asked(image); return answered; } });
    login.catch(() => undefined);
    const first = await Promise.race([login.then(() => undefined), askedFor]).catch(error => this.fail(error));
    if (!first) return this.finishLogin(login, useSaved);
    let image: string;
    try { image = captchaImage(first); } catch (error) {
      cancel(error as Error);
      this.fail(error);
    }
    const timer = setTimeout(() => {
      if (this.captcha?.login !== login) return;
      this.captcha = undefined;
      cancel(new AppError(409, '验证码等待超时，请重新登录。'));
    }, CAPTCHA_WAIT_MS);
    timer.unref?.();
    this.captcha = { client, login, savedPassword: useSaved, answer, cancel, timer };
    return { ...this.status(), captcha: { image } };
  }

  signOut() {
    this.reset();
    return this.status();
  }

  /** Todo 用款申请单 from the portal (one quick read); none is usable until checkForm says blank. */
  async forms() {
    try {
      const todos = await this.read(reader => listApplyMoneyTodosHttp(reader));
      this.candidates = new Map(todos.map(todo => [todo.documentNumber, todo]));
      this.todos = new Map();
      return { forms: todos.map(todo => ({ documentNumber: todo.documentNumber, date: todo.date })) };
    } catch (error) { this.fail(error); }
  }

  /** One listed form: an empty 报销单查询 row, and nothing in the editor either (an
   * interrupted fill leaves funding or invoices while that row is still empty). */
  async checkForm(documentNumber: unknown): Promise<{ documentNumber: string; blank: boolean }> {
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.candidates.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前的用款申请单列表中，请刷新列表。');
    try {
      const blank = await this.read(async reader => await isBlankApplyMoneyHttp(reader, todo) && !await this.formContent(reader, todo));
      if (blank) this.todos.set(documentNumber, todo);
      else this.todos.delete(documentNumber);
      return { documentNumber, blank };
    } catch (error) { this.fail(error); }
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
    const client = this.session();
    if (this.creating) throw new AppError(409, '正在新建用款申请单，请勿重复提交。');
    this.creating = true;
    try {
      this.form = await this.serial(() => createReimbursementHttp(client, 'applyMoney'));
      return this.status();
    } catch (error) { this.fail(error); }
    finally { this.creating = false; }
  }

  async select(body: unknown) {
    const { documentNumber } = record(body);
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.todos.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前可用的用款申请单列表中，请刷新列表。');
    try {
      this.form = await this.serial(async () => {
        if (!await isBlankApplyMoneyHttp(this.session(), todo)) {
          this.todos.delete(documentNumber);
          throw new AppError(409, '该用款申请单已经填写了内容，不再是空单，请刷新列表。');
        }
        return openFormHttp(this.session(), todo.target);
      });
      return this.status();
    } catch (error) { this.fail(error); }
  }

  /** 报销状态 of an invoice number in the account's OA invoice folders (read-only). */
  async invoiceClaim(number: unknown): Promise<InvoiceClaim & { usable: boolean; message: string }> {
    if (typeof number !== 'string' || !/^\d{20}$/.test(number)) throw new AppError(400, '发票号码应为 20 位数字。');
    try {
      const claim = await this.read((reader, page) => checkInvoiceClaimHttp(reader, page, number));
      const usable = claim.state === 'absent' || (claim.state === 'unclaimed' && !claim.documents?.length);
      return { ...claim, usable, message: claimMessage(claim) };
    } catch (error) { this.fail(error); }
  }

  /** 未报销 invoices of the account's OA folders; `selectable` ones are whole (balance = amount) and on no other form. */
  async folderInvoices(): Promise<{ invoices: Array<FolderInvoice & { selectable: boolean; reason: string }>; truncated: boolean }> {
    try {
      const listed = await this.read((reader, page) => listFolderInvoicesHttp(reader, page));
      return { truncated: listed.truncated, invoices: listed.invoices.map(row => {
        const reason = row.documents.length ? `已关联在单据 ${row.documents.join('、')}，可报余额 ${row.balance} 元。`
          : row.balance !== row.amount ? `可报余额 ${row.balance} 元，与发票金额 ${row.amount} 元不一致。`
          : Number(row.balance) <= 0 ? '可报余额为 0。' : '';
        return { ...row, selectable: !reason, reason };
      }) };
    } catch (error) { this.fail(error); }
  }

  /** Re-reads the folders and returns the picked invoices; each must still be selectable. */
  async pickedInvoices(picks: Array<{ folderId: string; number: string }>): Promise<Invoice[]> {
    if (!picks.length) return [];
    const { invoices } = await this.folderInvoices();
    return picks.map(pick => {
      const row = invoices.find(item => item.folderId === pick.folderId && item.number === pick.number);
      if (!row) throw new AppError(409, `OA 票夹中已找不到未报销的发票 ${pick.number}，请刷新票夹列表。`);
      if (!row.selectable) throw new AppError(409, `发票 ${pick.number} ${row.reason}`);
      return { name: row.fileName || `${row.number}.pdf`, sha256: '', size: 0, number: row.number, amount: row.amount, balance: row.balance,
        seller: row.seller || undefined, date: row.date || undefined, folderId: row.folderId };
    });
  }

  async assertInvoiceUsable(number: unknown): Promise<void> {
    const claim = await this.invoiceClaim(number);
    if (!claim.usable) throw new AppError(409, claim.message);
  }

  /** What a browser run needs to continue this login on the chosen form. A listed form
   * is re-checked to be still blank; null documentNumber means a new 用款申请单. */
  async handoff(documentNumber: unknown): Promise<{ target?: FormTarget; storageState: StorageState }> {
    const client = this.session();
    if (documentNumber === null) return { storageState: client.jar.toStorageState() };
    if (typeof documentNumber !== 'string' || !DOCUMENT_NUMBER.test(documentNumber)) throw new AppError(400, '单据编号格式无效。');
    const todo = this.todos.get(documentNumber);
    if (!todo) throw new AppError(409, '该单据不在当前可用的用款申请单列表中，请刷新列表。');
    try {
      if (!await this.read(reader => isBlankApplyMoneyHttp(reader, todo))) {
        this.todos.delete(documentNumber);
        throw new AppError(409, '该用款申请单已经填写了内容，不再是空单，请刷新列表。');
      }
      const detail = await this.read(reader => this.formContent(reader, todo));
      if (detail) {
        this.todos.delete(documentNumber);
        throw new AppError(409, `该用款申请单${detail}（主表金额仍为空），不是空单；请改选其他单据或在 OA 中处理。`);
      }
    } catch (error) {
      if (error instanceof HttpFillError) throw new AppError(502, error.message);
      this.fail(error);
    }
    // Handed to a job: a second submission with this form waits for a refreshed list, so two
    // queued jobs never both take it before the first one writes to it.
    this.todos.delete(documentNumber);
    return { target: { bizId: todo.target.bizId, taskId: todo.target.taskId, documentNumber },
      storageState: client.jar.toStorageState() };
  }

  /** 报销单查询's newest bills for the print panel, each with OA's print rule. */
  async printList() {
    try {
      const { total, rows } = await this.read((reader, page) => listPrintableHttp(reader, page));
      this.printable = new Map(rows.map(row => [row.bizId, { billCode: row.billCode, print: row.print }]));
      return { ...(total === undefined ? {} : { total }), rows: rows.map(row => ({ bizId: row.bizId, billCode: row.billCode, status: row.status,
        statusText: row.statusText, kind: row.kindText, amount: row.reimbursementAmount, remark: row.remark, date: row.fillinDate.slice(0, 10), print: row.print })) };
    } catch (error) { this.fail(error); }
  }

  /** testReimbursementPrintPermission for a listed bill whose status needs it (提交 and others). */
  async printPermission(bizId: unknown): Promise<{ bizId: string; allowed: boolean; message?: string }> {
    const bill = typeof bizId === 'string' ? this.printable.get(bizId) : undefined;
    if (!bill) throw new AppError(409, new PrintError('not_listed').message);
    if (bill.print !== 'check') return { bizId: bizId as string, allowed: bill.print === 'yes' };
    try {
      const result = await this.read((reader, page) => printPermissionHttp(reader, page, bizId as string));
      if (result.allowed) bill.print = 'yes';
      return { bizId: bizId as string, ...result };
    } catch (error) { this.fail(error); }
  }

  /** Fetches each bill's OA print page in turn and joins them into one document; returns its local
   * URL. `format: 'pdf'` renders it to a PDF download named after the bill(s) instead. */
  async printDocument(body: unknown): Promise<{ url: string; bills: string[]; filename?: string }> {
    const { bizIds: ids, format = 'html' } = record(body);
    if (format !== 'html' && format !== 'pdf') throw new AppError(400, '打印格式无效。');
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new AppError(400, '请选择 1–20 张报销单。');
    const bills = ids.map(id => {
      const bill = typeof id === 'string' ? this.printable.get(id) : undefined;
      if (!bill) throw new AppError(409, new PrintError('not_listed').message);
      if (bill.print !== 'yes') throw new AppError(409, `报销单 ${bill.billCode} 当前不能打印。`);
      return { bizId: id as string, billCode: bill.billCode };
    });
    try {
      const pages = [];
      for (const bill of bills) {
        const html = await this.read((reader, page) => fetchPrintPageHttp(reader, page, bill.bizId))
          .catch(error => { throw error instanceof PrintError && error.code === 'not_printable' ? new PrintError('not_printable', `报销单 ${bill.billCode}：${error.message}`) : error; });
        pages.push({ billCode: bill.billCode, html });
      }
      const html = combinePrintPages(pages);
      const file: PrintFile = format === 'pdf'
        ? { body: await (this.renderPdf ?? renderPrintPdf)(html).catch(() => { throw new AppError(500, '未能生成 PDF，请改用打印并在打印对话框中选择“存储为 PDF”。'); }),
          type: 'application/pdf', filename: `${bills.length === 1 ? bills[0].billCode : `报销单-${bills.length}张`}.pdf` }
        : { body: html, type: 'text/html; charset=utf-8' };
      const now = Date.now();
      for (const [key, item] of this.printed) if (item.expires < now) this.printed.delete(key);
      const token = randomBytes(18).toString('base64url');
      this.printed.set(token, { ...file, expires: now + 10 * 60_000 });
      return { url: `/print/${token}`, bills: bills.map(bill => bill.billCode), ...(file.filename ? { filename: file.filename } : {}) };
    } catch (error) { this.fail(error); }
  }

  /** Swapped out in tests; renders the joined print page to a PDF. */
  renderPdf?: (html: string) => Promise<Buffer>;

  /** A built print document or PDF; each token is served once. */
  takePrint(token: string): PrintFile | undefined {
    const item = this.printed.get(token);
    this.printed.delete(token);
    return item && item.expires >= Date.now() ? item : undefined;
  }

  /** 银行汇款 accounts in OA's supplier register whose account name is exactly `name`. */
  async payees(name: unknown): Promise<{ suppliers: Array<{ supplierCode: string; name: string; bank: string; account: string; main: boolean }> }> {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) throw new AppError(400, '请填写 2–100 个字符的银行转账户名。');
    try {
      const found = await this.read((reader, page) => searchSuppliersHttp(reader, page, name));
      // Only the tail of the account goes to the page; the full one stays in OA.
      return { suppliers: found.map(item => ({ supplierCode: item.supplierCode, name: item.name, bank: item.openingBankName || item.ownedBank,
        account: `****${item.account.slice(-4)}`, main: item.main })) };
    } catch (error) { this.fail(error); }
  }

  /** A handed-off form whose job was not created or not started is selectable again. */
  release(documentNumber: string): void {
    const todo = this.candidates.get(documentNumber);
    if (todo) this.todos.set(documentNumber, todo);
  }

  /** 报销单查询 status and amount of one bill; `until` polls briefly for a status change. */
  private async ownerStatus(client: OaHttpClient, billCode: string, until?: string, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
    for (let attempt = 0; ; attempt++) {
      const page = await openOwnerQueryHttp(client);
      const { list } = await searchOwnerHttp(client, page, { billCode });
      const matches = list.rows.filter(row => row.billCode === billCode);
      const row = matches.length === 1 ? { status: matches[0].statusText, amount: matches[0].reimbursementAmount } : undefined;
      if (!until || row?.status === until || attempt >= 2) return row;
      await sleep(2000);
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
      const result = await this.serial(() => submitFormHttp(client, form, expect, {
        progress: (step, message) => { move(step === 'advance' ? 'confirm submission' : 'prepare submission'); stage('started', message); },
        validated: summary => { advancing = true; onEvent({ type: 'submission_validated', summary }); },
      }));
      route = `；审批路线：${result.route.map(item => `${item.step} ${item.handler}`).join('、')}`;
      stage('completed', 'OA 已接受提交请求。');
    } catch (error) {
      const failure = error instanceof HttpSubmitError ? error : undefined;
      const detail = failure?.response ? `（${failure.response}）` : '';
      if (failure?.code === 'authentication' || (error as { code?: string })?.code === 'authentication') {
        this.reset();
      } else if (failure ? failure.code === 'unknown' : advancing) {
        // queryAdvance went out with an unfamiliar reply: only 报销单查询 can tell what happened.
        stage('skipped', `${failure?.message ?? '接口提交发生异常。'}${detail} 改以“报销单查询”的单据状态为准。`);
      } else {
        const sent = failure ? failure.sent : advancing;
        const row = sent ? await this.serial(() => this.ownerStatus(client, form.documentNumber)).catch(() => undefined) : undefined;
        const code: FailureCode = sent ? (failure?.code === 'rejected' && row?.status === '预制' ? 'http_submit_rejected' : 'submission_unknown')
          : failure?.code === 'route_unverified' ? 'submission_route_unverified' : 'http_submit_blocked';
        stage('skipped', `已停止：${failure?.message ?? '接口提交发生异常。'}${detail}`);
        onEvent({ type: 'failure', failure: failureByCode(code) });
        return;
      }
      if (!this.client) {
        stage('skipped', `已停止：${failure?.message ?? '学校 OA 登录已失效。'}`);
        onEvent({ type: 'failure', failure: failureByCode(advancing ? 'submission_unknown' : 'http_submit_blocked') });
        return;
      }
    }
    phase = 'verify submission';
    stage('started', '正在“报销单查询”中核对本单状态。');
    const row = await this.serial(() => this.ownerStatus(client, form.documentNumber, '提交')).catch(() => undefined);
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
      const client = this.session();
      stage(target ? 'select reimbursement form' : 'create reimbursement form', 'started');
      created = !target;
      const form = await this.serial(() => target ? openFormHttp(client, target) : createReimbursementHttp(client, 'applyMoney'));
      if (target?.documentNumber && form.documentNumber !== target.documentNumber) throw new HttpFillError('response_invalid');
      stage(target ? 'select reimbursement form' : 'create reimbursement form', 'completed', `已打开 ${form.documentNumber}（接口方式，不启动浏览器）。`);
      const stages: Record<FillStep, Stage> = { funding: 'select funding item', upload: 'attach invoice', invoice: 'attach invoice',
        payment: 'configure payment', save: 'save reimbursement' };
      const result = await this.serial(() => fillFormHttp(client, form, {
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
        const client = this.client;
        const alive = client ? await this.serial(() => openOwnerQueryHttp(client)).then(() => true, () => false) : false;
        if (alive) refused = true;
        else this.reset();
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

  async funds(params: URLSearchParams) {
    const kind = params.get('kind') || 'authorized';
    if (!Object.hasOwn(FUNDING_KINDS, kind)) throw new AppError(400, '经费类别无效。');
    try {
      const result = await this.read((reader, page) => searchFundingHttp(reader, page,
        { kind: kind as keyof typeof FUNDING_KINDS, pageSize: 100 }));
      return { total: result.list.dataCount ?? result.list.items.length, pageCount: result.list.pageCount ?? 1,
        items: result.list.items.map(item => ({ code: item.projectId, name: item.projectName,
          label: item.label || `${item.projectId}-${item.projectName}`, department: item.departmentName })) };
    } catch (error) { this.fail(error); }
  }

  async budgets(params: URLSearchParams) {
    const fundingCode = params.get('fundingCode') || '';
    if (!FUNDING_CODE.test(fundingCode)) throw new AppError(400, '经费编号无效。');
    try {
      const query = (reader: OaHttpClient, page: QueryDocument) => searchBudgetHttp(reader, page, { fundingItemsCode: fundingCode, pagesize: 100 });
      // A single "登录超时" can be transient; only a repeated one ends the login.
      const result = await this.read((reader, page) => query(reader, page).catch(error => {
        if (error instanceof BudgetSearchError && error.code === 'authentication') return query(reader, page);
        throw error;
      }));
      if (!result.outlays) throw new AppError(502, '预算科目接口返回了无法识别的结构。');
      return { fundingCode, total: result.outlays.total ?? result.outlays.rows.length,
        balance: result.outlays.showAmount ?? '',
        subjects: result.outlays.rows.map(row => ({ code: row.expenditureItemCode, name: row.expenditureItemName,
          quotaCode: row.quotaCode, quotaName: row.quotaName, balance: row.showAmount })) };
    } catch (error) { this.fail(error); }
  }
}

function describeForm(form: HttpForm) {
  return { documentNumber: form.documentNumber, accountBook: form.context.accountBook, reimbursementKind: form.context.reimbursementKind };
}

/** Routes under /api/oa/; the caller has already checked the local session and CSRF token. */
export async function handleOaRoute(api: OaApi, method: string, url: URL, body: () => Promise<unknown>): Promise<unknown | undefined> {
  if (url.pathname === '/api/oa/travel' || url.pathname.startsWith('/api/oa/travel/')) return handleTravelRoute(api.travel, method, url);
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/oa/status': return api.status();
    case 'POST /api/oa/login': return api.signIn(await body());
    case 'POST /api/oa/login/captcha': return api.refreshCaptcha();
    case 'POST /api/oa/logout': return api.signOut();
    case 'GET /api/oa/forms': return api.forms();
    case 'GET /api/oa/forms/check': return api.checkForm(url.searchParams.get('documentNumber'));
    case 'POST /api/oa/forms': return api.create(await body());
    case 'GET /api/oa/payees': return api.payees(url.searchParams.get('name'));
    case 'GET /api/oa/print': return api.printList();
    case 'GET /api/oa/print/permission': return api.printPermission(url.searchParams.get('bizId'));
    case 'POST /api/oa/print': return api.printDocument(await body());
    case 'POST /api/oa/select': return api.select(await body());
    case 'GET /api/oa/funds': return api.funds(url.searchParams);
    case 'GET /api/oa/budgets': return api.budgets(url.searchParams);
    case 'GET /api/oa/invoice-claim': return api.invoiceClaim(url.searchParams.get('number'));
    case 'GET /api/oa/folder-invoices': return api.folderInvoices();
    default: return undefined;
  }
}
