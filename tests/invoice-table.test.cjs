const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findInvoiceRowByColumn, identitySelector } = require('../dist/automation/invoice-table');
const number = '26117000000000000001';

// Simulate a virtual column: its cells only exist on the right, checkboxes only
// on the left, and the rows change order after a horizontal scroll round-trip.
function fixture(mode = 'normal') {
  let offset = 0, revealed = false;
  const moves = [];
  const entries = [
    { key: 'other', number: mode === 'duplicate' ? number : '26117000000000000009' },
    { key: 'target', number },
  ];
  const right = () => offset > 500;
  const bodyElement = { clientWidth: 400, scrollWidth: 1600,
    get scrollLeft() { return offset; }, set scrollLeft(next) {
      offset = Math.max(0, Math.min(1200, next)); moves.push(offset); revealed ||= right();
    } };
  const cell = (kind, pattern) => ({ kind, pattern });
  function rows(key, filters = []) {
    const values = () => {
      let result = revealed && !right() ? [...entries].reverse() : entries;
      if (mode === 'disappear' && revealed && !right()) result = result.filter(row => row.key !== 'target');
      if (key) result = result.filter(row => row.key === key);
      return result.filter(row => filters.every(f => {
        if (!f.has) return true;
        if (f.has.kind === 'selected') return false;
        if (f.has.kind === 'checkbox') return !right();
        return right() && f.has.pattern.test(row.number);
      }));
    };
    const value = { or: () => value, filter: f => rows(key, [...filters, f]), count: async () => values().length,
      first: () => value, waitFor: async () => { if (!values().length) throw Error('missing row'); },
      all: async () => values().map(row => rows(row.key)),
      getAttribute: async () => values()[0]?.key || null,
      evaluate: async fn => fn({ getAttribute: name => mode === 'no-key' ? null : name === 'rowid' ? values()[0]?.key : null }),
      locator: selector => {
        if (selector.startsWith('td.')) return {
          count: async () => right() ? values().length : 0,
          textContent: async () => values()[0]?.number,
        };
        return { filter: () => ({ count: async () => !right() ? values().length : 0 }) };
      } };
    return value;
  }
  const rowKey = selector => selector.match(/rowid="([^"]+)"/)?.[1];
  const header = { filter: () => header, first: () => header, waitFor: async () => {},
    count: async () => right() ? 1 : 0,
    evaluate: async fn => fn({ classList: ['vxe-header--column', 'col_invoice'] }),
    boundingBox: async () => ({ x: 0 }) };
  const table = { filter: () => table, first: () => table, count: async () => 1, waitFor: async () => {},
    locator: selector => selector.includes('header-wrapper') ? header : rows(rowKey(selector)) };
  const body = { filter: () => body, first: () => body, count: async () => 1, waitFor: async () => {},
    boundingBox: async () => ({ x: 0 }), evaluate: async (fn, arg) => fn(bodyElement, arg),
    locator: selector => selector.startsWith('xpath=') ? table : rows(rowKey(selector)) };
  const ctx = { page: { waitForTimeout: async () => {} }, locator: selector => {
    if (selector.includes('body-wrapper')) return body;
    if (selector.startsWith('td.')) return { filter: options => cell('number', options.hasText) };
    if (selector.includes(':checked')) return cell('selected');
    return cell('checkbox');
  } };
  return { ctx, moves };
}

test('horizontal search binds the invoice-number column match to its row identity after reordering', async () => {
  const f = fixture();
  const row = await findInvoiceRowByColumn(f.ctx, number, 1000);
  assert.equal(await row.getAttribute('rowid'), 'target');
  assert.ok(f.moves.some(offset => offset > 500));
  assert.equal(f.moves.at(-1), 0);
});

test('wrong invoice number, duplicate numbers, and missing row identity cannot select a row', async () => {
  assert.equal(await findInvoiceRowByColumn(fixture().ctx, '26117000000000000002', 1000), null);
  await assert.rejects(findInvoiceRowByColumn(fixture('duplicate').ctx, number, 1000), { code: 'ambiguous_choice' });
  await assert.rejects(findInvoiceRowByColumn(fixture('no-key').ctx, number, 1000), { code: 'invoice_row_identity_missing' });
  await assert.rejects(findInvoiceRowByColumn(fixture('disappear').ctx, number, 1000), { code: 'control_missing' });
});

test('row identity selectors escape values and reject positional or malformed identifiers', () => {
  assert.equal(identitySelector({ attribute: 'rowid', value: 'row"\\7' }), 'tr[rowid="row\\"\\\\7"]');
  assert.throws(() => identitySelector({ attribute: 'row-index', value: '2' }), { code: 'invoice_row_identity_missing' });
  assert.throws(() => identitySelector({ attribute: 'rowid', value: '' }), { code: 'invoice_row_identity_missing' });
});
