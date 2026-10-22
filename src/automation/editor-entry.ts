import type { Frame, Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { assertNotLoginTimeout } from './auth';
import { FlowError } from '../domain/workflow';

/** The new empty application shows “选择经费项目”; older forms use the recorded ID.
 * Resolve both in every frame, without clicking or creating another document. */
export async function waitForFundingEntry(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const deadline = Date.now() + timeout;
  let lastEvidence = '';
  do {
    await assertNotLoginTimeout(ctx.page);
    const frames = ctx.page.frames();
    const matches: Array<{ frame: Frame; locator: Locator }> = [];
    let ids = 0, named = 0;
    for (const frame of frames) {
      const byId = frame.locator('#editReimburFundingItems').filter({ visible: true });
      const byName = frame.getByRole('button', { name: /^(?:[\uE000-\uF8FF]\s*)?选择经费项目\s*$/ }).filter({ visible: true });
      ids += await byId.count(); named += await byName.count();
      const candidates = byId.or(byName);
      for (const locator of await candidates.all()) matches.push({ frame, locator });
    }
    const evidence = `编辑页经费入口检测：${frames.length} 个框架，旧 ID 可见 ${ids} 个，按钮名称匹配 ${named} 个。`;
    if (evidence !== lastEvidence) {
      process.send?.({ type: 'stage', stage: 'prepare reimbursement form', state: 'started', evidence });
      lastEvidence = evidence;
    }
    if (matches.length > 1) throw new FlowError('ambiguous_choice');
    if (matches.length === 1 && await matches[0].locator.isEnabled()) {
      ctx.setActiveFrame(matches[0].frame === ctx.page.mainFrame() ? null : matches[0].frame);
      return matches[0].locator;
    }
    await ctx.page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new FlowError('editor_entry_unavailable');
}
