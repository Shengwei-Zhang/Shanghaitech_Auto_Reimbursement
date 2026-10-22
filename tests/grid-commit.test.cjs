const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commitGridEditor } = require('../dist/automation/grid-commit');

test('grid commit clicks empty body despite text in child rows and rejects covered or row targets', async () => {
  for (const scenario of ['blank', 'row', 'overlay']) {
    let clicks = 0;
    const element = { clientLeft: 1, clientTop: 1, clientWidth: 500, clientHeight: 240,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
      textContent: '200.00 existing row', contains: hit => hit.kind === 'row', closest: () => null };
    const hit = scenario === 'blank' ? element : { kind: scenario, textContent: '', closest: () => scenario === 'row' ? {} : null };
    const body = { filter: () => body, first: () => body, waitFor: async () => {}, count: async () => 1,
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async fn => {
        const old = global.document;
        global.document = { elementFromPoint: () => hit };
        try { return fn(element); } finally { global.document = old; }
      },
      click: async options => { clicks++; assert.deepEqual(options.position, { x: 250, y: 220 }); },
    };
    const run = commitGridEditor({ locator: () => body }, 100);
    if (scenario === 'blank') { await run; assert.equal(clicks, 1); }
    else { await assert.rejects(run, { code: 'funding_commit_unverified' }); assert.equal(clicks, 0); }
  }
});
