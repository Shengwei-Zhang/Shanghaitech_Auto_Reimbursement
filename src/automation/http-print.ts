import type { OaHttpClient } from './http-login';
import { BPM_ORIGIN } from './form-request';
import { searchOwnerHttp, type BpmDocument } from './http-bpm';
import { ANY_BILL_CODE, parseOwnerList, type OwnerReimbursement } from './reimbursement-list';

/** The 报销单查询 print chain, captured live 2026-10-21 (rbReimbursementQueryCommonFun.js):
 * permission check for bills still in approval, 打印状态 check, watermark path, then a form
 * POST of printRbReimbursement.load whose HTML holds every page as an inline JPEG. */
export const PRINT_PATHS = {
  permission: '/bpm-new/rbReimbursement/testReimbursementPrintPermission.ajax',
  status: '/bpm-new/rbReimbursement/checkReimbursementPrintStatus.ajax',
  watermark: '/bpm-new/techPdf/queryWatermarkPathByBizIdOrTaskId.ajax',
  page: '/bpm-new/rbReimbursement/printRbReimbursement.load',
} as const;

/** checkPrintBtnStatus with isMainQuery: 2/3/5 print at once; -1 取消, 0 预制, 4 驳回 and
 * 6 终止 never; any other status (1 提交) asks testReimbursementPrintPermission first. */
export function printRule(status: string): 'yes' | 'no' | 'check' {
  if (['2', '3', '5'].includes(status)) return 'yes';
  if (['-1', '0', '4', '6'].includes(status)) return 'no';
  return 'check';
}

export class PrintError extends Error {
  constructor(readonly code: 'authentication' | 'request_failed' | 'response_invalid' | 'not_printable' | 'not_listed', message?: string) {
    super(message ?? {
      authentication: '学校 OA 登录已失效。',
      request_failed: '学校 OA 打印请求未完成，请检查校园网络/VPN 后重试。',
      response_invalid: '学校 OA 返回了无法识别的打印结果。',
      not_printable: '该报销单当前不能打印。',
      not_listed: '报销单不在本次读取的列表中，请先刷新列表。',
    }[code]);
  }
}

const MAX_PAGE_BYTES = 40 * 1024 * 1024;

async function send(client: OaHttpClient, page: BpmDocument, pathname: string, form: Record<string, string>, ajax: boolean): Promise<string> {
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${pathname}`, { method: 'POST', followRedirects: false,
      body: new URLSearchParams(form).toString(),
      headers: { 'content-type': `application/x-www-form-urlencoded${ajax ? '; charset=UTF-8' : ''}`,
        ...(ajax ? { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' } : {}),
        csrfToken: page.csrfToken, origin: BPM_ORIGIN, referer: page.url } });
  } catch { throw new PrintError('request_failed'); }
  if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) throw new PrintError('authentication');
  if (response.status !== 200 || response.bytes.length > MAX_PAGE_BYTES) throw new PrintError('response_invalid');
  return response.text;
}

function envelope(text: string): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new PrintError('response_invalid'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PrintError('response_invalid');
  const result = data as Record<string, unknown>;
  if (result.isAuth !== undefined || /登录超时|重新登录/.test(String(result.message ?? ''))) throw new PrintError('authentication');
  return result;
}

/** 状态 filter of 报销单查询 for bills to print: only 提交 (in approval) needs a printed copy. */
export const PRINT_STATUS_KIND = '1';

/** The newest 提交 bills, filtered by OA itself (queryStatusKind), one page of at most 100, each
 * with its print rule. A row in another status is dropped, should OA ever ignore the filter. */
export async function listPrintableHttp(client: OaHttpClient, page: BpmDocument, pagesize = 100)
  : Promise<{ total?: number; rows: Array<OwnerReimbursement & { print: ReturnType<typeof printRule> }> }> {
  // Every bill type prints the same way, so its rows are read again with any bill code (A/D/G…).
  const { response } = await searchOwnerHttp(client, page, { page: 1, pagesize, queryStatusKind: PRINT_STATUS_KIND });
  const list = parseOwnerList(response, ANY_BILL_CODE);
  if (!list) throw new PrintError('response_invalid');
  return { ...(list.total === undefined ? {} : { total: list.total }),
    rows: list.rows.filter(row => row.status === PRINT_STATUS_KIND).map(row => ({ ...row, print: printRule(row.status) })) };
}

/** testReimbursementPrintPermission: {"data":{"success":true},"status":0} when allowed. */
export async function printPermissionHttp(client: OaHttpClient, page: BpmDocument, bizId: string): Promise<{ allowed: boolean; message?: string }> {
  const result = envelope(await send(client, page, PRINT_PATHS.permission, { bizId }, true));
  const data = result.data as { success?: unknown; message?: unknown } | undefined;
  return data?.success === true ? { allowed: true } : { allowed: false, ...(typeof data?.message === 'string' ? { message: data.message } : {}) };
}

/** One bill's print page exactly as the 打印 button gets it: 打印状态 check, watermark path, page. */
export async function fetchPrintPageHttp(client: OaHttpClient, page: BpmDocument, bizId: string): Promise<string> {
  const status = envelope(await send(client, page, PRINT_PATHS.status, { id: bizId }, true));
  if (String(status.status) !== '1') throw new PrintError('not_printable', typeof status.message === 'string' && status.message ? status.message : undefined);
  const mark = envelope(await send(client, page, PRINT_PATHS.watermark, { bizId }, true));
  const html = await send(client, page, PRINT_PATHS.page, { id: bizId, outputType: 'img',
    markImagePath: typeof mark.data === 'string' ? mark.data : '', csrfToken: page.csrfToken }, false);
  if (!/class="page-image"/.test(html) || !/<img\b[^>]*src="data:image\//.test(html)) throw new PrintError('response_invalid');
  return html;
}

const PRINT_STYLE_FALLBACK = 'html,body{margin:0;padding:0}img{max-width:99%;display:block;margin:0 auto}'
  + '.page-break{page-break-before:always}';

/** The OA page reduced to what it prints: its own <style> and the .hg-form blocks. Scripts,
 * event handlers and anything that could load from another origin are dropped. */
export function printBody(html: string): { style: string; body: string } {
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? PRINT_STYLE_FALLBACK;
  const start = html.search(/<div class="container-fluid">/);
  const end = html.lastIndexOf('</body>');
  if (start < 0 || end < start) throw new PrintError('response_invalid');
  const body = html.slice(start, end)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Only inline data images stay; any remote src would leak the request off this machine.
    .replace(/<img\b[^>]*\bsrc="(?!data:image\/)[^"]*"[^>]*>/gi, '');
  return { style: style.replace(/<\/?[a-z][^>]*>/gi, ''), body };
}

/** One printable document for several bills, the first page of each bill starting a sheet. */
export function combinePrintPages(bills: Array<{ billCode: string; html: string }>): string {
  const parts = bills.map(({ html }) => printBody(html));
  const sections = parts.map((part, index) =>
    `<section class="bill"${index ? ' style="page-break-before:always"' : ''}>${part.body}</section>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>报销单打印 ${bills.map(item => item.billCode).join('、')}</title>`
    + `<style>${parts[0]?.style ?? PRINT_STYLE_FALLBACK}\n@media screen{body{background:#eee}.bill{background:#fff;margin:0 auto 16px;max-width:900px}}</style>`
    + `<script src="/print.js" defer></script></head><body>${sections}</body></html>`;
}
