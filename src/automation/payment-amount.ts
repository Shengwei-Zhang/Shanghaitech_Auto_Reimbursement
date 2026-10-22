import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { moneyToCents } from '../domain/job';
import { FlowError } from '../domain/workflow';
import { uniqueVisible } from './controls';
import { DEFAULT_TIMEOUT_MS } from './config';

// Accept ordinary decimal amounts and correctly grouped thousands only. Mask
// placeholders, partial decimals and other text must never become valid money.
export function paymentAmountCents(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  try { return moneyToCents(text.replace(/,/g, '')); } catch { return null; }
}

export async function fillPaymentAmount(ctx: AutomationContext, locator: Locator, amount: string,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const expected = moneyToCents(amount);
  const field = await uniqueVisible(locator, timeout);
  if (!await field.isEditable()) throw new FlowError('payment_amount_input_failed');
  // Enter the reimbursement amount directly, then let OA format it on blur.
  // Always use two decimal places, formatted from integer cents.
  const typed = `${Math.floor(expected / 100)}.${String(expected % 100).padStart(2, '0')}`;
  try {
    await field.click({ timeout });
    await field.fill(typed, { timeout });
    await field.blur({ timeout });
  } catch (cause) { throw new FlowError('payment_amount_input_failed', { cause }); }
  // Observe only after the single input attempt; never repeatedly type or save.
  const deadline = Date.now() + Math.min(timeout, 5000);
  let actual: number | null = null;
  do {
    actual = paymentAmountCents(await field.inputValue({ timeout }));
    if (actual === expected) return;
    await ctx.page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new FlowError(actual === null ? 'payment_amount_input_failed' : 'payment_amount_mismatch');
}
