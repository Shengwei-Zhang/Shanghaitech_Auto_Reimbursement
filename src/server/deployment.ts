import os from 'node:os';

/** How the server is reached. 'local' (the default): one person on their own computer at 127.0.0.1, exactly
 * as before. 'server': several people through a reverse proxy (nginx), each browser with a session of its own
 * (see docs/deployment.md). Read once at start from the environment. */
export interface Deployment {
  mode: 'local' | 'server';
  /** server: the public origin(s) the page is served from, e.g. https://reim.example.edu.cn; Host and Origin must match. */
  origins: string[];
  /** server: trust X-Forwarded-Proto/-For from the proxy (it must be the only way in). */
  trustProxy: boolean;
  /** Idle minutes after which a browser session (and its school login) is dropped. */
  idleMinutes: number;
  /** Most browser sessions held at once; the oldest idle one gives way. */
  maxSessions: number;
  /** Jobs that start a browser (OA_HTTP_FILL/OA_HTTP_SUBMIT=false, demo) running at once across users. Jobs over
   * HTTP are not capped; each user still runs one job at a time. */
  maxActiveJobs: number;
  /** 票据 parsed at once (OCR of scans is CPU-bound); 0 = no limit. */
  maxParses: number;
  /** School accounts that may open the usage statistics (/admin). Empty: nobody on a server; the one user locally. */
  admins: string[];
  /** Contact address shown in every page's footer (REIM_CONTACT_EMAIL); kept out of the code. Empty: none shown. */
  contact?: string;
}

export class DeploymentError extends Error {}

export function deploymentFromEnv(env: NodeJS.ProcessEnv = process.env): Deployment {
  const mode = env.REIM_DEPLOYMENT === 'server' ? 'server' : 'local';
  if (env.REIM_DEPLOYMENT !== undefined && env.REIM_DEPLOYMENT !== '' && env.REIM_DEPLOYMENT !== 'local' && mode !== 'server') {
    throw new DeploymentError('REIM_DEPLOYMENT 只能是 local 或 server。');
  }
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new DeploymentError(`${name} 必须是 ${min}–${max} 的整数。`);
    return value;
  };
  const origins = (env.REIM_PUBLIC_ORIGIN ?? '').split(',').map(item => item.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new DeploymentError(`REIM_PUBLIC_ORIGIN 中的 ${origin} 不是有效地址。`); }
    if (url.origin !== origin || url.protocol !== 'https:') throw new DeploymentError(`REIM_PUBLIC_ORIGIN 须为 https://主机名[:端口]，不含路径：${origin}`);
  }
  if (mode === 'server' && !origins.length) throw new DeploymentError('REIM_DEPLOYMENT=server 时必须设置 REIM_PUBLIC_ORIGIN（如 https://reim.example.edu.cn）。');
  return { mode, origins: mode === 'server' ? origins : [], trustProxy: mode === 'server' && env.REIM_TRUST_PROXY !== 'false',
    idleMinutes: number('REIM_SESSION_IDLE_MINUTES', 120, 5, 24 * 60),
    maxSessions: number('REIM_MAX_SESSIONS', mode === 'server' ? 200 : 1, 1, 10_000),
    maxActiveJobs: number('REIM_MAX_ACTIVE_JOBS', mode === 'server' ? 2 : 1, 1, 64),
    maxParses: number('REIM_MAX_PARSES', mode === 'server' ? Math.max(1, os.cpus().length - 1) : 0, 0, 256),
    admins: admins(env.REIM_ADMIN_ACCOUNTS), contact: contact(env.REIM_CONTACT_EMAIL) };
}

function contact(value: string | undefined): string {
  const address = (value ?? '').trim();
  if (address && !/^[\w.+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(address)) throw new DeploymentError('REIM_CONTACT_EMAIL 不是有效的邮箱地址。');
  return address;
}

function admins(value: string | undefined): string[] {
  const list = (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  for (const account of list) if (!/^\w{1,32}$/.test(account)) throw new DeploymentError(`REIM_ADMIN_ACCOUNTS 中的 ${account} 不是学号/工号。`);
  return list;
}
