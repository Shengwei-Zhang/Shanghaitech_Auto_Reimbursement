const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const { fillTravelFormHttp, legRow, easySearchRows, selectOptions, submitTravelFormHttp, validateTravelInput } = require('../dist/automation/travel/index.js');
const { normalizeFormContext } = require('../dist/automation/reimbursement-context.js');

// Shapes from the 2026-10-21 capture of D209900000038 (tmp/travel-capture, not committed).
const BIZ = '5E5AC766876E7758E0632D2A0F0AF09B';
const TASK = 'dd838710-cd53-11f1-8913-525400cfaf12';
const CSRF = '159BB12842D0416DB2346681665A567F';
const FUNDING_ID = '5E5AC88C45F3A2E5E0632C2A0F0A502B';
const KIND_ID = '5E5AD06A27BCB0B0E0632C2A0F0AB8D9';
const CARD_KIND = '003B714CBB164B6C8562338A4D1E3237';
const STAFF_TYPE = 'BCEF71B8970942AE920E29A7AF33AC4D', STUDENT_TYPE = 'E3CF8F58DA8044A6A37A341C5BC42CD1';
const POPUP = 'cccccccc-1111-2222-3333-444444444444';
const SECRET = { password: 'Pw3kLm9QzX1vB7nT', salt: 'Sa1tR4nD0mV4lu3s', iterations: 1000 };
const URL_ = `https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job?bizId=${BIZ}&taskId=${TASK}`;
const FORM = { url: URL_, csrfToken: CSRF, procTaskId: TASK, documentNumber: 'D209900000038',
  context: { bizId: BIZ, taskId: TASK, accountBook: 'ST00', reimbursementKind: 'domesticTravel' } };
const LEG_OUT = { startDate: '2026-10-19', startAddress: '上海', arriveDate: '2026-10-20', arriveAddress: '北京', vehicle: 'aircraft',
  trafficExpense: '111', travelDays: 2, hotelExpense: '500', meetingAmount: '2400' };
const LEG_BACK = { startDate: '2026-10-20', startAddress: '北京', arriveDate: '2026-10-20', arriveAddress: '上海', vehicle: 'aircraft',
  trafficExpense: '1000', travelDays: 0 };
const INPUT = { fundingKind: 'authorized', fundingCode: '2099F9999-000-01', attachmentCount: 3,
  lines: [{ budgetName: '国内差旅/参会费', purpose: '教师乙北京差旅' }], payees: [{ kind: 'card', code: '900002' }],
  reason: '教师乙北京差旅', explain: '参加会议',
  travellers: [{ kind: 'staff', code: '900002', name: '教师乙', legs: [LEG_OUT, LEG_BACK] },
    { kind: 'student', code: '2020000001', name: '李同学', legs: [] }],
  ctripOrders: ['1990000000000006', '1990000000000005'] };
// 3371 + 1000 差旅, 882 + 1383 冲账, 2106 付款.

const core = () => Buffer.from(`return (async function(){ let innerEncrypt = async function(dataObj){ const encoder=new TextEncoder();
 const saltBytes=encoder.encode('${SECRET.salt}'); const pswBytes=encoder.encode('${SECRET.password}');
 const aesKey=await crypto.subtle.deriveKey({name:'PBKDF2',salt:saltBytes,iterations:${SECRET.iterations},hash:'SHA-256'},keyMaterial,{name:'AES-CBC',length:256},false,['encrypt']);
 combined.set(iv,0); return btoa(binary); }; })()`).toString('base64');
const EDITOR = `<input type="hidden" name="procInstId" id="jobPageProcInstId" value="dd82c3ba-cd53-11f1-8913-525400cfaf12">
<input type="hidden" name="taskDefKey" id="jobPageTaskDefKey" value="Apply">
<form class="hg-form" method="post" action="" id="submitForm">
<input type="hidden" name="id" value="${BIZ}"><input type="text" name="billCode" value="D209900000038" readonly="readonly">
<input type="hidden" name="reimbursementKind" value="domesticTravel"><input type="hidden" name="accountBook" value="ST00">
</form><input type="hidden" name="currencyKind" value="0" id="currencyKind"/>
<input type="hidden" name="hasCtripBorrowAccount" value="true" id="hasCtripBorrowAccount"/>
<textarea name="explain" id="reimbursementExplain"></textarea>`;
const FUNDING_HTML = `<table id="easySearchTableListData" dataCount="1" pageCount="1"><tr class="list"><td>
<input type="hidden" name="projectid" value="2099F9999-000-01"><input type="hidden" name="projectname" value="教师乙启动经费">
<input type="hidden" name="departmid" value="9999P0001"><input type="hidden" name="departmname" value="教师乙组">
<input type="hidden" name="firstid" value="900002"></td></tr></table>`;
const BUDGET_ROWS = [
  { quotaName: '业务费（含设备费）', budgetBalance: '4910.83', expenditureItemCode: '09', projectCode: '2099F9999-000-01',
    showAmount: '4910.83', projectName: '教师乙启动经费', expenditureItemName: '国内差旅/参会费', quotaCode: '02' },
  { quotaName: '业务费（含设备费）', budgetBalance: '2000.00', expenditureItemCode: '10', projectCode: '2099F9999-000-01',
    showAmount: '2000.00', projectName: '教师乙启动经费', expenditureItemName: '会议费', quotaCode: '02' },
];
const person = (code, name) => `<tr class='list'> <input type='hidden' flag='0' name='id' value='${code}' />
  <td title='${code}'> ${code} </td> <input type='hidden' flag='1' name='code' value='${code}' />
  <td title='${name}'> ${name} </td> <input type='hidden' flag='1' name='name' value='${name}' /> </tr>`;
const PEOPLE = { '教师乙': [['900002', '教师乙']], '李同学': [['2020000001', '李同学'], ['2024000002', '李同学']] };
const TRAVELLER_PAGE = `<form class="hg-form" method="post" action="" id="businessTravellerSubmitForm"><input type="hidden" name="id" id="id"/>
<select name="travellerTypeId" id="travellerTypeId" class="select" required="true" label="类别" > <option value=""></option>
<option value="${STAFF_TYPE}">教工</option> <option value="${STUDENT_TYPE}">学生</option>
<option value="D03FA41EE5E73FD1E053132A0F0ADF51">校外</option> </select></form>`;
const detailPage = daily => `<form class="hg-form" method="post" action="" id="businessDetailSubmitForm"> <input type="hidden" name="id" id="id"/>
<input type="hidden" name="travellerSubsidyAmount" value="${daily}" id="travellerSubsidyAmount"/>
<select name="vehicle" id="vehicle" class="select" required="true" label="交通工具" > <option value=""></option>
<option value="other">其他</option> <option value="car">汽车</option> <option value="aircraft">飞机</option> <option value="train">火车</option>
</select></form>`;
const borrow = (code, amount) => ({ deptName: '', accountCode: '12I7000000', quotaName: '', voucherYear: '2026', outstandingAmount: amount,
  accountName: '其他应收款-携程借款', borrowMoneyCode: code, remark: `携程机票#${code}`, ctripBorrowAccountKey: 'ctripAccount',
  loanAmount: amount, personCode: '0000101552', personName: '教师乙', projectCode: 'ST00', voucherNo: '1000031174', lineNumber: '175' });
const BORROWS = [borrow('9657678711', 952), borrow('1990000000000006', 882), borrow('1990000000000005', 1383)];

const FOLDER = '1879423340632997890', INVOICE = '26312000000000000001';
const FOLDER_ROW = { invoiceId: 'INV1', billTypeName: '电子发票', salerName: '某酒店', allValoremTax: '2106.00', invoiceDate: '2026-10-20 00:00:00',
  invoiceNumber: INVOICE, invoiceCode: '', billClaimState: 'UNDOING', invoiceBalance: '2106.00' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const twice = value => decodeURIComponent(decodeURIComponent(value));

async function decrypt(base64) {
  const bytes = Buffer.from(base64, 'base64'), enc = new TextEncoder();
  const material = await webcrypto.subtle.importKey('raw', enc.encode(SECRET.password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SECRET.salt), iterations: SECRET.iterations, hash: 'SHA-256' },
    material, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
  return JSON.parse(Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv: bytes.subarray(0, 16) }, key, bytes.subarray(16))).toString());
}

/** A stateful stand-in for the 境内差旅单 editor endpoints, answering with the captured shapes. */
function oa(overrides = {}) {
  const calls = [], state = { tabs: [], travellers: [], details: {}, writeOffs: [], kinds: [], settles: [], invoices: [] };
  const daily = { [STAFF_TYPE]: 180, [STUDENT_TYPE]: 100 };
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    const name = pathname.split('/').pop();
    const form = typeof init.body === 'string' && !init.body.startsWith('{') ? new URLSearchParams(init.body) : undefined;
    const call = { name, url, method: init.method, headers: init.headers, form, raw: init.body };
    calls.push(call);
    if (overrides[name]) { const reply = await overrides[name](call, state); if (reply) return reply; }
    switch (name) {
      case 'showLoadRbReimbursement.job': return new Response(`<div id="reimburFundingItemsTabDiv"><ul>${state.tabs.map(tab =>
        `<li id="${tab.id}" class="tab-item" data-code="${tab.code}" data-amount="${tab.amount}">${tab.code}</li>`).join('')}</ul></div>${EDITOR}`);
      case 'queryRbBusinessTravellers.ajax': return json({ status: 0, data: state.travellers });
      case 'queryRbReimburWriteOff.ajax': return json({ status: 0, data: { Total: state.writeOffs.length, Rows: state.writeOffs } });
      case 'slicedQueryRbReimbursementInvoices.ajax': return json({ status: 0, data: { Total: state.invoices.length, Rows: state.invoices } });
      case 'loadInvoiceFolderList1.ajax': return json({ status: 0, data: [{ id: FOLDER, invoiceFolderName: '自行上传票据' }] });
      case 'queryBillImageListForClaims4WsNew.ajax': return json({ status: 0, data: { Total: 1, Rows: [FOLDER_ROW] } });
      case 'insertRbReimbursementInvoice1.ajax': {
        const records = JSON.parse(init.body).insertRecords;
        state.invoices.push(...records);
        return json({ status: 0, data: { insertCount: records.length } });
      }
      case 'easySearch.load': {
        if (form.get('queryName') === 'queryFundingItems') return new Response(FUNDING_HTML);
        const people = PEOPLE[decodeURI(form.get('paramValue'))] ?? [];
        return new Response(`<table id="easySearchTableListData" dataCount='${people.length}'>${people.map(([c, n]) => person(c, n)).join('')}</table>`);
      }
      case 'queryChooseBudgetOutlays.ajax': return json({ status: 0, data: { Total: BUDGET_ROWS.length, requireAmount: '193110.83', showAmount: '193110.83',
        fundingManager: '900002', Rows: BUDGET_ROWS } });
      case 'showInsertRbBusinessTraveller.load': return new Response(TRAVELLER_PAGE);
      case 'queryCtripBorrows.ajax': return json({ status: 0, data: { Rows: BORROWS } });
      case 'saveRbReimburBudgetOutlays.ajax':
        state.tabs = [{ id: FUNDING_ID, code: '2099F9999-000-01', amount: '' }];
        state.chosen = JSON.parse(twice(form.get('budgetOutlays')));
        return json({ data: FUNDING_ID, status: 1 });
      case 'saveRbBusinessTraveller.ajax': {
        const type = form.get('travellerTypeId');
        state.travellers.push({ travellerTypeName: twice(form.get('travellerTypeId_text')), travellerTypeId: type, subsidyAmount: daily[type],
          travellerCode: form.get('travellerCode'), traveller: twice(form.get('traveller')), remark: '',
          id: `5E5ACA426354A2E1E0632C2A0F0A${String(state.travellers.length).padStart(4, '0')}`, reimbursementId: BIZ });
        return json({ data: 'ok', status: 1 });
      }
      case 'showInsertRbBusinessDetail.load': {
        const traveller = state.travellers.find(item => item.id === form.get('travellerId'));
        return new Response(detailPage(traveller.subsidyAmount));
      }
      case 'saveRbBusinessDetails.ajax': {
        const rows = JSON.parse(twice(form.get('businessDetails')));
        const list = state.details[form.get('travellerId')] ??= [];
        for (const row of rows) {
          const total = ['trafficExpense', 'subsidyAmount', 'hotelExpense', 'meetingAmount', 'otherAmount'].reduce((sum, key) => sum + Number(row[key] || 0), 0);
          list.push({ ...row, id: `R${list.length}`, totalAmount: total });
        }
        return json({ data: 'ok', status: 1 });
      }
      case 'queryRbBusinessDetail.ajax': {
        const rows = state.details[form.get('travellerId')] ?? [];
        return json({ status: 0, data: { totalFields: { totalAmount: rows.length ? rows.reduce((sum, row) => sum + row.totalAmount, 0) : '' },
          Total: rows.length, Rows: rows } });
      }
      case 'saveRbReimburWriteOff.ajax': state.writeOffs = JSON.parse(twice(form.get('writeOffs'))); return json({ data: 'ok', status: 1 });
      case 'querySettlementKindByReimbursementId.ajax': return json({ status: 0, data: state.kinds });
      case 'showInsertRbReimburSettleKind.load': return new Response(`<label class="checkbox-inline">
        <input type="checkbox" value="${CARD_KIND}" name="settlementKindId">个人银行卡</label>`);
      case 'insertRbReimburSettleKind.ajax':
        state.kinds.push({ isSelectHistory: 0, code: 'tech.rb.settlement.kind.007', name: '个人银行卡', settlementKindId: CARD_KIND, id: KIND_ID, isCash: 0 });
        return json({ data: 'ok', status: 1 });
      case 'queryRbReimbursementSettle.ajax': {
        const rows = state.settles.filter(row => row.kind === form.get('reimburSettleKindId'));
        return json({ status: 0, data: { Total: rows.length, Rows: rows } });
      }
      case 'showInsertRbReimbursementSettle.load': return new Response(`<form class="hg-form" id="reimbursementSettlementForm">
        <input type="hidden" name="id" value=""><input type="hidden" name="reimbursementId" value="${BIZ}">
        <input type="hidden" name="reimburSettleKindId" value="${KIND_ID}"><input type="hidden" name="rbSettlementKindCode" value="tech.rb.settlement.kind.007">
        <input type="text" name="personCode" value=""><input type="text" name="personName" value=""><input type="text" name="payeeCode" value="">
        <input type="text" name="paymentAmount" value=""><input type="hidden" name="__POPUP_SESSION_ID" value="${POPUP}">
        <input type="hidden" name="__CORE_JS_B64" value="${core()}"></form>`);
      case 'queryPersonInfo.ajax': {
        const plain = await decrypt(twice(form.get('encryptedPayload')));
        const known = { 900002: { caNo: '6222000000000001', name: '教师乙' }, 900001: { caNo: '6222000000000002', name: '报销人甲' } };
        return json({ status: 0, data: known[plain.personCode] ?? {} });
      }
      case 'saveRbReimbursementSettle.ajax':
        state.settles.push({ id: `S${state.settles.length}`, paymentAmount: form.get('paymentAmount'), personCode: form.get('personCode'),
          kind: form.get('reimburSettleKindId') });
        return json({ data: String(Number(form.get('paymentAmount'))), status: 1 });
      case 'queryRbReimburBudgetOutlays.ajax': {
        // One detail row per chosen budget item, holding what saveBizData last stored for it.
        const rows = (state.chosen ?? []).map((row, index) => ({ amount: '', attachmentNumber: '', remark: '', version: 166315338 + index,
          ...row, ...state.outlays?.[row.expenditureItemName], fundingItemsId: FUNDING_ID, id: `D${index}`, reimbursementId: BIZ }));
        return json({ status: 0, data: { Total: rows.length, Rows: rows } });
      }
      case 'saveBizData.ajax': {
        // [] keeps the saved detail row, as OA does when the page submits.
        const outlays = JSON.parse(twice(form.get('budgetOutlays')));
        if (outlays.length) state.outlays = Object.fromEntries(outlays.map(row => [row.expenditureItemName, row]));
        const stored = Object.values(state.outlays ?? {});
        const trip = Object.values(state.details).flat().reduce((sum, row) => sum + row.totalAmount, 0);
        return json({ status: form.get('showTips') === 'false' ? 0 : 1, data: { bizData: {
          reverseEntryAmount: state.writeOffs.reduce((sum, row) => sum + Number(row.strikeBalanceAmount), 0),
          businessTripAmount: trip, attachmentNumber: stored.reduce((sum, row) => sum + Number(row.attachmentNumber || 0), 0),
          reimbursementAmount: Math.round(stored.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100,
          settlementAmount: state.settles.reduce((sum, row) => sum + Number(row.paymentAmount), 0) } } });
      }
      // 提交 → 流转确认, as captured on D209900000038.
      case 'checkAdvanceBillInvoice.ajax': return json({ message: 'no', status: 0 });
      case 'showQueryHandlers.ajax': return json({ data: 'true', status: 0 });
      case 'queryHandlers.ajax': return json({ status: 0, data: { hasSelection: false, hasGatewayManual: 'false', procApprovalRuleFullName: '/网上预约报销审批',
        Rows: [['responsiblePerson', '经费负责人', '教师乙', '900002', 10], ['financialContactPerson', '学院财务联络人', '联络人戊', '102001', 50],
          ['financialApprovalPosition', '财务审核岗', '审核员己', '102002', 60]].map(([id, step, name, code, group]) => ({ subProcUnitId: id,
          subProcUnitName: step, handlerName: name, handlerId: `${code}@${'A'.repeat(32)}`, groupId: group, sendMessage: 1, bizId: BIZ,
          bizCode: 'D209900000038' })) } });
      case 'queryAdvance.ajax': state.advanced = (state.advanced ?? 0) + 1; return json({ data: 'ok', status: 1 });
      default: throw new Error(`unexpected ${pathname}`);
    }
  };
  return { calls, state, client: new OaHttpClient(fetchImpl) };
}
const writes = calls => calls.filter(call => /^(save|insert)/.test(call.name)).map(call => call.name);

test('fillTravelFormHttp sends the captured 境内差旅单 chain: funding, travellers, legs, 携程 write-off, payment, save', async () => {
  const { calls, state, client } = oa();
  const steps = [];
  const result = await fillTravelFormHttp(client, FORM, INPUT, { progress: step => steps.push(step) });
  assert.deepEqual(writes(calls), ['saveRbReimburBudgetOutlays.ajax', 'saveRbBusinessTraveller.ajax', 'saveRbBusinessTraveller.ajax',
    'saveRbBusinessDetails.ajax', 'saveRbBusinessDetails.ajax', 'saveRbReimburWriteOff.ajax', 'insertRbReimburSettleKind.ajax',
    'saveRbReimbursementSettle.ajax', 'saveBizData.ajax']);
  assert.deepEqual([...new Set(steps)], ['funding', 'traveller', 'detail', 'writeoff', 'payment', 'save']);
  // Lookups happen before the first write: the student is told apart from a namesake by 学号.
  const firstWrite = calls.findIndex(call => call.name === 'saveRbReimburBudgetOutlays.ajax');
  assert.ok(calls.findIndex(call => call.name === 'queryCtripBorrows.ajax') < firstWrite);
  assert.equal(calls.filter((call, index) => index < firstWrite && call.form?.get('queryName') === 'queryStudent').length, 1);

  const travellers = calls.filter(call => call.name === 'saveRbBusinessTraveller.ajax').map(call => call.form);
  assert.equal(travellers[0].get('travellerTypeId'), STAFF_TYPE);
  assert.equal(travellers[1].get('travellerTypeId'), STUDENT_TYPE);
  assert.equal(travellers[1].get('travellerCode'), '2020000001');
  assert.ok(travellers[0].toString().includes(new URLSearchParams({ traveller: encodeURI(encodeURI('教师乙')) }).toString()),
    'names go through BPM double encodeURI');

  const legs = calls.filter(call => call.name === 'saveRbBusinessDetails.ajax').map(call => JSON.parse(twice(call.form.get('businessDetails'))));
  assert.deepEqual(legs[0], [{ id: '', travellerSubsidyAmount: '180', startDate: '2026-10-19', startAddress: '上海', arriveDate: '2026-10-20',
    arriveAddress: '北京', vehicle: 'aircraft', vehicle_text: '飞机', trafficExpense: '111.00', travelDays: '2', standardSubsidyAmount: '360.00',
    subsidyAmount: '360.00', hotelExpense: '500.00', meetingAmount: '2400.00', otherAmount: '' }]);
  assert.equal(legs[1][0].travelDays, '0');
  assert.equal(legs[1][0].subsidyAmount, '0.00');

  assert.deepEqual(state.writeOffs.map(row => [row.borrowMoneyCode, row.strikeBalanceAmount, row.id]),
    [['1990000000000006', 882, ''], ['1990000000000005', 1383, '']]);
  assert.equal(state.settles[0].paymentAmount, '2106.00');

  const save = calls.find(call => call.name === 'saveBizData.ajax').form;
  assert.deepEqual([...save.keys()].slice(-5), ['remark', 'explain', 'budgetOutlays', 'writeOffs', 'businessDetails']);
  assert.equal(save.has('currencyKind'), false);
  assert.equal(twice(save.get('explain')), '参加会议');
  assert.equal(twice(save.get('businessDetails')), '[]');
  const outlay = JSON.parse(twice(save.get('budgetOutlays')))[0];
  assert.deepEqual([outlay.amount, outlay.attachmentNumber, outlay.remark], ['4371.00', '3', '教师乙北京差旅']);
  assert.deepEqual(result.bizData, { businessTripAmount: 4371, reverseEntryAmount: 2265, reimbursementAmount: 4371,
    settlementAmount: 2106, attachmentNumber: 3 });
  assert.deepEqual(result.payeeNames, ['教师乙']);
  assert.equal(result.managerId, '900002');
});

test('a wrong 学号, an unknown 携程 order or a non-travel form stops before anything is written', async () => {
  for (const [input, form, code] of [
    [{ ...INPUT, travellers: [INPUT.travellers[0], { ...INPUT.travellers[1], code: '2020999999' }] }, FORM, 'person_missing'],
    [{ ...INPUT, ctripOrders: ['1990000000000004'] }, FORM, 'borrow_missing'],
    [INPUT, { ...FORM, context: { ...FORM.context, reimbursementKind: 'applyMoney' } }, 'not_travel'],
  ]) {
    const { calls, client } = oa();
    await assert.rejects(fillTravelFormHttp(client, form, input), error => error.code === code && error.partial === false);
    assert.deepEqual(writes(calls), []);
  }
});

test('差旅天数 are checked for the whole trip, not leg by leg', () => {
  const traveller = INPUT.travellers[0];
  // All days on the first leg, which alone spans one day: fine while the trip (10-19 → 10-21) has 3.
  const spread = [{ ...LEG_OUT, arriveDate: '2026-10-19', travelDays: 3 }, { ...LEG_BACK, startDate: '2026-10-21', arriveDate: '2026-10-21' }];
  assert.doesNotThrow(() => validateTravelInput({ ...INPUT, travellers: [{ ...traveller, legs: spread }] }));
  assert.throws(() => validateTravelInput({ ...INPUT, travellers: [{ ...traveller, legs: [spread[0], { ...spread[1], travelDays: 1 }] }] }),
    error => error.code === 'leg_invalid' && /合计 4 天，行程共 3 天/.test(error.message));
});

test('legs breaking the page rules are refused: days beyond the dates before any request, subsidy above standard before the leg', async () => {
  const { calls, client } = oa();
  const long = { ...INPUT, travellers: [{ ...INPUT.travellers[0], legs: [{ ...LEG_BACK, travelDays: 2 }] }] };
  await assert.rejects(fillTravelFormHttp(client, FORM, long), { code: 'leg_invalid' });
  assert.equal(calls.length, 0);

  const rich = oa();
  const high = { ...INPUT, travellers: [{ ...INPUT.travellers[0], legs: [{ ...LEG_OUT, subsidyAmount: '400' }] }] };
  await assert.rejects(fillTravelFormHttp(rich.client, FORM, high), error => error.code === 'leg_invalid' && error.partial === true);
  assert.equal(writes(rich.calls).includes('saveRbBusinessDetails.ajax'), false);
});

test('a form that already has a traveller or write-off is left untouched', async () => {
  const { calls, client } = oa({ 'queryRbBusinessTravellers.ajax': () => json({ status: 0, data: [{ id: 'X', travellerCode: '1' }] }) });
  await assert.rejects(fillTravelFormHttp(client, FORM, INPUT), { code: 'form_not_blank' });
  assert.deepEqual(writes(calls), []);
});

test('write-offs covering the whole trip add no payment row; more than the trip is refused', async () => {
  const covered = oa({ 'queryCtripBorrows.ajax': () => json({ status: 0, data: { Rows: [borrow('5000000001', 4371)] } }) });
  const result = await fillTravelFormHttp(covered.client, FORM, { ...INPUT, ctripOrders: ['5000000001'] });
  assert.deepEqual(result.payeeNames, []);
  assert.equal(result.bizData.settlementAmount, 0);
  assert.equal(writes(covered.calls).some(name => /Settle/.test(name)), false);

  const over = oa({ 'queryCtripBorrows.ajax': () => json({ status: 0, data: { Rows: [borrow('5000000001', 5000)] } }) });
  await assert.rejects(fillTravelFormHttp(over.client, FORM, { ...INPUT, ctripOrders: ['5000000001'] }), { code: 'writeoff_over' });
  assert.equal(writes(over.calls).includes('saveRbReimburWriteOff.ajax'), false);
});

test('a receipt whose 差旅合计 differs from the legs is a mismatch', async () => {
  const { client } = oa({ 'saveBizData.ajax': () => json({ status: 1, data: { bizData: { reverseEntryAmount: 2265, businessTripAmount: 3371,
    attachmentNumber: 3, reimbursementAmount: 4371, settlementAmount: 2106 } } }) });
  await assert.rejects(fillTravelFormHttp(client, FORM, INPUT), error => error.code === 'save_mismatch' && error.step === 'save');
});

test('helpers read the captured fragments; D-prefixed 差旅单 numbers are kept in the form context', () => {
  assert.deepEqual(selectOptions(TRAVELLER_PAGE, 'travellerTypeId').map(item => item.label), ['教工', '学生', '校外']);
  assert.deepEqual(easySearchRows(person('2020000001', '李同学')), [{ id: '2020000001', code: '2020000001', name: '李同学' }]);
  assert.equal(legRow({ ...LEG_BACK, otherAmount: '12.5' }, 18000, '飞机').otherAmount, '12.50');
  assert.equal(normalizeFormContext({ documentNumber: 'D209900000038' }).documentNumber, 'D209900000038');
  assert.equal(normalizeFormContext({ documentNumber: 'X202610210026' }).documentNumber, '');
});

test('invoices from an OA folder are checked before the first write and linked after the write-off, covering the payment', async () => {
  const { calls, state, client } = oa();
  const withInvoice = { ...INPUT, invoices: [{ fileName: 'hotel.pdf', number: INVOICE, folderId: FOLDER }] };
  await fillTravelFormHttp(client, FORM, withInvoice);
  const names = calls.map(call => call.name);
  assert.ok(names.indexOf('queryBillImageListForClaims4WsNew.ajax') < names.indexOf('saveRbReimburBudgetOutlays.ajax'));
  assert.deepEqual(writes(calls).slice(5, 8), ['saveRbReimburWriteOff.ajax', 'insertRbReimbursementInvoice1.ajax', 'insertRbReimburSettleKind.ajax']);
  assert.equal(state.invoices[0].actualAmount, '2106.00');

  // 2106 元 of payment needs at least as much invoice balance (OA: 实报总额 ≥ 报销总额 − 借款金额).
  const short = oa({ 'queryBillImageListForClaims4WsNew.ajax': () => json({ status: 0, data: { Total: 1,
    Rows: [{ ...FOLDER_ROW, allValoremTax: '300.00', invoiceBalance: '300.00' }] } }) });
  await assert.rejects(fillTravelFormHttp(short.client, FORM, withInvoice), error => error.code === 'invoice_balance' && error.partial === true);
  assert.equal(writes(short.calls).includes('saveRbReimbursementSettle.ajax'), false);
});

const SUBMIT = { fundingCode: INPUT.fundingCode, lines: [{ budgetName: '国内差旅/参会费', amount: 437100, purpose: '教师乙北京差旅' }],
  attachmentCount: 3, reason: INPUT.reason, explain: INPUT.explain, travellerCodes: ['900002', '2020000001'], trip: 437100,
  ctripOrders: INPUT.ctripOrders, reverse: 226500, payees: [{ kind: 'card', code: '900002', amount: 210600 }], invoiceNumbers: [], managerId: '900002' };
const submitted = calls => calls.map(call => call.name).filter(name => ['checkAdvanceBillInvoice.ajax', 'showQueryHandlers.ajax', 'saveBizData.ajax',
  'queryHandlers.ajax', 'queryAdvance.ajax'].includes(name));

test('submitTravelFormHttp re-reads the saved 差旅单, then sends the captured submit chain once', async () => {
  const { calls, state, client } = oa();
  await fillTravelFormHttp(client, FORM, INPUT);
  const before = calls.length;
  const result = await submitTravelFormHttp(client, FORM, SUBMIT);
  const after = calls.slice(before);
  assert.deepEqual(submitted(after), ['checkAdvanceBillInvoice.ajax', 'showQueryHandlers.ajax', 'saveBizData.ajax', 'queryHandlers.ajax',
    'queryAdvance.ajax']);
  assert.equal(state.advanced, 1);
  assert.deepEqual(after.filter(call => call.name === 'queryRbBusinessDetail.ajax').map(call => call.form.get('travellerId')).length, 2,
    'every traveller\'s itinerary is re-read');
  const advance = after.find(call => call.name === 'queryAdvance.ajax').form;
  assert.equal(twice(advance.get('businessDetails')), '[]');
  assert.equal(twice(advance.get('budgetOutlays')), '[]', 'the saved detail row is kept');
  assert.equal(twice(advance.get('explain')), '参加会议');
  assert.equal(JSON.parse(twice(advance.get('procUnitHandlers'))).length, 3);
  assert.deepEqual(result.route.map(item => item.handler), ['教师乙', '联络人戊', '审核员己']);
});

test('a 差旅单 that differs from the run, or whose route is not the fund manager\'s, is never advanced', async () => {
  const cases = [
    [{ ...SUBMIT, trip: 437000, lines: [{ ...SUBMIT.lines[0], amount: 437000 }], payees: [{ ...SUBMIT.payees[0], amount: 210500 }] }, 'form_mismatch', /经费明细/],
    [{ ...SUBMIT, lines: [{ ...SUBMIT.lines[0], purpose: '别的用途' }] }, 'form_mismatch', /经费明细/],
    [{ ...SUBMIT, ctripOrders: [INPUT.ctripOrders[0]], reverse: 88200, payees: [{ ...SUBMIT.payees[0], amount: 348900 }] }, 'form_mismatch', /冲借款/],
    [{ ...SUBMIT, travellerCodes: ['900002'] }, 'form_mismatch', /出差人/],
    [{ ...SUBMIT, payees: [{ ...SUBMIT.payees[0], code: '900001' }] }, 'form_mismatch', /收款人/],
    [{ ...SUBMIT, invoiceNumbers: ['26312000000000000001'] }, 'form_mismatch', /发票/],
    [{ ...SUBMIT, managerId: '900003' }, 'route_unverified', /经费负责人/],
    [{ ...SUBMIT, payees: [{ ...SUBMIT.payees[0], amount: 1 }] }, 'form_mismatch', /./],
  ];
  for (const [expect, code, message] of cases) {
    const { calls, state, client } = oa();
    await fillTravelFormHttp(client, FORM, INPUT);
    await assert.rejects(submitTravelFormHttp(client, FORM, expect), error => error.code === code && message.test(error.message) && !error.sent);
    assert.equal(state.advanced, undefined);
    assert.equal(calls.some(call => call.name === 'queryAdvance.ajax'), false);
  }
});

test('write-offs covering the trip submit without a payment row; an OA refusal is reported and not retried', async () => {
  const covered = oa({ 'queryCtripBorrows.ajax': () => json({ status: 0, data: { Rows: [borrow('5000000001', 4371)] } }) });
  await fillTravelFormHttp(covered.client, FORM, { ...INPUT, ctripOrders: ['5000000001'] });
  await submitTravelFormHttp(covered.client, FORM, { ...SUBMIT, ctripOrders: ['5000000001'], reverse: 437100, payees: [] });
  assert.equal(covered.state.advanced, 1);

  const refused = oa({ 'queryAdvance.ajax': (call, state) => { state.advanced = (state.advanced ?? 0) + 1;
    return json({ isAuth: 0, message: 'Exception while invoking TaskListener: 报销总金额不等于差旅费用金额,请确认。', status: '2' }); } });
  await fillTravelFormHttp(refused.client, FORM, INPUT);
  await assert.rejects(submitTravelFormHttp(refused.client, FORM, SUBMIT),
    error => error.code === 'rejected' && error.sent && /差旅费用金额/.test(error.message));
  assert.equal(refused.state.advanced, 1);
});

test('several 经费明细 lines and payees: one blank line and one blank payee take the rest; OA gets every row', async () => {
  const { calls, state, client } = oa();
  // 4371 trip: 会议费 2000 + 国内差旅 the rest; 2106 payment after 2265 of write-offs: 报销人甲 1000 + 教师乙 the rest.
  const input = { ...INPUT, lines: [{ budgetName: '会议费', amount: '2000', purpose: '会议注册费' }, { budgetName: '国内差旅/参会费', purpose: '交通与住宿' }],
    payees: [{ kind: 'card', code: '900001', amount: '1000' }, { kind: 'card', code: '900002' }] };
  const result = await fillTravelFormHttp(client, FORM, input);
  assert.deepEqual(result.lineAmounts, [200000, 237100]);
  assert.deepEqual(result.payeeAmounts.map(row => [row.payee.code, row.amount]), [['900001', 100000], ['900002', 110600]]);
  assert.deepEqual(result.payeeNames, ['报销人甲', '教师乙']);
  assert.deepEqual(state.chosen.map(row => row.expenditureItemName), ['会议费', '国内差旅/参会费'], 'both budget rows in one funding save');
  assert.equal(writes(calls).filter(name => name === 'saveRbReimburBudgetOutlays.ajax').length, 1);
  assert.equal(writes(calls).filter(name => name === 'saveRbReimbursementSettle.ajax').length, 2);
  assert.equal(writes(calls).filter(name => name === 'insertRbReimburSettleKind.ajax').length, 1, 'the payment kind is added once');
  const save = calls.find(call => call.name === 'saveBizData.ajax').form;
  assert.deepEqual(JSON.parse(twice(save.get('budgetOutlays'))).map(row => [row.expenditureItemName, row.amount, row.attachmentNumber, row.remark]),
    [['会议费', '2000.00', '3', '会议注册费'], ['国内差旅/参会费', '2371.00', '0', '交通与住宿']]);
  assert.equal(result.bizData.reimbursementAmount, 4371);

  await submitTravelFormHttp(client, FORM, { ...SUBMIT,
    lines: [{ budgetName: '会议费', amount: 200000, purpose: '会议注册费' }, { budgetName: '国内差旅/参会费', amount: 237100, purpose: '交通与住宿' }],
    payees: [{ kind: 'card', code: '900001', amount: 100000 }, { kind: 'card', code: '900002', amount: 110600 }] });
  assert.equal(state.advanced, 1);
});

test('lines or payees that cannot add up stop before the main form is saved; a line over its budget too', async () => {
  for (const [change, code] of [
    [{ lines: [{ budgetName: '国内差旅/参会费', amount: '4000', purpose: 'x' }] }, 'lines_invalid'],
    [{ lines: [{ budgetName: '会议费', amount: '4371', purpose: 'x' }] }, 'budget_over'],
    [{ payees: [{ kind: 'card', code: '900002', amount: '2000' }] }, 'payees_invalid'],
    [{ payees: [] }, 'payees_invalid'],
  ]) {
    const { calls, client } = oa();
    await assert.rejects(fillTravelFormHttp(client, FORM, { ...INPUT, ...change }), error => error.code === code && error.partial === true);
    for (const name of ['saveRbReimburWriteOff.ajax', 'saveRbReimbursementSettle.ajax', 'saveBizData.ajax']) {
      assert.equal(writes(calls).includes(name), false, `${code}: ${name}`);
    }
  }
  // Shapes the fill refuses before any request.
  for (const change of [{ lines: [] }, { lines: [{ budgetName: '会议费', purpose: 'x' }, { budgetName: '国内差旅/参会费', purpose: 'y' }] },
    { lines: [{ budgetName: '会议费', amount: '1', purpose: 'x' }, { budgetName: '会议费', amount: '2', purpose: 'y' }] },
    { payees: [{ kind: 'card', code: '900002' }, { kind: 'card', code: '900001' }] },
    { payees: [{ kind: 'bank', code: '某公司' }] }]) {
    const { calls, client } = oa();
    await assert.rejects(fillTravelFormHttp(client, FORM, { ...INPUT, ...change }), { code: 'invalid_input' });
    assert.equal(calls.length, 0, JSON.stringify(change));
  }
});

test('a balance OA does not show (showAmount empty) is sent back empty and not checked against budgetBalance', async () => {
  const hidden = BUDGET_ROWS.map(row => ({ ...row, budgetBalance: '1.00', showAmount: '' }));
  const { calls, client } = oa({ 'queryChooseBudgetOutlays.ajax': () => json({ status: 0, data: { Total: hidden.length,
    requireAmount: '193110.83', showAmount: '', fundingManager: '900002', Rows: hidden } }) });
  const result = await fillTravelFormHttp(client, FORM, INPUT);
  assert.equal(result.bizData.reimbursementAmount, 4371, 'not stopped by the hidden budgetBalance of 1.00');
  const save = calls.find(call => call.name === 'saveRbReimburBudgetOutlays.ajax').form;
  assert.equal(save.get('showAmount'), '', 'showAmount goes back as OA gave it');
  assert.equal(save.get('requireAmount'), '193,110.83');
});

const { matchGolden } = require('./golden.cjs');

test('请求基准 境内差旅单: two travellers, 携程 write-offs, fill and submit send exactly the recorded requests', async () => {
  const { calls, client } = oa();
  await fillTravelFormHttp(client, FORM, INPUT);
  await submitTravelFormHttp(client, FORM, SUBMIT);
  matchGolden('travel-submit', calls);
});

test('请求基准 境内差旅单: several 经费明细 lines and payees', async () => {
  const { calls, client } = oa();
  await fillTravelFormHttp(client, FORM, { ...INPUT, lines: [{ budgetName: '会议费', amount: '2000', purpose: '会议注册费' },
    { budgetName: '国内差旅/参会费', purpose: '交通与住宿' }], payees: [{ kind: 'card', code: '900001', amount: '1000' }, { kind: 'card', code: '900002' }] });
  matchGolden('travel-lines-payees', calls);
});

test('请求基准 境内差旅单: an invoice picked from an OA folder', async () => {
  const { calls, client } = oa();
  await fillTravelFormHttp(client, FORM, { ...INPUT, invoices: [{ fileName: 'hotel.pdf', number: INVOICE, folderId: FOLDER }] });
  matchGolden('travel-folder-invoice', calls);
});
