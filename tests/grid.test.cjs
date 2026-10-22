const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gridRows, singleGridCell } = require('../dist/automation/grid');

// Model Liger's frozen checkbox rows separately from its data rows, including
// live inline inputs whose value is absent from the parent cell's textContent.
function fixture(values) {
  function locator(nodes) {
    return {
      filter: () => locator(nodes), first: () => locator(nodes.slice(0, 1)),
      waitFor: async () => { if (!nodes.length) throw Error('missing'); },
      count: async () => nodes.length, all: async () => nodes.map(n => locator([n])),
      getAttribute: async key => nodes[0][key],
      innerText: async () => nodes[0].text || '',
      evaluate: async callback => {
        const previous = [global.HTMLInputElement, global.HTMLTextAreaElement, global.HTMLSelectElement];
        class Input {}
        global.HTMLInputElement = global.HTMLTextAreaElement = global.HTMLSelectElement = Input;
        try {
          const n = nodes[0];
          const element = n.kind === 'input' ? Object.assign(new Input(), { value: n.value }) : { textContent: n.text || '' };
          return callback(element);
        } finally { [global.HTMLInputElement, global.HTMLTextAreaElement, global.HTMLSelectElement] = previous; }
      },
      locator: selector => {
        let result = [];
        for (const node of nodes) {
          if (node.kind === 'grid') {
            if (selector.includes('columnname=')) {
              const name = selector.match(/columnname="([^"]+)"/)[1];
              result.push({ kind: 'header', id: `grid|${name}` });
            } else if (selector.startsWith('.l-grid-row')) {
              if (!selector.includes(':not(.l-grid1 ')) result.push({ kind: 'row', cells: [] });
              result.push(...values.map(cells => ({ kind: 'row', cells })));
            }
          } else if (node.kind === 'row') {
            const name = selector.match(/\|([^"|]+)"/)[1];
            const value = node.cells[name];
            if (value !== undefined) result.push({ kind: 'cell', id: `grid|r|${name}`, ...value });
          } else if (node.kind === 'cell') {
            if (node.input !== undefined) result.push({ kind: 'input', value: node.input });
          }
        }
        return locator(result);
      },
    };
  }
  return locator([{ kind: 'grid' }]);
}

test('frozen checkbox pane is not an extra payment record', async () => {
  const grid = fixture([{ personCode: { text: 'TEST01' }, paymentAmount: { text: '200.00' } }]);
  assert.deepEqual(await gridRows(grid, ['personCode', 'paymentAmount']), [{ personCode: 'TEST01', paymentAmount: '200.00' }]);
});

test('two actual payment records remain two records even when their values match', async () => {
  const row = { personCode: { text: 'TEST01' }, paymentAmount: { text: '200.00' } };
  assert.equal((await gridRows(fixture([row, row]), ['personCode', 'paymentAmount'])).length, 2);
  await assert.rejects(singleGridCell(fixture([row, row]), 'paymentAmount'), { code: 'ambiguous_choice' });
});

test('funding inline input values are read instead of empty cell text', async () => {
  const grid = fixture([{ amount: { input: '200.00' }, attachmentNumber: { input: '1' }, remark: { input: '测试用途' } }]);
  assert.deepEqual(await gridRows(grid, ['amount', 'attachmentNumber', 'remark']), [
    { amount: '200.00', attachmentNumber: '1', remark: '测试用途' },
  ]);
  assert.equal(await (await singleGridCell(grid, 'amount')).getAttribute('id'), 'grid|r|amount');
});
