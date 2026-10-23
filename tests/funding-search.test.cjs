const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFundingSearchPayload, searchFundingItems, parseFundingListHtml, findFundingItem,
  FundingSearchError, FUNDING_SEARCH_ORIGIN, FUNDING_SEARCH_PATH,
} = require('../dist/automation/funding-search');
const { parseFundingArgs, saveFundingResponse, main } = require('../dist/funds');

// Synthetic fixtures only: no real OA credential, browser, or remote request.
const endpoint = FUNDING_SEARCH_ORIGIN + FUNDING_SEARCH_PATH;
const formUrl = `${FUNDING_SEARCH_ORIGIN}/bpm-new/rbReimbursement/showLoadRbReimbursement.job?isReadOnly=false`;
const syntheticToken = 'synthetic-browser-token';
const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const plain = value => JSON.parse(JSON.stringify(value));

// Synthetic fragment with the live structure: one <tr class="list"> per project, fields as hidden inputs.
function fundingRow(code, name, extra = '') {
  return `<tr class="list"><td>${code}</td>
    <input type="hidden" name="projectid" value="${code}"><input type="hidden" name="projectname" value="${name}">
    <input type='hidden' name='projectnameTextView' value='${code}-${name}'>
    <input type="hidden" name="departmid" value="D001"><input type="hidden" name="departmname" value="合成学院">
    <input type="hidden" name="firstid" value="F1"><input type="hidden" name="firstname" value="一级">
    <input type="hidden" name="secondid" value="S1"><input type="hidden" name="secondname" value="二级">${extra}</tr>`;
}
const fundingHtml = `<div><table id="easySearchTableListData" class="noBorder"
  border=0 cellspacing=0 cellpadding=0 pageWidth="400" dataCount='3'
  pageCount='1'>
  <tr><th>项目编号</th></tr>
  ${fundingRow('SYN-0001', '合成科研 &amp; 测试')}
  ${fundingRow('SYN-0002', '合成&#x6559;学经费')}
  ${fundingRow('bad code<', '无效')}
  </table><script>alert(1)</script></div>`;
const errorPage = `<html><body><div id="show_error_info">出现错误！ 以下为错误信息： 错误的请求!</div></body></html>`;

function reply(overrides = {}) {
  return {
    status: 200, ok: true, type: 'basic', url: endpoint,
    headers: { get: name => name === 'content-type' ? 'text/html;charset=utf-8' : null },
    text: async () => fundingHtml, ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [], runtime = options.runtime ?? { csrfToken: syntheticToken };
  const form = options.form ?? { mainAccountBook: 'ST00', jobPageId: taskId };
  const location = { origin: FUNDING_SEARCH_ORIGIN, href: formUrl };
  const page = { isClosed: () => false, url: () => formUrl };
  const frame = { url: () => formUrl, evaluate: async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
    args, location, window: runtime, document: { querySelectorAll: () => [],
      getElementById: id => Object.hasOwn(form, id) ? { value: form[id] } : null },
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (...args) => { calls.push(args); return options.response ?? reply(); },
  }) };
  return { page, frame, calls, ctx: { page, root: () => frame } };
}

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-funds-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('payload reproduces the editor dialog body captured live, with kind and keyword options', () => {
  assert.deepEqual(buildFundingSearchPayload(), { queryName: 'queryFundingItems', pageSize: '8', configType: 'tech',
    paramValue: '', fundingItemKind: '1', accountBook: '', isMultipleSelect: 'false' });
  const responsible = buildFundingSearchPayload({ kind: 'responsible', paramValue: ' 合成 ', accountBook: 'ST01', pageSize: 20 });
  assert.equal(responsible.fundingItemKind, '0');
  assert.equal(responsible.paramValue, '合成');
  assert.equal(responsible.accountBook, 'ST01');
  assert.equal(responsible.pageSize, '20');
  for (const value of [null, [], { kind: 'mine' }, { paramValue: 'a\nb' }, { paramValue: 'x'.repeat(101) },
    { accountBook: 'bad book' }, { pageSize: 0 }, { pageSize: 101 }, { queryName: 'other' }, { csrfToken: 'x' }]) {
    assert.throws(() => buildFundingSearchPayload(value), { code: 'invalid_query' });
  }
});

test('request is sent from the open form with its token, procTaskId and account book, and parses the list', async () => {
  const f = fixture();
  const result = await searchFundingItems(f.ctx);
  assert.equal(f.calls.length, 1);
  const [url, request] = f.calls[0];
  assert.equal(url, endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.body, 'queryName=queryFundingItems&pageSize=8&configType=tech&paramValue='
    + '&fundingItemKind=1&accountBook=ST00&isMultipleSelect=false');
  assert.deepEqual(plain(request.headers), { Accept: 'text/plain, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
    csrfToken: syntheticToken, procTaskId: taskId });
  assert.equal(result.query.accountBook, 'ST00');
  assert.deepEqual(result.list.items.map(item => item.projectId), ['SYN-0001', 'SYN-0002']);
});

test('missing account book or token stops before fetch; an echoed token is redacted', async () => {
  for (const [options, code] of [[{ form: {} }, 'form_context_missing'], [{ runtime: {} }, 'csrf_missing']]) {
    const f = fixture(options);
    await assert.rejects(searchFundingItems(f.ctx), { code });
    assert.equal(f.calls.length, 0);
  }
  const explicit = fixture({ form: {} });
  await searchFundingItems(explicit.ctx, { accountBook: 'ST00' });
  assert.equal(new URLSearchParams(explicit.calls[0][1].body).get('accountBook'), 'ST00');
  const echoed = fixture({ response: reply({ text: async () => fundingHtml.replace('<div>', `<div data-t="${syntheticToken}">`) }) });
  assert.doesNotMatch(JSON.stringify(await searchFundingItems(echoed.ctx)), /synthetic-browser-token/);
});

test('BPM error page, login pages, unrecognised HTML and HTTP failures are errors, not empty lists', async () => {
  for (const [response, code] of [
    [reply({ text: async () => errorPage }), 'server_rejected'],
    [reply({ text: async () => '<form><input type="password" id="password"></form>' }), 'authentication'],
    [reply({ text: async () => '<p>登录超时，请重新登录</p>' }), 'authentication'],
    [reply({ text: async () => '<table id="other"><tr><td>x</td></tr></table>' }), 'list_unrecognized'],
    [reply({ status: 302, ok: false }), 'authentication'], [reply({ status: 500, ok: false }), 'http_error'],
    [reply({ text: async () => '  ' }), 'response_invalid'], [reply({ url: `${endpoint}?moved` }), 'response_invalid'],
  ]) {
    const f = fixture({ response });
    await assert.rejects(searchFundingItems(f.ctx), { code });
  }
});

test('funding list HTML yields project codes from the live hidden inputs without running scripts', () => {
  const list = parseFundingListHtml(fundingHtml);
  assert.equal(list.dataCount, 3);
  assert.equal(list.pageCount, 1);
  assert.equal(list.skipped, 1);
  assert.deepEqual(list.items.map(item => ({ ...item })), [
    { projectId: 'SYN-0001', projectName: '合成科研 & 测试', label: 'SYN-0001-合成科研 & 测试', departmentId: 'D001',
      departmentName: '合成学院', firstId: 'F1', firstName: '一级', secondId: 'S1', secondName: '二级' },
    { projectId: 'SYN-0002', projectName: '合成教学经费', label: 'SYN-0002-合成教学经费', departmentId: 'D001',
      departmentName: '合成学院', firstId: 'F1', firstName: '一级', secondId: 'S1', secondName: '二级' },
  ]);
  assert.equal(parseFundingListHtml('<table id="other"><tr><td>x</td></tr></table>'), undefined);
  assert.deepEqual({ ...parseFundingListHtml('<table id="easySearchTableListData" datacount="x"></table>') },
    { dataCount: undefined, pageCount: undefined, items: [], skipped: 0 });
});

test('funding keyword matches an exact code or exactly one label, otherwise fails closed', () => {
  const list = parseFundingListHtml(fundingHtml);
  assert.equal(findFundingItem(list, 'SYN-0002').projectId, 'SYN-0002');
  assert.equal(findFundingItem(list, '合成 科研').projectId, 'SYN-0001');
  assert.equal(findFundingItem(list, '教学').projectId, 'SYN-0002');
  assert.throws(() => findFundingItem(list, '合成'), { code: 'item_ambiguous' });
  assert.throws(() => findFundingItem(list, '不存在'), { code: 'item_missing' });
  assert.throws(() => findFundingItem(list, '  '), { code: 'invalid_query' });
  const duplicated = { ...list, items: [list.items[0], { ...list.items[0] }] };
  assert.equal(findFundingItem(duplicated, '科研').projectId, 'SYN-0001');
});

test('CLI needs an original form and validates options before browser startup', () => {
  assert.deepEqual(parseFundingArgs(['--help']), { help: true });
  assert.deepEqual(parseFundingArgs(['--document-number', 'A209900000016']),
    { help: false, query: {}, documentNumber: 'A209900000016' });
  const full = parseFundingArgs(['--biz-id', 'A'.repeat(32), '--task-id', taskId, '--kind', 'responsible',
    '--param-value', '合成', '--page-size', '20', '--keyword', ' 教学 ']);
  assert.deepEqual(full.query, { kind: 'responsible', paramValue: '合成', pageSize: 20 });
  assert.equal(full.keyword, '教学');
  assert.equal(full.target.isReadOnly, false);
  for (const args of [[], ['--accept', ''], ['--document-number', 'invalid'], ['--biz-id', 'A'.repeat(32)],
    ['--document-number', 'A1', '--kind', 'mine'], ['--document-number', 'A1', '--page-size', '0'],
    ['--document-number', 'A1', '--keyword', ' '], ['--document-number', 'A1', '--cookie', 'x'], ['positional']]) {
    assert.throws(() => parseFundingArgs(args), undefined, JSON.stringify(args));
  }
});

test('response files are private unique JSON artifacts, including inert HTML strings', async t => {
  const directory = temp(t);
  const result = { queriedAt: new Date().toISOString(), query: buildFundingSearchPayload(), httpStatus: 200,
    response: '<script>throw Error("must remain data")</script>', list: { items: [], skipped: 0 } };
  const file = await saveFundingResponse(result, directory);
  const second = await saveFundingResponse(result, directory);
  assert.notEqual(file, second);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), result);
});

function cliFixture(t) {
  const directory = temp(t), oldEnv = { ...process.env }, events = [], logs = [];
  t.after(() => { process.env = oldEnv; });
  process.env.OA_DATA_DIR = directory;
  process.env.PLAYWRIGHT_CDP_ENDPOINT = 'synthetic personal browser';
  t.mock.method(require('dotenv'), 'config', () => ({}));
  t.mock.method(console, 'log', value => { logs.push(value); });
  const f = fixture(), portal = { isClosed: () => false, on: () => {} };
  const session = { page: {}, restoredSession: true };
  const browser = require('../dist/automation/browser');
  t.mock.method(browser, 'createBrowserSession', async () => {
    events.push('create');
    assert.equal(process.env.PLAYWRIGHT_CDP_ENDPOINT, undefined);
    assert.equal(process.env.OA_LOGIN_MODE, 'manual');
    return session;
  });
  t.mock.method(require('../dist/automation/auth'), 'authenticateSchool', async () => { events.push('authenticate'); return portal; });
  t.mock.method(require('../dist/automation/reimbursement-list'), 'resolveListTarget', async (received, documentNumber, isReadOnly) => {
    events.push('todo'); assert.equal(received, session); assert.equal(received.page, portal);
    return { target: { bizId: 'B'.repeat(32), taskId, isReadOnly, expectedDocumentNumber: documentNumber },
      row: { statusText: '预制' }, task: { name: '申请', statusId: 'ready' } };
  });
  t.mock.method(require('../dist/automation/open-reimbursement'), 'openReimbursementByIds', async (_session, ctx, target) => {
    events.push('open');
    assert.deepEqual(target, { bizId: 'B'.repeat(32), taskId, isReadOnly: false, expectedDocumentNumber: 'A209900000016' });
    ctx.setActiveFrame(f.frame);
  });
  t.mock.method(browser, 'rememberAuthenticatedSession', async () => { events.push('remember'); });
  t.mock.method(browser, 'closeBrowserSession', async received => { events.push('close'); assert.equal(received, session); });
  const mutation = t.mock.method(require('../dist/automation/reimbursement-flow'), 'runReimbursementFlowWithErrorHandling',
    async () => { throw Error('must not invoke mutation flow'); });
  return { directory, events, logs, f, mutation };
}

test('CLI resolves and opens the form, queries the list inside it, saves, matches the keyword and closes', async t => {
  const fixture = cliFixture(t);
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  await main(['--document-number', 'A209900000016', '--keyword', '教学']);
  assert.deepEqual(fixture.events, ['create', 'authenticate', 'todo', 'open', 'remember', 'close']);
  assert.equal(fixture.f.calls.length, 1);
  assert.equal(fixture.mutation.mock.callCount(), 0);
  assert.equal(fs.readdirSync(path.join(fixture.directory, 'oa-funding-search')).length, 1);
  assert.match(fixture.logs.join('\n'), /2 个项目.*\n[\s\S]*SYN-0002/);
  assert.doesNotMatch(fixture.logs.join('\n'), /synthetic-browser-token/);
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
});

test('CLI failure closes its browser and leaves no misleading result file', async t => {
  const fixture = cliFixture(t);
  fixture.f.frame.evaluate = async () => ({ error: 'authentication', status: 403 });
  await assert.rejects(main(['--document-number', 'A209900000016']), { code: 'authentication' });
  assert.equal(fixture.events.at(-1), 'close');
  assert.equal(fs.existsSync(path.join(fixture.directory, 'oa-funding-search')), false);
});

test('CLI validates and prints help before launching any browser', async t => {
  const fixture = cliFixture(t);
  await assert.rejects(main(['--kind', 'mine', '--document-number', 'A1']), { code: 'invalid_query' });
  await main(['--help']);
  assert.deepEqual(fixture.events, []);
});

test('FundingSearchError exposes fixed messages', () => {
  const error = new FundingSearchError('server_rejected', 200);
  assert.equal(error.status, 200);
  assert.match(error.message, /错误的请求/);
});
