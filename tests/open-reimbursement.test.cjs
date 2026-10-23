const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  buildReimbursementUrl, openReimbursementByIds, OpenReimbursementError,
  REIMBURSEMENT_ORIGIN, REIMBURSEMENT_PATH,
} = require('../dist/automation/open-reimbursement');
const { parseOpenArgs, main } = require('../dist/open');

// All identifiers below are synthetic. Browser callbacks run in a separate JS
// realm against a tiny DOM fixture; no real browser or HTTP request is involved.
const target = {
  bizId: 'A'.repeat(32), taskId: '11111111-2222-3333-4444-555555555555',
  expectedDocumentNumber: 'A209900000016',
};
const expectedUrl = buildReimbursementUrl(target);
const args = ['--biz-id', target.bizId, '--task-id', target.taskId,
  '--document-number', target.expectedDocumentNumber];

// Hidden job fields of the real editor (names from the 2026-09-24 snapshot).
const hiddenFields = {
  jobPageBizId: target.bizId, jobPageId: target.taskId, jobPageProcInstId: '99999999-8888-7777-6666-555555555555',
  jobPageProcessDefinitionKey: 'rbReimbursementProc', jobPageProcInstStatusId: 'executing', jobPageStatusId: 'ready',
  mainAccountBook: 'ST00', reimbursementKind: 'applyMoney',
};

function frameFixture(state, getUrl, afterEvaluate) {
  return {
    url: getUrl,
    getByText: () => ({ filter: () => ({ count: async () => state.login ? 1 : 0 }) }),
    evaluate: async (fn, args) => {
      if (state.evaluateError) throw Error('PRIVATE browser ticket from DOM evaluation');
      const markers = state.markers ?? [{ visible: true }];
      const elements = markers.map(marker => ({
        getClientRects: () => marker.visible === false ? [] : [{}],
        display: marker.display ?? 'block', visibility: marker.visibility ?? 'visible',
      }));
      const hidden = state.hidden ?? hiddenFields;
      const result = vm.runInNewContext(`(${fn.toString()})(args)`, {
        args,
        document: {
          getElementById: id => Object.hasOwn(hidden, id) ? { value: hidden[id] } : null,
          body: { innerText: state.text ?? `单据编号：${target.expectedDocumentNumber}` },
          querySelectorAll: selector => {
            assert.equal(selector, '#invoiceGrid, #actualTotalAmount, #reimbursementReimbursementAmount');
            return elements;
          },
        },
        getComputedStyle: element => ({ display: element.display, visibility: element.visibility }),
      });
      afterEvaluate?.();
      return result;
    },
  };
}

function browserFixture(plans = [{}]) {
  const calls = { newPage: 0, gotos: [], bringToFront: 0, priorNavigations: 0, evaluations: 0 };
  let state = {}, currentUrl = 'about:blank';
  const oldPage = { goto: async () => { calls.priorNavigations += 1; throw Error('Must not navigate old page'); } };
  let mainFrame, frames;
  const page = {
    url: () => currentUrl,
    isClosed: () => state.closed === true,
    mainFrame: () => mainFrame,
    frames: () => frames,
    getByText: () => ({ filter: () => ({ count: async () => state.login ? 1 : 0 }) }),
    bringToFront: async () => { calls.bringToFront += 1; },
    waitForTimeout: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    goto: async (destination, options) => {
      calls.gotos.push({ destination, options });
      state = { ...plans[Math.min(calls.gotos.length - 1, plans.length - 1)] };
      if (state.gotoError) throw Error('PRIVATE navigation ticket or Cookie');
      currentUrl = state.url ?? (destination.startsWith('https://ids.shanghaitech.edu.cn/') ? expectedUrl : destination);
      const evaluated = () => {
        calls.evaluations += 1;
        if (state.afterEvaluateUrl) currentUrl = state.afterEvaluateUrl;
        if (state.expireAfterEvaluate) state.login = true;
      };
      mainFrame = frameFixture(state, () => currentUrl, evaluated);
      frames = state.frames
        ? [mainFrame, ...state.frames.map(child => frameFixture(child, () => child.url ?? expectedUrl, evaluated))]
        : [mainFrame];
      return state.noResponse ? null : { status: () => state.status ?? 200 };
    },
  };
  const session = { page: oldPage, context: { newPage: async () => { calls.newPage += 1; return page; } } };
  const ctx = {
    page: oldPage, activeFrame: 'previous-frame', state: { openedFromTodo: false },
    updatePage(next) { this.page = next; this.activeFrame = null; },
    setActiveFrame(next) { this.activeFrame = next; },
  };
  return { calls, page, oldPage, session, ctx };
}

test('direct-open URL uses the fixed observed endpoint and explicit editable/read-only mode', () => {
  const url = new URL(buildReimbursementUrl(target));
  assert.equal(url.origin, REIMBURSEMENT_ORIGIN);
  assert.equal(url.pathname, REIMBURSEMENT_PATH);
  assert.deepEqual([...url.searchParams], [
    ['isReadOnly', 'false'], ['bizId', target.bizId], ['taskId', target.taskId],
  ]);
  assert.equal(new URL(buildReimbursementUrl({ ...target, isReadOnly: true })).searchParams.get('isReadOnly'), 'true');
  assert.equal(url.searchParams.has('expectedDocumentNumber'), false);
});

test('invalid identifiers and timeout are rejected before opening any tab', async () => {
  for (const invalid of [null, {}, { ...target, bizId: '' }, { ...target, bizId: 'A'.repeat(31) },
    { ...target, bizId: 'G'.repeat(32) }, { ...target, bizId: `${target.bizId}&isReadOnly=true` },
    { ...target, taskId: '' }, { ...target, taskId: 42 }, { ...target, taskId: '../create' },
    { ...target, taskId: target.taskId + '\n' }, { ...target, isReadOnly: 'false' },
    { ...target, expectedDocumentNumber: 'A12<script>' }, { ...target, expectedDocumentNumber: 12 }]) {
    const fixture = browserFixture();
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, invalid), { code: 'invalid_target' });
    assert.equal(fixture.calls.newPage, 0);
    assert.equal(fixture.session.page, fixture.oldPage);
  }
  for (const timeout of [0, -1, Infinity, NaN]) {
    const fixture = browserFixture();
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, timeout), { code: 'invalid_target' });
    assert.equal(fixture.calls.newPage, 0);
  }
});

test('opens one new tab, confirms the expected form, and never navigates the existing page', async () => {
  const fixture = browserFixture();
  const result = await openReimbursementByIds(fixture.session, fixture.ctx, target, 100);
  assert.equal(result.page, fixture.page);
  assert.equal(result.documentNumber, target.expectedDocumentNumber);
  assert.equal(result.isReadOnly, false);
  assert.equal(result.identityVerified, true);
  assert.deepEqual({ ...result.context }, { bizId: target.bizId, taskId: target.taskId,
    procInstId: hiddenFields.jobPageProcInstId, documentNumber: '', processDefinitionKey: 'rbReimbursementProc',
    procInstStatusId: 'executing', statusId: 'ready', accountBook: 'ST00', reimbursementKind: 'applyMoney' });
  assert.equal(fixture.session.page, fixture.page);
  assert.equal(fixture.ctx.page, fixture.page);
  assert.equal(fixture.ctx.activeFrame, null);
  assert.equal(fixture.ctx.state.openedFromTodo, true);
  assert.equal(fixture.calls.newPage, 1);
  assert.equal(fixture.calls.priorNavigations, 0);
  assert.equal(fixture.calls.bringToFront, 1);
  assert.deepEqual(fixture.calls.gotos, [{ destination: expectedUrl,
    options: { waitUntil: 'domcontentloaded', timeout: 100 } }]);
});

test('selects a unique BPM iframe and ignores an unrelated frame with form-like content', async () => {
  const fixture = browserFixture([{ text: '', markers: [], frames: [
    { url: 'https://unrelated.invalid/form' },
    { url: `${REIMBURSEMENT_ORIGIN}/bpm-new/form-body` },
  ] }]);
  const result = await openReimbursementByIds(fixture.session, fixture.ctx, { ...target, isReadOnly: true }, 100);
  assert.equal(result.isReadOnly, true);
  assert.equal(fixture.ctx.activeFrame, fixture.page.frames()[2]);
});

test('rejects wrong origin, port, path, IDs, duplicate parameters and read-only changes', async () => {
  const variants = [
    expectedUrl.replace('sapbpm-new.shanghaitech.edu.cn', 'sapbpm-new.shanghaitech.edu.cn.evil.invalid'),
    expectedUrl.replace('https:', 'http:'), expectedUrl.replace(':9091', ''),
    expectedUrl.replace('showLoadRbReimbursement.job', 'forwardAddRbReimbursement.do'),
    expectedUrl.replace(target.bizId, 'B'.repeat(32)),
    expectedUrl.replace(target.taskId, '66666666-7777-8888-9999-000000000000'),
    `${expectedUrl}&taskId=${target.taskId}`, expectedUrl.replace('isReadOnly=false', 'isReadOnly=true'),
    expectedUrl.replace('https://', 'https://user:password@'),
  ];
  for (const url of variants) {
    const fixture = browserFixture([{ url }]);
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code: 'wrong_target' });
    assert.equal(fixture.calls.gotos.length, 1);
    assert.equal(fixture.ctx.state.openedFromTodo, false);
  }
});

test('rejects a different document number instead of reporting that the requested form opened', async () => {
  const fixture = browserFixture([{ text: '单据编号：A209900000022' }]);
  await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code: 'document_mismatch' });
  assert.equal(fixture.calls.gotos.length, 1);
  assert.equal(fixture.ctx.state.openedFromTodo, false);
});

test('hidden job fields must name the requested document; absent fields fall back to URL and bill-code checks', async () => {
  for (const [hidden, code] of [
    [{ ...hiddenFields, jobPageBizId: 'B'.repeat(32) }, 'wrong_target'],
    [{ ...hiddenFields, jobPageId: '66666666-7777-8888-9999-000000000000' }, 'wrong_target'],
    [{ ...hiddenFields, jobPageBizCode: 'A209900000022' }, 'ambiguous_form'],
  ]) {
    const fixture = browserFixture([{ hidden }]);
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code });
    assert.equal(fixture.ctx.state.openedFromTodo, false);
  }
  const lowercase = browserFixture([{ hidden: { ...hiddenFields, jobPageBizId: target.bizId.toLowerCase(),
    jobPageBizCode: target.expectedDocumentNumber } }]);
  const matched = await openReimbursementByIds(lowercase.session, lowercase.ctx, target, 20);
  assert.equal(matched.identityVerified, true);
  assert.equal(matched.context.documentNumber, target.expectedDocumentNumber);
  const legacy = browserFixture([{ hidden: {} }]);
  const opened = await openReimbursementByIds(legacy.session, legacy.ctx, target, 20);
  assert.equal(opened.identityVerified, false);
  assert.equal(opened.context.bizId, '');
  const malformed = browserFixture([{ hidden: { ...hiddenFields, jobPageBizId: 'not-an-id' } }]);
  assert.equal((await openReimbursementByIds(malformed.session, malformed.ctx, target, 20)).identityVerified, false);
});

test('explicit login page, visible expiry and HTTP 401 each recover through exactly one CAS navigation', async () => {
  for (const first of [
    { url: 'https://ids.shanghaitech.edu.cn/authserver/login?ticket=SYNTHETIC' },
    { login: true }, { status: 401 },
  ]) {
    const fixture = browserFixture([first, {}]);
    const result = await openReimbursementByIds(fixture.session, fixture.ctx, target, 100);
    assert.equal(result.documentNumber, target.expectedDocumentNumber);
    assert.equal(fixture.calls.gotos.length, 2);
    assert.equal(fixture.calls.newPage, 1);
    const sso = new URL(fixture.calls.gotos[1].destination);
    assert.equal(sso.origin, 'https://ids.shanghaitech.edu.cn');
    assert.equal(sso.pathname, '/authserver/login');
    assert.equal(sso.searchParams.get('service'), expectedUrl);
  }
});

test('failed CAS recovery stops after two navigations without searching or creating another form', async () => {
  const fixture = browserFixture([{ login: true }, { login: true }]);
  await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code: 'authentication' });
  assert.equal(fixture.calls.gotos.length, 2);
  assert.equal(fixture.calls.newPage, 1);
  assert.equal(fixture.ctx.state.openedFromTodo, false);
});

test('HTTP 403 and server errors stop immediately without SSO retry', async () => {
  for (const [status, code] of [[403, 'forbidden'], [404, 'request_failed'], [500, 'request_failed']]) {
    const fixture = browserFixture([{ status, login: true }]);
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code });
    assert.equal(fixture.calls.gotos.length, 1);
    assert.equal(fixture.ctx.state.openedFromTodo, false);
  }
});

test('unknown pages, creation menus and hidden form controls cannot count as an opened reimbursement', async () => {
  for (const state of [
    { text: '用款申请单 创建', markers: [] }, { text: '服务器页面', markers: [{}] },
    { markers: [] }, { markers: [{ visible: false }] }, { markers: [{ display: 'none' }] },
    { markers: [{ visibility: 'hidden' }] }, { evaluateError: true },
  ]) {
    const fixture = browserFixture([state]);
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 2), { code: 'form_unavailable' });
    assert.equal(fixture.calls.gotos.length, 1);
    assert.equal(fixture.ctx.state.openedFromTodo, false);
  }
});

test('multiple document numbers or multiple matching frames are ambiguous', async () => {
  for (const state of [
    { text: `单据编号：${target.expectedDocumentNumber}\n单据编号：A209900000017` },
    { frames: [{ url: expectedUrl }] },
  ]) {
    const fixture = browserFixture([state]);
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), { code: 'ambiguous_form' });
    assert.equal(fixture.calls.gotos.length, 1);
  }
});

test('rechecks navigation and late session expiry after reading form fields', async () => {
  const moved = browserFixture([{ afterEvaluateUrl: expectedUrl.replace(target.bizId, 'B'.repeat(32)) }]);
  await assert.rejects(openReimbursementByIds(moved.session, moved.ctx, target, 20), { code: 'wrong_target' });
  const expired = browserFixture([{ expireAfterEvaluate: true }, { expireAfterEvaluate: true }]);
  await assert.rejects(openReimbursementByIds(expired.session, expired.ctx, target, 20), { code: 'authentication' });
  assert.equal(expired.calls.gotos.length, 2);
  assert.equal(expired.ctx.state.openedFromTodo, false);
});

test('browser and navigation exceptions expose fixed messages without original tickets or cookies', async () => {
  for (const at of ['newPage', 'goto', 'closed']) {
    const fixture = browserFixture([{ gotoError: at === 'goto', closed: at === 'closed' }]);
    if (at === 'newPage') fixture.session.context.newPage = async () => { throw Error('PRIVATE Cookie ticket'); };
    await assert.rejects(openReimbursementByIds(fixture.session, fixture.ctx, target, 20), error => {
      assert.equal(error.code, 'request_failed');
      assert.doesNotMatch(error.message, /PRIVATE|Cookie|ticket/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('CLI parses explicit target, optional read-only and document checks, and rejects unrelated input', () => {
  assert.deepEqual(parseOpenArgs(['--help']), { help: true });
  assert.deepEqual(parseOpenArgs(args).target, { ...target, isReadOnly: false });
  assert.equal(parseOpenArgs([...args, '--read-only']).target.isReadOnly, true);
  assert.deepEqual(parseOpenArgs(['--document-number', target.expectedDocumentNumber, '--read-only']),
    { help: false, resolve: { documentNumber: target.expectedDocumentNumber, isReadOnly: true } });
  for (const invalid of [[], ['--biz-id', target.bizId], ['--task-id', target.taskId],
    ['--document-number', 'invalid'], ['--biz-id', target.bizId, '--document-number', target.expectedDocumentNumber],
    [...args, '--url', expectedUrl], [...args, '--cookie', 'synthetic'], [...args, '--unknown'],
    [...args, '--document-number', 'invalid'], ['--biz-id']]) assert.throws(() => parseOpenArgs(invalid));
});

function cliFixture(t) {
  const events = [], savedEnv = { ...process.env };
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    process.env = savedEnv;
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else delete process.stdin.isTTY;
  });
  process.env.PLAYWRIGHT_CDP_ENDPOINT = 'synthetic-existing-browser';
  process.env.CHROME_DEBUGGER_ADDRESS = 'synthetic-existing-browser';
  t.mock.method(require('dotenv'), 'config', () => ({}));
  t.mock.method(console, 'log', () => {});
  const page = { on: () => {} }, authenticatedPage = { on: () => {} }, openedPage = { on: () => {} };
  const browserEmitter = new EventEmitter();
  browserEmitter.close = async () => { events.push('browser-close'); };
  const session = { page, browser: browserEmitter, restoredSession: true };
  const browser = require('../dist/automation/browser');
  t.mock.method(browser, 'createBrowserSession', async () => {
    events.push('create');
    assert.equal(process.env.PLAYWRIGHT_CDP_ENDPOINT, undefined);
    assert.equal(process.env.CHROME_DEBUGGER_ADDRESS, undefined);
    assert.equal(process.env.OA_LOGIN_MODE, 'manual');
    assert.equal(process.env.HEADLESS, 'false');
    return session;
  });
  t.mock.method(require('../dist/automation/auth'), 'authenticateSchool', async (original, options) => {
    events.push('authenticate');
    assert.equal(original, page);
    assert.deepEqual(options, { mode: 'manual', reuseSession: true });
    return authenticatedPage;
  });
  const openMock = t.mock.method(require('../dist/automation/open-reimbursement'), 'openReimbursementByIds',
    async (receivedSession, ctx, receivedTarget) => {
      events.push('open');
      assert.equal(receivedSession, session);
      assert.equal(ctx.page, authenticatedPage);
      assert.deepEqual(receivedTarget, { ...target, isReadOnly: false });
      session.page = openedPage;
      return { page: openedPage, documentNumber: target.expectedDocumentNumber, isReadOnly: false,
        identityVerified: true, context: { bizId: target.bizId, taskId: target.taskId, procInstStatusId: 'executing',
          statusId: 'ready', accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
    });
  t.mock.method(browser, 'rememberAuthenticatedSession', async received => {
    events.push('remember');
    assert.equal(received.page, openedPage);
  });
  t.mock.method(browser, 'closeBrowserSession', async received => {
    events.push('close');
    assert.equal(received, session);
  });
  t.mock.method(require('node:readline/promises'), 'createInterface', options => {
    events.push('readline');
    assert.equal(options.input, process.stdin);
    return {
      question: async (_question, { signal }) => {
        events.push('hold');
        assert.equal(signal.aborted, false);
        assert.equal(events.includes('remember'), true);
      },
      close: () => { events.push('readline-close'); },
    };
  });
  const workflow = t.mock.method(require('../dist/automation/reimbursement-flow'), 'runReimbursementFlowWithErrorHandling',
    async () => { throw Error('Must not run mutation flow'); });
  return { events, openMock, workflow };
}

test('CLI authenticates, opens, caches BPM session, holds for Enter, and closes without mutation flow', async t => {
  const { events, workflow } = cliFixture(t);
  const interrupts = process.listenerCount('SIGINT'), terminations = process.listenerCount('SIGTERM');
  await main(args);
  assert.deepEqual(events, ['create', 'authenticate', 'open', 'remember', 'readline', 'hold', 'readline-close', 'close']);
  assert.equal(workflow.mock.callCount(), 0);
  assert.equal(process.listenerCount('SIGINT'), interrupts);
  assert.equal(process.listenerCount('SIGTERM'), terminations);
});

test('CLI failed opening still closes its session and does not cache or hold an unverified form', async t => {
  const { events, openMock } = cliFixture(t);
  openMock.mock.mockImplementation(async () => {
    events.push('open-failed');
    throw new OpenReimbursementError('forbidden');
  });
  await assert.rejects(main(args), { code: 'forbidden' });
  assert.deepEqual(events, ['create', 'authenticate', 'open-failed', 'close']);
});

test('CLI validates arguments and prints help before attempting browser startup', async t => {
  const { events } = cliFixture(t);
  await assert.rejects(main(['--biz-id', 'invalid']), { code: 'invalid_target' });
  await main(['--help']);
  assert.deepEqual(events, []);
});
