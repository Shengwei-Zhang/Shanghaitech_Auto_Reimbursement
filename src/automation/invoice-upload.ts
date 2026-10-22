import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { uploadInvoiceFile } from './invoice';

export async function uploadNextMissingPdf(
  ctx: AutomationContext,
  uploadPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await uploadInvoiceFile(ctx, uploadPath, 'upload-invoice-file', timeoutMs);
}

