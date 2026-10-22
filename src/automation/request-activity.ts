import type { Page, Request, Response } from 'playwright';

/** Transport activity only, never a business-success receipt. No bodies or
 * URLs are retained. Install before the action to observe its requests. */
export function watchRequestActivity(page: Page, matches: (request: Request) => boolean = () => true) {
  const pending = new Set<Request>();
  let started = 0, failed = false, lastChange = Date.now();
  const request = (req: Request) => {
    if (!['xhr', 'fetch', 'document'].includes(req.resourceType()) || !matches(req)) return;
    pending.add(req); started++; lastChange = Date.now();
  };
  const response = (res: Response) => {
    if (pending.has(res.request()) && res.status() >= 400) failed = true;
  };
  const finished = (req: Request) => { if (pending.delete(req)) lastChange = Date.now(); };
  const rejected = (req: Request) => { if (pending.has(req)) failed = true; finished(req); };
  page.on('request', request); page.on('response', response);
  page.on('requestfinished', finished); page.on('requestfailed', rejected);
  return {
    snapshot: () => ({ pending: pending.size, started, failed, quietMs: Date.now() - lastChange }),
    dispose: () => {
      page.off('request', request); page.off('response', response);
      page.off('requestfinished', finished); page.off('requestfailed', rejected);
    },
  };
}

export async function waitForRequestQuiet(page: Page, activity: ReturnType<typeof watchRequestActivity>,
  timeout: number, quietMs = 750, requireStarted = false): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = activity.snapshot();
    if (state.failed) throw new Error('Observed request failed');
    if ((!requireStarted || state.started > 0) && !state.pending && state.quietMs >= quietMs) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Observed requests did not settle');
}
