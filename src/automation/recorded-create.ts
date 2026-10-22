import type { AutomationContext } from './browser';
import type { Locator } from 'playwright';
import { DEFAULT_TIMEOUT_MS } from './config';
import { uniqueVisible } from './controls';
import { waitForFundingEntry } from './editor-entry';
import { assertNotLoginTimeout } from './auth';
import { FlowError } from '../domain/workflow';

async function waitAuthenticatedControl(ctx: AutomationContext, locator: Locator, timeout: number): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await assertNotLoginTimeout(ctx.page);
    if (await locator.filter({ visible: true }).count()) return uniqueVisible(locator, timeout);
    await ctx.page.waitForTimeout(100);
  }
  await assertNotLoginTimeout(ctx.page);
  throw new FlowError('control_missing');
}

/** 2026-09-16 recording, steps 7–8: the application row, then its confirmation. */
export async function createPaymentApplication(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (ctx.state.creationAttempted) throw new FlowError('entry_result_unknown');
  await assertNotLoginTimeout(ctx.page, 'create payment application');
  const row = await waitAuthenticatedControl(ctx, ctx.page.getByRole('link').filter({ hasText: /^\s*用款申请单\s/ }), timeout);
  const create = await waitAuthenticatedControl(ctx, row.getByRole('button', { name: /创建/ }), timeout);
  // Never retry creation or confirm a generic unrelated dialog.
  ctx.state.creationAttempted = true;
  await create.click({ timeout });
  process.send?.({ type: 'stage', stage: 'prepare reimbursement form', state: 'started',
    evidence: '已点击“用款申请单”的“创建”，正在等待确认弹窗并检查 BPM 会话。' });
  const dialog = await waitAuthenticatedControl(ctx, ctx.page.locator('.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog, [role="dialog"]')
    .filter({ hasText: '用款申请单' }), timeout);
  const confirm = await waitAuthenticatedControl(ctx, dialog.locator('#ok').filter({ hasText: /^\s*确定\s*$/ }), timeout);
  await confirm.click({ timeout });
  process.send?.({ type: 'stage', stage: 'prepare reimbursement form', state: 'started',
    evidence: '已点击用款申请单确认，正在等待编辑页并检查 BPM 会话；不会重复创建。' });
  await waitForFundingEntry(ctx, timeout);
  ctx.state.creationCompleted = true;
}
