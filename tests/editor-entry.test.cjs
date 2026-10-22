const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitForFundingEntry } = require('../dist/automation/editor-entry');

function fixture(rows) {
  let active, clicks = 0;
  const list = items => ({ filter: () => list(items), count: async () => items.length,
    or: other => list([...new Set([...items, ...other.items])]), items,
    all: async () => items });
  const frames = rows.map(({ id, name, same, enabled = true }) => {
    const button = { isEnabled: async () => enabled, click: async () => clicks++ };
    const namedButton = same ? button : { isEnabled: async () => enabled, click: async () => clicks++ };
    return { locator: () => list(id ? [button] : []), getByRole: () => list(name ? [namedButton] : []),
      getByText: () => list([]) };
  });
  const page = { url: () => 'https://sapbpm-new.shanghaitech.edu.cn/form', frames: () => frames,
    mainFrame: () => frames[0], getByText: () => list([]),
    waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 5)) };
  return { ctx: { page, setActiveFrame: frame => active = frame }, frames,
    active: () => active, clicks: () => clicks };
}

test('funding entry accepts old ID and screenshot-backed button name across frames without clicking', async () => {
  for (const rows of [[{id:true}], [{name:true}], [{}, {name:true}]]) {
    const f = fixture(rows);
    assert.ok(await waitForFundingEntry(f.ctx, 40));
    assert.equal(f.clicks(), 0);
    assert.equal(f.active(), rows.length === 2 ? f.frames[1] : null);
  }
});

test('matching both ID and name is one control, while separate matches are ambiguous', async () => {
  const one = fixture([{id:true,name:true,same:true}]);
  assert.ok(await waitForFundingEntry(one.ctx, 40));
  for (const rows of [[{id:true,name:true}], [{id:true},{name:true}]]) {
    await assert.rejects(waitForFundingEntry(fixture(rows).ctx, 40), {code:'ambiguous_choice'});
  }
});

test('missing or disabled funding entry reports preparation failure without clicking', async () => {
  for (const rows of [[{}], [{name:true,enabled:false}]]) {
    const f = fixture(rows);
    await assert.rejects(waitForFundingEntry(f.ctx, 10), {code:'editor_entry_unavailable'});
    assert.equal(f.clicks(), 0);
  }
});
