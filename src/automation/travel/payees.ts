import { htmlInputs } from '../http-login';
import { bpmEncodeURI, type HttpForm } from '../http-bpm';
import { parseSuppliers, sameName, supplierQuery } from '../http-payee';
import { BANK_TRANSFER, cents, encodeFields, encryptPopupPayload, envelope, formFields, gridRows, HttpTravelError, parsePopupCipher,
  PERSONAL_CARD, record, TEXT_ACCEPT, TRAVEL_PATHS, yuan, type TravelSend } from './request';

/** 收款人 of a 境内差旅单: one or more payment rows whose sum is 差旅合计 − 携程冲账, as on D209900000034
 * (报销人甲 2,200 for the registration he paid, 教师丙 930 for subsidy and hotel). */
export interface TravelPayee {
  /** card: 个人银行卡 to the 学号/工号 `code`; bank: 银行汇款 to the OA supplier `supplierCode` whose account name is `code`. */
  kind: 'card' | 'bank';
  code: string;
  supplierCode?: string;
  /** 银行汇款's 汇款用途. */
  remitPurpose?: string;
  /** Yuan; at most one payee may leave it out and takes what the others leave. */
  amount?: string;
}

const KINDS = { card: { code: PERSONAL_CARD, name: '个人银行卡' }, bank: { code: BANK_TRANSFER, name: '银行汇款' } } as const;

/** Each payee's amount in cents: the blank one takes the rest of `payment`, and is dropped when that is 0
 * (write-offs covering the trip). Every amount is positive and they add up to `payment`. */
export function payeeAmounts(payees: TravelPayee[], payment: number): Array<{ payee: TravelPayee; amount: number }> {
  const given = payees.map(payee => (payee.amount === undefined || payee.amount.trim() === '' ? null : cents(payee.amount)));
  const rest = payment - given.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const rows = payees.map((payee, index) => ({ payee, amount: given[index] ?? rest }))
    .filter((row, index) => !(given[index] === null && row.amount === 0));
  if (rows.some(row => row.amount <= 0) || rows.reduce((sum, row) => sum + row.amount, 0) !== payment) {
    throw new HttpTravelError('payees_invalid', 'payment', `应付 ${yuan(payment)} 元，收款人 ${rows.map(row => yuan(row.amount)).join(' + ') || '无'}`);
  }
  return rows;
}

/** 付款: each needed payment kind is added once, the form must hold no payment row yet, then one row per
 * payee is saved (the dialog's 添加 → 保存) and read back. Returns each payee's name, in order. */
export async function saveTravelPayees(send: TravelSend, form: HttpForm, rows: Array<{ payee: TravelPayee; amount: number }>): Promise<string[]> {
  const bizId = form.context.bizId;
  const json = async (pathname: string, fields: Record<string, string>, accept?: string) =>
    envelope(await send(pathname, { form: fields }, 'payment', accept ? { accept } : undefined), 'payment');
  const kinds = async () => {
    const list = await json(TRAVEL_PATHS.settleKinds, { reimbursementId: bizId });
    if (String(list.status) !== '0' || !Array.isArray(list.data)) throw new HttpTravelError('response_invalid', 'payment');
    return (list.data as unknown[]).map(item => record(item) ?? {});
  };
  const settleRows = async (kindId: string) => gridRows(await json(TRAVEL_PATHS.settleRows, { reimbursementId: bizId,
    reimburSettleKindId: kindId, sortname: 'createdDate', sortorder: 'desc', sortfields: '[]' }), 'payment');

  // 付款方式: add the missing ones from the dialog's checkbox list.
  let present = await kinds();
  for (const kind of new Set(rows.map(row => row.payee.kind))) {
    if (present.some(item => item.code === KINDS[kind].code)) continue;
    const page = await send(TRAVEL_PATHS.settleKindPage, { form: { reimbursementKind: form.context.reimbursementKind, reimbursementId: bizId } },
      'payment', { accept: TEXT_ACCEPT });
    const choices = [...page.matchAll(/<input\b[^>]*name=["']settlementKindId["'][^>]*>\s*([^<]*)/gi)]
      .filter(match => match[1].trim() === KINDS[kind].name).map(match => htmlInputs(match[0])[0]?.value ?? '');
    if (choices.length !== 1 || !/^[\dA-F]{32}$/i.test(choices[0])) throw new HttpTravelError('settle_kind_missing', 'payment');
    const added = await json(TRAVEL_PATHS.addSettleKind, { reimbursementId: bizId, settleKindIds: choices[0] });
    if (String(added.status) !== '1') throw new HttpTravelError('settle_kind_missing', 'payment');
    present = await kinds();
  }
  const kindRow = (kind: TravelPayee['kind']) => {
    const hits = present.filter(item => item.code === KINDS[kind].code);
    if (hits.length !== 1 || typeof hits[0].id !== 'string') throw new HttpTravelError('settle_kind_missing', 'payment');
    return hits[0];
  };
  for (const item of present) if ((await settleRows(String(item.id ?? ''))).length) throw new HttpTravelError('payment_exists', 'payment');

  const names: string[] = [];
  const savedPerKind = new Map<string, number>();
  for (const { payee, amount } of rows) {
    const card = kindRow(payee.kind);
    const settleKindId = String(card.id);
    const history = { isSelectHistory: String(card.isSelectHistory ?? 0), isCash: String(card.isCash ?? 0) };
    let payeeName: string, saveForm: Record<string, string>;
    if (payee.kind === 'bank') {
      const suppliers = parseSuppliers(await json(TRAVEL_PATHS.supplierSearch, supplierQuery(payee.code)))
        .filter(item => item.supplierCode === payee.supplierCode && sameName(item.name, payee.code));
      if (suppliers.length !== 1) throw new HttpTravelError('payee_missing', 'payment', payee.code);
      const supplier = suppliers[0];
      // The dialog posts the chosen supplier row back with its own id blanked (the form's id is the new row's).
      const settlePage = await send(TRAVEL_PATHS.settlePage, { form: { ...Object.fromEntries(Object.entries(supplier.row)
        .map(([key, item]) => [key, item === null || item === undefined ? '' : String(item)])), id: '', ...history,
        reimburSettleKindId: settleKindId, reimbursementId: bizId } }, 'payment', { accept: TEXT_ACCEPT });
      const fields = formFields(settlePage, 'reimbursementSettlementForm').filter(([key]) => !key.startsWith('__'));
      const value = (name: string) => fields.find(([key]) => key === name)?.[1] ?? '';
      if (value('reimbursementId') !== bizId || value('supplierCode') !== supplier.supplierCode || value('payeeCode') !== supplier.account
        || value('rbSettlementKindCode') !== BANK_TRANSFER || value('id') !== '') throw new HttpTravelError('response_invalid', 'payment');
      payeeName = value('payee') || supplier.name;
      saveForm = encodeFields([...fields.filter(([key]) => key !== 'purpose' && key !== 'paymentAmount'),
        ['purpose', payee.remitPurpose!.trim()], ['paymentAmount', yuan(amount)], ['isSelectHistory', history.isSelectHistory], ['isCash', history.isCash]]);
    } else {
      const settlePage = await send(TRAVEL_PATHS.settlePage, { form: { reimburSettleKindId: settleKindId, reimbursementId: bizId } },
        'payment', { accept: TEXT_ACCEPT });
      const fields = formFields(settlePage, 'reimbursementSettlementForm');
      const value = (name: string) => fields.find(([key]) => key === name)?.[1] ?? '';
      const popupSessionId = value('__POPUP_SESSION_ID');
      if (!/^[\da-f-]{36}$/i.test(popupSessionId) || value('reimbursementId') !== bizId) throw new HttpTravelError('response_invalid', 'payment');
      const cipher = parsePopupCipher(value('__CORE_JS_B64'));
      const settle = fields.filter(([key]) => !key.startsWith('__'));
      const lookup = Object.fromEntries(settle.map(([key, item]) => [key, key === 'personCode' ? payee.code : item]));
      const person = await json(TRAVEL_PATHS.personInfo, { popupSessionId,
        encryptedPayload: bpmEncodeURI(await encryptPopupPayload(cipher, lookup)) });
      const info = record(person.data);
      const account = typeof info?.caNo === 'string' ? info.caNo : '';
      payeeName = typeof info?.name === 'string' ? info.name.trim() : '';
      if (!/^\d{8,32}$/.test(account) || !payeeName) throw new HttpTravelError('payee_missing', 'payment', payee.code);
      saveForm = { ...Object.fromEntries(settle), personCode: payee.code, personName: bpmEncodeURI(payeeName), payeeCode: account,
        paymentAmount: yuan(amount), ...history };
    }
    const settled = await json(TRAVEL_PATHS.saveSettle, saveForm);
    if (String(settled.status) !== '1' || cents(settled.data) !== amount) throw new HttpTravelError('payment_rejected', 'payment', payeeName);
    // Each save adds exactly one row of its kind.
    const count = (savedPerKind.get(settleKindId) ?? 0) + 1;
    savedPerKind.set(settleKindId, count);
    if ((await settleRows(settleKindId)).length !== count) throw new HttpTravelError('payment_rejected', 'payment', payeeName);
    names.push(payeeName);
  }
  return names;
}
