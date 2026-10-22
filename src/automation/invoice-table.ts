import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { uniqueVisible } from './controls';
import { FlowError } from '../domain/workflow';
import { INVOICE_CHECKED, invoiceSelectionState } from './invoice-selection';

const MAIN_BODY = '.vxe-table--body-wrapper:not(.vxe-table--fixed-left-wrapper *):not(.vxe-table--fixed-right-wrapper *)';
const ROOT = 'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," vxe-table ") or contains(concat(" ",normalize-space(@class)," ")," vxe-table--render-wrapper ")][1]';

export interface InvoiceRowIdentity { attribute: string; value: string }
export function identitySelector(identity: InvoiceRowIdentity): string {
  if (!['rowid', 'data-row-id', 'data-row-key', 'id'].includes(identity.attribute)
    || !identity.value || /[\u0000-\u001f\u007f]/.test(identity.value)) throw new FlowError('invoice_row_identity_missing');
  const escaped = identity.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tr[${identity.attribute}="${escaped}"]`;
}

/** Reveal a virtualised column through real horizontal scrolling. */
async function revealNumberColumn(ctx: AutomationContext, table: Locator, body: Locator, timeout: number): Promise<string> {
  const headers = table.locator('.vxe-table--header-wrapper th')
    .filter({ hasText: /^\s*发票(?:号|号码)\s*$/, visible: true });
  await body.evaluate(el => { el.scrollLeft = 0; });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await headers.count();
    if (count > 1) throw new FlowError('ambiguous_choice');
    if (count === 1) {
      const header = await uniqueVisible(headers, timeout);
      const column = await header.evaluate(el => Array.from(el.classList).find(name => /^col_[\w-]+$/.test(name)) || '');
      if (!column) throw new FlowError('invoice_number_column_missing');
      // Non-virtual tables already keep the column in the DOM, even offscreen.
      // Scroll the body to the corresponding header position as well.
      const bounds = await header.boundingBox();
      const viewport = await body.boundingBox();
      if (bounds && viewport) await body.evaluate((el, offset) => { el.scrollLeft += offset; }, bounds.x - viewport.x);
      await ctx.page.waitForTimeout(100);
      return column;
    }
    const moved = await body.evaluate(el => {
      const before = el.scrollLeft;
      el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, before + Math.max(1, el.clientWidth * 0.75));
      return el.scrollLeft > before;
    });
    await ctx.page.waitForTimeout(100);
    // Give the final virtual render a chance before declaring the column absent.
    if (!moved && !await headers.count()) throw new FlowError('invoice_number_column_missing');
  }
  throw new FlowError('invoice_number_column_missing');
}

/** Match only the 发票号 cell, then bind the result to a stable row identity
 * before returning to the checkbox at the left edge. Never use row position.
 */
export async function findInvoiceRowByColumn(ctx: AutomationContext, number: string, timeout: number): Promise<Locator | null> {
  if (!/^\d{20}$/.test(number)) throw new FlowError('configuration');
  const body = await uniqueVisible(ctx.locator(MAIN_BODY), timeout);
  const table = await uniqueVisible(body.locator(ROOT), timeout);
  const column = await revealNumberColumn(ctx, table, body, timeout);
  const rows = body.locator('tbody tr').filter({ visible: true });
  const cell = ctx.locator(`td.${column}`).filter({ hasText: new RegExp(`^\\s*${number}\\s*$`) });
  const matches = rows.filter({ has: cell });
  const count = await matches.count();
  if (count > 1) throw new FlowError('ambiguous_choice');
  if (!count) return null;
  const matched = await uniqueVisible(matches, timeout);
  const identity = await matched.evaluate(el => {
    for (const attribute of ['rowid', 'data-row-id', 'data-row-key', 'id']) {
      const value = el.getAttribute(attribute);
      if (value) return { attribute, value };
    }
    return null;
  });
  if (!identity) throw new FlowError('invoice_row_identity_missing');
  const selector = identitySelector(identity);
  // Selection state can live in either the main pane or a frozen left pane.
  const checkedRows = table.locator('tbody tr').filter({ has: ctx.locator(INVOICE_CHECKED) })
    .or(table.locator('tbody tr.row--checked'));
  for (const checked of await checkedRows.all()) {
    if (!(await invoiceSelectionState(checked)).checked) continue;
    if (await checked.getAttribute(identity.attribute) !== identity.value) throw new FlowError('value_mismatch');
  }
  await body.evaluate(el => { el.scrollLeft = 0; });
  const mainRow = body.locator(`tbody ${selector}`).filter({ visible: true });
  await uniqueVisible(mainRow, timeout);
  // Revalidate if the number column remains mounted. Virtualised tables can
  // remove it after scrolling left, which is why rowid was captured beforehand.
  const numberCell = mainRow.locator(`td.${column}`);
  if (await numberCell.count() && (await numberCell.textContent())?.trim() !== number) throw new FlowError('value_mismatch');
  const candidate = table.locator(`tbody ${selector}`).filter({ visible: true })
    .filter({ has: ctx.locator('input[type="checkbox"], .vxe-cell--checkbox, [role="checkbox"]') });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const native = mainRow.locator('input[type="checkbox"], .vxe-cell--checkbox, [role="checkbox"]').filter({ visible: true });
    if (await native.count()) return mainRow;
    if (await candidate.count() === 1) return candidate;
    await ctx.page.waitForTimeout(100);
  }
  throw new FlowError('control_missing');
}
