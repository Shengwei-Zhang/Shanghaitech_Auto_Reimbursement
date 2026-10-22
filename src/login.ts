import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { EGATE_ORIGIN, HttpLoginError, establishBpmSession, loginWithPassword, type OaHttpClient } from './automation/http-login';
import { buildTodoSearchPayload, TASK_SEARCH_PATH } from './automation/task-search';
import { buildOwnerListPayload, OWNER_LIST_PATH, parseOwnerList } from './automation/reimbursement-list';
import { BPM_ORIGIN } from './automation/form-request';
import { sessionStatePath, writeSessionState } from './automation/session-state';

const HELP = `用法：npm run oa:login -- [--save-session] [--skip-bpm]
不启动浏览器，用 OA_USERNAME / OA_PASSWORD（缺省时在终端询问）完成统一身份认证：
  1. 获取登录页的 execution 与 pwdEncryptSalt，按页面 encrypt.js 的 AES 规则加密密码；
  2. 提交 CAS 表单，跟随 ticket 跳转进入门户，并用门户 getLoginUser 核对账号；
  3. 用 CAS 登录态单点登录 BPM，打开“报销单查询”页取得 csrfToken；
  4. 以只读接口（待办查询、本人报销单列表）验证会话。
--save-session  把登录 Cookie 写入本机会话缓存（需 OA_REMEMBER_SESSION=true），之后的浏览器命令可直接复用；
                请确认 .env 中的账号就是平时手动登录的账号。
--skip-bpm      只登录门户，不建立 BPM 会话。
需要图形验证码时会保存验证码图片并在终端询问；要求多因素/二次认证时会停止并提示改用浏览器登录。
不会打印密码、Cookie 或 ticket，也不创建或修改报销单。`;

async function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    const write = output._writeToOutput.bind(rl);
    output._writeToOutput = text => { if (text.includes(question) || /[\r\n]/.test(text)) write(text); };
  }
  try { return await rl.question(question); } finally { rl.close(); }
}

async function privateDirectory(dataDir: string, name: string): Promise<string> {
  const directory = path.resolve(dataDir, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw Error('Invalid output directory');
  await fs.chmod(directory, 0o700);
  return directory;
}

async function checkTodo(client: OaHttpClient): Promise<string> {
  const response = await client.request(`${EGATE_ORIGIN}${TASK_SEARCH_PATH}`, { method: 'POST',
    body: JSON.stringify(buildTodoSearchPayload({ pageSize: 1 })),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*',
      referer: `${EGATE_ORIGIN}/CUS_TEMPLATE_OFFICIAL/pc/index.html` } });
  try {
    const json = JSON.parse(response.text) as { errcode?: unknown; total?: unknown };
    if (String(json.errcode) === '0' && Number.isSafeInteger(json.total)) return `待办接口可用，共 ${json.total} 条待办。`;
  } catch { /* reported below */ }
  return `待办接口没有返回已知结构（HTTP ${response.status}），请核对门户登录状态。`;
}

async function checkOwnerList(client: OaHttpClient, csrfToken: string, referer: string): Promise<string> {
  const response = await client.request(`${BPM_ORIGIN}${OWNER_LIST_PATH}`, { method: 'POST',
    body: new URLSearchParams(buildOwnerListPayload({ pagesize: 1 })).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', csrfToken, referer,
      accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' } });
  let list;
  try { list = parseOwnerList(JSON.parse(response.text)); } catch { /* reported below */ }
  return list?.total !== undefined ? `BPM 报销单列表接口可用，本人共 ${list.total} 张报销单。`
    : `BPM 报销单列表接口没有返回已知结构（HTTP ${response.status}）。`;
}

/** OA_USERNAME / OA_PASSWORD, or a terminal prompt; captcha images go to a private temp file. */
export async function loginFromEnvironment(dataDir = process.env.OA_DATA_DIR || 'data'): Promise<OaHttpClient> {
  const interactive = Boolean(process.stdin.isTTY);
  let username = process.env.OA_USERNAME?.trim() ?? '', password = process.env.OA_PASSWORD ?? '';
  if ((!username || !password) && !interactive) throw Error('未设置 OA_USERNAME / OA_PASSWORD，且当前不是交互终端。');
  if (!username) username = (await ask('学号/工号：')).trim();
  if (!password) password = await ask('密码（输入不回显）：', true);
  const client = await loginWithPassword({ username, password, solveCaptcha: interactive ? async image => {
    const file = path.join(await privateDirectory(dataDir, 'http-login'), `captcha-${randomUUID()}.jpg`);
    await fs.writeFile(file, image, { mode: 0o600, flag: 'wx' });
    try { return await ask(`需要图形验证码，请打开 ${file} 后输入：`); } finally { await fs.unlink(file).catch(() => undefined); }
  } : undefined });
  console.log('统一身份认证已通过（无浏览器），门户已确认登录账号与输入一致。');
  return client;
}

export function isLoginSetupError(error: unknown): error is Error {
  return error instanceof HttpLoginError || (error instanceof Error && /^(保存会话|未设置)/.test(error.message));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, 'save-session': { type: 'boolean' }, 'skip-bpm': { type: 'boolean' } } });
  if (values.help) { console.log(HELP); return; }
  dotenv.config();
  const sessionFile = values['save-session'] ? sessionStatePath() : undefined;
  if (values['save-session'] && !sessionFile) throw Error('保存会话需要在 .env 中设置 OA_REMEMBER_SESSION=true。');
  const client = await loginFromEnvironment();
  console.log(await checkTodo(client));
  if (!values['skip-bpm']) {
    const bpm = await establishBpmSession(client);
    console.log('BPM 单点登录完成，已打开“报销单查询”页并取得 csrfToken。');
    console.log(await checkOwnerList(client, bpm.csrfToken, bpm.url));
  }
  if (sessionFile) {
    await writeSessionState(client.jar.toStorageState(), sessionFile);
    console.log('登录会话已写入本机缓存；oa:tasks / oa:open / oa:funds / oa:budgets 会先验证并复用。');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(isLoginSetupError(error) ? error.message : '无浏览器登录未完成。请检查校园网络/VPN、账号状态；可用 --help 查看用法。');
    process.exitCode = 1;
  });
}
