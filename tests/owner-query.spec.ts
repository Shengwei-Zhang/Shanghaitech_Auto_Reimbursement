import { test, expect } from '@playwright/test';
import { loadOwnerQueryGrid } from '../src/automation/todo-reimbursement';

const base = 'http://owner-query.test/bpm-new/rbReimbursementQuery/';

test('owner query waits past the initial empty grid until its delayed response renders', async ({ page }) => {
  await page.route(`${base}**`, async route => {
    if (route.request().url().endsWith('rows')) {
      await new Promise(resolve => setTimeout(resolve, 120));
      await route.fulfill({ json: [{ billCode: 'A209900000012' }] });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: `
      <form id="queryMainForm"></form>
      <div id="maingrid"><div class="l-grid-loading" style="display:none">加载中</div>
      <span id="rows">0</span></div>
      <script>
        let rows = [];
        window.gridManager = { getData: () => rows };
        window.query = () => setTimeout(async () => {
          document.querySelector('.l-grid-loading').style.display = 'block';
          rows = await (await fetch('rows')).json();
          document.querySelector('#rows').textContent = rows[0].billCode;
          document.querySelector('.l-grid-loading').style.display = 'none';
        }, 400);
      </script>` });
  });
  await page.goto(`${base}forwardRbReimbursementOwnerQuery.do`);
  await loadOwnerQueryGrid(page, 3000);
  expect(await page.locator('#rows').textContent()).toBe('A209900000012');
});

test('owner query refuses to read a grid when query starts no request', async ({ page }) => {
  await page.route(`${base}**`, route => route.fulfill({ contentType: 'text/html', body: `
    <form id="queryMainForm"></form><div id="maingrid"></div>
    <script>window.gridManager = {getData: () => []}; window.query = () => {};</script>` }));
  await page.goto(`${base}forwardRbReimbursementOwnerQuery.do`);
  await expect(loadOwnerQueryGrid(page, 350)).rejects.toThrow('Observed requests did not settle');
});
