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
import { buildBudgetSearchPayload, searchBudgetOutlays, BudgetSearchError,
  type BudgetSearchOptions, type BudgetSearchResponse } from './automation/budget-search';
import { findFundingItem, searchFundingItems, FundingSearchError, FUNDING_KINDS } from './automation/funding-search';
import { ReimbursementListError } from './automation/reimbursement-list';
import { targetFromList } from './open';

const HELP = `用法：npm run oa:budgets -- (--funding-code <经费编号> | --funding-keyword <项目关键词>)
                         (--biz-id <32位ID> --task-id <UUID> | --document-number A单据编号)
可选：--account-book --reimbursement-kind --page 1 --page-size 20
打开已有报销单，在当前表单内读取 csrfToken、账套和报销类型，查询该项目的预算支出科目。
--funding-keyword 先在原单内查询经费列表，按关键词唯一匹配项目编号；
  --funding-kind authorized|responsible 选择被授权的项目（默认）或我负责的项目；
只给 --document-number 时，登录后从“报销单查询”取得 bizId，再从申请环节任务取得 taskId。
账套和报销类型默认取自原单页面，显式传入时以参数为准。
Cookie 复用浏览器登录态；响应私有保存到 data/oa-budget-search，不自动选科目或保存报销单。`;

export interface BudgetRequest {
  /** fundingItemsCode is empty when fundingKeyword must be resolved after login. */
  query: BudgetSearchOptions;
  fundingKeyword?: string;
  fundingKind?: keyof typeof FUNDING_KINDS;
  target?: ReimbursementTarget;
  documentNumber?: string;
}

/** allowDirect: no form identifiers is valid (the HTTP command queries with the BPM session alone). */
export function parseBudgetArgs(args: string[], allowDirect = false): { help: boolean } & Partial<BudgetRequest> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, 'funding-code': { type: 'string' }, 'funding-keyword': { type: 'string' },
    'funding-kind': { type: 'string' },
    'biz-id': { type: 'string' }, 'task-id': { type: 'string' }, 'document-number': { type: 'string' },
    'account-book': { type: 'string' }, 'reimbursement-kind': { type: 'string' },
    page: { type: 'string' }, 'page-size': { type: 'string' },
  } });
  if (values.help) return { help: true };
  const integer = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value)) throw new BudgetSearchError('invalid_query');
    return Number(value);
  };
  const keyword = values['funding-keyword']?.trim();
  if ((values['funding-code'] !== undefined) === (keyword !== undefined)
    || (keyword !== undefined && (!keyword || keyword.length > 100 || /[\u0000-\u001f]/.test(keyword)))) {
    throw new BudgetSearchError('invalid_query');
  }
  const query: BudgetSearchOptions = {
    fundingItemsCode: values['funding-code'] ?? '', accountBook: values['account-book'],
    reimbursementKind: values['reimbursement-kind'],
    page: integer(values.page, 1), pagesize: integer(values['page-size'], 20),
  };
  // Validate everything else before a browser starts; a keyword is resolved later.
  buildBudgetSearchPayload({ ...query, fundingItemsCode: query.fundingItemsCode || 'KEYWORD' });
  const kind = values['funding-kind'];
  if (kind !== undefined && (keyword === undefined || !Object.hasOwn(FUNDING_KINDS, kind))) {
    throw new BudgetSearchError('invalid_query');
  }
  const fundingKeyword = keyword
    ? { fundingKeyword: keyword, ...(kind ? { fundingKind: kind as keyof typeof FUNDING_KINDS } : {}) } : {};
  if (allowDirect && values['biz-id'] === undefined && values['task-id'] === undefined && values['document-number'] === undefined) {
    return { help: false, query, ...fundingKeyword };
  }
  if (values['biz-id'] === undefined && values['task-id'] === undefined && values['document-number'] !== undefined) {
    if (!/^A\d{1,32}$/.test(values['document-number'])) throw new OpenReimbursementError('invalid_target');
    return { help: false, query, ...fundingKeyword, documentNumber: values['document-number'] };
  }
  const target: ReimbursementTarget = { bizId: values['biz-id'] || '', taskId: values['task-id'] || '',
    isReadOnly: false, expectedDocumentNumber: values['document-number'] };
  buildReimbursementUrl(target);
  return { help: false, query, ...fundingKeyword, target };
}

export async function saveBudgetResponse(result: BudgetSearchResponse, dataDir: string): Promise<string> {
  const directory = path.resolve(dataDir, 'oa-budget-search');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Invalid output directory');
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return file;
}

export function reportBudgetResult(result: BudgetSearchResponse, file: string): void {
  console.log(`已收到预算科目接口响应（HTTP ${result.httpStatus}，项目 ${result.query.fundingItemsCode}，账套 ${result.query.accountBook}，`
    + `报销类型 ${result.query.reimbursementKind}），已保存：${file}`);
  const outlays = result.outlays;
  if (outlays) {
    console.log(`本页 ${outlays.rows.length} 个预算科目${outlays.total === undefined ? '' : `（接口声明共 ${outlays.total} 个）`}`
      + `${outlays.showAmount ? `，项目可用余额 ${outlays.showAmount} 元` : '，余额未授权查看'}`
      + `${outlays.skipped ? `；${outlays.skipped} 行不属于该项目或缺少科目编号，已忽略` : ''}：`);
    for (const row of outlays.rows) {
      console.log(`  ${row.expenditureItemCode} ${row.expenditureItemName}（${row.quotaCode} ${row.quotaName}）`);
    }
  } else {
    console.log('响应不是已知的 { status: 0, data: { Rows, Total } } 结构，已原样保存，未解读科目。');
  }
  console.log('此结果不代表科目已选定或报销已保存。');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { help, query, fundingKeyword, fundingKind, target: explicit, documentNumber } = parseBudgetArgs(args);
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
    if (stopped) throw new BudgetSearchError('request_failed');
    session.page = await authenticateSchool(session.page, { mode: 'manual', reuseSession: session.restoredSession });
    const target = explicit ?? await targetFromList(session, documentNumber!, false);
    const ctx = new AutomationContext(session.page);
    await openReimbursementByIds(session, ctx, target);
    await rememberAuthenticatedSession(session);
    let fundingItemsCode = query!.fundingItemsCode;
    if (fundingKeyword) {
      const funds = await searchFundingItems(ctx, fundingKind ? { kind: fundingKind } : {});
      const item = findFundingItem(funds.list, fundingKeyword);
      fundingItemsCode = item.projectId;
      console.log(`经费关键词唯一匹配项目 ${item.projectId}。`);
    }
    const result = await searchBudgetOutlays(ctx, { ...query!, fundingItemsCode });
    reportBudgetResult(result, await saveBudgetResponse(result, process.env.OA_DATA_DIR || 'data'));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeBrowserSession(session);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof BudgetSearchError || error instanceof OpenReimbursementError
      || error instanceof FundingSearchError || error instanceof ReimbursementListError ? error.message
      : '预算查询未完成。请检查参数、校园登录及本机输出目录；用 --help 查看用法。');
    process.exitCode = 1;
  });
}
