import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
const OA_HOSTS = new Set(['ids.shanghaitech.edu.cn', 'egate-new.shanghaitech.edu.cn',
  'sapbpm-new.shanghaitech.edu.cn', 'sapbpm.shanghaitech.edu.cn']);

/** Resolve before forking: a worker's cwd is its invoice directory. */
export function sessionStatePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  if (env.OA_REMEMBER_SESSION?.trim().toLowerCase() !== 'true') return undefined;
  return path.resolve(cwd, env.OA_SESSION_STATE_PATH?.trim()
    || path.join(env.OA_DATA_DIR?.trim() || 'data', 'browser-session', 'storage-state.json'));
}

function oaState(state: StorageState): StorageState {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw Error('Invalid state');
  const cookies = state.cookies.filter(cookie => {
    if (!cookie || !['name', 'value', 'domain', 'path'].every(key =>
      typeof cookie[key as keyof typeof cookie] === 'string') || !Number.isFinite(cookie.expires)
      || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean'
      || !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) throw Error('Invalid cookie');
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return (OA_HOSTS.has(domain) || domain === 'shanghaitech.edu.cn')
      && (cookie.expires === -1 || cookie.expires > Date.now() / 1000);
  });
  const origins = state.origins.filter(origin => {
    const indexedDB = (origin as typeof origin & { indexedDB?: unknown }).indexedDB;
    if (!origin || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)
      || !origin.localStorage.every(item => typeof item.name === 'string' && typeof item.value === 'string')
      || (indexedDB !== undefined && !Array.isArray(indexedDB))) throw Error('Invalid origin');
    const url = new URL(origin.origin);
    return url.protocol === 'https:' && url.origin === origin.origin && OA_HOSTS.has(url.hostname);
  });
  return { cookies, origins };
}

export async function loadSessionState(file: string): Promise<StorageState | undefined> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid state file');
    await fs.chmod(file, 0o600);
    return oaState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('本机登录会话缓存不可用，将通过学校页面重新登录。');
    }
    return undefined;
  }
}

/** Private, atomic snapshot; never log cookie values or send them to the job API. */
export async function writeSessionState(state: StorageState, file: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const filtered = oaState(state);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) throw Error('Invalid session directory');
    await fs.chmod(directory, 0o700);
    await fs.writeFile(temporary, JSON.stringify(filtered), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function saveSessionState(context: BrowserContext, file: string): Promise<boolean> {
  try {
    await writeSessionState(await context.storageState({ indexedDB: true }), file);
    return true;
  } catch {
    // Failure to cache a login must not turn an already-saved reimbursement into
    // a failed job or trigger another OA write. Leave the previous snapshot intact.
    console.warn('未能更新本机登录会话缓存；报销操作不会因此重试，下次可能需要重新登录。');
    return false;
  }
}
