import { AppError, MAX_INVOICES, object, type Invoice, type WorkerEvent, type WorkerRequest } from '../domain/job';
import { searchFundingHttp } from '../automation/http-bpm';
import { inspectInvoice, LOCAL_OWNER, type LaunchWorker } from '../application/job-service';
import { FUNDING_KINDS } from '../automation/funding-search';
import { checkInvoiceClaimHttp, claimMessage, listFolderInvoicesHttp, type FolderInvoice, type InvoiceClaim } from '../automation/invoice-claim';
import { combinePrintPages, fetchPrintPageHttp, listPrintableHttp, printPermissionHttp, PrintError } from '../automation/http-print';
import { searchSuppliersHttp } from '../automation/http-payee';
import { ApplyMoneyApi, type ApplyMoneyJobs } from './apply-money-api';
import { travelType, TravelApi } from './travel-api';
import type { FormContext, FormType, PageInvoice } from './form-routes';
import { OaSession, record } from './oa-session';
import { randomBytes } from 'node:crypto';
import { renderPrintPdf } from '../infrastructure/print-pdf';
import type { PrintMarks } from '../infrastructure/print-marks';

export { defaultLogin, savedCredentials, type LoginEvidence, type LoginHooks, type PasswordLogin, type SavedCredentials } from './oa-session';

/** A print document served under its token: the HTML page to print, or a PDF to save. */
export interface PrintFile { body: string | Buffer; type: string; filename?: string }

/** A ready 打印文件 stays this long, at most this many per browser. */
const READY_MS = 30 * 60_000;
const READY_MAX = 20;
interface ReadyFile { bizId: string; billCode: string; html: string; pdf: Buffer; token: string; expires: number;
  /** When its print page was first opened (the user clicked 打印). */
  printedAt?: number }
export interface ReadyInfo { bizId: string; billCode: string; printUrl: string; pdfUrl: string; filename: string; expiresAt: string;
  /** 打印 has been clicked (its print page opened) at least once, for this file or an earlier one of the bill. */
  printed: boolean }
const readyInfo = (file: ReadyFile, printed: boolean): ReadyInfo => ({ bizId: file.bizId, billCode: file.billCode, printUrl: `/print/ready/${file.token}`,
  pdfUrl: `/print/ready/${file.token}.pdf`, filename: `${file.billCode}.pdf`, expiresAt: new Date(file.expires).toISOString(),
  printed: printed || file.printedAt !== undefined });

/** The page's school login (OaSession) with what every 报销类型 shares: funds, invoice folders, suppliers,
 * printing. Each 报销类型 is a module of its own (apply-money-api.ts, travel-api.ts) registered in `types`;
 * a new one is added there, borrowing only the login (FormHost). */
export class OaApi extends OaSession {
  /** Whose jobs this browser's 用款申请单 become: 'local' on one's own computer, a random id per browser on a server. */
  ownerId = LOCAL_OWNER;
  /** 用款申请单: blank forms, budgets, the fill and submission as jobs. */
  readonly applyMoney = new ApplyMoneyApi(this, () => this.ownerId);
  /** 境内差旅单, kept apart from the 用款申请单 jobs; it borrows only this login. */
  readonly travel = new TravelApi(this);
  /** Every 报销类型's routes, in the order they are asked. */
  readonly types: FormType[] = [this.applyMoney.type, travelType(this.travel)];
  /** Bills of the last print list: bizId → bill code and print rule ('check' turns 'yes' once OA allows it). */
  private printable = new Map<string, { billCode: string; print: 'yes' | 'no' | 'check' }>();
  /** Built print documents, served once each under an unguessable token for 10 minutes. */
  private printed = new Map<string, PrintFile & { expires: number }>();
  /** 打印文件 made ahead, one per bill: its print page and PDF, opened as often as needed under one token until it
   * expires (READY_MS) or the login ends. In memory only; at most READY_MAX per browser, the oldest gives way. */
  private ready = new Map<string, ReadyFile>();
  /** Bills this account has clicked 打印 for, kept on disk (infrastructure/print-marks.ts), when the server keeps them. */
  printMarks?: PrintMarks;

  protected onReset(): void {
    this.applyMoney.reset();
    this.printable.clear();
    this.printed.clear();
    this.ready.clear();
  }

  status() {
    const form = this.applyMoney?.form;
    return { loggedIn: Boolean(this.client), login: this.login ?? null, form: form ? { documentNumber: form.documentNumber,
      accountBook: form.context.accountBook, reimbursementKind: form.context.reimbursementKind } : null, savedUsername: this.saved?.username ?? null };
  }

  /** The job service 用款申请单 runs in. */
  useJobs(jobs: ApplyMoneyJobs): void {
    this.applyMoney.useJobs(jobs);
  }

  // 用款申请单's own calls, kept here under their old names for callers of OaApi; the work is ApplyMoneyApi's.
  forms() { return this.applyMoney.forms(); }
  checkForm(documentNumber: unknown) { return this.applyMoney.checkForm(documentNumber); }
  create(body: unknown) { return this.applyMoney.create(body); }
  select(body: unknown) { return this.applyMoney.select(body); }
  handoff(documentNumber: unknown) { return this.applyMoney.handoff(documentNumber); }
  release(documentNumber: string) { this.applyMoney.release(documentNumber); }
  budgets(params: URLSearchParams) { return this.applyMoney.budgets(params); }

  /** LaunchWorker of a live 用款申请单 job (see ApplyMoneyApi.fillJob). */
  fillJob(request: WorkerRequest, onEvent: (event: WorkerEvent) => void, onExit: () => void, submitWith?: LaunchWorker) {
    return this.applyMoney.fillJob(request, onEvent, onExit, submitWith);
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

  /** A page's `invoices` for a form that is not a job: PDFs read here like a job's, folder picks re-read in OA. */
  async pageInvoices(value: unknown): Promise<PageInvoice[]> {
    const uploads = value === undefined ? [] : value;
    if (!Array.isArray(uploads) || uploads.length > MAX_INVOICES) throw new AppError(400, `每张报销单可关联 0–${MAX_INVOICES} 张发票。`);
    const invoices: PageInvoice[] = [];
    const picks: Array<{ folderId: string; number: string }> = [];
    for (const upload of uploads) {
      const item = object(upload);
      if (item.folderId !== undefined) {
        if (typeof item.folderId !== 'string' || !/^\d{1,32}$/.test(item.folderId) || typeof item.number !== 'string' || !/^\d{20}$/.test(item.number)) {
          throw new AppError(400, '票夹发票参数无效。');
        }
        picks.push({ folderId: item.folderId, number: item.number });
        invoices.push({ fileName: '', number: item.number, folderId: item.folderId });
      } else {
        const { invoice, buffer } = await inspectInvoice(upload);
        if (!invoice.number) throw new AppError(400, '未能从 PDF 识别发票号码，无法核对是否已报销。');
        invoices.push({ fileName: invoice.name, number: invoice.number, bytes: buffer });
      }
      if (invoices.filter(entry => entry.number === invoices[invoices.length - 1].number).length > 1) {
        throw new AppError(400, `同一张发票（${invoices[invoices.length - 1].number}）选择了多次。`);
      }
    }
    for (const picked of await this.pickedInvoices(picks)) {
      const entry = invoices.find(item => item.folderId === picked.folderId && item.number === picked.number);
      if (entry) entry.fileName = picked.name;
    }
    return invoices;
  }

  /** 报销单查询's newest bills for the print panel, each with OA's print rule. */
  async printList() {
    try {
      const { total, rows } = await this.read((reader, page) => listPrintableHttp(reader, page));
      this.printable = new Map(rows.map(row => [row.bizId, { billCode: row.billCode, print: row.print }]));
      return { ...(total === undefined ? {} : { total }), rows: rows.map(row => ({ bizId: row.bizId, billCode: row.billCode, status: row.status,
        statusText: row.statusText, kind: row.kindText, amount: row.reimbursementAmount, remark: row.remark, date: row.fillinDate.slice(0, 10), print: row.print,
        printed: this.wasPrinted(row.bizId) })) };
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

  /** Makes one bill's 打印文件 (its print page and a PDF) and keeps it ready; a bill already ready is returned as is. */
  async prepareFile(body: unknown): Promise<ReadyInfo> {
    const { bizId } = record(body);
    const bill = typeof bizId === 'string' ? this.printable.get(bizId) : undefined;
    if (!bill) throw new AppError(409, new PrintError('not_listed').message);
    if (bill.print !== 'yes') throw new AppError(409, `报销单 ${bill.billCode} 当前不能打印。`);
    this.dropExpired();
    const known = this.ready.get(bizId as string);
    if (known) return this.info(known);
    try {
      const page = await this.read((reader, query) => fetchPrintPageHttp(reader, query, bizId as string))
        .catch(error => { throw error instanceof PrintError && error.code === 'not_printable' ? new PrintError('not_printable', `报销单 ${bill.billCode}：${error.message}`) : error; });
      const html = combinePrintPages([{ billCode: bill.billCode, html: page }]);
      const pdf = await (this.renderPdf ?? renderPrintPdf)(html)
        .catch(() => { throw new AppError(500, `未能生成报销单 ${bill.billCode} 的 PDF，请稍后重试。`); });
      const file: ReadyFile = { bizId: bizId as string, billCode: bill.billCode, html, pdf, token: randomBytes(18).toString('base64url'),
        expires: Date.now() + READY_MS };
      this.ready.set(file.bizId, file);
      while (this.ready.size > READY_MAX) this.ready.delete([...this.ready.values()].sort((a, b) => a.expires - b.expires)[0].bizId);
      return this.info(file);
    } catch (error) { this.fail(error); }
  }

  /** The 打印文件 still ready, for the print page after a reload. */
  readyFiles(): { files: ReadyInfo[] } {
    this.dropExpired();
    return { files: [...this.ready.values()].map(file => this.info(file)) };
  }

  /** A ready 打印文件 by its token: the print page, or the PDF; not used up by opening it. */
  takeReady(token: string, kind: 'html' | 'pdf'): PrintFile | undefined {
    this.dropExpired();
    const file = [...this.ready.values()].find(item => item.token === token);
    if (!file) return undefined;
    if (kind === 'html') {
      file.printedAt ??= Date.now();
      const account = this.account();
      if (account) this.printMarks?.mark(account, file.bizId);
    }
    return kind === 'pdf' ? { body: file.pdf, type: 'application/pdf', filename: `${file.billCode}.pdf` } : { body: file.html, type: 'text/html; charset=utf-8' };
  }

  private info(file: ReadyFile): ReadyInfo {
    return readyInfo(file, this.wasPrinted(file.bizId));
  }

  /** 打印 was clicked for this bill under this login's account, in this or an earlier session. */
  private wasPrinted(bizId: string): boolean {
    const account = this.account();
    return Boolean(account && this.printMarks?.has(account, bizId));
  }

  private dropExpired(): void {
    const now = Date.now();
    for (const [key, item] of this.ready) if (item.expires < now) this.ready.delete(key);
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

}

/** Routes under /api/oa/: the login and shared queries, then each 报销类型's own; the caller has already
 * checked the local session and CSRF token. A Created answer is sent with HTTP 201. */
export async function handleOaRoute(api: OaApi, method: string, url: URL, body: () => Promise<unknown>,
  context: FormContext): Promise<unknown | undefined> {
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/oa/status': return api.status();
    case 'POST /api/oa/login': return api.signIn(await body());
    case 'POST /api/oa/login/captcha': return api.refreshCaptcha();
    case 'POST /api/oa/logout': return api.signOut();
    case 'GET /api/oa/payees': return api.payees(url.searchParams.get('name'));
    case 'GET /api/oa/print': return api.printList();
    case 'GET /api/oa/print/permission': return api.printPermission(url.searchParams.get('bizId'));
    case 'POST /api/oa/print': return api.printDocument(await body());
    case 'POST /api/oa/print/file': return api.prepareFile(await body());
    case 'GET /api/oa/print/files': return api.readyFiles();
    case 'GET /api/oa/funds': return api.funds(url.searchParams);
    case 'GET /api/oa/invoice-claim': return api.invoiceClaim(url.searchParams.get('number'));
    case 'GET /api/oa/folder-invoices': return api.folderInvoices();
    default:
      for (const type of api.types) {
        const answer = await type.route(method, url, body, context);
        if (answer !== undefined) return answer;
      }
      return undefined;
  }
}
