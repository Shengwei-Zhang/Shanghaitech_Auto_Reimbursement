const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const { fillFormHttp, parsePopupCipher, encryptPopupPayload, formFields } = require('../dist/automation/http-fill.js');

const BIZ = '0123456789ABCDEF0123456789ABCDEF';
const TASK = '11111111-2222-3333-4444-555555555555';
const CSRF = '159BB12842D0416DB2346681665A567F';
const FUNDING_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KIND_ID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CARD_KIND = '003B714CBB164B6C8562338A4D1E3237';
const POPUP = 'cccccccc-1111-2222-3333-444444444444';
const SECRET = { password: 'Pw3kLm9QzX1vB7nT', salt: 'Sa1tR4nD0mV4lu3s', iterations: 1000 };
const INVOICE = '26422000000000000001';
const URL_ = `https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job?bizId=${BIZ}&taskId=${TASK}`;
const FORM = { url: URL_, csrfToken: CSRF, procTaskId: TASK, documentNumber: 'A209900000023',
  context: { bizId: BIZ, taskId: TASK, accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
const INPUT = { fundingKind: 'authorized', fundingCode: 'P001', budgetName: '委托服务费', amount: '200', attachmentCount: 1,
  purpose: '大模型API使用费', reason: '大模型 API 费用 & 测试', payeeCode: '2025000001',
  invoices: [{ fileName: '发票.pdf', bytes: Buffer.from('%PDF-1.7 test'), number: INVOICE }] };

const core = (secret = SECRET) => Buffer.from(`return (async function(){ let innerEncrypt = async function(dataObj){ const encoder=new TextEncoder();
 const saltBytes=encoder.encode('${secret.salt}'); const pswBytes=encoder.encode('${secret.password}');
 const aesKey=await crypto.subtle.deriveKey({name:'PBKDF2',salt:saltBytes,iterations:${secret.iterations},hash:'SHA-256'},keyMaterial,{name:'AES-CBC',length:256},false,['encrypt']);
 combined.set(iv,0); return btoa(binary); }; })()`).toString('base64');
const EDITOR = `<input type="hidden" id="jobPageProcInstId" value="900001"><input type="hidden" id="jobPageTaskDefKey" value="Apply">
<form class="hg-form" method="post" action="" id="submitForm">
<input type="hidden" name="id" value="${BIZ}"><input type="text" name="billCode" value="A209900000023" readonly="readonly">
<input type="hidden" name="fillinDate" value="2026-10-15"><input type="hidden" name="hasSchoolLeader" value="false">
<input type="hidden" name="organName" value="上海科技大学&amp;测试"><input type="text" name="emali" value="">
</form><input type="text" name="remark" id="reimbursementRemark">
<input type="radio" name="currencyKind" id="currencyKind0" checked="checked" value="0"><input type="radio" name="currencyKind" value="1">`;
const FUNDING_HTML = `<table id="easySearchTableListData" dataCount="1" pageCount="1"><tr class="list"><td>
<input type="hidden" name="projectid" value="P001"><input type="hidden" name="projectname" value="测试项目">
<input type="hidden" name="departmid" value="D01"><input type="hidden" name="departmname" value="测试组">
<input type="hidden" name="firstid" value="100001"></td></tr></table>`;
const BUDGET_ROWS = [
  { quotaName: '业务费', budgetBalance: '9000', expenditureItemCode: '302', projectCode: 'P001', showAmount: '9000',
    projectName: '测试项目', expenditureItemName: '委托服务费', quotaCode: 'Q1' },
  { quotaName: '劳务费', budgetBalance: '50', expenditureItemCode: '303', projectCode: 'P001', showAmount: '50',
    projectName: '测试项目', expenditureItemName: '助研津贴', quotaCode: 'Q2' },
];
const FOLDER_ROW = { invoiceId: 'INV1', billTypeName: '电子发票', salerName: '某科技公司', allValoremTax: '200.00',
  invoiceNumber: INVOICE, invoiceCode: '', billClaimState: 'UNDOING', invoiceBalance: '200.00', invoiceFilesId: 'F1' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const twice = value => decodeURIComponent(decodeURIComponent(value));

async function decrypt(base64) {
  const bytes = Buffer.from(base64, 'base64'), enc = new TextEncoder();
  const material = await webcrypto.subtle.importKey('raw', enc.encode(SECRET.password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SECRET.salt), iterations: SECRET.iterations, hash: 'SHA-256' },
    material, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
  return JSON.parse(Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv: bytes.subarray(0, 16) }, key, bytes.subarray(16))).toString());
}

/** A stateful stand-in for the BPM editor endpoints, answering with the captured shapes. */
function oa(overrides = {}) {
  const calls = [], state = { invoices: [], kinds: [], settles: [], polls: 0, tabs: [], uploaded: [] };
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    const name = pathname.split('/').pop();
    const form = typeof init.body === 'string' && !init.body.startsWith('{') ? new URLSearchParams(init.body) : undefined;
    const call = { name, url, method: init.method, headers: init.headers, form, raw: init.body };
    calls.push(call);
    if (overrides[name]) { const reply = await overrides[name](call, state); if (reply) return reply; }
    switch (name) {
      case 'showLoadRbReimbursement.job': return new Response(`<div id="reimburFundingItemsTabDiv" class="ui-hide"><div class="ui-tab-links"><ul>${
        state.tabs.map(tab => `<li id="${tab.id}" class="tab-item" data-code="${tab.code}" data-amount="${tab.amount}">${tab.code}</li>`).join('')}</ul></div></div>${EDITOR}`);
      case 'slicedQueryRbReimbursementInvoices.ajax': return json({ status: 0, data: { Total: state.invoices.length, Rows: state.invoices } });
      case 'easySearch.load': return new Response(FUNDING_HTML);
      case 'queryChooseBudgetOutlays.ajax': return json({ status: 0, data: { Total: BUDGET_ROWS.length, requireAmount: '197984.93',
        showAmount: '197984.93', Rows: BUDGET_ROWS } });
      case 'saveRbReimburBudgetOutlays.ajax':
        state.tabs = [...state.tabs.filter(tab => tab.code !== 'P001'), { id: FUNDING_ID, code: 'P001', amount: '' }];
        return json({ data: FUNDING_ID, status: 1 });
      case 'loadInvoiceFolderList1.ajax': return json({ status: 0, data: [{ id: '2038513290682167297', invoiceFolderName: '表单默认票夹' },
        { id: '1879423340632997890', invoiceFolderName: '自行上传票据' }] });
      case 'uploadFillingInvoiceFiles.ajax': {
        // Each file part may name its invoice number; a part without one is the default invoice.
        // Like OA (live 2026-10-21), only the last file of a request is stored.
        const text = Buffer.from(init.body).toString('utf8');
        const numbers = [...text.matchAll(/filename="[^"]*"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/g)]
          .map(part => part[1].match(/(\d{20})/)?.[1] ?? INVOICE).slice(-1);
        state.uploads = (state.uploads ?? 0) + 1;
        state.uploaded.push(...(numbers.length ? numbers : [INVOICE]));
        state.seenUpload = state.polls;
        return json({ status: 0, data: { folderId: '2038513290682167297', message: '',
          invoiceResultList: (numbers.length ? numbers : [INVOICE]).map(number => ({ billEnOut: { invoiceNumber: number, billClaimState: 'UNDOING' }, billImgEnOuts: [{ fileId: 'F1' }] })) } });
      }
      case 'queryBillImageListForClaims4WsNew.ajax': {
        const folderId = new URL(url).searchParams.get('folderId');
        if (folderId !== '2038513290682167297' || new URL(url).searchParams.get('invoiceStatus') !== '未报销') return json({ status: 0, data: { Total: 0, Rows: [] } });
        state.polls++;
        const rows = state.uploaded.length && state.polls > state.seenUpload + 1
          ? state.uploaded.map(number => ({ ...FOLDER_ROW, invoiceNumber: number })) : [];
        return json({ status: 0, data: { Total: rows.length, Rows: rows } });
      }
      case 'insertRbReimbursementInvoice1.ajax': {
        const records = JSON.parse(init.body).insertRecords;
        state.invoices.push(...records);
        return json({ status: 0, data: { insertCount: records.length } });
      }
      case 'querySettlementKindByReimbursementId.ajax': return json({ status: 0, data: state.kinds });
      case 'showInsertRbReimburSettleKind.load': return new Response(`<label class="checkbox-inline">
        <input type="checkbox" value="A8E2528E79B94F06AF6912494A0DEF05" name="settlementKindId">银行汇款</label>
        <label class="checkbox-inline"><input type="checkbox" value="${CARD_KIND}" name="settlementKindId">
        个人银行卡</label>`);
      case 'insertRbReimburSettleKind.ajax':
        state.kinds.push({ isSelectHistory: 0, code: 'tech.rb.settlement.kind.007', name: '个人银行卡', settlementKindId: CARD_KIND, id: KIND_ID, isCash: 0 });
        return json({ data: 'ok', status: 1 });
      case 'queryRbReimbursementSettle.ajax': return json({ status: 0, data: { Total: state.settles.length, Rows: state.settles } });
      case 'showInsertRbReimbursementSettle.load': return new Response(`<form class="hg-form" id="reimbursementSettlementForm">
        <input type="hidden" name="id" value=""><input type="hidden" name="reimbursementId" value="${BIZ}">
        <input type="hidden" name="reimburSettleKindId" value="${KIND_ID}"><input type="hidden" name="rbSettlementKindCode" value="tech.rb.settlement.kind.007">
        <input type="text" name="personCode" value=""><input type="text" name="personName" value=""><input type="text" name="payeeCode" value="">
        <input type="text" name="paymentAmount" value=""><input type="hidden" name="__POPUP_SESSION_ID" value="${POPUP}">
        <input type="hidden" name="__CORE_JS_B64" value="${core()}"></form>`);
      case 'queryPersonInfo.ajax': {
        const plain = await decrypt(twice(form.get('encryptedPayload')));
        call.plain = plain;
        return json(plain.personCode === INPUT.payeeCode ? { status: 0, data: { caNo: '6222000000000001', name: '张三' } } : { status: 0, data: {} });
      }
      case 'saveRbReimbursementSettle.ajax': state.settles.push({ id: 'S1' }); return json({ data: '200', status: 1 });
      case 'queryRbReimburBudgetOutlays.ajax': return json({ status: 0, data: { Total: 1, Rows: [{ amount: '', quotaName: '业务费',
        expenditureItemCode: '302', attachmentNumber: '', remark: '', version: 3, fundingItemsId: FUNDING_ID, id: 'D1',
        expenditureItemName: '委托服务费', reimbursementId: BIZ }] } });
      case 'saveBizData.ajax': state.tabs.forEach(tab => { if (tab.code === 'P001') tab.amount = '200'; });
        return json({ status: 1, data: { bizData: { reverseEntryAmount: 0, attachmentNumber: 1,
        reimbursementAmount: 200, settlementAmount: 200 } } });
      default: throw new Error(`unexpected ${pathname}`);
    }
  };
  return { calls, state, client: new OaHttpClient(fetchImpl), handlers: overrides };
}
const fast = { sleep: async () => undefined };
const writes = calls => calls.filter(call => /^(save|insert|upload)/.test(call.name)).map(call => call.name);

test('fillFormHttp sends the captured request chain and reads back each write', async () => {
  const { calls, client } = oa();
  const steps = [];
  const result = await fillFormHttp(client, FORM, INPUT, { ...fast, progress: step => steps.push(step) });
  assert.deepEqual(steps, ['funding', 'upload', 'upload', 'funding', 'invoice', 'payment', 'save'],
    'funding is located read-only, the invoice uploaded and listed, and only then is funding saved');
  assert.deepEqual(writes(calls), ['uploadFillingInvoiceFiles.ajax', 'saveRbReimburBudgetOutlays.ajax', 'insertRbReimbursementInvoice1.ajax',
    'insertRbReimburSettleKind.ajax', 'saveRbReimbursementSettle.ajax', 'saveBizData.ajax']);
  assert.deepEqual(result, { fundingItemsId: FUNDING_ID, managerId: '100001', payeeName: '张三', bizData: { reimbursementAmount: 200, settlementAmount: 200, attachmentNumber: 1 } });
  for (const call of calls.filter(item => item.url.includes('/bpm-new/') && item.name.endsWith('.ajax'))) assert.equal(call.headers.csrfToken, CSRF);

  const funding = calls.find(call => call.name === 'saveRbReimburBudgetOutlays.ajax').form;
  assert.equal(funding.get('requireAmount'), '197,984.93');
  assert.equal(funding.get('manager'), '100001');
  assert.deepEqual(JSON.parse(twice(funding.get('budgetOutlays'))), [BUDGET_ROWS[0]]);

  const upload = calls.find(call => call.name === 'uploadFillingInvoiceFiles.ajax');
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(new URL(upload.url).searchParams.get('csrfToken'), CSRF);
  const text = Buffer.from(upload.raw).toString('utf8');
  assert.match(text, /name="backurl"\r\n\r\ndoSave\r\n/);
  assert.match(text, /name="folderId"\r\n\r\n2038513290682167297\r\n/);
  assert.match(text, /name="upload"; filename="发票.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF-1.7 test\r\n/);

  const link = JSON.parse(calls.find(call => call.name === 'insertRbReimbursementInvoice1.ajax').raw).insertRecords[0];
  assert.equal(link.invoiceCode, INVOICE);
  assert.equal(link.invoiceNumber, '');
  assert.equal(link.reimbursementId, BIZ);
  assert.equal(link.actualAmount, '200.00');
  assert.equal(link.reimbursementSettleName, '某科技公司');

  assert.equal(calls.find(call => call.name === 'insertRbReimburSettleKind.ajax').form.get('settleKindIds'), CARD_KIND);
  const lookup = calls.find(call => call.name === 'queryPersonInfo.ajax');
  assert.equal(lookup.form.get('popupSessionId'), POPUP);
  assert.deepEqual(Object.keys(lookup.plain), ['id', 'reimbursementId', 'reimburSettleKindId', 'rbSettlementKindCode', 'personCode',
    'personName', 'payeeCode', 'paymentAmount']);
  const settle = calls.find(call => call.name === 'saveRbReimbursementSettle.ajax').form;
  assert.deepEqual([...settle.keys()], ['id', 'reimbursementId', 'reimburSettleKindId', 'rbSettlementKindCode', 'personCode',
    'personName', 'payeeCode', 'paymentAmount', 'isSelectHistory', 'isCash']);
  assert.equal(twice(settle.get('personName')), '张三');
  assert.equal(settle.get('payeeCode'), '6222000000000001');
  assert.equal(settle.get('paymentAmount'), '200.00');

  const save = calls.find(call => call.name === 'saveBizData.ajax').form;
  const value = key => twice(save.get(key));
  assert.equal([...save.keys()].slice(0, 3).join(','), 'id,billCode,fillinDate');
  assert.ok(!save.has('hasSchoolLeader'));
  assert.equal(value('organName'), '上海科技大学&测试');
  assert.equal(value('procInstId'), '900001');
  assert.equal(value('procUnitId'), 'Apply');
  assert.equal(value('taskId'), TASK);
  assert.equal(value('remark'), INPUT.reason);
  assert.equal(value('currencyKind'), '0');
  assert.deepEqual(JSON.parse(value('budgetOutlays')).map(row => [row.id, row.amount, row.attachmentNumber, row.remark, row.version]),
    [['D1', '200.00', '1', '大模型API使用费', 3]]);
});

const OWN_FOLDER = '1879423340632997890';
const PICKED = '26422000000000000007';
const ownFolder = rows => ({ 'queryBillImageListForClaims4WsNew.ajax': async (call, state) => {
  if (new URL(call.url).searchParams.get('folderId') !== OWN_FOLDER) return undefined;
  return json({ status: 0, data: { Total: rows.length, Rows: rows } });
} });

test('an invoice picked from an OA folder is checked read-only first, then linked without upload', async () => {
  const row = { ...FOLDER_ROW, invoiceId: 'INV7', invoiceNumber: PICKED, salerName: '某商贸公司', invoiceDate: '2026-09-08 00:00:00' };
  const input = { ...INPUT, invoices: [{ fileName: '旧发票.pdf', number: PICKED, folderId: OWN_FOLDER }] };
  const { calls, client, state } = oa(ownFolder([row]));
  await fillFormHttp(client, FORM, input, fast);
  assert.deepEqual(writes(calls), ['saveRbReimburBudgetOutlays.ajax', 'insertRbReimbursementInvoice1.ajax', 'insertRbReimburSettleKind.ajax',
    'saveRbReimbursementSettle.ajax', 'saveBizData.ajax']);
  assert.ok(calls.findIndex(call => call.name === 'queryBillImageListForClaims4WsNew.ajax')
    < calls.findIndex(call => call.name === 'saveRbReimburBudgetOutlays.ajax'), 'the folder is read before the first write');
  assert.equal(state.invoices[0].invoiceCode, PICKED);
  assert.equal(state.invoices[0].invoiceId, 'INV7');

  const gone = oa(ownFolder([]));
  await assert.rejects(fillFormHttp(gone.client, FORM, input, fast), { code: 'invoice_missing', partial: false });
  assert.deepEqual(writes(gone.calls), []);
});

test('the 500 元 limits are checked on the OA rows before anything is written to the form', async () => {
  const day = '2026-09-08 00:00:00';
  const picked = { ...FOLDER_ROW, invoiceNumber: PICKED, salerName: '东莞市某电子经营部（个体工商户）', invoiceDate: day, allValoremTax: 300, invoiceBalance: 300 };
  const input = { ...INPUT, amount: '500', invoices: [...INPUT.invoices, { fileName: '旧发票.pdf', number: PICKED, folderId: OWN_FOLDER }] };
  const sameDay = oa({ ...ownFolder([picked]), 'queryBillImageListForClaims4WsNew.ajax': async (call, state) => {
    if (new URL(call.url).searchParams.get('folderId') === OWN_FOLDER) return json({ status: 0, data: { Total: 1, Rows: [picked] } });
    const rows = state.uploaded.map(number => ({ ...FOLDER_ROW, invoiceNumber: number, salerName: '东莞市某电子经营部(个体工商户)', invoiceDate: day }));
    return json({ status: 0, data: { Total: rows.length, Rows: rows } });
  } });
  await assert.rejects(fillFormHttp(sameDay.client, FORM, input, fast), { code: 'invoice_limit', partial: false });
  assert.deepEqual(writes(sameDay.calls), ['uploadFillingInvoiceFiles.ajax'], 'nothing is written to the form');

  const big = oa(ownFolder([{ ...picked, allValoremTax: 500, invoiceBalance: 500 }]));
  await assert.rejects(fillFormHttp(big.client, FORM, { ...input, invoices: [input.invoices[1]] }, fast), error => {
    assert.notEqual(error.code, 'invoice_limit');
    return true;
  });
  assert.ok(writes(big.calls).includes('insertRbReimbursementInvoice1.ajax'), 'a single 500 元 invoice is linked');
});

test('a PDF already stored in a folder is selected there and is not uploaded again', async () => {
  const existing = '26422000000000000008';
  const OWN = '1879423340632997890';
  const row = { ...FOLDER_ROW, invoiceId: 'INV-EXISTING', invoiceNumber: existing, salerName: '已有公司', allValoremTax: '50.00', invoiceBalance: '50.00' };
  const input = { ...INPUT, invoices: [...INPUT.invoices, { fileName: '已上传.pdf', bytes: Buffer.from(`%PDF-1.7 ${existing}`), number: existing }] };
  const { calls, client, state } = oa({ 'queryBillImageListForClaims4WsNew.ajax': async (call, state) => {
    const folderId = new URL(call.url).searchParams.get('folderId');
    if (folderId === OWN) return json({ status: 0, data: { Total: 1, Rows: [row] } });
    if (folderId !== '2038513290682167297') return json({ status: 0, data: { Total: 0, Rows: [] } });
    state.polls++;
    const rows = state.uploaded.length && state.polls > (state.seenUpload ?? 0) + 1
      ? state.uploaded.map(number => ({ ...FOLDER_ROW, invoiceNumber: number })) : [];
    return json({ status: 0, data: { Total: rows.length, Rows: rows } });
  } });
  await fillFormHttp(client, FORM, input, fast);
  const upload = Buffer.from(calls.find(call => call.name === 'uploadFillingInvoiceFiles.ajax').raw).toString('utf8');
  assert.match(upload, /filename="发票.pdf"/);
  assert.doesNotMatch(upload, /已上传\.pdf/);
  assert.deepEqual(state.invoices.map(item => item.invoiceCode), [INVOICE, existing]);
});

test('several invoices are uploaded together, one request each, listed by one folder check, then linked in one request', async () => {
  const second = '26422000000000000002';
  const input = { ...INPUT, invoices: [...INPUT.invoices, { fileName: '发票2.pdf', bytes: Buffer.from(`%PDF-1.7 ${second}`), number: second }] };
  const { calls, client, state } = oa();
  const sleeps = [];
  await fillFormHttp(client, FORM, input, { sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(writes(calls), ['uploadFillingInvoiceFiles.ajax', 'uploadFillingInvoiceFiles.ajax', 'saveRbReimburBudgetOutlays.ajax',
    'insertRbReimbursementInvoice1.ajax', 'insertRbReimburSettleKind.ajax', 'saveRbReimbursementSettle.ajax', 'saveBizData.ajax']);
  const link = JSON.parse(calls.find(call => call.name === 'insertRbReimbursementInvoice1.ajax').raw);
  assert.deepEqual(link.insertRecords.map(row => row.invoiceCode), [INVOICE, second], 'both invoices in one 确定 request');
  const parts = calls.filter(call => call.name === 'uploadFillingInvoiceFiles.ajax').map(call => Buffer.from(call.raw).toString('utf8'));
  assert.deepEqual(parts.map(body => (body.match(/filename="/g) || []).length), [1, 1], 'OA keeps only the last file of a request, so one file each');
  assert.match(parts[0], /filename="发票.pdf"/);
  assert.match(parts[1], /filename="发票2.pdf"/);
  assert.deepEqual(state.invoices.map(row => row.invoiceCode), [INVOICE, second]);
  assert.equal(calls.filter(call => call.name === 'queryBillImageListForClaims4WsNew.ajax').length, 4, 'one folder check before upload, then one shared wait');
  assert.deepEqual(sleeps, [3000]);
  const partly = oa({ 'queryBillImageListForClaims4WsNew.ajax': async () => json({ status: 0, data: { Total: 1, Rows: [FOLDER_ROW] } }) });
  await assert.rejects(fillFormHttp(partly.client, FORM, input, { ...fast, invoiceWaitMs: 0 }), { code: 'invoice_pending', partial: false });
  assert.deepEqual(writes(partly.calls), ['uploadFillingInvoiceFiles.ajax'], 'funding is not saved while an invoice is still missing');
  assert.ok(!partly.calls.some(call => call.name === 'insertRbReimbursementInvoice1.ajax'), 'nothing is linked until every invoice is listed');
  const extra = oa({ 'insertRbReimbursementInvoice1.ajax': async (call, state) => {
    state.invoices.push({ invoiceCode: '26422000000000000099' });
  } });
  await assert.rejects(fillFormHttp(extra.client, FORM, input, fast), { code: 'invoice_rejected', partial: true });
  await assert.rejects(fillFormHttp(oa().client, FORM, { ...input, invoices: [INPUT.invoices[0], INPUT.invoices[0]] }, fast),
    { code: 'invalid_input', partial: false });
});

test('a budget name matching two rows, or a form that already has an invoice, stops before any write', async () => {
  const dup = oa({ 'queryChooseBudgetOutlays.ajax': async () => json({ status: 0, data: { Total: 2, requireAmount: '1', Rows: [
    { ...BUDGET_ROWS[1] }, { ...BUDGET_ROWS[1], quotaCode: 'Q9' }] } }) });
  await assert.rejects(fillFormHttp(dup.client, FORM, { ...INPUT, budgetName: '助研津贴' }, fast), { code: 'budget_missing', partial: false });
  assert.deepEqual(writes(dup.calls), []);
  const used = oa();
  used.state.invoices.push({ invoiceCode: INVOICE });
  await assert.rejects(fillFormHttp(used.client, FORM, INPUT, fast), { code: 'form_not_blank', partial: false });
  assert.deepEqual(writes(used.calls), []);
});

test('a form that already holds another funding item is left untouched', async () => {
  const other = oa();
  other.state.tabs.push({ id: 'OLD', code: 'P999', amount: '' });
  await assert.rejects(fillFormHttp(other.client, FORM, INPUT, fast), { code: 'funding_other', partial: false });
  assert.deepEqual(writes(other.calls), []);
  const same = oa();
  same.state.tabs.push({ id: FUNDING_ID, code: 'P001', amount: '' });
  await assert.rejects(fillFormHttp(same.client, FORM, INPUT, fast), { code: 'funding_other', partial: false });
  const leftover = oa({ 'saveBizData.ajax': async (call, state) => { state.tabs.push({ id: 'OLD', code: 'P999', amount: '' }); } });
  await assert.rejects(fillFormHttp(leftover.client, FORM, INPUT, fast), { code: 'save_mismatch', partial: true });
});

test('an upload OA recognises as already claimed is not linked to the form', async () => {
  const { calls, client } = oa({ 'uploadFillingInvoiceFiles.ajax': async () => json({ status: 0, data: { invoiceResultList: [
    { billEnOut: { invoiceNumber: INVOICE, billClaimState: 'DONE' } }] } }) });
  await assert.rejects(fillFormHttp(client, FORM, INPUT, fast), { code: 'invoice_claimed', partial: false });
  assert.deepEqual(writes(calls), ['uploadFillingInvoiceFiles.ajax'], 'a refused upload stops before anything is written to the form');
  const page = oa({ 'uploadFillingInvoiceFiles.ajax': async () => new Response(`<div class="alert alert-danger">当前票据发票.pdf（发票号码：${INVOICE}）`
    + '已被报销，报销人[900001-测试]，报销单号[A209900000025]</div>') });
  await assert.rejects(fillFormHttp(page.client, FORM, INPUT, fast), error => {
    assert.equal(error.code, 'invoice_claimed');
    assert.equal(error.partial, false);
    assert.match(error.message, new RegExp(`第 1 张发票 ${INVOICE}（发票\\.pdf） 已被报销`));
    assert.match(error.message, /A209900000025/);
    return true;
  });
  // Live 2026-10-20: the bill code sits in brackets between 已被 and 报销使用.
  const live = oa({ 'uploadFillingInvoiceFiles.ajax': async () => new Response(`<h3>出现错误！</h3><p>以下为错误信息：</p><div>票据[${INVOICE}_上海科技大学_20261009204930.pdf]`
    + '已被(报销人[900001-测试]，报销单号[A209900000030])报销使用</div><p>如果还是出错，请联系管理员提出您的问题，将得到满意的回答。</p>', { headers: { 'content-type': 'text/html;charset=utf-8' } }) });
  await assert.rejects(fillFormHttp(live.client, FORM, INPUT, fast), error => {
    assert.equal(error.code, 'invoice_claimed');
    assert.match(error.message, new RegExp(`第 1 张发票 ${INVOICE}（发票\\.pdf） 已被报销（报销单号 A209900000030），请删除这一张后重新提交。`));
    return true;
  });
});

test('a PDF holding several invoices is split into one PDF per invoice; pages without a number are left out', async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const { splitInvoicePdf } = require('../dist/application/job-service.js');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['itinerary only', '26422000000000000001', '26422000000000000002', '26422000000000000002']) {
    doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 12, font });
  }
  const { parts, skipped } = await splitInvoicePdf({ name: 'merge.pdf', base64: Buffer.from(await doc.save()).toString('base64') });
  assert.deepEqual(skipped, [1]);
  assert.deepEqual(parts.map(part => [part.name, part.invoice.number]),
    [['merge-第2页.pdf', '26422000000000000001'], ['merge-第3、4页.pdf', '26422000000000000002']], 'a number on consecutive pages is one invoice');
  for (const part of parts) assert.equal((await PDFDocument.load(Buffer.from(part.base64, 'base64'))).getPageCount(), part.name.includes('、') ? 2 : 1);

  const single = await PDFDocument.create();
  single.addPage([300, 200]).drawText('26422000000000000003', { x: 20, y: 100, size: 12, font: await single.embedFont(StandardFonts.Helvetica) });
  const base64 = Buffer.from(await single.save()).toString('base64');
  const kept = await splitInvoicePdf({ name: 'one.pdf', base64 });
  assert.equal(kept.parts.length, 1);
  assert.equal(kept.parts[0].base64, base64, 'a single invoice keeps its original file');
});

test('an uploaded invoice that never reaches the folder list times out without linking', async () => {
  const { calls, client } = oa({ 'queryBillImageListForClaims4WsNew.ajax': async () => json({ status: 0, data: { Total: 0, Rows: [] } }) });
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    await assert.rejects(fillFormHttp(client, FORM, INPUT, { invoiceWaitMs: 9000, sleep: async ms => { clock += ms; } }),
      { code: 'invoice_pending', step: 'upload', partial: false });
  } finally { Date.now = realNow; }
  assert.equal(calls.filter(call => call.name === 'queryBillImageListForClaims4WsNew.ajax').length, 6);
  assert.ok(!calls.some(call => call.name === 'insertRbReimbursementInvoice1.ajax'));
});

test('an existing payment row or an unfamiliar encryptor stops before the payee is written', async () => {
  const paid = oa();
  paid.state.kinds.push({ code: 'tech.rb.settlement.kind.007', id: KIND_ID, isSelectHistory: 0, isCash: 0 });
  paid.state.settles.push({ id: 'OLD' });
  await assert.rejects(fillFormHttp(paid.client, FORM, INPUT, fast), { code: 'payment_exists' });
  assert.ok(!paid.calls.some(call => call.name === 'insertRbReimburSettleKind.ajax' || call.name === 'saveRbReimbursementSettle.ajax'));

  const changed = oa({ 'showInsertRbReimbursementSettle.load': async () => new Response(`<form id="reimbursementSettlementForm">
    <input type="hidden" name="reimbursementId" value="${BIZ}"><input type="hidden" name="__POPUP_SESSION_ID" value="${POPUP}">
    <input type="hidden" name="__CORE_JS_B64" value="${Buffer.from('eval(atob(x))').toString('base64')}"></form>`) });
  await assert.rejects(fillFormHttp(changed.client, FORM, INPUT, fast), { code: 'encryption_unrecognized', partial: true });
  assert.ok(!changed.calls.some(call => call.name === 'queryPersonInfo.ajax'));
});

test('a save receipt with another amount is reported as a mismatch', async () => {
  const { client } = oa({ 'saveBizData.ajax': async () => json({ status: 1, data: { bizData: { attachmentNumber: 1,
    reimbursementAmount: 20, settlementAmount: 200 } } }) });
  await assert.rejects(fillFormHttp(client, FORM, INPUT, fast), { code: 'save_mismatch', step: 'save', partial: true });
});

test('an expired session envelope maps to authentication and stopping is honoured between steps', async () => {
  const expired = oa({ 'saveRbReimburBudgetOutlays.ajax': async () => json({ isAuth: 1, message: '登录超时，请重新登录!', status: '2' }) });
  await assert.rejects(fillFormHttp(expired.client, FORM, INPUT, fast), { code: 'authentication', step: 'funding' });
  const stopped = oa();
  let steps = 0;
  await assert.rejects(fillFormHttp(stopped.client, FORM, INPUT, { ...fast, progress: () => { steps++; }, stopped: () => steps >= 2 }),
    { code: 'stopped', step: 'upload', partial: false });
  assert.deepEqual(writes(stopped.calls), ['uploadFillingInvoiceFiles.ajax']);
});

test('popup cipher literals are read without running the script, and payloads round-trip', async () => {
  assert.deepEqual(parsePopupCipher(core()), SECRET);
  const payload = await encryptPopupPayload(SECRET, { personCode: 'X' });
  assert.deepEqual(await decrypt(payload), { personCode: 'X' });
  assert.throws(() => parsePopupCipher(core({ ...SECRET, salt: "x'),fetch('" })), { code: 'encryption_unrecognized' });
  assert.deepEqual(formFields('<form id="f"><input name="a" value="1"><input name="b" disabled="disabled" value="2">'
    + '<input type="radio" name="c" value="3"><input type="radio" name="c" checked="checked" value="4"></form><input name="d">', 'f'),
  [['a', '1'], ['c', '4']]);
});

const { submitFormHttp } = require('../dist/automation/http-submit.js');
const HANDLER_ROWS = [
  { subProcUnitId: 'responsiblePerson', subProcUnitName: '经费负责人', handlerName: '李四', handlerId: `100001@${'E'.repeat(32)}`,
    groupId: 1, sendMessage: 1, bizId: BIZ, bizCode: 'A209900000023' },
  { subProcUnitId: 'financeAudit', subProcUnitName: '财务审核岗', handlerName: '王五', handlerId: `100999@${'F'.repeat(32)}`,
    groupId: 2, sendMessage: 0, bizId: BIZ, bizCode: 'A209900000023' }];
const EXPECT = { fundingCode: 'P001', budgetName: '委托服务费', amount: '200', attachmentCount: 1, payeeCode: INPUT.payeeCode,
  invoiceNumbers: [INVOICE], reason: INPUT.reason, managerId: '100001' };

/** The fill mock plus the readback shapes of a saved form and the captured submit replies. */
function saved(overrides = {}) {
  return oa({
    'saveRbReimbursementSettle.ajax': async (call, state) => {
      state.settles.push({ id: 'S1', personCode: call.form.get('personCode'), paymentAmount: call.form.get('paymentAmount') });
      return json({ data: '200', status: 1 });
    },
    'queryRbReimburBudgetOutlays.ajax': async (call, state) => state.tabs[0]?.amount ? json({ status: 0, data: { Total: 1, Rows: [{
      id: 'D1', amount: '200.00', attachmentNumber: '1', expenditureItemName: '委托服务费', fundingItemsId: FUNDING_ID }] } }) : undefined,
    'checkAdvanceBillInvoice.ajax': async () => json({ message: 'no', status: 0 }),
    'showQueryHandlers.ajax': async () => json({ data: 'true', status: 0 }),
    'queryHandlers.ajax': async () => json({ status: 0, data: { procApprovalRuleFullName: '/网上预约报销审批', hasSelection: false,
      hasGatewayManual: false, Rows: HANDLER_ROWS } }),
    'queryAdvance.ajax': async () => new Response(''),
    ...overrides,
  });
}
const submitCalls = calls => calls.slice(calls.findIndex(call => call.name === 'checkAdvanceBillInvoice.ajax')).map(call => call.name);

test('submitFormHttp re-reads the saved form, then sends the captured submit chain once', async () => {
  const { calls, client } = saved();
  await fillFormHttp(client, FORM, INPUT, fast);
  const steps = [];
  let validated;
  const result = await submitFormHttp(client, FORM, EXPECT, { progress: step => steps.push(step), validated: summary => { validated = summary; } });
  assert.deepEqual(steps, ['verify', 'route', 'advance']);
  assert.deepEqual(validated, { documentNumber: 'A209900000023', amount: '200.00' });
  assert.deepEqual(result.route.map(item => item.handler), ['李四', '王五']);
  assert.deepEqual(submitCalls(calls), ['checkAdvanceBillInvoice.ajax', 'showQueryHandlers.ajax', 'saveBizData.ajax',
    'queryHandlers.ajax', 'queryAdvance.ajax']);
  const save = calls.filter(call => call.name === 'saveBizData.ajax').pop().form;
  assert.equal(save.get('showTips'), 'false');
  assert.equal(twice(save.get('budgetOutlays')), '[]', 'submit keeps the saved detail rows');
  const advance = calls.find(call => call.name === 'queryAdvance.ajax').form;
  assert.equal(advance.get('hasGatewayManual'), 'false');
  assert.equal(twice(advance.get('remark')), INPUT.reason);
  const handlers = JSON.parse(twice(advance.get('procUnitHandlers')));
  assert.deepEqual(handlers.map(row => [row.handlerName, row.canMerge, row.merged, row.__id]), [['李四', '0', '0', 'r1001'], ['王五', '0', '0', 'r1002']]);
  for (const call of calls.slice(-5)) assert.equal(call.headers.csrfToken, CSRF);
});

test('a route whose 经费负责人 is not the fund manager, or a form that differs, is never advanced', async () => {
  const wrong = saved();
  await fillFormHttp(wrong.client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(wrong.client, FORM, { ...EXPECT, managerId: '100002' }),
    error => error.code === 'route_unverified' && !error.sent && error.message.includes('经费负责人'));
  assert.ok(!wrong.calls.some(call => call.name === 'queryAdvance.ajax'));

  const other = saved();
  await fillFormHttp(other.client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(other.client, FORM, { ...EXPECT, payeeCode: '2025000002' }), { code: 'form_mismatch', sent: false });
  await assert.rejects(submitFormHttp(other.client, FORM, { ...EXPECT, invoiceNumbers: [INVOICE, '26422000000000000009'] }), { code: 'form_mismatch' });
  await assert.rejects(submitFormHttp(other.client, FORM, { ...EXPECT, payeeKind: 'bank', supplierCode: '1000014428' }),
    { code: 'form_mismatch', sent: false }, 'a 个人银行卡 row does not pass as the expected 银行汇款');
  assert.ok(!other.calls.some(call => call.name === 'checkAdvanceBillInvoice.ajax'), 'readback stops before the submit chain');

  const claimed = saved({ 'checkAdvanceBillInvoice.ajax': async () => json({ message: 'yes', status: 0 }) });
  await fillFormHttp(claimed.client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(claimed.client, FORM, EXPECT), { code: 'advance_invoice', sent: false });
  assert.ok(!claimed.calls.some(call => call.name === 'saveBizData.ajax' && call.form.has('showTips')));
});

test('an OA rejection of queryAdvance is reported with its message and never retried', async () => {
  const { calls, client } = saved({ 'queryAdvance.ajax': async () => json({ isAuth: 0, status: '2', message: '报销金额为空' }) });
  await fillFormHttp(client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(client, FORM, EXPECT),
    error => error.code === 'rejected' && error.sent && error.message.includes('报销金额为空'));
  assert.equal(calls.filter(call => call.name === 'queryAdvance.ajax').length, 1);
  const lost = saved({ 'queryAdvance.ajax': async () => { throw new TypeError('socket hang up'); } });
  await fillFormHttp(lost.client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(lost.client, FORM, EXPECT), { code: 'unknown', sent: true });
  assert.equal(lost.calls.filter(call => call.name === 'queryAdvance.ajax').length, 1);
  const ok = saved({ 'queryAdvance.ajax': async () => json({ data: 'ok', status: 1 }) });
  await fillFormHttp(ok.client, FORM, INPUT, fast);
  assert.equal((await submitFormHttp(ok.client, FORM, EXPECT)).route.length, 2, 'the live success reply is accepted');
  const odd = saved({ 'queryAdvance.ajax': async () => json({ status: 0, data: { ok: true } }) });
  await fillFormHttp(odd.client, FORM, INPUT, fast);
  await assert.rejects(submitFormHttp(odd.client, FORM, EXPECT),
    error => error.code === 'unknown' && error.sent && error.response === 'queryAdvance 响应：{"status":0,"data":{"ok":true}}');
});

test('uploads go out together like the OA page; a refused one stops before the form is written and is named', async () => {
  const numbers = ['26422000000000000011', '26422000000000000012', '26422000000000000013'];
  const input = { ...INPUT, amount: '200', invoices: numbers.map((number, index) => ({ fileName: `发票${index + 1}.pdf`, bytes: Buffer.from(`%PDF-1.7 ${number}`), number })) };
  let inFlight = 0, most = 0;
  const slow = refuse => async call => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--;
    if (refuse && Buffer.from(call.raw).toString('utf8').includes(refuse)) {
      return new Response(`<div>票据[${refuse}_x.pdf]已被(报销人[900001-测试]，报销单号[A209900000033])报销使用</div>`);
    }
  };
  const together = oa({ 'uploadFillingInvoiceFiles.ajax': slow() });
  await fillFormHttp(together.client, FORM, input, fast).catch(error => assert.notEqual(error.step, 'upload'));
  assert.equal(most, 3, 'all three uploads were in flight at once');

  most = 0;
  const refused = oa({ 'uploadFillingInvoiceFiles.ajax': slow(numbers[1]) });
  await assert.rejects(fillFormHttp(refused.client, FORM, input, fast), error => {
    assert.equal(error.code, 'invoice_claimed');
    assert.equal(error.partial, false);
    assert.match(error.message, /第 2 张发票 26422000000000000012（发票2\.pdf） 已被报销（报销单号 A209900000033）/);
    return true;
  });
  assert.deepEqual(writes(refused.calls).filter(name => name !== 'uploadFillingInvoiceFiles.ajax'), [], 'nothing written to the form');
});

// 银行汇款, as captured live 2026-10-21: the payee is an OA supplier, its account comes from the register.
const BANK_KIND = 'A8E2528E79B94F06AF6912494A0DEF05', BANK_KIND_ID = 'B'.repeat(32);
const SUPPLIER = { supplierName: '上海上勤餐饮管理有限公司', openingBankName: '上海银行市政大厦支行', isMainData: 1, code: '1000014428',
  openingBankAddress: '', payeeCode: '31663803001390901', supplierCode: '1000014428', statusTextView: '启用', payee: '上海上勤餐饮管理有限公司',
  name: '上海上勤餐饮管理有限公司', id: 'AF8D6701CD61B50EE053122A0F0AE7F2', isMainDataTextView: '是', ownedBank: '上海银行', status: 1 };
const bankOa = (suppliers = [SUPPLIER]) => oa({
  'showInsertRbReimburSettleKind.load': async () => undefined,
  'insertRbReimburSettleKind.ajax': async (call, state) => {
    if (call.form.get('settleKindIds') !== BANK_KIND) return undefined;
    state.kinds.push({ isSelectHistory: 1, code: 'tech.rb.settlement.kind.006', name: '银行汇款', settlementKindId: BANK_KIND, id: BANK_KIND_ID, isCash: 0 });
    return json({ data: 'ok', status: 1 });
  },
  'slicedQueryMmSupplier.ajax': async call => { call.suppliers = true; return json({ status: 0, data: { Total: suppliers.length, page: 1, Rows: suppliers } }); },
  'showInsertRbReimbursementSettle.load': async call => {
    const row = Object.fromEntries(call.form);
    return new Response(`<form class="hg-form" id="reimbursementSettlementForm"><select name="pageCostUndertakerKind"><option value=""></option></select>
      <input type="hidden" name="id" value="${row.id ?? ''}"><input type="hidden" name="reimbursementId" value="${row.reimbursementId}">
      <input type="hidden" name="supplierCode" value="${row.supplierCode}"><input type="hidden" name="supplierName" value="${row.supplierName}">
      <input type="hidden" name="reimburSettleKindId" value="${row.reimburSettleKindId}"><input type="hidden" name="transferPointId" value="">
      <input type="hidden" name="rbSettlementKindCode" value="tech.rb.settlement.kind.006">
      <input type="1" name="payee" value="${row.payee}"><input type="1" name="payeeCode" value="${row.payeeCode}">
      <input type="1" name="ownedBank" value="${row.ownedBank}"><input type="1" name="openingBankName" value="${row.openingBankName}">
      <input type="1" name="purpose" value=""><input type="2" name="paymentAmount" value=""></form>`);
  },
});
const BANK_INPUT = { ...INPUT, payeeKind: 'bank', payeeCode: '上海上勤餐饮管理有限公司', supplierCode: '1000014428', remitPurpose: '会议餐费' };

test('银行汇款 pays the chosen OA supplier: its account comes from the register, the 汇款用途 from the claim', async () => {
  const run = bankOa();
  const done = await fillFormHttp(run.client, FORM, BANK_INPUT, fast);
  assert.equal(done.payeeName, '上海上勤餐饮管理有限公司');
  assert.ok(!run.calls.some(call => call.name === 'queryPersonInfo.ajax'), 'no 学工号 lookup for a bank transfer');
  assert.equal(run.calls.find(call => call.name === 'insertRbReimburSettleKind.ajax').form.get('settleKindIds'), BANK_KIND, '银行汇款 is added');
  const search = run.calls.find(call => call.name === 'slicedQueryMmSupplier.ajax').form;
  assert.deepEqual([search.get('supplierKind'), search.get('isBank'), search.get('status'), twice(search.get('keyValue'))], ['1', '1', '1', '上海上勤餐饮管理有限公司']);
  const opened = run.calls.find(call => call.name === 'showInsertRbReimbursementSettle.load').form;
  assert.equal(opened.get('supplierCode'), '1000014428', 'the supplier row is posted back to open the payment form');
  assert.equal(opened.get('id'), '', 'the supplier\'s own id is blanked, as the page does: OA would prefill it as the payment row id');
  assert.equal(opened.get('reimburSettleKindId'), BANK_KIND_ID);
  const saved = run.calls.find(call => call.name === 'saveRbReimbursementSettle.ajax').form;
  assert.deepEqual(Object.fromEntries([...saved].map(([key, value]) => [key, twice(value)])), {
    id: '', reimbursementId: BIZ, supplierCode: '1000014428', supplierName: '上海上勤餐饮管理有限公司', reimburSettleKindId: BANK_KIND_ID,
    transferPointId: '', rbSettlementKindCode: 'tech.rb.settlement.kind.006', payee: '上海上勤餐饮管理有限公司', payeeCode: '31663803001390901',
    ownedBank: '上海银行', openingBankName: '上海银行市政大厦支行', purpose: '会议餐费', paymentAmount: '200.00', isSelectHistory: '1', isCash: '0',
  }, 'the captured field order and values');
});

test('银行汇款 stops without a payment row when the supplier is missing, ambiguous, renamed or has no account', async () => {
  for (const suppliers of [[], [SUPPLIER, { ...SUPPLIER, id: 'X' }], [{ ...SUPPLIER, supplierName: '上海上勤', payee: '上海上勤', name: '上海上勤' }],
    [{ ...SUPPLIER, payeeCode: '' }], [{ ...SUPPLIER, supplierCode: '1000099999', code: '1000099999' }]]) {
    const run = bankOa(suppliers);
    await assert.rejects(fillFormHttp(run.client, FORM, BANK_INPUT, fast), { code: 'payee_missing', step: 'payment' });
    assert.ok(!run.calls.some(call => call.name === 'saveRbReimbursementSettle.ajax'));
  }
  await assert.rejects(fillFormHttp(bankOa().client, FORM, { ...BANK_INPUT, remitPurpose: ' ' }, fast), { code: 'invalid_input', partial: false });
  await assert.rejects(fillFormHttp(bankOa().client, FORM, { ...BANK_INPUT, supplierCode: undefined }, fast), { code: 'invalid_input', partial: false });
});

test('the submit readback accepts the 银行汇款 row of the expected supplier only', async () => {
  const bankSaved = overrides => {
    const run = bankOa();
    const base = saved({
      ...['showInsertRbReimburSettleKind.load', 'insertRbReimburSettleKind.ajax', 'slicedQueryMmSupplier.ajax', 'showInsertRbReimbursementSettle.load']
        .reduce((all, name) => ({ ...all, [name]: (call, state) => run.handlers[name](call, state) }), {}),
      'saveRbReimbursementSettle.ajax': async (call, state) => {
        state.settles.push({ id: 'S2', supplierCode: call.form.get('supplierCode'), paymentAmount: call.form.get('paymentAmount') });
        return json({ data: '200', status: 1 });
      },
      ...overrides,
    });
    return base;
  };
  const good = bankSaved();
  await fillFormHttp(good.client, FORM, BANK_INPUT, fast);
  await assert.rejects(submitFormHttp(good.client, FORM, { ...EXPECT, payeeKind: 'bank', supplierCode: '1000099999' }), { code: 'form_mismatch', sent: false });
  const result = await submitFormHttp(good.client, FORM, { ...EXPECT, payeeKind: 'bank', supplierCode: '1000014428' });
  assert.ok(result, 'the matching supplier row is submitted');
});

const { matchGolden } = require('./golden.cjs');

test('请求基准 用款申请单: 个人银行卡, upload, fill and submit send exactly the recorded requests', async () => {
  const { calls, client } = saved();
  await fillFormHttp(client, FORM, INPUT, fast);
  await submitFormHttp(client, FORM, EXPECT);
  matchGolden('apply-money-card-submit', calls);
});

test('请求基准 用款申请单: 银行汇款 to an OA supplier', async () => {
  const run = bankOa();
  await fillFormHttp(run.client, FORM, BANK_INPUT, fast);
  matchGolden('apply-money-bank', run.calls);
});

test('请求基准 用款申请单: an invoice picked from an OA folder', async () => {
  const row = { ...FOLDER_ROW, invoiceId: 'INV7', invoiceNumber: PICKED, salerName: '某商贸公司', invoiceDate: '2026-09-08 00:00:00' };
  const { calls, client } = oa(ownFolder([row]));
  await fillFormHttp(client, FORM, { ...INPUT, invoices: [{ fileName: '旧发票.pdf', number: PICKED, folderId: OWN_FOLDER }] }, fast);
  matchGolden('apply-money-folder-invoice', calls);
});
