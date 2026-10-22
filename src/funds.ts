import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AutomationContext, createBrowserSession, closeBrowserSession, rememberAuthenticatedSession,
  type BrowserSession } from './automation/browser';
import { authenticateSchool } from './automation/auth';
import { buildReimbursementUrl, openReimbursementByIds, OpenReimbursementError,
  type ReimbursementTarget } from './automation/open-reimbursement';
import { buildFundingSearchPayload, findFundingItem, searchFundingItems, FundingSearchError, FUNDING_KINDS,
  type FundingSearchOptions, type FundingSearchResponse } from './automation/funding-search';
import { ReimbursementListError } from './automation/reimbursement-list';
import { targetFromList } from './open';

const HELP = `用法：npm run oa:funds -- (--document-number A单据编号 | --biz-id <32位ID> --task-id <UUID>)
可选：--kind authorized|responsible（被授权的项目，默认 / 我负责的项目）
      --param-value 关键字（对话框“关键字”框，默认空即全部）--account-book --page-size 8
      --keyword 项目关键词（在返回列表中唯一匹配，输出可用于 oa:budgets 的经费编号）
经费列表须在已打开的报销单内查询：登录后打开原单，读取 csrfToken、procTaskId 和账套，
发送与“选择项目”对话框相同的 POST /bpm-new/easySearch.load。只给单据编号时从“报销单查询”及申请环节任务取得原单 ID。
响应私有保存到 data/oa-funding-search；不点击项目行、不选择经费或保存报销单。`;

export interface FundingRequest {
  query: FundingSearchOptions;
  keyword?: string;
  target?: ReimbursementTarget;
  documentNumber?: string;
}

/** allowDirect: no form identifiers is valid (the HTTP command queries with the BPM session alone). */
export function parseFundingArgs(args: string[], allowDirect = false): { help: boolean } & Partial<FundingRequest> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, keyword: { type: 'string' }, kind: { type: 'string' },
    'param-value': { type: 'string' }, 'account-book': { type: 'string' }, 'page-size': { type: 'string' },
    'biz-id': { type: 'string' }, 'task-id': { type: 'string' }, 'document-number': { type: 'string' },
  } });
  if (values.help) return { help: true };
  const pageSize = values['page-size'];
  if (pageSize !== undefined && !/^[1-9]\d*$/.test(pageSize)) throw new FundingSearchError('invalid_query');
  if (values.kind !== undefined && !Object.hasOwn(FUNDING_KINDS, values.kind)) throw new FundingSearchError('invalid_query');
  const query: FundingSearchOptions = {
    ...(values.kind ? { kind: values.kind as keyof typeof FUNDING_KINDS } : {}),
    ...(values['param-value'] !== undefined ? { paramValue: values['param-value'] } : {}),
    ...(values['account-book'] !== undefined ? { accountBook: values['account-book'] } : {}),
    ...(pageSize ? { pageSize: Number(pageSize) } : {}),
  };
  buildFundingSearchPayload(query);
  const keyword = values.keyword?.trim();
  if (keyword !== undefined && (!keyword || keyword.length > 100 || /[\u0000-\u001f]/.test(keyword))) {
    throw new FundingSearchError('invalid_query');
  }
  const extra = keyword ? { keyword } : {};
  if (values['biz-id'] === undefined && values['task-id'] === undefined) {
    if (allowDirect && values['document-number'] === undefined) return { help: false, query, ...extra };
    if (!/^A\d{1,32}$/.test(values['document-number'] ?? '')) throw new OpenReimbursementError('invalid_target');
    return { help: false, query, ...extra, documentNumber: values['document-number'] };
  }
  const target: ReimbursementTarget = { bizId: values['biz-id'] || '', taskId: values['task-id'] || '',
    isReadOnly: false, expectedDocumentNumber: values['document-number'] };
  buildReimbursementUrl(target);
  return { help: false, query, ...extra, target };
}

export async function saveFundingResponse(result: FundingSearchResponse, dataDir: string): Promise<string> {
  const directory = path.resolve(dataDir, 'oa-funding-search');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Invalid output directory');
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return file;
}

export function describeFundingList(result: FundingSearchResponse): string {
  const { items, dataCount, pageCount, skipped } = result.list;
  return `已解析经费表格：${items.length} 个项目${dataCount === undefined ? '' : `（页面声明共 ${dataCount} 条`}`
    + `${pageCount === undefined ? '' : `、${pageCount} 页`}${dataCount === undefined ? '' : '）'}`
    + `${skipped ? `；${skipped} 行编号格式异常已忽略` : ''}。`
    + `${pageCount !== undefined && pageCount > 1 ? '仅解析了返回的第一页。' : ''}`;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { help, query, keyword, target: explicit, documentNumber } = parseFundingArgs(args);
  if (help) { console.log(HELP); return; }
  dotenv.config();
  delete process.env.PLAYWRIGHT_CDP_ENDPOINT;
  delete process.env.CHROME_DEBUGGER_ADDRESS;
  process.env.HEADLESS = 'false';
  process.env.OA_LOGIN_MODE = 'manual';
  process.env.KEEP_BROWSER_OPEN = 'false';
  let session: BrowserSession | null = null;
  let stopped = false;
  const stop = () => { stopped = true; void session?.browser.close().catch(() => undefined); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    session = await createBrowserSession();
    if (stopped) throw new FundingSearchError('request_failed');
    session.page = await authenticateSchool(session.page, { mode: 'manual', reuseSession: session.restoredSession });
    const target = explicit ?? await targetFromList(session, documentNumber!, false);
    const ctx = new AutomationContext(session.page);
    await openReimbursementByIds(session, ctx, target);
    await rememberAuthenticatedSession(session);
    const result = await searchFundingItems(ctx, query);
    const file = await saveFundingResponse(result, process.env.OA_DATA_DIR || 'data');
    console.log(`已收到经费列表（HTTP ${result.httpStatus}，账套 ${result.query.accountBook}，`
      + `fundingItemKind=${result.query.fundingItemKind}），已保存：${file}`);
    console.log(describeFundingList(result));
    if (keyword) {
      const item = findFundingItem(result.list, keyword);
      console.log(`关键词唯一匹配：经费编号 ${item.projectId}（${item.label || item.projectName}）。`);
    }
    console.log('此结果不代表经费余额或已选定项目。');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeBrowserSession(session);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof FundingSearchError || error instanceof OpenReimbursementError
      || error instanceof ReimbursementListError ? error.message
      : '经费查询未完成。请检查参数、校园登录及本机输出目录；用 --help 查看用法。');
    process.exitCode = 1;
  });
}
