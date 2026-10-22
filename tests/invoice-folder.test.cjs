const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { findInvoiceInFolder, openInvoiceFolder } = require('../dist/automation/invoice-folder');
const table = require('../dist/automation/invoice-table');
// These tests cover pagination; the table adapter has separate horizontal-scroll tests.
table.findInvoiceRowByColumn = async ctx => ctx.matchOnPage();
const number = '26117000000000000001';

function fixture(pages, { selected = true } = {}) {
  let index = 0, clicks = [];
  const page = new EventEmitter();
  page.mainFrame = () => page;
  page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  function locator(kind, filters = []) {
    const rows = () => (pages[index] || []).filter(text => filters.every(f =>
      (!f.hasText || f.hasText.test(text)) && (!f.hasNotText || !f.hasNotText.test(text)) && !f.has));
    const value = {
      filter: f => locator(kind, [...filters, f]), first: () => value, waitFor: async () => {},
      count: async () => kind === 'rows' ? rows().length : kind === 'loading' ? 0 : kind === 'empty' ? (pages[index].length ? 0 : 1) : 1,
      allTextContents: async () => rows(),
      evaluateAll: async () => [String(index + 1)],
      evaluate: async () => kind === 'next' ? index < pages.length - 1 : kind === 'prev' ? index > 0 : selected,
      click: async () => { clicks.push(kind); if (kind === 'next') index++; if (kind === 'prev') index--; },
    };
    return value;
  }
  const ctx = { page, activeFrame: null, matchOnPage: async () => {
    const matches = pages[index].filter(text => text === number);
    if (matches.length > 1) throw new (require('../dist/domain/workflow').FlowError)('ambiguous_choice');
    return matches.length ? locator('rows', [{ hasText: new RegExp(`^${number}$`) }]) : null;
  }, root: () => ({ getByText: () => locator('folder') }),
    locator: selector => locator(selector.includes('tbody tr') ? 'rows' : selector.includes('vxe-loading') ? 'loading'
      : selector.includes('empty-placeholder') ? 'empty' : selector.includes('--next-btn') ? 'next'
        : selector.includes('--prev-btn') ? 'prev' : 'marker') };
  return { ctx, clicks, index: () => index };
}

test('invoice search stops on the matching page without visiting later pages or returning', async () => {
  const f = fixture([['other invoice'], [number], ['last invoice']]);
  const row = await findInvoiceInFolder(f.ctx, number, 1000);
  assert.deepEqual(await row.allTextContents(), [number]);
  assert.equal(f.index(), 1);
  assert.deepEqual(f.clicks, ['next']);
});

test('first-page match returns immediately even when the folder has many more pages', async () => {
  const f = fixture([[number], ...Array.from({ length: 40 }, () => ['other'])]);
  const row = await findInvoiceInFolder(f.ctx, number, 1000);
  assert.deepEqual(await row.allTextContents(), [number]);
  assert.equal(f.index(), 0);
  assert.deepEqual(f.clicks, []);
});

test('same-page duplicates stop and absent invoice is reported only after the last page', async () => {
  const duplicate = fixture([[number, number], ['other']]);
  await assert.rejects(findInvoiceInFolder(duplicate.ctx, number, 1000), { code: 'ambiguous_choice' });
  assert.deepEqual(duplicate.clicks, []);
  const absent = fixture([['first'], ['second']]);
  assert.equal(await findInvoiceInFolder(absent.ctx, number, 1000), null);
  assert.equal(absent.index(), 1);
});

test('a longer number containing the invoice number is not a valid match', async () => {
  const f = fixture([[`${number}9`], [number]]);
  const row = await findInvoiceInFolder(f.ctx, number, 1000);
  assert.deepEqual(await row.allTextContents(), [number]);
  assert.deepEqual(f.clicks, ['next']);
});

test('folder click without selected-state confirmation cannot use old invoice rows', async () => {
  const f = fixture([[number]], { selected: false });
  await assert.rejects(openInvoiceFolder(f.ctx, '表单默认票夹', 100), { code: 'invoice_folder_unconfirmed' });
  assert.equal(f.ctx.page.listenerCount('request'), 0);
});
