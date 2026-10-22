import type { Frame, Page } from 'playwright';
import type { AutomationContext, BrowserSession } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { isLoginTimeoutPage } from './auth';
import { readFormContext, type ReimbursementFormContext } from './reimbursement-context';

export const REIMBURSEMENT_ORIGIN = 'https://sapbpm-new.shanghaitech.edu.cn:9091';
export const REIMBURSEMENT_PATH = '/bpm-new/rbReimbursement/showLoadRbReimbursement.job';
const CAS_LOGIN_URL = 'https://ids.shanghaitech.edu.cn/authserver/login';

export interface ReimbursementTarget {
  bizId: string;
  taskId: string;
  isReadOnly?: boolean;
  expectedDocumentNumber?: string;
}

const messages = {
  invalid_target: '请提供有效的 bizId（32 位十六进制）和 taskId（UUID），可选单据编号格式为 A 加数字。',
  authentication: '报销系统登录已失效；一次 SSO 恢复后仍未进入原单，请在学校页面重新登录后重试。',
  forbidden: '报销系统拒绝访问此任务，请核对当前账号的办理权限及 taskId 是否仍有效。',
  request_failed: '报销单页面请求未完成，请检查校园网络及浏览器状态。',
  wrong_target: '返回地址与指定报销单不一致，已停止打开流程。',
  document_mismatch: '页面单据编号与预期不一致，已停止打开流程。',
  ambiguous_form: '页面包含多个报销单，无法唯一核验目标单据。',
  form_unavailable: '页面未显示可核验的报销单编号和表单字段，请核对 bizId、taskId 及当前任务状态。',
} as const;

export interface OpenedReimbursement {
  page: Page;
  documentNumber: string;
  isReadOnly: boolean;
  /** Read from the loaded editor; supplies accountBook/reimbursementKind for queries. */
  context: ReimbursementFormContext;
  /** True when the page's own hidden bizId and taskId both matched the request. */
  identityVerified: boolean;
}

export class OpenReimbursementError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'OpenReimbursementError';
  }
}

/** Only construct the observed school endpoint; never accept arbitrary URLs or headers. */
export function buildReimbursementUrl(target: ReimbursementTarget): string {
  if (!target || typeof target.bizId !== 'string' || !/^[\da-f]{32}$/i.test(target.bizId)
    || typeof target.taskId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(target.taskId)
    || (target.isReadOnly !== undefined && typeof target.isReadOnly !== 'boolean')
    || (target.expectedDocumentNumber !== undefined
      && (typeof target.expectedDocumentNumber !== 'string' || !/^[AD]\d{1,32}$/.test(target.expectedDocumentNumber)))) {
    throw new OpenReimbursementError('invalid_target');
  }
  const url = new URL(REIMBURSEMENT_PATH, REIMBURSEMENT_ORIGIN);
  url.searchParams.set('isReadOnly', String(target.isReadOnly ?? false));
  url.searchParams.set('bizId', target.bizId);
  url.searchParams.set('taskId', target.taskId);
  return url.href;
}

function assertTargetUrl(current: string, expected: string): void {
  const url = new URL(current);
  const target = new URL(expected);
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password
    || ['bizId', 'taskId', 'isReadOnly'].some(key => url.searchParams.getAll(key).length !== 1
      || url.searchParams.get(key) !== target.searchParams.get(key))) {
    throw new OpenReimbursementError('wrong_target');
  }
}

/** The editor's hidden job fields identify the loaded document independently of
 * the URL. Absent fields are tolerated; present ones must agree with the target. */
function assertFormIdentity(context: ReimbursementFormContext, target: ReimbursementTarget, documentNumber: string): void {
  if ((context.bizId && context.bizId.toLowerCase() !== target.bizId.toLowerCase())
    || (context.taskId && context.taskId.toLowerCase() !== target.taskId.toLowerCase())) {
    throw new OpenReimbursementError('wrong_target');
  }
  if (context.documentNumber && context.documentNumber !== documentNumber) throw new OpenReimbursementError('ambiguous_form');
}

async function waitForReimbursement(page: Page, target: ReimbursementTarget, url: string, timeout: number)
  : Promise<{ frame: Frame; documentNumber: string; context: ReimbursementFormContext }> {
  const deadline = Date.now() + timeout;
  do {
    if (page.isClosed()) throw new OpenReimbursementError('request_failed');
    if (await isLoginTimeoutPage(page)) throw new OpenReimbursementError('authentication');
    assertTargetUrl(page.url(), url);
    const forms: Array<{ frame: Frame; documentNumber: string }> = [];
    for (const frame of page.frames()) {
      // Only inspect school BPM documents; iframe content from elsewhere is not evidence.
      if (!frame.url().startsWith(`${REIMBURSEMENT_ORIGIN}/`)) continue;
      const state = await frame.evaluate(() => {
        const text = document.body?.innerText || '';
        const numbers = [...new Set(Array.from(text.matchAll(/单据编号\s*[:：]?\s*(A\d+)\b/g), match => match[1]))];
        const hasForm = Array.from(document.querySelectorAll(
          '#invoiceGrid, #actualTotalAmount, #reimbursementReimbursementAmount',
        )).some(element => {
          const style = getComputedStyle(element);
          return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        return { numbers, hasForm };
      }).catch(() => null);
      if (!state?.hasForm || !state.numbers.length) continue;
      if (state.numbers.length > 1) throw new OpenReimbursementError('ambiguous_form');
      forms.push({ frame, documentNumber: state.numbers[0] });
    }
    if (forms.length > 1) throw new OpenReimbursementError('ambiguous_form');
    if (forms.length === 1) {
      const context = await readFormContext(forms[0].frame).catch(() => null);
      if (!context) {
        await page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
        continue;
      }
      // Recheck after DOM reads, since navigation can race with inspection.
      if (await isLoginTimeoutPage(page)) throw new OpenReimbursementError('authentication');
      assertTargetUrl(page.url(), url);
      assertFormIdentity(context, target, forms[0].documentNumber);
      if (target.expectedDocumentNumber && forms[0].documentNumber !== target.expectedDocumentNumber) {
        throw new OpenReimbursementError('document_mismatch');
      }
      return { ...forms[0], context };
    }
    await page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new OpenReimbursementError('form_unavailable');
}

/** Open an existing form in a fresh tab of the authenticated context. No edit/create/save calls. */
export async function openReimbursementByIds(
  session: BrowserSession,
  ctx: AutomationContext,
  target: ReimbursementTarget,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<OpenedReimbursement> {
  const url = buildReimbursementUrl(target); // Reject bad inputs before opening a tab.
  if (!Number.isFinite(timeout) || timeout <= 0) throw new OpenReimbursementError('invalid_target');
  try {
    const page = await session.context.newPage();
    session.page = page;
    ctx.updatePage(page);
    await page.bringToFront();
    const navigate = async (destination: string) => {
      const response = await page.goto(destination, { waitUntil: 'domcontentloaded', timeout });
      if (response?.status() === 401) throw new OpenReimbursementError('authentication');
      if (response?.status() === 403) throw new OpenReimbursementError('forbidden');
      if (response && response.status() >= 400) throw new OpenReimbursementError('request_failed');
    };
    let form;
    try {
      await navigate(url);
      form = await waitForReimbursement(page, target, url, timeout);
    } catch (error) {
      if (!(error instanceof OpenReimbursementError) || error.code !== 'authentication') throw error;
      // egate and BPM have separate cookies. Reuse the existing CAS session once,
      // with the exact original form as service, just as the owner-query entry does.
      const sso = new URL(CAS_LOGIN_URL);
      sso.searchParams.set('service', url);
      await navigate(sso.href);
      form = await waitForReimbursement(page, target, url, timeout);
    }
    ctx.setActiveFrame(form.frame === page.mainFrame() ? null : form.frame);
    ctx.state.openedFromTodo = true;
    return { page, documentNumber: form.documentNumber, isReadOnly: target.isReadOnly ?? false,
      context: form.context, identityVerified: Boolean(form.context.bizId && form.context.taskId) };
  } catch (error) {
    if (error instanceof OpenReimbursementError) throw error;
    // Playwright errors can contain request URLs and SSO tickets.
    throw new OpenReimbursementError('request_failed');
  }
}
