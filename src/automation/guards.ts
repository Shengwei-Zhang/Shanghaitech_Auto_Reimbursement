import { moneyToCents } from '../domain/job';
import type { AutomationContext } from './browser';
import { getEnvValue } from './config';

/** Fail closed before editing/saving a form with a different invoice or amount. */
export async function assertExpectedInvoice(ctx: AutomationContext, checkPayment = false): Promise<void> {
  const expectedNumber = getEnvValue('EXPECTED_INVOICE_NUMBER');
  const expectedAmount = getEnvValue('EXPECTED_AMOUNT');
  const values = await ctx.root().evaluate(() => {
    const grid = document.querySelector('#invoiceGrid') as HTMLElement | null;
    // innerText on a hidden root falls back to textContent, so check the root too.
    const visible = grid && grid.getClientRects().length > 0 && getComputedStyle(grid).visibility === 'visible';
    return {
      // Preserve cell boundaries and exclude hidden picker/template text.
      invoiceText: visible ? grid.innerText : '',
      amount: (document.querySelector('#actualTotalAmount') as HTMLInputElement | null)?.value || '',
      reimbursement: (document.querySelector('#reimbursementReimbursementAmount') as HTMLInputElement | null)?.value || '',
      payment: (document.querySelector('#reimbursementSettlementAmount') as HTMLInputElement | null)?.value || '',
    };
  });
  const numbers = new Set(values.invoiceText.match(/(?<!\d)\d{20}(?!\d)/g) || []);
  // EXPECTED_INVOICE_NUMBER lists every invoice of the task (comma-separated); the form
  // must hold exactly that set, never merely contain it.
  const expected = new Set(expectedNumber ? expectedNumber.split(',') : []);
  if (expected.size && (numbers.size !== expected.size || [...expected].some(number => !numbers.has(number)))) {
    throw new Error('The OA form does not contain only the expected invoice number. Manual verification is required.');
  }
  const cents = moneyToCents(values.amount.replace(/,/g, '').trim());
  const invoiceAmount = getEnvValue('EXPECTED_INVOICE_AMOUNT');
  const actual = expectedAmount ? moneyToCents(expectedAmount) : cents;
  if ((invoiceAmount && cents !== moneyToCents(invoiceAmount)) || actual > cents) {
    throw new Error('The OA invoice total differs from the confirmed amount. Manual verification is required.');
  }
  if (checkPayment && (moneyToCents(values.reimbursement.replace(/,/g, '').trim()) !== actual
    || moneyToCents(values.payment.replace(/,/g, '').trim()) !== actual)) {
    throw new Error('Invoice, reimbursement and payment totals do not match. No rows will be deleted automatically.');
  }
}
