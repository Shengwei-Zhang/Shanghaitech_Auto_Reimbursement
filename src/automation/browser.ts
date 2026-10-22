import { existsSync } from 'fs';
import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import { getEnvValue, isEnvTrue } from './config';
import { FlowError } from '../domain/workflow';
import { loadSessionState, saveSessionState, sessionStatePath } from './session-state';
import { attachNetworkCapture } from './network-capture';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sessionStateFile?: string;
  restoredSession?: boolean;
  authenticationVerified?: boolean;
}

export async function createBrowserSession(): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  // Explicit credentials can belong to a different account. Never mix that
  // login with the remembered account used by manual/scan-code login.
  const sessionStateFile = getEnvValue('OA_LOGIN_MODE') === 'credentials' ? undefined : sessionStatePath();

  const chromeDebuggerAddress = getEnvValue('CHROME_DEBUGGER_ADDRESS');
  const playwrightCdpEndpoint = getEnvValue('PLAYWRIGHT_CDP_ENDPOINT');
  if (chromeDebuggerAddress || playwrightCdpEndpoint) {
    const endpoint = playwrightCdpEndpoint || `http://${chromeDebuggerAddress}`;
    console.log(`Browser mode: attaching over CDP (${endpoint}).`);
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? await browser.newContext({
      viewport: null,
    });
    const page = context.pages()[0] ?? await context.newPage();
    return { browser, context, page, sessionStateFile };
  }

  const systemChromePath = getEnvValue('PLAYWRIGHT_EXECUTABLE_PATH')
    || getEnvValue('CHROME_EXECUTABLE_PATH')
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = existsSync(systemChromePath) ? systemChromePath : undefined;
  console.log(
    executablePath
      ? `Browser mode: launching system Chrome with a fresh Playwright profile (${executablePath}).`
      : 'Browser mode: launching bundled Playwright Chromium.',
  );
  const browser = await chromium.launch({
    headless: isEnvTrue('HEADLESS'),
    executablePath,
    args: ['--disable-dev-shm-usage'],
  });

  try {
    const storageState = sessionStateFile ? await loadSessionState(sessionStateFile) : undefined;
    const context = await browser.newContext({
      storageState,
      // In headed OA sessions, resizing the real window must resize the page
      // viewport so the school's tables/iframe layout can recompute their height.
      viewport: isEnvTrue('HEADLESS') ? { width: 1440, height: 1000 } : null,
    });
    context.setDefaultTimeout(Number(getEnvValue('PLAYWRIGHT_TIMEOUT_MS') || 20000));
    context.setDefaultNavigationTimeout(Number(getEnvValue('PLAYWRIGHT_TIMEOUT_MS') || 20000));
    const captureFile = getEnvValue('OA_NETWORK_CAPTURE_FILE');
    if (captureFile) attachNetworkCapture(context, captureFile);
    const page = await context.newPage();

    return { browser, context, page, sessionStateFile, restoredSession: Boolean(storageState) };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** Call only after the actual school portal has confirmed authentication. */
export async function rememberAuthenticatedSession(session: BrowserSession): Promise<void> {
  session.authenticationVerified = true;
  if (session.sessionStateFile && await saveSessionState(session.context, session.sessionStateFile)) {
    console.log('学校登录会话已保存到本机，下次会先验证并复用。');
  }
}

export async function closeBrowserSession(session: BrowserSession | null): Promise<void> {
  if (!session) {
    return;
  }

  if (session.sessionStateFile && session.authenticationVerified && session.browser.isConnected()) {
    await saveSessionState(session.context, session.sessionStateFile);
  }

  if (isEnvTrue('KEEP_BROWSER_OPEN')) {
    console.log('KEEP_BROWSER_OPEN=true, browser session left open for debugging.');
    return;
  }

  await session.browser.close();
}

export async function attachToExistingBusinessPage(
  session: BrowserSession,
  options: { sapbpmOnly?: boolean } = {},
): Promise<boolean> {
  const candidates = session.context.pages().filter(page => !page.isClosed());
  const bpm = candidates.filter(page => businessPageHost(page) === 'sapbpm-new.shanghaitech.edu.cn');
  const egate = candidates.filter(page => businessPageHost(page) === 'egate-new.shanghaitech.edu.cn');
  // Titles and complete URLs may contain financial data or SSO tickets.
  console.log(`OA resume candidates: BPM=${bpm.length}, egate=${egate.length}.`);
  const selected = bpm.length ? bpm : options.sapbpmOnly ? [] : egate;
  if (selected.length > 1) throw new FlowError('resume_page_ambiguous');
  const page = selected[0];
  if (!page) return false;

  const expectedHost = businessPageHost(page);
  await page.bringToFront();
  if (page.isClosed() || businessPageHost(page) !== expectedHost) {
    throw new FlowError('resume_page_missing');
  }
  session.page = page;
  console.log(`Attached to the unique ${bpm.length ? 'BPM' : 'egate'} tab.`);
  return true;
}

function businessPageHost(page: Page): string {
  try {
    const url = new URL(page.url());
    return ['https:', 'http:'].includes(url.protocol) ? url.hostname : '';
  } catch {
    return '';
  }
}

export async function switchToExistingBusinessPage(session: BrowserSession, startFromStep: string): Promise<string> {
  if (!startFromStep) {
    return startFromStep;
  }

  console.log(`START_FROM is set to "${startFromStep}". Looking for an existing OA business tab...`);
  const attached = await attachToExistingBusinessPage(session);

  if (!attached) {
    throw new FlowError('resume_page_missing');
  }

  return startFromStep;
}

export type RootTarget = Page | Frame;

export interface AutomationRunState {
  entryAttempted: boolean;
  backupEntryAttempted: boolean;
  creationAttempted: boolean;
  creationCompleted: boolean;
  submissionPrepareAttempted: boolean;
  submissionFinalAttempted: boolean;
  stage: string;
  openedFromTodo: boolean;
  invoicePath: string;
  invoiceUploadAttempted: boolean;
  invoiceNumber: string;
  pickerRowCountBefore: number;
  recentResponses: Array<{ status: number; url: string }>;
}

export class AutomationContext {
  activeFrame: Frame | null = null;
  private readonly observedPages = new WeakSet<Page>();
  readonly state: AutomationRunState = {
    entryAttempted: false,
    backupEntryAttempted: false,
    creationAttempted: false,
    creationCompleted: false,
    submissionPrepareAttempted: false,
    submissionFinalAttempted: false,
    stage: 'initializing',
    openedFromTodo: false,
    invoicePath: '',
    invoiceUploadAttempted: false,
    invoiceNumber: '',
    pickerRowCountBefore: -1,
    recentResponses: [],
  };

  constructor(public page: Page) {
    this.observePage(page);
  }

  updatePage(page: Page): void {
    this.page = page;
    this.activeFrame = null;
    this.observePage(page);
  }

  root(): RootTarget {
    return this.activeFrame ?? this.page;
  }

  setActiveFrame(frame: Frame | null): void {
    this.activeFrame = frame;
  }

  setStage(stage: string): void {
    this.state.stage = stage;
  }

  activeFrameUrl(): string {
    return this.activeFrame?.url() || '';
  }

  private observePage(page: Page): void {
    if (this.observedPages.has(page)) {
      return;
    }
    this.observedPages.add(page);
    page.on('response', (response) => {
      if (!/upload|invoice|attach|file|reimbursement/i.test(response.url())) {
        return;
      }
      this.state.recentResponses.push({
        status: response.status(),
        url: response.url(),
      });
      this.state.recentResponses.splice(0, Math.max(0, this.state.recentResponses.length - 20));
    });
  }

  locator(selector: string) {
    return this.root().locator(selector);
  }

  getByRole(...args: Parameters<Page['getByRole']>) {
    return this.root().getByRole(...args);
  }

  getByPlaceholder(...args: Parameters<Page['getByPlaceholder']>) {
    return this.root().getByPlaceholder(...args);
  }

  getByLabel(...args: Parameters<Page['getByLabel']>) {
    return this.root().getByLabel(...args);
  }

  getByText(...args: Parameters<Page['getByText']>) {
    return this.root().getByText(...args);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    this.activeFrame = null;
  }
}
