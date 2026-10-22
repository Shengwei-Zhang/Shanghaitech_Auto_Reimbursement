const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { workbenchSearch, openWorkbench } = require('../dist/automation/workbench');
const { waitForFailureInspection } = require('../dist/automation/failure-inspection');

function fixture(groups, url = 'https://egate-new.shanghaitech.edu.cn/green/index.html#/work') {
  const frames = groups.map(fields => {
    const build = matched => ({
      matched,
      or(other) { return build([...new Set([...matched, ...other.matched])]); },
      filter() { return build(matched.filter(field => !field.hidden)); },
      count: async () => matched.length,
      nth: i => ({ id: matched[i].id, isEditable: async options => { matched[i].probeTimeout = options?.timeout; return !matched[i].disabled; },
        click: async options => {
          if (matched[i].blocked) throw Error('covered by loading mask');
          if (options?.trial) matched[i].trialChecks = (matched[i].trialChecks || 0) + 1;
          else matched[i].clicked = true;
        },
        fill: async value => { matched[i].value = value; }, inputValue: async () => matched[i].value }),
    });
    return {
      getByPlaceholder: pattern => build(fields.filter(field => pattern.test(field.placeholder || ''))),
      getByRole: (_, { name }) => build(fields.filter(field => name.test(field.label || ''))),
      locator: () => build(fields.filter(field => field.recorded)),
      isDetached: () => false,
    };
  });
  let active, navigations = [];
  const page = { url: () => url, frames: () => frames, mainFrame: () => frames[0], isClosed: () => false,
    waitForTimeout: async () => {},
    goto: async (next, options) => { navigations.push(options); url = next; },
  };
  return { page, setStage() {}, setActiveFrame(frame) { active = frame; }, get active() { return active; }, navigations };
}

test('workbench finds the unique editable search in iframe and ignores hidden duplicate', async () => {
  const ctx = fixture([[{ placeholder: '事项名称', hidden: true }], [{ placeholder: '请输入您想要的事 项 名 称', id: 'target' }]]);
  assert.equal((await workbenchSearch(ctx)).id, 'target');
  assert.equal(ctx.active, ctx.page.frames()[1]);
  await openWorkbench(ctx);
  assert.equal(ctx.navigations.length, 0);
});
test('necessary workbench navigation waits only for commit, then verifies the actual search control', async () => {
  const field = { placeholder: '请输入您想要的事项名称', disabled: true };
  const ctx = fixture([[field]], 'https://egate-new.shanghaitech.edu.cn/green/index.html#/home');
  const navigate = ctx.page.goto;
  ctx.page.goto = async (...args) => { await navigate(...args); field.disabled = false; };
  await openWorkbench(ctx);
  assert.equal(ctx.navigations[0].waitUntil, 'commit');
  assert.equal(field.probeTimeout, 150);
});

test('already usable logged-in home goes straight to creation without navigating or waiting for load', async () => {
  const field = { placeholder: '请输入您想要的事项名称' };
  const ctx = fixture([[field]], 'https://egate-new.shanghaitech.edu.cn/orange/index.html#/home');
  ctx.page.goto = async () => { throw Error('must not reload the ready home'); };
  ctx.page.waitForTimeout = async () => { throw Error('must not wait when ready'); };
  await openWorkbench(ctx);
  assert.equal(field.trialChecks, undefined);
  assert.equal(field.clicked, undefined);
  assert.equal(field.value, undefined);
});

test('a blocked actual click reports a blocked input, not a missing search field', async () => {
  const { fillWorkflowSearch } = require('../dist/automation/workbench');
  const field = { placeholder: '事项名称', blocked: true };
  const ctx = fixture([[field]]);
  await assert.rejects(fillWorkflowSearch(ctx, 20), { code: 'workbench_search_blocked' });
  assert.equal(field.value, undefined);
});

test('stalled unrelated frame cannot delay search input in the ready frame', async () => {
  const { fillWorkflowSearch } = require('../dist/automation/workbench');
  const field = { placeholder: '事项名称' };
  const ctx = fixture([[], [field]]);
  let calls = 0;
  const stalled = { or: () => stalled, filter: () => stalled,
    count: () => { calls++; return new Promise(() => {}); } };
  ctx.page.frames()[0].getByPlaceholder = () => stalled;
  const start = Date.now();
  await fillWorkflowSearch(ctx, 200);
  assert.equal(field.value, '报销单');
  assert.ok(Date.now() - start < 1000);
  assert.equal(calls, 1);
});

test('unresponsive frame is bounded, classified and not probed repeatedly in parallel', async () => {
  const ctx = fixture([[]]);
  let calls = 0;
  const stalled = { or: () => stalled, filter: () => stalled,
    count: () => { calls++; return new Promise(() => {}); } };
  ctx.page.frames()[0].getByPlaceholder = () => stalled;
  await assert.rejects(workbenchSearch(ctx, 550), { code: 'workbench_search_pending' });
  assert.equal(calls, 1);
});

test('search click is not gated by trial click and input is verified', async () => {
  const { fillWorkflowSearch } = require('../dist/automation/workbench');
  const field = { placeholder: '事项名称' };
  const ctx = fixture([[field]]);
  await fillWorkflowSearch(ctx);
  assert.equal(field.trialChecks, undefined);
  assert.equal(field.clicked, true);
  assert.equal(field.value, '报销单');
});
test('workbench rejects missing, ambiguous and closed pages with specific error codes', async () => {
  await assert.rejects(workbenchSearch(fixture([[]]), 0), e => e.code === 'workbench_search_missing');
  const ctx = fixture([[{ placeholder: '事项名称' }, { placeholder: '事项名称' }]]);
  await assert.rejects(workbenchSearch(ctx), e => e.code === 'workbench_search_ambiguous');
  ctx.page.isClosed = () => true;
  await assert.rejects(workbenchSearch(ctx), e => e.code === 'workbench_closed');
});
test('failure inspection is bounded and ends on cancellation or browser/context close', async () => {
  for (const exit of ['abort', 'disconnected', 'close', 'timeout']) {
    const browser = new EventEmitter(), context = new EventEmitter(), controller = new AbortController();
    browser.isConnected = () => true; context.pages = () => [{}];
    const waiting = waitForFailureInspection({ browser, context }, controller.signal, exit === 'timeout' ? 1 : 1000);
    if (exit === 'abort') controller.abort();
    if (exit === 'disconnected') browser.emit(exit);
    if (exit === 'close') context.emit(exit);
    await waiting;
    assert.equal(browser.listenerCount('disconnected'), 0);
    assert.equal(context.listenerCount('close'), 0);
  }
});

test('execution reports failure before closing the browser and never repeats business work', async t => {
  // This test isolates browser failure handling; invoice input has its own integration coverage.
  const invoiceInput = require('../dist/automation/invoice-input');
  t.mock.method(invoiceInput, 'validateInvoiceInput', async () => {});
  const browserModule = require('../dist/automation/browser');
  const flowModule = require('../dist/automation/reimbursement-flow');
  const beforeCreate = browserModule.createBrowserSession, beforeClose = browserModule.closeBrowserSession;
  const beforeRun = flowModule.runReimbursementFlowWithErrorHandling;
  const browser = new EventEmitter(), context = new EventEmitter();
  browser.isConnected = () => true; context.pages = () => [{}];
  let closed = false, runs = 0, announced = false;
  browser.close = async () => { closed = true; };
  browserModule.createBrowserSession = async () => ({ browser, context });
  browserModule.closeBrowserSession = async () => { closed = true; };
  flowModule.runReimbursementFlowWithErrorHandling = async () => { runs++; throw new Error('selector not found'); };
  try {
    const { executeAutomation } = require('../dist/automation/execute');
    await assert.rejects(executeAutomation({}, { onFailureInspection: async failure => {
      announced = true;
      assert.equal(closed, false);
      assert.equal(failure.code, 'control_missing');
      setImmediate(() => context.emit('close'));
    } }), /selector not found/);
    assert.equal(announced, true);
    assert.equal(closed, true);
    assert.equal(runs, 1);
  } finally {
    browserModule.createBrowserSession = beforeCreate; browserModule.closeBrowserSession = beforeClose;
    flowModule.runReimbursementFlowWithErrorHandling = beforeRun;
  }
});

test('orange workbench remains on its selected theme after login and home navigation', async () => {
  const base = 'https://egate-new.shanghaitech.edu.cn/orange/index.html';
  const ctx = fixture([[{ placeholder: '请输入您想要的事项名称' }]], `${base}#/home`);
  await openWorkbench(ctx, { requireWorkRoute: true });
  assert.equal(ctx.page.url(), `${base}#/work`);
  await openWorkbench(ctx);
  assert.equal(ctx.navigations.length, 1);
});

test('all theme variants continue from authentication to search without reload or theme change', async () => {
  const { isEgateLoggedIn, waitForEgateAfterLogin } = require('../dist/automation/auth');
  const { fillWorkflowSearch } = require('../dist/automation/workbench');
  for (const theme of ['red', 'orange', 'blue', 'green', 'purple', 'random', 'teal-v2']) {
    const base = `https://egate-new.shanghaitech.edu.cn/${theme}/index.html`;
    const field = { placeholder: '请输入您想要的事项名称' };
    const ctx = fixture([[field]], `${base}#/work`);
    ctx.page.locator = () => ({ filter: () => ({ count: async () => 0 }) });
    ctx.page.getByPlaceholder = () => ({ filter: () => ({ count: async () => 1 }) });
    ctx.page.getByRole = ctx.page.getByText = ctx.page.locator;
    ctx.page.context = () => ({ pages: () => [ctx.page] });
    // Authentication probes the login fields in each frame as well.
    const originalLocator = ctx.page.mainFrame().locator;
    ctx.page.mainFrame().locator = selector => selector.startsWith('#username')
      ? ctx.page.locator(selector) : originalLocator(selector);
    assert.equal(await isEgateLoggedIn(ctx.page), true);
    assert.equal(await waitForEgateAfterLogin(ctx.page, 100), ctx.page);
    await openWorkbench(ctx);
    await fillWorkflowSearch(ctx);
    assert.equal(field.value, '报销单');
    assert.equal(ctx.navigations.length, 0);
    assert.equal(ctx.page.url(), `${base}#/work`);
  }
});


test('recorded aria/XPath search works without placeholder and uses recorded query', async () => {
  const { fillWorkflowSearch } = require('../dist/automation/workbench');
  for (const field of [{ label: '请输入您想要的事项名称' }, { recorded: true },
    { placeholder: '事项名称', label: '事项名称', recorded: true }]) {
    const ctx = fixture([[], [field]]);
    await fillWorkflowSearch(ctx);
    assert.equal(field.clicked, true);
    assert.equal(field.value, '报销单');
  }
});
test('selector failures are not silently reported as a missing search field', async () => {
  const ctx = fixture([[]]);
  ctx.page.frames()[0].getByPlaceholder = () => {
    const locator = { or: () => locator, filter: () => locator, count: async () => { throw Error('selector syntax'); } };
    return locator;
  };
  await assert.rejects(workbenchSearch(ctx, 20), error => error.code === 'workbench_search_error');
});
