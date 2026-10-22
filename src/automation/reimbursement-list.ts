import type { Page } from 'playwright';
import { AutomationContext, type BrowserSession } from './browser';
import { isLoginTimeoutPage } from './auth';
import { BPM_ORIGIN, postFromForm } from './form-request';
import type { ReimbursementTarget } from './open-reimbursement';

export const OWNER_QUERY_PATH = '/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do';
export const OWNER_LIST_PATH = '/bpm-new/rbReimbursementQuery/slicedQueryOwnerReimbursement.ajax';
export const APPLY_TASK_PATH = '/bpm-new/techCommonFunction/getApplyTaskInfo.ajax';
const OWNER_QUERY_URL = `${BPM_ORIGIN}${OWNER_QUERY_PATH}`;
const BIZ_ID = /^[\da-f]{32}$/i;
const TASK_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
/** A: 网上预约报销 (用款申请单…); D: 境内差旅单. */
const DOCUMENT_NUMBER = /^[AD]\d{1,32}$/;

const errors = {
  invalid_query: '报销单列表查询参数无效；单据编号须为 A 加数字，页码须为正整数，每页 1–100 条。',
  bpm_unavailable: '未能打开 BPM“报销单查询”页面，请检查校园网络并重新登录。',
  authentication: '报销单列表接口要求重新认证或拒绝访问，请核对 BPM 登录状态。',
  csrf_missing: '报销单查询页面未提供可识别的 csrfToken；请重新打开页面。',
  csrf_ambiguous: '报销单查询页面的 csrfToken 来源不一致；请刷新后重试。',
  csrf_invalid: '报销单查询页面的 csrfToken 格式异常，未发送请求。',
  form_context_missing: '报销单查询页面缺少必要字段，未发送请求。',
  timeout: '报销单列表查询超时，请稍后重试。',
  request_failed: '报销单列表请求未完成，请检查校园网络及 BPM 登录状态。',
  http_error: '报销单列表接口返回 HTTP 错误，未将其视为空列表。',
  non_json: '报销单列表接口没有返回 JSON，可能是登录页或错误页。',
  response_invalid: '报销单列表接口返回的结构无法识别，未将其视为空列表。',
  document_missing: '“报销单查询”中没有该单据编号；请核对编号是否属于当前账号。',
  document_ambiguous: '“报销单查询”中有多条记录与该单据编号相同，未自动选择。',
  task_missing: '该报销单当前没有可办理的申请环节任务（可能已提交、已完成或已撤销），无法生成办理页地址。',
  task_mismatch: '申请环节任务信息与报销单不一致（bizId 或单据编号不同），未打开报销单。',
  not_editable: '该报销单已离开申请环节（当前为他人办理的审批等环节），不以办理模式打开；如需查看请加 --read-only。',
} as const;

export class ReimbursementListError extends Error {
  constructor(readonly code: keyof typeof errors, readonly status?: number) {
    super(errors[code]);
    this.name = 'ReimbursementListError';
  }
}

/** queryStatusKind: the 状态 checkboxes of the query form (0 预制, 1 提交, 2 预收, 3 接收, 4 驳回,
 * 5 已完成, 6 已中止; live 2026-10-21), several joined with commas; '' for all. */
export interface OwnerListOptions { billCode?: string; page?: number; pagesize?: number; queryStatusKind?: string }

/** The grid's own request body after 查询 (captured live 2026-10-15). */
export function buildOwnerListPayload(options: OwnerListOptions = {}) {
  const allowed = new Set(['billCode', 'page', 'pagesize', 'queryStatusKind']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) throw new ReimbursementListError('invalid_query');
  const billCode = options.billCode ?? '', page = options.page ?? 1, pagesize = options.pagesize ?? 20;
  const queryStatusKind = options.queryStatusKind ?? '';
  if (typeof queryStatusKind !== 'string' || !/^(?:[0-6](?:,[0-6])*)?$/.test(queryStatusKind)) throw new ReimbursementListError('invalid_query');
  if (typeof billCode !== 'string' || (billCode !== '' && !DOCUMENT_NUMBER.test(billCode))
    || !Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pagesize) || pagesize < 1 || pagesize > 100) {
    throw new ReimbursementListError('invalid_query');
  }
  return { billCode, startYearMonth: '', endYearMonth: '', reimbursementKind: '', reimbursementKind_text: '',
    remark: '', supplier: '', invoiceCode: '', reimburSettleKindId: '', reimburSettleKindId_text: '',
    queryStatusKind, page: String(page), pagesize: String(pagesize), sortname: 'fillinDate',
    sortorder: 'desc', sortfields: '[]' };
}

export interface OwnerReimbursement {
  /** Row id; the bizId of showLoadRbReimbursement.job. */
  bizId: string;
  billCode: string;
  /** 0 预制, 1 提交, 5 已完成, … (statusTextView). */
  status: string;
  statusText: string;
  reimbursementKind: string;
  /** reimbursementKindTextView, e.g. 用款申请单、境内差旅单. */
  kindText: string;
  accountBook: string;
  reimbursementAmount: string;
  remark: string;
  fillinDate: string;
  /** Every content column is empty: nothing has been saved into the form yet. */
  blank: boolean;
}
export interface OwnerList { total?: number; rows: OwnerReimbursement[]; skipped: number }

/** Columns that are '' on a freshly created draft and filled once anything is saved
 * (amounts, remark, funding, attachments, payee; compared live 2026-10-15). A missing
 * column counts as filled, so a changed response never passes as blank. */
export const DRAFT_CONTENT_FIELDS = ['explain', 'remark', 'allProjectName', 'projectCode', 'projectName', 'fundingItemKind',
  'reimbursementAmount', 'actualAmount', 'settlementAmount', 'reverseEntryAmount', 'businessTripAmount', 'carHailingAmount',
  'attachmentNumber', 'receivePersonName', 'prereceiveName', 'esupplySupplierName', 'esupplyBillCode', 'premiumPrice',
  'workload', 'businessTrip'] as const;

export function isBlankDraft(row: Record<string, unknown>): boolean {
  return DRAFT_CONTENT_FIELDS.every(field => row[field] === null || (typeof row[field] === 'string' && !(row[field] as string).trim()));
}

/** Envelope verified live: { status: 0, data: { Rows: [...], Total } }. */
/** Every bill type's code (A 用款申请单, D 境内差旅单, G 采购预付及报销单, …); filling only handles A. */
export const ANY_BILL_CODE = /^[A-Z]\d{1,32}$/;

export function parseOwnerList(response: unknown, billCodes: RegExp = DOCUMENT_NUMBER): OwnerList | undefined {
  const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const envelope = record(response);
  if (!envelope || String(envelope.status) !== '0') return undefined;
  const data = record(envelope.data);
  if (!data || !Array.isArray(data.Rows)) return undefined;
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const rows: OwnerReimbursement[] = [];
  let skipped = 0;
  for (const raw of data.Rows) {
    const row = record(raw);
    const bizId = text(row?.id), billCode = text(row?.billCode);
    if (!BIZ_ID.test(bizId) || !billCodes.test(billCode)) { skipped++; continue; }
    rows.push({ bizId, billCode, status: text(row?.status), statusText: text(row?.statusTextView),
      reimbursementKind: text(row?.reimbursementKind), kindText: text(row?.reimbursementKindTextView), accountBook: text(row?.accountBook),
      reimbursementAmount: text(row?.reimbursementAmount), remark: text(row?.remark), fillinDate: text(row?.fillinDate),
      blank: isBlankDraft(row!) });
  }
  const total = typeof data.Total === 'number' ? data.Total
    : typeof data.Total === 'string' && /^\d+$/.test(data.Total) ? Number(data.Total) : undefined;
  return { ...(total === undefined ? {} : { total }), rows, skipped };
}

export interface ApplyTask {
  taskId: string;
  bizId: string;
  documentNumber: string;
  /** 'ready' while the applicant can still handle the form. */
  statusId: string;
  taskDefKey: string;
  name: string;
}

/** getApplyTaskInfo (verified live 2026-10-15): data.id is the taskId of the
 * form's current task, data.businessKey the bizId, data.businessCode the bill code.
 * Drafts return the applicant's taskDefKey 'Apply' task. */
export function parseApplyTask(response: unknown): ApplyTask | undefined {
  const envelope = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown> : undefined;
  if (!envelope || String(envelope.status) !== '0') return undefined;
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown> : undefined;
  if (!data) return undefined;
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const task = { taskId: text(data.id), bizId: text(data.businessKey), documentNumber: text(data.businessCode),
    statusId: text(data.statusId), taskDefKey: text(data.taskDefKey), name: text(data.name).slice(0, 200) };
  return TASK_ID.test(task.taskId) && BIZ_ID.test(task.bizId) ? task : undefined;
}

/** Open the read-only 报销单查询 page in a new tab; recover once through CAS. */
export async function openOwnerQueryPage(session: BrowserSession, timeoutMs = 20_000): Promise<Page> {
  try {
    const page = await session.context.newPage();
    session.page = page;
    const navigate = async (url: string) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (response?.status() === 403) throw new ReimbursementListError('authentication', 403);
      if (response && response.status() >= 400 && response.status() !== 401) {
        throw new ReimbursementListError('bpm_unavailable', response.status());
      }
    };
    const ready = async () => {
      const current = new URL(page.url());
      return current.origin === BPM_ORIGIN && current.pathname === OWNER_QUERY_PATH
        && !current.username && !current.password && !await isLoginTimeoutPage(page)
        && await page.locator('#queryMainForm').count() > 0;
    };
    await navigate(OWNER_QUERY_URL);
    if (!await ready()) {
      const sso = new URL('https://ids.shanghaitech.edu.cn/authserver/login');
      sso.searchParams.set('service', OWNER_QUERY_URL);
      await navigate(sso.href);
    }
    if (await isLoginTimeoutPage(page)) throw new ReimbursementListError('authentication');
    if (!await ready()) throw new ReimbursementListError('bpm_unavailable');
    return page;
  } catch (error) {
    if (error instanceof ReimbursementListError) throw error;
    throw new ReimbursementListError('bpm_unavailable');
  }
}

const JSON_ACCEPT = 'application/json, text/javascript, */*; q=0.01';

/** Same request as the 报销单查询 grid, from that page (cookies, csrfToken). */
export async function searchOwnerReimbursements(ctx: AutomationContext, options: OwnerListOptions = {},
  timeoutMs = 20_000): Promise<{ query: ReturnType<typeof buildOwnerListPayload>; response: unknown; list: OwnerList }> {
  const query = buildOwnerListPayload(options);
  const result = await postFromForm(ctx, { pathname: OWNER_LIST_PATH, payload: query, expect: 'json',
    accept: JSON_ACCEPT, timeoutMs });
  if (result.error) throw new ReimbursementListError(result.error, result.status);
  const list = parseOwnerList(result.data);
  if (!list) throw new ReimbursementListError('response_invalid', result.status);
  return { query, response: result.data, list };
}

export async function fetchApplyTask(ctx: AutomationContext, bizId: string, timeoutMs = 20_000): Promise<ApplyTask> {
  if (!BIZ_ID.test(bizId)) throw new ReimbursementListError('invalid_query');
  const result = await postFromForm(ctx, { pathname: APPLY_TASK_PATH, expect: 'json', accept: JSON_ACCEPT, timeoutMs,
    payload: { bizId, checkSubProcUnitId: 'financialContactPerson' } });
  if (result.error) throw new ReimbursementListError(result.error, result.status);
  const task = parseApplyTask(result.data);
  if (!task) throw new ReimbursementListError('task_missing', result.status);
  return task;
}

export interface ListTarget { target: ReimbursementTarget; row: OwnerReimbursement; task: ApplyTask }

/** 报销单查询 by bill code → bizId → 申请 task → taskId. The bill code must match
 * exactly one row, and the task must name the same bizId and bill code. */
export async function resolveListTarget(session: BrowserSession, documentNumber: string, isReadOnly = false,
  timeoutMs = 20_000): Promise<ListTarget> {
  if (!DOCUMENT_NUMBER.test(documentNumber)) throw new ReimbursementListError('invalid_query');
  const previous = session.page;
  const page = await openOwnerQueryPage(session, timeoutMs);
  try {
    const ctx = new AutomationContext(page);
    const { list } = await searchOwnerReimbursements(ctx, { billCode: documentNumber }, timeoutMs);
    const row = pickOwnerRow(list, documentNumber);
    return listTarget(row, await fetchApplyTask(ctx, row.bizId, timeoutMs), documentNumber, isReadOnly);
  } finally {
    await page.close().catch(() => undefined);
    session.page = previous;
  }
}

export function pickOwnerRow(list: OwnerList, documentNumber: string): OwnerReimbursement {
  const rows = list.rows.filter(row => row.billCode === documentNumber);
  if (!rows.length) throw new ReimbursementListError('document_missing');
  if (new Set(rows.map(row => row.bizId.toLowerCase())).size > 1) throw new ReimbursementListError('document_ambiguous');
  return rows[0];
}

export function listTarget(row: OwnerReimbursement, task: ApplyTask, documentNumber: string, isReadOnly: boolean): ListTarget {
  if (task.bizId.toLowerCase() !== row.bizId.toLowerCase()
    || (task.documentNumber && task.documentNumber !== documentNumber)) throw new ReimbursementListError('task_mismatch');
  if (task.statusId && task.statusId !== 'ready') throw new ReimbursementListError('task_missing');
  // For a submitted form the endpoint returns the current approver's task
  // (taskDefKey Approve, 2026-10-15); only the applicant's Apply task is ours to handle.
  if (!isReadOnly && task.taskDefKey !== 'Apply') throw new ReimbursementListError('not_editable');
  return { row, task, target: { bizId: row.bizId, taskId: task.taskId, isReadOnly, expectedDocumentNumber: documentNumber } };
}
