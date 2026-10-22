import { establishBpmSession, htmlInputs, HttpLoginError, EGATE_ORIGIN, type BpmPage, type OaHttpClient } from './http-login';
import { BPM_ORIGIN, type FormRequestError } from './form-request';
import { buildOwnerListPayload, listTarget, parseApplyTask, parseOwnerList, pickOwnerRow, ReimbursementListError,
  APPLY_TASK_PATH, OWNER_LIST_PATH, type ListTarget, type OwnerList, type OwnerListOptions } from './reimbursement-list';
import { buildReimbursementUrl, OpenReimbursementError, REIMBURSEMENT_PATH, type ReimbursementTarget } from './open-reimbursement';
import { normalizeFormContext, FORM_CONTEXT_FIELDS, type ReimbursementFormContext } from './reimbursement-context';
import { buildFundingSearchPayload, interpretFundingHtml, FundingSearchError, FUNDING_SEARCH_PATH,
  type FundingSearchOptions, type FundingSearchResponse } from './funding-search';
import { buildBudgetSearchPayload, parseBudgetOutlays, BudgetSearchError, BUDGET_SEARCH_PATH,
  type BudgetSearchOptions, type BudgetSearchResponse } from './budget-search';
import { buildTodoSearchPayload, extractTodoTargets, TaskSearchError, TASK_SEARCH_PATH,
  type TodoSearchOptions, type TodoSearchResponse } from './task-search';

const JSON_ACCEPT = 'application/json, text/javascript, */*; q=0.01';
const MAX_BODY = 5 * 1024 * 1024;

/** A BPM page loaded over HTTP whose csrfToken (and, for a form, job ids) back its Ajax calls. */
export interface BpmDocument { url: string; csrfToken: string; procTaskId?: string }

type PostResult = { error: FormRequestError; status?: number } | { error?: undefined; status: number; text: string };

/** Form POST as the page's own jQuery calls: csrfToken (+ procTaskId) headers, page as Referer. */
export async function bpmPost(client: OaHttpClient, document: BpmDocument, pathname: string,
  payload: Record<string, string>, accept: string): Promise<PostResult> {
  let response;
  try {
    response = await client.request(new URL(pathname, BPM_ORIGIN).href, { method: 'POST', followRedirects: false,
      body: new URLSearchParams(payload).toString(),
      headers: { accept, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest',
        csrfToken: document.csrfToken, ...(document.procTaskId ? { procTaskId: document.procTaskId } : {}),
        origin: BPM_ORIGIN, referer: document.url } });
  } catch {
    return { error: 'request_failed' };
  }
  const status = response.status;
  if ((status >= 300 && status < 400) || status === 401 || status === 403) return { error: 'authentication', status };
  if (status < 200 || status >= 300) return { error: 'http_error', status };
  if (!response.text.trim() || response.bytes.length > MAX_BODY) return { error: 'response_invalid', status };
  return { status, text: response.text.split(document.csrfToken).join('[REDACTED]') };
}

function json(result: Extract<PostResult, { text: string }>): { data: unknown } | { error: FormRequestError } {
  try {
    const data = JSON.parse(result.text);
    return data && typeof data === 'object' ? { data } : { error: 'response_invalid' };
  } catch {
    return { error: /^\s*[[{]/.test(result.text) ? 'response_invalid' : 'non_json' };
  }
}

export async function openOwnerQueryHttp(client: OaHttpClient): Promise<BpmDocument> {
  try {
    const page: BpmPage = await establishBpmSession(client);
    return { url: page.url, csrfToken: page.csrfToken };
  } catch (error) {
    if (error instanceof HttpLoginError && error.code === 'bpm_unverified') throw new ReimbursementListError('bpm_unavailable');
    throw error;
  }
}

export async function searchOwnerHttp(client: OaHttpClient, page: BpmDocument, options: OwnerListOptions = {})
  : Promise<{ query: ReturnType<typeof buildOwnerListPayload>; response: unknown; list: OwnerList }> {
  const query = buildOwnerListPayload(options);
  const result = await bpmPost(client, page, OWNER_LIST_PATH, query, JSON_ACCEPT);
  if (result.error) throw new ReimbursementListError(result.error, result.status);
  const parsed = json(result);
  if ('error' in parsed) throw new ReimbursementListError(parsed.error, result.status);
  const list = parseOwnerList(parsed.data);
  if (!list) throw new ReimbursementListError('response_invalid', result.status);
  return { query, response: parsed.data, list };
}

/** 报销单查询 (bill code → bizId) + getApplyTaskInfo (→ taskId), with the browser path's checks. */
export async function resolveListTargetHttp(client: OaHttpClient, documentNumber: string, isReadOnly = false): Promise<ListTarget> {
  if (!/^[AD]\d{1,32}$/.test(documentNumber)) throw new ReimbursementListError('invalid_query');
  const page = await openOwnerQueryHttp(client);
  const row = pickOwnerRow((await searchOwnerHttp(client, page, { billCode: documentNumber })).list, documentNumber);
  const result = await bpmPost(client, page, APPLY_TASK_PATH, { bizId: row.bizId, checkSubProcUnitId: 'financialContactPerson' }, JSON_ACCEPT);
  if (result.error) throw new ReimbursementListError(result.error, result.status);
  const parsed = json(result);
  if ('error' in parsed) throw new ReimbursementListError(parsed.error, result.status);
  const task = parseApplyTask(parsed.data);
  if (!task) throw new ReimbursementListError('task_missing', result.status);
  return listTarget(row, task, documentNumber, isReadOnly);
}

export interface HttpForm extends BpmDocument { documentNumber: string; context: ReimbursementFormContext }

/** Value of an element by id: an input's value, or a select's selected option. */
function elementValue(html: string, id: string): string | undefined {
  const input = htmlInputs(html).filter(attrs => attrs.id === id);
  if (input.length) return input.length === 1 ? input[0].value ?? '' : undefined;
  const select = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</select>`, 'i'))?.[1];
  const selected = select?.match(/<option\b[^>]*\bselected\b[^>]*>/i)?.[0];
  return selected ? htmlInputs(selected.replace(/^<option/i, '<input'))[0]?.value : undefined;
}

/** GET the editor HTML (no scripts run) and verify its hidden job fields name the target. */
export async function openFormHttp(client: OaHttpClient, target: ReimbursementTarget): Promise<HttpForm> {
  const url = buildReimbursementUrl(target);
  let page;
  try { page = await client.request(url); }
  catch (error) {
    if (error instanceof HttpLoginError && error.code === 'unexpected_redirect') throw new OpenReimbursementError('authentication');
    throw new OpenReimbursementError('request_failed');
  }
  const final = new URL(page.url), expected = new URL(url);
  if (final.hostname === 'ids.shanghaitech.edu.cn') throw new OpenReimbursementError('authentication');
  if (page.status === 401) throw new OpenReimbursementError('authentication');
  if (page.status === 403) throw new OpenReimbursementError('forbidden');
  if (page.status !== 200) throw new OpenReimbursementError('request_failed');
  if (final.origin !== expected.origin || final.pathname.replace(/\/{2,}/g, '/') !== REIMBURSEMENT_PATH
    || ['bizId', 'taskId', 'isReadOnly'].some(key => final.searchParams.getAll(key).length !== 1
      || final.searchParams.get(key) !== expected.searchParams.get(key))) throw new OpenReimbursementError('wrong_target');
  const context = normalizeFormContext(Object.fromEntries(Object.entries(FORM_CONTEXT_FIELDS)
    .map(([key, id]) => [key, elementValue(page.text, id) ?? ''])));
  if (!context.bizId || !context.taskId) throw new OpenReimbursementError('form_unavailable');
  if (context.bizId.toLowerCase() !== target.bizId.toLowerCase()
    || context.taskId.toLowerCase() !== target.taskId.toLowerCase()) throw new OpenReimbursementError('wrong_target');
  if (target.expectedDocumentNumber && context.documentNumber !== target.expectedDocumentNumber) {
    throw new OpenReimbursementError('document_mismatch');
  }
  const tokens = [...new Set(htmlInputs(page.text).filter(attrs => attrs.id === 'csrfTokenElement'
    || attrs.name === 'csrfToken' || attrs.id === 'csrfToken').map(attrs => attrs.value ?? '').filter(Boolean))];
  if (tokens.length !== 1 || !/^[\x21-\x7e]{1,4096}$/.test(tokens[0])) throw new OpenReimbursementError('form_unavailable');
  return { url: page.url, csrfToken: tokens[0], procTaskId: context.taskId, documentNumber: context.documentNumber, context };
}

/** Any BPM page's csrfToken authorizes easySearch.load and the budget query (verified
 * live 2026-10-15 from 报销单查询); a form only contributes procTaskId and defaults. */
export type QueryDocument = BpmDocument & { context?: Partial<ReimbursementFormContext> };

export async function searchFundingHttp(client: OaHttpClient, form: QueryDocument, options: FundingSearchOptions = {})
  : Promise<FundingSearchResponse> {
  const query = buildFundingSearchPayload(options);
  if (!query.accountBook) query.accountBook = form.context?.accountBook ?? '';
  if (!query.accountBook) throw new FundingSearchError('form_context_missing');
  const result = await bpmPost(client, form, FUNDING_SEARCH_PATH, query, 'text/plain, */*; q=0.01');
  if (result.error) throw new FundingSearchError(result.error, result.status);
  return { queriedAt: new Date().toISOString(), query, httpStatus: result.status, response: result.text,
    list: interpretFundingHtml(result.text, result.status) };
}

export async function searchBudgetHttp(client: OaHttpClient, form: QueryDocument, options: BudgetSearchOptions)
  : Promise<BudgetSearchResponse> {
  const query = buildBudgetSearchPayload(options);
  if (!query.accountBook) query.accountBook = form.context?.accountBook ?? '';
  if (!query.reimbursementKind) query.reimbursementKind = form.context?.reimbursementKind ?? '';
  if (!query.accountBook || !query.reimbursementKind) throw new BudgetSearchError('form_context_missing');
  const result = await bpmPost(client, form, BUDGET_SEARCH_PATH, query, JSON_ACCEPT);
  if (result.error) throw new BudgetSearchError(result.error, result.status);
  const parsed = json(result);
  if ('error' in parsed) throw new BudgetSearchError(parsed.error, result.status);
  const data = parsed.data as BudgetSearchResponse['response'];
  // BPM answers an expired session with HTTP 200 { status: "2", isAuth: 1, message: "登录超时，请重新登录!" }.
  const envelope = data as { isAuth?: unknown; message?: unknown };
  if (envelope.isAuth !== undefined || /登录超时|重新登录/.test(typeof envelope.message === 'string' ? envelope.message : '')) {
    throw new BudgetSearchError('authentication', result.status);
  }
  const outlays = parseBudgetOutlays(data, query.fundingItemsCode);
  return { queriedAt: new Date().toISOString(), query, httpStatus: result.status, response: data, ...(outlays ? { outlays } : {}) };
}

export interface ApplyMoneyTodo { documentNumber: string; date: string; target: ReimbursementTarget }

/** The applicant's own handling step of a 用款申请单 (live 2026-10-15); stale tasks have no node. */
export const APPLY_MONEY_NODE = '网上预约报销申请单';
const APPLY_MONEY_SUBJECT = /\[用款申请单-(A\d{1,32})\]\((\d{4}-\d{2}-\d{2})\)/;

/** 用款申请单 the user can still fill in, from the portal todo list (subject filter is
 * applied by the server). Each needs one handling link whose bill code matches the subject. */
export async function listApplyMoneyTodosHttp(client: OaHttpClient, maxPages = 5): Promise<ApplyMoneyTodo[]> {
  const todos: ApplyMoneyTodo[] = [];
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const result = await searchTodoHttp(client, { subject: '用款申请单', pageNumber, pageSize: 100 });
    const envelope = result.response as { datas?: unknown; pages?: unknown };
    if (!Array.isArray(envelope.datas)) throw new TaskSearchError('response_invalid', result.httpStatus);
    for (const record of envelope.datas as Array<Record<string, unknown>>) {
      const match = typeof record?.subject === 'string' ? record.subject.match(APPLY_MONEY_SUBJECT) : null;
      if (!match || record.nodeName !== APPLY_MONEY_NODE || todos.some(todo => todo.documentNumber === match[1])) continue;
      const targets = extractTodoTargets({ datas: [record] })
        .filter(target => target.kind === 'handling' && (!target.documentNumber || target.documentNumber === match[1]));
      if (new Set(targets.map(target => `${target.bizId}/${target.taskId}`.toLowerCase())).size !== 1) continue;
      todos.push({ documentNumber: match[1], date: match[2],
        target: { bizId: targets[0].bizId, taskId: targets[0].taskId, isReadOnly: false, expectedDocumentNumber: match[1] } });
    }
    if (!Number.isSafeInteger(envelope.pages) || pageNumber >= (envelope.pages as number)) break;
  }
  return todos;
}

/** A 用款申请单 still at 预制 with nothing saved into it, under the bizId the todo links to. */
function isBlankApplyMoney(row: OwnerList['rows'][number], todo: ApplyMoneyTodo): boolean {
  return row.blank && row.status === '0' && row.reimbursementKind === 'applyMoney'
    && row.bizId.toLowerCase() === todo.target.bizId.toLowerCase();
}

export interface BlankApplyMoney { forms: ApplyMoneyTodo[]; filled: number; unchecked: number }

async function checkBlank(client: OaHttpClient, page: BpmDocument, todo: ApplyMoneyTodo): Promise<boolean> {
  const { list } = await searchOwnerHttp(client, page, { billCode: todo.documentNumber });
  return isBlankApplyMoney(pickOwnerRow(list, todo.documentNumber), todo);
}

/** Todo 用款申请单 whose 报销单查询 row shows no content, looked up by bill code (paging
 * the whole list returns short pages, live 2026-10-15). Lookups that fail are left out
 * (unchecked); an expired session still aborts. */
export async function listBlankApplyMoneyHttp(client: OaHttpClient, concurrency = 4): Promise<BlankApplyMoney> {
  const todos = await listApplyMoneyTodosHttp(client);
  if (!todos.length) return { forms: [], filled: 0, unchecked: 0 };
  const page = await openOwnerQueryHttp(client);
  const results: Array<boolean | undefined> = new Array(todos.length);
  const lookup = async (index: number) => {
    try {
      results[index] = await checkBlank(client, page, todos[index]);
    } catch (error) {
      if ((error as { code?: string })?.code === 'authentication') throw error;
    }
  };
  let next = 0;
  const worker = async () => { while (next < todos.length) await lookup(next++); };
  await Promise.all(Array.from({ length: Math.min(concurrency, todos.length) }, worker));
  // Read-only lookups that failed under concurrent load get one sequential retry.
  for (let index = 0; index < todos.length; index++) if (results[index] === undefined) await lookup(index);
  return { forms: todos.filter((_, index) => results[index] === true),
    filled: results.filter(result => result === false).length,
    unchecked: results.filter(result => result === undefined).length };
}

/** Re-reads one form's 报销单查询 row right before it is used. */
export async function isBlankApplyMoneyHttp(client: OaHttpClient, todo: ApplyMoneyTodo): Promise<boolean> {
  return checkBlank(client, await openOwnerQueryHttp(client), todo);
}

/** Drafts (status 0 预制) are the forms the applicant can still fill in; newest first. */
export async function listDraftsHttp(client: OaHttpClient, page: BpmDocument, maxPages = 3): Promise<OwnerList['rows']> {
  const drafts: OwnerList['rows'] = [];
  for (let index = 1; index <= maxPages; index++) {
    const { list } = await searchOwnerHttp(client, page, { page: index, pagesize: 100 });
    drafts.push(...list.rows.filter(row => row.status === '0'));
    if (list.rows.length < 100 || (list.total !== undefined && index * 100 >= list.total)) break;
  }
  return drafts;
}

export const CREATE_ENTRY_PATH = '/bpm-new/rbReimbursement/forwardAddRbReimbursement.do';
export const CREATE_PATH = '/bpm-new/rbReimbursement/createReimbursement.ajax';

const createErrors = {
  entry_unavailable: '未能打开 BPM“网上预约报销”创建入口，请重新登录后重试。',
  kind_unavailable: '创建入口中没有该报销类型或账套，未发送创建请求。',
  authentication: '创建接口要求重新认证，未确认是否已创建；请先在报销单列表中查看，再决定是否重试。',
  create_rejected: 'BPM 拒绝创建报销单。',
  create_result_unknown: '已发送一次创建请求，但无法确认结果；请勿重复点击，先刷新报销单列表查看是否已生成新草稿。',
} as const;

export class CreateReimbursementError extends Error {
  constructor(readonly code: keyof typeof createErrors, readonly detail?: string) {
    super(detail ? `${createErrors[code]}（${detail}）` : createErrors[code]);
    this.name = 'CreateReimbursementError';
  }
}

export interface CreateOption { kind: string; title: string }
export interface CreateEntry extends BpmDocument { kinds: CreateOption[]; accountBooks: Array<{ code: string; name: string }> }

/** The 网上预约报销 page: its "创建" buttons (data-kind/title) and #accountBook options. */
export async function openCreateEntryHttp(client: OaHttpClient): Promise<CreateEntry> {
  const page = await client.request(new URL(CREATE_ENTRY_PATH, BPM_ORIGIN).href).catch(() => undefined);
  if (!page || page.status !== 200 || new URL(page.url).pathname.replace(/\/{2,}/g, '/') !== CREATE_ENTRY_PATH) {
    throw new CreateReimbursementError('entry_unavailable');
  }
  const tokens = [...new Set(htmlInputs(page.text).filter(attrs => attrs.id === 'csrfTokenElement').map(attrs => attrs.value ?? ''))];
  if (tokens.length !== 1 || !/^[\x21-\x7e]{1,4096}$/.test(tokens[0])) throw new CreateReimbursementError('entry_unavailable');
  const kinds: CreateOption[] = [];
  for (const match of page.text.matchAll(/<button\b[^>]*\bclass=["'][^"']*\binsert\b[^"']*["'][^>]*>/gi)) {
    const attrs = htmlInputs(match[0].replace(/^<button/i, '<input'))[0] ?? {};
    const kind = attrs['data-kind'] ?? '', title = (attrs.title ?? '').trim();
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kind) && title && !kinds.some(item => item.kind === kind)) kinds.push({ kind, title });
  }
  const select = page.text.match(/<select\b[^>]*\bid=["']accountBook["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? '';
  const accountBooks = [...select.matchAll(/<option\b[^>]*\bvalue=["']([A-Za-z0-9_-]{1,32})["'][^>]*>([^<]*)<\/option>/gi)]
    .map(match => ({ code: match[1], name: match[2].trim() }));
  if (!kinds.length || !accountBooks.length) throw new CreateReimbursementError('entry_unavailable');
  return { url: page.url, csrfToken: tokens[0], kinds, accountBooks };
}

/** Public.encodeURI of the BPM common.js: encodeURI, escape & and +, encodeURI again. */
export function bpmEncodeURI(value: string): string {
  return value ? encodeURI(encodeURI(value).replace(/&/g, '%26').replace(/\+/g, '%2B')) : '';
}

function createdIds(data: unknown): ReimbursementTarget | undefined {
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const bizId = typeof record?.bizId === 'string' ? record.bizId : '', taskId = typeof record?.taskId === 'string' ? record.taskId : '';
  return /^[\da-f]{32}$/i.test(bizId) && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId)
    ? { bizId, taskId, isReadOnly: false } : undefined;
}

/** The "创建 → 确定" of rbReimbursementAdd.js: one createReimbursement.ajax, never retried.
 * The returned bizId/taskId are the params of showLoadRbReimbursement.job; the opened
 * form's hidden fields must confirm them. */
export async function createReimbursementHttp(client: OaHttpClient, kind: string, accountBook = 'ST00'): Promise<HttpForm> {
  const entry = await openCreateEntryHttp(client);
  const book = entry.accountBooks.find(item => item.code === accountBook);
  if (!entry.kinds.some(item => item.kind === kind) || !book) throw new CreateReimbursementError('kind_unavailable');
  const result = await bpmPost(client, entry, CREATE_PATH,
    { reimbursementKind: kind, accountBook: book.code, accountBookName: bpmEncodeURI(book.name) }, JSON_ACCEPT);
  if (result.error === 'authentication') throw new CreateReimbursementError('authentication');
  if (result.error) throw new CreateReimbursementError('create_result_unknown');
  let envelope: Record<string, unknown> | undefined;
  try { envelope = JSON.parse(result.text); } catch { /* checked below */ }
  if (!envelope || typeof envelope !== 'object') throw new CreateReimbursementError('create_result_unknown');
  if (String(envelope.status) !== '0') {
    const message = typeof envelope.message === 'string' ? envelope.message.replace(/<[^>]*>/g, '').trim().slice(0, 200) : '';
    // Status 1/2 are BPM's business errors (Public.ajaxCallback); anything else is unknown.
    if (['1', '2'].includes(String(envelope.status))) throw new CreateReimbursementError('create_rejected', message || undefined);
    throw new CreateReimbursementError('create_result_unknown');
  }
  const target = createdIds(envelope.data);
  if (!target) throw new CreateReimbursementError('create_result_unknown');
  try { return await openFormHttp(client, target); }
  catch { throw new CreateReimbursementError('create_result_unknown', `bizId ${target.bizId}`); }
}

export async function searchTodoHttp(client: OaHttpClient, options: TodoSearchOptions = {}): Promise<TodoSearchResponse> {
  const query = buildTodoSearchPayload(options);
  let response;
  try {
    response = await client.request(`${EGATE_ORIGIN}${TASK_SEARCH_PATH}`, { method: 'POST', followRedirects: false,
      body: JSON.stringify(query), headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*',
        origin: EGATE_ORIGIN, referer: `${EGATE_ORIGIN}/CUS_TEMPLATE_OFFICIAL/pc/index.html` } });
  } catch { throw new TaskSearchError('request_failed'); }
  const status = response.status;
  if ((status >= 300 && status < 400) || status === 401 || status === 403) throw new TaskSearchError('authentication', status);
  if (status < 200 || status >= 300) throw new TaskSearchError('http_error', status);
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) throw new TaskSearchError('non_json', status);
  let data: unknown;
  try { data = JSON.parse(response.text); } catch { throw new TaskSearchError('response_invalid', status); }
  if (!data || typeof data !== 'object' || response.bytes.length > MAX_BODY) throw new TaskSearchError('response_invalid', status);
  return { queriedAt: new Date().toISOString(), query, httpStatus: status,
    response: data as TodoSearchResponse['response'], targets: extractTodoTargets(data) };
}
