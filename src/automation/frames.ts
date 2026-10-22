import { DEFAULT_TIMEOUT_MS } from './config';
import type { AutomationContext } from './browser';
import { activateFrameForSelector, findFrameWithSelector } from './dom';

export async function resolveFrameForSelector(ctx: AutomationContext, selector: string): Promise<void> {
  const frame = await findFrameWithSelector(ctx.page, selector);
  ctx.setActiveFrame(frame && frame !== ctx.page.mainFrame() ? frame : null);
}

export async function switchToRecordedFrameOrElementContext(
  ctx: AutomationContext,
  selector: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await activateFrameForSelector(ctx, selector, timeoutMs);
}

export async function waitForDisplayed(
  ctx: AutomationContext,
  selector: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await switchToRecordedFrameOrElementContext(ctx, selector, timeoutMs);
}
