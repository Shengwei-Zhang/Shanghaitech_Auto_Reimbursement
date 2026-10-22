import dotenv from 'dotenv';
import { parseArgs } from 'node:util';
import type { OaHttpClient } from './automation/http-login';
import { openFormHttp, openOwnerQueryHttp, resolveListTargetHttp, searchBudgetHttp, searchFundingHttp, searchTodoHttp,
  type HttpForm, type QueryDocument } from './automation/http-bpm';
import { establishBpmSession } from './automation/http-login';
import { buildReimbursementUrl, OpenReimbursementError, type ReimbursementTarget } from './automation/open-reimbursement';
import { ReimbursementListError } from './automation/reimbursement-list';
import { FundingSearchError, findFundingItem } from './automation/funding-search';
import { BudgetSearchError } from './automation/budget-search';
import { TaskSearchError } from './automation/task-search';
import { isLoginSetupError, loginFromEnvironment } from './login';
import { parseTodoArgs, reportTodoResult, saveTodoResponse } from './tasks';
import { describeFundingList, parseFundingArgs, saveFundingResponse } from './funds';
import { parseBudgetArgs, reportBudgetResult, saveBudgetResponse } from './budgets';

const HELP = `用法：npm run oa:http -- <命令> [参数]
全程不启动浏览器：用 OA_USERNAME / OA_PASSWORD（缺省时在终端询问）登录后直接调用学校接口。
  tasks   [与 oa:tasks 相同的参数]     门户待办查询
  target  --document-number A单据编号 [--read-only]
                                       由“报销单查询”与申请环节任务得到 bizId、taskId 和办理地址
  funds   [--kind --param-value --account-book --page-size --keyword]
                                       查询经费列表
  budgets (--funding-code 经费编号 | --funding-keyword 关键词 [--funding-kind])
          [--account-book --reimbursement-kind --page --page-size]
                                       查询预算支出科目
funds / budgets 不需要报销单：默认直接用 BPM 会话的 csrfToken 请求接口，账套默认 ST00、报销类型默认 applyMoney。
需要以某张原单的账套和报销类型为准时，加 --document-number（或 --biz-id/--task-id）：
以 HTTP 获取报销单页面（不执行页面脚本），核对隐藏字段中的 bizId、taskId、单据编号后读取上下文。
全部为只读查询，不创建、修改或提交报销单。
结果与对应浏览器命令一样私有保存到 data/ 下。`;

const dataDir = () => process.env.OA_DATA_DIR || 'data';

export const DIRECT_ACCOUNT_BOOK = 'ST00';
export const DIRECT_REIMBURSEMENT_KIND = 'applyMoney';

/** With a form: its csrfToken, procTaskId and context. Without: the 报销单查询 page's csrfToken. */
async function queryDocument(client: OaHttpClient, target: ReimbursementTarget | undefined,
  documentNumber: string | undefined): Promise<QueryDocument> {
  if (!target && !documentNumber) {
    const page = await openOwnerQueryHttp(client);
    console.log('未指定报销单：直接以 BPM 会话的 csrfToken 查询'
      + `（账套默认 ${DIRECT_ACCOUNT_BOOK}，报销类型默认 ${DIRECT_REIMBURSEMENT_KIND}，可用参数覆盖）。`);
    return { ...page, context: { accountBook: DIRECT_ACCOUNT_BOOK, reimbursementKind: DIRECT_REIMBURSEMENT_KIND } };
  }
  return formFor(client, target, documentNumber);
}

async function formFor(client: OaHttpClient, target: ReimbursementTarget | undefined, documentNumber: string | undefined): Promise<HttpForm> {
  await establishBpmSession(client);
  const resolved = target ?? (await resolveListTargetHttp(client, documentNumber!, false)).target;
  const form = await openFormHttp(client, resolved);
  console.log(`已通过 HTTP 打开报销单 ${form.documentNumber || '(页面未给出编号)'}，隐藏字段的 bizId/taskId 与目标一致`
    + `（账套 ${form.context.accountBook || '未知'}，报销类型 ${form.context.reimbursementKind || '未知'}）。`);
  return form;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') { console.log(HELP); return; }
  if (command === 'tasks') {
    const { help, query } = parseTodoArgs(rest);
    if (help) { console.log(HELP); return; }
    dotenv.config();
    const client = await loginFromEnvironment();
    const result = await searchTodoHttp(client, query);
    reportTodoResult(result, await saveTodoResponse(result, dataDir()));
  } else if (command === 'target') {
    const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
      'document-number': { type: 'string' }, 'read-only': { type: 'boolean' } } });
    const documentNumber = values['document-number'] ?? '';
    if (!/^A\d{1,32}$/.test(documentNumber)) throw new ReimbursementListError('invalid_query');
    dotenv.config();
    const client = await loginFromEnvironment();
    await establishBpmSession(client);
    const { target, row, task } = await resolveListTargetHttp(client, documentNumber, values['read-only'] === true);
    console.log(`单据 ${row.billCode}（${row.statusText || row.status}，${row.reimbursementAmount} 元）：bizId ${target.bizId}，`
      + `taskId ${target.taskId}（${task.name || task.taskDefKey}）`);
    console.log(`办理地址：${buildReimbursementUrl(target)}`);
  } else if (command === 'funds') {
    const { help, query, keyword, target, documentNumber } = parseFundingArgs(rest, true);
    if (help) { console.log(HELP); return; }
    dotenv.config();
    const client = await loginFromEnvironment();
    const form = await queryDocument(client, target, documentNumber);
    const result = await searchFundingHttp(client, form, query);
    console.log(`已收到经费列表响应（HTTP ${result.httpStatus}），已保存：${await saveFundingResponse(result, dataDir())}`);
    console.log(describeFundingList(result));
    if (keyword) {
      const item = findFundingItem(result.list, keyword);
      console.log(`关键词唯一匹配：${item.projectId} ${item.label || item.projectName}（${item.departmentName}）`);
    } else {
      for (const item of result.list.items) console.log(`  ${item.projectId} ${item.label || item.projectName}`);
    }
  } else if (command === 'budgets') {
    const { help, query, fundingKeyword, fundingKind, target, documentNumber } = parseBudgetArgs(rest, true);
    if (help) { console.log(HELP); return; }
    dotenv.config();
    const client = await loginFromEnvironment();
    const form = await queryDocument(client, target, documentNumber);
    let fundingItemsCode = query!.fundingItemsCode;
    if (fundingKeyword) {
      const funds = await searchFundingHttp(client, form, fundingKind ? { kind: fundingKind } : {});
      fundingItemsCode = findFundingItem(funds.list, fundingKeyword).projectId;
      console.log(`经费关键词唯一匹配项目 ${fundingItemsCode}。`);
    }
    const result = await searchBudgetHttp(client, form, { ...query!, fundingItemsCode });
    reportBudgetResult(result, await saveBudgetResponse(result, dataDir()));
  } else {
    console.log(HELP);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    const known = isLoginSetupError(error) || error instanceof TaskSearchError || error instanceof ReimbursementListError
      || error instanceof OpenReimbursementError || error instanceof FundingSearchError || error instanceof BudgetSearchError;
    console.error(known ? error.message : '无浏览器查询未完成。请检查参数、校园网络/VPN 和账号状态；可用 --help 查看用法。');
    process.exitCode = 1;
  });
}
