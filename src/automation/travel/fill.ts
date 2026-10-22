import { htmlInputs, type OaHttpClient } from '../http-login';
import { bpmEncodeURI, type HttpForm } from '../http-bpm';
import type { FUNDING_KINDS } from '../funding-search';
import { cents, encodeFields, envelope, formFields, fundingTabs, gridRows, HttpTravelError, post, record, TEXT_ACCEPT, TRAVEL_KIND,
  TRAVEL_PATHS, TRAVEL_WRITES, travelBizFields, yuan, type Body, type TravelSend, type TravelStep } from './request';
import { ctripBorrowQuery, easySearchRows, personQuery, selectOptions, TRAVELLER_KINDS, type TravellerKind } from './search';
import { chooseTravelFunding, lineAmounts, saveTravelFunding, type FundingLine } from './funding';
import { linkTravelInvoices, prepareTravelInvoices, travelInvoiceCount, type InvoiceOptions, type TravelInvoice } from './invoices';
import { payeeAmounts, saveTravelPayees, type TravelPayee } from './payees';

const VEHICLES = ['aircraft', 'train', 'car', 'other'] as const;

export interface TravelLeg {
  /** YYYY-MM-DD. */
  startDate: string;
  startAddress: string;
  arriveDate: string;
  arriveAddress: string;
  vehicle: typeof VEHICLES[number];
  trafficExpense: string;
  travelDays: number;
  /** 实际补贴; defaults to 标准补贴 (the traveller's daily rate × travelDays), never above it. */
  subsidyAmount?: string;
  hotelExpense?: string;
  meetingAmount?: string;
  otherAmount?: string;
}
export interface Traveller {
  kind: TravellerKind;
  /** 工号 / 学号, checked together with the name (students share names). */
  code: string;
  name: string;
  remark?: string;
  legs: TravelLeg[];
}
export interface HttpTravelInput {
  fundingKind?: keyof typeof FUNDING_KINDS;
  fundingCode: string;
  /** 经费明细: 1–10 支出项目 under the fund; amounts add up to the 差旅合计 (one may be left blank). */
  lines: FundingLine[];
  /** 附件张数, put on the first 经费明细 line. */
  attachmentCount: number;
  /** 报销事由. */
  reason: string;
  /** 情况说明. */
  explain?: string;
  travellers: Traveller[];
  /** 携程借款单 订单号 (borrowMoneyCode), each written off by its full 未清余额. */
  ctripOrders?: string[];
  /** 0–10: each linked for its full 可报余额; together at least the payment less the subsidies. */
  invoices?: TravelInvoice[];
  /** 收款人: amounts add up to 差旅合计 − 携程冲账 (one may be left blank); none when the write-offs cover all. */
  payees: TravelPayee[];
}
export interface HttpTravelResult {
  fundingItemsId: string;
  managerId: string;
  /** Each payee's name as OA has it, in order; empty when no payment row was needed. */
  payeeNames: string[];
  /** Cents, in line order. */
  lineAmounts: number[];
  /** Cents, in payee order (payees left with nothing are dropped). */
  payeeAmounts: Array<{ payee: TravelPayee; amount: number }>;
  bizData: { businessTripAmount: number; reverseEntryAmount: number; reimbursementAmount: number; settlementAmount: number;
    attachmentNumber: number };
}
export interface HttpTravelOptions extends InvoiceOptions {
  progress?: (step: TravelStep, message: string) => void;
  /** Checked before each step; true ends the run there. */
  stopped?: () => boolean;
}

const optional = (value: string | undefined) => (value === undefined || value.trim() === '' ? 0 : cents(value));
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONEY = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const blank = (value: string | undefined) => value === undefined || value.trim() === '';

/** Amount cells of one leg in cents, plus its total as OA computes it (totalAmount). */
export function legAmounts(leg: TravelLeg, dailySubsidy: number) {
  const traffic = cents(leg.trafficExpense), hotel = optional(leg.hotelExpense), meeting = optional(leg.meetingAmount),
    other = optional(leg.otherAmount);
  const standard = dailySubsidy * leg.travelDays;
  const subsidy = leg.subsidyAmount === undefined ? standard : cents(leg.subsidyAmount);
  if ([traffic, hotel, meeting, other, subsidy].some(value => value === null || value < 0)) return null;
  return { traffic: traffic!, hotel: hotel!, meeting: meeting!, other: other!, standard, subsidy: subsidy!,
    total: traffic! + hotel! + meeting! + other! + subsidy! };
}

/** One row of saveRbBusinessDetails, field for field as the dialog's form sends it. */
export function legRow(leg: TravelLeg, dailySubsidy: number, vehicleText: string): Record<string, string> {
  const amounts = legAmounts(leg, dailySubsidy)!;
  const money = (value: number, given: string | undefined) => (blank(given) ? '' : yuan(value));
  return { id: '', travellerSubsidyAmount: String(dailySubsidy / 100), startDate: leg.startDate, startAddress: leg.startAddress.trim(),
    arriveDate: leg.arriveDate, arriveAddress: leg.arriveAddress.trim(), vehicle: leg.vehicle, vehicle_text: vehicleText,
    trafficExpense: yuan(amounts.traffic), travelDays: String(leg.travelDays), standardSubsidyAmount: yuan(amounts.standard),
    subsidyAmount: yuan(amounts.subsidy), hotelExpense: money(amounts.hotel, leg.hotelExpense),
    meetingAmount: money(amounts.meeting, leg.meetingAmount), otherAmount: money(amounts.other, leg.otherAmount) };
}

/** Input checks that need no OA data; fillTravelFormHttp runs them first. */
export function validateTravelInput(input: HttpTravelInput): void {
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
  const amountOk = (value: string | undefined) => blank(value) || (MONEY.test(value!.trim()) && cents(value) !== null && cents(value)! > 0);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const payees = Array.isArray(input.payees) ? input.payees : [];
  const ok = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.fundingCode)
    && lines.length >= 1 && lines.length <= 10 && new Set(lines.map(line => line.budgetName?.trim())).size === lines.length
    && lines.every(line => text(line.budgetName, 100) && text(line.purpose, 200) && amountOk(line.amount))
    && lines.filter(line => blank(line.amount)).length <= 1
    && payees.length <= 10 && payees.filter(payee => blank(payee.amount)).length <= 1
    && new Set(payees.map(payee => `${payee.kind}|${payee.code?.trim()}|${payee.supplierCode ?? ''}`)).size === payees.length
    && payees.every(payee => amountOk(payee.amount) && (payee.kind === 'bank'
      ? text(payee.code, 100) && /^\d{1,20}$/.test(payee.supplierCode ?? '') && text(payee.remitPurpose, 200)
      : payee.kind === 'card' && /^[a-zA-Z0-9_-]{2,32}$/.test(payee.code) && payee.supplierCode === undefined))
    && Number.isInteger(input.attachmentCount) && input.attachmentCount >= 0 && input.attachmentCount <= 100
    && text(input.reason, 200) && (input.explain === undefined || input.explain.length <= 200)
    && Array.isArray(input.travellers) && input.travellers.length >= 1 && input.travellers.length <= 20
    && new Set(input.travellers.map(item => item.code)).size === input.travellers.length
    && input.travellers.some(item => item.legs.length > 0)
    && input.travellers.every(item => item.kind in TRAVELLER_KINDS && /^[A-Za-z0-9]{2,32}$/.test(item.code) && text(item.name, 30)
      && (item.remark === undefined || item.remark.length <= 60) && Array.isArray(item.legs) && item.legs.length <= 30
      && item.legs.every(leg => DATE.test(leg.startDate) && DATE.test(leg.arriveDate) && text(leg.startAddress, 32)
        && text(leg.arriveAddress, 32) && VEHICLES.includes(leg.vehicle) && Number.isInteger(leg.travelDays)
        && leg.travelDays >= 0 && leg.travelDays <= 999 && cents(leg.trafficExpense) !== null))
    && (input.ctripOrders ?? []).length <= 50 && new Set(input.ctripOrders ?? []).size === (input.ctripOrders ?? []).length
    && (input.ctripOrders ?? []).every(order => /^\d{4,32}$/.test(order))
    && (input.invoices ?? []).length <= 10 && new Set((input.invoices ?? []).map(item => item.number)).size === (input.invoices ?? []).length
    && (input.invoices ?? []).every(item => /^\d{20}$/.test(item.number)
      && (item.folderId === undefined ? Boolean(item.bytes?.length) : item.bytes === undefined && /^\d{1,32}$/.test(item.folderId)));
  if (!ok) throw new HttpTravelError('invalid_input');
  // domesticTravelDetail.js / reimbursementBusinessTrip.js: arrival not before start, days at most the
  // calendar span, actual subsidy not above standard. The daily rate is checked once OA states it.
  for (const traveller of input.travellers) {
    for (const leg of traveller.legs) {
      const span = days(leg.startDate, leg.arriveDate);
      if (!Number.isFinite(span) || span < 0 || leg.travelDays > span + 1) {
        throw new HttpTravelError('leg_invalid', 'detail', `${traveller.name} ${leg.startDate} ${leg.startAddress}→${leg.arriveAddress}`);
      }
    }
  }
}

/** Fills a blank, opened 境内差旅单 over HTTP: funding with its 支出项目, travellers, their legs, 携程
 * write-offs, invoices, one payment row per payee, and the main-form save with every 经费明细 line
 * (together the trip total, which OA requires on submit: "报销总金额不等于差旅费用金额"). Never submits. */
export async function fillTravelFormHttp(client: OaHttpClient, form: HttpForm, input: HttpTravelInput,
  options: HttpTravelOptions = {}): Promise<HttpTravelResult> {
  const state = { wrote: false };
  try {
    return await fill(client, form, input, options, state);
  } catch (error) {
    const failure = error instanceof HttpTravelError ? error
      : new HttpTravelError((error as { code?: string })?.code === 'authentication' ? 'authentication' : 'response_invalid', 'funding');
    failure.partial = state.wrote;
    throw failure;
  }
}

async function fill(client: OaHttpClient, form: HttpForm, input: HttpTravelInput, options: HttpTravelOptions,
  state: { wrote: boolean }): Promise<HttpTravelResult> {
  validateTravelInput(input);
  if (form.context.reimbursementKind !== TRAVEL_KIND) throw new HttpTravelError('not_travel');
  const progress = (step: TravelStep, message: string) => {
    if (options.stopped?.()) throw new HttpTravelError('stopped', step);
    options.progress?.(step, message);
  };
  const bizId = form.context.bizId;
  const send: TravelSend = (pathname: string, body: Body, step: TravelStep, extra?: { accept?: string; query?: string }) => {
    if (TRAVEL_WRITES.has(pathname)) state.wrote = true;
    return post(client, form, pathname, body, step, extra);
  };
  const json = async (pathname: string, fields: Record<string, string>, step: TravelStep) => envelope(await send(pathname, { form: fields }, step), step);
  const editorPage = async (step: TravelStep) =>
    (await client.request(form.url).catch(() => { throw new HttpTravelError('request_failed', step); })).text;

  // 0. 只在空单上填写：没有经费、出差人、冲借款、发票
  const editor = await editorPage('funding');
  const travellersNow = async () => {
    const list = await json(TRAVEL_PATHS.travellers, { reimbursementId: bizId }, 'traveller');
    if (String(list.status) !== '0' || !Array.isArray(list.data)) throw new HttpTravelError('response_invalid', 'traveller');
    return list.data.map(item => record(item) ?? {});
  };
  const writeOffsNow = async () => gridRows(await json(TRAVEL_PATHS.writeOffs, { reimbursementId: bizId, sortfields: '[]' }, 'writeoff'), 'writeoff');
  if (fundingTabs(editor).length || (await travellersNow()).length || (await writeOffsNow()).length
    || await travelInvoiceCount(client, form)) throw new HttpTravelError('form_not_blank', 'funding');

  // 1. 经费及每行预算科目（只读定位）
  progress('funding', `正在按经费编号和 ${input.lines.length} 个预算科目名称唯一定位。`);
  const choice = await chooseTravelFunding(client, form, input.fundingKind ?? 'authorized', input.fundingCode, input.lines);

  // 2. 出差人：先只读核对类别，并按姓名查询（与弹窗相同）后核对学号/工号；携程借款单同样先只读定位
  progress('traveller', `正在核对 ${input.travellers.length} 位出差人。`);
  const travellerPage = await send(TRAVEL_PATHS.travellerPage, { form: {} }, 'traveller', { accept: TEXT_ACCEPT });
  const kinds = selectOptions(travellerPage, 'travellerTypeId');
  for (const traveller of input.travellers) {
    const label = TRAVELLER_KINDS[traveller.kind];
    if (kinds.filter(item => item.label === label).length !== 1) throw new HttpTravelError('traveller_kind_missing', 'traveller', label);
    const found = easySearchRows(await send(TRAVEL_PATHS.personSearch, { form: personQuery(traveller.kind, traveller.name) }, 'traveller',
      { accept: TEXT_ACCEPT })).filter(row => row.code === traveller.code);
    if (!found.length || found.some(row => row.name !== traveller.name.trim())) {
      throw new HttpTravelError('person_missing', 'traveller', `${label} ${traveller.code} ${traveller.name}`);
    }
  }
  const orders = input.ctripOrders ?? [];
  let borrows: Record<string, unknown>[] = [];
  if (orders.length) {
    // 携程借款单 is read before anything is written, so a wrong order number leaves the form blank.
    if (htmlInputs(editor).find(attrs => attrs.id === 'hasCtripBorrowAccount')?.value !== 'true') {
      throw new HttpTravelError('borrow_missing', 'writeoff', '本单不提供携程借款单');
    }
    const listed = gridRows(await json(TRAVEL_PATHS.ctripBorrows, ctripBorrowQuery(form.context.accountBook || 'ST00', choice.fund.projectId),
      'writeoff'), 'writeoff');
    borrows = orders.map(order => {
      const hits = listed.filter(row => String(row.borrowMoneyCode) === order);
      if (hits.length !== 1 || (cents(hits[0].outstandingAmount) ?? 0) <= 0) throw new HttpTravelError('borrow_missing', 'writeoff', order);
      return hits[0];
    });
  }

  // 发票：票夹中已有的只读核对，其余 PDF 上传到票夹并等列出，均在写入本单之前
  const invoices = input.invoices ?? [];
  const { listed: invoiceRows } = invoices.length
    ? await prepareTravelInvoices(client, form, invoices, send, progress, options) : { listed: new Map<string, Record<string, unknown>>() };

  // 3. 保存经费选择（本单的第一个写入），各行预算科目一次保存
  progress('funding', '出差人已核对，正在保存经费选择。');
  const fundingItemsId = await saveTravelFunding(send, form, choice);

  // 4. 逐人保存出差人，回读取得出差人 ID 及其每日补贴标准
  const saved = new Map<string, Record<string, unknown>>();
  for (const traveller of input.travellers) {
    progress('traveller', `正在添加出差人 ${traveller.name}（${TRAVELLER_KINDS[traveller.kind]}）。`);
    const typeId = kinds.find(item => item.label === TRAVELLER_KINDS[traveller.kind])!.value;
    const reply = await json(TRAVEL_PATHS.saveTraveller, { id: '', travellerCode: traveller.code, travellerTypeId: typeId,
      travellerTypeId_text: bpmEncodeURI(TRAVELLER_KINDS[traveller.kind]), traveller: bpmEncodeURI(traveller.name.trim()),
      remark: bpmEncodeURI(traveller.remark?.trim() ?? ''), reimbursementId: bizId }, 'traveller');
    if (String(reply.status) !== '1') throw new HttpTravelError('traveller_rejected', 'traveller', traveller.name);
    const mine = (await travellersNow()).filter(row => row.travellerCode === traveller.code);
    if (mine.length !== 1 || !/^[\dA-F]{32}$/i.test(String(mine[0].id)) || mine[0].travellerTypeId !== typeId
      || mine[0].traveller !== traveller.name.trim() || cents(mine[0].subsidyAmount) === null) {
      throw new HttpTravelError('traveller_rejected', 'traveller', traveller.name);
    }
    saved.set(traveller.code, mine[0]);
  }

  // 5. 行程：每段一个请求（与页面“添加 → 保存”相同），每人回读合计
  let tripTotal = 0, subsidyTotal = 0;
  for (const traveller of input.travellers) {
    const travellerId = String(saved.get(traveller.code)!.id);
    let expected = 0;
    for (const [index, leg] of traveller.legs.entries()) {
      progress('detail', `正在保存 ${traveller.name} 第 ${index + 1} 段行程 ${leg.startAddress}→${leg.arriveAddress}。`);
      const page = await send(TRAVEL_PATHS.detailPage, { form: { travellerId, reimbursementId: bizId } }, 'detail', { accept: TEXT_ACCEPT });
      const daily = cents(formFields(page, 'businessDetailSubmitForm').find(([key]) => key === 'travellerSubsidyAmount')?.[1]);
      if (daily === null || daily !== cents(saved.get(traveller.code)!.subsidyAmount)) throw new HttpTravelError('response_invalid', 'detail',
        undefined, '学校 OA 返回的补贴标准无法识别或与出差人不一致，已停止填写。');
      const amounts = legAmounts(leg, daily);
      const where = `${traveller.name} ${leg.startDate} ${leg.startAddress}→${leg.arriveAddress}`;
      if (!amounts || amounts.subsidy > amounts.standard) throw new HttpTravelError('leg_invalid', 'detail', where);
      const vehicle = selectOptions(page, 'vehicle').filter(item => item.value === leg.vehicle);
      if (vehicle.length !== 1) throw new HttpTravelError('vehicle_missing', 'detail', leg.vehicle);
      const reply = await json(TRAVEL_PATHS.saveDetails, { reimbursementId: bizId, travellerId,
        businessDetails: bpmEncodeURI(JSON.stringify([legRow(leg, daily, vehicle[0].label)])) }, 'detail');
      if (String(reply.status) !== '1') throw new HttpTravelError('detail_rejected', 'detail', where);
      expected += amounts.total;
      subsidyTotal += amounts.subsidy;
    }
    const listed = await json(TRAVEL_PATHS.details, { reimbursementId: bizId, travellerId, sortname: 'startDate', sortorder: 'asc',
      sortfields: '[]' }, 'detail');
    const total = traveller.legs.length ? cents(record(record(listed.data)?.totalFields)?.totalAmount) : 0;
    if (gridRows(listed, 'detail').length !== traveller.legs.length || total !== expected) {
      throw new HttpTravelError('detail_rejected', 'detail', traveller.name);
    }
    tripTotal += expected;
  }
  if (tripTotal <= 0) throw new HttpTravelError('invalid_input');
  // The lines and payees are settled now that OA has the trip total; nothing below is sent if they do not add up.
  const lineCents = lineAmounts(input.lines, tripTotal, choice);

  // 6. 冲借款：所选携程借款单，冲账金额 = 未清余额（reimburWriteOff.js 默认），一次保存全部
  let reverse = 0;
  if (borrows.length) {
    reverse = borrows.reduce((sum, row) => sum + cents(row.outstandingAmount)!, 0);
    if (reverse > tripTotal) throw new HttpTravelError('writeoff_over', 'writeoff', `冲账 ${yuan(reverse)}，差旅 ${yuan(tripTotal)}`);
  }
  const payment = tripTotal - reverse;
  const payees = payeeAmounts(input.payees, payment);
  if (borrows.length) {
    progress('writeoff', `正在冲销 ${borrows.length} 张携程借款单，共 ${yuan(reverse)} 元。`);
    const reply = await json(TRAVEL_PATHS.saveWriteOffs, { reimbursementId: bizId,
      writeOffs: bpmEncodeURI(JSON.stringify(borrows.map(row => ({ ...row, id: '', strikeBalanceAmount: row.outstandingAmount })))) }, 'writeoff');
    if (String(reply.status) !== '1') throw new HttpTravelError('writeoff_rejected', 'writeoff');
    const back = await writeOffsNow();
    if (back.length !== borrows.length || back.reduce((sum, row) => sum + (cents(row.strikeBalanceAmount) ?? NaN), 0) !== reverse
      || borrows.some(row => back.filter(item => item.borrowMoneyCode === row.borrowMoneyCode).length !== 1)) {
      throw new HttpTravelError('writeoff_rejected', 'writeoff');
    }
  }

  // 7. 关联发票（补贴不需要发票），再逐个收款人付款
  if (invoices.length) {
    progress('invoice', `正在把 ${invoices.length} 张发票关联到本单。`);
    await linkTravelInvoices(send, form, invoices, invoiceRows, Math.max(0, payment - subsidyTotal));
  }
  let payeeNames: string[] = [];
  if (payees.length) {
    progress('payment', `正在添加 ${payees.length} 个收款人，共 ${yuan(payment)} 元。`);
    payeeNames = await saveTravelPayees(send, form, payees);
  }

  // 8. 经费明细（每行金额、用途；附件数在第一行）+ 报销事由、情况说明，保存主表单
  progress('save', `正在写入 ${input.lines.length} 行经费明细和报销事由并保存主表单。`);
  const details = gridRows(await json(TRAVEL_PATHS.budgetRows, { reimbursementId: bizId, fundingItemsId, sortfields: '[]' }, 'save'), 'save');
  const outlays = input.lines.map((line, index) => {
    const hits = details.filter(row => row.expenditureItemName === line.budgetName.trim());
    if (hits.length !== 1) throw new HttpTravelError('detail_missing', 'save', line.budgetName);
    return { ...hits[0], amount: yuan(lineCents[index]), attachmentNumber: String(index ? 0 : input.attachmentCount), remark: line.purpose.trim() };
  });
  if (details.length !== input.lines.length) throw new HttpTravelError('detail_missing', 'save');
  const body = travelBizFields(await editorPage('save'), form, input.reason, outlays, input.explain ?? '');
  if (!body) throw new HttpTravelError('response_invalid', 'save', undefined, '差旅单主表单字段无法识别，未保存。');
  const result = await json(TRAVEL_PATHS.saveForm, encodeFields(body), 'save');
  const biz = record(record(result.data)?.bizData);
  if (String(result.status) !== '1' || !biz) throw new HttpTravelError('save_rejected', 'save');
  if (cents(biz.businessTripAmount) !== tripTotal || cents(biz.reimbursementAmount) !== tripTotal
    || (cents(biz.reverseEntryAmount) ?? 0) !== reverse || (cents(biz.settlementAmount) ?? 0) !== payment
    || Number(biz.attachmentNumber) !== input.attachmentCount) throw new HttpTravelError('save_mismatch', 'save');
  return { fundingItemsId, managerId: String(choice.fund.firstId ?? ''), payeeNames, lineAmounts: lineCents, payeeAmounts: payees,
    bizData: { businessTripAmount: Number(biz.businessTripAmount), reverseEntryAmount: Number(biz.reverseEntryAmount ?? 0),
      reimbursementAmount: Number(biz.reimbursementAmount), settlementAmount: Number(biz.settlementAmount ?? 0),
      attachmentNumber: Number(biz.attachmentNumber) } };
}
