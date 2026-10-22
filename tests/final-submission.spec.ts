import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { findSubmissionDialog } from '../src/automation/submission';
import { assertApprovalRoute, readApprovalRoute, confirmSubmission } from '../src/automation/final-submission';

const route = `<div>流程审批规则： /网上预约报销审批</div><table>
<tr><th></th><th>环节</th><th>处理人</th><th>*发送消息</th><th>分组号</th></tr>
<tr><td>1</td><td rowspan="2">财务审核</td><td>合成甲</td><td>是</td><td>60</td></tr>
<tr><td>2</td><td>合成乙</td><td>否</td><td>60</td></tr></table>`;

test('table dialog with a title sharing the ldg_dialog prefix retains the route and recorded #ok', async ({ page }) => {
  await page.setContent(`<table class="ui_dialog"><tr><td>
    <div id="ldg_dialog_title_fixture">流转确认<a href="#">×</a></div></td></tr>
    <tr><td>${route}</td></tr><tr><td><a id="ok">确定</a><button>取消</button></td></tr></table>`);
  const ctx = new AutomationContext(page);
  const dialog = await findSubmissionDialog(ctx);
  expect(dialog).not.toBeNull();
  expect(await dialog!.getAttribute('class')).toBe('ui_dialog');
  assertApprovalRoute(await readApprovalRoute(dialog!));
  await page.evaluate(() => {
    (window as any).clicks = 0;
    document.querySelector('#ok')!.addEventListener('click', () => { (window as any).clicks++; });
  });
  // No request is sent by this fixture. The observed click must remain unknown,
  // and a second call must not replay it.
  await expect(confirmSubmission(ctx, async () => {}, async () => {}, undefined, 200))
    .rejects.toMatchObject({ code: 'submission_unknown' });
  await expect(confirmSubmission(ctx, async () => {}, async () => {}, undefined, 200))
    .rejects.toMatchObject({ code: 'submission_unknown' });
  expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
});

test('two independent flow dialogs remain ambiguous', async ({ page }) => {
  await page.setContent(`<div class="ui_dialog">流转确认${route}<button>确定</button></div>
    <div class="ui_dialog">流转确认${route}<button>确定</button></div>`);
  await expect(findSubmissionDialog(new AutomationContext(page))).rejects.toMatchObject({ code: 'submission_unknown' });
});
