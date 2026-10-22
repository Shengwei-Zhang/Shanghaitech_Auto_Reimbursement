import type { Page } from 'playwright';
import type { AutomationContext, BrowserSession } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { FlowError } from '../domain/workflow';
import { hasHost } from './auth';

const BPM_HOST = 'sapbpm-new.shanghaitech.edu.cn';

function pageHostsBpm(page: Page): boolean {
  return hasHost(page.url(), BPM_HOST)
    || page.frames().some((frame) => hasHost(frame.url(), BPM_HOST));
}

export async function runAndFocusBpmPage(
  session: BrowserSession,
  ctx: AutomationContext,
  action: () => Promise<void>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Page> {
  const pagesBefore = new Set(session.context.pages());
  const existingBusinessPages = new Set([...pagesBefore].filter(pageHostsBpm));

  await action();
  const deadline = Date.now() + timeoutMs;
  let bpmPage: Page | undefined;
  while (Date.now() < deadline && !bpmPage) {
    // A popup and same-tab/iframe navigation are equal readiness signals.
    // Never await a popup timeout when the actual business page is already ready,
    // and never adopt an unrelated reimbursement tab that was open beforehand.
    const candidates = session.context.pages().filter(page => !page.isClosed()
      && (!pagesBefore.has(page) || !existingBusinessPages.has(page)) && pageHostsBpm(page));
    if (candidates.length > 1) throw new FlowError('ambiguous_choice');
    bpmPage = candidates[0];
    if (!bpmPage) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!bpmPage) {
    throw new Error('BPM reimbursement page did not open.');
  }

  session.page = bpmPage;
  ctx.updatePage(bpmPage);
  await bpmPage.bringToFront().catch(() => undefined);
  return bpmPage;
}

export async function focusBestBusinessPage(
  session: BrowserSession,
  ctx: AutomationContext,
): Promise<Page> {
  const pages = session.context.pages();
  const available = pages.filter(page => !page.isClosed());
  // Inspect the page where the operation failed, including its active iframe.
  // Another, newer tab may be a different reimbursement or the egate workbench.
  const target = available.includes(ctx.page) ? ctx.page
    : [...available].reverse().find(pageHostsBpm)
      || available[available.length - 1];
  if (!target) {
    throw new Error('No browser page is available.');
  }

  session.page = target;
  if (ctx.page !== target) ctx.updatePage(target);
  await target.bringToFront().catch(() => undefined);
  return target;
}
