import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import {
  chooseUploadedInvoiceInPicker,
  collectPickerInvoiceNumbers,
} from './invoice';

export async function scanPickerInvoiceNumbers(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Set<string>> {
  return collectPickerInvoiceNumbers(ctx, timeoutMs);
}

export async function chooseInvoiceByRecordedNumber(
  ctx: AutomationContext,
  uploadPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await chooseUploadedInvoiceInPicker(ctx, 'choose-uploaded-file', uploadPath, timeoutMs);
}

