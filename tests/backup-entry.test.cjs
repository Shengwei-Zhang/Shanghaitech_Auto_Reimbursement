const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openBackupEntry, BACKUP_REIMBURSEMENT_URL } = require('../dist/automation/backup-entry');
const { FlowError } = require('../dist/domain/workflow');
test('blocked clicks and failed search input do not silently switch to the backup', () => {
  const { canUseBackupEntry } = require('../dist/automation/backup-entry');
  assert.equal(canUseBackupEntry(new FlowError('workbench_search_pending')), true);
  assert.equal(canUseBackupEntry(new FlowError('workbench_search_blocked')), false);
  assert.equal(canUseBackupEntry(new FlowError('workbench_search_input_failed')), false);
});
function setup(mode = 'menu') {
  let opened = 0, navigations = [];
  const button = { getByRole: () => button, filter: () => button, count: async () => mode === 'menu' ? 1 : 0 };
  const page = { bringToFront: async () => {}, goto: async url => navigations.push(url), isClosed: () => false,
    url: () => mode === 'login' ? 'https://ids.shanghaitech.edu.cn/authserver/login' : BACKUP_REIMBURSEMENT_URL,
    locator: () => ({ innerText: async () => '' }), getByRole: () => button,
    frames: () => [{ locator: () => ({ isVisible: async () => mode === 'editor' }) }], waitForTimeout: async () => {} };
  const ctx = { state: { entryAttempted: false, backupEntryAttempted: false, creationAttempted: false }, updatePage(p) { this.page = p; } };
  const session = { context: { newPage: async () => { opened++; return page; } } };
  return { ctx, session, page, navigations, opened: () => opened };
}
test('backup opens the exact ticket-free URL once in the current browser context', async () => {
  const f = setup(); await openBackupEntry(f.session, f.ctx, 100);
  assert.deepEqual(f.navigations, [BACKUP_REIMBURSEMENT_URL]);
  assert.equal(new URL(f.navigations[0]).search, '');
  assert.equal(f.session.page, f.page); assert.equal(f.ctx.page, f.page);
  await assert.rejects(openBackupEntry(f.session, f.ctx), e => e.code === 'entry_result_unknown');
  assert.equal(f.opened(), 1);
});
test('a primary entry or creation attempt forbids fallback even if it failed', async () => {
  for (const flag of ['entryAttempted', 'creationAttempted']) {
    const f = setup(); f.ctx.state[flag] = true;
    await assert.rejects(openBackupEntry(f.session, f.ctx), e => e.code === 'entry_result_unknown');
    assert.equal(f.opened(), 0);
  }
});
test('editor, authentication redirect and unknown page do not count as new creation', async () => {
  for (const [mode, code] of [['editor', 'backup_form_review'], ['login', 'authentication'], ['unknown', 'backup_entry_unavailable']]) {
    const f = setup(mode);
    await assert.rejects(openBackupEntry(f.session, f.ctx, mode === 'unknown' ? 0 : 100), e => e.code === code);
    assert.equal(f.opened(), 1);
  }
});
test('main flow uses backup after workbench failure only for new tasks', async () => {
  const auth = require('../dist/automation/auth');
  const workbench = require('../dist/automation/workbench');
  const backup = require('../dist/automation/backup-entry');
  const { runReimbursementFlow } = require('../dist/automation/reimbursement-flow');
  const { setStartFromStep } = require('../dist/automation/runner');
  const originals = [auth.authenticateSchool, auth.isEgateLoggedIn, workbench.openWorkbench, backup.openBackupEntry];
  const before = process.env.UPLOAD_FILE_PATH;
  process.env.UPLOAD_FILE_PATH = '/synthetic.pdf';
  let backups = 0;
  auth.authenticateSchool = async p => p; auth.isEgateLoggedIn = async () => true;
  workbench.openWorkbench = async () => { throw new FlowError('workbench_search_missing'); };
  backup.openBackupEntry = async () => { backups++; throw new FlowError('backup_form_review'); };
  const page = {};
  const ctx = { page, state: {}, setStage() {}, updatePage(p) { this.page = p; } };
  try {
    setStartFromStep('');
    await assert.rejects(runReimbursementFlow({ page }, {}, ctx, { formMode: 'new' }), e => e.code === 'backup_form_review');
    assert.equal(backups, 1);
    setStartFromStep('');
    await assert.rejects(runReimbursementFlow({ page }, {}, ctx, { formMode: 'reuse' }), e => e.code === 'workbench_search_missing');
    assert.equal(backups, 1);
  } finally {
    [auth.authenticateSchool, auth.isEgateLoggedIn, workbench.openWorkbench, backup.openBackupEntry] = originals;
    if (before === undefined) delete process.env.UPLOAD_FILE_PATH; else process.env.UPLOAD_FILE_PATH = before;
  }
});
