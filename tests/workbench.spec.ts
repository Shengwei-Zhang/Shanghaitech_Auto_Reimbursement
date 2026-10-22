import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { openWorkbench, workbenchSearch } from '../src/automation/workbench';

for (const theme of ['red', 'orange', 'blue', 'green', 'purple', 'random']) {
test(`${theme} portal authentication proceeds to search without changing theme`, async ({ page }) => {
  const { waitForEgateAfterLogin } = await import('../src/automation/auth');
  const { fillWorkflowSearch } = await import('../src/automation/workbench');
  await page.context().route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: '<input hidden placeholder="请输入您想要的事项名称"><input placeholder="请输入您想要的事项名称">' }));
  const url = `https://egate-new.shanghaitech.edu.cn/${theme}/index.html#/work`;
  await page.goto(url);
  expect(await waitForEgateAfterLogin(page, 1000)).toBe(page);
  const ctx = new AutomationContext(page);
  await openWorkbench(ctx);
  await fillWorkflowSearch(ctx);
  await expect(page.getByPlaceholder('请输入您想要的事项名称').filter({ visible: true })).toHaveValue('报销单');
  expect(page.url()).toBe(url);
});
}

test('ready workbench proceeds while an unrelated deferred script still delays DOMContentLoaded', async ({ page }) => {
  test.setTimeout(5000);
  let deferred: import('@playwright/test').Route | undefined;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/slow.js') { deferred = route; return; }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<script defer src="/slow.js"></script><input placeholder="请输入您想要的事项名称">' });
  });
  await page.goto('https://egate-new.shanghaitech.edu.cn/orange/index.html#/work', { waitUntil: 'commit' });
  try {
    const ctx = new AutomationContext(page);
    await openWorkbench(ctx);
    await expect(page.getByPlaceholder('请输入您想要的事项名称')).toBeEditable();
    expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
  } finally { await deferred?.fulfill({ contentType: 'text/javascript', body: '' }); }
});

test('workbench search handles async iframe and hidden duplicated placeholder', async ({ page }) => {
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'egate-new.shanghaitech.edu.cn') return route.abort();
    if (url.pathname === '/search') return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<input placeholder="请输入您想要的事 项 名 称" id="search">' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<input hidden placeholder="事项名称"><script>setTimeout(() => { const frame=document.createElement("iframe");frame.src="/search";document.body.append(frame); },100)</script>' });
  });
  await page.goto('https://egate-new.shanghaitech.edu.cn/green/index.html#/work');
  const ctx = new AutomationContext(page);
  await openWorkbench(ctx);
  await (await workbenchSearch(ctx)).fill('报销单创建（电子签章）');
  await expect(page.frameLocator('iframe').locator('#search')).toHaveValue('报销单创建（电子签章）');
});

test('missing workbench search raises a specific failure without business clicks', async ({ page }) => {
  await page.context().route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>加载中</p>' }));
  await page.goto('https://egate-new.shanghaitech.edu.cn/green/index.html#/work');
  await expect(workbenchSearch(new AutomationContext(page), 100)).rejects.toMatchObject({ code: 'workbench_search_missing' });
});

test('recorded accessible-name search without placeholder triggers suggestions inside iframe', async ({ page }) => {
  const { fillWorkflowSearch } = await import('../src/automation/workbench');
  const { clickWorkflowSearchResult } = await import('../src/automation/workflow-search');
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'egate-new.shanghaitech.edu.cn') return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.pathname === '/search'
      ? `<input aria-label="请输入您想要的事项名称"><div class="search__dropdown" hidden><div>报销单查询</div><div id="create">报销单创建（电子签章）</div></div><script>
      document.querySelector('input').oninput = e => document.querySelector('.search__dropdown').hidden = e.target.value !== '报销单';
      document.querySelector('#create').onclick = () => document.body.dataset.selected = 'create';</script>`
      : '<iframe src="/search"></iframe>' });
  });
  await page.goto('https://egate-new.shanghaitech.edu.cn/blue/index.html#/work');
  const ctx = new AutomationContext(page);
  await openWorkbench(ctx);
  await fillWorkflowSearch(ctx);
  await clickWorkflowSearchResult(ctx, 'recorded-search');
  await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute('data-selected', 'create');
});

test('recorded XPath finds only its own field when accessible label is absent', async ({ page }) => {
  const { fillWorkflowSearch } = await import('../src/automation/workbench');
  await page.setContent('<input placeholder="无关搜索"><div id="home"><header><div></div><div><div></div><div><div><div><div></div><div><div><div><div><input id="recorded"></div></div></div></div></div></div></div></div></header></div>');
  await fillWorkflowSearch(new AutomationContext(page), 500);
  await expect(page.locator('#recorded')).toHaveValue('报销单');
  await expect(page.getByPlaceholder('无关搜索')).toHaveValue('');
});

test('highlighted screenshot menu with spaces clicks creation rather than audit or query', async ({ page }) => {
  const { clickWorkflowSearchResult } = await import('../src/automation/workflow-search');
  await page.setContent(`<div class="search__dropdown">
    <div data-choice="audit"><span style="color:green">报销单</span>审核 （电子签章）</div>
    <div data-choice="create"><span style="color:green">报销单</span>创建 （电子签章）</div>
    <div data-choice="query"><span style="color:green">报销单</span>查询 （电子签章）</div>
    <div data-choice="legacy"><span style="color:green">报销单</span>查询</div>
    <div hidden data-choice="hidden">报销单创建（电子签章）</div>
    </div><script>document.querySelectorAll('[data-choice]').forEach(el=>el.onclick=()=>document.body.dataset.clicked=el.dataset.choice)</script>`);
  await clickWorkflowSearchResult(new AutomationContext(page), 'screenshot-menu', 1000);
  await expect(page.locator('body')).toHaveAttribute('data-clicked', 'create');
});
