import { test, expect } from '@playwright/test';
import { installOaFixture, inputs, number } from './fixtures/oa';
import { AutomationContext } from '../src/automation/browser';
import { configurePersonalBankCardPayment, assertPaymentDetails } from '../src/automation/payment';
import { fillReimbursementDetails, assertReimbursementDetails } from '../src/automation/funding';

test('frozen checkbox panes allow one payment followed by all reimbursement details', async ({ page }) => {
  Object.assign(process.env, { EXPECTED_AMOUNT: '120.10', EXPECTED_INVOICE_AMOUNT: '120.10', EXPECTED_INVOICE_NUMBER: number });
  await installOaFixture(page);
  const frame = page.frameLocator('iframe');
  // A changed internal column name still resolves through the exact Chinese header.
  await frame.locator('#gridfund [columnname="attachmentNumber"]').evaluate(header => {
    header.setAttribute('columnname', 'attachmentCount'); header.textContent = '*附件张数';
  });
  for (const id of ['gridpay', 'gridfund']) {
    await frame.locator(`#${id}`).evaluate(grid => {
      if (!grid.querySelector('.l-grid2')) {
        const main = document.createElement('div'); main.className = 'l-grid2';
        while (grid.firstChild) main.append(grid.firstChild);
        grid.append(main);
      }
      const frozen = document.createElement('div'); frozen.className = 'l-grid1';
      frozen.innerHTML = '<table><tr class="l-grid-row"><td><input type="checkbox"></td></tr></table>';
      grid.append(frozen);
    });
  }
  // A blank fixed pane must not be mistaken for an existing payment.
  await frame.locator('#gridpay .l-grid1 tr').evaluate(row => { row.remove(); });
  await frame.locator('#bankDialog #ok').evaluate(save => {
    save.addEventListener('click', () => {
      document.querySelector('#gridpay .l-grid1 table')!.innerHTML = '<tr class="l-grid-row"><td><input type="checkbox"></td></tr>';
    });
  });
  const ctx = new AutomationContext(page);
  await configurePersonalBankCardPayment(ctx, inputs, 2000);
  await fillReimbursementDetails(ctx, inputs, 2000);
  await assertReimbursementDetails(ctx, inputs);
  await assertPaymentDetails(ctx, inputs);
  await expect(frame.locator('#reimbursementRemark')).toHaveValue(inputs.reimbursementReason);
  await expect(frame.locator('#reimbursementReimbursementAmount')).toHaveValue('120.10');
  await expect(frame.locator('#reimbursementAttachmentNumber')).toHaveValue(inputs.attachmentCount);
  await expect(frame.locator('#gridpay .l-grid2 .l-grid-row')).toHaveCount(1);
});
