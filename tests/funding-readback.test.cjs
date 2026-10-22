const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertFundingChoice } = require('../dist/automation/funding');

function fixture(values) {
  let reads = 0, waits = 0;
  const section = { filter: () => section, count: async () => 1,
    innerText: async () => values[Math.min(reads++, values.length - 1)] };
  const ctx = { locator: () => section, page: { waitForTimeout: async ms => {
    waits++; await new Promise(resolve => setTimeout(resolve, ms));
  } } };
  return { ctx, reads: () => reads, waits: () => waits };
}

test('funding readback waits for async main-form update and tolerates layout whitespace only', async () => {
  process.env.FUNDING_ITEM_KEYWORD = 'TEST-001-项目甲';
  process.env.BUDGET_OUTLAY_KEYWORD = '23-委托服务费';
  const f = fixture(['', 'TEST-001-项目甲', 'TEST-001-\n项目甲 23-委托\n 服务费']);
  await assertFundingChoice(f.ctx, 1000);
  assert.equal(f.reads(), 3);
  assert.equal(f.waits(), 2);
});

test('matching funding returns immediately without an extra delay', async () => {
  process.env.FUNDING_ITEM_KEYWORD = 'TEST-001-项目甲';
  process.env.BUDGET_OUTLAY_KEYWORD = '23-委托服务费';
  const f = fixture(['TEST-001-项目甲 23-委托服务费']);
  await assertFundingChoice(f.ctx, 1000);
  assert.equal(f.waits(), 0);
});

test('genuine mismatches identify project, budget, or both without accepting another code', async () => {
  process.env.FUNDING_ITEM_KEYWORD = 'TEST-001-项目甲';
  process.env.BUDGET_OUTLAY_KEYWORD = '23-委托服务费';
  for (const [text, code] of [
    ['TEST-002-项目甲 23-委托服务费', 'funding_project_mismatch'],
    ['TEST-001-项目甲 24-材料费', 'funding_budget_mismatch'],
    ['TEST-002-项目甲 24-材料费', 'funding_choice_mismatch'],
  ]) {
    await assert.rejects(assertFundingChoice(fixture([text]).ctx, 30), { code });
  }
});

test('a replaced section is retried instead of immediately rejecting its stale locator', async () => {
  process.env.FUNDING_ITEM_KEYWORD = '项目甲';
  process.env.BUDGET_OUTLAY_KEYWORD = '材料费';
  let reads = 0;
  const section = { filter: () => section, count: async () => 1,
    innerText: async () => { if (!reads++) throw Error('detached'); return '项目甲 材料费'; } };
  await assertFundingChoice({ locator: () => section, page: { waitForTimeout: async () => {} } }, 1000);
  assert.equal(reads, 2);
});
