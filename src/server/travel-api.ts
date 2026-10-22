import { randomBytes } from 'node:crypto';
import { AppError } from '../domain/job';
import type { OaHttpClient } from '../automation/http-login';
import { BudgetSearchError } from '../automation/budget-search';
import { CreateReimbursementError, createReimbursementHttp, listDraftsHttp, openFormHttp, resolveListTargetHttp, searchBudgetHttp,
  type HttpForm, type QueryDocument } from '../automation/http-bpm';
import { OpenReimbursementError } from '../automation/open-reimbursement';
import { ReimbursementListError } from '../automation/reimbursement-list';
import { cents, fillTravelFormHttp, HttpTravelError, searchCtripBorrowsHttp, searchTravellersHttp, submitTravelFormHttp, TRAVEL_KIND,
  TravelSubmitError, validateTravelInput, type FundingLine, type HttpTravelInput, type HttpTravelResult, type TravelLeg, type Traveller,
  type TravelPayee, type TravelStep, type TravelSubmitExpectation } from '../automation/travel';

/** The Easy page's 境内差旅单, apart from the 用款申请单 jobs of OaApi: it reuses only the school login
 * (OaApi's session, its request queue and its reading session) through TravelHost. */
export interface TravelHost {
  session(): OaHttpClient;
  serial<T>(task: () => Promise<T>): Promise<T>;
  read<T>(task: (client: OaHttpClient, page: QueryDocument) => Promise<T>): Promise<T>;
  reset(): void;
  fail(error: unknown): never;
  ownerStatus(client: OaHttpClient, billCode: string, until?: string): Promise<{ status: string; amount: string } | undefined>;
}

/** One run of the page: not a job (it keeps no files), held in memory only. */
export interface TravelRun {
  id: string;
  /** completed: saved only; submitted: 报销单查询 shows 提交; needs_review: queryAdvance went out with an unclear outcome. */
  status: 'running' | 'completed' | 'submitted' | 'needs_review' | 'failed' | 'cancelled';
  action: 'save' | 'submit';
  startedAt: string;
  documentNumber?: string;
  events: Array<{ at: string; step: TravelStep | 'create' | 'submit'; message: string }>;
  result?: HttpTravelResult;
  error?: string;
  /** The form holds part of this run. */
  partial?: boolean;
}

const FUNDING_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const yuanText = (value: number) => `${Number(value).toFixed(2)} 元`;

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '请求格式无效。');
  return body as Record<string, unknown>;
}

/** The page's travel form as HttpTravelInput; only known fields are kept, then checked like the fill does. */
export function travelInput(body: unknown): HttpTravelInput {
  const data = record(body);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const optional = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const input: HttpTravelInput = {
    fundingKind: data.fundingKind === 'responsible' ? 'responsible' : 'authorized',
    fundingCode: text(data.fundingCode), attachmentCount: Number(data.attachmentCount),
    lines: list(data.lines).map((item): FundingLine => {
      const line = record(item);
      return { budgetName: text(line.budgetName).trim(), purpose: text(line.purpose), amount: optional(line.amount) };
    }),
    payees: list(data.payees).map((item): TravelPayee => {
      const payee = record(item);
      // Anything else fails validateTravelInput below.
      return { kind: text(payee.kind) as TravelPayee['kind'], code: text(payee.code).trim(), amount: optional(payee.amount),
        ...(payee.kind === 'bank' ? { supplierCode: text(payee.supplierCode), remitPurpose: text(payee.remitPurpose) } : {}) };
    }),
    reason: text(data.reason), explain: text(data.explain),
    travellers: list(data.travellers).map(item => {
      const traveller = record(item);
      return { kind: text(traveller.kind) as Traveller['kind'],
        code: text(traveller.code).trim(), name: text(traveller.name).trim(), legs: list(traveller.legs).map(value => {
          const leg = record(value);
          return { startDate: text(leg.startDate), startAddress: text(leg.startAddress), arriveDate: text(leg.arriveDate),
            arriveAddress: text(leg.arriveAddress), vehicle: text(leg.vehicle) as TravelLeg['vehicle'], trafficExpense: text(leg.trafficExpense).trim(),
            travelDays: Number(leg.travelDays), subsidyAmount: optional(leg.subsidyAmount), hotelExpense: optional(leg.hotelExpense),
            meetingAmount: optional(leg.meetingAmount), otherAmount: optional(leg.otherAmount) };
        }) };
    }),
    ctripOrders: list(data.ctripOrders).map(text),
  };
  try { validateTravelInput(input); }
  catch (error) { throw new AppError(400, error instanceof Error ? error.message : '差旅单参数无效。'); }
  return input;
}

export class TravelApi {
  /** The last run of this login. */
  private run?: TravelRun;
  private stopRun?: () => void;
  /** Blank drafts of the last forms() list; only these can be reused. */
  private drafts = new Set<string>();

  constructor(private readonly host: TravelHost) {}

  /** A travel lookup error is OA's answer to show; the rest (login gone, AppError) is the host's. */
  private fail(error: unknown): never {
    if (error instanceof HttpTravelError && error.code !== 'authentication') throw new AppError(502, error.message);
    return this.host.fail(error);
  }

  /** The applicant's own 境内差旅单 drafts (报销单查询, status 预制) with nothing saved in them yet. */
  async forms() {
    try {
      const drafts = await this.host.read((reader, page) => listDraftsHttp(reader, page));
      const blank = drafts.filter(row => row.reimbursementKind === TRAVEL_KIND && row.blank);
      this.drafts = new Set(blank.map(row => row.billCode));
      return { forms: blank.map(row => ({ documentNumber: row.billCode, date: row.fillinDate.slice(0, 10) })) };
    } catch (error) { this.fail(error); }
  }

  /** 支出项目 of a fund as a 差旅单 lists them (国内差旅/参会费 …), with its balance. */
  async budgets(params: URLSearchParams) {
    const fundingCode = params.get('fundingCode') || '';
    if (!FUNDING_CODE.test(fundingCode)) throw new AppError(400, '经费编号无效。');
    try {
      const query = (reader: OaHttpClient, page: QueryDocument) =>
        searchBudgetHttp(reader, page, { fundingItemsCode: fundingCode, reimbursementKind: TRAVEL_KIND, pagesize: 100 });
      // A single "登录超时" can be transient; only a repeated one ends the login.
      const result = await this.host.read((reader, page) => query(reader, page).catch(error => {
        if (error instanceof BudgetSearchError && error.code === 'authentication') return query(reader, page);
        throw error;
      }));
      if (!result.outlays) throw new AppError(502, '预算科目接口返回了无法识别的结构。');
      return { fundingCode, total: result.outlays.total ?? result.outlays.rows.length, balance: result.outlays.showAmount ?? '',
        subjects: result.outlays.rows.map(row => ({ code: row.expenditureItemCode, name: row.expenditureItemName,
          quotaCode: row.quotaCode, quotaName: row.quotaName, balance: row.showAmount })) };
    } catch (error) { this.fail(error); }
  }

  /** 教工 / 学生 by name for the traveller picker (read-only); the fill re-checks code and name. */
  async people(params: URLSearchParams) {
    const kind = params.get('kind'), name = (params.get('name') || '').trim();
    if (kind !== 'staff' && kind !== 'student') throw new AppError(400, '出差人类别无效。');
    if (!name || name.length > 30 || /[\u0000-\u001f]/.test(name)) throw new AppError(400, '请输入 1–30 个字符的姓名。');
    try {
      return { kind, name, people: await this.host.read((reader, page) => searchTravellersHttp(reader, page, kind, name)) };
    } catch (error) { this.fail(error); }
  }

  /** Open 携程借款单 under one fund, for the page's write-off picker (read-only). */
  async borrows(params: URLSearchParams) {
    const fundingCode = params.get('fundingCode') || '';
    if (!FUNDING_CODE.test(fundingCode)) throw new AppError(400, '经费编号无效。');
    try {
      return { fundingCode, borrows: await this.host.read((reader, page) => searchCtripBorrowsHttp(reader, page, fundingCode)) };
    } catch (error) { this.fail(error); }
  }

  status(): { run: TravelRun | null } {
    return { run: this.run ?? null };
  }

  stop(): { run: TravelRun | null } {
    if (this.run?.status === 'running') this.stopRun?.();
    return this.status();
  }

  /** One 境内差旅单 filled and saved over HTTP, then submitted when asked, one run at a time: a listed
   * blank draft (`documentNumber`) or a new form. The fill itself re-checks the form is empty. */
  start(body: unknown, documentNumber: string | null = null, invoices: HttpTravelInput['invoices'] = [],
    action: TravelRun['action'] = 'save'): { run: TravelRun } {
    if (this.run?.status === 'running') throw new AppError(409, '已有一张境内差旅单正在填写，请等它完成。');
    // 差旅单 has no browser submit to fall back on.
    if (action === 'submit' && process.env.OA_HTTP_SUBMIT === 'false') throw new AppError(400, 'OA_HTTP_SUBMIT=false 时差旅单只能保存。');
    if (documentNumber !== null && !this.drafts.has(documentNumber)) {
      throw new AppError(409, '该差旅单不在当前的空白差旅单列表中，请刷新列表。');
    }
    const client = this.host.session();
    const input = { ...travelInput(body), invoices };
    const run: TravelRun = { id: randomBytes(8).toString('hex'), status: 'running', action, startedAt: new Date().toISOString(), events: [] };
    let stopped = false;
    this.run = run;
    this.stopRun = () => { stopped = true; };
    const note = (step: TravelRun['events'][number]['step'], message: string) => run.events.push({ at: new Date().toISOString(), step, message });
    void (async () => {
      try {
        note('create', documentNumber ? `正在打开空白差旅单 ${documentNumber}。` : '正在新建境内差旅单。');
        const form = await this.host.serial(async () => documentNumber
          ? openFormHttp(client, (await resolveListTargetHttp(client, documentNumber)).target) : createReimbursementHttp(client, TRAVEL_KIND));
        if (documentNumber && form.documentNumber !== documentNumber) throw new HttpTravelError('response_invalid', 'funding', undefined,
          `打开的单据不是 ${documentNumber}，未填写。`);
        run.documentNumber = form.documentNumber;
        if (documentNumber) this.drafts.delete(documentNumber);
        note('create', `已${documentNumber ? '打开' : '新建'} ${form.documentNumber}（接口方式，不启动浏览器）。`);
        const result = await this.host.serial(() => fillTravelFormHttp(client, form, input, { stopped: () => stopped, progress: note }));
        run.result = result;
        const payees = result.payeeAmounts.map(({ amount }, index) => `${result.payeeNames[index]} ${yuanText(amount / 100)}`).join('、');
        note('save', `已保存${action === 'submit' ? '' : '，未提交'}：差旅合计 ${yuanText(result.bizData.businessTripAmount)}`
          + `（${input.lines.length} 行经费明细），冲账 ${yuanText(result.bizData.reverseEntryAmount)}，`
          + `付款 ${yuanText(result.bizData.settlementAmount)}${payees ? `（${payees}）` : ''}，附件 ${result.bizData.attachmentNumber} 张。`);
        if (action === 'save') { run.status = 'completed'; return; }
        if (stopped) throw Object.assign(new HttpTravelError('stopped', 'save', undefined, '用户已停止执行，已保存、未提交。'), { partial: true });
        const trip = Math.round(Number(result.bizData.businessTripAmount) * 100);
        run.status = await this.submit(client, form, {
          fundingCode: input.fundingCode, attachmentCount: input.attachmentCount, reason: input.reason, explain: input.explain ?? '',
          lines: input.lines.map((line, index) => ({ budgetName: line.budgetName, amount: result.lineAmounts[index], purpose: line.purpose })),
          travellerCodes: input.travellers.map(item => item.code), trip, ctripOrders: input.ctripOrders ?? [],
          reverse: Math.round(Number(result.bizData.reverseEntryAmount) * 100),
          payees: result.payeeAmounts.map(({ payee, amount }) => ({ kind: payee.kind, code: payee.code, supplierCode: payee.supplierCode, amount })),
          invoiceNumbers: (input.invoices ?? []).map(item => item.number), managerId: result.managerId || undefined,
        }, message => note('submit', message));
        if (run.status === 'failed') run.error = run.events[run.events.length - 1].message;
      } catch (error) {
        run.status = stopped ? 'cancelled' : 'failed';
        run.partial = error instanceof HttpTravelError ? error.partial : Boolean(run.documentNumber);
        run.error = error instanceof HttpTravelError || error instanceof CreateReimbursementError || error instanceof OpenReimbursementError
          || error instanceof ReimbursementListError ? error.message : '接口填写发生异常。';
        note('save', `已停止：${run.error}${run.partial ? '本单已写入部分内容，请在 OA 中核对或删除。'
          : run.documentNumber ? `${run.documentNumber} 仍是空单。` : ''}`);
      }
    })();
    return { run };
  }

  /** The saved 差旅单's submission, then 报销单查询 as receipt; queryAdvance goes out at most once. */
  private async submit(client: OaHttpClient, form: HttpForm, expect: TravelSubmitExpectation,
    note: (message: string) => void): Promise<TravelRun['status']> {
    let advancing = false, route = '';
    try {
      const result = await this.host.serial(() => submitTravelFormHttp(client, form, expect, {
        progress: (_step, message) => note(message), validated: () => { advancing = true; } }));
      route = `；审批路线：${result.route.map(item => `${item.step} ${item.handler}`).join('、')}`;
      note('OA 已接受提交请求。');
    } catch (error) {
      const failure = error instanceof TravelSubmitError ? error : undefined;
      const detail = failure?.response ? `（${failure.response}）` : '';
      if (failure?.code === 'authentication' || (error as { code?: string })?.code === 'authentication') {
        this.host.reset();
        note(`已停止：${failure?.message ?? '学校 OA 登录已失效。'}${advancing ? '提交请求可能已发出，请在 OA 中核对本单状态。' : '本单已保存，未提交。'}`);
        return advancing ? 'needs_review' : 'failed';
      }
      if (!(failure ? failure.code === 'unknown' : advancing)) {
        const sent = failure ? failure.sent : advancing;
        note(`已停止：${failure?.message ?? '接口提交发生异常。'}${detail}${sent ? '' : '本单已保存，未提交。'}`);
        return sent && failure?.code !== 'rejected' ? 'needs_review' : 'failed';
      }
      // queryAdvance went out with an unfamiliar reply: only 报销单查询 can tell what happened.
      note(`${failure?.message ?? '接口提交发生异常。'}${detail} 改以“报销单查询”的单据状态为准。`);
    }
    note('正在“报销单查询”中核对本单状态。');
    const row = await this.host.serial(() => this.host.ownerStatus(client, form.documentNumber, '提交')).catch(() => undefined);
    if (row?.status !== '提交' || cents(row.amount) !== expect.trip) {
      note(`报销单查询显示状态“${row?.status ?? '未读取到'}”，金额 ${row?.amount ?? '—'}。请在 OA 中核对本单。`);
      return 'needs_review';
    }
    note(`报销单查询显示 ${form.documentNumber} 状态“提交”，金额 ${row.amount} 元${route}。`);
    return 'submitted';
  }
}

/** Read routes under /api/oa/travel; POST /api/oa/travel itself is in app.ts (it reads the invoices). */
export async function handleTravelRoute(api: TravelApi, method: string, url: URL): Promise<unknown | undefined> {
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/oa/travel': return api.status();
    case 'GET /api/oa/travel/forms': return api.forms();
    case 'GET /api/oa/travel/budgets': return api.budgets(url.searchParams);
    case 'GET /api/oa/travel/borrows': return api.borrows(url.searchParams);
    case 'GET /api/oa/travel/people': return api.people(url.searchParams);
    case 'POST /api/oa/travel/stop': return api.stop();
    default: return undefined;
  }
}
