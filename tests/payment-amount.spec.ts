import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { fillPaymentAmount } from '../src/automation/payment-amount';

// Synthetic blur formatter based on the user-confirmed interaction. This does
// not reproduce or prove the behavior of the school's actual input plugin.
test('direct amount entry replaces zero and waits for blur formatting', async ({ page }) => {
  await page.setContent('<input id="amount" value="0.00"><button>保存</button>');
  await page.locator('#amount').evaluate(element => {
    const input = element as HTMLInputElement;
    input.addEventListener('blur', () => {
      const entered = input.value;
      input.value = '0.00';
      setTimeout(() => { input.value = Number(entered).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }); }, 150);
    });
  });
  const field = page.locator('#amount');
  const ctx = new AutomationContext(page);
  await fillPaymentAmount(ctx, field, '200.00', 2000);
  await expect(field).toHaveValue('200.00');
  await fillPaymentAmount(ctx, field, '1200.10', 2000);
  await expect(field).toHaveValue('1,200.10');
});

test('wrong amount stops before the caller can save', async ({ page }) => {
  await page.setContent('<input id="amount"><button>保存</button>');
  await page.locator('#amount').evaluate(element => {
    element.addEventListener('blur', () => { (element as HTMLInputElement).value = '20.00'; });
  });
  await expect(fillPaymentAmount(new AutomationContext(page), page.locator('#amount'), '200.00', 200))
    .rejects.toMatchObject({ code: 'payment_amount_mismatch' });
});
