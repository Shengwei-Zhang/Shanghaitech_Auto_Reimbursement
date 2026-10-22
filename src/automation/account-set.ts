import type { Locator } from 'playwright';
import { waitAndClick } from './actions';
import type { AutomationContext } from './browser';
import { assertNotLoginTimeout } from './auth';
import { waitForDisplayed } from './frames';

/** Legacy Katalon xpath — lookup button beside the 报销账套 label, NOT list-row 创建 buttons. */
const ACCOUNT_SET_LOOKUP_XPATH =
  "(.//*[normalize-space(text()) and normalize-space(.)='报销账套\u00a0:'])[1]/following::button[2]";

export async function isReimbursementEditPageReady(ctx: AutomationContext): Promise<boolean> {
  return ctx.page.locator('#editReimburFundingItems').isVisible().catch(() => false);
}

export async function dismissWrongFormDialogs(ctx: AutomationContext): Promise<void> {
  const wrongDialog = ctx.page.locator('.ui_dialog, .ui-dialog').filter({ hasText: '用款申请单' });
  if (await wrongDialog.first().isVisible().catch(() => false)) {
    await wrongDialog.first().getByRole('button', { name: '关闭' }).click().catch(async () => {
      await wrongDialog.first().getByRole('button', { name: '确定' }).click().catch(() => undefined);
    });
    throw new Error(
      'Account set step clicked the wrong control and opened [用款申请单]. '
      + 'The lookup button beside 报销账套 must be used instead of list-row 创建 buttons.',
    );
  }
}

export async function dismissLoginTimeoutPrompts(ctx: AutomationContext): Promise<void> {
  const prompt = ctx.page.locator('.ui_dialog, .ui-dialog, .modal').filter({ hasText: '登录超时' });
  if (await prompt.first().isVisible().catch(() => false)) {
    await prompt.first().getByRole('button', { name: /确定|关闭/ }).first().click().catch(() => undefined);
    throw new Error(
      `BPM session expired (登录超时) at ${ctx.page.url()}. `
      + 'Close all OA tabs, log in again, and rerun npm start.',
    );
  }
}

function accountSetLookupButton(ctx: AutomationContext): Locator {
  return ctx.page.locator(`xpath=${ACCOUNT_SET_LOOKUP_XPATH}`);
}

export async function selectReimbursementAccountSet(ctx: AutomationContext): Promise<void> {
  if (await isReimbursementEditPageReady(ctx)) {
    console.log('Reimbursement edit page already loaded; skipping account set lookup click.');
    return;
  }

  await assertNotLoginTimeout(ctx.page, 'BPM account set page');
  await dismissLoginTimeoutPrompts(ctx);
  await dismissWrongFormDialogs(ctx);

  await waitAndClick(ctx, accountSetLookupButton(ctx), 'reimbursement-account-set');
}

export async function confirmReimbursementAccountSet(ctx: AutomationContext): Promise<void> {
  if (await isReimbursementEditPageReady(ctx)) {
    console.log('Reimbursement edit page already loaded; skipping account set confirmation.');
    return;
  }

  await dismissWrongFormDialogs(ctx);

  const accountDialog = ctx.page.locator('.ui_dialog, .ui-dialog').filter({ hasText: /报销账套|账套/ });
  const okInDialog = accountDialog.locator('#ok').first();
  const okTarget = (await okInDialog.isVisible().catch(() => false))
    ? okInDialog
    : ctx.page.locator('#ok').first();

  await waitAndClick(ctx, okTarget, 'confirm-account-set');
  await dismissLoginTimeoutPrompts(ctx);
}

export async function waitForReimbursementEditPage(ctx: AutomationContext): Promise<void> {
  await waitForDisplayed(ctx, '#editReimburFundingItems');
}
