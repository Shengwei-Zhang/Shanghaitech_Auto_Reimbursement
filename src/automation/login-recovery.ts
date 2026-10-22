import type { AutomationContext, BrowserSession } from './browser';
import { hasHost, isLoginTimeoutPage } from './auth';
import { FlowError } from '../domain/workflow';

/** Only the creation menu's explicit expired session can restart creation.
 * Once an editor exists, a new document would risk duplicating an existing one. */
export async function canRecoverCreationLogin(ctx: AutomationContext, session: BrowserSession): Promise<boolean> {
  if (ctx.state.creationCompleted || ctx.state.openedFromTodo || ctx.state.invoiceUploadAttempted
    || ctx.state.submissionPrepareAttempted || ctx.state.submissionFinalAttempted || ctx.page.isClosed()) return false;
  const url = new URL(ctx.page.url());
  if (!hasHost(url.href, 'sapbpm-new.shanghaitech.edu.cn')
    || !/\/(?:forwardAddRbReimbursement\.do|showLoadRbReimbursement\.job)$/.test(url.pathname)
    || ['bizId', 'taskId', 'procInstId'].some(key => url.searchParams.has(key))) return false;
  if (!await isLoginTimeoutPage(ctx.page)) return false;
  // Require the creation menu, even when a timeout is on top of its confirm dialog.
  if (!await ctx.page.getByRole('link').filter({ hasText: /^\s*用款申请单\s/ })
    .getByRole('button', { name: /创建/ }).filter({ visible: true }).count()) return false;
  for (const page of session.context.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      if (await frame.locator('#editReimburFundingItems').count()) return false;
    }
  }
  return true;
}

export async function returnToLoginWorkbench(session: BrowserSession, ctx: AutomationContext): Promise<void> {
  const expired = ctx.page;
  const portals = session.context.pages().filter(page => page !== expired && !page.isClosed()
    && hasHost(page.url(), 'egate-new.shanghaitech.edu.cn'));
  const portal = portals.length === 1 ? portals[0] : await session.context.newPage();
  // Have a surviving tab before closing the expired one. Never reuse its ticket URL.
  await expired.close();
  session.page = portal;
  ctx.updatePage(portal);
  ctx.state.entryAttempted = false;
  ctx.state.backupEntryAttempted = false;
  ctx.state.creationAttempted = false;
  await portal.bringToFront();
}

export async function withCreationLoginRecovery(session: BrowserSession, ctx: AutomationContext,
  enabled: boolean, create: (recovered: boolean) => Promise<void>, loginAndWorkbench: () => Promise<void>,
  signal?: AbortSignal): Promise<void> {
  try { await create(false); }
  catch (error) {
    signal?.throwIfAborted();
    if (!enabled || !(error instanceof FlowError) || error.code !== 'authentication'
      || !await canRecoverCreationLogin(ctx, session)) throw error;
    process.send?.({ type: 'stage', stage: 'authenticate', state: 'started',
      evidence: '创建入口明确提示登录超时且未发现已建单据。关闭失效标签页，返回认证和工作台搜索；本任务仅恢复一次。' });
    await returnToLoginWorkbench(session, ctx);
    await loginAndWorkbench();
    signal?.throwIfAborted();
    // Deliberately outside the catch: a second expiry never loops or recreates again.
    await create(true);
  }
}
