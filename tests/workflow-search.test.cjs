const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WORKFLOW_NAME, clickWorkflowSearchResult, waitForWorkflowSearchResults } = require('../dist/automation/workflow-search');

function fixture(groups, stalled = false) {
  const clicks = [];
  const frames = groups.map(labels => ({ isDetached: () => false,
    getByText: pattern => ({ filter: () => ({ all: async () => labels.filter(label => pattern.test(label))
      .map(label => ({ click: async () => clicks.push(label) })) }) }) }));
  if (stalled) frames.unshift({ isDetached: () => false, getByText: () => ({ filter: () => ({ all: () => new Promise(() => {}) }) }) });
  const ctx = { page: { frames: () => frames, mainFrame: () => frames[0], isClosed: () => false,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)) }, state: { entryAttempted: false },
    setActiveFrame(frame) { this.activeFrame = frame; } };
  return { ctx, clicks, frames };
}

test('creation label accepts theme spacing and parentheses, never audit/query or extra words', () => {
  for (const label of ['报销单创建（电子签章）', '报销单创建 （电子签章）',
    '报销单 创建\u00a0(电子签章)', ' 报销单\n创建　（ 电子签章 ） ']) assert.equal(WORKFLOW_NAME.test(label), true, label);
  for (const label of ['报销单审核 （电子签章）', '报销单查询 （电子签章）', '报销单查询',
    '报销单创建（电子签章）说明', '其他报销单创建（电子签章）', '报销单创建']) assert.equal(WORKFLOW_NAME.test(label), false, label);
});

test('screenshot menu clicks only the creation item and marks the attempt', async () => {
  const f = fixture([['报销单审核 （电子签章）', '报销单创建 （电子签章）', '报销单查询 （电子签章）', '报销单查询']]);
  await clickWorkflowSearchResult(f.ctx, 'test', 100);
  assert.deepEqual(f.clicks, ['报销单创建 （电子签章）']);
  assert.equal(f.ctx.state.entryAttempted, true);
});

test('unresponsive unrelated frame cannot block the visible creation result', async () => {
  const f = fixture([['报销单创建 （电子签章）']], true);
  await clickWorkflowSearchResult(f.ctx, 'test', 100);
  assert.equal(f.ctx.activeFrame, f.frames[1]);
  assert.equal(f.clicks.length, 1);
});

test('ambiguous and absent creation results never click any menu item', async () => {
  for (const [groups, code] of [
    [[['报销单创建（电子签章）'], ['报销单创建 （电子签章）']], 'ambiguous_choice'],
    [[['报销单查询（电子签章）']], 'control_missing'],
  ]) {
    const f = fixture(groups);
    await assert.rejects(waitForWorkflowSearchResults(f.ctx, 30), { code });
    assert.equal(f.ctx.state.entryAttempted, false);
    assert.deepEqual(f.clicks, []);
  }
});
