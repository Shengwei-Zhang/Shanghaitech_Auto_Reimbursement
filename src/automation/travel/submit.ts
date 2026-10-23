import type { OaHttpClient } from '../http-login';
import type { HttpForm } from '../http-bpm';
import { BANK_TRANSFER, cents, encodeFields, envelope, fundingTabs, gridRows, HttpTravelError, PERSONAL_CARD, post, record,
  TRAVEL_KIND, TRAVEL_PATHS, travelBizFields } from './request';

/** 提交 of a saved 境内差旅单, its own copy of the page's submit chain (captured on D209900000038, the
 * same requests as 用款申请单): checkAdvanceBillInvoice → showQueryHandlers → saveBizData → queryHandlers
 * → the 流转确认 “确定” queryAdvance, sent once and never retried. */
export const TRAVEL_APPROVAL_RULE = '/网上预约报销审批';

const errors = {
  authentication: '学校 OA 登录已失效，未提交。',
  request_failed: '学校 OA 请求未完成，未提交。',
  response_invalid: '学校 OA 返回了无法识别的结果，未提交。',
  form_mismatch: '提交前回读本单，内容与本次填写不一致，未提交。',
  advance_invoice: 'OA 提示本单的发票需先处理（checkAdvanceBillInvoice 未返回 no），未提交。',
  handlers_hidden: 'OA 未要求确认审批路线，与已核对的提交流程不同，未提交。',
  save_mismatch: '提交前保存的回执金额或附件数与本次填写不一致，未提交。',
  route_unverified: '审批规则或 OA 自动生成的审批人未通过核验，未提交。',
  rejected: 'OA 拒绝了提交。',
  unknown: '已发送最终提交请求，但未取得可识别的回执；禁止自动重试。',
} as const;
export type TravelSubmitErrorCode = keyof typeof errors;

export class TravelSubmitError extends Error {
  /** `oaMessage`: OA's own reason; `detail`: what our readback found different; `response`: what queryAdvance answered. */
  constructor(readonly code: TravelSubmitErrorCode, readonly oaMessage?: string, readonly response?: string, detail?: string) {
    super(oaMessage ? `${errors[code]}OA 提示：${oaMessage}` : detail ? `提交前回读本单，${detail}与本次填写不一致，未提交。` : errors[code]);
    this.name = 'TravelSubmitError';
  }
  /** queryAdvance was sent: the form may have moved on, so only the OA status can tell. */
  get sent(): boolean { return this.code === 'rejected' || this.code === 'unknown'; }
}

/** A saved 境内差旅单 as the fill left it; amounts in cents. */
export interface TravelSubmitExpectation {
  fundingCode: string;
  /** 经费明细 lines: budget name, amount, 用途, in order. */
  lines: Array<{ budgetName: string; amount: number; purpose: string }>;
  attachmentCount: number;
  reason: string;
  explain: string;
  /** 学号/工号 of every traveller. */
  travellerCodes: string[];
  /** 差旅费用合计 = sum of the lines = 报销总金额 (OA refuses the advance otherwise). */
  trip: number;
  /** 携程 订单号 written off, each in full; `reverse` is their total. */
  ctripOrders: string[];
  reverse: number;
  /** Payment rows: kind, 学号/工号 (card) or supplierCode (bank), amount. They add up to trip − reverse. */
  payees: Array<{ kind: 'card' | 'bank'; code: string; supplierCode?: string; amount: number }>;
  invoiceNumbers: string[];
  /** firstId of the chosen fund: the 经费负责人 approver must be this person. */
  managerId?: string;
}
export interface TravelRouteStep { step: string; handler: string; group: number }
export interface TravelSubmitResult { rule: string; route: TravelRouteStep[] }
export interface TravelSubmitOptions {
  progress?: (step: 'verify' | 'route' | 'advance', message: string) => void;
  /** Called after every check passed, right before the single queryAdvance. */
  validated?: (summary: { documentNumber: string; amount: string }) => void;
}

/** OA-generated approvers, accepted only as captured: the expected rule, no manual choice,
 * every row complete and on this bill, the 经费负责人 being the fund's manager. */
export function travelRouteIssue(data: Record<string, unknown> | undefined, form: HttpForm, managerId?: string): string | null {
  if (!data) return '审批路线回执格式无效';
  if (data.procApprovalRuleFullName !== TRAVEL_APPROVAL_RULE) {
    return `流程审批规则为“${String(data.procApprovalRuleFullName ?? '')}”，不是 ${TRAVEL_APPROVAL_RULE}`;
  }
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

/** Two lists hold the same entries, each once. */
const sameSet = <T>(expected: T[], actual: T[]) => expected.length === actual.length
  && expected.every(item => actual.filter(other => other === item).length === expected.filter(other => other === item).length);

/** Submits a 境内差旅单 the HTTP fill saved: the form is re-read against the run (funding and every
 * 经费明细 line, travellers and their itinerary totals, 携程 write-offs, invoices, every payment row),
 * then the submit chain goes out, queryAdvance once. */
export async function submitTravelFormHttp(client: OaHttpClient, form: HttpForm, expect: TravelSubmitExpectation,
  options: TravelSubmitOptions = {}): Promise<TravelSubmitResult> {
  const { trip, reverse } = expect;
  const payment = expect.payees.reduce((sum, payee) => sum + payee.amount, 0);
  if (form.context.reimbursementKind !== TRAVEL_KIND || !Number.isSafeInteger(trip) || trip <= 0 || reverse < 0 || trip - reverse !== payment
    || !expect.travellerCodes.length || !expect.lines.length || expect.lines.reduce((sum, line) => sum + line.amount, 0) !== trip) {
    throw new TravelSubmitError('form_mismatch');
  }
  const bizId = form.context.bizId;
  const call = async (pathname: string, fields: Record<string, string>) => {
    try { return envelope(await post(client, form, pathname, { form: fields }, 'save'), 'save'); }
    catch (error) {
      if (error instanceof HttpTravelError) throw new TravelSubmitError(error.code === 'authentication' ? 'authentication'
        : error.code === 'request_failed' ? 'request_failed' : 'response_invalid');
      throw error;
    }
  };
  const rows = (value: Record<string, unknown>) => {
    try { return gridRows(value, 'save'); } catch { throw new TravelSubmitError('response_invalid'); }
  };
  const mismatch = (what: string) => new TravelSubmitError('form_mismatch', undefined, undefined, what);

  // 1. 回读本单：唯一经费及每行明细、出差人与各自行程合计、冲借款、发票、每个付款行
  options.progress?.('verify', '正在回读差旅单的经费明细、出差人行程、冲借款、发票和收款人，逐项与本次填写核对。');
  const page = await client.request(form.url).catch(() => { throw new TravelSubmitError('request_failed'); });
  if (page.status !== 200) throw new TravelSubmitError(page.status < 400 ? 'authentication' : 'response_invalid');
  const editor = page.text;
  const tabs = fundingTabs(editor);
  if (tabs.length !== 1 || tabs[0].code !== expect.fundingCode) throw mismatch('经费项目');
  const details = rows(await call(TRAVEL_PATHS.budgetRows, { reimbursementId: bizId, fundingItemsId: tabs[0].id, sortfields: '[]' }));
  if (details.length !== expect.lines.length || expect.lines.some(line => {
    const hits = details.filter(row => row.expenditureItemName === line.budgetName);
    return hits.length !== 1 || cents(hits[0].amount) !== line.amount || String(hits[0].remark ?? '').trim() !== line.purpose.trim();
  }) || details.reduce((sum, row) => sum + (Number(row.attachmentNumber) || 0), 0) !== expect.attachmentCount) throw mismatch('经费明细');
  const listed = await call(TRAVEL_PATHS.travellers, { reimbursementId: bizId });
  if (String(listed.status) !== '0' || !Array.isArray(listed.data)) throw new TravelSubmitError('response_invalid');
  const travellers = listed.data.map(item => record(item) ?? {});
  if (!sameSet(expect.travellerCodes, travellers.map(row => String(row.travellerCode ?? '')))) throw mismatch('出差人');
  let legs = 0;
  for (const traveller of travellers) {
    const reply = await call(TRAVEL_PATHS.details, { reimbursementId: bizId, travellerId: String(traveller.id ?? ''),
      sortname: 'startDate', sortorder: 'asc', sortfields: '[]' });
    legs += rows(reply).length ? cents(record(record(reply.data)?.totalFields)?.totalAmount) ?? NaN : 0;
  }
  if (legs !== trip) throw mismatch('行程合计');
  const writeOffs = rows(await call(TRAVEL_PATHS.writeOffs, { reimbursementId: bizId, sortfields: '[]' }));
  if (!sameSet(expect.ctripOrders, writeOffs.map(row => String(row.borrowMoneyCode ?? '')))
    || writeOffs.reduce((sum, row) => sum + (cents(row.strikeBalanceAmount) ?? NaN), 0) !== reverse) throw mismatch('冲借款');
  const invoices = rows(await call(TRAVEL_PATHS.formInvoices, { reimbursementId: bizId,
    page: '1', pagesize: '20', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' }));
  if (invoices.length !== expect.invoiceNumbers.length || expect.invoiceNumbers.some(number =>
    invoices.filter(row => [row.invoiceCode, row.invoiceNumber].includes(number)).length !== 1)) throw mismatch('发票');
  const kinds = await call(TRAVEL_PATHS.settleKinds, { reimbursementId: bizId });
  if (String(kinds.status) !== '0' || !Array.isArray(kinds.data)) throw new TravelSubmitError('response_invalid');
  const settles: string[] = [];
  for (const kind of kinds.data.map(item => record(item) ?? {})) {
    for (const row of rows(await call(TRAVEL_PATHS.settleRows, { reimbursementId: bizId, reimburSettleKindId: String(kind.id ?? ''),
      sortname: 'createdDate', sortorder: 'desc', sortfields: '[]' }))) {
      settles.push(kind.code === BANK_TRANSFER ? `bank|${String(row.supplierCode ?? '')}|${cents(row.paymentAmount)}`
        : kind.code === PERSONAL_CARD ? `card|${String(row.personCode ?? '')}|${cents(row.paymentAmount)}` : `other|${String(kind.code)}`);
    }
  }
  const wanted = expect.payees.map(payee => `${payee.kind}|${payee.kind === 'bank' ? payee.supplierCode ?? '' : payee.code}|${payee.amount}`);
  if (!sameSet(wanted, settles)) throw mismatch('收款人');
  const body = travelBizFields(editor, form, expect.reason, [], expect.explain);
  if (!body) throw new TravelSubmitError('response_invalid');

  // 2. 点击“提交”：发票预检、是否弹出流转确认、保存、取 OA 生成的审批路线
  options.progress?.('route', '本单回读一致，正在按页面“提交”的顺序请求审批路线。');
  const advanceInvoice = await call(TRAVEL_PATHS.checkAdvanceInvoice, { reimbursementId: bizId });
  if (String(advanceInvoice.status) !== '0' || advanceInvoice.message !== 'no') throw new TravelSubmitError('advance_invoice');
  const show = await call(TRAVEL_PATHS.showHandlers, { bizId, processDefinitionKey: 'rbReimbursementProc',
    procUnitId: body.find(([key]) => key === 'procUnitId')![1] });
  if (String(show.status) !== '0' || show.data !== 'true') throw new TravelSubmitError('handlers_hidden');
  const saved = await call(TRAVEL_PATHS.saveForm, { ...encodeFields(body), showTips: 'false' });
  const biz = record(record(saved.data)?.bizData);
  // OA leaves settlementAmount out (or 0) when there is no payment row.
  if (!['0', '1'].includes(String(saved.status)) || !biz || cents(biz.reimbursementAmount) !== trip || cents(biz.businessTripAmount) !== trip
    || (cents(biz.settlementAmount) ?? 0) !== payment || (cents(biz.reverseEntryAmount) ?? 0) !== reverse
    || Number(biz.attachmentNumber) !== expect.attachmentCount) throw new TravelSubmitError('save_mismatch');
  const handlers = await call(TRAVEL_PATHS.handlers, encodeFields(body));
  const data = record(handlers.data);
  const issue = String(handlers.status) === '0' ? travelRouteIssue(data, form, expect.managerId) : '审批路线请求未成功';
  if (issue) throw new TravelSubmitError('route_unverified', issue);
  const approvers = (data!.Rows as Record<string, unknown>[]);
  const route = approvers.map(row => ({ step: String(row.subProcUnitName), handler: String(row.handlerName), group: Number(row.groupId) }));

  // 3. 流转确认“确定”：唯一一次 queryAdvance，附上页面表格中的处理人行
  options.validated?.({ documentNumber: form.documentNumber, amount: (trip / 100).toFixed(2) });
  options.progress?.('advance', `审批路线：${route.map(item => `${item.step} ${item.handler}`).join('、')}。正在发送唯一一次提交请求。`);
  const procUnitHandlers = approvers.map((row, index) => ({ ...row, canMerge: '0', merged: '0', __id: `r${1001 + index}`, __isEditor: false }));
  let text: string;
  try {
    text = await post(client, form, TRAVEL_PATHS.advance, { form: { ...encodeFields(body),
      ...encodeFields([['procUnitHandlers', JSON.stringify(procUnitHandlers)]]), hasGatewayManual: String(data!.hasGatewayManual) } }, 'save');
  } catch (error) {
    throw new TravelSubmitError('unknown', undefined, error instanceof HttpTravelError ? `queryAdvance ${error.code}` : 'queryAdvance 请求未完成');
  }
  if (text.trim()) {
    let reply: Record<string, unknown> | undefined;
    try { reply = record(JSON.parse(text)); } catch { /* not an envelope */ }
    // As 用款申请单 (live 2026-10-15); no 差旅单 has been seen succeeding yet.
    if (String(reply?.status) === '1' && reply?.data === 'ok') return { rule: TRAVEL_APPROVAL_RULE, route };
    const message = typeof reply?.message === 'string' ? reply.message.trim().slice(0, 300) : '';
    const response = `queryAdvance 响应：${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
    if (String(reply?.status) === '2' && message) throw new TravelSubmitError('rejected', message, response);
    throw new TravelSubmitError('unknown', message || undefined, response);
  }
  return { rule: TRAVEL_APPROVAL_RULE, route };
}
