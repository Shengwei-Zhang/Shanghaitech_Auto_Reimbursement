import { randomBytes, webcrypto } from 'crypto';
import { htmlInputs, type OaHttpClient } from '../http-login';
import { BPM_ORIGIN } from '../form-request';
import { bpmEncodeURI, type HttpForm } from '../http-bpm';
import { decodeEntities } from '../funding-search';
import { SUPPLIER_SEARCH_PATH } from '../http-payee';

/** 境内差旅单 requests, kept apart from 用款申请单 (http-fill / http-submit) on purpose: each form
 * type has its own copy of the request chain, so a change for one never moves the other.
 * Captured live 2026-10-21 on D209900000038; see docs/http-travel.md. */
export const TRAVEL_KIND = 'domesticTravel';
export const TRAVEL_PATHS = {
  travellerPage: '/bpm-new/rbBusinessTrip/showInsertRbBusinessTraveller.load',
  personSearch: '/bpm-new/easySearch.load',
  saveTraveller: '/bpm-new/rbBusinessTrip/saveRbBusinessTraveller.ajax',
  travellers: '/bpm-new/rbBusinessTrip/queryRbBusinessTravellers.ajax',
  detailPage: '/bpm-new/rbBusinessTrip/showInsertRbBusinessDetail.load',
  saveDetails: '/bpm-new/rbBusinessTrip/saveRbBusinessDetails.ajax',
  details: '/bpm-new/rbBusinessTrip/queryRbBusinessDetail.ajax',
  writeOffs: '/bpm-new/rbReimburWriteOff/queryRbReimburWriteOff.ajax',
  ctripBorrows: '/bpm-new/rbReimburWriteOff/queryCtripBorrows.ajax',
  saveWriteOffs: '/bpm-new/rbReimburWriteOff/saveRbReimburWriteOff.ajax',
  saveFunding: '/bpm-new/rbReimburFundingItems/saveRbReimburBudgetOutlays.ajax',
  budgetRows: '/bpm-new/rbReimburFundingItems/queryRbReimburBudgetOutlays.ajax',
  upload: '/bpm-new/reimburInvoiceFolder/uploadFillingInvoiceFiles.ajax',
  linkInvoice: '/bpm-new/rbReimbursementInvoice/insertRbReimbursementInvoice1.ajax',
  formInvoices: '/bpm-new/rbReimbursementInvoice/slicedQueryRbReimbursementInvoices.ajax',
  settleKindPage: '/bpm-new/rbReimbursementSettlement/showInsertRbReimburSettleKind.load',
  addSettleKind: '/bpm-new/rbReimbursementSettlement/insertRbReimburSettleKind.ajax',
  settleKinds: '/bpm-new/rbReimbursementSettlement/querySettlementKindByReimbursementId.ajax',
  settleRows: '/bpm-new/rbReimbursementSettlement/queryRbReimbursementSettle.ajax',
  settlePage: '/bpm-new/rbReimbursementSettlement/showInsertRbReimbursementSettle.load',
  personInfo: '/bpm-new/rbReimbursement/queryPersonInfo.ajax',
  saveSettle: '/bpm-new/rbReimbursementSettlement/saveRbReimbursementSettle.ajax',
  supplierSearch: SUPPLIER_SEARCH_PATH,
  saveForm: '/bpm-new/workflow/saveBizData.ajax',
  checkAdvanceInvoice: '/bpm-new/rbReimbursement/checkAdvanceBillInvoice.ajax',
  showHandlers: '/bpm-new/workflow/showQueryHandlers.ajax',
  handlers: '/bpm-new/workflow/queryHandlers.ajax',
  advance: '/bpm-new/workflow/queryAdvance.ajax',
} as const;
/** Requests that change the form. An upload only adds to the invoice folder. */
export const TRAVEL_WRITES: ReadonlySet<string> = new Set([TRAVEL_PATHS.saveTraveller, TRAVEL_PATHS.saveDetails,
  TRAVEL_PATHS.saveWriteOffs, TRAVEL_PATHS.saveFunding, TRAVEL_PATHS.linkInvoice, TRAVEL_PATHS.addSettleKind,
  TRAVEL_PATHS.saveSettle, TRAVEL_PATHS.saveForm]);

export const PERSONAL_CARD = 'tech.rb.settlement.kind.007';
export const BANK_TRANSFER = 'tech.rb.settlement.kind.006';
export const JSON_ACCEPT = 'application/json, text/javascript, */*; q=0.01';
export const TEXT_ACCEPT = 'text/plain, */*; q=0.01';

const errors = {
  invalid_input: '差旅单自动填写参数无效。',
  stopped: '用户已停止执行。',
  authentication: '学校 OA 登录已失效，已停止填写。',
  request_failed: '学校 OA 请求未完成，已停止填写；请在 OA 核对本单当前内容。',
  response_invalid: '学校 OA 返回了无法识别的结果，已停止填写；请在 OA 核对本单当前内容。',
  not_travel: '本单不是境内差旅单。',
  form_not_blank: '本单已有出差人、经费、冲借款、发票或付款，不在已有内容的单上自动填写。',
  funding_missing: '经费列表中没有唯一的该经费编号。',
  budget_missing: '该经费下没有唯一名称匹配的预算科目。',
  budget_over: '经费明细金额超过预算科目或经费的可用余额。',
  funding_rejected: 'OA 未确认经费及预算科目的选择。',
  lines_invalid: '经费明细金额与差旅合计不符：各行金额之和须等于差旅合计。',
  traveller_kind_missing: '出差人类别中没有唯一的该选项。',
  person_missing: '按学号/工号和姓名没有查到唯一的出差人。',
  traveller_rejected: 'OA 未确认出差人保存，或回读的出差人与任务不一致。',
  leg_invalid: '行程不符合 OA 规则：到达日期早于启程日期、各段差旅天数之和不等于行程总天数（首段启程到末段到达），或实际补贴高于标准补贴。',
  vehicle_missing: '交通工具中没有该选项。',
  detail_rejected: 'OA 未确认行程保存，或回读的行程合计与任务不一致。',
  borrow_missing: '携程借款单中没有唯一的该订单号，或其未清余额不大于 0。',
  writeoff_rejected: 'OA 未确认冲借款保存，或回读的冲账金额与任务不一致。',
  writeoff_over: '冲借款合计超过差旅费用合计。',
  invoice_limit: '同一销售方同一开票日期的发票在本单合计超过 499.99 元，均未关联到本单。',
  folder_missing: '未找到“表单默认票夹”。',
  upload_rejected: 'OA 未确认发票上传，或识别出的发票号与本次发票不一致。',
  invoice_claimed: 'OA 识别该发票已报销或正在其他单据中报销，未关联到本单。',
  invoice_pending: '上传后票夹在限定时间内未列出全部发票，均未关联到本单。',
  invoice_missing: '所选票夹中已找不到这张未报销的发票，未改动本单。',
  invoice_balance: '发票可报销余额（合计）小于需要发票的金额（付款减去补贴）。',
  invoice_rejected: 'OA 未确认把发票关联到本单。',
  payees_invalid: '收款人金额与应付金额不符：各收款人金额之和须等于差旅合计减去携程冲账。',
  settle_kind_missing: '付款方式中没有唯一的“个人银行卡”或“银行汇款”。',
  payment_exists: '本单已有付款记录，未重复添加。',
  encryption_unrecognized: '收款人查询页的加密脚本与已核对的结构不同，未发送收款人查询。',
  payee_missing: '未能按学号/工号查到收款人姓名及银行卡号，或 OA 供应商中没有唯一匹配的银行转账账户。',
  payment_rejected: 'OA 未确认付款记录或付款金额不一致。',
  detail_missing: '本单经费明细行与所选预算科目不一致。',
  save_rejected: 'OA 未确认主表单保存。',
  save_mismatch: '保存回执中的差旅合计、报销金额、冲账金额、结算金额或附件数与任务不一致。',
} as const;
export type HttpTravelErrorCode = keyof typeof errors;
export type TravelStep = 'funding' | 'upload' | 'invoice' | 'traveller' | 'detail' | 'writeoff' | 'payment' | 'save';

export class HttpTravelError extends Error {
  /** A write request was already sent, so the form may hold part of this run. */
  partial = false;
  constructor(readonly code: HttpTravelErrorCode, readonly step?: TravelStep, detail?: string, message?: string) {
    super(message ?? `${errors[code]}${detail ? `（${detail}）` : ''}`);
    this.name = 'HttpTravelError';
  }
}

export type Body = { form: Record<string, string> } | { json: unknown } | { multipart: { body: Buffer; boundary: string } };
/** post() bound to one form, marking the run partial on a write. */
export type TravelSend = (pathname: string, body: Body, step: TravelStep, extra?: { accept?: string; query?: string }) => Promise<string>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function cents(value: unknown): number | null {
  const text = String(value ?? '').replace(/,/g, '').trim();
  return /^-?\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
}
export const yuan = (value: number) => (value / 100).toFixed(2);
export const thousands = (value: number) => (value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** POST like the page's jQuery/axios calls: form csrfToken (+ procTaskId), page as Referer. */
export async function post(client: OaHttpClient, form: HttpForm, pathname: string, body: Body, step: TravelStep,
  { accept = JSON_ACCEPT, query = '' }: { accept?: string; query?: string } = {}): Promise<string> {
  const [payload, type] = 'form' in body ? [new URLSearchParams(body.form).toString(), 'application/x-www-form-urlencoded; charset=UTF-8']
    : 'json' in body ? [JSON.stringify(body.json), 'application/json; charset=UTF-8']
    : [body.multipart.body, `multipart/form-data; boundary=${body.multipart.boundary}`];
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${pathname}${query}`, { method: 'POST', followRedirects: false, body: payload,
      headers: { accept, 'content-type': type, ...('multipart' in body ? {} : { 'x-requested-with': 'XMLHttpRequest' }),
        csrfToken: form.csrfToken, ...(form.procTaskId ? { procTaskId: form.procTaskId } : {}), origin: BPM_ORIGIN, referer: form.url } });
  } catch { throw new HttpTravelError('request_failed', step); }
  if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) {
    throw new HttpTravelError('authentication', step);
  }
  if (response.status !== 200) throw new HttpTravelError('response_invalid', step);
  return response.text;
}

export async function getJson(client: OaHttpClient, form: HttpForm, pathname: string, query: string, step: TravelStep): Promise<unknown> {
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${pathname}${query ? `?${query}` : ''}`, { followRedirects: false,
      headers: { accept: 'application/json, text/plain, */*', csrfToken: form.csrfToken, referer: form.url } });
  } catch { throw new HttpTravelError('request_failed', step); }
  if (response.status !== 200) throw new HttpTravelError(response.status < 400 ? 'authentication' : 'response_invalid', step);
  return envelope(response.text, step);
}

/** JSON body; BPM's "登录超时" envelope means the session is gone. */
export function envelope(text: string, step: TravelStep): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpTravelError('response_invalid', step); }
  const result = record(data);
  if (!result) throw new HttpTravelError('response_invalid', step);
  if (result.isAuth !== undefined || /登录超时|重新登录/.test(String(result.message ?? ''))) throw new HttpTravelError('authentication', step);
  return result;
}

export function gridRows(value: Record<string, unknown>, step: TravelStep): Record<string, unknown>[] {
  const data = record(value.data);
  if (String(value.status) !== '0' || !data || !Array.isArray(data.Rows)) throw new HttpTravelError('response_invalid', step);
  return data.Rows.map(row => record(row) ?? {});
}

/** Named, enabled fields of one <form id=...> in a BPM fragment, in document order. */
export function formFields(html: string, id: string): Array<[string, string]> {
  const start = html.search(new RegExp(`<form\\b[^>]*\\bid=["']${id}["']`, 'i'));
  if (start < 0) return [];
  const end = html.indexOf('</form>', start);
  const fields: Array<[string, string]> = [];
  for (const attrs of htmlInputs(html.slice(start, end < 0 ? undefined : end))) {
    if (!attrs.name || 'disabled' in attrs) continue;
    if (['radio', 'checkbox'].includes((attrs.type || '').toLowerCase()) && !('checked' in attrs)) continue;
    fields.push([attrs.name, decodeEntities(attrs.value ?? '')]);
  }
  return fields;
}

/** BPM reads every workflow field through decodeURI twice. */
export function encodeFields(fields: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(fields.map(([key, item]) => [key, bpmEncodeURI(item)]));
}

/** Funding tabs of the editor (#reimburFundingItemsTabDiv li.tab-item); OA allows one per form. */
export function fundingTabs(html: string): Array<{ id: string; code: string; amount: string }> {
  const start = html.indexOf('id="reimburFundingItemsTabDiv"');
  if (start < 0) return [];
  const block = html.slice(start, html.indexOf('</ul>', start));
  return [...block.matchAll(/<li\b[^>]*\bclass="tab-item"[^>]*>/g)].map(([tag]) => {
    const attr = (name: string) => decodeEntities(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
    return { id: attr('id'), code: attr('data-code'), amount: attr('data-amount') };
  });
}

/** #submitForm fields saveBizData carries (the page drops hasSchoolLeader). */
const SUBMIT_FIELDS = ['id', 'billCode', 'fillinDate', 'fullId', 'organId', 'organName', 'deptId', 'positionId', 'positionName',
  'personMemberId', 'reimbursementKind', 'personId', 'accountBook', 'hasFinancialResponsiblePerson', 'disableBackSubProcUnitIds',
  'personCode', 'personMemberName', 'deptName', 'mobilePhone', 'officePhone', 'emali'] as const;

/** The workflow body saveBizData, queryHandlers and queryAdvance share, as domesticTravelDetail.js
 * getExtendedData sends it: #submitForm, the job ids, 报销事由, 情况说明, the detail rows ([] keeps the
 * saved ones), writeOffs and businessDetails ([] = keep). Null when the editor lacks them. */
export function travelBizFields(editor: string, form: HttpForm, remark: string, budgetOutlays: unknown[], explain: string)
  : Array<[string, string]> | null {
  const submit = Object.fromEntries(formFields(editor, 'submitForm'));
  const hidden = (id: string) => decodeEntities(htmlInputs(editor).find(attrs => attrs.id === id)?.value ?? '');
  const bizId = form.context.bizId;
  if (submit.id !== bizId || submit.billCode !== form.documentNumber || submit.reimbursementKind !== TRAVEL_KIND
    || !hidden('jobPageProcInstId')) return null;
  return [
    ...SUBMIT_FIELDS.map(key => [key, submit[key] ?? ''] as [string, string]),
    ['bizId', bizId], ['procUnitId', hidden('jobPageTaskDefKey') || 'Apply'], ['procInstId', hidden('jobPageProcInstId')],
    ['taskKindId', 'task'], ['taskId', form.context.taskId], ['flowKind', 'APPROVAL'], ['currentHandleSequence', '0'],
    ['currentHandleGroupId', '0'], ['handleResult', '0'], ['handleOpinion', ''], ['remark', remark.trim()], ['explain', explain.trim()],
    ['budgetOutlays', JSON.stringify(budgetOutlays)], ['writeOffs', '[]'], ['businessDetails', '[]'],
  ];
}

/** The payment popup's per-session encryptor (captured 2026-10-15): AES-256-CBC, key = PBKDF2-SHA256
 * of a literal password/salt, random IV prepended, base64. Only these literals are read; the script
 * itself is never executed. */
export function parsePopupCipher(coreBase64: string): { password: string; salt: string; iterations: number } {
  const code = Buffer.from(coreBase64, 'base64').toString('utf8');
  const salt = code.match(/saltBytes=encoder\.encode\('([\x21-\x26\x28-\x5b\x5d-\x7e]{8,64})'\)/)?.[1];
  const password = code.match(/pswBytes=encoder\.encode\('([\x21-\x26\x28-\x5b\x5d-\x7e]{8,64})'\)/)?.[1];
  const iterations = Number(code.match(/iterations:(\d{3,7})/)?.[1]);
  if (!salt || !password || !Number.isSafeInteger(iterations) || !/name:'AES-CBC',length:256/.test(code)
    || !/hash:'SHA-256'/.test(code) || !/combined\.set\(iv,0\)/.test(code)) throw new HttpTravelError('encryption_unrecognized', 'payment');
  return { password, salt, iterations };
}

export async function encryptPopupPayload(cipher: { password: string; salt: string; iterations: number }, data: unknown,
  iv: Uint8Array = randomBytes(16)): Promise<string> {
  const encoder = new TextEncoder();
  const material = await webcrypto.subtle.importKey('raw', encoder.encode(cipher.password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: encoder.encode(cipher.salt), iterations: cipher.iterations, hash: 'SHA-256' },
    material, { name: 'AES-CBC', length: 256 }, false, ['encrypt']);
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoder.encode(JSON.stringify(data))));
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64');
}

export function multipart(fields: Array<[string, string]>, files: Array<{ field: string; name: string; type: string; bytes: Uint8Array }>) {
  const boundary = `----OaHttpFormBoundary${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = fields.map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name.replace(/["\r\n]/g, '_')}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`), Buffer.from(file.bytes), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}
