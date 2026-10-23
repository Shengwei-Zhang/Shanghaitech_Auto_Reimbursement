const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTodoSearchPayload, searchTodoTasks, extractTodoTargets, selectTodoTarget,
  TASK_SEARCH_ORIGIN, TASK_SEARCH_PATH } = require('../dist/automation/task-search');
const { parseTodoArgs, saveTodoResponse, main } = require('../dist/tasks');

function reply(overrides = {}) {
  return { status: 200, ok: true, type: 'basic', headers: { get: () => 'application/json;charset=UTF-8' },
    text: async () => JSON.stringify({ synthetic: { rows: [], count: 0 } }), ...overrides };
}

function portal(response = reply(), origin = TASK_SEARCH_ORIGIN) {
  const calls = [];
  const fetch = async (...args) => { calls.push(args); return response; };
  return { calls, url: () => `${TASK_SEARCH_ORIGIN}/CUS_TEMPLATE_OFFICIAL/pc/index.html`, isClosed: () => false,
    // Run the actual browser callback in a separate JS realm without network,
    // rather than substituting the callback's expected return value.
    evaluate: async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
      args, location: { origin }, fetch, URL, AbortController, setTimeout, clearTimeout,
    }),
  };
}

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-tasks-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('payload reproduces supplied search defaults with a fresh timestamp and no caller-controlled type', () => {
  assert.deepEqual(buildTodoSearchPayload({}, 123), {
    type: 1, pageNumber: 1, pageSize: 10, subject: '', bizSceneCode: '', startTime: '', endTime: '',
    taskType: '', priority: '', isExpire: '', isIgnore: '0', _t: 123,
  });
  const before = Date.now();
  const query = buildTodoSearchPayload({ pageNumber: 3, pageSize: 25, subject: ' A209900000015 ', isIgnore: '1' });
  assert.equal(query.pageNumber, 3);
  assert.equal(query.pageSize, 25);
  assert.equal(query.subject, 'A209900000015');
  assert.ok(query._t >= before && query._t <= Date.now());
  for (const options of [{ pageNumber: 0 }, { pageNumber: 1.5 }, { pageNumber: Infinity }, { pageSize: 101 },
    { pageSize: 0 }, { pageSize: '10' }, { type: 2 }, { _t: 1 }, { url: 'https://example.org' },
    { subject: 3 }, { subject: 'a\nb' }, { isIgnore: '2' }, { subject: 'a'.repeat(501) }, null]) {
    assert.throws(() => buildTodoSearchPayload(options), { code: 'invalid_query' });
  }
});

test('in-page request uses fixed POST endpoint and browser cookies, without copied browser headers', async () => {
  const page = portal();
  const result = await searchTodoTasks(page, { subject: 'A209900000015', pageNumber: 2 });
  assert.equal(page.calls.length, 1);
  const [url, request] = page.calls[0];
  assert.equal(url, TASK_SEARCH_ORIGIN + TASK_SEARCH_PATH);
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.mode, 'same-origin');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.cache, 'no-store');
  assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Content-Type']);
  assert.equal(JSON.parse(request.body).subject, 'A209900000015');
  assert.equal(JSON.parse(request.body).pageNumber, 2);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(result.response)), { synthetic: { rows: [], count: 0 } });
});

test('only the exact HTTPS origin and a known portal shell may send the request', async () => {
  for (const url of ['https://egate-new.shanghaitech.edu.cn.evil.invalid/green/index.html',
    'http://egate-new.shanghaitech.edu.cn/green/index.html',
    'https://egate-new.shanghaitech.edu.cn:9091/green/index.html',
    'https://egate-new.shanghaitech.edu.cn/login?ticket=synthetic', 'about:blank']) {
    const page = portal(); page.url = () => url;
    await assert.rejects(searchTodoTasks(page), { code: 'portal_unavailable' });
    assert.equal(page.calls.length, 0);
  }
  const closed = portal(); closed.isClosed = () => true;
  await assert.rejects(searchTodoTasks(closed), { code: 'portal_unavailable' });
});

test('navigation race to another origin is detected inside page evaluation before fetch', async () => {
  const page = portal(reply(), 'https://another.invalid');
  await assert.rejects(searchTodoTasks(page), { code: 'portal_unavailable' });
  assert.equal(page.calls.length, 0);
});

test('authentication errors and redirects stop without reading a response body or following a new URL', async () => {
  for (const extra of [{ status: 401 }, { status: 403 }, { status: 302 }, { type: 'opaqueredirect', status: 0 }]) {
    let read = false;
    const page = portal(reply({ ...extra, text: async () => { read = true; return 'PRIVATE'; } }));
    await assert.rejects(searchTodoTasks(page), { code: 'authentication' });
    assert.equal(read, false);
    assert.equal(page.calls.length, 1);
  }
});

test('HTTP errors, HTML, malformed JSON, scalar and oversized JSON are not empty lists', async () => {
  for (const [response, code] of [
    [reply({ ok: false, status: 500 }), 'http_error'],
    [reply({ headers: { get: () => 'text/html' }, text: async () => '<html>PRIVATE login</html>' }), 'non_json'],
    [reply({ text: async () => '{PRIVATE' }), 'response_invalid'],
    [reply({ text: async () => 'null' }), 'response_invalid'],
    [reply({ text: async () => '"PRIVATE"' }), 'response_invalid'],
    [reply({ text: async () => 'x'.repeat(5 * 1024 * 1024 + 1) }), 'response_invalid'],
  ]) {
    await assert.rejects(searchTodoTasks(portal(response)), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
  }
});

test('unknown response envelope including business-error JSON is preserved, never converted to success or tasks', async () => {
  const data = { code: 'UNKNOWN_ERROR', data: null, message: 'synthetic failure' };
  const result = await searchTodoTasks(portal(reply({ text: async () => JSON.stringify(data) })));
  assert.deepEqual(JSON.parse(JSON.stringify(result.response)), data);
  assert.equal(result.tasks, undefined);
  assert.equal(result.success, undefined);
});

test('network timeout and page failure expose fixed errors, without sensitive underlying messages', async () => {
  const page = portal();
  page.evaluate = async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
    args, location: { origin: TASK_SEARCH_ORIGIN }, URL, AbortController, setTimeout, clearTimeout,
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('PRIVATE token')));
    }),
  });
  await assert.rejects(searchTodoTasks(page, {}, 5), { code: 'timeout' });
  page.evaluate = async () => { throw Error('PRIVATE page url ticket'); };
  await assert.rejects(searchTodoTasks(page), error => {
    assert.equal(error.code, 'request_failed');
    assert.doesNotMatch(error.message, /PRIVATE|ticket/);
    return true;
  });
});

const bizA = 'A'.repeat(32), bizB = 'b'.repeat(32), bizC = 'C'.repeat(32);
const taskA = '11111111-2222-3333-4444-555555555555', taskB = '66666666-7777-8888-9999-000000000000';
const formLink = (bizId, taskId) => 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/'
  + `showLoadRbReimbursement.job?isReadOnly=false&bizId=${bizId}&taskId=${taskId}`;

test('todo targets come from BPM form links (also wrapped by SSO) or sibling bizId/taskId fields', () => {
  const sso = `https://ids.shanghaitech.edu.cn/authserver/login?service=${encodeURIComponent(formLink(bizB, taskB))}`;
  const response = { code: 0, data: { records: [
    { subject: '报销单 A209900000016 待审批', url: formLink(bizA, taskA) },
    { title: '单据A209900000017', pcUrl: sso },
    { subject: 'A209900000018', extend: { bizId: bizC, taskId: taskA } },
    { subject: '重复', url: formLink(bizA.toLowerCase(), taskA) },
    { subject: 'A209900000019 与 A209900000020', url: formLink(bizC, taskB) },
  ] } };
  assert.deepEqual(extractTodoTargets(response).map(target => ({ ...target })), [
    { bizId: bizA, taskId: taskA, documentNumber: 'A209900000016', source: 'link', kind: 'handling', path: '$.data.records[0]' },
    { bizId: bizB, taskId: taskB, documentNumber: 'A209900000017', source: 'link', kind: 'handling', path: '$.data.records[1]' },
    { bizId: bizC, taskId: taskA, documentNumber: '', source: 'fields', kind: 'handling', path: '$.data.records[2].extend' },
    { bizId: bizC, taskId: taskB, documentNumber: '', source: 'link', kind: 'handling', path: '$.data.records[4]' },
  ]);
});

test('live portal envelope: handling todos are selectable, 通知任务 pointing at the same form are not', () => {
  // Shapes from the 2026-10-15 portal response; identifiers are synthetic.
  const notice = 'cccccccc-dddd-eeee-ffff-000000000000_abc';
  const response = { errcode: '0', errmsg: 'success', total: 3, pages: 1, datas: [
    { subject: '张三[用款申请单-A209900000016](2026-10-14)', nodeName: '网上预约报销申请单', bizKey: bizA,
      taskId: 'portal-1', pcViewUrl: formLink(bizA, taskA), h5ViewUrl: formLink(bizA, taskA) },
    { subject: '通知任务:网上报销打印通知：张三[A209900000016]', nodeName: '通知任务:网上预约报销单', bizKey: notice,
      taskId: 'portal-2', pcViewUrl: formLink(bizA, taskB).replace('?', '?isReadOnly=true&') },
    { subject: '通知任务:您提交的报销单[D209900000035]已被驳回!', nodeName: '网上预约报销单', bizKey: notice,
      pcViewUrl: formLink(bizB, taskB) },
    { subject: '合同审批申请', pcViewUrl: 'https://oa.shanghaitech.edu.cn/workflow/request/ViewRequest.jsp?requestid=1' },
  ] };
  const targets = extractTodoTargets(response);
  assert.deepEqual(targets.map(target => [target.bizId, target.taskId, target.documentNumber, target.kind]), [
    [bizA, taskA, 'A209900000016', 'handling'],
    [bizA, taskB, 'A209900000016', 'notification'],
    [bizB, taskB, '', 'notification'],
  ]);
  assert.equal(selectTodoTarget(targets, 'A209900000016').taskId, taskA);
  assert.throws(() => selectTodoTarget(targets.slice(1), 'A209900000016'), { code: 'target_missing' });
});

test('non-BPM, wrong-path, duplicated-parameter and malformed links yield no target', () => {
  const link = formLink(bizA, taskA);
  for (const url of [link.replace('sapbpm-new.shanghaitech.edu.cn', 'sapbpm-new.evil.invalid'),
    link.replace(':9091', ''), link.replace('showLoadRbReimbursement.job', 'forwardAddRbReimbursement.do'),
    `${link}&bizId=${bizB}`, link.replace(taskA, 'not-a-task'), link.replace(bizA, 'A'.repeat(31)),
    `javascript:${link}`, `https://portal.invalid/#%E0%A4%A${encodeURIComponent(link)}`]) {
    assert.deepEqual(extractTodoTargets({ url, subject: 'A209900000016' }), [], url);
  }
  assert.deepEqual(extractTodoTargets({ bizId: bizA, taskId: 'x' }), []);
  assert.deepEqual(extractTodoTargets(null), []);
});

test('selection requires one target for the bill code and never guesses between candidates', () => {
  const named = (bizId, documentNumber) => ({ bizId, taskId: taskA, documentNumber, source: 'link', kind: 'handling', path: '$' });
  const one = named(bizA, 'A209900000016'), other = named(bizB, 'A209900000017'), unnamed = named(bizC, '');
  assert.equal(selectTodoTarget([one, other, unnamed], 'A209900000016'), one);
  assert.equal(selectTodoTarget([unnamed], 'A209900000016'), unnamed);
  assert.throws(() => selectTodoTarget([other, unnamed], 'A209900000016'), { code: 'target_missing' });
  assert.throws(() => selectTodoTarget([], 'A209900000016'), { code: 'target_missing' });
  assert.throws(() => selectTodoTarget([unnamed, named(bizA, '')], 'A209900000016'), { code: 'target_ambiguous' });
  assert.throws(() => selectTodoTarget([one, named(bizB, 'A209900000016')], 'A209900000016'), { code: 'target_ambiguous' });
});

test('CLI maps options, supports help and rejects unknown/missing/invalid values before browser startup', () => {
  assert.equal(parseTodoArgs(['--help']).help, true);
  const { query } = parseTodoArgs(['--subject', 'A209900000015', '--page', '2', '--page-size', '20',
    '--biz-scene-code', 'TEST', '--start-time', '2026-10-01', '--end-time', '2026-10-14',
    '--task-type', 'TEST', '--priority', '1', '--is-expire', '0', '--is-ignore', '1']);
  assert.equal(query.subject, 'A209900000015');
  assert.equal(query.pageNumber, 2);
  assert.equal(query.pageSize, 20);
  assert.equal(query.bizSceneCode, 'TEST');
  assert.equal(query.isIgnore, '1');
  for (const args of [['--cookie', 'must-not-accept'], ['--url', 'https://example.org'], ['--subject'],
    ['--page', 'abc'], ['--page-size', '0'], ['--is-ignore', 'invalid']]) {
    assert.throws(() => parseTodoArgs(args));
  }
});

test('query results are written privately under data dir without overwriting earlier results', async t => {
  const directory = temp(t);
  const result = await searchTodoTasks(portal());
  const file = await saveTodoResponse(result, directory);
  const second = await saveTodoResponse(result, directory);
  assert.notEqual(file, second);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(result)));
});

test('CLI logs in, queries and closes its own browser without invoking reimbursement flow', async t => {
  const directory = temp(t), oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.OA_DATA_DIR = directory;
  process.env.PLAYWRIGHT_CDP_ENDPOINT = 'synthetic-personal-browser';
  process.env.CHROME_DEBUGGER_ADDRESS = 'synthetic-personal-browser';
  t.mock.method(require('dotenv'), 'config', () => ({}));
  t.mock.method(console, 'log', () => {});
  const page = portal(), session = { page, restoredSession: true };
  const browser = require('../dist/automation/browser');
  t.mock.method(browser, 'createBrowserSession', async () => {
    assert.equal(process.env.PLAYWRIGHT_CDP_ENDPOINT, undefined);
    assert.equal(process.env.CHROME_DEBUGGER_ADDRESS, undefined);
    return session;
  });
  const remember = t.mock.method(browser, 'rememberAuthenticatedSession', async () => {});
  const close = t.mock.method(browser, 'closeBrowserSession', async () => {});
  t.mock.method(require('../dist/automation/auth'), 'authenticateSchool', async (_page, options) => {
    assert.equal(options.mode, 'manual');
    assert.equal(options.reuseSession, true);
    return page;
  });
  const workflow = t.mock.method(require('../dist/automation/reimbursement-flow'), 'runReimbursementFlowWithErrorHandling',
    async () => { throw Error('must not run'); });
  await main(['--subject', 'A209900000015']);
  assert.equal(page.calls.length, 1);
  assert.equal(remember.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(workflow.mock.callCount(), 0);
  assert.equal(fs.readdirSync(path.join(directory, 'oa-task-search')).length, 1);
});
