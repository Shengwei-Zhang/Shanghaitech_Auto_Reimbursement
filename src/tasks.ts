import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { TodoSearchOptions, TodoSearchResponse } from './automation/task-search';
import { buildTodoSearchPayload, searchTodoTasks, TaskSearchError } from './automation/task-search';
import { createBrowserSession, closeBrowserSession, rememberAuthenticatedSession, type BrowserSession } from './automation/browser';
import { authenticateSchool } from './automation/auth';

const HELP = `用法：npm run oa:tasks -- [--subject 单据编号或标题] [--page 1] [--page-size 10]
可选筛选：--biz-scene-code --start-time --end-time --task-type --priority --is-expire --is-ignore
只查询 type=1 的待办任务，不打开办理链接、不创建或提交报销单。
登录态由浏览器提供；JSON 响应保存在本机 data/oa-task-search 目录。
响应中的 BPM 报销办理链接（或成对的 bizId/taskId 字段）会整理到 targets，供 oa:open 使用。`;

export function parseTodoArgs(args: string[]): { help: boolean; query: TodoSearchOptions } {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, subject: { type: 'string' }, page: { type: 'string' }, 'page-size': { type: 'string' },
    'biz-scene-code': { type: 'string' }, 'start-time': { type: 'string' }, 'end-time': { type: 'string' },
    'task-type': { type: 'string' }, priority: { type: 'string' }, 'is-expire': { type: 'string' }, 'is-ignore': { type: 'string' },
  } });
  const query: TodoSearchOptions = {
    pageNumber: values.page === undefined ? undefined : Number(values.page),
    pageSize: values['page-size'] === undefined ? undefined : Number(values['page-size']),
    subject: values.subject, bizSceneCode: values['biz-scene-code'], startTime: values['start-time'],
    endTime: values['end-time'], taskType: values['task-type'], priority: values.priority,
    isExpire: values['is-expire'], isIgnore: values['is-ignore'] as TodoSearchOptions['isIgnore'],
  };
  buildTodoSearchPayload(query); // Validate before any browser is launched.
  return { help: values.help === true, query };
}

export async function saveTodoResponse(result: TodoSearchResponse, dataDir: string): Promise<string> {
  const directory = path.resolve(dataDir, 'oa-task-search');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw Error('Invalid output directory');
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return file;
}

export function reportTodoResult(result: TodoSearchResponse, file: string): void {
  console.log(`已收到待办接口 JSON 响应（HTTP ${result.httpStatus}，请求第 ${result.query.pageNumber} 页），已保存：${file}`);
  const envelope = result.response as Record<string, unknown>;
  if (!Array.isArray(envelope) && String(envelope.errcode) === '0' && Number.isSafeInteger(envelope.total)
    && Number.isSafeInteger(envelope.pages) && Array.isArray(envelope.datas)) {
    console.log(`门户报告待办共 ${envelope.total} 条、${envelope.pages} 页，本页 ${envelope.datas.length} 条。`);
  } else {
    console.log('响应不是已知的 { errcode: "0", total, pages, datas } 结构，未解读总数或业务结果。');
  }
  const handling = result.targets.filter(target => target.kind === 'handling');
  const named = handling.filter(target => target.documentNumber).length;
  console.log(handling.length
    ? `识别到 ${handling.length} 个报销单办理目标（bizId/taskId），其中 ${named} 个带单据编号；可用 oa:open --document-number 打开。`
    : '本页没有识别到报销单办理目标（bizId/taskId），已原样保存。');
  const notices = result.targets.length - handling.length;
  if (notices) console.log(`另有 ${notices} 条通知任务也链接到报销单，不作为办理目标。`);
  console.log('不据此判断原单状态或提交结果。');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { help, query } = parseTodoArgs(args);
  if (help) { console.log(HELP); return; }
  dotenv.config();
  // A dedicated query browser avoids navigating or closing an existing form.
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
    if (stopped) throw new TaskSearchError('request_failed');
    session.page = await authenticateSchool(session.page, { mode: 'manual', reuseSession: session.restoredSession });
    await rememberAuthenticatedSession(session);
    const result = await searchTodoTasks(session.page, query);
    reportTodoResult(result, await saveTodoResponse(result, process.env.OA_DATA_DIR || 'data'));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeBrowserSession(session);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof TaskSearchError ? error.message : '待办查询未完成。请检查参数、校园登录和本机输出目录；可用 --help 查看用法。');
    process.exitCode = 1;
  });
}
