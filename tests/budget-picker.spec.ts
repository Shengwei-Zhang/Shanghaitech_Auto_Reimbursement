import { test, expect, type Page } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { chooseBudget } from '../src/automation/budget-picker';

async function budgetGrid(page: Page, options: { targetPage?: number; virtual?: boolean; duplicate?: boolean; missing?: boolean; stuck?: boolean; frozen?: boolean } = {}) {
  await page.setContent(`<div id="chooseBudgetOutlaysGrid">
    <div class="l-grid1"><table><tbody><tr class="l-grid-row"><td>23-委托服务费</td></tr></tbody></table></div>
    <div class="l-grid2"><table><tbody><tr><td>支出项目</td></tr></tbody></table>
      <div class="l-grid-body" style="height:160px;overflow:auto;position:relative;width:700px">
        <div id="canvas" style="position:relative"><table style="border-collapse:collapse;width:650px"><tbody id="rows"></tbody></table></div>
      </div>
    </div>
    <div class="l-grid-loading" style="display:none">加载中</div>
    <div class="l-bar-btnprev" role="button"><span>上一页</span></div>
    <div class="l-bar-text"><input value="2" size="1"> / 2</div>
    <div class="l-bar-btnnext" role="button"><span>下一页</span></div>
    <div id="selected"></div>
  </div><script>
    const options = ${JSON.stringify(options)};
    let current = 1;
    const body = document.querySelector('.l-grid-body');
    const rows = document.querySelector('#rows');
    const canvas = document.querySelector('#canvas');
    const renderRows = () => {
      const count = current === 0 ? 20 : 13;
      const start = options.virtual ? Math.floor(body.scrollTop / 40) : 0;
      const end = options.virtual ? Math.min(count, start + 5) : count;
      canvas.style.height = count * 40 + 'px';
      rows.parentElement.style.position = options.virtual ? 'absolute' : 'static';
      rows.parentElement.style.top = start * 40 + 'px';
      rows.innerHTML = Array.from({length:end-start}, (_, n) => {
        const i = start + n;
        const target = !options.missing && current === (options.targetPage ?? 1) && (i === 10 || (options.duplicate && i === 2));
        return '<tr class="l-grid-row" id="chooseBudgetOutlaysGrid|2|r' + i + '" style="height:40px"><td><span class="l-grid-row-cell-btn-checkbox" role="checkbox" aria-checked="false">□</span></td><td>' + (target ? '23-委托服务费' : '其他科目 ' + current + '-' + i) + '</td></tr>';
      }).join('');
      if (options.frozen) {
        const frozen = document.querySelector('.l-grid1');
        frozen.innerHTML = '<div style="height:160px;overflow:hidden"><table style="border-collapse:collapse"><tbody></tbody></table></div>';
        rows.querySelectorAll('tr').forEach(row => {
          const copy = row.cloneNode(true);
          copy.id = copy.id.replace('|2|','|1|');
          frozen.querySelector('tbody').append(copy);
          row.querySelector('td').remove();
        });
        frozen.firstElementChild.scrollTop = body.scrollTop;
      }
      document.querySelectorAll('.l-grid-row-cell-btn-checkbox').forEach(box => box.onclick = () => {
        box.setAttribute('aria-checked','true');
        document.querySelector('#selected').textContent += current + ':' + box.closest('tr').textContent;
      });
    };
    const render = () => {
      document.querySelector('.l-bar-text input').value = current + 1;
      document.querySelector('.l-bar-btnprev span').className = current === 0 ? 'l-disabled' : '';
      document.querySelector('.l-bar-btnnext').classList.toggle('l-bar-btnnext-disabled', current === 1);
      body.scrollTop = 0; renderRows();
    };
    for (const [selector, delta] of [['.l-bar-btnprev', -1], ['.l-bar-btnnext', 1]]) {
      document.querySelector(selector + ' span').onclick = () => {
        if (options.stuck) return;
        current += delta;
        if (current < 0 || current > 1) throw new Error('clicked disabled pagination');
        document.querySelector('.l-grid-loading').style.display = 'block';
        // Page indicator changes before the async row response.
        document.querySelector('.l-bar-text input').value = current + 1;
        setTimeout(() => { render(); document.querySelector('.l-grid-loading').style.display = 'none'; }, 120);
      };
    }
    body.onscroll = () => {
      if (options.virtual) renderRows();
      if (options.frozen) document.querySelector('.l-grid1').firstElementChild.scrollTop = body.scrollTop;
    };
    render();
  </script>`);
}

test('budget scans Liger pages and scrolls to an offscreen checkbox without including frozen/header rows', async ({ page }) => {
  await budgetGrid(page);
  await chooseBudget(new AutomationContext(page), '23-委托服务费', 2000);
  await expect(page.locator('#selected')).toHaveText('1:□23-委托服务费');
  expect(await page.locator('.l-grid2 .l-grid-body').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});

test('budget returns to an earlier page and scrolls back to the matched subject', async ({ page }) => {
  await budgetGrid(page, { targetPage: 0 });
  await chooseBudget(new AutomationContext(page), '23-委托服务费', 2000);
  await expect(page.locator('#selected')).toHaveText('0:□23-委托服务费');
});

test('budget scans virtual rows revealed only by internal scrolling', async ({ page }) => {
  await budgetGrid(page, { virtual: true });
  await chooseBudget(new AutomationContext(page), '23-委托服务费', 2000);
  await expect(page.locator('#selected')).toHaveText('1:□23-委托服务费');
});

test('budget selects the matching frozen-pane checkbox after scrolling the data pane', async ({ page }) => {
  await budgetGrid(page, { frozen: true });
  await chooseBudget(new AutomationContext(page), '23-委托服务费', 2000);
  await expect(page.locator('#selected')).toHaveText('1:□23-委托服务费');
});

test('budget rejects duplicate matches in separate scroll windows before selecting', async ({ page }) => {
  await budgetGrid(page, { virtual: true, duplicate: true });
  await expect(chooseBudget(new AutomationContext(page), '23-委托服务费', 2000))
    .rejects.toMatchObject({ code: 'ambiguous_choice' });
  await expect(page.locator('#selected')).toBeEmpty();
});

test('budget exhausts all pages for an absent subject without selecting another subject', async ({ page }) => {
  await budgetGrid(page, { missing: true });
  await expect(chooseBudget(new AutomationContext(page), '23-委托服务费', 2000))
    .rejects.toMatchObject({ code: 'control_missing' });
  await expect(page.locator('#selected')).toBeEmpty();
});

test('budget stops if pagination does not load a different page', async ({ page }) => {
  await budgetGrid(page, { stuck: true });
  await expect(chooseBudget(new AutomationContext(page), '23-委托服务费', 500))
    .rejects.toMatchObject({ code: 'control_missing' });
  await expect(page.locator('#selected')).toBeEmpty();
});
