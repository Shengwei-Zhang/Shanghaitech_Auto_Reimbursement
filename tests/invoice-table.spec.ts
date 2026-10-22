import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { findInvoiceRowByColumn } from '../src/automation/invoice-table';

const number = '26117000000000000001';

async function table(page: import('@playwright/test').Page, mode = 'normal') {
  await page.setContent(`<div class="vxe-table">
    <div class="vxe-table--header-wrapper"><table><thead><tr id="headers"></tr></thead></table></div>
    <div class="vxe-table--body-wrapper" style="width:400px;overflow-x:auto"><table style="width:1600px;table-layout:fixed"><tbody></tbody></table></div>
    </div><script>(() => {
    const body=document.querySelector('.vxe-table--body-wrapper');
    let revealed=false;window.selected='';window.moves=[];
    const render=()=>{
      const right=body.scrollLeft>500;
      if(right)revealed=true;
      const mode=${JSON.stringify(mode)};
      document.querySelector('#headers').innerHTML=right?'<th class="col_invoice">发票号</th>':'<th class="col_select">选择</th>';
      let rows=[{id:'wrong',number:'26117000000000000009'},{id:'target',number:'${number}'}];
      // Reorder after scrolling back: a positional row locator would pick wrong.
      if(!right && revealed)rows.reverse();
      if(mode==='duplicate')rows[0].number='${number}';
      if(mode==='disappear' && !right && revealed)rows=rows.filter(row=>row.id!=='target');
      document.querySelector('tbody').innerHTML=rows.map(row=>'<tr '+(mode==='no-key'?'':'rowid="'+row.id+'"')+'>'+
        (right?'<td class="col_invoice">'+row.number+'</td>':'<td><input type="checkbox" data-id="'+row.id+'"></td>')+
        '<td>备注 ${number}</td></tr>').join('');
      document.querySelectorAll('input').forEach(input=>input.onchange=()=>window.selected=input.dataset.id);
    };
    body.onscroll=()=>{window.moves.push(body.scrollLeft);render();};render();
    })();</script>`);
}

test('virtual invoice column is revealed and the same row is selected after scrolling left and reordering', async ({ page }) => {
  await table(page);
  const row = await findInvoiceRowByColumn(new AutomationContext(page), number, 2000);
  expect(row).not.toBeNull();
  await row!.locator('input').check();
  expect(await page.evaluate(() => (window as any).selected)).toBe('target');
  expect(await page.evaluate(() => (window as any).moves.some((x: number) => x > 500))).toBe(true);
});

test('number in a remark never substitutes for the invoice-number cell', async ({ page }) => {
  await table(page);
  expect(await findInvoiceRowByColumn(new AutomationContext(page), '26117000000000000002', 2000)).toBeNull();
  expect(await page.evaluate(() => (window as any).selected)).toBe('');
});

test('duplicate invoice cells and missing stable row identity stop without selecting', async ({ page }) => {
  for (const [mode, code] of [['duplicate', 'ambiguous_choice'], ['no-key', 'invoice_row_identity_missing']]) {
    await table(page, mode);
    await expect(findInvoiceRowByColumn(new AutomationContext(page), number, 2000)).rejects.toMatchObject({ code });
    expect(await page.evaluate(() => (window as any).selected)).toBe('');
  }
});

test('a target row removed after scrolling back cannot select the row at its old position', async ({ page }) => {
  await table(page, 'disappear');
  const result = findInvoiceRowByColumn(new AutomationContext(page), number, 1000);
  // The adapter must either detect the disappearance itself, or return a locator
  // bound to the vanished identity that refuses the subsequent click.
  await expect(result.then(row => row!.locator('input').check({ timeout: 200 }))).rejects.toThrow();
  expect(await page.evaluate(() => (window as any).selected)).toBe('');
});
