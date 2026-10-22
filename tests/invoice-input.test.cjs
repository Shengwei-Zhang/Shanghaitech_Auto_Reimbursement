const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateInvoiceInput } = require('../dist/automation/invoice-input');
const { executeAutomation } = require('../dist/automation/execute');
const browserModule = require('../dist/automation/browser');
const flowModule = require('../dist/automation/reimbursement-flow');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-invoice-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdf = path.join(dir, '发票（科研服务）.PDF');
  await fs.writeFile(pdf, '%PDF-1.4\nsynthetic invoice header');
  return { dir, pdf };
}

function setRunEnvironment(t, file) {
  const values = { UPLOAD_FILE_PATH: file, START_FROM: '', RESUME_EXISTING: 'false' };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
}

test('accepts a readable single PDF with Chinese name and uppercase extension', async t => {
  const { pdf } = await fixture(t);
  await validateInvoiceInput(pdf);
});

test('rejects missing, empty and non-PDF input with per-invoice guidance', async t => {
  const { dir } = await fixture(t);
  const empty = path.join(dir, 'empty.pdf'), disguised = path.join(dir, 'disguised.pdf');
  const other = path.join(dir, 'invoice.txt');
  await fs.writeFile(empty, '');
  await fs.writeFile(disguised, 'not a PDF');
  await fs.writeFile(other, '%PDF-1.4');
  for (const [file, reason] of [
    ['', /尚未设置/], [path.join(dir, 'missing.pdf'), /不存在/],
    [empty, /为空/], [disguised, /内容不是 PDF/], [other, /扩展名/],
  ]) {
    await assert.rejects(validateInvoiceInput(file), error => {
      assert.match(error.message, reason);
      assert.match(error.message, /每张发票单独创建任务/);
      assert.match(error.message, /不同经费项目或预算科目请分别办理/);
      return true;
    });
  }
});

test('unreadable input reports a file permission error', async t => {
  const { pdf } = await fixture(t);
  t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }); });
  await assert.rejects(validateInvoiceInput(pdf), /无法读取.*文件权限/);
});

test('directory containing PDFs is rejected before browser startup or business work', async t => {
  const { dir } = await fixture(t);
  setRunEnvironment(t, dir);
  const launch = t.mock.method(browserModule, 'createBrowserSession', async () => { throw new Error('must not launch'); });
  const run = t.mock.method(flowModule, 'runReimbursementFlowWithErrorHandling', async () => { throw new Error('must not run'); });
  await assert.rejects(executeAutomation({}), /指向目录.*每张发票单独创建任务/);
  assert.equal(launch.mock.callCount(), 0);
  assert.equal(run.mock.callCount(), 0);
});

test('valid single PDF allows exactly one browser startup and one workflow run', async t => {
  const { pdf } = await fixture(t);
  setRunEnvironment(t, pdf);
  const browser = new EventEmitter();
  const session = { browser, context: {}, page: {} };
  const expected = { documentNumber: 'synthetic', amount: '1.00', action: 'save' };
  const launch = t.mock.method(browserModule, 'createBrowserSession', async () => session);
  const close = t.mock.method(browserModule, 'closeBrowserSession', async observed => assert.equal(observed, session));
  const run = t.mock.method(flowModule, 'runReimbursementFlowWithErrorHandling', async observed => {
    assert.equal(observed, session);
    assert.equal(process.env.UPLOAD_FILE_PATH, pdf);
    return expected;
  });
  assert.equal(await executeAutomation({}, { action: 'save' }), expected);
  assert.equal(launch.mock.callCount(), 1);
  assert.equal(run.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
});
