import { randomBytes, webcrypto } from 'crypto';
import { htmlInputs, type OaHttpClient } from './http-login';
import { BPM_ORIGIN } from './form-request';
import { bpmEncodeURI, searchBudgetHttp, searchFundingHttp, type HttpForm } from './http-bpm';
import { decodeEntities, FUNDING_KINDS, type FundingItem } from './funding-search';
import { invoiceLimitProblems } from '../domain/invoice-rules';
import { parseSuppliers, sameName, supplierQuery, SUPPLIER_SEARCH_PATH } from './http-payee';
import { folderQuery, lookupInvoicesHttp, parseFolders, parseRows, FOLDER_PAGE_SIZE, INVOICE_FOLDERS_PATH, INVOICE_FOLDER_ROWS_PATH, type InvoiceFolder } from './invoice-claim';

/** The editor's write requests, in the order the browser flow sends them (captured live
 * 2026-10-15 on A209900000010, see docs/http-fill.md). Every step is sent once; a
 * response that does not confirm the write stops the run without retrying. */
export const FILL_PATHS = {
  saveFunding: '/bpm-new/rbReimburFundingItems/saveRbReimburBudgetOutlays.ajax',
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
  detailRows: '/bpm-new/rbReimburFundingItems/queryRbReimburBudgetOutlays.ajax',
  saveForm: '/bpm-new/workflow/saveBizData.ajax',
} as const;

export const PERSONAL_CARD = 'tech.rb.settlement.kind.007';
export const BANK_TRANSFER = 'tech.rb.settlement.kind.006';
const DEFAULT_FOLDER = '表单默认票夹';
const JSON_ACCEPT = 'application/json, text/javascript, */*; q=0.01';
const TEXT_ACCEPT = 'text/plain, */*; q=0.01';
/** #submitForm fields saveBizData carries (the page drops hasSchoolLeader). */
const SUBMIT_FIELDS = ['id', 'billCode', 'fillinDate', 'fullId', 'organId', 'organName', 'deptId', 'positionId', 'positionName',
  'personMemberId', 'reimbursementKind', 'personId', 'accountBook', 'hasFinancialResponsiblePerson', 'disableBackSubProcUnitIds',
  'personCode', 'personMemberName', 'deptName', 'mobilePhone', 'officePhone', 'emali'] as const;

const errors = {
  invalid_input: '自动填写参数无效。',
  stopped: '用户已停止执行。',
  authentication: '学校 OA 登录已失效，已停止填写。',
  request_failed: '学校 OA 请求未完成，已停止填写；请在 OA 核对本单当前内容。',
  response_invalid: '学校 OA 返回了无法识别的结果，已停止填写；请在 OA 核对本单当前内容。',
  invoice_limit: '同一销售方同一开票日期的发票在本单合计超过 499.99 元，均未关联到本单。',
  form_not_blank: '本单已有发票、付款或明细内容，不在空单上自动填写。',
  funding_missing: '经费列表中没有唯一的该经费编号。',
  funding_other: '本单已选过经费项目（OA 每张单只能有一个经费项目），未自动填写；请在 OA 中删除该经费项目或改选其他空单。',
  budget_missing: '该经费下没有唯一名称匹配的预算科目。',
  funding_rejected: 'OA 未确认经费及预算科目的选择。',
  folder_missing: '未找到“表单默认票夹”。',
  upload_rejected: 'OA 未确认发票上传，或识别出的发票号与本次发票不一致。',
  invoice_claimed: 'OA 识别该发票已报销或正在其他单据中报销，未关联到本单。',
  invoice_pending: '上传后票夹在限定时间内未列出全部发票，均未关联到本单。',
  invoice_missing: '所选票夹中已找不到这张未报销的发票，未改动本单。',
  invoice_balance: '发票可报销余额（合计）小于实报金额。',
  invoice_rejected: 'OA 未确认把发票关联到本单。',
  settle_kind_missing: '付款方式中没有唯一的“个人银行卡”或“银行汇款”。',
  payment_exists: '本单已有付款记录，未重复添加。',
  encryption_unrecognized: '收款人查询页的加密脚本与已核对的结构不同，未发送收款人查询。',
  payee_missing: '未能按学号/工号查到收款人姓名及银行卡号，或 OA 供应商中没有唯一匹配的银行转账账户。',
  payment_rejected: 'OA 未确认付款记录或付款金额不一致。',
  detail_missing: '本单经费明细行不唯一。',
  save_rejected: 'OA 未确认主表单保存。',
  save_mismatch: '保存回执中的报销金额、结算金额或附件数与任务不一致。',
} as const;
export type HttpFillErrorCode = keyof typeof errors;

export class HttpFillError extends Error {
  /** A write request was already sent, so the form may hold part of this run. */
  partial = false;
  constructor(readonly code: HttpFillErrorCode, readonly step?: FillStep, detail?: string) {
    super(detail ? `${errors[code]}（${detail}）` : errors[code]);
    this.name = 'HttpFillError';
  }
}

/** Requests that change the form. An upload only adds to the invoice folder. */
/** Simultaneous invoice uploads; OA's own page sends every selected file at once. */
const UPLOADS_AT_ONCE = 5;

const WRITES: ReadonlySet<string> = new Set([FILL_PATHS.saveFunding, FILL_PATHS.linkInvoice,
  FILL_PATHS.addSettleKind, FILL_PATHS.saveSettle, FILL_PATHS.saveForm]);

export type FillStep = 'funding' | 'upload' | 'invoice' | 'payment' | 'save';
export interface HttpFillInput {
  fundingKind?: keyof typeof FUNDING_KINDS;
  fundingCode: string;
  /** expenditureItemName of exactly one budget row, e.g. 委托服务费. */
  budgetName: string;
  amount: string;
  attachmentCount: number;
  /** 经费明细的“用途”. */
  purpose: string;
  /** 报销事由 (#reimbursementRemark). */
  reason: string;
  payeeCode: string;
  /** 个人银行卡 (default) or 银行汇款 to the supplier `supplierCode` whose account name is payeeCode. */
  payeeKind?: 'card' | 'bank';
  supplierCode?: string;
  /** 银行汇款's 汇款用途. */
  remitPurpose?: string;
  /** All linked to this form, each in full (actualAmount = its balance): a PDF to upload
   * (bytes) or an invoice already in an OA folder (folderId). */
  invoices: Array<{ fileName: string; number: string; bytes?: Uint8Array; folderId?: string }>;
}
export interface HttpFillResult {
  fundingItemsId: string;
  /** firstId of the fund (its 经费负责人). */
  managerId: string;
  payeeName: string;
  bizData: { reimbursementAmount: number; settlementAmount: number; attachmentNumber: number };
}
export interface HttpFillOptions {
  progress?: (step: FillStep, message: string) => void;
  /** Checked before each step; true ends the run there. */
  stopped?: () => boolean;
  /** How long to wait for OA to list the uploaded invoice. */
  invoiceWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Body = { form: Record<string, string> } | { json: unknown } | { multipart: { body: Buffer; boundary: string } };
/** post() bound to one form, marking the run partial on a write. */
type FillSend = (pathname: string, body: Body, step: FillStep, extra?: { accept?: string; query?: string }) => Promise<string>;
type PaymentInput = Pick<HttpFillInput, 'payeeCode' | 'payeeKind' | 'supplierCode' | 'remitPurpose'>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function cents(value: unknown): number | null {
  const text = String(value ?? '').replace(/,/g, '').trim();
  return /^-?\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
}

/** POST like the page's jQuery/axios calls: form csrfToken (+ procTaskId), page as Referer. */
export async function post(client: OaHttpClient, form: HttpForm, pathname: string, body: Body, step: FillStep,
  { accept = JSON_ACCEPT, query = '' }: { accept?: string; query?: string } = {}): Promise<string> {
  const [payload, type] = 'form' in body ? [new URLSearchParams(body.form).toString(), 'application/x-www-form-urlencoded; charset=UTF-8']
    : 'json' in body ? [JSON.stringify(body.json), 'application/json; charset=UTF-8']
    : [body.multipart.body, `multipart/form-data; boundary=${body.multipart.boundary}`];
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${pathname}${query}`, { method: 'POST', followRedirects: false, body: payload,
      headers: { accept, 'content-type': type, ...('multipart' in body ? {} : { 'x-requested-with': 'XMLHttpRequest' }),
        csrfToken: form.csrfToken, ...(form.procTaskId ? { procTaskId: form.procTaskId } : {}), origin: BPM_ORIGIN, referer: form.url } });
  } catch { throw new HttpFillError('request_failed', step); }
  if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) {
    throw new HttpFillError('authentication', step);
  }
  if (response.status !== 200) throw new HttpFillError('response_invalid', step);
  return response.text;
}

async function getJson(client: OaHttpClient, form: HttpForm, pathname: string, query: string, step: FillStep): Promise<unknown> {
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${pathname}${query ? `?${query}` : ''}`, { followRedirects: false,
      headers: { accept: 'application/json, text/plain, */*', csrfToken: form.csrfToken, referer: form.url } });
  } catch { throw new HttpFillError('request_failed', step); }
  if (response.status !== 200) throw new HttpFillError(response.status < 400 ? 'authentication' : 'response_invalid', step);
  return envelope(response.text, step);
}

/** JSON body; BPM's "登录超时" envelope means the session is gone. */
export function envelope(text: string, step: FillStep): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpFillError('response_invalid', step); }
  const result = record(data);
  if (!result) throw new HttpFillError('response_invalid', step);
  if (result.isAuth !== undefined || /登录超时|重新登录/.test(String(result.message ?? ''))) throw new HttpFillError('authentication', step);
  return result;
}

export function gridRows(value: Record<string, unknown>, step: FillStep): Record<string, unknown>[] {
  const data = record(value.data);
  if (String(value.status) !== '0' || !data || !Array.isArray(data.Rows)) throw new HttpFillError('response_invalid', step);
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

const yuan = (value: number) => (value / 100).toFixed(2);
const thousands = (value: number) => (value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The popup's per-session encryptor (captured 2026-10-15): AES-256-CBC, key = PBKDF2-SHA256
 * of a literal password/salt, random IV prepended, base64. Only these literals are read; the
 * script itself is never executed. */
export function parsePopupCipher(coreBase64: string): { password: string; salt: string; iterations: number } {
  const code = Buffer.from(coreBase64, 'base64').toString('utf8');
  const salt = code.match(/saltBytes=encoder\.encode\('([\x21-\x26\x28-\x5b\x5d-\x7e]{8,64})'\)/)?.[1];
  const password = code.match(/pswBytes=encoder\.encode\('([\x21-\x26\x28-\x5b\x5d-\x7e]{8,64})'\)/)?.[1];
  const iterations = Number(code.match(/iterations:(\d{3,7})/)?.[1]);
  if (!salt || !password || !Number.isSafeInteger(iterations) || !/name:'AES-CBC',length:256/.test(code)
    || !/hash:'SHA-256'/.test(code) || !/combined\.set\(iv,0\)/.test(code)) throw new HttpFillError('encryption_unrecognized', 'payment');
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

function multipart(fields: Array<[string, string]>, files: Array<{ field: string; name: string; type: string; bytes: Uint8Array }>) {
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

function validate(input: HttpFillInput): number {
  const amount = cents(input.amount);
  if (amount === null || amount <= 0 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.fundingCode) || !input.budgetName.trim()
    || !Number.isInteger(input.attachmentCount) || input.attachmentCount < 1 || input.attachmentCount > 100
    || !input.purpose.trim() || !input.reason.trim()
    || (input.payeeKind === 'bank' ? !input.payeeCode.trim() || !/^\d{1,20}$/.test(input.supplierCode ?? '') || !input.remitPurpose?.trim()
      : !/^[a-zA-Z0-9_-]{2,32}$/.test(input.payeeCode))
    || !input.invoices.length || input.invoices.length > 10
    || new Set(input.invoices.map(item => item.number)).size !== input.invoices.length
    || input.invoices.some(item => !/^\d{20}$/.test(item.number)
      || (item.folderId === undefined ? !item.bytes?.length : item.bytes !== undefined || !/^\d{1,32}$/.test(item.folderId)))) {
    throw new HttpFillError('invalid_input');
  }
  return amount;
}

/** The workflow body saveBizData, queryHandlers and queryAdvance share: #submitForm, the
 * job ids and the detail rows ([] keeps the saved ones). Null when the editor lacks them. */
export function bizDataFields(editor: string, form: HttpForm, remark: string, budgetOutlays: unknown[]): Array<[string, string]> | null {
  const submit = Object.fromEntries(formFields(editor, 'submitForm'));
  const hidden = (id: string) => decodeEntities(htmlInputs(editor).find(attrs => attrs.id === id)?.value ?? '');
  const currency = editor.match(/<input\b[^>]*name=["']currencyKind["'][^>]*checked[^>]*>/i)?.[0];
  const bizId = form.context.bizId;
  if (submit.id !== bizId || submit.billCode !== form.documentNumber || !hidden('jobPageProcInstId') || !currency) return null;
  return [
    ...SUBMIT_FIELDS.map(key => [key, submit[key] ?? ''] as [string, string]),
    ['bizId', bizId], ['procUnitId', hidden('jobPageTaskDefKey') || 'Apply'], ['procInstId', hidden('jobPageProcInstId')],
    ['taskKindId', 'task'], ['taskId', form.context.taskId], ['flowKind', 'APPROVAL'], ['currentHandleSequence', '0'],
    ['currentHandleGroupId', '0'], ['handleResult', '0'], ['handleOpinion', ''], ['remark', remark.trim()],
    ['budgetOutlays', JSON.stringify(budgetOutlays)], ['writeOffs', '[]'], ['currencyKind', htmlInputs(currency)[0]?.value ?? '0'],
  ];
}

/** BPM reads every workflow field through decodeURI twice. */
export function encodeFields(fields: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(fields.map(([key, item]) => [key, bpmEncodeURI(item)]));
}

/** Funding tabs of the editor (#reimburFundingItemsTabDiv li.tab-item). OA allows one
 * funding item per form; a leftover empty one makes submission fail ("报销金额为空"). */
export function fundingTabs(html: string): Array<{ id: string; code: string; amount: string }> {
  const start = html.indexOf('id="reimburFundingItemsTabDiv"');
  if (start < 0) return [];
  const block = html.slice(start, html.indexOf('</ul>', start));
  return [...block.matchAll(/<li\b[^>]*\bclass="tab-item"[^>]*>/g)].map(([tag]) => {
    const attr = (name: string) => decodeEntities(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
    return { id: attr('id'), code: attr('data-code'), amount: attr('data-amount') };
  });
}

/** Invoices already linked to the form; the owner list can call such a form blank. */
export async function formInvoiceCount(client: OaHttpClient, form: HttpForm): Promise<number> {
  return gridRows(envelope(await post(client, form, FILL_PATHS.formInvoices, { form: { reimbursementId: form.context.bizId,
    page: '1', pagesize: '10', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' } }, 'invoice'), 'invoice'), 'invoice').length;
}

type FundingChoice = { fund: FundingItem; chosen: Record<string, unknown>[]; budgetData?: Record<string, unknown>; fundBalance: number };

/** 按经费编号和预算科目名称唯一定位（只读）. */
async function chooseFundingHttp(client: OaHttpClient, form: HttpForm,
  input: Pick<HttpFillInput, 'fundingKind' | 'fundingCode' | 'budgetName'>): Promise<FundingChoice> {
  const funds = (await searchFundingHttp(client, form, { kind: input.fundingKind ?? 'authorized', paramValue: input.fundingCode, pageSize: 100 }))
    .list.items.filter(item => item.projectId === input.fundingCode);
  if (funds.length !== 1) throw new HttpFillError('funding_missing', 'funding');
  const fund = funds[0];
  const budgetRows: Record<string, unknown>[] = [];
  let budgetData: Record<string, unknown> | undefined;
  for (let page = 1; page <= 10; page++) {
    const budget = await searchBudgetHttp(client, form, { fundingItemsCode: fund.projectId, page, pagesize: 20 });
    const data = record(record(budget.response)?.data);
    if (!budget.outlays || !data || !Array.isArray(data.Rows)) throw new HttpFillError('response_invalid', 'funding');
    budgetData ??= data;
    budgetRows.push(...data.Rows.map(row => record(row) ?? {}));
    if (!data.Rows.length || budgetRows.length >= Number(data.Total ?? 0)) break;
  }
  if (budgetRows.length < Number(budgetData?.Total ?? 0)) throw new HttpFillError('response_invalid', 'funding');
  const chosen = budgetRows.filter(row => row.expenditureItemName === input.budgetName.trim() && row.projectCode === fund.projectId);
  if (chosen.length !== 1) throw new HttpFillError('budget_missing', 'funding');
  const fundBalance = cents(budgetData?.requireAmount);
  if (fundBalance === null) throw new HttpFillError('response_invalid', 'funding');
  return { fund, chosen, budgetData, fundBalance };
}

/** 保存经费选择; returns the new fundingItemsId. */
async function saveFundingHttp(send: FillSend, form: HttpForm, { fund, chosen, budgetData, fundBalance }: FundingChoice): Promise<string> {
  const bizId = form.context.bizId;
  const saved = envelope(await send(FILL_PATHS.saveFunding, { form: {
    reimbursementId: bizId, projectCode: fund.projectId, projectName: fund.projectName, deptCode: fund.departmentId,
    deptName: fund.departmentName, requireAmount: thousands(fundBalance), // showAmount as OA returned it: empty when the balance is not authorized to this user, as the page sends it.
    showAmount: String(budgetData?.showAmount ?? ''),
    manager: fund.firstId, budgetOutlays: bpmEncodeURI(JSON.stringify(chosen)),
  } }, 'funding'), 'funding');
  const fundingItemsId = typeof saved.data === 'string' ? saved.data : '';
  if (String(saved.status) !== '1' || !/^[\dA-F]{32}$/i.test(fundingItemsId)) throw new HttpFillError('funding_rejected', 'funding');
  return fundingItemsId;
}

/** 付款：个人银行卡按学号/工号查收款人；银行汇款按户名在 OA 供应商中取唯一账户（2026-10-21 抓包）。两者都是
 * 添加付款方式 → 确认本单没有付款行 → 打开付款弹窗 → 保存付款行，支付金额等于实报金额。
 * Returns the payee name; the row's amount is checked against `amount` (cents). */
async function savePaymentHttp(send: FillSend, form: HttpForm, input: PaymentInput, amount: number): Promise<string> {
  const bizId = form.context.bizId;
  const bank = input.payeeKind === 'bank';
  const kindCode = bank ? BANK_TRANSFER : PERSONAL_CARD, kindName = bank ? '银行汇款' : '个人银行卡';
  const kinds = async () => {
    const list = envelope(await send(FILL_PATHS.settleKinds, { form: { reimbursementId: bizId } }, 'payment'), 'payment');
    if (String(list.status) !== '0' || !Array.isArray(list.data)) throw new HttpFillError('response_invalid', 'payment');
    return (list.data as unknown[]).map(item => record(item) ?? {}).filter(item => item.code === kindCode);
  };
  let card = await kinds();
  if (!card.length) {
    const page = await send(FILL_PATHS.settleKindPage, { form: { reimbursementKind: form.context.reimbursementKind, reimbursementId: bizId } },
      'payment', { accept: TEXT_ACCEPT });
    const choices = [...page.matchAll(/<input\b[^>]*name=["']settlementKindId["'][^>]*>\s*([^<]*)/gi)]
      .filter(match => match[1].trim() === kindName).map(match => htmlInputs(match[0])[0]?.value ?? '');
    if (choices.length !== 1 || !/^[\dA-F]{32}$/i.test(choices[0])) throw new HttpFillError('settle_kind_missing', 'payment');
    const added = envelope(await send(FILL_PATHS.addSettleKind, { form: { reimbursementId: bizId, settleKindIds: choices[0] } }, 'payment'), 'payment');
    if (String(added.status) !== '1') throw new HttpFillError('settle_kind_missing', 'payment');
    card = await kinds();
  }
  if (card.length !== 1 || typeof card[0].id !== 'string') throw new HttpFillError('settle_kind_missing', 'payment');
  const settleKindId = card[0].id;
  const rows = gridRows(envelope(await send(FILL_PATHS.settleRows, { form: { reimbursementId: bizId,
    reimburSettleKindId: settleKindId, sortname: 'createdDate', sortorder: 'desc', sortfields: '[]' } }, 'payment'), 'payment'), 'payment');
  if (rows.length) throw new HttpFillError('payment_exists', 'payment');
  const history = { isSelectHistory: String(card[0].isSelectHistory ?? 0), isCash: String(card[0].isCash ?? 0) };
  let payeeName: string, saveForm: Record<string, string>;
  if (bank) {
    const suppliers = parseSuppliers(envelope(await send(FILL_PATHS.supplierSearch, { form: supplierQuery(input.payeeCode) }, 'payment'), 'payment'))
      .filter(item => item.supplierCode === input.supplierCode && sameName(item.name, input.payeeCode));
    if (suppliers.length !== 1) throw new HttpFillError('payee_missing', 'payment');
    const supplier = suppliers[0];
    // The dialog posts the chosen supplier row back, and the payment form comes prefilled from it. The row's
    // own `id` is the supplier's; the page blanks it (captured body: id=) because the form's `id` is the new
    // payment row's. Kept, OA prefills it and the save turns into an update of a row that does not exist.
    const settlePage = await send(FILL_PATHS.settlePage, { form: { ...Object.fromEntries(Object.entries(supplier.row)
      .map(([key, item]) => [key, item === null || item === undefined ? '' : String(item)])), id: '', ...history,
      reimburSettleKindId: settleKindId, reimbursementId: bizId } }, 'payment', { accept: TEXT_ACCEPT });
    const fields = formFields(settlePage, 'reimbursementSettlementForm').filter(([key]) => !key.startsWith('__'));
    const value = (name: string) => fields.find(([key]) => key === name)?.[1] ?? '';
    if (value('reimbursementId') !== bizId || value('supplierCode') !== supplier.supplierCode || value('payeeCode') !== supplier.account
      || value('rbSettlementKindCode') !== BANK_TRANSFER || value('id') !== '') throw new HttpFillError('response_invalid', 'payment');
    payeeName = value('payee') || supplier.name;
    saveForm = encodeFields([...fields.filter(([key]) => key !== 'purpose' && key !== 'paymentAmount'),
      ['purpose', input.remitPurpose!.trim()], ['paymentAmount', yuan(amount)], ['isSelectHistory', history.isSelectHistory], ['isCash', history.isCash]]);
  } else {
    const settlePage = await send(FILL_PATHS.settlePage, { form: { reimburSettleKindId: settleKindId, reimbursementId: bizId } },
      'payment', { accept: TEXT_ACCEPT });
    const fields = formFields(settlePage, 'reimbursementSettlementForm');
    const value = (name: string) => fields.find(([key]) => key === name)?.[1] ?? '';
    const popupSessionId = value('__POPUP_SESSION_ID');
    if (!/^[\da-f-]{36}$/i.test(popupSessionId) || value('reimbursementId') !== bizId) throw new HttpFillError('response_invalid', 'payment');
    const cipher = parsePopupCipher(value('__CORE_JS_B64'));
    const settle = fields.filter(([key]) => !key.startsWith('__'));
    const lookup = Object.fromEntries(settle.map(([key, item]) => [key, key === 'personCode' ? input.payeeCode : item]));
    const person = envelope(await send(FILL_PATHS.personInfo, { form: { popupSessionId,
      encryptedPayload: bpmEncodeURI(await encryptPopupPayload(cipher, lookup)) } }, 'payment'), 'payment');
    const info = record(person.data);
    const account = typeof info?.caNo === 'string' ? info.caNo : '';
    payeeName = typeof info?.name === 'string' ? info.name.trim() : '';
    if (!/^\d{8,32}$/.test(account) || !payeeName) throw new HttpFillError('payee_missing', 'payment');
    saveForm = { ...Object.fromEntries(settle), personCode: input.payeeCode, personName: bpmEncodeURI(payeeName), payeeCode: account,
      paymentAmount: yuan(amount), ...history };
  }
  const settled = envelope(await send(FILL_PATHS.saveSettle, { form: saveForm }, 'payment'), 'payment');
  if (String(settled.status) !== '1' || cents(settled.data) !== amount) throw new HttpFillError('payment_rejected', 'payment');
  return payeeName;
}

/** 发票 before anything is written to the form: invoices already in an OA folder are checked
 * read-only, the other PDFs uploaded into 表单默认票夹 (which leaves the form untouched) and
 * waited for there; the 500 元 limits are checked on the OA rows. Returns the folder rows by number. */
async function prepareInvoicesHttp(client: OaHttpClient, form: HttpForm, invoices: HttpFillInput['invoices'], send: FillSend,
  progress: (step: FillStep, message: string) => void, options: Pick<HttpFillOptions, 'invoiceWaitMs' | 'sleep'> = {})
  : Promise<{ listed: Map<string, Record<string, unknown>>; uploaded: number }> {
  const bizId = form.context.bizId;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // 票夹中已有的发票：写入任何内容前只读确认它们仍未报销，并按 OA 数据核对报销限制
  const home = new Map(invoices.flatMap(item => item.folderId ? [[item.number, item.folderId] as [string, string]] : []));
  const listed = new Map<string, Record<string, unknown>>();
  const look = async () => {
    const folderIds = [...new Set([...home].filter(([number]) => !listed.has(number)).map(([, id]) => id))];
    const pages = await Promise.all(folderIds.map(folderId => getJson(client, form, INVOICE_FOLDER_ROWS_PATH,
      folderQuery(folderId, '未报销', 1, FOLDER_PAGE_SIZE, bizId), 'invoice')));
    for (const [index, folderId] of folderIds.entries()) {
      for (const item of parseRows(pages[index]).rows as Record<string, unknown>[]) {
        const number = String(item.invoiceNumber ?? '');
        if (home.get(number) === folderId && !listed.has(number)) listed.set(number, item);
      }
    }
  };
  const overLimit = (rows: Record<string, unknown>[]) => invoiceLimitProblems(rows.map(row => ({ number: String(row.invoiceNumber ?? ''),
    faceCents: cents(row.allValoremTax), usedCents: cents(row.invoiceBalance), seller: String(row.salerName ?? '') || undefined,
    date: String(row.invoiceDate ?? '').slice(0, 10) || undefined }))).length > 0;
  let folders: InvoiceFolder[] | undefined;
  const pdfs = invoices.filter(item => item.bytes);
  // Split PDFs are named after their page (merge-第3页.pdf), so name the row and file, not just the number.
  const named = (number: string) => {
    const index = invoices.findIndex(item => item.number === number);
    return index < 0 ? `发票 ${number}` : `第 ${index + 1} 张发票 ${number}（${invoices[index].fileName}）`;
  };
  if (pdfs.length) {
    const known = await lookupInvoicesHttp(client, form, pdfs.map(item => item.number));
    for (const invoice of pdfs) {
      const hit = known.find(item => item.number === invoice.number);
      if (hit?.state !== 'unclaimed' || !hit.folderId) continue;
      if (hit.documents?.length) {
        throw new HttpFillError('invoice_claimed', 'invoice', `${named(invoice.number)} 已关联在单据 ${hit.documents.join('、')}，无法选择。`);
      }
      home.set(invoice.number, hit.folderId);
    }
  }
  const uploads = pdfs.filter(invoice => !home.has(invoice.number));
  if (home.size) {
    folders = parseFolders(await getJson(client, form, INVOICE_FOLDERS_PATH, '', 'invoice'));
    if ([...home.values()].some(id => !folders!.some(item => item.id === id))) throw new HttpFillError('invoice_missing', 'invoice');
    await look();
    if (listed.size !== home.size) throw new HttpFillError('invoice_missing', 'invoice');
    if (overLimit([...listed.values()])) throw new HttpFillError('invoice_limit', 'invoice');
  }

  // 2. 再把尚未进票夹的 PDF 上传到“表单默认票夹”：每张一个请求，同时发出（OA 页面多选上传时就是这样，
  //    2026-10-21 抓包：两个请求同一毫秒发出，各返回一张）。一个请求放多个文件时 OA 只保存最后一个却照样回复
  //    成功。上传只进票夹、不写本单；OA 对已被占用的发票直接拒绝且不保存，所以这时停下本单仍未改动。
  folders ??= parseFolders(await getJson(client, form, INVOICE_FOLDERS_PATH, '', 'upload'));
  const folder = folders.find(item => item.name === DEFAULT_FOLDER);
  if (uploads.length && !folder) throw new HttpFillError('folder_missing', 'upload');
  const count = invoices.length;
  const kept = pdfs.length - uploads.length;
  if (uploads.length) {
    progress('upload', `${kept ? `其中 ${kept} 张已在票夹中，将直接选中；` : ''}正在${uploads.length > 1 ? `同时上传 ${uploads.length} 张 PDF` : '上传发票 PDF'}`
      + '到“表单默认票夹”，尚未写入本单。');
    const uploadOne = async (invoice: typeof uploads[number]) => {
      const reply = await send(FILL_PATHS.upload, { multipart: multipart([['backurl', 'doSave'], ['folderId', folder!.id]],
        [{ field: 'upload', name: invoice.fileName, type: 'application/pdf', bytes: invoice.bytes! }]) }, 'upload',
      { accept: 'application/json, text/plain, */*', query: `?csrfToken=${encodeURIComponent(form.csrfToken)}` });
      // An invoice already on a bill comes back as an HTML error page, and nothing is stored:
      // "当前票据…（发票号码：…）已被报销，报销人[…]，报销单号[…]", or (live 2026-10-20)
      // "票据[<number>_…pdf]已被(报销人[…]，报销单号[…])报销使用".
      if (!reply.trimStart().startsWith('{') && /已被[^。]{0,120}?报销|报销中/.test(reply)) {
        const text = reply.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const bill = text.match(/报销单号\[([A-Z]\d{6,32})\]/)?.[1];
        throw new HttpFillError('invoice_claimed', 'upload', `${named(invoice.number)} 已被报销${bill ? `（报销单号 ${bill}）` : ''}，请删除这一张后重新提交。`);
      }
      const uploaded = envelope(reply, 'upload');
      if (String(uploaded.status) !== '0') throw new HttpFillError('upload_rejected', 'upload');
      const results = record(uploaded.data)?.invoiceResultList;
      const bills = Array.isArray(results) ? results.map(item => record(record(item)?.billEnOut) ?? {}) : [];
      const recognised = bills.filter(bill => bill.invoiceNumber === invoice.number);
      if (recognised.length > 1) throw new HttpFillError('upload_rejected', 'upload');
      if (recognised.length === 1 && recognised[0].billClaimState !== 'UNDOING') {
        throw new HttpFillError('invoice_claimed', 'upload', `${named(invoice.number)} 已被报销，请删除这一张后重新提交。`);
      }
    };
    // Every request is let finish, then the first problem in list order is reported.
    const settled: PromiseSettledResult<void>[] = [];
    for (let start = 0; start < uploads.length; start += UPLOADS_AT_ONCE) {
      settled.push(...await Promise.allSettled(uploads.slice(start, start + UPLOADS_AT_ONCE).map(uploadOne)));
    }
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed) throw failed.reason;
  }

  // 3. 写入本单前等票夹列出全部发票（实测上传返回后第一次查询即已列出；识别慢时最多等这里的时限）
  if (uploads.length) {
    progress('upload', uploads.length > 1 ? `${uploads.length} 张 PDF 均已上传，正在核对票夹已列出全部发票。`
      : '上传已返回，正在核对票夹已列出发票。');
    for (const item of uploads) home.set(item.number, folder!.id);
    const deadline = Date.now() + (options.invoiceWaitMs ?? 60_000 + 20_000 * uploads.length);
    for (;;) {
      await look();
      if (listed.size === count) break;
      if (Date.now() >= deadline) throw new HttpFillError('invoice_pending', 'upload');
      await sleep(3000);
    }
  }
  if (overLimit([...listed.values()])) throw new HttpFillError('invoice_limit', 'upload');
  return { listed, uploaded: uploads.length };
}

/** 关联发票: all invoices in one request, each for its full 可报余额; together they must cover `amount` (cents). */
async function linkInvoicesHttp(send: FillSend, form: HttpForm, invoices: HttpFillInput['invoices'],
  listed: Map<string, Record<string, unknown>>, amount: number): Promise<void> {
  const bizId = form.context.bizId;
  const count = invoices.length;
  let balances = 0;
  // 一次请求关联全部发票，与票夹“确定”按钮相同（2026-10-21 抓包：insertRecords 两条，回复 insertCount 2）
  const records = invoices.map(invoice => {
    const row = listed.get(invoice.number)!;
    const balance = cents(row.invoiceBalance);
    if (balance === null || balance <= 0) throw new HttpFillError('invoice_balance', 'invoice');
    balances += balance;
    return { ...row, reimbursementId: bizId, reimbursementSettleName: row.salerName, actualAmount: row.invoiceBalance, flag: true,
      // The page's own mapping swaps these two fields.
      invoiceCode: row.invoiceNumber, invoiceNumber: row.invoiceCode };
  });
  if (balances < amount) throw new HttpFillError('invoice_balance', 'invoice');
  const linked = envelope(await send(FILL_PATHS.linkInvoice, { json: { insertRecords: records,
    pendingRecords: [], updateRecords: [], removeRecords: [] } }, 'invoice'), 'invoice');
  if (String(linked.status) !== '0' || record(linked.data)?.insertCount !== count) throw new HttpFillError('invoice_rejected', 'invoice');
  const onForm = gridRows(envelope(await send(FILL_PATHS.formInvoices, { form: { reimbursementId: bizId,
    page: '1', pagesize: '20', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' } }, 'invoice'), 'invoice'), 'invoice');
  if (onForm.length !== count || invoices.some(invoice =>
    onForm.filter(item => [item.invoiceCode, item.invoiceNumber].includes(invoice.number)).length !== 1)) {
    throw new HttpFillError('invoice_rejected', 'invoice');
  }
}

/** Fills a blank, opened form over HTTP: invoice upload into the folder first (nothing on the
 * form yet), then funding + budget, invoice link, personal-card payment, and the main-form save
 * with the detail row. Never submits. */
export async function fillFormHttp(client: OaHttpClient, form: HttpForm, input: HttpFillInput,
  options: HttpFillOptions = {}): Promise<HttpFillResult> {
  const state = { wrote: false };
  try {
    return await fill(client, form, input, options, state);
  } catch (error) {
    const failure = error instanceof HttpFillError ? error
      : new HttpFillError((error as { code?: string })?.code === 'authentication' ? 'authentication' : 'response_invalid', 'funding');
    failure.partial = state.wrote;
    throw failure;
  }
}

async function fill(client: OaHttpClient, form: HttpForm, input: HttpFillInput, options: HttpFillOptions,
  state: { wrote: boolean }): Promise<HttpFillResult> {
  const amount = validate(input);
  const progress = (step: FillStep, message: string) => {
    if (options.stopped?.()) throw new HttpFillError('stopped', step);
    options.progress?.(step, message);
  };
  const bizId = form.context.bizId;
  const send = (pathname: string, body: Body, step: FillStep, extra?: { accept?: string; query?: string }) => {
    if (WRITES.has(pathname)) state.wrote = true;
    return post(client, form, pathname, body, step, extra);
  };

  // A blank form has no invoice and no payment row yet; anything else is not ours to overwrite.
  if (await formInvoiceCount(client, form)) throw new HttpFillError('form_not_blank', 'invoice');
  const editorPage = async (step: FillStep) =>
    (await client.request(form.url).catch(() => { throw new HttpFillError('request_failed', step); })).text;
  if (fundingTabs(await editorPage('funding')).length) {
    throw new HttpFillError('funding_other', 'funding');
  }

  // 1. 按经费编号和预算科目名称唯一定位（只读）
  progress('funding', '正在按经费编号和预算科目名称唯一定位。');
  const choice = await chooseFundingHttp(client, form, input);

  const { listed, uploaded } = await prepareInvoicesHttp(client, form, input.invoices, send, progress, options);

  // 4. 保存经费选择（本单的第一个写入）
  progress('funding', uploaded ? '发票已进入票夹，正在保存经费选择。' : '正在保存经费选择。');
  const fundingItemsId = await saveFundingHttp(send, form, choice);

  // 5. 关联发票
  const count = input.invoices.length;
  progress('invoice', count > 1 ? `经费已保存，正在把 ${count} 张发票一次关联到本单。` : '经费已保存，正在把发票关联到本单。');
  await linkInvoicesHttp(send, form, input.invoices, listed, amount);

  // 6. 付款：个人银行卡按学号/工号查收款人；银行汇款按户名在 OA 供应商中取唯一账户（2026-10-21 抓包）。两者都是
  //    添加付款方式 → 确认本单没有付款行 → 打开付款弹窗 → 保存付款行，支付金额等于实报金额。
  progress('payment', input.payeeKind === 'bank' ? `发票已关联，正在添加银行汇款付款并在 OA 供应商中核对“${input.payeeCode}”的账户。`
    : '发票已关联，正在添加个人银行卡付款并按学号/工号查询收款人。');
  const payeeName = await savePaymentHttp(send, form, input, amount);

  // 7. 经费明细（金额、附件数、用途）+ 报销事由，保存主表单
  progress('save', '付款行已保存，正在写入经费明细和报销事由并保存主表单。');
  const details = gridRows(envelope(await send(FILL_PATHS.detailRows, { form: { reimbursementId: bizId,
    fundingItemsId, sortfields: '[]' } }, 'save'), 'save'), 'save');
  if (details.length !== 1) throw new HttpFillError('detail_missing', 'save');
  const detail = { ...details[0], amount: yuan(amount), attachmentNumber: String(input.attachmentCount), remark: input.purpose.trim() };
  const body = bizDataFields(await editorPage('save'), form, input.reason, [detail]);
  if (!body) throw new HttpFillError('response_invalid', 'save');
  const result = envelope(await send(FILL_PATHS.saveForm, { form: encodeFields(body) }, 'save'), 'save');
  const biz = record(record(result.data)?.bizData);
  if (String(result.status) !== '1' || !biz) throw new HttpFillError('save_rejected', 'save');
  if (cents(biz.reimbursementAmount) !== amount || cents(biz.settlementAmount) !== amount
    || Number(biz.attachmentNumber) !== input.attachmentCount) throw new HttpFillError('save_mismatch', 'save');
  const tabs = fundingTabs(await editorPage('save'));
  if (tabs.length !== 1 || tabs[0].code !== input.fundingCode || cents(tabs[0].amount) !== amount) {
    throw new HttpFillError('save_mismatch', 'save');
  }
  return { fundingItemsId, managerId: String(choice.fund.firstId ?? ''), payeeName, bizData: { reimbursementAmount: Number(biz.reimbursementAmount),
    settlementAmount: Number(biz.settlementAmount), attachmentNumber: Number(biz.attachmentNumber) } };
}
