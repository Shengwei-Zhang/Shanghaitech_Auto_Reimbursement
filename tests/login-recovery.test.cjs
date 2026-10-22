const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FlowError } = require('../dist/domain/workflow');
const { canRecoverCreationLogin, withCreationLoginRecovery } = require('../dist/automation/login-recovery');

function fixture({ editor = false, portal = true, url = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new//rbReimbursement/forwardAddRbReimbursement.do?ticket=synthetic', timeout = true } = {}) {
  const actions = [];
  const menu = { filter: () => menu, getByRole: () => menu, count: async () => 1 };
  const frame = { locator: () => ({ count: async () => editor ? 1 : 0 }), getByText: () => ({ filter: () => ({ count: async () => 0 }) }) };
  let closed = false;
  const expired = { url: () => url, isClosed: () => closed, frames: () => [frame], mainFrame: () => frame,
    getByRole: () => menu, getByText: () => ({ filter: () => ({ count: async () => timeout ? 1 : 0 }) }),
    close: async () => { actions.push('close-expired'); closed = true; } };
  const workbench = { url: () => 'https://egate-new.shanghaitech.edu.cn/purple/index.html', isClosed: () => false,
    frames: () => [], bringToFront: async () => actions.push('focus-portal') };
  const pages = portal ? [workbench, expired] : [expired];
  const session = { page: expired, context: { pages: () => pages, newPage: async () => {
    actions.push('new-tab'); pages.push(workbench); return workbench;
  } } };
  const ctx = { page: expired, state: { entryAttempted: true, creationAttempted: true }, updatePage(page) { this.page = page; } };
  return { ctx, session, actions, workbench };
}

test('expired creation confirmation closes only stale tab, reauthenticates and restarts from portal once', async () => {
  const f = fixture(); let calls = 0;
  await withCreationLoginRecovery(f.session, f.ctx, true, async recovered => {
    f.actions.push(recovered ? 'search-and-create-again' : 'first-create'); calls++;
    if (!recovered) throw new FlowError('authentication');
    assert.equal(f.ctx.page, f.workbench);
    assert.equal(f.ctx.state.creationAttempted, false);
    assert.equal(f.ctx.state.entryAttempted, false);
  }, async () => f.actions.push('authenticate-and-workbench'));
  assert.equal(calls, 2);
  assert.deepEqual(f.actions, ['first-create', 'close-expired', 'focus-portal', 'authenticate-and-workbench', 'search-and-create-again']);
});

test('if no portal survives create a tab before closing expired tab', async () => {
  const f = fixture({ portal: false });
  await withCreationLoginRecovery(f.session, f.ctx, true, async recovered => {
    if (!recovered) throw new FlowError('authentication');
  }, async () => {});
  assert.deepEqual(f.actions, ['new-tab', 'close-expired', 'focus-portal']);
});

test('second expiry stops rather than repeating login or creation indefinitely', async () => {
  const f = fixture(); let attempts = 0, logins = 0;
  await assert.rejects(withCreationLoginRecovery(f.session, f.ctx, true, async () => {
    attempts++; throw new FlowError('authentication');
  }, async () => { logins++; }), { code: 'authentication' });
  assert.equal(attempts, 2); assert.equal(logins, 1);
});

test('generic timeout, existing document, reuse and cancelled jobs never close tabs or restart creation', async () => {
  for (const kind of ['network', 'editor', 'document', 'completed', 'reuse', 'upload', 'submit', 'no-expiry', 'cancel']) {
    const f = fixture({ editor: kind === 'editor', timeout: kind !== 'no-expiry',
      ...(kind === 'document' ? { url: 'https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/showLoadRbReimbursement.job?bizId=synthetic' } : {}) });
    if (kind === 'completed') f.ctx.state.creationCompleted = true;
    if (kind === 'upload') f.ctx.state.invoiceUploadAttempted = true;
    if (kind === 'submit') f.ctx.state.submissionFinalAttempted = true;
    const abort = new AbortController(); if (kind === 'cancel') abort.abort();
    let attempts = 0;
    await assert.rejects(withCreationLoginRecovery(f.session, f.ctx, kind !== 'reuse', async () => {
      attempts++; throw new FlowError(kind === 'network' ? 'control_missing' : 'authentication');
    }, async () => { throw Error('must not login'); }, abort.signal));
    assert.equal(attempts, 1); assert.deepEqual(f.actions, []);
  }
});

test('menu guard requires current BPM creation route and refuses document markers even with expired session', async () => {
  for (const url of ['https://other.example/forwardAddRbReimbursement.do',
    'https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/unknown',
    'https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/showLoadRbReimbursement.job?taskId=x']) {
    const f = fixture({ url }); assert.equal(await canRecoverCreationLogin(f.ctx, f.session), false);
  }
});
