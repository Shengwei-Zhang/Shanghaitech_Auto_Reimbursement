import type { Locator, Request } from 'playwright';
import type { AutomationContext } from './browser';
import { FlowError } from '../domain/workflow';
import { uniqueVisible } from './controls';
import { findInvoiceRowByColumn } from './invoice-table';

const ROWS = '.vxe-table--body-wrapper tbody tr';
const LOADING = '.vxe-loading, .vxe-table--loading, .vxe-grid--loading';
export const invoiceNumberPattern = (number: string) => new RegExp(`(?:^|\\D)${number}(?:\\D|$)`);

export function invoiceRows(ctx: AutomationContext): Locator {
  // Fixed column panes duplicate rows; match and select in the main table only.
  return ctx.locator(`${ROWS}:not(.vxe-table--fixed-left-wrapper tr):not(.vxe-table--fixed-right-wrapper tr)`)
    .filter({ visible: true });
}

async function snapshot(ctx: AutomationContext): Promise<string> {
  const page = await ctx.locator('.vxe-pager--goto input, input.vxe-pager--goto, .vxe-pager--num-btn.is--active')
    .filter({ visible: true }).evaluateAll(elements => elements.map(el =>
      el instanceof HTMLInputElement ? el.value : el.textContent));
  return JSON.stringify([page, await invoiceRows(ctx).allTextContents()]);
}

/** Await a stable rendered list, including delayed folder/pager requests. */
export async function waitInvoiceList(ctx: AutomationContext, timeout: number, changedFrom?: string,
  pending = () => false): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = '', stableSince = Date.now();
  while (Date.now() < deadline) {
    const current = await snapshot(ctx);
    const loading = pending() || await ctx.locator(LOADING).filter({ visible: true }).count();
    const ready = await invoiceRows(ctx).count()
      || await ctx.locator('.vxe-table--empty-placeholder').filter({ visible: true }).count();
    if (current !== last || loading || !ready) { last = current; stableSince = Date.now(); }
    if (!loading && ready && current !== changedFrom && Date.now() - stableSince >= 300) return;
    await ctx.page.waitForTimeout(100);
  }
  throw new FlowError('control_missing');
}

async function changeList(ctx: AutomationContext, action: () => Promise<void>, timeout: number,
  changedFrom?: string): Promise<void> {
  const requests = new Set<Request>();
  let failed = false;
  const frame = ctx.activeFrame || ctx.page.mainFrame();
  const start = (request: Request) => {
    if (request.serviceWorker()) return;
    if (['xhr', 'fetch'].includes(request.resourceType()) && request.frame() === frame) requests.add(request);
  };
  const finish = async (request: Request) => {
    if (!requests.has(request)) return;
    try { if (!(await request.response())?.ok()) failed = true; }
    catch { failed = true; }
    finally { requests.delete(request); }
  };
  const rejected = (request: Request) => {
    if (requests.delete(request)) failed = true;
  };
  ctx.page.on('request', start);
  ctx.page.on('requestfinished', finish);
  ctx.page.on('requestfailed', rejected);
  try {
    await action();
    await waitInvoiceList(ctx, timeout, changedFrom, () => {
      if (failed) throw new FlowError('control_missing');
      return requests.size > 0;
    });
  } finally {
    ctx.page.off('request', start);
    ctx.page.off('requestfinished', finish);
    ctx.page.off('requestfailed', rejected);
  }
}

export async function refreshInvoiceFolder(ctx: AutomationContext, timeout: number): Promise<void> {
  const search = ctx.root().getByRole('button', { name: /^(搜索|查询)$/ }).filter({ visible: true });
  if (await search.count() === 1) await changeList(ctx, () => search.click({ timeout }), timeout);
  else await waitInvoiceList(ctx, timeout);
}

export async function openInvoiceFolder(ctx: AutomationContext, name: string, timeout: number): Promise<void> {
  const folder = await uniqueVisible(ctx.root().getByText(name, { exact: true }), timeout);
  // Require the tree's selected state before interpreting any rows. The old
  // code could read the 401-row self-upload list after clicking another folder.
  await changeList(ctx, async () => {
    await folder.click({ timeout });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await folder.evaluate(el => Boolean(el.closest(
        '.is--current, .is--selected, [aria-selected="true"], [aria-current="true"]',
      )))) return;
      await ctx.page.waitForTimeout(100);
    }
    throw new FlowError('invoice_folder_unconfirmed');
  }, timeout);
}

/** Return as soon as the current page has one exact invoice-number match.
 * Only search other pages when it is absent; do not scan the folder for global
 * uniqueness after finding the uploaded invoice.
 */
export async function findInvoiceInFolder(ctx: AutomationContext, number: string, timeout: number): Promise<Locator | null> {
  const currentMatch = () => findInvoiceRowByColumn(ctx, number, timeout);
  await waitInvoiceList(ctx, timeout);
  const visibleMatch = await currentMatch();
  if (visibleMatch) return visibleMatch;
  const next = ctx.locator('.vxe-pager--next-btn').filter({ visible: true });
  const prev = ctx.locator('.vxe-pager--prev-btn').filter({ visible: true });
  const enabled = async (control: Locator) => {
    if (!await control.count()) return false;
    return (await uniqueVisible(control, timeout)).evaluate(el =>
      !el.closest(':disabled, [disabled], [aria-disabled="true"], .is--disabled'));
  };
  const move = async (control: Locator) => {
    const before = await snapshot(ctx);
    await changeList(ctx, async () => (await uniqueVisible(control, timeout)).click({ timeout }), timeout, before);
  };
  for (let n = 0; await enabled(prev); n++) {
    if (n >= 100) throw new FlowError('invoice_pagination_unchecked');
    await move(prev);
  }
  let index = 0;
  const signatures = new Set<string>();
  for (;;) {
    await waitInvoiceList(ctx, timeout);
    const signature = await snapshot(ctx);
    if (signatures.has(signature)) throw new FlowError('invoice_pagination_unchecked');
    signatures.add(signature);
    const target = await currentMatch();
    if (target) return target;
    if (!await enabled(next)) return null;
    if (++index >= 100) throw new FlowError('invoice_pagination_unchecked');
    await move(next);
  }
}
