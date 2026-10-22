const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sessionStatePath, loadSessionState, saveSessionState } = require('../dist/automation/session-state');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-session-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'private', 'storage-state.json');
}
function cookie(domain, value = 'synthetic-only', expires = -1) {
  return { name: 'session', value, domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' };
}
function state(value = 'synthetic-only') {
  return { cookies: [cookie('.shanghaitech.edu.cn', value)], origins: [] };
}
function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
function fakeBrowser(t) {
  const browser = { closed: 0, isConnected: () => true, close: async () => { browser.closed++; } };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => ({}),
    storageState: async () => state('updated') };
  let received;
  browser.newContext = async options => { received = options; return context; };
  t.mock.method(require('playwright').chromium, 'launch', async () => browser);
  return { browser, context, options: () => received };
}

test('session persistence is opt-in and its path can be resolved before changing worker cwd', () => {
  assert.equal(sessionStatePath({}), undefined);
  const file = sessionStatePath({ OA_REMEMBER_SESSION: 'true', OA_DATA_DIR: 'data' }, '/parent');
  assert.equal(file, '/parent/data/browser-session/storage-state.json');
  assert.equal(sessionStatePath({ OA_REMEMBER_SESSION: 'true', OA_SESSION_STATE_PATH: file }, '/worker'), file);
});

test('snapshot roundtrip retains session cookies and OA storage, excluding expired/unrelated origins', async t => {
  const file = temp(t);
  const snapshot = { cookies: [cookie('ids.shanghaitech.edu.cn'), cookie('.shanghaitech.edu.cn'),
    cookie('sapbpm-new.shanghaitech.edu.cn', 'expired', 1), cookie('personal.example.org'),
    cookie('shanghaitech.edu.cn.attacker.invalid')],
    origins: [
      { origin: 'https://egate-new.shanghaitech.edu.cn', localStorage: [{ name: 'token', value: 'synthetic' }],
        indexedDB: [{ name: 'test-db', version: 1, stores: [] }] },
      { origin: 'https://sapbpm-new.shanghaitech.edu.cn:9091', localStorage: [] },
      { origin: 'https://personal.example.org', localStorage: [] },
    ] };
  const context = { storageState: async options => { assert.equal(options.indexedDB, true); return snapshot; } };
  assert.equal(await saveSessionState(context, file), true);
  const restored = await loadSessionState(file);
  assert.equal(restored.cookies.length, 2);
  assert.equal(restored.cookies[0].expires, -1);
  assert.equal(restored.origins.length, 2);
  assert.deepEqual(restored.origins[0].indexedDB, snapshot.origins[0].indexedDB);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['storage-state.json']);
});

test('bad cache falls back to login without logging its content; failed capture preserves previous snapshot', async t => {
  const file = temp(t), logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  assert.equal(await loadSessionState(file), undefined);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'SENSITIVE malformed cache');
  assert.equal(await loadSessionState(file), undefined);
  fs.writeFileSync(file, JSON.stringify(state('previous')));
  const capture = { storageState: async () => { throw Error('SENSITIVE browser closed'); } };
  assert.equal(await saveSessionState(capture, file), false);
  assert.equal((await loadSessionState(file)).cookies[0].value, 'previous');
  assert.doesNotMatch(logs.join('\n'), /SENSITIVE|previous/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['storage-state.json']);
});

test('browser restores state and refreshes it only after confirmed authentication', async t => {
  const file = temp(t);
  await saveSessionState({ storageState: async () => state('initial') }, file);
  env(t, { OA_REMEMBER_SESSION: 'true', OA_SESSION_STATE_PATH: file, OA_LOGIN_MODE: 'manual',
    CHROME_DEBUGGER_ADDRESS: '', PLAYWRIGHT_CDP_ENDPOINT: '', KEEP_BROWSER_OPEN: 'false' });
  const fixture = fakeBrowser(t);
  const { createBrowserSession, closeBrowserSession, rememberAuthenticatedSession } = require('../dist/automation/browser');
  const session = await createBrowserSession();
  assert.equal(fixture.options().storageState.cookies[0].value, 'initial');
  assert.equal(session.restoredSession, true);
  await closeBrowserSession(session);
  assert.equal((await loadSessionState(file)).cookies[0].value, 'initial');
  assert.equal(fixture.browser.closed, 1);
  const next = await createBrowserSession();
  await rememberAuthenticatedSession(next);
  assert.equal((await loadSessionState(file)).cookies[0].value, 'updated');
  fixture.context.storageState = async () => state('bpm-rotated');
  await closeBrowserSession(next);
  assert.equal((await loadSessionState(file)).cookies[0].value, 'bpm-rotated');
});

test('explicit credential login neither imports nor replaces the remembered account', async t => {
  const file = temp(t);
  await saveSessionState({ storageState: async () => state('remembered-account') }, file);
  env(t, { OA_REMEMBER_SESSION: 'true', OA_SESSION_STATE_PATH: file, OA_LOGIN_MODE: 'credentials',
    CHROME_DEBUGGER_ADDRESS: '', PLAYWRIGHT_CDP_ENDPOINT: '', KEEP_BROWSER_OPEN: 'false' });
  const fixture = fakeBrowser(t);
  const { createBrowserSession, rememberAuthenticatedSession, closeBrowserSession } = require('../dist/automation/browser');
  const session = await createBrowserSession();
  assert.equal(fixture.options().storageState, undefined);
  assert.equal(session.sessionStateFile, undefined);
  await rememberAuthenticatedSession(session);
  await closeBrowserSession(session);
  assert.equal((await loadSessionState(file)).cookies[0].value, 'remembered-account');
});

test('new-context failure closes the launched browser', async t => {
  env(t, { OA_REMEMBER_SESSION: 'false', CHROME_DEBUGGER_ADDRESS: '', PLAYWRIGHT_CDP_ENDPOINT: '' });
  const fixture = fakeBrowser(t);
  fixture.browser.newContext = async () => { throw Error('synthetic failure'); };
  await assert.rejects(require('../dist/automation/browser').createBrowserSession(), /synthetic failure/);
  assert.equal(fixture.browser.closed, 1);
});

test('web worker receives the shared absolute cache path, without inheriting credentials', t => {
  env(t, { OA_REMEMBER_SESSION: 'true', OA_SESSION_STATE_PATH: 'data/browser-session/storage-state.json',
    OA_USERNAME: 'must-not-inherit', OA_PASSWORD: 'must-not-inherit' });
  const child = new EventEmitter();
  child.send = () => {};
  let options;
  t.mock.method(require('node:child_process'), 'fork', (_file, _args, received) => { options = received; return child; });
  const { launchWorker } = require('../dist/application/job-service');
  launchWorker({ workDir: '/synthetic-worker' }, () => {}, () => {});
  assert.equal(options.env.OA_SESSION_STATE_PATH, path.resolve('data/browser-session/storage-state.json'));
  assert.equal(options.env.OA_REMEMBER_SESSION, 'true');
  assert.equal(options.env.OA_PASSWORD, undefined);
  assert.equal(options.env.OA_USERNAME, undefined);
});
