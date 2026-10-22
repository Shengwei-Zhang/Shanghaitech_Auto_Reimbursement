const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeepSeekAdvisor } = require('../dist/infrastructure/deepseek');
const { parseInput } = require('../dist/domain/job');
const { planBusinessInput, validateStoredPlan } = require('../dist/domain/reimbursement-plan');
const { JobService, LOCAL_OWNER, launchWorker } = require('../dist/application/job-service');
const { JobStore } = require('../dist/infrastructure/job-store');
const { createApp } = require('../dist/server/app');
const input = parseInput({ purpose: '科研耗材', reason: '采购实验耗材用于科研样本制备', payeeCode: 'PRIVATE001',
  fundingKeyword: '项目A', budgetKeyword: '材料费', amount: '120.10', attachmentCount: 1 });
const draft = () => ({ input: planBusinessInput(input), summary: '科研耗材报销，待核对经费。', concerns: ['请核实 OA 可选科目。'] });
const advisor = { review: async () => { throw new Error('Unused'); }, generatePlan: async () => draft() };
function fixture(t, customAdvisor = advisor, launcher = () => { throw new Error('Must not launch'); }) {
  const store = new JobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-plan-')));
  const service = new JobService(store, customAdvisor, true, launcher);
  t.after(() => { service.shutdown(); fs.rmSync(store.root, { recursive: true, force: true }); });
  return { store, service };
}
function pdf() {
  const stream = 'BT /F1 14 Tf 30 100 Td (26117000000000000099) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return { name: 'private-invoice.pdf', base64: Buffer.from(result).toString('base64') };
}
const create = service => service.create({ mode: 'live', action: 'save', input, invoice: pdf() });
const reply = (value, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));

test('DS sends only allowlisted business fields in JSON mode; key stays in authorization header', async () => {
  let request;
  const ds = new DeepSeekAdvisor('test-secret', async (url, options) => { request = { url, ...options }; return reply(draft()); });
  assert.deepEqual(await ds.generatePlan(input, '130.00'), draft());
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(body.messages[1].content), { input: planBusinessInput(input), invoiceAmount: '130.00' });
  assert.equal(request.body.includes(input.payeeCode), false);
  assert.equal(request.body.includes('test-secret'), false);
});

test('DS refuses missing key, provider failures, malformed/truncated JSON and invented parameters', async () => {
  await assert.rejects(new DeepSeekAdvisor('', () => { throw Error('must not fetch'); }).generatePlan(input), error => error.status === 503);
  for (const status of [401, 403, 402, 429, 500]) {
    const ds = new DeepSeekAdvisor('secret', async () => new Response('sensitive upstream body', { status }));
    await assert.rejects(ds.generatePlan(input), error => error.status === 502 && !error.message.includes('sensitive'));
  }
  const responses = [() => reply('{'), () => reply(draft(), 'length'), () => reply('x'.repeat(20001)),
    () => reply({ ...draft(), action: 'submit' }), () => reply({ ...draft(), input: { ...draft().input, amount: '999.00' } }),
    () => reply({ ...draft(), input: { ...draft().input, fundingKeyword: '另一个项目' } }),
    () => reply({ ...draft(), input: { ...draft().input, selector: '#submit' } }),
    () => reply({ ...draft(), concerns: [123] }), () => { throw Error('secret network error'); }];
  for (const response of responses) await assert.rejects(new DeepSeekAdvisor('secret', async () => response()).generatePlan(input), error => error.status === 502 && !error.message.includes('secret'));
});

test('plan persists immutable private revisions and launch requires latest confirmed hash', async t => {
  let launched;
  const { service, store } = fixture(t, advisor, request => { launched = request; return { stop() {} }; });
  const job = await create(service);
  await assert.rejects(service.generatePlan(job.id, {}), /同意/);
  const first = await service.generatePlan(job.id, { consent: true });
  const filename = path.join(store.directory(job.id), first.plan.file);
  const original = fs.readFileSync(filename, 'utf8');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const plan = service.getPlan(job.id);
  assert.equal(plan.input.payeeCode, input.payeeCode);
  assert.equal(plan.invoice.fileRef, 'invoice.pdf');
  assert.equal(plan.action, 'save');
  const next = await service.generatePlan(job.id, { consent: true });
  assert.equal(next.plan.version, 2);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.throws(() => service.start(job.id, { confirmed: true, planSha256: first.plan.sha256 }), /版本已变化/);
  assert.equal(launched, undefined);
  service.start(job.id, { confirmed: true, planSha256: next.plan.sha256 });
  assert.deepEqual(launched.job.input, plan.input);
  assert.deepEqual(fs.readFileSync(launched.invoicePath), Buffer.from(pdf().base64, 'base64'));
});

test('failed regeneration retains draft and previous JSON revision', async t => {
  let fail = false;
  const { service, store } = fixture(t, { ...advisor, generatePlan: async () => {
    if (fail) throw new Error('API unavailable'); return draft();
  } });
  const job = await create(service);
  const first = await service.generatePlan(job.id, { consent: true }); fail = true;
  await assert.rejects(service.generatePlan(job.id, { consent: true }), /unavailable/);
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'draft');
  assert.deepEqual(store.get(job.id, LOCAL_OWNER).plan, first.plan);
  assert.equal(service.getPlan(job.id).version, 1);
});

test('generation locks duplicate requests and start; cancellation discards in-flight result', async t => {
  let resolve;
  const { service, store } = fixture(t, { ...advisor, generatePlan: () => new Promise(done => { resolve = done; }) });
  const job = await create(service);
  const pending = service.generatePlan(job.id, { consent: true });
  await assert.rejects(service.generatePlan(job.id, { consent: true }), /正在生成/);
  assert.throws(() => service.start(job.id, { confirmed: true }), /正在生成/);
  service.cancel(job.id); resolve(draft());
  await assert.rejects(pending, /状态或参数已变化/);
  assert.equal(store.get(job.id, LOCAL_OWNER).plan, undefined);
  assert.equal(fs.readdirSync(store.directory(job.id)).some(name => name.startsWith('reimbursement.')), false);
});

test('plan or invoice tampering/missing files stops start before launch', async t => {
  for (const target of ['plan', 'invoice', 'missing']) {
    const { service, store } = fixture(t);
    const job = await create(service);
    const planned = await service.generatePlan(job.id, { consent: true });
    const file = path.join(store.directory(job.id), target === 'invoice' ? 'invoice.pdf' : planned.plan.file);
    if (target === 'missing') fs.unlinkSync(file); else fs.appendFileSync(file, 'changed');
    assert.throws(() => service.start(job.id, { confirmed: true, planSha256: planned.plan.sha256 }), error => error.status === 409);
    assert.equal(store.get(job.id, LOCAL_OWNER).status, 'draft');
  }
});

test('stored plan schema rejects unexpected instructions, changed task fields and file references', async t => {
  const { service, store } = fixture(t);
  const job = await create(service); await service.generatePlan(job.id, { consent: true });
  const plan = service.getPlan(job.id); const current = store.get(job.id, LOCAL_OWNER);
  for (const mutate of [p => p.actions = ['click'], p => p.input.amount = '1.00', p => p.input.selector = '#submit',
    p => p.invoice.fileRef = '../../other.pdf', p => p.review.input = draft().input, p => p.action = 'submit', p => p.createdAt = 'invalid']) {
    const changed = structuredClone(plan); mutate(changed);
    assert.throws(() => validateStoredPlan(changed, current), error => error.status === 409);
  }
});

test('queued plan tampering blocks the later worker launch', async t => {
  const handles = [];
  const { service, store } = fixture(t, advisor, (request, event, exit) => { handles.push({ request, event, exit }); return { stop() {} }; });
  const first = await service.create({ mode: 'demo', input }); service.start(first.id, { confirmed: true });
  const job = await create(service); const planned = await service.generatePlan(job.id, { consent: true });
  service.start(job.id, { confirmed: true, planSha256: planned.plan.sha256 });
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'queued');
  fs.appendFileSync(path.join(store.directory(job.id), planned.plan.file), 'changed');
  handles[0].exit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(handles.length, 1);
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'failed');
});

test('child worker validates JSON before importing automation or opening browser', async t => {
  const { service, store } = fixture(t);
  const job = await create(service); const planned = await service.generatePlan(job.id, { consent: true });
  fs.appendFileSync(path.join(store.directory(job.id), planned.plan.file), 'changed');
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.stop(); reject(Error('worker did not reject invalid plan')); }, 5000);
    const worker = launchWorker({ job: planned, workDir: store.directory(job.id), invoicePath: path.join(store.directory(job.id), 'invoice.pdf') },
      event => events.push(event), () => { clearTimeout(timer); resolve(); });
  });
  assert.deepEqual(events.map(event => event.type), ['failure']);
});

test('plan API enforces session, CSRF and consent; offers formatted authenticated download', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-plan-api-'));
  const app = createApp({ dataDir, advisor });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.service.shutdown(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = await fetch(`${base}/api/session`);
  const config = await session.json(); assert.equal(config.planConfigured, true);
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken };
  const job = await create(app.service); const url = `${base}/api/jobs/${job.id}/plan`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: headers.Cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{"consent":true}' })).status, 200);
  const download = await fetch(`${url}?download=1`, { headers });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /reimbursement.v1.json/);
  const raw = await download.text(); assert.match(raw, /\n  "schemaVersion": 1,/);
  assert.deepEqual(JSON.parse(raw), app.service.getPlan(job.id));
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
});
