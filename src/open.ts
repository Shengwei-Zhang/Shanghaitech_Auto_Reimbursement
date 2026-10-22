import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { AutomationContext, createBrowserSession, closeBrowserSession, rememberAuthenticatedSession,
  type BrowserSession } from './automation/browser';
import { authenticateSchool } from './automation/auth';
import { buildReimbursementUrl, openReimbursementByIds, OpenReimbursementError,
  type OpenedReimbursement, type ReimbursementTarget } from './automation/open-reimbursement';
import { resolveListTarget, ReimbursementListError } from './automation/reimbursement-list';

const HELP = `用法：npm run oa:open -- --biz-id <32位ID> --task-id <UUID> [--read-only] [--document-number A单据编号]
   或：npm run oa:open -- --document-number A单据编号 [--read-only]
在独立浏览器中复用本机登录态，按两个 ID 打开旧报销单，核验页面单据编号及隐藏的 bizId/taskId。
只给单据编号时，登录后在 BPM“报销单查询”中按编号取得 bizId，再查询其申请环节任务取得 taskId。
默认请求 isReadOnly=false；--read-only 请求只读页面。不会填写、创建、保存或提交报销单。
浏览器自动提供 Cookie 等请求头。检查完成后按 Enter 关闭浏览器。`;

/** Either an explicit target, or a bill code to resolve through 报销单查询 after login. */
export function parseOpenArgs(args: string[]): { help: boolean; target?: ReimbursementTarget; resolve?: { documentNumber: string; isReadOnly: boolean } } {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, 'biz-id': { type: 'string' }, 'task-id': { type: 'string' },
    'read-only': { type: 'boolean' }, 'document-number': { type: 'string' },
  } });
  if (values.help) return { help: true };
  const isReadOnly = values['read-only'] ?? false;
  if (values['biz-id'] === undefined && values['task-id'] === undefined && values['document-number'] !== undefined) {
    if (!/^A\d{1,32}$/.test(values['document-number'])) throw new OpenReimbursementError('invalid_target');
    return { help: false, resolve: { documentNumber: values['document-number'], isReadOnly } };
  }
  const target: ReimbursementTarget = {
    bizId: values['biz-id'] || '', taskId: values['task-id'] || '',
    isReadOnly, expectedDocumentNumber: values['document-number'],
  };
  buildReimbursementUrl(target);
  return { help: false, target };
}

export function describeOpened(opened: OpenedReimbursement): string {
  const status = [opened.context.procInstStatusId && `流程 ${opened.context.procInstStatusId}`,
    opened.context.statusId && `任务 ${opened.context.statusId}`].filter(Boolean).join('，');
  return `已打开并识别报销单 ${opened.documentNumber}（请求${opened.isReadOnly ? '只读' : '办理'}页面`
    + `${opened.identityVerified ? '，页面隐藏的 bizId/taskId 与目标一致' : '，页面未提供隐藏 bizId/taskId，仅核对了地址和单号'}`
    + `${status ? `；状态：${status}` : ''}）。`;
}

/** 报销单查询 gives the bizId, its 申请 task the taskId; both are re-checked on the opened form. */
export async function targetFromList(session: BrowserSession, documentNumber: string,
  isReadOnly: boolean): Promise<ReimbursementTarget> {
  const found = await resolveListTarget(session, documentNumber, isReadOnly);
  console.log(`已从“报销单查询”找到单据 ${documentNumber}（状态：${found.row.statusText || found.row.status}），`
    + `并取得申请环节任务（${found.task.name || found.task.taskDefKey}，${found.task.statusId}）。`);
  return found.target;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { help, target: explicit, resolve } = parseOpenArgs(args);
  if (help) { console.log(HELP); return; }
  if (!process.stdin.isTTY) throw new Error('请在本机交互终端运行 npm run oa:open，以便查看打开的报销单。');
  dotenv.config();
  delete process.env.PLAYWRIGHT_CDP_ENDPOINT;
  delete process.env.CHROME_DEBUGGER_ADDRESS;
  process.env.HEADLESS = 'false';
  process.env.OA_LOGIN_MODE = 'manual';
  process.env.KEEP_BROWSER_OPEN = 'false';
  let session: BrowserSession | null = null;
  const controller = new AbortController();
  const stop = () => { controller.abort(); void session?.browser.close().catch(() => undefined); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    session = await createBrowserSession();
    session.browser.once('disconnected', () => controller.abort());
    if (controller.signal.aborted) return;
    session.page = await authenticateSchool(session.page, { mode: 'manual', reuseSession: session.restoredSession });
    const target = explicit ?? await targetFromList(session, resolve!.documentNumber, resolve!.isReadOnly);
    const ctx = new AutomationContext(session.page);
    const opened = await openReimbursementByIds(session, ctx, target);
    // Capture BPM cookies too, after the successful navigation/SSO round trip.
    await rememberAuthenticatedSession(session);
    console.log(describeOpened(opened));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('可以在浏览器中查看原单；按 Enter 结束并关闭独立浏览器。', { signal: controller.signal });
    } finally { rl.close(); }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeBrowserSession(session);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof OpenReimbursementError || error instanceof ReimbursementListError ? error.message
      : '打开报销单未完成。请在本机交互终端运行，检查参数、校园网络及登录状态；用 --help 查看用法。');
    process.exitCode = 1;
  });
}
