const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const browserModule = require('../dist/automation/browser');
const { failureOf } = require('../dist/domain/workflow');
const { attachToExistingBusinessPage, switchToExistingBusinessPage } = browserModule;

const bpmUrl = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/form';
const egateUrl = 'https://egate-new.shanghaitech.edu.cn/green/index.html';
function page(url, closed = false) {
  return {
    currentUrl: url, closed, focused: 0,
    url() { return this.currentUrl; },
    isClosed() { return this.closed; },
    async bringToFront() { this.focused++; },
    async title() { throw Error('Resume must not read unrelated tab titles'); },
  };
}
function session(pages) {
  return { context: { pages: () => pages }, page: page('about:blank') };
}

test('resume chooses the unique BPM tab before egate, including the real OA port', async () => {
  const portal = page(egateUrl), target = page(bpmUrl), state = session([portal, target]);
  assert.equal(await attachToExistingBusinessPage(state), true);
  assert.equal(state.page, target);
  assert.equal(target.focused, 1);
  assert.equal(portal.focused, 0);
});

test('ambiguous BPM tabs are rejected without focusing a tab or changing the session', async () => {
  const first = page(bpmUrl), second = page(`${bpmUrl}?document=other`);
  const state = session([first, second, page(egateUrl)]), initial = state.page;
  await assert.rejects(attachToExistingBusinessPage(state), error => {
    assert.equal(failureOf(error).code, 'resume_page_ambiguous');
    return true;
  });
  assert.equal(state.page, initial);
  assert.equal(first.focused + second.focused, 0);
});

test('closed BPM tabs do not cause ambiguity or get selected', async () => {
  const closed = page(bpmUrl, true), target = page(bpmUrl), state = session([closed, target]);
  assert.equal(await attachToExistingBusinessPage(state, { sapbpmOnly: true }), true);
  assert.equal(state.page, target);
  assert.equal(closed.focused, 0);
  assert.equal(await attachToExistingBusinessPage(session([closed])), false);
});

test('resume matches parsed hosts, never domains embedded in another URL', async () => {
  for (const url of [
    'https://sapbpm-new.shanghaitech.edu.cn.example.org/form',
    'https://example.org/?next=https://sapbpm-new.shanghaitech.edu.cn',
    'https://sapbpm-new.shanghaitech.edu.cn@example.org/form',
    'https://example.org/egate-new.shanghaitech.edu.cn',
    'https://egate-new.shanghaitech.edu.cn.example.org/form',
    'javascript://sapbpm-new.shanghaitech.edu.cn/form',
    'not a valid url',
  ]) {
    const unrelated = page(url), state = session([unrelated]), initial = state.page;
    assert.equal(await attachToExistingBusinessPage(state), false, url);
    assert.equal(state.page, initial);
    assert.equal(unrelated.focused, 0);
  }
});

test('BPM-only mode never falls back to a workbench page', async () => {
  const portal = page(egateUrl), state = session([portal]);
  assert.equal(await attachToExistingBusinessPage(state, { sapbpmOnly: true }), false);
  assert.equal(portal.focused, 0);
  assert.equal(await attachToExistingBusinessPage(state), true);
  assert.equal(state.page, portal);
});

test('multiple workbench pages are also rejected when fallback is allowed', async () => {
  await assert.rejects(attachToExistingBusinessPage(session([page(egateUrl), page(egateUrl)])),
    { code: 'resume_page_ambiguous' });
});

test('resume diagnostics never include URL credentials, query, fragment or page title', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const target = page('https://user:secret@sapbpm-new.shanghaitech.edu.cn:9091/form?ticket=PRIVATE#PRIVATE');
  assert.equal(await attachToExistingBusinessPage(session([target])), true);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs.join('\n'), /secret|PRIVATE|ticket|https|user/);
});

test('a page that closes or leaves OA while focusing is not installed as the active page', async () => {
  for (const changed of ['closed', 'navigated']) {
    const target = page(bpmUrl), state = session([target]), initial = state.page;
    target.bringToFront = async () => {
      if (changed === 'closed') target.closed = true;
      else target.currentUrl = 'https://example.org/';
    };
    await assert.rejects(attachToExistingBusinessPage(state), { code: 'resume_page_missing' });
    assert.equal(state.page, initial);
  }
});

test('legacy resume helper never converts a missing page into a new run', async () => {
  await assert.rejects(switchToExistingBusinessPage(session([]), 'configure payment'),
    { code: 'resume_page_missing' });
  assert.equal(await switchToExistingBusinessPage(session([]), ''), '');
  assert.equal(await switchToExistingBusinessPage(session([page(bpmUrl)]), 'configure payment'), 'configure payment');
});

test('execute reports missing resume page, closes the session and never starts the business flow', async t => {
  const oldEnv = Object.fromEntries(['RESUME_EXISTING', 'START_FROM'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.RESUME_EXISTING = 'true';
  process.env.START_FROM = '';
  t.mock.method(require('../dist/automation/invoice-input'), 'validateInvoiceInput', async () => {});
  const browser = new EventEmitter();
  browser.isConnected = () => true;
  t.mock.method(browserModule, 'createBrowserSession', async () => ({ ...session([]), browser }));
  const close = t.mock.method(browserModule, 'closeBrowserSession', async () => {});
  const run = t.mock.method(require('../dist/automation/reimbursement-flow'), 'runReimbursementFlowWithErrorHandling',
    async () => { throw Error('must not run'); });
  const { executeAutomation } = require('../dist/automation/execute');
  await assert.rejects(executeAutomation({}), { code: 'resume_page_missing' });
  assert.equal(close.mock.callCount(), 1);
  assert.equal(run.mock.callCount(), 0);
});
