const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../dist/server/app');
const { JobService, LOCAL_OWNER } = require('../dist/application/job-service');
const { JobStore } = require('../dist/infrastructure/job-store');
const input = { purpose: '科研耗材', reason: '采购实验耗材用于科研样本制备', payeeCode: 'TEST01', fundingKeyword: '项目A', budgetKeyword: '材料费', amount: '120.10', attachmentCount: 1 };
const advisor = { review: async () => ({ source: 'deepseek', summary: '测试建议', concerns: [], suggestions: [], createdAt: new Date().toISOString() }) };
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oa-v4-test-')); }
function fixture(t, launcher, siteProfile) { const store = new JobStore(temp(t)); const service = new JobService(store, advisor, true, launcher, undefined, siteProfile); t.after(() => { service.shutdown(); fs.rmSync(store.root, { recursive: true, force: true }); }); return { store, service }; }

// Synthetic PDF; no real invoice or personal information.
function pdf(text) {
  const stream = `BT /F1 14 Tf 30 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return { name: 'test-invoice.pdf', base64: Buffer.from(result).toString('base64') };
}

test('real PDF preflight, duplicate identity, tamper detection and private storage', async t => {
  const { service, store } = fixture(t, () => { throw new Error('Not expected'); });
  const invoice = pdf('26117000000000000001');
  const job = await service.create({ mode: 'live', input, invoice });
  assert.equal(job.invoice.number, '26117000000000000001');
  const again = await service.create({ mode: 'live', input, invoice });
  assert.notEqual(again.id, job.id);
  assert.throws(() => store.get(job.id, 'other-user'), error => error.status === 404);
  assert.throws(() => store.get('../../etc/passwd', LOCAL_OWNER), error => error.status === 404);
  const file = path.join(store.directory(job.id), 'invoice.pdf');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.appendFileSync(file, 'changed');
  assert.throws(() => service.start(job.id, { confirmed: true, credentials: { username: 'test-user', password: 'secret' } }), error => error.status === 409);
  assert.equal(fs.readFileSync(path.join(store.directory(job.id), 'job.json'), 'utf8').includes('secret'), false);
});

test('reject corrupt PDFs, disguised names and invalid input before launching a browser', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.create({ mode: 'live', input, invoice: { name: '../a.pdf', base64: '' } }), /文件名/);
  await assert.rejects(service.create({ mode: 'live', input, invoice: { name: 'a.pdf', base64: Buffer.from('not-pdf').toString('base64') } }), /有效 PDF/);
  await assert.rejects(service.create({ mode: 'live', input, invoice: pdf('no invoice number') }), /识别/);
  await assert.rejects(service.create({ mode: 'live', input, invoice: { name: 'a.pdf', base64: '!!!!' } }), /编码/);
});

test('queue is serial, repeated start is idempotent and raw credentials are never stored', async t => {
  const launched = [];
  const { service, store } = fixture(t, (request, event, exit) => {
    const handle = { request, event, exit, stopped: false };
    launched.push(handle); return { stop() { handle.stopped = true; setImmediate(exit); } };
  });
  const a = await service.create({ mode: 'live', input, invoice: pdf('26117000000000000002') });
  const b = await service.create({ mode: 'demo', input });
  const auth = { confirmed: true, credentials: { username: 'test-user', password: 'test-password' } };
  service.start(a.id, auth); service.start(a.id, auth); service.start(b.id, { confirmed: true });
  assert.equal(launched.length, 1);
  assert.equal(store.get(b.id, LOCAL_OWNER).status, 'queued');
  const serialized = JSON.stringify(store.list(LOCAL_OWNER));
  assert.equal(serialized.includes('test-password'), false);
  assert.equal(serialized.includes('test-user'), false);
  launched[0].event({ type: 'result', result: { documentNumber: 'A-TEST', amount: '120.10' } });
  launched[0].exit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(a.id, LOCAL_OWNER).status, 'needs_review');
  assert.equal(launched.length, 2);
  assert.throws(() => service.start(a.id, auth), /不允许自动重放/);
  service.cancel(b.id);
  assert.equal(store.get(b.id, LOCAL_OWNER).status, 'interrupted');
  launched[1].event({ type: 'result', result: { documentNumber: 'late', amount: '120.10' } });
  assert.equal(store.get(b.id, LOCAL_OWNER).status, 'interrupted');
  await new Promise(resolve => setImmediate(resolve));
});

test('queued cancellation, restart recovery and reviewer consent do not replay tasks', async t => {
  const { service, store } = fixture(t, () => ({ stop() {} }));
  const a = await service.create({ mode: 'demo', input });
  const b = await service.create({ mode: 'demo', input });
  await assert.rejects(service.review(a.id, {}), /确认/);
  assert.equal((await service.review(a.id, { consent: true, question: '用途说明哪里存在歧义？' })).advisory.summary, '测试建议');
  assert.throws(() => service.start(a.id, {}), /确认/);
  service.start(a.id, { confirmed: true }); service.start(b.id, { confirmed: true });
  service.cancel(b.id); assert.equal(store.get(b.id, LOCAL_OWNER).status, 'cancelled');
  store.recover(LOCAL_OWNER); assert.equal(store.get(a.id, LOCAL_OWNER).status, 'interrupted');
});

test('manual reconciliation requires explicit confirmation and preserves the audit trail', async t => {
  let handle;
  const { service, store } = fixture(t, (_, event, exit) => { handle = { event, exit }; return { stop() {} }; });
  const invoice = pdf('26117000000000000003');
  const job = await service.create({ mode: 'live', input, invoice });
  assert.throws(() => service.reconcile(job.id, { confirmed: true, outcome: 'not_saved' }), /不需要人工核验/);
  service.start(job.id, { confirmed: true, credentials: { username: 'test-user', password: 'secret' } });
  handle.event({ type: 'failure' });
  assert.throws(() => service.reconcile(job.id, { confirmed: true, outcome: 'not_saved' }), /尚未完全退出/);
  handle.exit();
  assert.throws(() => service.reconcile(job.id, { outcome: 'not_saved' }), /明确确认/);
  const replacement = await service.create({ mode: 'live', input, invoice });
  assert.notEqual(job.id, replacement.id);
  service.reconcile(job.id, { confirmed: true, outcome: 'not_saved' });
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'released');
  assert.match(store.get(job.id, LOCAL_OWNER).events.at(-1).message, /用户已确认/);
});

test('manual handoff keeps its worker and queue slot until explicit feedback, with no automatic final click', async t => {
  const handles = [];
  const { service, store } = fixture(t, (_, event, exit) => {
    const handle = { event, exit, confirmations: 0 };
    handles.push(handle);
    return { stop() {}, completeManual() { handle.confirmations++; } };
  });
  const job = await service.create({ mode: 'live', action: 'submit', input, invoice: pdf('26117000000000000004') });
  const queued = await service.create({ mode: 'demo', input });
  service.start(job.id, { confirmed: true, credentials: { username: 'test-user', password: 'secret' } });
  service.start(queued.id, { confirmed: true });
  handles[0].event({ type: 'manual_required', summary: { documentNumber: 'A20260001', amount: '120.10' } });
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'waiting_manual');
  assert.equal(store.get(queued.id, LOCAL_OWNER).status, 'queued');
  assert.equal(handles.length, 1);
  service.start(job.id, { confirmed: true }); assert.equal(handles.length, 1);
  assert.throws(() => service.completeManual(job.id, {}), /明确反馈/);
  assert.equal(handles[0].confirmations, 0);
  service.completeManual(job.id, { confirmed: true });
  assert.equal(handles[0].confirmations, 1);
  assert.throws(() => service.completeManual(job.id, { confirmed: true }), /没有正在等待/);
  handles[0].event({ type: 'result', result: { documentNumber: 'A20260001', amount: '120.10', action: 'submit', verification: 'user_confirmed' } });
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'verified');
  assert.notEqual(store.get(job.id, LOCAL_OWNER).status, 'submitted');
  handles[0].exit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(handles.length, 2);
  service.cancel(queued.id); handles[1].exit();
});

test('manual waiting is recoverable as interrupted and failure output never leaks raw exceptions', async t => {
  let emit;
  const { service, store } = fixture(t, (_, event) => { emit = event; return { stop() {} }; });
  const job = await service.create({ mode: 'live', input, invoice: pdf('26117000000000000005') });
  service.start(job.id, { confirmed: true, credentials: { username: 'test-user', password: 'secret' } });
  emit({ type: 'manual_required', summary: { documentNumber: 'A20260001', amount: '120.10' } });
  store.recover(LOCAL_OWNER);
  assert.equal(store.get(job.id, LOCAL_OWNER).status, 'interrupted');
  emit({ type: 'failure', failure: { code: 'unexpected', message: 'secret', recovery: 'secret', uncertain: false } });
  assert.equal(JSON.stringify(store.get(job.id, LOCAL_OWNER)).includes('secret'), false);
});

test('live task can use manual school login without collecting credentials', async t => {
  let request;
  const { service, store } = fixture(t, value => { request = value; return { stop() {} }; });
  const job = await service.create({ mode: 'live', input, invoice: pdf('26117000000000000006') });
  service.start(job.id, { confirmed: true, loginMode: 'manual', credentials: { username: 'unused', password: 'discard-this' } });
  assert.equal(request.job.loginMode, 'manual');
  assert.equal(request.credentials, undefined);
  assert.equal(JSON.stringify(store.get(job.id, LOCAL_OWNER)).includes('discard-this'), false);
});

test('HTTP origin/session/CSRF protection and end-to-end demo child process', async t => {
  const dataDir = temp();
  const app = createApp({ dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.service.shutdown(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const badHost = await new Promise(resolve => { const req = require('node:http').get(`${base}/api/session`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', () => resolve(0)); });
  assert.equal(badHost, 403);
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const config = await session.json(); assert.equal(config.liveEnabled, false);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken };
  const noCsrf = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noCsrf.status, 403);
  const badJson = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: '{' }); assert.equal(badJson.status, 400);
  const created = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ mode: 'demo', input }) });
  assert.equal(created.status, 201); const { job } = await created.json();
  const start = await fetch(`${base}/api/jobs/${job.id}/start`, { method: 'POST', headers, body: '{"confirmed":true}' }); assert.equal(start.status, 200);
  let completed;
  for (let i = 0; i < 70; i++) {
    completed = (await (await fetch(`${base}/api/jobs/${job.id}`, { headers })).json()).job;
    if (completed.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completed.status, 'completed');
  // The worker reports completion before its process exits; its exit must not reach a deleted data folder.
  for (let i = 0; i < 100 && app.service.running; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.service.running, 0, 'the demo worker has exited');
  assert.equal(completed.events.filter(event => event.state === 'completed').length, 14);
  assert.equal(completed.result.documentNumber, '演示单据');
  assert.equal((await fetch(`${base}/data/jobs/${job.id}/job.json`)).status, 404);
});

test('invoice inspection is read-only and an unrecognized total needs explicit amount', async t => {
  const { inspectInvoice } = require('../dist/application/job-service');
  const { service, store } = fixture(t);
  const upload = pdf('26117000000000000077');
  const result = await inspectInvoice(upload);
  assert.equal(result.invoice.number, '26117000000000000077');
  assert.equal(result.invoice.amount, undefined);
  assert.equal(store.list(LOCAL_OWNER).length, 0);
  await assert.rejects(service.create({ mode: 'live', input: { ...input, amount: '' }, invoice: upload }), /实报金额/);
  const job = await service.create({ mode: 'live', input: { ...input, reason: '' }, invoice: upload });
  assert.equal(job.input.reason, input.purpose);
  assert.equal(job.input.reimbursementType, '用款申请单');
});

test('failure inspection holds queue, sanitizes errors, supports stop and preserves failure after close', async t => {
  const handles = [];
  const { service, store } = fixture(t, (_, event, exit) => {
    const handle = { event, exit, stopped: false }; handles.push(handle);
    return { stop() { handle.stopped = true; } };
  });
  const first = await service.create({ mode: 'live', input, invoice: pdf('26117000000000000088') });
  const second = await service.create({ mode: 'demo', input });
  service.start(first.id, { confirmed: true, loginMode: 'manual' });
  service.start(second.id, { confirmed: true });
  handles[0].event({ type: 'inspection_required', stage: 'open workbench', failure: { code: 'workbench_search_missing', message: 'secret', recovery: 'secret' } });
  const paused = store.get(first.id, LOCAL_OWNER);
  assert.equal(paused.status, 'waiting_review');
  assert.equal(paused.events.at(-1).stage, 'open workbench');
  assert.equal(JSON.stringify(paused).includes('secret'), false);
  assert.equal(handles.length, 1);
  assert.throws(() => service.reconcile(first.id, { confirmed: true, outcome: 'not_saved' }));
  handles[0].exit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(first.id, LOCAL_OWNER).status, 'failed');
  assert.equal(handles.length, 2);
  service.cancel(second.id); handles[1].exit();
  const third = await service.create({ mode: 'live', input, invoice: pdf('26117000000000000089') });
  service.start(third.id, { confirmed: true, loginMode: 'manual' });
  handles[2].event({ type: 'inspection_required', stage: 'open workbench', failure: { code: 'workbench_search_missing' } });
  service.cancel(third.id);
  assert.equal(handles[2].stopped, true);
  assert.equal(store.get(third.id, LOCAL_OWNER).status, 'interrupted');
  handles[2].event({ type: 'failure' });
  assert.equal(store.get(third.id, LOCAL_OWNER).status, 'interrupted');
  handles[2].exit();
});


test('automatic submission binds the receipt to the validated job document without manual waiting', async t => {
  const profile = { version: 1, saveResponse: { pathname: '/save', field: 'success', equals: true },
    receipt: { container: '#receipt', documentNumber: '.number', amount: '.amount', status: '.status', savedStatuses: ['已保存'], submittedStatuses: ['审批中'] } };
  for (const scenario of ['matching', 'no-summary', 'wrong-document', 'wrong-amount', 'draft', 'no-profile']) {
    let emit;
    const { service, store } = fixture(t, (_, event) => { emit = event; return { stop() {} }; }, scenario === 'no-profile' ? undefined : profile);
    const job = await service.create({ mode: 'live', action: 'submit', input, invoice: pdf('26117000000000000088') });
    service.start(job.id, { confirmed: true, loginMode: 'manual' });
    if (scenario !== 'no-summary') emit({ type: 'submission_validated', summary: {
      documentNumber: scenario === 'wrong-document' ? 'A20269999' : 'A20260001', amount: scenario === 'wrong-amount' ? '999.00' : '120.10' } });
    assert.equal(store.get(job.id, LOCAL_OWNER).status, 'running');
    assert.equal(store.get(job.id, LOCAL_OWNER).manualSummary, undefined);
    emit({ type: 'result', result: { action: 'submit', verification: 'receipt', documentNumber: 'A20260001', amount: '120.10',
      receipt: { documentNumber: 'A20260001', amount: '120.10', status: scenario === 'draft' ? '已保存' : '审批中', source: 'reloaded_oa_page', verifiedAt: new Date().toISOString() } } });
    assert.equal(store.get(job.id, LOCAL_OWNER).status, scenario === 'matching' ? 'submitted' : 'needs_review');
    if (scenario !== 'matching') assert.equal(store.get(job.id, LOCAL_OWNER).result.verification, 'unverified');
  }
});


test('OA worker uploads the exact original filename and unchanged bytes, including archived jobs', async t => {
  for (const name of ['电子发票 2026（科研耗材）.PDF', 'digital_26117000000000000077.pdf', 'invoice.pdf']) {
    let request;
    const { service, store } = fixture(t, value => { request = value; return { stop() {} }; });
    const upload = { ...pdf('26117000000000000077'), name };
    const job = await service.create({ mode: 'live', input, invoice: upload });
    // Existing tasks already store invoice.pdf and retain the original name in job metadata.
    assert.ok(fs.existsSync(path.join(store.directory(job.id), 'invoice.pdf')));
    service.start(job.id, { confirmed: true, loginMode: 'manual' });
    assert.equal(path.basename(request.invoicePath), name);
    assert.deepEqual(fs.readFileSync(request.invoicePath), Buffer.from(upload.base64, 'base64'));
    assert.equal(fs.statSync(request.invoicePath).mode & 0o777, 0o600);
    assert.equal(store.get(job.id, LOCAL_OWNER).invoice.name, name);
  }
});
