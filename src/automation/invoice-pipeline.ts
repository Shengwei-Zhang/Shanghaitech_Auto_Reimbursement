import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { isInvoiceAttached } from './invoice-state';
import { openInvoiceEntry, saveSelectedInvoice } from './invoice-dialog';
import { uploadNextMissingPdf } from './invoice-upload';
import { chooseInvoiceByRecordedNumber } from './invoice-picker';
import { attachRecordedInvoice } from './recorded-invoice';
import { assertExpectedInvoice } from './guards';

export async function attachNextPdfInvoice(
  ctx: AutomationContext,
  uploadPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (await isInvoiceAttached(ctx)) {
    await assertExpectedInvoice(ctx);
    console.log('Invoice is already attached to the reimbursement form.');
    return;
  }

  if (await attachRecordedInvoice(ctx, uploadPath, timeoutMs)) return;
  await openInvoiceEntry(ctx);
  await uploadNextMissingPdf(ctx, uploadPath, timeoutMs);
  await chooseInvoiceByRecordedNumber(ctx, uploadPath, timeoutMs);
  await saveSelectedInvoice(ctx, timeoutMs);

  if (!(await isInvoiceAttached(ctx))) {
    throw new Error('Invoice pipeline finished without an invoice row on the reimbursement form.');
  }
}
