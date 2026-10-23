import type { OaHttpClient } from './http-login';
import type { HttpForm } from './http-bpm';
import { BANK_TRANSFER, bizDataFields, cents, encodeFields, envelope, FILL_PATHS, fundingTabs, gridRows, HttpFillError, PERSONAL_CARD, post } from './http-fill';

/** The requests the editor sends for 提交 and the 流转确认 “确定” (captured live 2026-10-15
 * on A209900000008, A209900000009 and A209900000024, see docs/http-fill.md). Only
 * queryAdvance advances the workflow; it is sent once and never retried. */
export const SUBMIT_PATHS = {
  checkAdvanceInvoice: '/bpm-new/rbReimbursement/checkAdvanceBillInvoice.ajax',
  showHandlers: '/bpm-new/workflow/showQueryHandlers.ajax',
  handlers: '/bpm-new/workflow/queryHandlers.ajax',
  advance: '/bpm-new/workflow/queryAdvance.ajax',
} as const;

export const APPROVAL_RULE = '/网上预约报销审批';

const errors = {
  authentication: '学校 OA 登录已失效，未提交。',
  request_failed: '学校 OA 请求未完成，未提交。',
  response_invalid: '学校 OA 返回了无法识别的结果，未提交。',
  form_mismatch: '提交前回读本单，发票、经费明细或付款与任务不一致，未提交。',
  advance_invoice: 'OA 提示本单的发票需先处理（checkAdvanceBillInvoice 未返回 no），未提交。',
  handlers_hidden: 'OA 未要求确认审批路线，与已核对的提交流程不同，未提交。',
  save_mismatch: '提交前保存的回执金额或附件数与任务不一致，未提交。',
  route_unverified: '审批规则或 OA 自动生成的审批人未通过核验，未提交。',
  rejected: 'OA 拒绝了提交。',
  unknown: '已发送最终提交请求，但未取得可识别的回执；禁止自动重试。',
} as const;
export type HttpSubmitErrorCode = keyof typeof errors;

export class HttpSubmitError extends Error {
  /** `response`: what queryAdvance answered, kept for the job record. */
  constructor(readonly code: HttpSubmitErrorCode, readonly oaMessage?: string, readonly response?: string) {
    super(oaMessage ? `${errors[code]}OA 提示：${oaMessage}` : errors[code]);
    this.name = 'HttpSubmitError';
  }
  /** queryAdvance was sent: the form may have moved on, so only the OA status can tell. */
  get sent(): boolean { return this.code === 'rejected' || this.code === 'unknown'; }
}

export interface HttpSubmitExpectation {
  fundingCode: string;
  budgetName: string;
  amount: string;
  attachmentCount: number;
  /** 个人银行卡: the 学号/工号 on the payment row; 银行汇款: the supplier code (supplierCode) on it. */
  payeeCode: string;
  payeeKind?: 'card' | 'bank';
  supplierCode?: string;
  invoiceNumbers: string[];
  /** 报销事由, saved again with the submission as the page does. */
  reason: string;
  /** firstId of the chosen fund: the 经费负责人 approver must be this person. */
  managerId?: string;
}
export interface RouteStep { step: string; handler: string; group: number }
export interface HttpSubmitResult { rule: string; route: RouteStep[] }
export interface HttpSubmitOptions {
  progress?: (step: 'verify' | 'route' | 'advance', message: string) => void;
  /** Called after every check passed, right before the single queryAdvance. */
  validated?: (summary: { documentNumber: string; amount: string }) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** OA-generated approvers, accepted only as captured: the expected rule, no manual choice,
 * every row complete and on this bill, the 经费负责人 being the fund's manager. */
export function routeIssue(data: Record<string, unknown> | undefined, form: HttpForm, managerId?: string): string | null {
  if (!data) return '审批路线回执格式无效';
  if (data.procApprovalRuleFullName !== APPROVAL_RULE) return `流程审批规则为“${String(data.procApprovalRuleFullName ?? '')}”，不是 ${APPROVAL_RULE}`;
  if (data.hasSelection !== false || String(data.hasGatewayManual) !== 'false') return '审批路线需要手工选择分支或处理人';
  const rows = Array.isArray(data.Rows) ? data.Rows.map(row => record(row)) : [];
  if (!rows.length || rows.some(row => !row)) return '审批路线没有处理人';
  for (const row of rows as Record<string, unknown>[]) {
    if (!String(row.subProcUnitName ?? '').trim() || !String(row.handlerName ?? '').trim()
      || !/^[\w-]+@[\dA-F]{32}$/i.test(String(row.handlerId ?? '')) || !Number.isInteger(row.groupId)
      || ![0, 1].includes(row.sendMessage as number) || row.bizId !== form.context.bizId || row.bizCode !== form.documentNumber) {
      return '审批路线中有处理人行不完整或不属于本单';
    }
  }
  const managers = (rows as Record<string, unknown>[]).filter(row => row.subProcUnitId === 'responsiblePerson');
  if (managers.length !== 1) return '审批路线中经费负责人不唯一';
  if (managerId && !String(managers[0].handlerId).startsWith(`${managerId}@`)) return '审批路线中的经费负责人不是所选经费的负责人';
  return null;
}

/** The submit's read requests on one form: every failure is an HttpSubmitError (nothing is sent yet). */
function submitRequests(client: OaHttpClient, form: HttpForm) {
  const bizId = form.context.bizId;
  const call: SubmitCall = async (pathname, fields) => {
    try {
      return envelope(await post(client, form, pathname, { form: fields }, 'save'), 'save');
    } catch (error) {
      if (error instanceof HttpFillError) throw new HttpSubmitError(error.code === 'authentication' ? 'authentication'
        : error.code === 'request_failed' ? 'request_failed' : 'response_invalid');
      throw error;
    }
  };
  const editorPage = async () => {
    const page = await client.request(form.url).catch(() => { throw new HttpSubmitError('request_failed'); });
    if (page.status !== 200) throw new HttpSubmitError(page.status < 400 ? 'authentication' : 'response_invalid');
    return page.text;
  };
  const rows = (value: Record<string, unknown>) => {
    try { return gridRows(value, 'save'); } catch { throw new HttpSubmitError('response_invalid'); }
  };
  /** Payment rows of every payment kind on the form, each tagged with its kind code. */
  const settleRows = async () => {
    const kinds = await call(FILL_PATHS.settleKinds, { reimbursementId: bizId });
    if (String(kinds.status) !== '0' || !Array.isArray(kinds.data)) throw new HttpSubmitError('response_invalid');
    const settles: Record<string, unknown>[] = [];
    for (const kind of kinds.data.map(item => record(item) ?? {})) {
      for (const row of rows(await call(FILL_PATHS.settleRows, { reimbursementId: bizId, reimburSettleKindId: String(kind.id ?? ''),
        sortname: 'createdDate', sortorder: 'desc', sortfields: '[]' }))) settles.push({ ...row, kindCode: kind.code });
    }
    return settles;
  };
  return { call, editorPage, rows, settleRows };
}

/** 个人银行卡 to the 学号/工号, or 银行汇款 to the chosen supplier. */
function samePayee(row: Record<string, unknown>, expect: Pick<HttpSubmitExpectation, 'payeeKind' | 'payeeCode' | 'supplierCode'>): boolean {
  return expect.payeeKind === 'bank' ? row.kindCode === BANK_TRANSFER && row.supplierCode === expect.supplierCode
    : row.kindCode === PERSONAL_CARD && row.personCode === expect.payeeCode;
}

/** The form's invoices are exactly these numbers. */
function sameInvoices(rows: Record<string, unknown>[], numbers: string[]): boolean {
  return rows.length === numbers.length && numbers.every(number => rows.filter(row => [row.invoiceCode, row.invoiceNumber].includes(number)).length === 1);
}

/** Submits a form the HTTP fill saved: re-reads it against the task, then sends the
 * page's submit chain. Throws HttpSubmitError; `sent` tells whether queryAdvance went out. */
export async function submitFormHttp(client: OaHttpClient, form: HttpForm, expect: HttpSubmitExpectation,
  options: HttpSubmitOptions = {}): Promise<HttpSubmitResult> {
  const amount = cents(expect.amount);
  if (amount === null || amount <= 0 || !expect.invoiceNumbers.length) throw new HttpSubmitError('form_mismatch');
  const bizId = form.context.bizId;
  const { call, editorPage, rows, settleRows } = submitRequests(client, form);

  // 1. 回读本单：唯一经费及金额、经费明细、发票集合、付款行
  options.progress?.('verify', '正在回读本单的经费、明细、发票和付款，逐项与任务核对。');
  const editor = await editorPage();
  const tabs = fundingTabs(editor);
  if (tabs.length !== 1 || tabs[0].code !== expect.fundingCode || cents(tabs[0].amount) !== amount) throw new HttpSubmitError('form_mismatch');
  const details = rows(await call(FILL_PATHS.detailRows, { reimbursementId: bizId, fundingItemsId: tabs[0].id, sortfields: '[]' }));
  if (details.length !== 1 || cents(details[0].amount) !== amount || Number(details[0].attachmentNumber) !== expect.attachmentCount
    || details[0].expenditureItemName !== expect.budgetName) throw new HttpSubmitError('form_mismatch');
  const invoices = rows(await call(FILL_PATHS.formInvoices, { reimbursementId: bizId,
    page: '1', pagesize: '20', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' }));
  if (!sameInvoices(invoices, expect.invoiceNumbers)) throw new HttpSubmitError('form_mismatch');
  const settles = await settleRows();
  if (settles.length !== 1 || !samePayee(settles[0], expect) || cents(settles[0].paymentAmount) !== amount) throw new HttpSubmitError('form_mismatch');
  const body = bizDataFields(editor, form, expect.reason, []);
  if (!body) throw new HttpSubmitError('response_invalid');

  return advanceHttp(client, call, form, body, { reimbursement: amount, settlement: amount, attachments: expect.attachmentCount }, expect.managerId, options);
}

/** What the save sent with the submission must answer, in cents. */
interface SubmitReceipt { reimbursement: number; settlement: number; attachments: number }
type SubmitCall = (pathname: string, fields: Record<string, string>) => Promise<Record<string, unknown>>;

/** The page's 提交 → 流转确认 “确定” for a form already re-read: invoice pre-check, the handler
 * dialog, the save, OA's route, then the single queryAdvance. */
async function advanceHttp(client: OaHttpClient, call: SubmitCall, form: HttpForm, body: Array<[string, string]>, receipt: SubmitReceipt, managerId: string | undefined,
  options: HttpSubmitOptions): Promise<HttpSubmitResult> {
  const bizId = form.context.bizId;
  // 2. 点击“提交”：发票预检、是否弹出流转确认、保存、取 OA 生成的审批路线
  options.progress?.('route', '本单回读一致，正在按页面“提交”的顺序请求审批路线。');
  const advanceInvoice = await call(SUBMIT_PATHS.checkAdvanceInvoice, { reimbursementId: bizId });
  if (String(advanceInvoice.status) !== '0' || advanceInvoice.message !== 'no') throw new HttpSubmitError('advance_invoice');
  const show = await call(SUBMIT_PATHS.showHandlers, { bizId, processDefinitionKey: 'rbReimbursementProc',
    procUnitId: body.find(([key]) => key === 'procUnitId')![1] });
  if (String(show.status) !== '0' || show.data !== 'true') throw new HttpSubmitError('handlers_hidden');
  const saved = await call(FILL_PATHS.saveForm, { ...encodeFields(body), showTips: 'false' });
  const biz = record(record(saved.data)?.bizData);
  if (!['0', '1'].includes(String(saved.status)) || !biz || cents(biz.reimbursementAmount) !== receipt.reimbursement
    || cents(biz.settlementAmount) !== receipt.settlement || Number(biz.attachmentNumber) !== receipt.attachments) {
    throw new HttpSubmitError('save_mismatch');
  }
  const handlers = await call(SUBMIT_PATHS.handlers, encodeFields(body));
  const data = record(handlers.data);
  const issue = String(handlers.status) === '0' ? routeIssue(data, form, managerId) : '审批路线请求未成功';
  if (issue) throw new HttpSubmitError('route_unverified', issue);
  const approvers = (data!.Rows as Record<string, unknown>[]);
  const route = approvers.map(row => ({ step: String(row.subProcUnitName), handler: String(row.handlerName), group: Number(row.groupId) }));

  // 3. 流转确认“确定”：唯一一次 queryAdvance，附上页面表格中的处理人行
  options.validated?.({ documentNumber: form.documentNumber, amount: (receipt.reimbursement / 100).toFixed(2) });
  options.progress?.('advance', `审批路线：${route.map(item => `${item.step} ${item.handler}`).join('、')}。正在发送唯一一次提交请求。`);
  const procUnitHandlers = approvers.map((row, index) => ({ ...row, canMerge: '0', merged: '0', __id: `r${1001 + index}`, __isEditor: false }));
  let text: string;
  try {
    text = await post(client, form, SUBMIT_PATHS.advance, { form: { ...encodeFields(body),
      ...encodeFields([['procUnitHandlers', JSON.stringify(procUnitHandlers)]]), hasGatewayManual: String(data!.hasGatewayManual) } }, 'save');
  } catch (error) {
    throw new HttpSubmitError('unknown', undefined, error instanceof HttpFillError ? `queryAdvance ${error.code}` : 'queryAdvance 请求未完成');
  }
  if (text.trim()) {
    let reply: Record<string, unknown> | undefined;
    try { reply = record(JSON.parse(text)); } catch { /* not an envelope */ }
    // Live 2026-10-15 (A209900000025/0140): OA now answers a successful advance this way.
    if (String(reply?.status) === '1' && reply?.data === 'ok') return { rule: APPROVAL_RULE, route };
    const message = typeof reply?.message === 'string' ? reply.message.trim().slice(0, 300) : '';
    const response = `queryAdvance 响应：${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
    if (String(reply?.status) === '2' && message) throw new HttpSubmitError('rejected', message, response);
    throw new HttpSubmitError('unknown', message || undefined, response);
  }
  return { rule: APPROVAL_RULE, route };
}

