import { test, expect } from '@playwright/test';
import { waitForFundingEntry } from '../src/automation/editor-entry';
import { AutomationContext } from '../src/automation/browser';

test('empty application with new button ID proceeds to funding without requiring invoice rows', async ({ page }) => {
  await page.setContent('<h1>用款申请单</h1><p>单据编号：A20260001</p><button id="newFunding">选择经费项目</button><div hidden id="rbReimbursementInvoiceButtons"></div>');
  const ctx = new AutomationContext(page);
  const button = await waitForFundingEntry(ctx, 500);
  await expect(button).toHaveAttribute('id', 'newFunding');
});

test('hidden old template and icon-prefixed visible button resolve to the visible control', async ({ page }) => {
  await page.setContent('<button hidden id="editReimburFundingItems">选择经费项目</button><button id="newFunding">&#xf1ad; 选择经费项目</button>');
  const button = await waitForFundingEntry(new AutomationContext(page), 500);
  await expect(button).toHaveAttribute('id', 'newFunding');
});
