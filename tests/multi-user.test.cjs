const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const { createApp } = require('../dist/server/app');
const { OaApi } = require('../dist/server/oa-api');
const { deploymentFromEnv } = require('../dist/server/deployment');
const { SessionRegistry } = require('../dist/server/sessions');
const { JobService } = require('../dist/application/job-service');
const { JobStore } = require('../dist/infrastructure/job-store');

const ORIGIN = 'https://reim.test';
const SERVER = { mode: 'server', origins: [ORIGIN], trustProxy: true, idleMinutes: 120, maxSessions: 50, maxActiveJobs: 2, maxParses: 2 };

/** A school login that answers for whoever signs in, without any OA. */
const fakeLogin = async username => {
  const client = new OaHttpClient(async () => new Response('', { status: 404 }));
  client.account = { userAccount: username, userName: `用户${username}` };
  return client;
};

/** One request as nginx would forward it: Host of the public site, X-Forwarded-Proto https. */
function proxied(port, method, pathname, { cookie, csrf, body, host = 'reim.test', proto = 'https', origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: {
      Host: host, 'X-Forwarded-Proto': proto, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function serverApp(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-user-'));
  const app = createApp({ dataDir, liveEnabled: true, deployment: SERVER, makeOaApi: () => new OaApi(fakeLogin, null), ...extra });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)).then(() => fs.rmSync(dataDir, { recursive: true, force: true })));
  const port = app.server.address().port;
  /** A browser: its own cookie and CSRF token from /api/session. */
  const browser = async () => {
    const session = await proxied(port, 'GET', '/api/session');
    assert.equal(session.status, 200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    const call = (method, pathname, body) => proxied(port, method, pathname, { cookie, csrf: session.data.csrfToken, body });
    return { cookie, csrf: session.data.csrfToken, setCookie: session.headers['set-cookie'][0], call };
  };
  return { app, port, browser, dataDir };
}

test('deployment settings: local by default; server needs an https public origin', () => {
  assert.equal(deploymentFromEnv({}).mode, 'local');
  assert.equal(deploymentFromEnv({}).maxActiveJobs, 1);
  assert.throws(() => deploymentFromEnv({ REIM_DEPLOYMENT: 'server' }), /REIM_PUBLIC_ORIGIN/);
  assert.throws(() => deploymentFromEnv({ REIM_DEPLOYMENT: 'server', REIM_PUBLIC_ORIGIN: 'http://reim.test' }), /https/);
  assert.throws(() => deploymentFromEnv({ REIM_DEPLOYMENT: 'server', REIM_PUBLIC_ORIGIN: 'https://reim.test/app' }), /不含路径/);
  assert.throws(() => deploymentFromEnv({ REIM_DEPLOYMENT: 'cloud' }), /local 或 server/);
  const server = deploymentFromEnv({ REIM_DEPLOYMENT: 'server', REIM_PUBLIC_ORIGIN: 'https://reim.test, https://reim2.test', REIM_MAX_ACTIVE_JOBS: '8' });
  assert.deepEqual([server.origins, server.trustProxy, server.maxActiveJobs], [['https://reim.test', 'https://reim2.test'], true, 8]);
});

test('server: each browser has its own session, CSRF token and school login; nothing is shared', async t => {
  const { browser } = await serverApp(t);
  const alice = await browser(), bob = await browser();
  assert.notEqual(alice.cookie, bob.cookie);
  assert.notEqual(alice.csrf, bob.csrf);
  assert.match(alice.setCookie, /HttpOnly; SameSite=Strict; Path=\/; Secure/, 'the cookie is Secure behind https');

  assert.equal((await alice.call('POST', '/api/oa/login', { username: 'alice01', password: 'pw' })).status, 200);
  assert.equal((await bob.call('POST', '/api/oa/login', { username: 'bob0002', password: 'pw' })).status, 200);
  // Bob's login did not end Alice's: each sees only their own.
  assert.equal((await alice.call('GET', '/api/oa/status')).data.login.userAccount, 'alice01');
  assert.equal((await bob.call('GET', '/api/oa/status')).data.login.userAccount, 'bob0002');
  await bob.call('POST', '/api/oa/logout', {});
  assert.equal((await alice.call('GET', '/api/oa/status')).data.loggedIn, true, 'one logout ends one login');
  assert.equal((await bob.call('GET', '/api/oa/status')).data.loggedIn, false);
});

test('server: a token of one browser is refused with another browser\'s cookie', async t => {
  const { port, browser } = await serverApp(t);
  const alice = await browser(), bob = await browser();
  const mixed = await proxied(port, 'POST', '/api/oa/logout', { cookie: alice.cookie, csrf: bob.csrf, body: {} });
  assert.equal(mixed.status, 403);
  const unknown = await proxied(port, 'GET', '/api/oa/status', { cookie: `oa_session=${'0'.repeat(64)}` });
  assert.equal(unknown.status, 401);
});

test('server: only the public origin through https; .env credentials are never offered', async t => {
  const { port, browser } = await serverApp(t);
  assert.equal((await proxied(port, 'GET', '/api/session', { host: 'evil.test' })).status, 403, 'another Host');
  assert.equal((await proxied(port, 'GET', '/api/session', { proto: 'http' })).status, 403, 'plain http');
  assert.equal((await proxied(port, 'GET', '/api/session', { origin: 'https://evil.test' })).status, 403, 'another Origin');
  assert.equal((await proxied(port, 'GET', '/api/session', { host: '127.0.0.1' })).status, 403, 'the local address is not the site');
  const page = await proxied(port, 'GET', '/');
  assert.equal(page.status, 302);

  const alice = await browser();
  const status = await alice.call('GET', '/api/oa/status');
  assert.equal(status.data.savedUsername, null);
  assert.equal((await alice.call('POST', '/api/oa/login', { useSaved: true })).status, 400, '使用已保存账号 is not available');
  // Jobs outside the page (demo, typed credentials for a browser worker) are for one's own computer only.
  assert.equal((await alice.call('POST', '/api/jobs', { mode: 'demo', input: {} })).status, 404);
});

test('server: jobs belong to the browser that made them', async t => {
  const { app, browser } = await serverApp(t);
  const alice = await browser(), bob = await browser();
  assert.deepEqual((await alice.call('GET', '/api/jobs')).data, { jobs: [] });
  // A job of someone else's in the same store.
  const store = app.store;
  const job = { id: '00000000-0000-4000-8000-000000000001', ownerId: 'nobody', mode: 'live', action: 'save', status: 'draft',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), input: {}, invoice: null, checks: [], events: [] };
  store.save(job);
  assert.equal((await alice.call('GET', `/api/jobs/${job.id}`)).status, 404, 'another owner\'s job is not found');
  assert.equal((await bob.call('POST', `/api/jobs/${job.id}/cancel`, {})).status, 404);
  assert.deepEqual((await bob.call('GET', '/api/jobs')).data.jobs, []);
});

test('sessions: idle ones end with their school login; the oldest gives way at the limit', () => {
  let now = 0;
  const made = [];
  const registry = new SessionRegistry(() => { const api = new OaApi(fakeLogin, null); made.push(api); return api; },
    { shared: false, idleMs: 1000, max: 2 }, () => now);
  registry.close();
  const a = registry.open(''), b = registry.open('');
  assert.equal(registry.size, 2);
  now = 500;
  assert.equal(registry.require(a.id), a, 'a live session is found and kept alive');
  now = 1400;
  registry.sweep();
  assert.equal(registry.size, 1, 'b was idle for 1400 ms');
  assert.throws(() => registry.require(b.id), { status: 401 });
  const c = registry.open('');
  const d = registry.open('');
  assert.equal(registry.size, 2, 'at the limit the oldest idle one ends');
  assert.throws(() => registry.require(a.id), { status: 401 });
  assert.equal(registry.open(c.id), c, 'a page reload keeps its session');
  assert.notEqual(d.api, c.api, 'each browser its own OaApi');
});

test('local: one shared session for every tab, as before; the .env account is offered', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-user-local-'));
  const app = createApp({ dataDir, oaApi: new OaApi(fakeLogin, { username: 'me00001', password: 'secret' }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)).then(() => fs.rmSync(dataDir, { recursive: true, force: true })));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const first = await fetch(`${base}/api/session`), second = await fetch(`${base}/api/session`);
  assert.equal(first.headers.get('set-cookie'), second.headers.get('set-cookie'), 'the same session for every tab');
  assert.doesNotMatch(first.headers.get('set-cookie'), /Secure/, 'plain http on 127.0.0.1');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${base}/api/oa/status`, { headers: { Cookie: cookie } })).json()).savedUsername, 'me00001');
  // fetch drops a custom Host header; a raw request carries it.
  assert.equal((await proxied(app.server.address().port, 'GET', '/api/session', { host: 'reim.test' })).status, 403, 'only this computer');
});

test('job service: HTTP jobs of different users all run at once; browser jobs are capped; one user\'s jobs stay in order', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-user-jobs-'));
  try {
    const store = new JobStore(path.join(dataDir, 'jobs'));
    const running = [];
    const launcher = (request, onEvent, onExit) => { running.push({ owner: request.job.ownerId, id: request.job.id, onExit }); return { stop() {} }; };
    // Jobs whose purpose says 浏览器 stand for ones that start a browser; the rest go over HTTP.
    const heavy = job => job.input.purpose === '浏览器';
    const service = new JobService(store, { review: async () => ({}) }, false, launcher, 60_000, undefined, 1, heavy);
    const demo = purpose => ({ mode: 'demo', input: { fundingKindKeyword: '被授权的项目', fundingKeyword: 'P001', budgetKeyword: '委托服务费',
      amount: '10', attachmentCount: 1, payeeCode: '900001', purpose } });
    const make = async (owner, purpose = '接口') => {
      const id = (await service.create(demo(purpose), {}, owner)).id;
      return { id, owner };
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const owners = () => running.map(item => item.owner);
    const a1 = await make('a'), b1 = await make('b'), c1 = await make('c'), d1 = await make('d'), a2 = await make('a');
    for (const job of [a1, b1, c1, d1, a2]) service.start(job.id, { confirmed: true }, undefined, job.owner);
    assert.deepEqual(owners(), ['a', 'b', 'c', 'd'], 'four users at once over HTTP, no global cap; a\'s second waits for a\'s first');
    assert.equal(service.running, 4);
    running[0].onExit();
    await settle();
    assert.deepEqual(owners(), ['a', 'b', 'c', 'd', 'a'], 'a\'s second follows its first');

    // Browser jobs: at most maxActive (1) at once, and a waiting one holds back its owner's later jobs only.
    const e1 = await make('e', '浏览器'), f1 = await make('f', '浏览器'), f2 = await make('f'), g1 = await make('g');
    for (const job of [e1, f1, f2, g1]) service.start(job.id, { confirmed: true }, undefined, job.owner);
    assert.deepEqual(owners().slice(5), ['e', 'g'], 'f waits for the browser slot, f\'s HTTP job waits behind it, g runs');
    running.find(item => item.id === e1.id).onExit();
    await settle();
    assert.deepEqual(owners().slice(5), ['e', 'g', 'f'], 'the freed slot goes to f');
    assert.throws(() => service.cancel(g1.id, 'a'), { status: 404 }, 'one owner cannot stop another\'s job');
    service.shutdown();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('limiter: at most N tasks at once, the rest in order', async () => {
  const { Limiter } = require('../dist/server/sessions');
  const limiter = new Limiter(2);
  let now = 0, peak = 0;
  const order = [];
  const task = name => limiter.run(async () => { peak = Math.max(peak, ++now); await new Promise(r => setTimeout(r, 5)); order.push(name); now--; });
  await Promise.all(['a', 'b', 'c', 'd'].map(task));
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(0, 2).sort(), ['a', 'b']);
  assert.equal(new Limiter(0).run(async () => 'unlimited') instanceof Promise, true);
});
