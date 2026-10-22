import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { fillFundingCell } from '../src/automation/funding-editor';

test('floating editor needs outside mouse click to commit; blur alone leaves old cell value', async ({ page }) => {
  await page.setContent(`<div id="grid"><table><tr><th class="l-grid-hd-cell" columnname="amount" id="g|c1">报销金额/元</th></tr></table>
    <div class="l-grid2"><div class="l-grid-body" style="height:250px;border:1px solid">
    <table><tr class="l-grid-row"><td id="g|r1|c1" style="width:220px;height:32px"><div>0.00</div></td></tr></table>
    </div></div></div>`);
  await page.evaluate(() => {
    const cell = document.querySelector('td')!;
    let editor: HTMLInputElement | null = null;
    cell.firstElementChild!.addEventListener('click', () => {
      editor = document.createElement('input');
      const box = cell.getBoundingClientRect();
      Object.assign(editor.style, { position: 'fixed', left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` });
      editor.value = '0.00'; document.body.append(editor); editor.focus();
    });
    document.querySelector('.l-grid-body')!.addEventListener('mousedown', event => {
      if (!editor || (event.target as Element).closest('tr')) return;
      cell.firstElementChild!.textContent = editor.value;
      editor.remove(); editor = null;
    });
  });
  await fillFundingCell(new AutomationContext(page), page.locator('#grid'), 'amount', '200.00', 1500);
  await expect(page.locator('td')).toHaveText('200.00');
  await expect(page.locator('input')).toHaveCount(0);
});
