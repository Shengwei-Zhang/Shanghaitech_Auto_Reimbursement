import type { AutomationContext } from './browser';
import { resolveFrameForSelector } from './frames';
import { INVOICE_ENTRY_CONTAINERS } from './invoice-entry';

async function activateInvoiceContext(ctx: AutomationContext): Promise<void> {
  for (const selector of [
    '#rbReimbursementInvoiceForm',
    INVOICE_ENTRY_CONTAINERS,
    '#editReimburFundingItems',
  ]) {
    await resolveFrameForSelector(ctx, selector).catch(() => undefined);
    if (await ctx.locator(selector).count().catch(() => 0)) {
      return;
    }
  }
}

export async function isInvoiceAttached(ctx: AutomationContext): Promise<boolean> {
  await activateInvoiceContext(ctx);
  return ctx.root().evaluate(() => {
    const total = (document.querySelector('#actualTotalAmount') as HTMLInputElement | null)?.value || '';
    const rows = Array.from(document.querySelectorAll('#invoiceGrid tr, #invoiceGrid .l-grid-row'));
    return rows.some((row) => /[2]\d{19}|\d+\.\d{2}/.test(row.textContent || ''))
      || Number(total.replace(/,/g, '').trim()) > 0;
  });
}

export async function isInvoicePickerOpen(ctx: AutomationContext): Promise<boolean> {
  await activateInvoiceContext(ctx);
  return ctx.root().evaluate(() => Array.from(document.querySelectorAll(
    '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
  )).some((dialog) => {
    const text = dialog.textContent || '';
    const rect = dialog.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && /发票列表/.test(text) && /上传/.test(text);
  }));
}

export async function isAddInvoiceDialogVisible(ctx: AutomationContext): Promise<boolean> {
  await activateInvoiceContext(ctx);
  return ctx.root().evaluate(() => Array.from(document.querySelectorAll(
    '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
  )).some((dialog) => {
    const text = dialog.textContent || '';
    const rect = dialog.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && /添加发票/.test(text);
  }));
}

export async function isAddInvoicePopulated(ctx: AutomationContext): Promise<boolean> {
  await activateInvoiceContext(ctx);
  return ctx.root().evaluate(() => {
    const amount = (document.querySelector('#actualAmount') as HTMLInputElement | null)?.value || '';
    const code = (document.querySelector('#invoiceCode') as HTMLInputElement | null)?.value || '';
    return Boolean(amount.trim() || code.trim());
  });
}
