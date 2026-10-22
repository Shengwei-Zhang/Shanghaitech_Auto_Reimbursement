const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openSubmissionDialog } = require('../dist/automation/submission');

function fixture(location, existing = false, openAfter = 1) {
  let opened = existing, clicks = 0, waits = 0;
  const empty = { filter: () => empty, count: async () => 0, all: async () => [] };
  const dialog = { locator: () => empty };
  const root = name => ({ url: () => 'https://sapbpm-new.shanghaitech.edu.cn/form', locator: () => {
    const list = { filter: () => list, count: async () => opened && location === name ? 1 : 0,
      all: async () => opened && location === name ? [dialog] : [] };
    return list;
  } });
  const main = root('main'), child = root('child');
  const page = Object.assign(new EventEmitter(), { ...main, frames: () => [main, child], mainFrame: () => main,
    waitForTimeout: async ms => { waits++; await new Promise(resolve => setTimeout(resolve, ms)); } });
  const button = { filter: () => button, first: () => button, count: async () => 1, waitFor: async () => {},
    isVisible: async () => true, isEnabled: async () => true,
    click: async () => { clicks++; opened = clicks >= openAfter; } };
  const ctx = { page, state: {}, activeFrame: child, locator: () => button,
    root() { return this.activeFrame || this.page; },
    setActiveFrame(frame) { this.activeFrame = frame; } };
  return { ctx, dialog, child, button, clicks: () => clicks, waits: () => waits };
}

test('submission locates the outer-page flow dialog after clicking in the editor frame once', async () => {
  const f = fixture('main');
  assert.equal(await openSubmissionDialog(f.ctx, 100), f.dialog);
  assert.equal(f.ctx.activeFrame, null);
  assert.equal(f.clicks(), 1);
  assert.equal(f.waits(), 0);
});

test('submission locates confirmation in a child frame and adopts its context', async () => {
  const f = fixture('child');
  assert.equal(await openSubmissionDialog(f.ctx, 100), f.dialog);
  assert.equal(f.ctx.activeFrame, f.child);
  assert.equal(f.clicks(), 1);
});

test('existing confirmation is reused without repeating the form submit', async () => {
  const f = fixture('main', true);
  assert.equal(await openSubmissionDialog(f.ctx, 100), f.dialog);
  assert.equal(f.clicks(), 0);
});

test('missing flow dialog never reports success or retries submission', async () => {
  const f = fixture('missing');
  await assert.rejects(openSubmissionDialog(f.ctx, 20), { code: 'submission_unknown' });
  await assert.rejects(openSubmissionDialog(f.ctx, 20), { code: 'submission_unknown' });
  assert.equal(f.clicks(), 1);
});

test('an inert first click may be retried, and dialog detection stops further clicks', async () => {
  const f = fixture('main', false, 2);
  assert.equal(await openSubmissionDialog(f.ctx, 800), f.dialog);
  assert.equal(f.clicks(), 2);
  assert.equal(f.ctx.page.listenerCount('request'), 0);
  assert.equal(f.ctx.page.listenerCount('dialog'), 0);
});

test('no-response attempts are capped at three without a final confirmation', async () => {
  const f = fixture('missing');
  await assert.rejects(openSubmissionDialog(f.ctx, 700), { code: 'submission_unknown' });
  assert.equal(f.clicks(), 3);
});

test('pending or completed requests prevent retrying an uncertain action', async () => {
  for (const finish of [false, true]) {
    const f = fixture('missing');
    const click = f.button.click;
    f.button.click = async () => {
      await click();
      const req = { resourceType: () => 'xhr' };
      f.ctx.page.emit('request', req);
      if (finish) f.ctx.page.emit('requestfinished', req);
    };
    await assert.rejects(openSubmissionDialog(f.ctx, 500), { code: 'submission_unknown' });
    assert.equal(f.clicks(), 1);
  }
});

test('native alert, navigation, failed click, and new window cannot trigger repeated clicks', async () => {
  for (const event of ['dialog', 'popup', 'navigation', 'click-error']) {
    const f = fixture('missing');
    const click = f.button.click;
    f.button.click = async () => {
      await click();
      if (event === 'navigation') f.ctx.page.url = () => 'https://sapbpm-new.shanghaitech.edu.cn/other';
      else if (event === 'click-error') throw Error('click timed out');
      else f.ctx.page.emit(event, {});
    };
    await assert.rejects(openSubmissionDialog(f.ctx, 500), { code: 'submission_unknown' });
    assert.equal(f.clicks(), 1);
  }
});

test('a visible validation message or loading mask blocks a second click', async () => {
  const f = fixture('missing');
  const locator = f.ctx.page.locator;
  f.ctx.page.locator = selector => selector.includes('[role="alert"]')
    ? { filter: () => ({ count: async () => 1 }) } : locator(selector);
  await assert.rejects(openSubmissionDialog(f.ctx, 500), { code: 'submission_unknown' });
  assert.equal(f.clicks(), 1);
});
