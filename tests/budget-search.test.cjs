const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBudgetSearchPayload, searchBudgetOutlays, parseBudgetOutlays,
  BUDGET_SEARCH_ORIGIN, BUDGET_SEARCH_PATH } = require('../dist/automation/budget-search');
const { parseBudgetArgs, saveBudgetResponse, main } = require('../dist/budgets');
const endpoint = BUDGET_SEARCH_ORIGIN + BUDGET_SEARCH_PATH;
const formUrl = `${BUDGET_SEARCH_ORIGIN}/bpm-new/rbReimbursement/showLoadRbReimbursement.job?isReadOnly=false`;
const cliArgs = ['--funding-code', '2025X0203-999-99', '--biz-id', 'A'.repeat(32),
  '--task-id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];

// Synthetic fixtures only: no real OA credential, browser, or remote request.
const syntheticFundingCode = '2025X0203-999-99';
const syntheticToken = 'synthetic-browser-token';
const query = { fundingItemsCode: syntheticFundingCode };
const plain = value => JSON.parse(JSON.stringify(value));

function reply(overrides = {}) {
  return {
    status: 200, ok: true, type: 'basic', url: endpoint,
    headers: { get: name => name === 'content-type' ? 'application/json;charset=UTF-8' : null },
    text: async () => JSON.stringify({ synthetic: { rows: [], count: 0 } }),
    ...overrides,
  };
}

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-budgets-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(options = {}) {
  const calls = [], runtime = options.runtime ?? { csrfToken: syntheticToken };
  const elements = options.elements ?? [];
  // Hidden inputs of the real editor; values are the 2026-09-24 snapshot's.
  const form = options.form ?? { mainAccountBook: 'ST00', reimbursementKind: 'applyMoney' };
  const location = { origin: BUDGET_SEARCH_ORIGIN, href: formUrl, ...options.location };
  const page = { isClosed: () => false, on: () => {}, url: () => formUrl };
  const frame = { url: () => formUrl, evaluate: async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
    args, location, window: runtime, document: { querySelectorAll: () => elements,
      getElementById: id => Object.hasOwn(form, id) ? { value: form[id] } : null },
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (...args) => { calls.push(args); return options.fetch ? options.fetch(...args) : options.response ?? reply(); },
  }) };
  return { page, frame, runtime, location, calls, ctx: { page, root: () => frame } };
}

function input(value) { return { tagName: 'INPUT', value }; }

test('form payload leaves form-provided fields empty, keeps explicit parameters, lowercase pagesize and fixed sortfields', () => {
  assert.deepEqual(buildBudgetSearchPayload(query), { accountBook: '', reimbursementKind: '',
    fundingItemsCode: syntheticFundingCode, page: '1', pagesize: '20', sortfields: '[]' });
  const payload = buildBudgetSearchPayload({ ...query, accountBook: 'TEST', reimbursementKind: 'testKind', page: 3, pagesize: 50 });
  assert.equal(payload.accountBook, 'TEST');
  assert.equal(payload.reimbursementKind, 'testKind');
  assert.equal(payload.page, '3');
  assert.equal(payload.pagesize, '50');
  for (const value of [null, {}, [], { ...query, page: 0 }, { ...query, page: 1.1 }, { ...query, pagesize: 101 },
    { ...query, pageSize: 20 }, { ...query, sortfields: '[]' }, { ...query, csrfToken: 'forbidden' },
    { ...query, fundingItemsCode: 'code&admin=true' }, { ...query, accountBook: 'A\nB' },
    { ...query, reimbursementKind: 3 }, { ...query, page: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => buildBudgetSearchPayload(value), { code: 'invalid_query' });
  }
});

test('actual frame callback sends encoded same-origin POST without manually copying cookies or Referer', async () => {
  const f = fixture();
  const result = await searchBudgetOutlays(f.ctx, query);
  assert.equal(f.calls.length, 1);
  const [url, request] = f.calls[0];
  assert.equal(url, endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.mode, 'same-origin');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.headers.csrfToken, syntheticToken);
  assert.equal(request.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.match(request.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Content-Type', 'X-Requested-With', 'csrfToken']);
  assert.equal(request.body, `accountBook=ST00&reimbursementKind=applyMoney&fundingItemsCode=${syntheticFundingCode}&page=1&pagesize=20&sortfields=%5B%5D`);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(plain(result.response), { synthetic: { rows: [], count: 0 } });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-browser-token/);
});

test('each explicit token source works, including the browser named-element Window alias', async () => {
  const element = input(syntheticToken);
  for (const config of [
    { runtime: {}, elements: [input(syntheticToken)] },
    { runtime: {}, elements: [{ tagName: 'META', getAttribute: name => name === 'content' ? syntheticToken : null }] },
    { runtime: { csrfToken: element }, elements: [element] },
    { runtime: { jQuery: { ajaxSettings: { headers: { CSRFToken: syntheticToken } } } } },
    { runtime: { $: { ajaxSettings: { headers: { csrfToken: syntheticToken } } } } },
    { runtime: { csrfToken: syntheticToken }, elements: [input(syntheticToken), input('')] },
  ]) {
    const f = fixture(config);
    await searchBudgetOutlays(f.ctx, query);
    assert.equal(f.calls[0][1].headers.csrfToken, syntheticToken);
  }
});

test('the live editor #csrfTokenElement is a token source and must agree with other candidates', async () => {
  const element = { tagName: 'INPUT', id: 'csrfTokenElement', value: syntheticToken };
  const f = fixture({ runtime: {}, elements: [element] });
  await searchBudgetOutlays(f.ctx, query);
  assert.equal(f.calls[0][1].headers.csrfToken, syntheticToken);
  const conflict = fixture({ runtime: { csrfToken: 'other-token' }, elements: [element] });
  await assert.rejects(searchBudgetOutlays(conflict.ctx, query), { code: 'csrf_ambiguous' });
  assert.equal(conflict.calls.length, 0);
});

test('account book and reimbursement kind come from the open form unless explicitly given', async () => {
  const f = fixture({ form: { mainAccountBook: 'BOOK1', reimbursementKind: 'otherKind' } });
  const result = await searchBudgetOutlays(f.ctx, query);
  const body = new URLSearchParams(f.calls[0][1].body);
  assert.equal(body.get('accountBook'), 'BOOK1');
  assert.equal(body.get('reimbursementKind'), 'otherKind');
  assert.equal(result.query.accountBook, 'BOOK1');
  assert.equal(result.query.reimbursementKind, 'otherKind');
  const explicit = fixture({ form: { mainAccountBook: 'BOOK1', reimbursementKind: 'otherKind' } });
  await searchBudgetOutlays(explicit.ctx, { ...query, accountBook: 'ST00' });
  assert.equal(new URLSearchParams(explicit.calls[0][1].body).get('accountBook'), 'ST00');
  for (const form of [{}, { mainAccountBook: 'ST00' }, { mainAccountBook: 'bad book', reimbursementKind: 'applyMoney' },
    { mainAccountBook: 'ST00', reimbursementKind: '' }]) {
    const missing = fixture({ form });
    await assert.rejects(searchBudgetOutlays(missing.ctx, query), { code: 'form_context_missing' });
    assert.equal(missing.calls.length, 0);
  }
});

// Envelope and field names from the 2026-10-15 live response; values are synthetic.
const outlayRow = (code, name, projectCode = syntheticFundingCode) => ({ quotaName: '合成额度', budgetBalance: '100.00',
  expenditureItemCode: code, projectCode, showAmount: '', projectName: '合成项目', expenditureItemName: name, quotaCode: '02' });
const liveEnvelope = rows => ({ status: 0, data: { requireAmount: '100.00', showAmount: '', Total: rows.length,
  fundingManager: '000000', Rows: rows } });

test('live { status: 0, data: { Rows, Total } } responses are parsed into outlays for the requested project only', async () => {
  const f = fixture({ response: reply({ text: async () => JSON.stringify(liveEnvelope([
    outlayRow('01', '办公费'), outlayRow('05', '国内差旅费'), outlayRow('09', '别的项目', 'OTHER-1'), outlayRow('', '无编号'),
  ])) }) });
  const result = await searchBudgetOutlays(f.ctx, query);
  // The balance OA withholds from this user (showAmount '') stays hidden: budgetBalance and requireAmount are not read.
  assert.deepEqual(plain(result.outlays), { total: 4, skipped: 2, rows: [
    { expenditureItemCode: '01', expenditureItemName: '办公费', quotaCode: '02', quotaName: '合成额度',
      showAmount: '', projectCode: syntheticFundingCode, projectName: '合成项目' },
    { expenditureItemCode: '05', expenditureItemName: '国内差旅费', quotaCode: '02', quotaName: '合成额度',
      showAmount: '', projectCode: syntheticFundingCode, projectName: '合成项目' },
  ] });
  const shown = parseBudgetOutlays({ status: 0, data: { requireAmount: '100.00', showAmount: '100.00', Total: 1,
    Rows: [{ ...outlayRow('01', '办公费'), showAmount: '60.00' }] } }, syntheticFundingCode);
  assert.deepEqual([shown.showAmount, shown.rows[0].showAmount], ['100.00', '60.00'], 'an authorized balance is the one OA shows');
  assert.deepEqual(plain(parseBudgetOutlays({ Rows: [], Total: '0' }, syntheticFundingCode)), { total: 0, rows: [], skipped: 0 });
  for (const value of [{ status: 1, data: { Rows: [] } }, { status: '500', msg: 'x' }, { data: { Rows: {} } },
    { rows: [] }, [], null, { synthetic: { rows: [], count: 0 } }]) {
    assert.equal(parseBudgetOutlays(value, syntheticFundingCode), undefined);
  }
  const other = fixture();
  assert.equal((await searchBudgetOutlays(other.ctx, query)).outlays, undefined);
});

test('procTaskId header mirrors the editor #jobPageId only when it is a valid task UUID', async () => {
  const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const f = fixture({ form: { mainAccountBook: 'ST00', reimbursementKind: 'applyMoney', jobPageId: taskId } });
  await searchBudgetOutlays(f.ctx, query);
  assert.equal(f.calls[0][1].headers.procTaskId, taskId);
  const bad = fixture({ form: { mainAccountBook: 'ST00', reimbursementKind: 'applyMoney', jobPageId: 'x\r\nInjected: 1' } });
  await searchBudgetOutlays(bad.ctx, query);
  assert.equal(bad.calls[0][1].headers.procTaskId, undefined);
});

test('missing, conflicting, invalid token and URL-only token stop before fetch', async () => {
  for (const [config, code] of [
    [{ runtime: {} }, 'csrf_missing'],
    [{ runtime: {}, elements: [input('')] }, 'csrf_missing'],
    [{ elements: [input('different-token')] }, 'csrf_ambiguous'],
    [{ runtime: { csrfToken: 'bad\r\nheader' } }, 'csrf_invalid'],
    [{ runtime: { csrfToken: {} } }, 'csrf_invalid'],
    [{ runtime: { csrfToken: 'a'.repeat(4097) } }, 'csrf_invalid'],
  ]) {
    const f = fixture(config);
    await assert.rejects(searchBudgetOutlays(f.ctx, query), { code });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ runtime: {} });
  f.location.href = `${formUrl}&csrfToken=not-an-ajax-token`;
  f.frame.url = () => f.location.href;
  await assert.rejects(searchBudgetOutlays(f.ctx, query), { code: 'csrf_missing' });
  assert.equal(f.calls.length, 0);
});

test('token is read afresh on every call and echoed tokens are redacted before reaching Node', async () => {
  const f = fixture({ response: reply({ text: async () => JSON.stringify({ csrfToken: syntheticToken,
    detail: `echo ${syntheticToken}`, nested: [syntheticToken] }) }) });
  const result = await searchBudgetOutlays(f.ctx, query);
  assert.deepEqual(plain(result.response), { csrfToken: '[REDACTED]', detail: 'echo [REDACTED]', nested: ['[REDACTED]'] });
  f.runtime.csrfToken = 'rotated-synthetic-token';
  await searchBudgetOutlays(f.ctx, query);
  assert.equal(f.calls[1][1].headers.csrfToken, 'rotated-synthetic-token');
});

test('active iframe is used and unavailable origins, closed pages and navigation races do not send', async () => {
  const valid = fixture();
  valid.page.url = () => 'https://egate-new.shanghaitech.edu.cn/green/index.html';
  valid.page.evaluate = () => { throw Error('must use active frame'); };
  await searchBudgetOutlays(valid.ctx, query);
  assert.equal(valid.calls.length, 1);
  for (const url of ['https://sapbpm-new.shanghaitech.edu.cn.evil.invalid/bpm-new/test',
    'http://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/test', 'https://sapbpm-new.shanghaitech.edu.cn/bpm-new/test',
    `${BUDGET_SEARCH_ORIGIN}/authserver/login`, 'not a url']) {
    const f = fixture(); f.frame.url = () => url;
    await assert.rejects(searchBudgetOutlays(f.ctx, query), { code: 'bpm_unavailable' });
    assert.equal(f.calls.length, 0);
  }
  const closed = fixture(); closed.page.isClosed = () => true;
  await assert.rejects(searchBudgetOutlays(closed.ctx, query), { code: 'bpm_unavailable' });
  for (const location of [{ origin: 'https://other.invalid' }, { href: `${formUrl}&new-document=1` }]) {
    const f = fixture({ location });
    await assert.rejects(searchBudgetOutlays(f.ctx, query), { code: 'bpm_unavailable' });
    assert.equal(f.calls.length, 0);
  }
});

test('auth failures, redirects, HTTP errors and wrong final endpoints stop before reading bodies', async () => {
  for (const [overrides, code] of [
    [{ status: 401 }, 'authentication'], [{ status: 403 }, 'authentication'], [{ status: 302 }, 'authentication'],
    [{ type: 'opaqueredirect', status: 0 }, 'authentication'], [{ status: 500, ok: false }, 'http_error'],
    [{ url: `${endpoint}?wrong=1` }, 'response_invalid'],
    [{ headers: { get: name => name === 'content-length' ? String(6 * 1024 * 1024) : null } }, 'response_invalid'],
  ]) {
    let read = false;
    const f = fixture({ response: reply({ ...overrides, text: async () => { read = true; return '{}'; } }) });
    await assert.rejects(searchBudgetOutlays(f.ctx, query), { code });
    assert.equal(read, false);
  }
});

test('legacy text JSON and business errors retain their envelope without invented rows or success', async () => {
  const payload = { code: 'SYNTHETIC_ERROR', data: null, message: 'permission issue' };
  for (const type of ['application/json', 'text/plain', 'text/html']) {
    const f = fixture({ response: reply({ headers: { get: name => name === 'content-type' ? type : null },
      text: async () => JSON.stringify(payload) }) });
    const result = await searchBudgetOutlays(f.ctx, query);
    assert.deepEqual(plain(result.response), payload);
    assert.equal(result.success, undefined);
    assert.equal(result.rows, undefined);
  }
});

test('HTML, malformed, scalar, empty and oversized data are errors instead of empty budgets', async () => {
  for (const [body, type, code] of [
    ['<html>login</html>', 'text/html', 'non_json'], ['{broken', 'application/json', 'response_invalid'],
    ['null', 'application/json', 'response_invalid'], ['"string"', 'text/plain', 'response_invalid'],
    ['', 'application/json', 'response_invalid'], ['x'.repeat(5 * 1024 * 1024 + 1), 'text/plain', 'response_invalid'],
  ]) {
    const f = fixture({ response: reply({ headers: { get: name => name === 'content-type' ? type : null }, text: async () => body }) });
    await assert.rejects(searchBudgetOutlays(f.ctx, query), { code });
  }
});

test('timeouts, network and page exceptions expose fixed errors only', async () => {
  const timeout = fixture({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('PRIVATE token')));
  }) });
  await assert.rejects(searchBudgetOutlays(timeout.ctx, query, 5), { code: 'timeout' });
  const network = fixture({ fetch: () => { throw Error('PRIVATE cookie'); } });
  const page = fixture(); page.frame.evaluate = async () => { throw Error('PRIVATE ticket'); };
  for (const f of [network, page]) await assert.rejects(searchBudgetOutlays(f.ctx, query), error => {
    assert.equal(error.code, 'request_failed'); assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
  const invalid = fixture();
  await assert.rejects(searchBudgetOutlays(invalid.ctx, query, 60001), { code: 'invalid_query' });
  assert.equal(invalid.calls.length, 0);
});

test('CLI validates explicit project and original-form IDs, optional parameters and help before browser startup', () => {
  assert.deepEqual(parseBudgetArgs(['--help']), { help: true });
  const parsed = parseBudgetArgs([...cliArgs, '--account-book', 'TEST', '--reimbursement-kind', 'testKind',
    '--page', '2', '--page-size', '50', '--document-number', 'A123456']);
  assert.equal(parsed.query.fundingItemsCode, syntheticFundingCode);
  assert.equal(parsed.query.page, 2);
  assert.equal(parsed.query.pagesize, 50);
  assert.equal(parsed.target.expectedDocumentNumber, 'A123456');
  assert.equal(parsed.target.isReadOnly, false);
  assert.equal(parseBudgetArgs(cliArgs).query.accountBook, undefined);
  const keyword = parseBudgetArgs(['--funding-keyword', ' 合成项目 ', ...cliArgs.slice(2)]);
  assert.equal(keyword.fundingKeyword, '合成项目');
  assert.equal(keyword.query.fundingItemsCode, '');
  const byNumber = parseBudgetArgs(['--funding-code', syntheticFundingCode, '--document-number', 'A209900000015']);
  assert.equal(byNumber.documentNumber, 'A209900000015');
  assert.equal(byNumber.target, undefined);
  for (const args of [[], ['--funding-code', syntheticFundingCode], [...cliArgs, '--page', '1.5'],
    [...cliArgs, '--page-size', '0'], [...cliArgs, '--cookie', 'do-not-accept'],
    [...cliArgs, '--csrf-token', 'do-not-accept'], [...cliArgs, '--url', 'https://other.invalid'],
    [...cliArgs, '--funding-keyword', '合成项目'], ['--funding-keyword', '  ', ...cliArgs.slice(2)],
    ['--funding-code', syntheticFundingCode, '--document-number', 'invalid'],
    [...cliArgs, '--funding-kind', 'responsible'], ['--funding-keyword', 'x', '--funding-kind', 'mine', ...cliArgs.slice(2)],
    ['--funding-code', syntheticFundingCode, '--biz-id', 'A'.repeat(32), '--document-number', 'A1']]) {
    assert.throws(() => parseBudgetArgs(args));
  }
});

test('results are unique private files and never contain an echoed current token', async t => {
  const directory = temp(t);
  const f = fixture({ response: reply({ text: async () => JSON.stringify({ csrfToken: syntheticToken }) }) });
  const result = await searchBudgetOutlays(f.ctx, query);
  const first = await saveBudgetResponse(result, directory), second = await saveBudgetResponse(result, directory);
  assert.notEqual(first, second);
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
  assert.doesNotMatch(fs.readFileSync(first, 'utf8'), /synthetic-browser-token/);
});

test('CLI opens existing form before querying, saves results, and closes on success and failure', async t => {
  const directory = temp(t), oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.OA_DATA_DIR = directory;
  process.env.PLAYWRIGHT_CDP_ENDPOINT = 'not-used';
  process.env.CHROME_DEBUGGER_ADDRESS = 'not-used';
  t.mock.method(require('dotenv'), 'config', () => ({}));
  const logs = t.mock.method(console, 'log', () => {});
  const f = fixture(), session = { page: f.page, restoredSession: true };
  const events = [], browser = require('../dist/automation/browser');
  t.mock.method(browser, 'createBrowserSession', async () => {
    assert.equal(process.env.PLAYWRIGHT_CDP_ENDPOINT, undefined);
    assert.equal(process.env.CHROME_DEBUGGER_ADDRESS, undefined);
    events.push('create'); return session;
  });
  t.mock.method(browser, 'rememberAuthenticatedSession', async () => { events.push('remember'); });
  const close = t.mock.method(browser, 'closeBrowserSession', async () => { events.push('close'); });
  t.mock.method(require('../dist/automation/auth'), 'authenticateSchool', async (_page, options) => {
    assert.equal(options.mode, 'manual'); assert.equal(options.reuseSession, true);
    events.push('auth'); return f.page;
  });
  t.mock.method(require('../dist/automation/open-reimbursement'), 'openReimbursementByIds', async (_session, ctx, target) => {
    assert.equal(target.bizId, 'A'.repeat(32)); ctx.setActiveFrame(f.frame); events.push('open');
  });
  await main(cliArgs);
  assert.deepEqual(events, ['create', 'auth', 'open', 'remember', 'close']);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readdirSync(path.join(directory, 'oa-budget-search')).length, 1);
  f.runtime.csrfToken = undefined;
  await assert.rejects(main(cliArgs), { code: 'csrf_missing' });
  assert.equal(close.mock.callCount(), 2);
  assert.equal(fs.readdirSync(path.join(directory, 'oa-budget-search')).length, 1);
  assert.doesNotMatch(JSON.stringify(logs.mock.calls.map(call => call.arguments)), /synthetic-browser-token/);
});

test('CLI resolves the form from the todo list and the funding code from the list, then queries with form context', async t => {
  const directory = temp(t), oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.OA_DATA_DIR = directory;
  t.mock.method(require('dotenv'), 'config', () => ({}));
  t.mock.method(console, 'log', () => {});
  const f = fixture(), events = [];
  const session = { page: f.page, restoredSession: true, context: { synthetic: 'bpm-context' } };
  const browser = require('../dist/automation/browser');
  t.mock.method(browser, 'createBrowserSession', async () => session);
  t.mock.method(browser, 'rememberAuthenticatedSession', async () => {});
  t.mock.method(browser, 'closeBrowserSession', async () => { events.push('close'); });
  t.mock.method(require('../dist/automation/auth'), 'authenticateSchool', async () => f.page);
  t.mock.method(require('../dist/automation/reimbursement-list'), 'resolveListTarget', async (received, documentNumber, isReadOnly) => {
    assert.equal(received, session); assert.equal(documentNumber, 'A209900000015'); events.push('todo');
    return { target: { bizId: 'B'.repeat(32), taskId: '11111111-2222-3333-4444-555555555555', isReadOnly,
      expectedDocumentNumber: documentNumber }, row: { statusText: '预制' }, task: { name: '申请', statusId: 'ready' } };
  });
  t.mock.method(require('../dist/automation/open-reimbursement'), 'openReimbursementByIds', async (_session, ctx, target) => {
    assert.deepEqual(target, { bizId: 'B'.repeat(32), taskId: '11111111-2222-3333-4444-555555555555',
      isReadOnly: false, expectedDocumentNumber: 'A209900000015' });
    ctx.setActiveFrame(f.frame); events.push('open');
  });
  const funding = require('../dist/automation/funding-search');
  const projects = [{ projectId: 'SYN-0001', label: 'SYN-0001-合成科研' }, { projectId: 'SYN-0002', label: 'SYN-0002-合成教学' }];
  const kinds = [];
  t.mock.method(funding, 'searchFundingItems', async (ctx, options) => {
    assert.equal(ctx.root(), f.frame); kinds.push(options.kind); events.push('funds');
    return { list: { items: projects, skipped: 0 } };
  });
  await main(['--funding-keyword', '教学', '--document-number', 'A209900000015']);
  assert.deepEqual(events, ['todo', 'open', 'funds', 'close']);
  assert.deepEqual(kinds, [undefined]);
  const body = new URLSearchParams(f.calls[0][1].body);
  assert.deepEqual([body.get('fundingItemsCode'), body.get('accountBook'), body.get('reimbursementKind')],
    ['SYN-0002', 'ST00', 'applyMoney']);
  await assert.rejects(main(['--funding-keyword', '合成', '--funding-kind', 'responsible',
    '--document-number', 'A209900000015']), { code: 'item_ambiguous' });
  assert.equal(kinds[1], 'responsible');
  assert.equal(f.calls.length, 1);
  assert.equal(events.at(-1), 'close');
});
