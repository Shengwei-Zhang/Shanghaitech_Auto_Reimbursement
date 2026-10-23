const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const bpm = require('../dist/automation/http-bpm.js');
const { createApp } = require('../dist/server/app');
const { OaApi } = require('../dist/server/oa-api');

const BIZ = '0123456789abcdef0123456789abcdef', NEW_BIZ = 'fedcba9876543210fedcba9876543210';
const TASK = '11111111-2222-3333-4444-555555555555', NEW_TASK = '99999999-8888-7777-6666-555555555555';
const CSRF = '159BB12842D0416DB2346681665A567F';
const CLAIMED = '26117000000000000011', CLAIMING = '26117000000000000012';
const WHOLE = '26117000000000000041', PART = '26117000000000000042', SAME_DAY = '26117000000000000043';
/** 未报销 rows of 自行上传票据: a whole invoice, one partly claimed by a 差旅单, and one more from the same seller and day. */
const FOLDER_ROWS = [
  { invoiceNumber: WHOLE, salerName: '某商贸公司', invoiceDate: '2026-09-08 00:00:00', allValoremTax: 300, invoiceBalance: 300,
    billClaimState: 'UNDOING', invoiceFilesName: 'whole.pdf', billCheckStateTextView: '查验通过' },
  { invoiceNumber: PART, salerName: '某酒店', invoiceDate: '2026-08-18 00:00:00', allValoremTax: 960, invoiceBalance: 60,
    billClaimState: 'UNDOING', electronicInvoice: { billEnOut: { billCodeList: 'D209900000037', totalActualAmount: 900 } } },
  { invoiceNumber: SAME_DAY, salerName: '某商贸公司', invoiceDate: '2026-09-08 00:00:00', allValoremTax: 200, invoiceBalance: 200, billClaimState: 'UNDOING' },
  { invoiceNumber: '', allValoremTax: 0, invoiceBalance: 0 },
];
const ENTRY_HTML = `<input type="hidden" id="csrfTokenElement" value="${CSRF}"/>
<select name="accountBook" id="accountBook" class="select"><option value="ST00">上海科技大学</option></select>
<button type="button" class="btn btn-info insert" data-kind="applyMoney" title="用款申请单">创建</button>
<button type="button" class="btn btn-info insert" data-kind="domesticTravel" title="境内差旅单">创建</button>`;
const form = (biz, task, code) => `<input type="hidden" id="csrfTokenElement" value="${CSRF}">
<input type="hidden" id="jobPageBizId" value="${biz}"><input type="hidden" id="jobPageId" value="${task}">
<input type="hidden" id="jobPageBizCode" value="${code}"><input type="hidden" id="mainAccountBook" value="ST00">
<input type="hidden" id="reimbursementKind" value="applyMoney">`;
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const { DRAFT_CONTENT_FIELDS, isBlankDraft } = require('../dist/automation/reimbursement-list.js');
const blankContent = () => Object.fromEntries(DRAFT_CONTENT_FIELDS.map(field => [field, '']));

/** The easy page's form loading: the quick list, then one check per form; returns the blank ones. */
async function listForms(call) {
  const { data } = await call('GET', '/api/oa/forms');
  const blank = [];
  for (const form of data.forms) {
    const checked = await call('GET', `/api/oa/forms/check?documentNumber=${form.documentNumber}`);
    if (checked.data.blank) blank.push(form.documentNumber);
  }
  return blank;
}

test('a draft is blank only when every content column is present and empty', () => {
  assert.equal(isBlankDraft(blankContent()), true);
  assert.equal(isBlankDraft({ ...blankContent(), attachmentNumber: null }), true);
  for (const [field, value] of [['remark', '用途'], ['reimbursementAmount', 0], ['attachmentNumber', 3], ['allProjectName', 'P-1']]) {
    assert.equal(isBlankDraft({ ...blankContent(), [field]: value }), false, field);
  }
  const { remark, ...missing } = blankContent();
  assert.equal(isBlankDraft(missing), false, 'a missing column is not proof of emptiness');
});

function fakeOa({ createResponse } = {}) {
  const calls = [];
  const linkedInvoices = [];
  const ownerRows = [
    { ...blankContent(), id: BIZ, billCode: 'A209900000010', status: 0, reimbursementKind: 'applyMoney', statusTextView: '预制', fillinDate: '2026-09-24' },
    { ...blankContent(), id: 'd'.repeat(32), billCode: 'A209900000009', status: 0, reimbursementKind: 'applyMoney', statusTextView: '预制',
      remark: '已填写', reimbursementAmount: 4820, attachmentNumber: 3 },
    { id: 'a'.repeat(32), billCode: 'A209900000013', status: '1', statusTextView: '提交' },
    { id: 'e'.repeat(32), billCode: 'A209900000011', status: '5', statusTextView: '已完成', reimbursementAmount: 345, remark: '已报销', fillinDate: '2026-10-01 09:00:00' },
    { id: 'c'.repeat(32), billCode: 'D209900000036', status: 1, statusTextView: '提交', reimbursementKind: 'domesticTravel',
      reimbursementKindTextView: '境内差旅单', reimbursementAmount: 1200, remark: '出差', fillinDate: '2026-09-04 10:00:00' }];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? new URLSearchParams(init.body) : undefined;
    calls.push({ pathname, query: searchParams, body, headers: init.headers, raw: init.body });
    if (pathname.endsWith('forwardRbReimbursementOwnerQuery.do')) return new Response(`<input id="csrfTokenElement" value="${CSRF}">`);
    if (pathname.endsWith('slicedQueryOwnerReimbursement.ajax')) {
      const kinds = (body.get('queryStatusKind') || '').split(',').filter(Boolean);
      const rows = ownerRows.filter(row => (!body.get('billCode') || row.billCode === body.get('billCode'))
        && (!kinds.length || kinds.includes(String(row.status))));
      return json({ status: 0, data: { Total: rows.length, Rows: rows } });
    }
    if (pathname.endsWith('getApplyTaskInfo.ajax')) {
      return json({ status: 0, data: { id: TASK, businessKey: BIZ, businessCode: 'A209900000010', statusId: 'ready', taskDefKey: 'Apply' } });
    }
    if (pathname.endsWith('showLoadRbReimbursement.job')) {
      return new Response(searchParams.get('bizId') === NEW_BIZ ? form(NEW_BIZ, NEW_TASK, 'A209900000023') : form(BIZ, TASK, 'A209900000010'));
    }
    if (pathname === '/custom/api/v2/casp-tdc/task/search') {
      const link = (biz, task) => `https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job?isReadOnly=false&bizId=${biz}&taskId=${task}`;
      return json({ errcode: '0', total: 4, pages: 1, datas: [
        { subject: '测试[用款申请单-A209900000010](2026-09-24)', nodeName: '网上预约报销申请单', pcViewUrl: link(BIZ, TASK) },
        { subject: '测试[用款申请单-A209900000001](2023-02-20)', nodeName: null, pcViewUrl: link('b'.repeat(32), TASK) },
        { subject: '通知任务:网上报销申请单【A209900000007】收到了新的办理通知', nodeName: '通知任务:网上预约报销单', pcViewUrl: link('c'.repeat(32), TASK) },
        { subject: '测试[用款申请单-A209900000009](2026-09-24)', nodeName: '网上预约报销申请单', pcViewUrl: link('d'.repeat(32), TASK) }] });
    }
    if (pathname.endsWith('forwardAddRbReimbursement.do')) return new Response(ENTRY_HTML);
    if (pathname.endsWith('createReimbursement.ajax')) return createResponse ? createResponse() : json({ status: 0, data: { bizId: NEW_BIZ, taskId: NEW_TASK } });
    if (pathname.endsWith('easySearch.load') && ['techOrgSearch', 'queryStudent'].includes(body.get('queryName'))) {
      const person = (code, name, dept) => `<tr class='list'><input type='hidden' name='id' value='${code}' /><td>${code}</td>
        <input type='hidden' flag='1' name='code' value='${code}' /><input type='hidden' flag='1' name='name' value='${name}' />
        ${dept ? `<input type='hidden' flag='1' name='deptName' value='${dept}' />` : ''}</tr>`;
      const rows = body.get('queryName') === 'queryStudent' && decodeURI(body.get('paramValue')) === '李同学'
        ? person('2020000001', '李同学') + person('2024000002', '李同学') + person('2024000002', '李同学')
        : body.get('queryName') === 'techOrgSearch' && decodeURI(body.get('paramValue')) === '教师乙' ? person('900002', '教师乙', '教师乙组') : '';
      return new Response(`<table id="easySearchTableListData" class="" dataCount='1' pageCount='1'>${rows}</table>`);
    }
    if (pathname.endsWith('easySearch.load')) {
      return new Response(`<table id="easySearchTableListData" dataCount="1" pageCount="1"><tr><td>
        <input type="hidden" name="projectid" value="P001"><input type="hidden" name="projectname" value="测试项目">
        <input type="hidden" name="projectnameTextView" value="P001-测试项目"><input type="hidden" name="departmname" value="信息学院"></td></tr></table>`);
    }
    if (pathname.endsWith('loadInvoiceFolderList1.ajax')) {
      return json({ status: 0, data: [{ id: '1879423340632997890', invoiceFolderName: '自行上传票据' },
        { id: '2038513290682167297', invoiceFolderName: '表单默认票夹' }] });
    }
    if (pathname.endsWith('slicedQueryRbReimbursementInvoices.ajax')) {
      const rows = linkedInvoices;
      return json({ status: 0, data: { Total: rows.length, Rows: rows } });
    }
    if (pathname.endsWith('queryBillImageListForClaims4WsNew.ajax')) {
      const own = searchParams.get('folderId') === '1879423340632997890';
      const rows = { 未报销: own ? FOLDER_ROWS : [], 报销中: [{ invoiceNumber: CLAIMING }], 已报销: [{ invoiceNumber: CLAIMED }] }[searchParams.get('invoiceStatus')];
      return json({ status: 0, data: { Total: rows.length, Rows: rows } });
    }
    if (pathname.endsWith('slicedQueryMmSupplier.ajax')) {
      const rows = [
        { supplierName: '上海上勤餐饮管理有限公司', payee: '上海上勤餐饮管理有限公司', openingBankName: '上海银行市政大厦支行', ownedBank: '上海银行',
          payeeCode: '31663803001390901', supplierCode: '1000014428', code: '1000014428', isMainData: 1, status: 1 },
        { supplierName: '上海上勤餐饮管理有限公司', payee: '上海上勤餐饮管理有限公司', openingBankName: '', ownedBank: '', payeeCode: '',
          supplierCode: '1000014429', code: '1000014429', isMainData: 0, status: 1 },
        { supplierName: '上海上勤餐饮', payee: '上海上勤餐饮', openingBankName: '工商银行', payeeCode: '1001700809300218071', supplierCode: '1000000001', code: '1000000001', isMainData: 1, status: 1 }];
      return json({ status: 0, data: { Total: rows.length, page: 1, Rows: rows } });
    }
    if (pathname.endsWith('testReimbursementPrintPermission.ajax')) return json({ data: { success: body.get('bizId') === 'a'.repeat(32) }, status: 0 });
    if (pathname.endsWith('checkReimbursementPrintStatus.ajax')) return json({ data: 'ok', status: 1 });
    if (pathname.endsWith('queryWatermarkPathByBizIdOrTaskId.ajax')) return json({ data: 'images/20190826094407.png', status: 0 });
    if (pathname.endsWith('printRbReimbursement.load')) {
      return new Response(`<html><head><style>.page-break{page-break-before:always}</style><script>window.print()</script></head><body><div class="container-fluid">`
        + `<div class="hg-form"><div class="page-break"><div class="page-image"><img src="data:image/jpeg;base64,${body.get('id')}" /></div></div></div></div></body></html>`);
    }
    if (pathname.endsWith('queryCtripBorrows.ajax')) {
      return json({ status: 0, data: { Rows: [
        { borrowMoneyCode: '9657678711', outstandingAmount: 952, personName: '教师丙', remark: '携程酒店#9657678711', voucherDate: '2019-06-04' },
        { borrowMoneyCode: '1990000000000006', outstandingAmount: 882, personName: '教师乙', remark: '携程机票#1990000000000006上海至大连', voucherDate: '2026-08-16' },
        { borrowMoneyCode: '1990000000000004', outstandingAmount: 0, personName: '教师乙', remark: '已冲清', voucherDate: '2026-09-01' }] } });
    }
    if (pathname.endsWith('expired.ajax')) return json({ isAuth: 1, message: '登录超时，请重新登录!', status: '2' });
    if (pathname.endsWith('queryChooseBudgetOutlays.ajax')) {
      // requireAmount/budgetBalance are filled either way; showAmount is what this user may see ('' for P002).
      const shown = body.get('fundingItemsCode') !== 'P002';
      return json({ status: 0, data: { Total: 1, requireAmount: '999999.00', showAmount: shown ? '765246.00' : '', Rows: [{ expenditureItemCode: '52',
        expenditureItemName: '国内差旅/参会费', quotaCode: '0102', quotaName: '业务费', budgetBalance: '8888.00', showAmount: shown ? '5200.00' : '',
        projectCode: body.get('fundingItemsCode') }] } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const client = new OaHttpClient(fetchImpl);
  client.account = { userAccount: '900001', userName: '测试' };
  return { calls, client, ownerRows, linkedInvoices };
}

test('createReimbursementHttp posts once with the entry csrfToken and verifies the new form', async () => {
  const { calls, client } = fakeOa();
  const created = await bpm.createReimbursementHttp(client, 'applyMoney');
  assert.equal(created.documentNumber, 'A209900000023');
  const posts = calls.filter(call => call.pathname.endsWith('createReimbursement.ajax'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.csrfToken, CSRF);
  assert.deepEqual(Object.fromEntries(posts[0].body), { reimbursementKind: 'applyMoney', accountBook: 'ST00',
    accountBookName: bpm.bpmEncodeURI('上海科技大学') });
  assert.equal(bpm.bpmEncodeURI('a&b+c'), encodeURI(encodeURI('a&b+c').replace(/&/g, '%26').replace(/\+/g, '%2B')));
  await assert.rejects(bpm.createReimbursementHttp(client, 'unknownKind'), { code: 'kind_unavailable' });
  assert.equal(calls.filter(call => call.pathname.endsWith('createReimbursement.ajax')).length, 1, 'unknown kind never posted');
});

test('createReimbursementHttp reports rejection and unknown results without retrying', async () => {
  const rejected = fakeOa({ createResponse: () => json({ status: 2, message: '<b>账套已关闭</b>' }) });
  await assert.rejects(bpm.createReimbursementHttp(rejected.client, 'applyMoney'),
    error => error.code === 'create_rejected' && error.message.includes('账套已关闭'));
  const unknown = fakeOa({ createResponse: () => new Response('<html>error</html>') });
  await assert.rejects(bpm.createReimbursementHttp(unknown.client, 'applyMoney'), { code: 'create_result_unknown' });
  assert.equal(unknown.calls.filter(call => call.pathname.endsWith('createReimbursement.ajax')).length, 1);
});

test('a captcha pauses the login, its answer continues the same login, and a stale one is refused', async () => {
  const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
  const oa = fakeOa();
  const answers = [], clients = [];
  const api = new OaApi(async (username, password, hooks) => {
    clients.push(hooks.client);
    const answer = await hooks.solveCaptcha(JPEG);
    answers.push(answer);
    if (answer !== 'AB12') throw new (require('../dist/automation/http-login.js').HttpLoginError)('credentials_rejected', '验证码错误');
    return oa.client;
  }, undefined);
  const paused = await api.signIn({ username: '900001', password: 'right' });
  assert.equal(paused.loggedIn, false);
  assert.equal(paused.captcha.image, `data:image/jpeg;base64,${JPEG.toString('base64')}`);
  assert.ok(!JSON.stringify(paused).includes('right'), 'password never echoed');
  await assert.rejects(api.signIn({ captcha: '验证' }), { status: 400 }, 'malformed answer leaves the login waiting');
  const done = await api.signIn({ captcha: ' AB12 ' });
  assert.equal(done.loggedIn, true);
  assert.equal(done.login.userAccount, '900001');
  assert.deepEqual(answers, ['AB12']);
  await assert.rejects(api.signIn({ captcha: 'AB12' }), { status: 409 }, 'an answered captcha cannot be reused');

  await api.signIn({ username: '900001', password: 'right' });
  await assert.rejects(api.signIn({ captcha: 'ZZ99' }), error => error.status === 401 && error.message.includes('验证码错误'));
  assert.equal(api.status().loggedIn, false);
  await api.signIn({ username: '900001', password: 'right' });
  api.signOut();
  await assert.rejects(api.signIn({ captcha: 'AB12' }), { status: 409 }, 'logout drops the paused login');
  assert.equal(new Set(clients).size, 3, 'each login has its own CAS session');
});

test('easy page API: login, applyMoney forms, select, create, funds and subjects', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-oa-'));
  const oa = fakeOa();
  const logins = [];
  const app = createApp({ dataDir, oaApi: new OaApi(async (username, password) => {
    logins.push(username);
    if (password !== 'right') throw Object.assign(new (require('../dist/automation/http-login.js').HttpLoginError)('credentials_rejected'));
    return oa.client;
  }, undefined) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { PAGE_PATH } = require('../dist/server/app');
  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.deepEqual([home.status, home.headers.get('location')], [302, PAGE_PATH], '/ lands on the page');
  assert.equal((await fetch(`${base}/easy-v2`)).status, 404, 'no other address serves the page');
  assert.equal((await fetch(`${base}${PAGE_PATH}`)).status, 200);
  assert.equal((await fetch(`${base}/js/main.js`)).status, 200);
  const session = await fetch(`${base}/api/session`);
  const { csrfToken } = await session.json();
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };

  assert.equal((await call('GET', '/api/oa/forms')).status, 401);
  assert.equal((await call('GET', '/api/oa/status')).data.savedUsername, null);
  assert.equal((await call('POST', '/api/oa/login', { useSaved: true })).status, 400, 'no saved credentials');
  assert.equal((await call('POST', '/api/oa/login', { username: '900001', password: 'wrong' })).status, 401);
  const login = await call('POST', '/api/oa/login', { username: '900001', password: 'right' });
  assert.equal(login.status, 200);
  assert.equal(login.data.login.userName, '测试');
  assert.ok(Date.parse(login.data.login.at) <= Date.now());
  assert.ok(!JSON.stringify(login.data).includes('right'), 'password never echoed');

  assert.deepEqual(login.data.login.steps.length, 3);
  assert.equal(login.data.login.userAccount, '900001');
  assert.equal(logins.length, 2, 'every login reaches the school login function');

  const forms = await call('GET', '/api/oa/forms');
  assert.deepEqual(forms.data, { forms: [{ documentNumber: 'A209900000010', date: '2026-09-24' }, { documentNumber: 'A209900000009', date: '2026-09-24' }] },
    'the 用款申请单 at the applicant step are listed at once, before any check');
  assert.equal((await call('POST', '/api/oa/select', { documentNumber: 'A209900000010' })).status, 409, 'an unchecked form is not selectable');
  assert.deepEqual(await listForms(call), ['A209900000010'], 'only empty drafts pass the check');
  assert.equal((await call('GET', '/api/oa/forms/check?documentNumber=A209900000013')).status, 409, 'unlisted forms are not checked');
  oa.linkedInvoices.push({ invoiceCode: '26132000003019425031' });
  assert.deepEqual(await listForms(call), [], 'an empty owner row with linked invoices (an interrupted fill) is not blank');
  assert.equal((await call('POST', '/api/oa/select', { documentNumber: 'A209900000010' })).status, 409, 'nor selectable');
  oa.linkedInvoices.length = 0;
  await listForms(call);
  const todoCall = oa.calls.find(call => call.pathname === '/custom/api/v2/casp-tdc/task/search');
  assert.equal(todoCall && JSON.parse(todoCall.raw).subject, '用款申请单');
  const direct = await call('GET', '/api/oa/funds');
  assert.equal(direct.status, 200, 'funds are queried without a form (ST00 用款申请单)');
  assert.equal(oa.calls.find(call => call.pathname.endsWith('easySearch.load')).body.get('accountBook'), 'ST00');
  assert.equal((await call('POST', '/api/oa/select', { documentNumber: 'A209900000013' })).status, 409, 'unlisted forms refused');
  assert.equal((await call('POST', '/api/oa/select', { documentNumber: 'A209900000009' })).status, 409, 'filled forms refused');

  oa.ownerRows[0].remark = '刚刚有人填写';
  const opened = oa.calls.filter(call => call.pathname.endsWith('showLoadRbReimbursement.job')).length;
  const stale = await call('POST', '/api/oa/select', { documentNumber: 'A209900000010' });
  assert.equal(stale.status, 409, 'emptiness is re-checked right before opening');
  assert.match(stale.data.error, /不再是空单/);
  assert.equal(oa.calls.filter(call => call.pathname.endsWith('showLoadRbReimbursement.job')).length, opened, 'a filled form is never opened');
  oa.ownerRows[0].remark = '';
  await listForms(call);

  const selected = await call('POST', '/api/oa/select', { documentNumber: 'A209900000010' });
  assert.equal(selected.data.form.documentNumber, 'A209900000010');
  const funds = await call('GET', '/api/oa/funds?kind=authorized');
  assert.deepEqual(funds.data.items, [{ code: 'P001', name: '测试项目', label: 'P001-测试项目', department: '信息学院' }]);
  assert.equal(oa.calls.find(call => call.pathname.endsWith('easySearch.load')).body.get('fundingItemKind'), '1');
  const subjects = await call('GET', '/api/oa/budgets?fundingCode=P001');
  assert.equal(subjects.data.balance, '765246.00');
  assert.deepEqual(subjects.data.subjects, [{ code: '52', name: '国内差旅/参会费', quotaCode: '0102', quotaName: '业务费', balance: '5200.00' }]);
  const hidden = await call('GET', '/api/oa/budgets?fundingCode=P002');
  assert.deepEqual([hidden.data.balance, hidden.data.subjects[0].balance], ['', ''], 'a balance OA does not show stays hidden');

  assert.equal((await call('POST', '/api/oa/forms', {})).status, 400, 'creation needs confirmation');
  const created = await call('POST', '/api/oa/forms', { kind: 'domesticTravel', confirmed: true });
  assert.equal(created.data.form.documentNumber, 'A209900000023');
  assert.equal(oa.calls.find(call => call.pathname.endsWith('createReimbursement.ajax')).body.get('reimbursementKind'), 'applyMoney',
    'only 用款申请单 is created');

  assert.equal((await call('POST', '/api/oa/logout')).data.loggedIn, false);
  assert.equal((await call('GET', '/api/oa/forms')).status, 401);
});

test('easy page API: reads run on a second BPM session of their own; on it calls never overlap, one 登录超时 is retried', async () => {
  const oa = fakeOa();
  let expiredOnce = false;
  const peaks = new Map();
  const watch = (client, name) => {
    const request = client.request.bind(client);
    let inflight = 0;
    client.request = async (url, init) => {
      peaks.set(name, Math.max(peaks.get(name) ?? 0, ++inflight));
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (!expiredOnce && url.includes('queryChooseBudgetOutlays.ajax')) {
          expiredOnce = true;
          return request(url.replace('queryChooseBudgetOutlays', 'expired'), init);
        }
        return request(url, init);
      } finally { inflight--; }
    };
    return client;
  };
  watch(oa.client, 'main');
  const fork = oa.client.fork.bind(oa.client);
  let forks = 0;
  oa.client.fork = () => { forks++; const reader = watch(fork(), 'reader');
    assert.ok(!reader.jar.header('https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/x').includes('JSESSIONID'), 'no BPM cookie of the main session'); return reader; };
  oa.client.jar.store('https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/x', ['JSESSIONID=main-session; Path=/bpm-new; Secure; HttpOnly']);
  const api = new OaApi(async () => oa.client, undefined);
  await api.signIn({ username: '900001', password: 'x' });

  // A job holds the main session for a long time; reads do not wait for it.
  let jobDone = false;
  const job = api.serial(() => new Promise(resolve => setTimeout(() => { jobDone = true; resolve(); }, 300)));
  const params = new URLSearchParams({ fundingCode: 'P001' });
  const results = await Promise.all([api.funds(new URLSearchParams()), api.budgets(params), api.budgets(params), api.budgets(params)]);
  assert.equal(jobDone, false, 'funds and budgets answered while the job still held the main session');
  await job;
  assert.equal(forks, 1, 'one reading session per login');
  assert.equal(peaks.get('reader'), 1, 'one request at a time on the reading session');
  assert.equal(peaks.get('main') ?? 0, 0, 'reads never touch the main session');
  assert.ok(expiredOnce);
  assert.ok(results.slice(1).every(result => result.balance === '765246.00'), 'the transient expiry was retried');
  assert.equal(api.status().loggedIn, true);
});

test('easy page API: saved .env credentials log in on the server without reaching the browser', async () => {
  const { savedCredentials } = require('../dist/server/oa-api.js');
  assert.equal(savedCredentials({ OA_USERNAME: '900001' }), undefined);
  assert.equal(savedCredentials({ OA_USERNAME: 'a b', OA_PASSWORD: 'x' }), undefined);
  const used = [];
  const api = new OaApi(async (username, password) => {
    used.push([username, password]);
    return { account: { userAccount: username, userName: '测试' } };
  }, savedCredentials({ OA_USERNAME: ' 900001 ', OA_PASSWORD: 'secret-pass' }));
  const before = api.status();
  assert.equal(before.savedUsername, '900001');
  assert.ok(!JSON.stringify(before).includes('secret-pass'));
  const status = await api.signIn({ useSaved: true });
  assert.deepEqual(used, [['900001', 'secret-pass']]);
  assert.equal(status.login.savedPassword, true);
  assert.ok(!JSON.stringify(status).includes('secret-pass'));
  await api.signIn({ useSaved: true });
  assert.equal(used.length, 2, 'every click performs a fresh login');
  assert.equal((await api.signIn({ username: '101837', password: 'typed' })).login.savedPassword, false);
});

// Synthetic one-line PDF whose text is a 20-digit invoice number.
function pdf(text) {
  const stream = `BT /F1 14 Tf 30 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return { name: '发票 1.pdf', base64: Buffer.from(result).toString('base64') };
}

async function easyServer(t, { liveEnabled = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-submit-'));
  const oa = fakeOa();
  oa.client.jar.store('https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/x', ['JSESSIONID=synthetic-session; Path=/bpm-new; Secure; HttpOnly']);
  const launched = [];
  const launcher = (request, onEvent, onExit) => {
    const file = request.sessionStateFile;
    launched.push({ request, file, mode: fs.statSync(file).mode & 0o777, state: JSON.parse(fs.readFileSync(file, 'utf8')), onExit });
    return { stop() {} };
  };
  const oaApi = new OaApi(async () => oa.client, undefined);
  oaApi.renderPdf = async html => Buffer.from(`%PDF-1.7 synthetic ${html.length}`);
  const app = createApp({ dataDir, liveEnabled, launcher, oaApi });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)).then(() => fs.rmSync(dataDir, { recursive: true, force: true })));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = await fetch(`${base}/api/session`);
  const { csrfToken } = await session.json();
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  await call('POST', '/api/oa/login', { username: '900001', password: 'any' });
  await listForms(call);
  return { oa, launched, call, dataDir, base, headers };
}

const claim = (overrides = {}) => ({ confirmed: true, action: 'save', documentNumber: 'A209900000010',
  invoice: pdf('26117000000000000009'), input: { fundingKindKeyword: '被授权的项目', fundingKeyword: 'P001',
    budgetKeyword: '国内差旅/参会费', amount: '120.00', attachmentCount: 1, payeeCode: '900001', purpose: '测试用途' }, ...overrides });

test('one-page submit: the chosen blank form becomes a live job and the browser continues the page login', async t => {
  const { launched, call, dataDir, oa } = await easyServer(t);
  const jobs = async () => (await call('GET', '/api/jobs')).data.jobs;

  const filled = await call('POST', '/api/oa/submit', claim({ documentNumber: 'A209900000009' }));
  assert.equal(filled.status, 409, 'a form with content is refused');
  oa.linkedInvoices.push({ invoiceCode: '26132000003019425031' });
  const linked = await call('POST', '/api/oa/submit', claim());
  assert.equal(linked.status, 409, 'invoices linked while the owner row is still empty make it not blank');
  assert.match(linked.data.error, /已关联 1 张发票/);
  oa.linkedInvoices.length = 0;
  await listForms(call);
  assert.equal((await call('POST', '/api/oa/submit', claim({ action: undefined }))).status, 400);
  assert.equal((await call('POST', '/api/oa/submit', claim({ confirmed: false }))).status, 400);
  assert.equal(launched.length, 0);
  assert.equal((await jobs()).length, 0, 'refusals leave no job and no invoice claim');

  const started = await call('POST', '/api/oa/submit', claim());
  assert.equal(started.status, 201);
  const job = started.data.job;
  assert.equal(job.status, 'running');
  assert.equal(job.mode, 'live');
  assert.equal(job.action, 'save');
  assert.equal(job.input.formMode, 'target');
  assert.deepEqual(job.input.target, { bizId: BIZ, taskId: TASK, documentNumber: 'A209900000010' });
  assert.equal(job.input.fundingKeyword, 'P001');
  assert.equal(launched.length, 1);
  const [run] = launched;
  assert.equal(path.dirname(run.file), path.join(dataDir, 'jobs', job.id), 'login state stays in the job directory');
  assert.equal(run.mode, 0o600);
  assert.deepEqual(run.state.cookies.map(cookie => [cookie.name, cookie.domain, cookie.path]),
    [['JSESSIONID', 'sapbpm-new.shanghaitech.edu.cn', '/bpm-new']]);
  assert.equal(run.request.job.loginMode, 'manual');
  assert.equal(run.request.credentials, undefined, 'no password reaches the worker');
  assert.ok(!JSON.stringify(started.data).includes('synthetic-session'), 'cookies never reach the page');
  run.onExit();
  assert.equal(fs.existsSync(run.file), false, 'login state is deleted when the run ends');

  const smuggled = claim({ documentNumber: null, invoice: pdf('26117000000000000010') });
  smuggled.input = { ...smuggled.input, formMode: 'target', target: { bizId: 'e'.repeat(32), taskId: TASK, documentNumber: 'A1' } };
  const created = await call('POST', '/api/oa/submit', smuggled);
  assert.equal(created.status, 201);
  assert.equal(created.data.job.input.formMode, 'new', 'null documentNumber means a new form; a client target is ignored');
  assert.equal(created.data.job.input.target, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched.length, 2);
  launched[1].onExit();
});

test('submitting uploaded invoices does not search the OA folder first', async t => {
  const { launched, call, oa } = await easyServer(t);
  const before = oa.calls.filter(call => call.pathname.endsWith('queryBillImageListForClaims4WsNew.ajax')).length;
  const started = await call('POST', '/api/oa/submit', claim({ invoice: pdf(CLAIMED) }));
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const looked = oa.calls.filter(call => call.pathname.endsWith('queryBillImageListForClaims4WsNew.ajax')).length - before;
  assert.equal(looked, 0, 'a PDF is uploaded later; OA reports 已被报销 on that upload');
  launched[0].onExit();
});

test('one-page submit with several invoices: one job, every file checked in OA, amount and attachments from the page', async t => {
  const { launched, call, dataDir } = await easyServer(t);
  const two = { ...pdf('26117000000000000021 ¥ 40.50'), name: '发票 2.pdf' };
  const first = pdf('26117000000000000022 ¥ 80.00');
  const twice = await call('POST', '/api/oa/submit', claim({ invoice: undefined, invoices: [first, first] }));
  assert.equal(twice.status, 400);
  assert.equal(launched.length, 0);
  await listForms(call);
  const started = await call('POST', '/api/oa/submit', claim({ invoice: undefined, invoices: [first, two] }));
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const job = started.data.job;
  const again = await call('POST', '/api/oa/submit', claim({ invoice: undefined, invoices: [pdf('26117000000000000023 ¥ 10.00')], input: { ...claim().input, amount: '10.00' } }));
  assert.equal(again.status, 409, 'a form handed to a queued job is not handed to a second one');
  assert.equal(launched.length, 1);
  assert.deepEqual([job.invoice.number, ...job.extraInvoices.map(item => item.number)], ['26117000000000000022', '26117000000000000021']);
  const dir = path.join(dataDir, 'jobs', job.id);
  assert.ok(fs.existsSync(path.join(dir, 'invoice.pdf')) && fs.existsSync(path.join(dir, 'invoice-2.pdf')));
  assert.match(job.checks.find(item => item.code === 'invoice').message, /2 张 PDF/);
  launched[0].onExit();
});

test('invoices already in an OA folder are listed, picked and linked without a PDF; the 500 元 limits apply', async t => {
  const { launched, call, dataDir } = await easyServer(t);
  const { invoices } = (await call('GET', '/api/oa/folder-invoices')).data;
  assert.deepEqual(invoices.map(item => [item.number, item.amount, item.balance, item.selectable]),
    [[WHOLE, '300.00', '300.00', true], [PART, '960.00', '60.00', false], [SAME_DAY, '200.00', '200.00', true]], 'rows without a number are dropped');
  assert.match(invoices[1].reason, /D209900000037/);
  assert.equal(invoices[0].date, '2026-09-08');
  const pick = number => ({ folderId: '1879423340632997890', number });
  const input = amount => ({ ...claim().input, amount });

  const partial = await call('POST', '/api/oa/submit', claim({ invoice: undefined, invoices: [pick(PART)], input: input('60.00') }));
  assert.equal(partial.status, 409);
  const sameDay = await call('POST', '/api/oa/submit', claim({ invoice: undefined, invoices: [pick(WHOLE), pick(SAME_DAY)], input: input('500.00') }));
  assert.equal(sameDay.status, 400);
  assert.match(sameDay.data.error, /某商贸公司 在 2026-09-08 开具的 2 张发票合计 500\.00 元/);
  assert.equal(launched.length, 0);
  // The refused submission released the blank form, so the next one can take it.

  const started = await call('POST', '/api/oa/submit', claim({ invoice: undefined,
    invoices: [pdf('26117000000000000052 ¥ 80.00'), pick(WHOLE)], input: input('380.00') }));
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const job = started.data.job;
  assert.deepEqual(job.extraInvoices.map(item => [item.number, item.folderId, item.sha256, item.seller]), [[WHOLE, '1879423340632997890', '', '某商贸公司']]);
  const dir = path.join(dataDir, 'jobs', job.id);
  assert.ok(fs.existsSync(path.join(dir, 'invoice.pdf')) && !fs.existsSync(path.join(dir, 'invoice-2.pdf')), 'only the uploaded PDF is stored');
  assert.match(job.checks.find(item => item.code === 'invoice').message, /1 张 PDF和OA 票夹中选择的 1 张/);
  const smuggled = await call('POST', '/api/jobs', { mode: 'live', action: 'save', invoices: [pick(SAME_DAY)], input: input('200.00') });
  assert.equal(smuggled.status, 400, 'folder invoices only come through the page, after the OA check');
  launched[0].onExit();
});

test('报销单打印: only 提交 bills of every type, filtered by OA; the joined page is served once under its own CSP', async t => {
  const { call, base, headers, oa } = await easyServer(t);
  const listed = await call('GET', '/api/oa/print');
  assert.equal(listed.status, 200);
  const query = oa.calls.filter(item => item.pathname.endsWith('slicedQueryOwnerReimbursement.ajax')).at(-1).body;
  assert.equal(query.get('queryStatusKind'), '1', 'OA filters by 状态 = 提交');
  assert.equal(query.get('pagesize'), '100');
  assert.deepEqual(listed.data.rows.map(row => [row.billCode, row.kind, row.print]),
    [['A209900000013', '', 'check'], ['D209900000036', '境内差旅单', 'check']], 'other bill types are listed too');
  assert.equal(listed.data.rows[1].date, '2026-09-04');
  const inApproval = 'a'.repeat(32), travel = 'c'.repeat(32);

  assert.equal((await call('POST', '/api/oa/print', { bizIds: ['e'.repeat(32)] })).status, 409, '已完成 is not in the print list');
  assert.equal((await call('POST', '/api/oa/print', { bizIds: [inApproval] })).status, 409, '提交 needs the OA permission check first');
  assert.equal((await call('POST', '/api/oa/print', { bizIds: [] })).status, 400);
  assert.deepEqual((await call('GET', `/api/oa/print/permission?bizId=${travel}`)).data, { bizId: travel, allowed: false }, 'OA may refuse one');
  assert.equal((await call('POST', '/api/oa/print', { bizIds: [travel] })).status, 409);
  assert.ok(!oa.calls.some(item => item.pathname.endsWith('printRbReimbursement.load')), 'refusals fetch nothing');

  assert.deepEqual((await call('GET', `/api/oa/print/permission?bizId=${inApproval}`)).data, { bizId: inApproval, allowed: true });
  const built = await call('POST', '/api/oa/print', { bizIds: [inApproval] });
  assert.equal(built.status, 200, JSON.stringify(built.data));
  assert.deepEqual(built.data.bills, ['A209900000013']);
  assert.match(built.data.url, /^\/print\/[\w-]{24}$/);
  const pages = oa.calls.filter(item => item.pathname.endsWith('printRbReimbursement.load'));
  assert.deepEqual(pages.map(item => [item.body.get('id'), item.body.get('outputType'), item.body.get('markImagePath')]),
    [[inApproval, 'img', 'images/20190826094407.png']]);

  assert.equal((await fetch(`${base}${built.data.url}`)).status, 401, 'the print page needs the local session');
  const page = await fetch(`${base}${built.data.url}`, { headers: { Cookie: headers.Cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'self'/);
  const html = await page.text();
  assert.ok(html.includes(`base64,${inApproval}`));
  assert.doesNotMatch(html, /window\.print\(\)/, 'OA\'s inline script is not passed on; print.js prints');
  assert.equal((await fetch(`${base}${built.data.url}`, { headers: { Cookie: headers.Cookie } })).status, 404, 'served once');

  const pdf = await call('POST', '/api/oa/print', { bizIds: [inApproval], format: 'pdf' });
  assert.equal(pdf.status, 200, JSON.stringify(pdf.data));
  assert.equal(pdf.data.filename, 'A209900000013.pdf');
  const file = await fetch(`${base}${pdf.data.url}`, { headers: { Cookie: headers.Cookie } });
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^attachment; .*filename\*=UTF-8''A209900000013\.pdf$/);
  assert.match(Buffer.from(await file.arrayBuffer()).toString(), /^%PDF-1\.7 synthetic \d+$/);
  assert.equal((await call('POST', '/api/oa/print', { bizIds: [inApproval], format: 'docx' })).status, 400);
});

test('打印文件: made ahead per bill, opened again and again until it expires; only allowed bills, only this session', async t => {
  const { call, base, headers, oa } = await easyServer(t);
  await call('GET', '/api/oa/print');
  const inApproval = 'a'.repeat(32), travel = 'c'.repeat(32);
  assert.equal((await call('POST', '/api/oa/print/file', { bizId: inApproval })).status, 409, '提交 needs the OA permission check first');
  assert.equal((await call('POST', '/api/oa/print/file', { bizId: 'e'.repeat(32) })).status, 409, 'not listed');
  await call('GET', `/api/oa/print/permission?bizId=${travel}`);
  assert.equal((await call('POST', '/api/oa/print/file', { bizId: travel })).status, 409, 'OA refused this one');
  assert.deepEqual((await call('GET', '/api/oa/print/files')).data, { files: [] });

  await call('GET', `/api/oa/print/permission?bizId=${inApproval}`);
  const made = await call('POST', '/api/oa/print/file', { bizId: inApproval });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.billCode, 'A209900000013');
  assert.equal(made.data.filename, 'A209900000013.pdf');
  assert.match(made.data.printUrl, /^\/print\/ready\/[\w-]{24}$/);
  assert.equal(made.data.pdfUrl, `${made.data.printUrl}.pdf`);
  assert.equal(made.data.printed, false);
  const fetched = () => oa.calls.filter(item => item.pathname.endsWith('printRbReimbursement.load')).length;
  assert.equal(fetched(), 1);
  assert.deepEqual((await call('POST', '/api/oa/print/file', { bizId: inApproval })).data, made.data, 'a ready bill is not fetched again');
  assert.equal(fetched(), 1);
  assert.deepEqual((await call('GET', '/api/oa/print/files')).data.files, [made.data], 'listed for a reload of the page');
  const pdfFirst = await fetch(`${base}${made.data.pdfUrl}?download=1`, { headers: { Cookie: headers.Cookie } });
  assert.equal(pdfFirst.status, 200);
  assert.equal((await call('GET', '/api/oa/print/files')).data.files[0].printed, false, 'a download is not a print');

  const cookie = { headers: { Cookie: headers.Cookie } };
  assert.equal((await fetch(`${base}${made.data.printUrl}`)).status, 401, 'needs the local session');
  for (let i = 0; i < 2; i++) {
    const page = await fetch(`${base}${made.data.printUrl}`, cookie);
    assert.equal(page.status, 200, 'the print page opens more than once');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok((await page.text()).includes(`base64,${inApproval}`));
  }
  assert.equal((await call('GET', '/api/oa/print/files')).data.files[0].printed, true, '打印 was clicked: kept for a reload');
  const viewed = await fetch(`${base}${made.data.pdfUrl}`, cookie);
  assert.equal(viewed.headers.get('content-type'), 'application/pdf');
  assert.match(viewed.headers.get('content-disposition'), /^inline; .*A209900000013\.pdf$/, 'opens in the browser');
  assert.match(Buffer.from(await viewed.arrayBuffer()).toString(), /^%PDF-1\.7 synthetic \d+$/);
  const saved = await fetch(`${base}${made.data.pdfUrl}?download=1`, cookie);
  assert.match(saved.headers.get('content-disposition'), /^attachment; /);
  assert.equal((await fetch(`${base}/print/ready/${'x'.repeat(24)}`, cookie)).status, 404);

  await call('POST', '/api/oa/logout');
  assert.equal((await fetch(`${base}${made.data.printUrl}`, cookie)).status, 404, 'the login ending drops its files');
});

test('银行转账: the page finds the account among OA suppliers by exact name; the job input keeps the choice', async t => {
  const { call } = await easyServer(t);
  const found = await call('GET', `/api/oa/payees?name=${encodeURIComponent('上海上勤餐饮管理有限公司')}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.suppliers, [{ supplierCode: '1000014428', name: '上海上勤餐饮管理有限公司', bank: '上海银行市政大厦支行', account: '****0901', main: true }],
    'only the exact name with an account; the full account number never reaches the page');
  assert.equal((await call('GET', '/api/oa/payees?name=x')).status, 400);

  const { parseInput } = require('../dist/domain/job.js');
  const base = { purpose: '用途', fundingKeyword: 'P001', budgetKeyword: '材料费', amount: '420.00', attachmentCount: 1 };
  assert.deepEqual((({ payeeCode, payeeKind, supplierCode, remitPurpose }) => ({ payeeCode, payeeKind, supplierCode, remitPurpose }))(
    parseInput({ ...base, payeeKind: 'bank', payeeCode: '上海上勤餐饮管理有限公司', supplierCode: '1000014428', remitPurpose: '会议餐费' })),
  { payeeCode: '上海上勤餐饮管理有限公司', payeeKind: 'bank', supplierCode: '1000014428', remitPurpose: '会议餐费' });
  assert.equal(parseInput({ ...base, payeeCode: '2024000002' }).payeeKind, undefined, '学号/工号 stays 个人银行卡');
  for (const bad of [{ payeeCode: '上海上勤' }, { payeeKind: 'bank', payeeCode: '上海上勤', remitPurpose: '餐费' },
    { payeeKind: 'bank', payeeCode: '上海上勤', supplierCode: '1000014428' }, { payeeCode: '2024000002', supplierCode: '1000014428' }]) {
    assert.throws(() => parseInput({ ...base, ...bad }), error => error.status === 400, JSON.stringify(bad));
  }
});

test('one-page submit is refused before any job when live execution is disabled', async t => {
  const { launched, call } = await easyServer(t, { liveEnabled: false });
  const response = await call('POST', '/api/oa/submit', claim());
  assert.equal(response.status, 403);
  assert.match(response.data.error, /OA_LIVE_ENABLED/);
  assert.equal((await call('GET', '/api/jobs')).data.jobs.length, 0);
  assert.equal(launched.length, 0);
});

test('a target form is validated as part of the job input', () => {
  const { parseInput } = require('../dist/domain/job.js');
  const base = { purpose: '用途', payeeCode: '900001', fundingKeyword: 'P001', budgetKeyword: '材料费', amount: '1.00', attachmentCount: 1 };
  const target = { bizId: BIZ, taskId: TASK, documentNumber: 'A209900000010' };
  assert.deepEqual(parseInput({ ...base, formMode: 'target', target }).target, target);
  for (const bad of [{ ...target, bizId: 'x' }, { ...target, taskId: 'y' }, { ...target, documentNumber: 'B1' }, undefined]) {
    assert.throws(() => parseInput({ ...base, formMode: 'target', target: bad }), error => error.status === 400);
  }
  assert.throws(() => parseInput({ ...base, formMode: 'new', target }), error => error.status === 400);
  assert.equal(parseInput(base).target, undefined);
});

test('境内差旅单 on the easy page: its own budget query, bad input or disabled live runs create nothing', async t => {
  const { call, oa } = await easyServer(t);
  assert.deepEqual((await call('GET', '/api/oa/travel')).data, { run: null });
  const travelBudgets = await call('GET', '/api/oa/travel/budgets?fundingCode=P001');
  assert.equal(travelBudgets.data.subjects[0].name, '国内差旅/参会费');
  const budget = oa.calls.filter(item => item.pathname.endsWith('queryChooseBudgetOutlays.ajax')).pop();
  assert.equal(budget.body.get('reimbursementKind'), 'domesticTravel');
  await call('GET', '/api/oa/budgets?fundingCode=P001&kind=domesticTravel');
  assert.notEqual(oa.calls.filter(item => item.pathname.endsWith('queryChooseBudgetOutlays.ajax')).pop().body.get('reimbursementKind'),
    'domesticTravel', 'the 用款申请单 query ignores the 差旅单 type');

  const input = { fundingCode: 'P001', attachmentCount: 1, reason: '差旅',
    lines: [{ budgetName: '国内差旅/参会费', purpose: '差旅' }], payees: [{ kind: 'card', code: '900001' }],
    travellers: [{ kind: 'staff', code: '900002', name: '教师乙', legs: [{ startDate: '2026-10-21', startAddress: '上海', arriveDate: '2026-10-20',
      arriveAddress: '北京', vehicle: 'train', trafficExpense: '553', travelDays: 1 }] }] };
  assert.equal((await call('POST', '/api/oa/travel', { input })).status, 400, 'needs confirmation');
  const backwards = await call('POST', '/api/oa/travel', { confirmed: true, input });
  assert.equal(backwards.status, 400);
  assert.match(backwards.data.error, /到达日期早于启程日期/);
  const stranger = { ...input, travellers: [{ ...input.travellers[0], kind: 'guest' }] };
  assert.equal((await call('POST', '/api/oa/travel', { confirmed: true, input: stranger })).status, 400);
  assert.equal(oa.calls.some(item => item.pathname.endsWith('createReimbursement.ajax')), false);
  assert.deepEqual((await call('GET', '/api/oa/travel')).data, { run: null });

  // Reusable drafts: the applicant's blank 境内差旅单 only (not the submitted one, not 用款申请单).
  oa.ownerRows.push({ ...blankContent(), id: 'f'.repeat(32), billCode: 'D209900000039', status: 0, reimbursementKind: 'domesticTravel',
    statusTextView: '预制', fillinDate: '2026-10-21 21:40:00' });
  assert.deepEqual((await call('GET', '/api/oa/travel/forms')).data, { forms: [{ documentNumber: 'D209900000039', date: '2026-10-21' }] });
  const fixed = { ...input, travellers: [{ ...input.travellers[0], legs: [{ ...input.travellers[0].legs[0], arriveDate: '2026-10-21' }] }] };
  const unlisted = await call('POST', '/api/oa/travel', { confirmed: true, input: fixed, documentNumber: 'D209900000040' });
  assert.equal(unlisted.status, 409);
  assert.equal((await call('POST', '/api/oa/travel', { confirmed: true, input: fixed, documentNumber: 'A209900000010' })).status, 400);
  assert.equal((await call('POST', '/api/oa/travel', { confirmed: true, action: 'publish', input: fixed })).status, 400, 'only save or submit');

  // 出差人 by name: 教工 from the org tree, 学生 from the student list; namesakes are all offered once each.
  assert.deepEqual((await call('GET', `/api/oa/travel/people?kind=staff&name=${encodeURIComponent('教师乙')}`)).data.people,
    [{ code: '900002', name: '教师乙', dept: '教师乙组' }]);
  assert.deepEqual((await call('GET', `/api/oa/travel/people?kind=student&name=${encodeURIComponent('李同学')}`)).data.people.map(item => item.code),
    ['2020000001', '2024000002']);
  const lookup = oa.calls.filter(item => item.pathname.endsWith('easySearch.load')).pop().body;
  assert.equal(lookup.get('paramValue'), encodeURI('李同学'), 'the name is encoded once, as the OA dialog sends it');
  assert.equal((await call('GET', '/api/oa/travel/people?kind=guest&name=x')).status, 400);
  assert.equal((await call('GET', '/api/oa/travel/people?kind=staff&name=')).status, 400);

  // 携程借款单 for the picker: open ones only, newest first.
  const borrows = await call('GET', '/api/oa/travel/borrows?fundingCode=P001');
  assert.deepEqual(borrows.data.borrows.map(item => [item.order, item.outstanding, item.date]),
    [['1990000000000006', '882.00', '2026-08-16'], ['9657678711', '952.00', '2019-06-04']]);
  assert.equal(oa.calls.filter(item => item.pathname.endsWith('queryCtripBorrows.ajax')).pop().body.get('fundingItemsCode'), 'P001');

  const { call: offline } = await easyServer(t, { liveEnabled: false });
  const refused = await offline('POST', '/api/oa/travel', { confirmed: true, input: { ...input, travellers: [{ ...input.travellers[0],
    legs: [{ ...input.travellers[0].legs[0], arriveDate: '2026-10-21' }] }] } });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /OA_LIVE_ENABLED/);
});

test('行程附件: a file is parsed in memory and assembled into legs; nothing is stored and bad input is refused', async t => {
  const { call, dataDir } = await easyServer(t);
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage();
  await doc.attach(Buffer.from(`<rai:TypeOfVoucher>电子发票（铁路电子客票）</rai:TypeOfVoucher><rai:TypeOfBusiness>售</rai:TypeOfBusiness>
    <rai:DepartureStation>上海虹桥</rai:DepartureStation><rai:DestinationStation>北京南</rai:DestinationStation><rai:TrainNumber>G1</rai:TrainNumber>
    <rai:TravelDate>2026-07-05</rai:TravelDate><rai:DepartureTime>07:00</rai:DepartureTime><rai:Fare>553.00</rai:Fare><rai:Name>测试</rai:Name>`),
  'rai.xml', { mimeType: 'application/xml' });
  const before = fs.readdirSync(dataDir, { recursive: true }).length;
  const parsed = await call('POST', '/api/travel/parse', { name: 'g1.pdf', base64: Buffer.from(await doc.save()).toString('base64') });
  assert.equal(parsed.status, 200);
  assert.deepEqual([parsed.data.items[0].type, parsed.data.items[0].from, parsed.data.items[0].to], ['train', '上海', '北京']);
  assert.equal(fs.readdirSync(dataDir, { recursive: true }).length, before, 'the attachment is not written anywhere');
  const built = await call('POST', '/api/travel/itinerary', { items: parsed.data.items });
  assert.deepEqual(built.data.itinerary.groups[0].legs.map(leg => [leg.startAddress, leg.arriveAddress, leg.trafficExpense]), [['上海', '北京', '553.00']]);
  assert.equal((await call('POST', '/api/travel/parse', { name: '../x.pdf', base64: 'AAAA' })).status, 400);
  assert.equal((await call('POST', '/api/travel/parse', { name: 'x.pdf', base64: 'not base64!' })).status, 400);
  assert.equal((await call('POST', '/api/travel/itinerary', { items: [{ type: 'train', fare: '<script>' }] })).status, 400);
});
