const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchRequestActivity, waitForRequestQuiet } = require('../dist/automation/request-activity');

test('save request wait includes a delayed request and completion, then removes listeners', async () => {
  const page = new EventEmitter();
  let loops = 0;
  const req = { resourceType: () => 'xhr' };
  page.waitForTimeout = async () => {
    if (++loops === 1) page.emit('request', req);
    else if (loops === 2) page.emit('requestfinished', req);
    await new Promise(resolve => setTimeout(resolve, 15));
  };
  const activity = watchRequestActivity(page);
  await waitForRequestQuiet(page, activity, 1000, 30);
  assert.ok(loops >= 3);
  assert.equal(activity.snapshot().pending, 0);
  assert.equal(activity.snapshot().started, 1);
  activity.dispose();
  assert.equal(page.eventNames().length, 0);
});

test('request errors and unfinished requests cannot pass the save wait', async () => {
  for (const mode of ['pending', 'failed', 'http-error']) {
    const page = new EventEmitter();
    page.waitForTimeout = async () => new Promise(resolve => setTimeout(resolve, 10));
    const activity = watchRequestActivity(page);
    const req = { resourceType: () => 'fetch' };
    page.emit('request', req);
    if (mode === 'failed') page.emit('requestfailed', req);
    if (mode === 'http-error') {
      page.emit('response', { request: () => req, status: () => 500 });
      page.emit('requestfinished', req);
    }
    await assert.rejects(waitForRequestQuiet(page, activity, 30, 5));
    activity.dispose();
  }
});

test('required query activity cannot pass on an initially idle page or an unrelated request', async () => {
  const page = new EventEmitter();
  page.waitForTimeout = async () => new Promise(resolve => setTimeout(resolve, 10));
  const activity = watchRequestActivity(page, req => req.isQuery === true);
  const unrelated = { resourceType: () => 'xhr', isQuery: false };
  page.emit('request', unrelated);
  page.emit('requestfinished', unrelated);
  await assert.rejects(waitForRequestQuiet(page, activity, 40, 5, true));
  assert.equal(activity.snapshot().started, 0);
  activity.dispose();
  assert.equal(page.eventNames().length, 0);
});

test('required query activity waits for a delayed query and its completion', async () => {
  const page = new EventEmitter();
  const req = { resourceType: () => 'xhr', isQuery: true };
  let loops = 0;
  page.waitForTimeout = async () => {
    loops++;
    if (loops === 4) page.emit('request', req);
    if (loops === 7) page.emit('requestfinished', req);
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  const activity = watchRequestActivity(page, item => item.isQuery === true);
  await waitForRequestQuiet(page, activity, 1000, 5, true);
  assert.ok(loops >= 7);
  activity.dispose();
});
