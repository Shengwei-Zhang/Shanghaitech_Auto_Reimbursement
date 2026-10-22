import type { BrowserContext, Page, Frame, Locator } from 'playwright';
import { moneyToCents } from '../domain/job';
import { FlowError, type Receipt, type SiteProfile, type WriteResponseRule } from '../domain/workflow';
import type { AutomationContext } from './browser';
import { uniqueVisible, readValue } from './controls';
import { DEFAULT_TIMEOUT_MS } from './config';
import { watchRequestActivity } from './request-activity';

const BPM_HOST = 'sapbpm-new.shanghaitech.edu.cn';
export const FLOW_DIALOG = '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog, [role="dialog"]';
const submissionProgress = (evidence: string) => process.send?.({ type: 'stage', stage: 'prepare submission', state: 'started', evidence });

/** Flow confirmation may be hosted by the outer page rather than the editor's
 * iframe. Inspect this page only, never an unrelated stale business tab. */
export async function findSubmissionDialog(ctx: AutomationContext): Promise<Locator | null> {
  const roots = [ctx.page, ...ctx.page.frames().filter(frame => frame !== ctx.page.mainFrame())];
  const matches: Array<{ root: Page | Frame; dialog: Locator }> = [];
  for (const root of roots) {
    // Nested dialog wrappers describe one dialog, not two independent choices.
    // Some OA skins give the title element an ldg_dialog* ID as well.
    // A title alone is not the dialog containing the route and final button.
    const contents = root.locator('table, th, td, iframe, #ok');
    const candidates = root.locator(FLOW_DIALOG).filter({ hasText: '流转确认', visible: true, has: contents });
    for (const dialog of await candidates.all()) {
      const nested = dialog.locator(FLOW_DIALOG).filter({ hasText: '流转确认', visible: true, has: contents });
      if (!await nested.count()) matches.push({ root, dialog });
    }
  }
  if (matches.length > 1) throw new FlowError('submission_unknown');
  if (!matches.length) return null;
  ctx.setActiveFrame(matches[0].root === ctx.page ? null : matches[0].root as Frame);
  return matches[0].dialog;
}

function isBpm(frame: Frame): boolean {
  try { return new URL(frame.url()).hostname === BPM_HOST; } catch { return false; }
}
function amount(value: string): string { return value.replace(/[¥￥,\s]/g, ''); }

async function submissionBlocked(ctx: AutomationContext): Promise<boolean> {
  for (const root of [ctx.page, ...ctx.page.frames().filter(frame => frame !== ctx.page.mainFrame())]) {
    if (await root.locator(`${FLOW_DIALOG}, [role="alert"], #ldg_lockmask, .lockmask, .ui-widget-overlay, .modal-backdrop, .l-window-mask, .l-grid-loading`)
      .filter({ visible: true }).count()) return true;
  }
  return false;
}

export async function confirmedWrite(ctx: AutomationContext, rule: WriteResponseRule,
  action: () => Promise<void>, kind: 'save' | 'submit', timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const unknown = kind === 'save' ? 'save_unverified' : 'submission_unknown';
  const responsePromise = ctx.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname === BPM_HOST && url.pathname === rule.pathname && response.request().method() === 'POST';
  }, { timeout }).catch(() => null);
  try { await action(); } catch (cause) { throw new FlowError(unknown, { cause }); }
  const response = await responsePromise;
  if (!response) throw new FlowError(unknown);
  if (!response.ok()) throw new FlowError(unknown);
  let body: unknown;
  try { body = await response.json(); } catch (cause) { throw new FlowError(unknown, { cause }); }
  for (const key of rule.field.split('.')) {
    body = body && typeof body === 'object' && Object.hasOwn(body, key) ? (body as Record<string, unknown>)[key] : undefined;
  }
  if (body !== rule.equals) throw new FlowError(kind === 'save' ? 'save_unverified' : 'submission_rejected');
}

/** Observes a specific document after a full page reload, never a toast or disabled button. */
export async function verifyReceipt(
  browser: BrowserContext, profile: SiteProfile, expected: { documentNumber: string; amount: string },
  kind: 'save' | 'submit', timeout = DEFAULT_TIMEOUT_MS,
): Promise<{ receipt: Receipt; page: Page; frame: Frame }> {
  const accepted = kind === 'save' ? profile.receipt.savedStatuses : profile.receipt.submittedStatuses;
  const deadline = Date.now() + timeout;
  const reloaded = new Set<Page>();
  while (Date.now() < deadline) {
    for (const page of browser.pages()) {
      if (page.isClosed() || !page.frames().some(isBpm)) continue;
      if (!reloaded.has(page)) {
        // Mark BEFORE the request; a timed-out reload cannot turn into a repeated write.
        reloaded.add(page);
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) }); }
        catch { continue; }
      }
      for (const frame of page.frames().filter(isBpm)) {
        const containers = frame.locator(profile.receipt.container).filter({ visible: true });
        const matches: Array<{ receipt: Receipt; page: Page; frame: Frame }> = [];
        for (const container of await containers.all()) {
          const field = async (selector: string) => {
            const loc = container.locator(selector);
            if (await loc.count() !== 1) return '';
            return readValue(loc);
          };
          try {
            const documentNumber = await field(profile.receipt.documentNumber);
            if (documentNumber !== expected.documentNumber) continue;
            const observedAmount = amount(await field(profile.receipt.amount));
            const status = await field(profile.receipt.status);
            if (moneyToCents(observedAmount) !== moneyToCents(amount(expected.amount))) throw new FlowError('value_mismatch');
            if (!accepted.includes(status)) continue;
            matches.push({ page, frame, receipt: { documentNumber, amount: observedAmount, status,
              source: 'reloaded_oa_page', verifiedAt: new Date().toISOString() } });
          } catch (error) { if (error instanceof FlowError) throw error; }
        }
        if (matches.length > 1) throw new FlowError('ambiguous_choice');
        if (matches.length === 1) return matches[0];
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new FlowError(kind === 'submit' ? 'submission_unknown' : 'save_unverified');
}

export async function openSubmissionDialog(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const existing = await findSubmissionDialog(ctx);
  if (existing) {
    submissionProgress('已发现现有“流转确认”弹窗，将核对后自动确认，不再次点击提交。');
    return existing;
  }
  if (ctx.state.submissionPrepareAttempted) throw new FlowError('submission_unknown');
  const advance = await uniqueVisible(ctx.locator('#toolBar #advance, button#advance').filter({ hasText: /^\s*提交\s*$/ }), timeout);
  // This selector and dialog title are grounded in the V3 recording/legacy implementation.
  ctx.state.submissionPrepareAttempted = true;
  const activity = watchRequestActivity(ctx.page);
  const originalPageUrl = ctx.page.url();
  const originalRoot = ctx.root();
  const originalRootUrl = originalRoot.url();
  let interrupted = false;
  const stopRetry = () => { interrupted = true; };
  // Leave native confirmation/alert dialogs to the user, never accept them.
  ctx.page.on('dialog', stopRetry); ctx.page.on('popup', stopRetry);
  let attempts = 0;
  const deadline = Date.now() + timeout;
  const observationMs = Math.min(4000, Math.max(100, timeout / 4));
  const click = async () => {
    attempts++;
    submissionProgress(`第 ${attempts}/3 次点击主表单“提交”以打开流转确认；弹窗出现后将核对并自动确认。`);
    await advance.click({ timeout: Math.max(1, deadline - Date.now()), noWaitAfter: true });
    submissionProgress(`第 ${attempts} 次点击已返回，正在跨框架检查弹窗和请求。`);
    return Date.now();
  };
  try {
    let lastClick = await click();
    while (Date.now() < deadline) {
      const dialog = await findSubmissionDialog(ctx);
      if (dialog) {
        submissionProgress('已识别“流转确认”弹窗，接下来核对表单和审批路线，再单次点击最终确定。');
        return dialog;
      }
      const state = activity.snapshot();
      if (interrupted || state.failed || ctx.page.url() !== originalPageUrl || originalRoot.url() !== originalRootUrl) {
        submissionProgress('检测到页面跳转、新窗口、原生提示或请求失败，停止重试打开弹窗，保留现场核对。');
        throw new FlowError('submission_unknown');
      }
      // A request means OA may be processing this click even if no dialog is
      // visible yet. Only an otherwise inert click is eligible for replay.
      if (attempts < 3 && state.started === 0 && Date.now() - lastClick >= observationMs
        && !await submissionBlocked(ctx) && await advance.isVisible() && await advance.isEnabled()) {
        const late = await findSubmissionDialog(ctx);
        if (late) return late;
        if (!activity.snapshot().started && !interrupted) lastClick = await click();
      }
      await ctx.page.waitForTimeout(100);
    }
    submissionProgress(`已尝试 ${attempts} 次打开弹窗，仍未识别到“流转确认”（观察到请求 ${activity.snapshot().started} 个）。停止点击，未执行最终确认。`);
    throw new FlowError('submission_unknown');
  } catch (cause) { throw new FlowError('submission_unknown', { cause }); }
  finally { activity.dispose(); ctx.page.off('dialog', stopRetry); ctx.page.off('popup', stopRetry); }
}
