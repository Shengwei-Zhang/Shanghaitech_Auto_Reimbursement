import type { AutomationContext } from './browser';
import { BPM_ORIGIN, postFromForm } from './form-request';
import { ACCOUNT_BOOK } from './budget-search';

export const FUNDING_SEARCH_ORIGIN = BPM_ORIGIN;
export const FUNDING_SEARCH_PATH = '/bpm-new/easySearch.load';

/** fundingItemKind values of the editor's #chooseFundingItemKind select. */
export const FUNDING_KINDS = { responsible: '0', authorized: '1' } as const;

export interface FundingSearchOptions {
  /** 被授权的项目 (authorized, the dialog default) or 我负责的项目 (responsible). */
  kind?: keyof typeof FUNDING_KINDS;
  /** Sent as paramValue, the dialog's 关键字 box; empty lists every project. */
  paramValue?: string;
  /** Omit to use the open form's #mainAccountBook. */
  accountBook?: string;
  pageSize?: number;
}

export interface FundingSearchResponse {
  queriedAt: string;
  query: ReturnType<typeof buildFundingSearchPayload>;
  httpStatus: number;
  /** Inert HTML fragment; never injected into a page. */
  response: string;
  list: FundingList;
}

export interface FundingItem {
  /** projectid: the fundingItemsCode accepted by the budget-outlay query. */
  projectId: string;
  projectName: string;
  /** projectnameTextView, shown in the wizard and main form as "<code>-<name>". */
  label: string;
  departmentId: string;
  departmentName: string;
  firstId: string;
  firstName: string;
  secondId: string;
  secondName: string;
}
export interface FundingList { dataCount?: number; pageCount?: number; items: FundingItem[]; skipped: number }

const FUNDING_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ROW_FIELDS: Record<string, keyof FundingItem> = {
  projectid: 'projectId', projectname: 'projectName', projectnametextview: 'label',
  departmid: 'departmentId', departmname: 'departmentName', firstid: 'firstId', firstname: 'firstName',
  secondid: 'secondId', secondname: 'secondName',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (match, dec, hex, name) => {
    if (dec || hex) {
      const code = Number.parseInt(dec || hex, dec ? 10 : 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[name.toLowerCase()];
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

/** Text parsing of the easySearch fragment (verified live 2026-10-15): each
 * <tr class="list"> carries hidden inputs named projectid, projectname, … .
 * No DOM is built and no script in the response is executed. */
export function parseFundingListHtml(html: string): FundingList | undefined {
  const table = html.match(/<table\b[^>]*\bid\s*=\s*["']?easySearchTableListData\b[^>]*>([\s\S]*?)<\/table\s*>/i);
  if (!table) return undefined;
  const tableAttributes = attributes(table[0].slice(0, table[0].indexOf('>') + 1));
  const count = (value: string | undefined) => value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
  const items: FundingItem[] = [];
  let skipped = 0;
  for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const item = Object.fromEntries(Object.values(ROW_FIELDS).map(key => [key, ''])) as unknown as FundingItem;
    let seen = false;
    for (const input of row[1].matchAll(/<input\b[^>]*>/gi)) {
      const attrs = attributes(input[0]);
      const key = ROW_FIELDS[(attrs.name || '').toLowerCase()];
      if (!key) continue;
      seen = true;
      item[key] = (attrs.value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    if (!seen) continue;
    if (!FUNDING_CODE.test(item.projectId)) { skipped++; continue; }
    items.push(item);
  }
  return { dataCount: count(tableAttributes.datacount), pageCount: count(tableAttributes.pagecount), items, skipped };
}

/** Exact project code, or a keyword contained in exactly one label (spacing ignored). */
export function findFundingItem(list: FundingList, keyword: string): FundingItem {
  const wanted = keyword.replace(/\s+/g, '');
  if (!wanted) throw new FundingSearchError('invalid_query');
  const exact = list.items.filter(item => item.projectId === keyword.trim());
  const matches = exact.length ? exact
    : list.items.filter(item => (item.label || `${item.projectId}-${item.projectName}`).replace(/\s+/g, '').includes(wanted));
  const codes = new Set(matches.map(item => item.projectId));
  if (!codes.size) throw new FundingSearchError('item_missing');
  if (codes.size > 1) throw new FundingSearchError('item_ambiguous');
  return matches[0];
}

const errors = {
  invalid_query: '经费查询参数无效；类别须为 authorized 或 responsible，关键字不含控制字符，每页 1–100 条。',
  bpm_unavailable: '经费查询需要当前已登录的 BPM 报销页面；请重新打开原单。',
  form_context_missing: '当前报销页面未提供有效的账套（#mainAccountBook），未发送经费请求；可显式传入账套。',
  csrf_missing: '当前报销页面未提供可识别的 csrfToken；请重新打开原单。',
  csrf_ambiguous: '当前页面的 csrfToken 来源不一致；请刷新原单后重试。',
  csrf_invalid: '当前页面的 csrfToken 格式异常，未发送经费请求。',
  authentication: '经费接口要求重新认证或拒绝访问，请核对 BPM 登录状态和当前账号权限。',
  timeout: '经费查询超时，请稍后重试。',
  request_failed: '经费请求未完成，请检查校园网络和 BPM 登录状态。',
  http_error: '经费接口返回 HTTP 错误，未将其视为空列表。',
  non_json: '经费接口响应格式异常，未将其视为空列表。',
  response_invalid: '经费接口响应为空、过大或格式异常，未将其视为空列表。',
  server_rejected: '经费接口返回了 BPM 错误页（“错误的请求”），未将其视为空列表。',
  list_unrecognized: '经费接口响应中没有可识别的经费表格（#easySearchTableListData），无法按关键词匹配项目。',
  item_missing: '经费列表中没有与关键词匹配的项目；请核对关键词或改用 --funding-code。',
  item_ambiguous: '经费列表中有多个项目与关键词匹配；请补充关键词或改用 --funding-code。',
} as const;

export class FundingSearchError extends Error {
  constructor(readonly code: keyof typeof errors, readonly status?: number) {
    super(errors[code]);
    this.name = 'FundingSearchError';
  }
}

/** The editor dialog's request body, captured live on 2026-10-15. */
export function buildFundingSearchPayload(options: FundingSearchOptions = {}) {
  const allowed = new Set(['kind', 'paramValue', 'accountBook', 'pageSize']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) throw new FundingSearchError('invalid_query');
  const kind = options.kind ?? 'authorized', paramValue = options.paramValue ?? '';
  const accountBook = options.accountBook ?? '', pageSize = options.pageSize ?? 8;
  if (!Object.hasOwn(FUNDING_KINDS, kind) || typeof paramValue !== 'string' || paramValue.length > 100
    || /[\u0000-\u001f\u007f]/.test(paramValue) || typeof accountBook !== 'string'
    || (accountBook !== '' && !ACCOUNT_BOOK.test(accountBook))
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new FundingSearchError('invalid_query');
  return { queryName: 'queryFundingItems', pageSize: String(pageSize), configType: 'tech',
    paramValue: paramValue.trim(), fundingItemKind: FUNDING_KINDS[kind], accountBook, isMultipleSelect: 'false' };
}

/** Same request as the editor's 选择项目 dialog, sent from the open form so the
 * csrfToken/procTaskId headers and #mainAccountBook come from that document. */
export async function searchFundingItems(ctx: AutomationContext, options: FundingSearchOptions = {},
  timeoutMs = 20_000): Promise<FundingSearchResponse> {
  const query = buildFundingSearchPayload(options);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new FundingSearchError('invalid_query');
  const result = await postFromForm(ctx, {
    pathname: FUNDING_SEARCH_PATH, payload: query, expect: 'text', timeoutMs, accept: 'text/plain, */*; q=0.01',
    fromForm: { accountBook: { id: 'mainAccountBook', format: ACCOUNT_BOOK } },
  });
  if (result.error) throw new FundingSearchError(result.error, result.status);
  const text = result.data as string;
  return { queriedAt: new Date().toISOString(), query: result.payload as FundingSearchResponse['query'],
    httpStatus: result.status, response: text, list: interpretFundingHtml(text, result.status) };
}

/** Classify an easySearch body: login page, BPM error page, or the project table. */
export function interpretFundingHtml(text: string, status?: number): FundingList {
  const visibleText = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
  if (/<(?:input|form)\b[^>]*(?:type\s*=\s*["']?password|id\s*=\s*["']?(?:password|login_submit)|authserver\/login)/i.test(text)
    || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*authserver\/login/i.test(text)
    || /(?:登录|登陆)(?:超时|失效)|请重新登[录陆]|会话已过期/.test(visibleText)) {
    throw new FundingSearchError('authentication', status);
  }
  // An empty or malformed body yields BPM's generic page: #show_error_info "错误的请求!".
  if (/\bid\s*=\s*["']?show_error_info\b/i.test(text) || /出现错误|错误的请求/.test(visibleText)) {
    throw new FundingSearchError('server_rejected', status);
  }
  const list = parseFundingListHtml(text);
  if (!list) throw new FundingSearchError('list_unrecognized', status);
  return list;
}
