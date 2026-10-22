const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authenticateSchool, hasHost, LOGIN_URL } = require('../dist/automation/auth');

function visibility(value) {
  return { first: () => ({ isVisible: async () => value }), filter: () => ({ count: async () => value ? 1 : 0 }) };
}

function fakePage(initialUrl, loggedIn) {
  const actions = [];
  const root = { locator: () => visibility(!loggedIn) };
  const page = {
    actions, goto: async url => actions.push(['goto', url]), bringToFront: async () => actions.push(['front']),
    url: () => initialUrl, frames: () => [], mainFrame: () => page, locator: root.locator, isClosed: () => false,
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    getByPlaceholder: () => visibility(loggedIn),
    getByRole: () => visibility(false),
    getByText: () => visibility(false),
  };
  page.context = () => ({ pages: () => [page] });
  return page;
}
test('manual school login does not inspect credentials or fill the school form', async () => {
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/green/index.html', true);
  await authenticateSchool(page, { mode: 'manual', username: 'must-not-use', password: 'must-not-use' });
  assert.deepEqual(page.actions, [['goto', LOGIN_URL], ['front']]);
});

test('restored session is verified on the portal and skips the login endpoint when valid', async () => {
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/green/index.html', true);
  assert.equal(await authenticateSchool(page, { mode: 'manual', reuseSession: true }), page);
  assert.deepEqual(page.actions, [['goto', 'https://egate-new.shanghaitech.edu.cn/green/index.html#/work']]);
});

test('expired restored session returns to normal manual login instead of assuming authentication', async () => {
  let currentUrl = LOGIN_URL;
  const page = fakePage(currentUrl, false);
  let loggedIn = false;
  page.url = () => currentUrl;
  page.locator = () => visibility(!loggedIn);
  page.getByPlaceholder = () => visibility(loggedIn);
  page.goto = async url => {
    page.actions.push(['goto', url]);
    if (url === LOGIN_URL) {
      loggedIn = true;
      currentUrl = 'https://egate-new.shanghaitech.edu.cn/green/index.html';
    }
  };
  assert.equal(await authenticateSchool(page, { mode: 'manual', reuseSession: true }), page);
  assert.deepEqual(page.actions, [
    ['goto', 'https://egate-new.shanghaitech.edu.cn/green/index.html#/work'], ['goto', LOGIN_URL], ['front'],
  ]);
});

test('BPM creation readiness uses the usable create button, not a title or document load event', async () => {
  const { waitForBpmPageReady } = require('../dist/automation/auth');
  let trial = false;
  const button = { filter: () => button, getByRole: () => button,
    count: async () => 1, click: async options => { assert.equal(options.trial, true); trial = true; } };
  const page = { url: () => 'https://sapbpm-new.shanghaitech.edu.cn/create', isClosed: () => false,
    frames: () => [], mainFrame: () => null,
    getByText: () => ({ filter: () => ({ count: async () => 0 }) }),
    getByRole: () => button, waitForTimeout: async () => { throw Error('ready page must not wait'); },
    waitForLoadState: async () => { throw Error('unrelated resources still loading'); } };
  await waitForBpmPageReady(page, 100);
  assert.equal(trial, true);
});
test('credentials are not entered at lookalike school domains', async () => {
  const page = fakePage('https://ids.shanghaitech.edu.cn.attacker.invalid/authserver/login', false);
  await assert.rejects(authenticateSchool(page, { mode: 'credentials', username: 'test', password: 'test' }), error => error.code === 'authentication');
  assert.equal(hasHost('https://evil.invalid/ids.shanghaitech.edu.cn', 'ids.shanghaitech.edu.cn'), false);
  assert.equal(hasHost('http://ids.shanghaitech.edu.cn', 'ids.shanghaitech.edu.cn'), false);
});
test('manual login timeout stops before any business operation', async () => {
  const page = fakePage(LOGIN_URL, false);
  await assert.rejects(authenticateSchool(page, { mode: 'manual', timeoutMs: 0 }), error => error.code === 'authentication');
  assert.deepEqual(page.actions, [['goto', LOGIN_URL], ['front']]);
});

test('egate CAS callback is not treated as a completed login', async () => {
  const { isEgateLoggedIn } = require('../dist/automation/auth');
  assert.equal(await isEgateLoggedIn(fakePage('https://egate-new.shanghaitech.edu.cn/login?ticket=test', true)), false);
  assert.equal(await isEgateLoggedIn(fakePage('https://egate-new.shanghaitech.edu.cn/green/index.html#/work', true)), true);
});

test('login adopts a unique authenticated tab in the same browser context', async () => {
  const { waitForEgateAfterLogin } = require('../dist/automation/auth');
  const original = fakePage(LOGIN_URL, false);
  const workbench = fakePage('https://egate-new.shanghaitech.edu.cn/green/index.html#/work', true);
  original.context = () => ({ pages: () => [original, workbench] });
  assert.equal(await waitForEgateAfterLogin(original, 100), workbench);
  original.isClosed = () => true;
  assert.equal(await waitForEgateAfterLogin(original, 100), workbench);
});

test('login never adopts a callback, lookalike domain, or ambiguous workbench tabs', async () => {
  const { waitForEgateAfterLogin } = require('../dist/automation/auth');
  const original = fakePage(LOGIN_URL, false);
  const callback = fakePage('https://egate-new.shanghaitech.edu.cn/login?ticket=test', true);
  const lookalike = fakePage('https://egate-new.shanghaitech.edu.cn.attacker.invalid/green/index.html', true);
  original.context = () => ({ pages: () => [original, callback, lookalike] });
  await assert.rejects(waitForEgateAfterLogin(original, 10), error => error.code === 'authentication');
  original.context = () => ({ pages: () => [original,
    fakePage('https://egate-new.shanghaitech.edu.cn/green/index.html', true),
    fakePage('https://egate-new.shanghaitech.edu.cn/blue/index.html', true)] });
  await assert.rejects(waitForEgateAfterLogin(original, 100), error => error.code === 'ambiguous_choice');
});

test('orange theme completes login in current or newly opened tab', async () => {
  const { isEgateLoggedIn, waitForEgateAfterLogin, egateWorkbenchUrl, isEgateShellUrl } = require('../dist/automation/auth');
  const orange = fakePage('https://egate-new.shanghaitech.edu.cn/orange/index.html#/work', true);
  assert.equal(await isEgateLoggedIn(orange), true);
  assert.equal(await waitForEgateAfterLogin(orange, 100), orange);
  const original = fakePage(LOGIN_URL, false);
  original.context = () => ({ pages: () => [original, orange] });
  assert.equal(await waitForEgateAfterLogin(original, 100), orange);
  assert.equal(egateWorkbenchUrl('https://egate-new.shanghaitech.edu.cn/orange/index.html#/home'), orange.url());
  assert.equal(isEgateShellUrl('https://egate-new.shanghaitech.edu.cn/login?ticket=test'), false);
  assert.equal(isEgateShellUrl('https://egate-new.shanghaitech.edu.cn.attacker.invalid/orange/index.html'), false);
  assert.equal(await isEgateLoggedIn(fakePage(orange.url(), false)), false);
});

test('all five themes and additional theme paths authenticate and preserve navigation theme', async () => {
  const { isEgateLoggedIn, waitForEgateAfterLogin, egateWorkbenchUrl, egateTaskListUrl } = require('../dist/automation/auth');
  for (const theme of ['red', 'orange', 'blue', 'green', 'purple', 'random', 'teal-v2']) {
    const base = `https://egate-new.shanghaitech.edu.cn/${theme}/index.html`;
    const portal = fakePage(`${base}#/work`, true);
    assert.equal(await isEgateLoggedIn(portal), true);
    assert.equal(await waitForEgateAfterLogin(portal, 100), portal);
    const original = fakePage(LOGIN_URL, false);
    original.context = () => ({ pages: () => [original, portal] });
    assert.equal(await waitForEgateAfterLogin(original, 100), portal);
    assert.equal(egateWorkbenchUrl(`${base}?ignored=1#/home`), `${base}#/work`);
    assert.equal(egateTaskListUrl(`${base}?ignored=1#/work`), `${base}#/taskList?cardName=todo`);
  }
});

test('official PC portal from the supplied API request is recognized only with actual portal UI', async () => {
  const { isEgateLoggedIn, isEgateShellUrl, egateWorkbenchUrl } = require('../dist/automation/auth');
  const base = 'https://egate-new.shanghaitech.edu.cn/CUS_TEMPLATE_OFFICIAL/pc/index.html';
  assert.equal(isEgateShellUrl(base), true);
  assert.equal(await isEgateLoggedIn(fakePage(base, true)), true);
  assert.equal(await isEgateLoggedIn(fakePage(base, false)), false);
  assert.equal(egateWorkbenchUrl(base), `${base}#/work`);
  assert.equal(isEgateShellUrl(base.replace('/pc/', '/unknown/')), false);
  assert.equal(isEgateShellUrl(base.replace('.edu.cn/', '.edu.cn.attacker.invalid/')), false);
});

test('theme paths require rendered portal UI and never accept login callbacks or lookalike hosts', async () => {
  const { isEgateLoggedIn, isEgateShellUrl } = require('../dist/automation/auth');
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/purple/index.html#/work', true);
  page.getByPlaceholder = () => visibility(false);
  assert.equal(await isEgateLoggedIn(page), false);
  page.getByText = () => visibility(true);
  assert.equal(await isEgateLoggedIn(page), true); // Navigation rendered, search still loading.
  for (const url of [LOGIN_URL, 'https://egate-new.shanghaitech.edu.cn/login?ticket=test',
    'https://egate-new.shanghaitech.edu.cn/authserver/index.html',
    'https://egate-new.shanghaitech.edu.cn.attacker.invalid/purple/index.html',
    'http://egate-new.shanghaitech.edu.cn/purple/index.html']) {
    assert.equal(isEgateShellUrl(url), false);
    assert.equal(await isEgateLoggedIn(fakePage(url, true)), false);
  }
  assert.equal(await isEgateLoggedIn(fakePage(page.url(), false)), false);
});

test('hidden first search match does not hide the visible portal search', async () => {
  const { isEgateLoggedIn } = require('../dist/automation/auth');
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/purple/index.html#/work', true);
  page.getByPlaceholder = () => ({
    first: () => ({ isVisible: async () => false }),
    filter: options => { assert.equal(options.visible, true); return { count: async () => 1 }; },
  });
  assert.equal(await isEgateLoggedIn(page), true);
});

test('a stalled unrelated iframe does not block a ready portal and probes do not accumulate', async () => {
  const { inspectEgateLogin } = require('../dist/automation/auth');
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/purple/index.html#/work', true);
  let calls = 0;
  const stalled = { filter: () => ({ count: () => { calls++; return new Promise(() => {}); } }) };
  const frame = { locator: () => stalled, getByPlaceholder: () => visibility(false),
    getByRole: () => visibility(false), getByText: () => visibility(false) };
  page.frames = () => [frame];
  for (let i = 0; i < 2; i++) {
    const state = await inspectEgateLogin(page, 20);
    assert.equal(state.loggedIn, true); assert.equal(state.pending, 1);
  }
  assert.equal(calls, 1);
});

test('visible login form blocks portal recognition and selector errors are reported', async () => {
  const { inspectEgateLogin } = require('../dist/automation/auth');
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/purple/index.html#/work', true);
  page.locator = () => visibility(true);
  assert.equal((await inspectEgateLogin(page)).loggedIn, false);
  page.locator = () => { throw Error('detached'); };
  const state = await inspectEgateLogin(page);
  assert.equal(state.loggedIn, false); assert.equal(state.failed, 1);
});

test('a visible username label alone does not masquerade as a login form', async () => {
  const { isEgateLoggedIn } = require('../dist/automation/auth');
  const page = fakePage('https://egate-new.shanghaitech.edu.cn/purple/index.html#/work', true);
  page.locator = selector => visibility(selector.includes('#username'));
  assert.equal(await isEgateLoggedIn(page), true);
});
