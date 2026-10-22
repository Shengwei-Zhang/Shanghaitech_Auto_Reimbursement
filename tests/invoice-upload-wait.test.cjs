const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchInvoiceUpload } = require('../dist/automation/invoice-upload-wait');

function setup() {
  const page = new EventEmitter();
  page.isClosed = () => false;
  const request = { headers: () => ({ 'content-type': 'multipart/form-data; boundary=test' }),
    method: () => 'POST', response: async () => ({ ok: () => true }) };
  return { page, request, observer: watchInvoiceUpload(page) };
}

test('file transfer waits for the complete response body, not setFiles or unrelated responses', async () => {
  const { page, request, observer } = setup();
  let completed = false;
  const waiting = observer.wait(1000).then(() => { completed = true; });
  page.emit('request', { ...request, headers: () => ({ 'content-type': 'application/json' }) });
  page.emit('request', request);
  page.emit('response', { ok: () => true });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(completed, false);
  page.emit('requestfinished', request);
  await waiting;
  observer.dispose();
  assert.equal(completed, true);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('requestfinished'), 0);
});

test('failed or unfinished uploads pause without claiming upload success', async () => {
  for (const mode of ['http', 'network', 'pending', 'unobserved']) {
    const { page, request, observer } = setup();
    if (mode !== 'unobserved') page.emit('request', request);
    if (mode === 'http') {
      request.response = async () => ({ ok: () => false });
      page.emit('requestfinished', request);
    }
    if (mode === 'network') page.emit('requestfailed', request);
    await assert.rejects(observer.wait(250), { code: ['http', 'network'].includes(mode)
      ? 'invoice_upload_failed' : 'invoice_upload_pending' });
    observer.dispose();
  }
});
