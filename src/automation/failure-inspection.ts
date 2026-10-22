import type { BrowserSession } from './browser';

/** Hold the failed session for inspection only; never resume or repeat an action. */
export function waitForFailureInspection(session: BrowserSession, signal: AbortSignal,
  timeoutMs = 5 * 60_000): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      session.browser.off('disconnected', done);
      session.context.off('close', done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    signal.addEventListener('abort', done, { once: true });
    session.browser.once('disconnected', done);
    session.context.once('close', done);
    if (signal.aborted || !session.browser.isConnected() || !session.context.pages().length) done();
  });
}
