const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { uploadRecordedPdf } = require('../dist/automation/recorded-upload');

async function fixture(t, mode = 'success') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oa-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '电子发票 2026（科研耗材）.PDF');
  const content = Buffer.from('%PDF-1.4 synthetic file for this task');
  await writeFile(file, content);
  const page = new EventEmitter();
  page.isClosed = () => false;
  const request = { method: () => 'POST', headers: () => ({ 'content-type': 'multipart/form-data; boundary=test' }),
    response: async () => ({ ok: () => true }) };
  let choose;
  const calls = [];
  const chooser = {
    setFiles: async selected => {
      calls.push(['file', selected]);
      page.emit('request', request);
      if (mode !== 'pending') page.emit('requestfinished', request);
    },
    element: () => ({ evaluate: async () => [{ name: mode === 'wrong' ? 'other.pdf' : path.basename(file), size: content.length }] }),
  };
  page.waitForEvent = async event => { assert.equal(event, 'filechooser'); return new Promise(resolve => { choose = resolve; }); };
  const upload = { click: async () => { calls.push(['click']); choose(chooser); } };
  return { file, page, calls, upload, ctx: { page, state: { invoiceUploadAttempted: false } } };
}

test('recorded upload selects the current job PDF and does not repeat it on a second call', async t => {
  const f = await fixture(t);
  await uploadRecordedPdf(f.ctx, f.upload, f.file, 1000, 1000);
  assert.deepEqual(f.calls, [['click'], ['file', f.file]]);
  assert.equal(f.ctx.state.invoiceUploadAttempted, true);
  await assert.rejects(uploadRecordedPdf(f.ctx, f.upload, f.file, 1000, 1000), { code: 'invoice_upload_pending' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.page.listenerCount('request'), 0);
});

test('wrong file readback stops after the first upload attempt', async t => {
  const f = await fixture(t, 'wrong');
  await assert.rejects(uploadRecordedPdf(f.ctx, f.upload, f.file, 1000, 1000), { code: 'invoice_file_mismatch' });
  assert.equal(f.ctx.state.invoiceUploadAttempted, true);
  assert.equal(f.page.listenerCount('request'), 0);
});

test('unfinished upload cannot be treated as success or trigger a second file selection', async t => {
  const f = await fixture(t, 'pending');
  await assert.rejects(uploadRecordedPdf(f.ctx, f.upload, f.file, 1000, 120), { code: 'invoice_upload_pending' });
  await assert.rejects(uploadRecordedPdf(f.ctx, f.upload, f.file, 1000, 120), { code: 'invoice_upload_pending' });
  assert.deepEqual(f.calls, [['click'], ['file', f.file]]);
});
