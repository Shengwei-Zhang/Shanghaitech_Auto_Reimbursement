import type { Page } from 'playwright';
import { isEgateShellUrl } from './auth';

export const TASK_SEARCH_ORIGIN = 'https://egate-new.shanghaitech.edu.cn';
export const TASK_SEARCH_PATH = '/custom/api/v2/casp-tdc/task/search';

export interface TodoSearchOptions {
  pageNumber?: number;
  pageSize?: number;
  subject?: string;
  bizSceneCode?: string;
  startTime?: string;
  endTime?: string;
  taskType?: string;
  priority?: string;
  isExpire?: string;
  isIgnore?: '0' | '1';
}

export const TASK_SEARCH_ERRORS = {
  invalid_query: '待办查询参数无效；页码须为正整数，每页 1–100 条，筛选条件须为字符串。',
  portal_unavailable: '请先打开并登录学校门户页面，再查询待办任务。',
  authentication: '待办接口要求重新认证或拒绝访问；请在学校页面核对登录状态。',
  timeout: '待办查询超时；没有执行报销写入操作。',
  request_failed: '待办请求未完成；请检查校园网络及门户页面状态。',
  http_error: '待办接口返回 HTTP 错误，未将其视为空列表。',
  non_json: '待办接口没有返回 JSON，可能是登录页或网关提示；请核对学校页面。',
  response_invalid: '待办接口返回的 JSON 格式不适用于任务查询；未将其视为空列表。',
  target_missing: '待办结果中没有找到该单据可用的 bizId 和 taskId；请改用 --biz-id、--task-id，或核对单据是否仍在本人待办中。',
  target_ambiguous: '待办结果中有多个办理目标与该单据匹配；请改用 --biz-id、--task-id 明确指定。',
} as const;

export class TaskSearchError extends Error {
  constructor(readonly code: keyof typeof TASK_SEARCH_ERRORS, readonly status?: number) {
    super(TASK_SEARCH_ERRORS[code]);
  }
}

export function buildTodoSearchPayload(options: TodoSearchOptions = {}, now = Date.now()) {
  const allowed = new Set(['pageNumber', 'pageSize', 'subject', 'bizSceneCode', 'startTime',
    'endTime', 'taskType', 'priority', 'isExpire', 'isIgnore']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.has(key))) throw new TaskSearchError('invalid_query');
  const pageNumber = options.pageNumber ?? 1, pageSize = options.pageSize ?? 10;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(pageSize)
    || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(now) || now < 0) {
    throw new TaskSearchError('invalid_query');
  }
  const field = (value: unknown) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u001f]/.test(value)) {
      throw new TaskSearchError('invalid_query');
    }
    return value.trim();
  };
  const isIgnore = options.isIgnore ?? '0';
  if (!['0', '1'].includes(isIgnore)) throw new TaskSearchError('invalid_query');
  return {
    type: 1, pageNumber, pageSize, subject: field(options.subject), bizSceneCode: field(options.bizSceneCode),
    startTime: field(options.startTime), endTime: field(options.endTime), taskType: field(options.taskType),
    priority: field(options.priority), isExpire: field(options.isExpire), isIgnore, _t: now,
  };
}

export interface TodoSearchResponse {
  queriedAt: string;
  query: ReturnType<typeof buildTodoSearchPayload>;
  httpStatus: number;
  /** The response envelope has not yet been calibrated against live OA data. */
  response: Record<string, unknown> | unknown[];
  /** BPM reimbursement targets found in the response; see extractTodoTargets. */
  targets: TodoTarget[];
}

export interface TodoTarget {
  bizId: string;
  taskId: string;
  /** Bill code (A + digits) found in the same record, when exactly one is present. */
  documentNumber: string;
  /** 'link': a BPM showLoadRbReimbursement.job URL; 'fields': sibling bizId/taskId keys. */
  source: 'link' | 'fields';
  /** 'notification': a 通知任务 pointing at the form, not its handling task; never selected. */
  kind: 'handling' | 'notification';
  /** JSON path of the record, e.g. $.data.records[2]. */
  path: string;
}

const BIZ_ID = /^[\da-f]{32}$/i;
const TASK_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const BPM_ORIGIN = 'https://sapbpm-new.shanghaitech.edu.cn:9091';
const BPM_FORM_PATH = '/bpm-new/rbReimbursement/showLoadRbReimbursement.job';

/** A handling link may be wrapped by SSO or portal redirects as an encoded
 * parameter. Only the BPM reimbursement endpoint itself yields IDs. */
type LinkIds = { bizId: string; taskId: string; readOnlyParams: number };

function idsFromLink(value: string, depth = 0): LinkIds[] {
  if (depth > 3 || value.length > 8192 || !/bizid/i.test(value)) return [];
  let url: URL;
  try { url = new URL(value, BPM_ORIGIN); } catch { return []; }
  if (!/^https?:$/.test(url.protocol)) return [];
  const found: LinkIds[] = [];
  if (url.origin === BPM_ORIGIN && url.pathname === BPM_FORM_PATH) {
    const bizId = url.searchParams.getAll('bizId'), taskId = url.searchParams.getAll('taskId');
    if (bizId.length === 1 && taskId.length === 1 && BIZ_ID.test(bizId[0]) && TASK_ID.test(taskId[0])) {
      found.push({ bizId: bizId[0], taskId: taskId[0], readOnlyParams: url.searchParams.getAll('isReadOnly').length });
    }
  }
  let hash = '';
  try { hash = decodeURIComponent(url.hash.slice(1)); } catch { /* A malformed fragment carries no target. */ }
  for (const nested of [...url.searchParams.values(), hash]) {
    if (/^https?:\/\/|^\/bpm-new\//i.test(nested)) found.push(...idsFromLink(nested, depth + 1));
  }
  return found;
}

/** Find reimbursement handling targets without assuming the envelope shape.
 * Every candidate must still be confirmed by opening the form (whose hidden
 * job fields are compared with the IDs) before any further use. */
export function extractTodoTargets(response: unknown): TodoTarget[] {
  const targets = new Map<string, TodoTarget>();
  let visited = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 12 || ++visited > 50_000) return;
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
    const record = node as Record<string, unknown>;
    const strings = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const numbers = new Set(strings.flatMap(([, value]) => value.match(/(?<![A-Za-z\d])A\d{12,32}(?!\d)/g) || []));
    const documentNumber = numbers.size === 1 ? [...numbers][0] : '';
    const field = (name: string) => strings.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1].trim() || '';
    // Live portal data (2026-10-15): handling todos link with one isReadOnly and
    // bizKey === bizId; 通知任务 links repeat isReadOnly and carry a UUID_… bizKey.
    const notice = /^\s*通知任务/.test(field('nodeName')) || /^\s*通知任务/.test(field('subject'));
    const bizKey = field('bizKey');
    const add = (bizId: string, taskId: string, source: TodoTarget['source'], readOnlyParams = 0) => {
      const key = `${bizId.toLowerCase()}|${taskId.toLowerCase()}`;
      const kind = notice || readOnlyParams > 1 || (bizKey && bizKey.toLowerCase() !== bizId.toLowerCase())
        ? 'notification' : 'handling';
      const known = targets.get(key);
      if (!known) targets.set(key, { bizId, taskId, documentNumber, source, kind, path });
      else if (kind === 'notification') known.kind = kind;
    };
    for (const [, value] of strings) {
      for (const ids of idsFromLink(value)) add(ids.bizId, ids.taskId, 'link', ids.readOnlyParams);
    }
    const bizId = field('bizId'), taskId = field('taskId');
    if (BIZ_ID.test(bizId) && TASK_ID.test(taskId)) add(bizId, taskId, 'fields');
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === 'object') walk(value, `${path}.${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}`, depth + 1);
    }
  };
  walk(response, '$', 0);
  return [...targets.values()];
}

/** Exactly one handling target for this bill code; notifications and records
 * naming a different code are excluded. */
export function selectTodoTarget(allTargets: TodoTarget[], documentNumber: string): TodoTarget {
  const targets = allTargets.filter(target => target.kind === 'handling');
  const named = targets.filter(target => target.documentNumber === documentNumber);
  const unnamed = targets.filter(target => !target.documentNumber);
  // An unnamed record is only acceptable when it is the sole candidate; the
  // opened page's bill code is compared with documentNumber afterwards.
  const matches = named.length ? named : unnamed.length === targets.length ? unnamed : [];
  if (!matches.length) throw new TaskSearchError('target_missing');
  if (matches.length > 1) throw new TaskSearchError('target_ambiguous');
  return matches[0];
}

/** Search the portal todo list by bill code and return its unique BPM target. */
export async function resolveTodoTarget(page: Page, documentNumber: string, timeoutMs = 20_000)
  : Promise<TodoTarget> {
  if (!/^A\d{1,32}$/.test(documentNumber)) throw new TaskSearchError('invalid_query');
  const result = await searchTodoTasks(page, { subject: documentNumber, pageSize: 20 }, timeoutMs);
  return selectTodoTarget(result.targets, documentNumber);
}

/** Read-only POST in the authenticated portal. The browser supplies HttpOnly
 * cookies, Origin, Referer, User-Agent and client hints; none are copied to Node. */
export async function searchTodoTasks(page: Page, options: TodoSearchOptions = {},
  timeoutMs = 20_000): Promise<TodoSearchResponse> {
  const query = buildTodoSearchPayload(options);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TaskSearchError('invalid_query');
  }
  if (page.isClosed() || !isEgateShellUrl(page.url()) || new URL(page.url()).origin !== TASK_SEARCH_ORIGIN) {
    throw new TaskSearchError('portal_unavailable');
  }
  let result;
  try {
    result = await page.evaluate(async ({ origin, pathname, payload, timeout }) => {
      if (location.origin !== origin) return { error: 'portal_unavailable' as const };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(new URL(pathname, origin).href, {
          method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'manual', cache: 'no-store',
          headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal,
        });
        const status = response.status;
        if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)
          || status === 401 || status === 403) return { error: 'authentication' as const, status };
        if (!response.ok) return { error: 'http_error' as const, status };
        if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) {
          return { error: 'non_json' as const, status };
        }
        const text = await response.text();
        if (text.length > 5 * 1024 * 1024) return { error: 'response_invalid' as const, status };
        let data: unknown;
        try { data = JSON.parse(text); }
        catch { return { error: 'response_invalid' as const, status }; }
        if (!data || typeof data !== 'object') return { error: 'response_invalid' as const, status };
        return { data: data as Record<string, unknown> | unknown[], status };
      } catch {
        return { error: controller.signal.aborted ? 'timeout' as const : 'request_failed' as const };
      } finally { clearTimeout(timer); }
    }, { origin: TASK_SEARCH_ORIGIN, pathname: TASK_SEARCH_PATH, payload: query, timeout: timeoutMs });
  } catch {
    // Playwright errors can contain URLs/tickets or page content. Expose only a
    // fixed classification, not the original exception or request headers.
    throw new TaskSearchError('request_failed');
  }
  if (result.error) throw new TaskSearchError(result.error, result.status);
  return { queriedAt: new Date().toISOString(), query, httpStatus: result.status!, response: result.data!,
    targets: extractTodoTargets(result.data) };
}
