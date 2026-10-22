import type { BrowserSession, AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { FlowError } from '../domain/workflow';
import { hasHost } from './auth';

export const BACKUP_REIMBURSEMENT_URL = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job';

export function canUseBackupEntry(error: unknown): boolean {
  return error instanceof FlowError && [
    'workbench_navigation', 'workbench_search_missing', 'workbench_search_error', 'workbench_search_pending',
    'workbench_search_ambiguous', 'control_missing', 'ambiguous_choice',
  ].includes(error.code);
}

/** Navigation only, exactly once, before any primary entry/create click. */
export async function openBackupEntry(session: BrowserSession, ctx: AutomationContext,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (ctx.state.entryAttempted || ctx.state.backupEntryAttempted || ctx.state.creationAttempted) {
    throw new FlowError('entry_result_unknown');
  }
  ctx.state.backupEntryAttempted = true;
  const page = await session.context.newPage();
  session.page = page;
  ctx.updatePage(page);
  await page.bringToFront();
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '备用标签页已打开，正在请求无参数报销入口。' });
  try {
    await page.goto(BACKUP_REIMBURSEMENT_URL, { waitUntil: 'commit', timeout });
  } catch (cause) {
    process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
      evidence: '备用地址导航请求未完成；尚未核验或点击用款申请单创建按钮。' });
    throw new FlowError('backup_entry_unavailable', { cause });
  }
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '备用地址已开始返回页面，正在检查登录状态和用款申请单创建按钮。' });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new FlowError('backup_entry_unavailable');
    if (hasHost(page.url(), 'ids.shanghaitech.edu.cn')) throw new FlowError('authentication');
    if (hasHost(page.url(), 'sapbpm-new.shanghaitech.edu.cn')) {
      const body = await page.locator('body').innerText().catch(() => '');
      if (/登录超时|请重新登录|登录失效/.test(body)) throw new FlowError('authentication');
      // showLoad is an editor endpoint, not proof of a newly created document.
      // Preserve it for inspection if it resolves an existing/contextual form.
      for (const frame of page.frames()) {
        if (await frame.locator('#editReimburFundingItems').isVisible().catch(() => false)) {
          throw new FlowError('backup_form_review');
        }
      }
      const buttons = page.getByRole('link').filter({ hasText: /^\s*用款申请单\s/ })
        .getByRole('button', { name: /创建/ }).filter({ visible: true });
      const count = await buttons.count();
      if (count > 1) throw new FlowError('ambiguous_choice');
      if (count === 1) return;
    }
    await page.waitForTimeout(200);
  }
  throw new FlowError('backup_entry_unavailable');
}
