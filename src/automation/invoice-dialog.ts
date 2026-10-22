import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import {
  confirmUploadedInvoiceSelection,
  openAddInvoiceDialog,
} from './invoice';

export async function openInvoiceEntry(
  ctx: AutomationContext,
): Promise<void> {
  await openAddInvoiceDialog(ctx);
}

export async function saveSelectedInvoice(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await confirmUploadedInvoiceSelection(ctx, 'confirm-uploaded-file', timeoutMs);
}

