import type { ElementHandle, Frame, Page } from 'playwright';
import type { AutomationContext, RootTarget } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';

export function searchRoots(page: Page): RootTarget[] {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

export async function findFrameWithSelector(
  page: Page,
  selector: string,
  visibleOnly = true,
): Promise<Frame | null> {
  async function visit(frame: Frame): Promise<Frame | null> {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (!visibleOnly || await locator.nth(index).isVisible().catch(() => false)) {
        return frame;
      }
    }

    for (const child of frame.childFrames()) {
      const found = await visit(child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  return visit(page.mainFrame());
}

export async function activateFrameForSelector(
  ctx: AutomationContext,
  selector: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RootTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await findFrameWithSelector(ctx.page, selector);
    if (frame) {
      ctx.setActiveFrame(frame === ctx.page.mainFrame() ? null : frame);
      return ctx.root();
    }
    await ctx.page.waitForTimeout(200);
  }
  throw new Error(`Timeout waiting for business selector: ${selector}`);
}

export async function waitForNoBlockingMask(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ctx.root().waitForFunction(() => {
    function visible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0;
    }

    return Array.from(document.querySelectorAll(
      '#ldg_lockmask, .lockmask, .ui-widget-overlay, .modal-backdrop, .l-window-mask',
    )).every((element) => !visible(element));
  }, undefined, { timeout: timeoutMs });
}

export async function visibleElementText(element: ElementHandle<Element>): Promise<string> {
  return element.evaluate((node) => (node.textContent || '').replace(/\s+/g, ' ').trim());
}

