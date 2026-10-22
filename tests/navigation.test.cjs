const { test } = require('node:test');
const assert = require('node:assert/strict');
const { focusBestBusinessPage, runAndFocusBpmPage } = require('../dist/automation/navigation');

function page(url, frames = [], closed = false) {
  return { url: () => url, frames: () => frames.map(url => ({ url: () => url })),
    isClosed: () => closed, focused: false, async bringToFront() { this.focused = true; } };
}

test('failure inspection preserves the failing page and invoice frame despite newer tabs', async () => {
  const failing = page('https://egate-new.shanghaitech.edu.cn/orange/index.html',
    ['https://sapbpm-new.shanghaitech.edu.cn/form']);
  const other = page('https://sapbpm-new.shanghaitech.edu.cn/another-form');
  const activeFrame = {};
  const ctx = { page: failing, activeFrame, updatePage() { throw Error('must preserve invoice frame'); } };
  const session = { context: { pages: () => [failing, other] } };
  assert.equal(await focusBestBusinessPage(session, ctx), failing);
  assert.equal(ctx.activeFrame, activeFrame);
  assert.equal(failing.focused, true);
  assert.equal(other.focused, false);
});

test('same-tab BPM navigation proceeds immediately without waiting for a popup', async () => {
  const original = page('https://egate-new.shanghaitech.edu.cn/orange/index.html');
  const session = { page: original, context: { pages: () => [original],
    waitForEvent: async () => { throw Error('must not wait for popup'); } } };
  const ctx = { page: original, updatePage(next) { this.page = next; } };
  assert.equal(await runAndFocusBpmPage(session, ctx, async () => {
    original.url = () => 'https://sapbpm-new.shanghaitech.edu.cn/form';
  }, 1000), original);
  assert.equal(original.focused, true);
});

test('delayed popup is discovered while an old unrelated reimbursement tab is ignored', async () => {
  const original = page('https://egate-new.shanghaitech.edu.cn/orange/index.html');
  const stale = page('https://sapbpm-new.shanghaitech.edu.cn/old-form');
  const fresh = page('https://sapbpm-new.shanghaitech.edu.cn/create');
  const pages = [original, stale];
  const session = { page: original, context: { pages: () => pages } };
  const ctx = { page: original, updatePage(next) { this.page = next; } };
  await runAndFocusBpmPage(session, ctx, async () => { setTimeout(() => pages.push(fresh), 20); }, 1000);
  assert.equal(ctx.page, fresh);
  assert.equal(stale.focused, false);
});

test('when failing tab has closed, inspection finds BPM inside an iframe', async () => {
  const closed = page('https://sapbpm-new.shanghaitech.edu.cn/closed', [], true);
  const business = page('https://egate-new.shanghaitech.edu.cn/orange/index.html',
    ['https://sapbpm-new.shanghaitech.edu.cn/form']);
  const home = page('https://egate-new.shanghaitech.edu.cn/orange/index.html');
  const ctx = { page: closed, updatePage(next) { this.page = next; } };
  const session = { context: { pages: () => [closed, business, home] } };
  assert.equal(await focusBestBusinessPage(session, ctx), business);
  assert.equal(ctx.page, business);
});
