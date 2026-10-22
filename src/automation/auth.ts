import type { Page, Frame, Locator } from 'playwright';
import { DEFAULT_TIMEOUT_MS } from './config';
import { FlowError } from '../domain/workflow';

export const LOGIN_URL = 'https://ids.shanghaitech.edu.cn/authserver/login?service=https%3A%2F%2Fegate-new.shanghaitech.edu.cn%2Flogin';
export function hasHost(value: string, host: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === host; } catch { return false; }
}

const LOGIN_TIMEOUT_PATTERN = /登[录陆](?:已)?(?:超时|失效|过期)|(?:请|需要)重新登[录陆]|(?:会话|认证)(?:已)?(?:超时|失效|过期)/;

export function isEgateShellUrl(value: string): boolean {
  if (!hasHost(value, 'egate-new.shanghaitech.edu.cn')) return false;
  // Official portal path supplied by the user's task-search request.
  if (new URL(value).pathname === '/CUS_TEMPLATE_OFFICIAL/pc/index.html') return true;
  const theme = new URL(value).pathname.match(/^\/([a-z][a-z0-9_-]*)\/index\.html$/)?.[1];
  // Theme names are presentation choices, not authentication states. This is
  // only a shell URL candidate; isEgateLoggedIn also checks actual portal UI.
  return Boolean(theme && !/^(?:login|auth|authserver|cas|sso|oauth|callback)$/.test(theme));
}

export function egateWorkbenchUrl(currentUrl: string): string {
  const target = new URL(isEgateShellUrl(currentUrl) ? currentUrl
    : 'https://egate-new.shanghaitech.edu.cn/green/index.html');
  target.search = '';
  target.hash = '/work';
  return target.href;
}

export function egateTaskListUrl(currentUrl: string): string {
  const target = new URL(egateWorkbenchUrl(currentUrl));
  target.hash = '/taskList?cardName=todo';
  return target.href;
}

type PortalProbe = { login: boolean; portal: boolean; failed?: boolean };
const pendingPortalProbes = new WeakMap<Page | Frame, Promise<PortalProbe>>();
const LOGIN_CONTROLS = '#password, input[type="password"], #login_submit';
const authProgress = (evidence: string) => process.send?.({ type: 'stage', stage: 'authenticate', state: 'started', evidence });

async function probePortalRoot(root: Page | Frame, timeout: number): Promise<PortalProbe | null> {
  let pending = pendingPortalProbes.get(root);
  if (!pending) {
    pending = (async () => {
      const visible = async (locator: Locator) => await locator.filter({ visible: true }).count() > 0;
      const [login, search, namedSearch, workbench, services] = await Promise.all([
        visible(root.locator(LOGIN_CONTROLS)),
        visible(root.getByPlaceholder(/事\s*项\s*名\s*称/)),
        visible(root.getByRole('textbox', { name: /事\s*项\s*名\s*称/ })),
        visible(root.getByText('工作台', { exact: true })),
        visible(root.getByText('办事大厅', { exact: true })),
      ]);
      return { login, portal: search || namedSearch || (workbench && services) };
    })().catch(() => ({ login: false, portal: false, failed: true }));
    pendingPortalProbes.set(root, pending);
    void pending.finally(() => pendingPortalProbes.delete(root));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
  } finally { clearTimeout(timer); }
}

export async function inspectEgateLogin(page: Page, timeout = 500): Promise<{
  loggedIn: boolean; reason: string; pending: number; failed: number;
}> {
  const url = page.url();
  if (!isEgateShellUrl(url)) return { loggedIn: false, reason: '尚未到达门户主题页面', pending: 0, failed: 0 };
  // Page and its main frame represent the same DOM; do not probe it twice.
  const roots = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
  const probes = await Promise.all(roots.map(root => probePortalRoot(root, timeout)));
  const login = probes.some(probe => probe?.login);
  const portal = probes.some(probe => probe?.portal);
  const pending = probes.filter(probe => !probe).length;
  const failed = probes.filter(probe => probe?.failed).length;
  return { loggedIn: portal && !login, pending, failed,
    reason: login ? '仍有可见的密码框或登录按钮' : portal ? '门户控件已就绪'
      : pending ? '部分页面框架未响应' : failed ? '读取页面控件失败' : '尚未检测到可见的事项搜索或工作台导航' };
}

export async function isEgateLoggedIn(page: Page): Promise<boolean> {
  return (await inspectEgateLogin(page)).loggedIn;
}

export async function waitForLoginOrEgateState(
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<'egate' | 'login'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isEgateLoggedIn(page)) {
      return 'egate';
    }

    const roots = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
    const states = await Promise.all(roots.map(root => probePortalRoot(root, Math.min(500, Math.max(1, deadline - Date.now())))));
    if (states.some(state => state?.login)) return 'login';

    await page.waitForTimeout(250);
  }

  return await isEgateLoggedIn(page) ? 'egate' : 'login';
}

export async function isLoginTimeoutPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('authserver/login') || url.includes('/login')) {
    return true;
  }

  // A delayed session-expiry popup can be in the BPM iframe. Only visible
  // text counts: hidden dialog templates and generic errors are not expiry.
  for (const root of [page, ...page.frames().filter(frame => frame !== page.mainFrame())]) {
    if (await root.getByText(LOGIN_TIMEOUT_PATTERN).filter({ visible: true }).count().catch(() => 0)) return true;
  }
  return false;
}

export async function assertNotLoginTimeout(page: Page, _stepLabel = 'current page'): Promise<void> {
  if (await isLoginTimeoutPage(page)) {
    throw new FlowError('authentication');
  }
}

/** SSO/scan-code login can leave the original tab open and open egate in another tab. */
export async function waitForEgateAfterLogin(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Page> {
  const context = page.context();
  const deadline = Date.now() + timeoutMs;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const pages = context.pages().filter(candidate => !candidate.isClosed());
    if (!pages.length) throw new FlowError('authentication');
    const states = await Promise.all(pages.map(async candidate => ({ page: candidate,
      state: await inspectEgateLogin(candidate, Math.min(500, Math.max(1, deadline - Date.now()))) })));
    const original = states.find(item => item.page === page && item.state.loggedIn);
    if (original) return original.page;
    const authenticated = states.filter(item => item.state.loggedIn);
    if (authenticated.length > 1) throw new FlowError('ambiguous_choice');
    if (authenticated.length === 1) return authenticated[0].page;
    if (Date.now() - lastProgress >= 10000) {
      authProgress(`等待门户认证检测：${states.map((item, i) => `标签页 ${i + 1}：${item.state.reason}（未响应 ${item.state.pending}，读取失败 ${item.state.failed}）`).join('；')}。尚未进入搜索。`);
      lastProgress = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new FlowError('authentication');
}

/** Manual login supports the school's normal password, scan-code and MFA paths. */
export async function authenticateSchool(page: Page, options: {
  mode: 'manual' | 'credentials'; username?: string; password?: string; timeoutMs?: number; reuseSession?: boolean;
}): Promise<Page> {
  const timeout = options.timeoutMs ?? 5 * 60_000;
  if (options.reuseSession && options.mode === 'manual') {
    authProgress('正在验证本机保存的学校登录会话。');
    await page.goto(egateWorkbenchUrl(page.url()), { waitUntil: 'commit', timeout: DEFAULT_TIMEOUT_MS });
    if (await waitForLoginOrEgateState(page) === 'egate') {
      authProgress('已验证并复用学校登录会话，继续办理。');
      return page;
    }
    authProgress('保存的登录会话已失效，返回学校页面重新登录。');
  }
  authProgress('正在打开学校认证入口；检测版本：可见控件并行探测 v2。');
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: DEFAULT_TIMEOUT_MS });
  authProgress('认证入口已响应，正在检查登录表单或已登录门户。');
  if (options.mode === 'manual') {
    console.log('请在打开的学校认证页面完成登录；工作台等待最多 5 分钟，登录成功后自动继续。');
    await page.bringToFront();
    return waitForEgateAfterLogin(page, timeout);
  }
  const state = await waitForLoginOrEgateState(page);
  if (state === 'egate') return page;
  if (!hasHost(page.url(), 'ids.shanghaitech.edu.cn') || !options.username || !options.password) {
    throw new FlowError('authentication');
  }
  authProgress('学校登录表单已就绪，正在填写本次凭据。');
  await page.locator('#username').fill(options.username);
  await page.locator('#password').fill(options.password);
  authProgress('正在点击学校登录按钮；点击后检查门户，不等待整页资源加载。');
  await page.locator('#login_submit').click({ noWaitAfter: true, timeout: DEFAULT_TIMEOUT_MS });
  authProgress('登录按钮点击已返回，正在检测门户及新标签页。');
  return waitForEgateAfterLogin(page, timeout);
}

export async function waitForBpmPageReady(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new FlowError('control_missing');
    await assertNotLoginTimeout(page);
    if (hasHost(page.url(), 'ids.shanghaitech.edu.cn')) throw new FlowError('authentication');
    if (hasHost(page.url(), 'sapbpm-new.shanghaitech.edu.cn')) {
      const create = page.getByRole('link').filter({ hasText: /^\s*用款申请单\s/ })
        .getByRole('button', { name: /创建/ }).filter({ visible: true });
      const count = await create.count();
      if (count > 1) throw new FlowError('ambiguous_choice');
      if (count === 1) {
        try { await create.click({ trial: true, timeout: 300 }); return; }
        catch { /* Still covered by a mask or waiting for application data. */ }
      }
    }
    await page.waitForTimeout(100);
  }
  throw new FlowError('control_missing');
}
