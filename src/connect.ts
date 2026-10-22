import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { createBrowserSession, closeBrowserSession, rememberAuthenticatedSession } from './automation/browser';
import { authenticateSchool, isEgateLoggedIn, egateWorkbenchUrl } from './automation/auth';
import { DEFAULT_TIMEOUT_MS } from './automation/config';

/** First real-site session: authenticate and inspect the workbench, without creating or editing forms. */
async function main(): Promise<void> {
  dotenv.config();
  if (!process.stdin.isTTY) throw new Error('请在本机交互终端运行 npm run oa:connect。');
  // Use an independent local browser, optionally restoring the dedicated OA state.
  delete process.env.PLAYWRIGHT_CDP_ENDPOINT;
  delete process.env.CHROME_DEBUGGER_ADDRESS;
  process.env.HEADLESS = 'false';
  process.env.OA_LOGIN_MODE = 'manual';
  process.env.KEEP_BROWSER_OPEN = 'false';
  const session = await createBrowserSession();
  const controller = new AbortController();
  session.browser.once('disconnected', () => controller.abort());
  const close = () => { controller.abort(); void closeBrowserSession(session).catch(() => undefined); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    session.page = await authenticateSchool(session.page, { mode: 'manual', reuseSession: session.restoredSession });
    await rememberAuthenticatedSession(session);
    await session.page.goto(egateWorkbenchUrl(session.page.url()), { waitUntil: 'domcontentloaded' });
    let searchFound = false;
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (!controller.signal.aborted && Date.now() < deadline && !searchFound) {
      for (const frame of session.page.frames()) {
        if (await frame.getByPlaceholder(/事项名称/).first().isVisible().catch(() => false)) searchFound = true;
      }
      if (!searchFound) await session.page.waitForTimeout(250);
    }
    if (!await isEgateLoggedIn(session.page)) throw new Error('School authentication expired.');
    console.log(searchFound ? '学校 SSO 登录已完成，已识别工作台事项搜索入口。' : '学校 SSO 登录已完成，但尚未核实工作台事项搜索入口，需要对当前页面校准定位器。');
    console.log('本连接命令只检查登录和工作台，不创建或修改报销单。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { await rl.question('可以在浏览器中检查页面；按 Enter 结束本次连接并关闭独立浏览器。', { signal: controller.signal }); }
    finally { rl.close(); }
  } finally {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    await closeBrowserSession(session);
  }
}
main().catch(() => { console.error('学校 OA 连接未完成。请检查校园网络/VPN、浏览器及登录状态后重试。'); process.exitCode = 1; });
