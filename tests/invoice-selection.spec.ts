import { test, expect } from '@playwright/test';
import { selectInvoice } from '../src/automation/invoice-selection';

for (const marker of ['row', 'cell', 'icon', 'wrapper', 'aria']) {
  test(`VXE checkbox state on ${marker} is recognised without a second click`, async ({ page }) => {
    await page.setContent(`<table><tbody><tr rowid="target"><td class="col--checkbox"><span class="vxe-cell--checkbox">选择</span></td></tr></tbody></table>`);
    await page.evaluate(marker => {
      const row = document.querySelector('tr')!;
      const cell = document.querySelector('td')!;
      const checkbox = document.querySelector('span')!;
      (window as any).clicks = 0;
      checkbox.addEventListener('click', () => {
        (window as any).clicks++;
        if (marker === 'row') row.classList.add('row--checked');
        if (marker === 'cell') cell.classList.add('is--checked');
        if (marker === 'wrapper') checkbox.classList.add('is--checked');
        if (marker === 'icon') checkbox.innerHTML = '<i class="vxe-checkbox--icon vxe-icon-checkbox-checked"></i>';
        if (marker === 'aria') { checkbox.setAttribute('role', 'checkbox'); checkbox.setAttribute('aria-checked', 'true'); }
      });
    }, marker);
    await selectInvoice(page.locator('tr[rowid="target"]'), 500);
    await selectInvoice(page.locator('tr[rowid="target"]'), 500);
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
  });
}


test('hidden checked icon template does not report an unchecked invoice as selected', async ({ page }) => {
  await page.setContent('<table><tr><td><span class="vxe-cell--checkbox">选择<i class="vxe-icon-checkbox-checked" style="display:none"></i></span></td></tr></table>');
  await expect(selectInvoice(page.locator('tr'), 100)).rejects.toMatchObject({ code: 'invoice_selection_unconfirmed' });
});
