const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectInvoice, invoiceSelectionState } = require('../dist/automation/invoice-selection');

function fixture(kind, { initial = false, disabled = false, mixed = false, never = false, native = false } = {}) {
  let selected = initial, clicks = 0, reads = 0;
  const control = { classList: { contains: cls => cls === 'is--indeterminate' && mixed },
    getAttribute: () => mixed ? 'mixed' : null, matches: () => disabled, closest: () => null };
  const rowNode = {
    classList: { contains: cls => selected && kind === 'row' && cls === 'row--checked' },
    querySelectorAll: selector => selector === 'input[type="checkbox"], .vxe-cell--checkbox, [role="checkbox"]'
      ? [control] : selected && kind !== 'row' && kind !== 'highlight'
      && selector.includes({ cell: 'td.col--checkbox.is--checked', icon: '.vxe-icon-checkbox-checked',
        wrapper: '.vxe-cell--checkbox.is--checked', native: 'input[type="checkbox"]:checked', aria: '[aria-checked="true"]' }[kind])
        ? [{ matches: () => kind === 'icon', getClientRects: () => [{}] }] : [],
  };
  const checkbox = { filter: () => checkbox, first: () => checkbox, count: async () => 1, waitFor: async () => {},
    click: async () => { clicks++; if (!never) selected = true; },
    check: async () => { clicks++; if (!never) selected = true; } };
  const empty = { filter: () => empty, count: async () => 0 };
  const row = { locator: selector => selector === 'input[type="checkbox"]' && !native ? empty : checkbox,
    evaluate: async (fn, arg) => {
      reads++;
      const prior = global.HTMLInputElement;
      const priorStyle = global.getComputedStyle;
      global.getComputedStyle = () => ({ visibility: 'visible' });
      global.HTMLInputElement = class {};
      try { return fn(rowNode, arg); } finally {
        if (priorStyle) global.getComputedStyle = priorStyle; else delete global.getComputedStyle;
        if (prior) global.HTMLInputElement = prior; else delete global.HTMLInputElement;
      }
    } };
  return { row, clicks: () => clicks, reads: () => reads };
}

test('VXE row, checkbox cell, icon, wrapper and aria checked states confirm a single selection', async () => {
  for (const kind of ['row', 'cell', 'icon', 'wrapper', 'aria', 'native']) {
    const f = fixture(kind, { native: kind === 'native' });
    await selectInvoice(f.row, 150);
    assert.equal(f.clicks(), 1);
    assert.ok(f.reads() >= 2);
  }
});

test('already selected invoice is not toggled off', async () => {
  for (const kind of ['row', 'cell', 'icon']) {
    const f = fixture(kind, { initial: true });
    await selectInvoice(f.row, 150);
    assert.equal(f.clicks(), 0);
  }
});

test('row highlight alone is not selection; unsuccessful checkbox click is not repeated', async () => {
  const f = fixture('highlight');
  assert.equal((await invoiceSelectionState(f.row)).checked, false);
  await assert.rejects(selectInvoice(f.row, 20), { code: 'invoice_selection_unconfirmed' });
  assert.equal(f.clicks(), 1);
});

test('disabled or partially selected checkbox cannot proceed', async () => {
  for (const [options, code] of [[{ disabled: true }, 'invoice_selection_disabled'],
    [{ mixed: true, initial: true }, 'invoice_selection_unconfirmed']]) {
    const f = fixture('row', options);
    await assert.rejects(selectInvoice(f.row, 20), { code });
    assert.equal(f.clicks(), 0);
  }
});
