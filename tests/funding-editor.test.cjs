const { test } = require('node:test');
const assert = require('node:assert/strict');
const grid = require('../dist/automation/grid');
const controls = require('../dist/automation/controls');
const commit = require('../dist/automation/grid-commit');
const { fillFundingCell } = require('../dist/automation/funding-editor');

test('inner-cell activation waits for delayed editor and outside click commits each named field', async () => {
  const originalCell = grid.singleGridCell, originalRead = controls.readValue;
  const originalCommit = commit.commitGridEditor;
  const actions = [];
  let opened = false, committed = '', pending = '', waits = 0;
  const inline = { filter: () => inline, first: () => inline, waitFor: async () => {},
    count: async () => opened && waits > 0 ? 1 : 0, isEditable: async () => true,
    fill: async value => { pending = value; actions.push(['fill', value]); },
    blur: async () => { throw Error('blur alone does not commit a Liger editor'); },
  };
  const inner = { filter: () => inner, first: () => inner, waitFor: async () => {}, count: async () => 1,
    click: async () => { opened = true; waits = 0; actions.push('inner-click'); } };
  const cell = { locator: selector => selector === ':scope > div' ? inner : inline,
    innerText: async () => committed,
    click: async () => { throw Error('outer td must not be clicked'); } };
  grid.singleGridCell = async (_, column) => { actions.push(column); return cell; };
  controls.readValue = async target => { assert.equal(target, cell); return committed; };
  commit.commitGridEditor = async () => { actions.push('outside-click'); committed = pending; opened = false; };
  const empty = { filter: () => empty, count: async () => 0 };
  const ctx = { locator: () => empty, page: { waitForTimeout: async () => { waits++; } } };
  try {
    for (const [column, value] of [['amount', '200.00'], ['attachmentNumber', '1'], ['remark', '测试用途']]) {
      await fillFundingCell(ctx, {}, column, value, 1000);
      assert.equal(committed, value);
    }
    assert.deepEqual(actions, [
      'amount', 'inner-click', ['fill', '200.00'], 'outside-click',
      'attachmentNumber', 'inner-click', ['fill', '1'], 'outside-click',
      'remark', 'inner-click', ['fill', '测试用途'], 'outside-click',
    ]);
  } finally { grid.singleGridCell = originalCell; controls.readValue = originalRead; commit.commitGridEditor = originalCommit; }
});

test('unrelated focused editor cannot receive the attachment count', async () => {
  const original = grid.singleGridCell;
  const empty = { filter: () => empty, count: async () => 0 };
  const inner = { filter: () => inner, first: () => inner, waitFor: async () => {}, count: async () => 1, click: async () => {} };
  const cell = { locator: selector => selector === ':scope > div' ? inner : empty,
    boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 30 }) };
  const wrong = { filter: () => wrong, count: async () => 1,
    boundingBox: async () => ({ x: 500, y: 500, width: 100, height: 30 }),
    fill: async () => { throw Error('unrelated field must never be filled'); } };
  grid.singleGridCell = async () => cell;
  try {
    await assert.rejects(fillFundingCell({ locator: () => wrong,
      page: { waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)) } }, {}, 'attachmentNumber', '1', 20),
    { code: 'funding_editor_missing' });
  } finally { grid.singleGridCell = original; }
});
