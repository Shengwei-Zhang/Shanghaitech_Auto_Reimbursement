import type { AutomationContext } from './browser';
import { BPM_ORIGIN, postFromForm } from './form-request';

export const BUDGET_SEARCH_ORIGIN = BPM_ORIGIN;
export const BUDGET_SEARCH_PATH = '/bpm-new/rbReimburFundingItems/queryChooseBudgetOutlays.ajax';

export interface BudgetSearchOptions {
  fundingItemsCode: string;
  /** Omit to use the open form's #mainAccountBook. */
  accountBook?: string;
  /** Omit to use the open form's #reimbursementKind. */
  reimbursementKind?: string;
  page?: number;
  pagesize?: number;
}

const errors = {
  invalid_query: '预算查询参数无效；请提供经费编号，页码须为正整数，每页 1–100 条。',
  bpm_unavailable: '预算查询需要当前已登录的 BPM 报销页面；请重新打开原单。',
  csrf_missing: '当前报销页面未提供可识别的 csrfToken；请重新打开原单，若仍失败需校准页面令牌来源。',
  csrf_ambiguous: '当前页面的 csrfToken 来源不一致；请刷新原单后重试。',
  csrf_invalid: '当前页面的 csrfToken 格式异常，未发送预算请求。',
  form_context_missing: '当前报销页面未提供有效的账套（#mainAccountBook）或报销类型（#reimbursementKind），未发送预算请求；可显式传入这两个参数。',
  authentication: '预算接口要求重新认证或拒绝访问；请核对 BPM 登录状态、页面令牌和项目权限。',
  timeout: '预算查询超时，请稍后重试。',
  request_failed: '预算请求未完成，请检查校园网络及原单页面状态。',
  http_error: '预算接口返回 HTTP 错误，未将其视为空列表。',
  non_json: '预算接口未返回 JSON，可能是登录页或网关提示；请核对学校页面。',
  response_invalid: '预算接口响应为空、过大或 JSON 格式异常，未将其视为空列表。',
} as const;

export const ACCOUNT_BOOK = /^[A-Za-z0-9_-]{1,32}$/;
const REIMBURSEMENT_KIND = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class BudgetSearchError extends Error {
  constructor(readonly code: keyof typeof errors, readonly status?: number) {
    super(errors[code]);
    this.name = 'BudgetSearchError';
  }
}

export function buildBudgetSearchPayload(options: BudgetSearchOptions) {
  const allowed = new Set(['fundingItemsCode', 'accountBook', 'reimbursementKind', 'page', 'pagesize']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) throw new BudgetSearchError('invalid_query');
  // An empty value is resolved from the open form inside the browser.
  const accountBook = options.accountBook ?? '';
  const reimbursementKind = options.reimbursementKind ?? '';
  const page = options.page ?? 1, pagesize = options.pagesize ?? 20;
  if (typeof options.fundingItemsCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(options.fundingItemsCode)
    || typeof accountBook !== 'string' || (accountBook !== '' && !ACCOUNT_BOOK.test(accountBook))
    || typeof reimbursementKind !== 'string' || (reimbursementKind !== '' && !REIMBURSEMENT_KIND.test(reimbursementKind))
    || !Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pagesize) || pagesize < 1 || pagesize > 100) {
    throw new BudgetSearchError('invalid_query');
  }
  return { accountBook, reimbursementKind, fundingItemsCode: options.fundingItemsCode,
    page: String(page), pagesize: String(pagesize), sortfields: '[]' };
}

export interface BudgetSearchResponse {
  queriedAt: string;
  query: ReturnType<typeof buildBudgetSearchPayload>;
  httpStatus: number;
  /** Raw envelope (token-scrubbed); HTTP 200 may still contain a business error. */
  response: Record<string, unknown> | unknown[];
  /** Present only for the success envelope { status: 0, data: { Rows, Total } }. */
  outlays?: BudgetOutlays;
}

export interface BudgetOutlay {
  expenditureItemCode: string;
  expenditureItemName: string;
  quotaCode: string;
  quotaName: string;
  /** The balance OA lets this user see (showAmount); empty when the balance is not authorized to them.
   * The row's budgetBalance is filled either way and is never shown. */
  showAmount: string;
  projectCode: string;
  projectName: string;
}
export interface BudgetOutlays {
  total?: number;
  rows: BudgetOutlay[];
  /** Rows naming another project or lacking an expenditure item code. */
  skipped: number;
  /** The fund balance OA lets this user see (data.showAmount); absent when not authorized. requireAmount,
   * filled either way, is not exposed. */
  showAmount?: string;
}

const OUTLAY_FIELDS = ['expenditureItemCode', 'expenditureItemName', 'quotaCode', 'quotaName', 'showAmount',
  'projectCode', 'projectName'] as const;

/** Envelope verified live on 2026-10-15: { status: 0, data: { Rows: [...], Total,
 * requireAmount, showAmount, fundingManager } }. A bare LigerUI { Rows, Total }
 * is also accepted. Any other shape, or a non-zero status, is left unparsed. */
export function parseBudgetOutlays(response: unknown, fundingItemsCode: string): BudgetOutlays | undefined {
  const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const envelope = record(response);
  if (!envelope) return undefined;
  let grid = envelope;
  if ('status' in envelope || 'data' in envelope) {
    if (String(envelope.status) !== '0') return undefined;
    grid = record(envelope.data) ?? {};
  }
  if (!Array.isArray(grid.Rows)) return undefined;
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const rows: BudgetOutlay[] = [];
  let skipped = 0;
  for (const raw of grid.Rows) {
    const row = record(raw);
    const outlay = Object.fromEntries(OUTLAY_FIELDS.map(key => [key, text(row?.[key])])) as unknown as BudgetOutlay;
    if (!outlay.expenditureItemCode || (outlay.projectCode && outlay.projectCode !== fundingItemsCode)) { skipped++; continue; }
    rows.push(outlay);
  }
  const total = typeof grid.Total === 'number' ? grid.Total
    : typeof grid.Total === 'string' && /^\d+$/.test(grid.Total) ? Number(grid.Total) : undefined;
  const showAmount = text(grid.showAmount);
  return { ...(total === undefined ? {} : { total }), rows, skipped, ...(showAmount ? { showAmount } : {}) };
}

/** Query in the active BPM frame so cookies and Referer belong to that document.
 * No token is cached, passed to Node, or accepted from callers. */
export async function searchBudgetOutlays(ctx: AutomationContext, options: BudgetSearchOptions,
  timeoutMs = 20_000): Promise<BudgetSearchResponse> {
  const query = buildBudgetSearchPayload(options);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new BudgetSearchError('invalid_query');
  }
  const result = await postFromForm(ctx, {
    pathname: BUDGET_SEARCH_PATH, payload: query, expect: 'json', timeoutMs,
    accept: 'application/json, text/javascript, */*; q=0.01',
    fromForm: { accountBook: { id: 'mainAccountBook', format: ACCOUNT_BOOK },
      reimbursementKind: { id: 'reimbursementKind', format: REIMBURSEMENT_KIND } },
  });
  if (result.error) throw new BudgetSearchError(result.error, result.status);
  const data = result.data as BudgetSearchResponse['response'];
  const outlays = parseBudgetOutlays(data, query.fundingItemsCode);
  return { queriedAt: new Date().toISOString(), query: result.payload as BudgetSearchResponse['query'],
    httpStatus: result.status, response: data, ...(outlays ? { outlays } : {}) };
}
