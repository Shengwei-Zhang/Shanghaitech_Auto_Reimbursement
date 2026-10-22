const test = require('node:test');
const assert = require('node:assert/strict');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const bpm = require('../dist/automation/http-bpm.js');

const BIZ = '0123456789abcdef0123456789abcdef';
const TASK = '11111111-2222-3333-4444-555555555555';
const CSRF = '159BB12842D0416DB2346681665A567F';
const ORIGIN = 'https://sapbpm-new.shanghaitech.edu.cn:9091';
const FORM_HTML = `<input type="hidden" id="csrfTokenElement" value="${CSRF}">
<input type="hidden" id="jobPageBizId" value="${BIZ}"><input type="hidden" id="jobPageId" value="${TASK}">
<input type="hidden" id="jobPageBizCode" value="A209900000013"><input type="hidden" id="mainAccountBook" value="ST00">
<select id="reimbursementKind"><option value="daily">日常</option><option value="travel" selected>差旅</option></select>`;
const FUNDING_HTML = `<table id="easySearchTableListData" dataCount="1" pageCount="1"><tr class="list">
<td><input type="hidden" name="projectid" value="P001"><input type="hidden" name="projectname" value="测试项目">
<input type="hidden" name="projectnameTextView" value="P001-测试项目"></td></tr></table>`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } });
}

function server(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ url, pathname, headers: init.headers, body: init.body ? new URLSearchParams(init.body) : undefined, raw: init.body });
    const override = overrides[pathname];
    if (override) return override(url, init);
    if (pathname === '/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do') {
      return new Response(`<form id="queryMainForm"></form><input id="csrfTokenElement" value="${CSRF}">`, { status: 200 });
    }
    if (pathname === '/bpm-new/rbReimbursementQuery/slicedQueryOwnerReimbursement.ajax') {
      return json({ status: 0, data: { Total: 1, Rows: [{ id: BIZ, billCode: 'A209900000013', status: '0', statusTextView: '预制' }] } });
    }
    if (pathname === '/bpm-new/techCommonFunction/getApplyTaskInfo.ajax') {
      return json({ status: 0, data: { id: TASK, businessKey: BIZ, businessCode: 'A209900000013', statusId: 'ready', taskDefKey: 'Apply' } });
    }
    if (pathname === '/bpm-new/rbReimbursement/showLoadRbReimbursement.job') return new Response(FORM_HTML, { status: 200 });
    if (pathname === '/bpm-new/easySearch.load') return new Response(FUNDING_HTML, { status: 200 });
    if (pathname === '/bpm-new/rbReimburFundingItems/queryChooseBudgetOutlays.ajax') {
      return json({ status: 0, data: { Total: 1, requireAmount: '100.00', Rows: [{ expenditureItemCode: '3020201',
        expenditureItemName: '办公费', projectCode: 'P001', budgetBalance: '100.00', csrfToken: CSRF }] } });
    }
    if (pathname === '/custom/api/v2/casp-tdc/task/search') return json({ errcode: '0', total: 0, pages: 0, datas: [] });
    throw new Error(`unexpected ${url}`);
  };
  return { calls, client: new OaHttpClient(fetchImpl) };
}

test('resolveListTargetHttp maps bill code to bizId/taskId with the page csrfToken', async () => {
  const { calls, client } = server();
  const { target } = await bpm.resolveListTargetHttp(client, 'A209900000013');
  assert.deepEqual(target, { bizId: BIZ, taskId: TASK, isReadOnly: false, expectedDocumentNumber: 'A209900000013' });
  const list = calls.find(call => call.pathname.endsWith('slicedQueryOwnerReimbursement.ajax'));
  assert.equal(list.headers.csrfToken, CSRF);
  assert.equal(list.body.get('billCode'), 'A209900000013');
  assert.equal(calls.find(call => call.pathname.endsWith('getApplyTaskInfo.ajax')).body.get('bizId'), BIZ);
});

test('openFormHttp verifies hidden identity fields and reads form context', async () => {
  const { client } = server();
  const form = await bpm.openFormHttp(client, { bizId: BIZ, taskId: TASK, expectedDocumentNumber: 'A209900000013' });
  assert.equal(form.csrfToken, CSRF);
  assert.equal(form.procTaskId, TASK);
  assert.equal(form.context.accountBook, 'ST00');
  assert.equal(form.context.reimbursementKind, 'travel');
  await assert.rejects(bpm.openFormHttp(client, { bizId: BIZ, taskId: TASK, expectedDocumentNumber: 'A1' }), { code: 'document_mismatch' });
  const other = server({ '/bpm-new/rbReimbursement/showLoadRbReimbursement.job': async () =>
    new Response(FORM_HTML.replace(BIZ, 'f'.repeat(32)), { status: 200 }) });
  await assert.rejects(bpm.openFormHttp(other.client, { bizId: BIZ, taskId: TASK }), { code: 'wrong_target' });
  const bare = server({ '/bpm-new/rbReimbursement/showLoadRbReimbursement.job': async () => new Response('<html></html>', { status: 200 }) });
  await assert.rejects(bpm.openFormHttp(bare.client, { bizId: BIZ, taskId: TASK }), { code: 'form_unavailable' });
});

test('funding and budget queries send the form headers and parse the live shapes', async () => {
  const { calls, client } = server();
  const form = await bpm.openFormHttp(client, { bizId: BIZ, taskId: TASK });
  const funds = await bpm.searchFundingHttp(client, form, { kind: 'responsible' });
  assert.deepEqual(funds.list.items.map(item => item.projectId), ['P001']);
  const fundingCall = calls.find(call => call.pathname === '/bpm-new/easySearch.load');
  assert.equal(fundingCall.headers.procTaskId, TASK);
  assert.equal(fundingCall.headers.csrfToken, CSRF);
  assert.equal(fundingCall.body.get('accountBook'), 'ST00');
  assert.equal(fundingCall.body.get('fundingItemKind'), '0');
  assert.match(fundingCall.headers.referer, /showLoadRbReimbursement\.job/);
  const budget = await bpm.searchBudgetHttp(client, form, { fundingItemsCode: 'P001' });
  assert.equal(budget.query.reimbursementKind, 'travel');
  assert.equal(budget.outlays.rows[0].expenditureItemCode, '3020201');
  assert.ok(!JSON.stringify(budget.response).includes(CSRF), 'echoed token scrubbed');
});

test('funding and budget queries also run directly from the owner-query csrfToken, without a form', async () => {
  const { calls, client } = server();
  const page = await bpm.openOwnerQueryHttp(client);
  const direct = { ...page, context: { accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
  const funds = await bpm.searchFundingHttp(client, direct);
  assert.equal(funds.query.accountBook, 'ST00');
  const budget = await bpm.searchBudgetHttp(client, direct, { fundingItemsCode: 'P001', reimbursementKind: 'travel' });
  assert.equal(budget.query.reimbursementKind, 'travel', 'explicit parameter wins');
  const posted = calls.filter(call => call.pathname.endsWith('.load') || call.pathname.endsWith('.ajax'));
  assert.ok(posted.every(call => call.headers.csrfToken === CSRF && !('procTaskId' in call.headers)));
  assert.ok(!calls.some(call => call.pathname.endsWith('showLoadRbReimbursement.job')), 'no form opened');
  await assert.rejects(bpm.searchFundingHttp(client, { ...page }), { code: 'form_context_missing' });
});

test('HTTP command accepts funds/budgets without form identifiers; browser commands still require them', () => {
  const { parseFundingArgs } = require('../dist/funds.js');
  const { parseBudgetArgs } = require('../dist/budgets.js');
  assert.deepEqual(parseFundingArgs(['--keyword', '冷冻电镜'], true), { help: false, query: {}, keyword: '冷冻电镜' });
  assert.throws(() => parseFundingArgs(['--keyword', '冷冻电镜']), { code: 'invalid_target' });
  const budget = parseBudgetArgs(['--funding-code', 'P001'], true);
  assert.equal(budget.query.fundingItemsCode, 'P001');
  assert.equal(budget.target, undefined);
  assert.equal(budget.documentNumber, undefined);
  assert.throws(() => parseBudgetArgs(['--funding-code', 'P001']), { code: 'invalid_target' });
});

test('BPM API redirects and error pages are not treated as data', async () => {
  const redirect = server({ '/bpm-new/easySearch.load': async () =>
    new Response(null, { status: 302, headers: { location: 'https://ids.shanghaitech.edu.cn/authserver/login?service=x' } }) });
  const form = await bpm.openFormHttp(redirect.client, { bizId: BIZ, taskId: TASK });
  await assert.rejects(bpm.searchFundingHttp(redirect.client, form), { code: 'authentication' });
  assert.ok(!redirect.calls.some(call => call.url.startsWith('https://ids.')), 'redirect not followed');
  const rejected = server({ '/bpm-new/easySearch.load': async () => new Response('<div id="show_error_info">错误的请求!</div>', { status: 200 }) });
  await assert.rejects(bpm.searchFundingHttp(rejected.client, await bpm.openFormHttp(rejected.client, { bizId: BIZ, taskId: TASK })),
    { code: 'server_rejected' });
  const notApply = server({ '/bpm-new/techCommonFunction/getApplyTaskInfo.ajax': async () =>
    json({ status: 0, data: { id: TASK, businessKey: BIZ, statusId: 'ready', taskDefKey: 'Approve' } }) });
  await assert.rejects(bpm.resolveListTargetHttp(notApply.client, 'A209900000013'), { code: 'not_editable' });
  const expired = server({ '/bpm-new/rbReimburFundingItems/queryChooseBudgetOutlays.ajax': async () =>
    json({ isAuth: 1, message: '登录超时，请重新登录!', status: '2' }) });
  const page = { ...await bpm.openOwnerQueryHttp(expired.client), context: { accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
  await assert.rejects(bpm.searchBudgetHttp(expired.client, page, { fundingItemsCode: 'P001' }), { code: 'authentication' });
});

test('searchTodoHttp posts the portal payload as JSON', async () => {
  const { calls, client } = server();
  const result = await bpm.searchTodoHttp(client, { pageSize: 5 });
  assert.equal(result.httpStatus, 200);
  assert.equal(JSON.parse(calls[0].raw).pageSize, 5);
  const login = server({ '/custom/api/v2/casp-tdc/task/search': async () =>
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(bpm.searchTodoHttp(login.client), { code: 'non_json' });
});
