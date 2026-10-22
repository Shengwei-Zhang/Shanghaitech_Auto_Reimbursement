import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { assertExpectedInvoice } from '../src/automation/guards';

test('only visible invoices on the main form count as attached, with exact cell boundaries', async ({ page }) => {
  const keys = ['EXPECTED_INVOICE_NUMBER', 'EXPECTED_INVOICE_AMOUNT', 'EXPECTED_AMOUNT'];
  const previous = keys.map(key => process.env[key]);
  const number = '26117000000000000001';
  Object.assign(process.env, { EXPECTED_INVOICE_NUMBER: number, EXPECTED_INVOICE_AMOUNT: '120.10', EXPECTED_AMOUNT: '120.10' });
  try {
    await page.setContent(`<div id="picker">${number}</div>
      <div id="invoiceGrid"><span hidden>${number}</span></div>
      <input id="actualTotalAmount" value="120.10">
      <input id="reimbursementReimbursementAmount" value="120.10">
      <input id="reimbursementSettlementAmount" value="120.10">`);
    const ctx = new AutomationContext(page);
    await expect(assertExpectedInvoice(ctx)).rejects.toThrow(/expected invoice/);
    await page.locator('#invoiceGrid').evaluate((el, number) => {
      el.innerHTML = `<table><tr><td>1</td><td>${number}</td><td>120.10</td></tr></table>`;
    }, number);
    await assertExpectedInvoice(ctx, true);
    await page.locator('#invoiceGrid').evaluate(el => { (el as HTMLElement).hidden = true; });
    await expect(assertExpectedInvoice(ctx)).rejects.toThrow(/expected invoice/);
    await page.locator('#invoiceGrid').evaluate(el => { (el as HTMLElement).hidden = false; });
    // The total remains unchanged: an additional invoice must still be rejected.
    await page.locator('#invoiceGrid tr').evaluate(el => {
      el.insertAdjacentHTML('afterend', '<tr><td>2</td><td>26117000000000000002</td><td>0.00</td></tr>');
    });
    await expect(assertExpectedInvoice(ctx)).rejects.toThrow(/expected invoice/);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    });
  }
});
