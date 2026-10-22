import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, object, type Job } from '../domain/job';
import { buildItinerary, sanitizeItems } from '../domain/itinerary';
import { parseItineraryFile } from '../infrastructure/itinerary-files';

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
import { JobStore } from '../infrastructure/job-store';
import { DeepSeekAdvisor, type Advisor } from '../infrastructure/deepseek';
import { JobService, inspectInvoice, splitInvoicePdf, launchWorker, LOCAL_OWNER, type LaunchWorker } from '../application/job-service';
import type { SiteProfile } from '../domain/workflow';
import { CONTRACTS } from '../automation/contracts';
import { OaApi, handleOaRoute } from './oa-api';
import { Created, type FormContext } from './form-routes';
import { pagePath } from './page-path';
import type { Deployment } from './deployment';
import { equalSecret, Limiter, SessionRegistry } from './sessions';
import { UsageStats } from '../infrastructure/usage-stats';

/** The page's address: /Reim-Copilot on the deploy and main branches, /Reim-Copilot elsewhere (see page-path.ts).
 * / redirects here. */
export const PAGE_PATH = pagePath();

const MAX_BODY = 12 * 1024 * 1024;
const STATIC_FILES: Record<string, [string, string]> = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/easy.css': ['easy.css', 'text/css; charset=utf-8'],
  [PAGE_PATH]: ['easy-v2.html', 'text/html; charset=utf-8'],
  '/easy-v2.css': ['easy-v2.css', 'text/css; charset=utf-8'],
  '/print.js': ['print.js', 'text/javascript; charset=utf-8'],
  '/print-list': ['print-list.html', 'text/html; charset=utf-8'],
  '/print-list.js': ['print-list.js', 'text/javascript; charset=utf-8'],
  // Usage statistics: the page is public, its data (GET /api/admin/stats) only for the administrator.
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请求必须使用 JSON。');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new AppError(413, '上传内容过大，PDF 上限为 8 MB。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, '上传内容过大，PDF 上限为 8 MB。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'JSON 请求格式无效。'); }
}


export interface AppOptions {
  dataDir: string;
  publicDir?: string;
  liveEnabled?: boolean;
  deepSeekKey?: string;
  advisor?: Advisor;
  launcher?: LaunchWorker;
  timeoutMs?: number;
  siteProfile?: SiteProfile;
  /** 'local' (one user, 127.0.0.1, the default) keeps this one OaApi; 'server' makes one per browser. */
  oaApi?: OaApi;
  /** How the server is reached (see deployment.ts); local by default. */
  deployment?: Deployment;
  /** server: each browser's OaApi; tests swap it. */
  makeOaApi?: () => OaApi;
}

export function createApp(options: AppOptions) {
  const deployment: Deployment = options.deployment ?? { mode: 'local', origins: [], trustProxy: false, idleMinutes: 120, maxSessions: 1,
    maxActiveJobs: 1, maxParses: 0, admins: [] };
  /** Usage counts for the administrator (no personal data; see usage-stats.ts). */
  const usage = new UsageStats(path.join(options.dataDir, 'stats'));
  /** 票据 parsing (OCR of scans takes a CPU core for seconds): at most maxParses at once, the rest wait their turn. */
  const parses = new Limiter(deployment.maxParses);
  const shared = deployment.mode === 'local';
  const store = new JobStore(path.join(options.dataDir, 'jobs'));
  store.recover(shared ? LOCAL_OWNER : undefined);
  /** Each browser's OaApi: on a server its own login and an owner id of its own, so jobs are never seen across browsers.
   * Saved credentials (.env OA_USERNAME/OA_PASSWORD) are for one's own computer only. */
  const makeApi = (): OaApi => {
    if (shared) return options.oaApi || new OaApi();
    const api = options.makeOaApi ? options.makeOaApi() : new OaApi(undefined, null);
    api.ownerId = `u-${randomBytes(16).toString('hex')}`;
    api.useJobs({ service, store });
    return api;
  };
  const sessions = new SessionRegistry(() => { const api = makeApi(); api.usage = usage; return api; },
    { shared, idleMs: deployment.idleMinutes * 60_000, max: deployment.maxSessions });
  /** Who may see the statistics: a listed school account; locally, with no list, the one logged-in user. */
  const isAdmin = (api: OaApi) => {
    const account = api.account()?.toLowerCase();
    const admins = deployment.admins ?? [];
    return Boolean(account) && (admins.length ? admins.includes(account!) : shared);
  };
  // The day's peak of browsers online, sampled each minute.
  const sampler = setInterval(() => usage.online(sessions.online().online), 60_000);
  sampler.unref();
  /** The OaApi a job belongs to: the browser session with the job's owner id. A session that has ended has no login to run on. */
  const apiFor = (ownerId: string): OaApi => {
    const api = sessions.apis().find(item => item.ownerId === ownerId);
    if (!api) throw new AppError(401, '该任务所属的登录已结束。');
    return api;
  };
  /** A page job filled over HTTP on the page's login; any other runs in a browser worker (a child process). */
  const overHttp = (job: Job, sessionStateFile?: string) => job.mode === 'live' && Boolean(sessionStateFile) && process.env.OA_HTTP_FILL !== 'false';
  const launcher: LaunchWorker = options.launcher || ((request, onEvent, onExit) =>
    overHttp(request.job, request.sessionStateFile)
      ? apiFor(request.job.ownerId).fillJob(request, onEvent, onExit, launchWorker) : launchWorker(request, onEvent, onExit));
  // Only jobs that start a browser count against REIM_MAX_ACTIVE_JOBS: a worker process, or OA_HTTP_SUBMIT=false
  // handing the saved form to one for 提交. HTTP jobs mostly wait on OA and run for every user at once.
  const heavy = (job: Job, sessionStateFile?: string) => !overHttp(job, sessionStateFile)
    || (job.action === 'submit' && process.env.OA_HTTP_SUBMIT === 'false');
  const service = new JobService(store, options.advisor || new DeepSeekAdvisor(options.deepSeekKey || ''),
    options.liveEnabled === true, launcher, options.timeoutMs, options.siteProfile, deployment.maxActiveJobs, heavy);
  // How each page 用款申请单 ended: submitted (receipt), saved, unclear, failed or stopped.
  service.onSettled = job => {
    if (job.mode !== 'live') return;
    const outcome = job.status === 'submitted' ? 'submitted'
      : job.status === 'verified' ? (job.action === 'submit' ? 'submitted' : 'saved')
        : job.status === 'needs_review' ? (job.action === 'save' && job.result ? 'saved' : 'needs_review')
          : job.status === 'cancelled' ? 'cancelled' : 'failed';
    usage.formFinished('用款申请单', outcome);
  };
  const publicDir = options.publicDir || path.resolve(__dirname, '../../public');
  // The page's modules, one per shared part and per 报销类型 (see public/js/main.js): every public/js/*.js, so a new
  // 报销类型's module is served without listing it here. Only plain names; nothing below public/js.
  const pageModules: Record<string, [string, string]> = Object.fromEntries((fs.existsSync(path.join(publicDir, 'js'))
    ? fs.readdirSync(path.join(publicDir, 'js')) : []).filter(name => /^[a-z][a-z0-9-]*\.js$/.test(name))
    .map(name => [`/js/${name}`, [`js/${name}`, 'text/javascript; charset=utf-8'] as [string, string]]));

  if (shared) sessions.apis()[0].useJobs({ service, store });
  /** What each 报销类型's routes may use besides the login, for one browser's OaApi. */
  const contextOf = (api: OaApi): FormContext => ({ liveEnabled: service.liveEnabled, readInvoices: value => api.pageInvoices(value) });

  const server = http.createServer(async (req, res) => {
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    applyHeaders(res);
    try {
      // Local: only this computer, at 127.0.0.1. Server: only the configured public origin(s), through the proxy.
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      const origins = shared ? [`http://127.0.0.1:${port}`, `http://localhost:${port}`] : deployment.origins;
      const forwarded = deployment.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
      const scheme = shared ? 'http' : forwarded || 'http';
      const here = `${scheme}://${req.headers.host || ''}`;
      if (!origins.includes(here)) throw new AppError(403, shared ? '仅允许本机访问。' : '访问地址不被允许。');
      if (req.headers.origin && req.headers.origin !== here) throw new AppError(403, '请求来源不被允许。');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '不接受跨站请求。');
      const url = new URL(req.url || '/', here);
      const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('oa_session='))?.slice(11) || '';
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const session = sessions.open(cookie);
        res.setHeader('Set-Cookie', `oa_session=${session.id}; HttpOnly; SameSite=Strict; Path=/${shared ? '' : '; Secure'}`);
        return json(200, { csrfToken: session.csrf, liveEnabled: service.liveEnabled, deployment: deployment.mode,
          aiConfigured: Boolean(options.deepSeekKey || options.advisor), edition: 'local', maxPdfMB: 8,
          planConfigured: Boolean(options.advisor ? options.advisor.generatePlan : options.deepSeekKey?.trim()),
          receiptConfigured: Boolean(options.siteProfile), stages: CONTRACTS });
      }
      const printToken = req.method === 'GET' ? url.pathname.match(/^\/print\/([\w-]{24})$/)?.[1] : undefined;
      if (printToken) {
        const file = sessions.require(cookie).api.takePrint(printToken);
        if (!file) throw new AppError(404, '打印内容已过期或已打开过，请回到报销单打印页面重新点击。');
        // OA's page: inline data images, inline styles (watermark layer), and only our print.js.
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200, { 'Content-Type': file.type, ...(file.filename
          ? { 'Content-Disposition': `attachment; filename="print.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename)}` } : {}) });
        return res.end(file.body);
      }
      if (url.pathname.startsWith('/api/')) {
        const session = sessions.require(cookie);
        if (req.method !== 'GET' && !equalSecret(String(req.headers['x-csrf-token'] || ''), session.csrf)) {
          throw new AppError(403, '请求校验失败，请刷新页面后重试。');
        }
        const { api: oaApi } = session, owner = oaApi.ownerId;
        // Usage statistics: the administrator's school account only; anyone else is told it does not exist.
        if (url.pathname === '/api/admin/stats') {
          if (req.method !== 'GET' || !isAdmin(oaApi)) throw new AppError(404, '接口不存在。');
          const now = sessions.online();
          usage.online(now.online);
          const travelRunning = sessions.apis().filter(api => api.travel.status().run?.status === 'running').length;
          return json(200, { now: { online: now.online, loggedIn: now.loggedIn, sessions: sessions.size,
            jobsRunning: service.running, jobsQueued: service.queued, travelRunning, mode: deployment.mode }, ...usage.report(30) });
        }
        if (url.pathname === '/api/oa/status' && req.method === 'GET') return json(200, { ...oaApi.status(), admin: isAdmin(oaApi) });
        // The login, shared queries and every 报销类型's own routes (oa-api.ts), all of this browser's.
        if (url.pathname.startsWith('/api/oa/')) {
          const result = await handleOaRoute(oaApi, req.method || 'GET', url, () => readJson(req), contextOf(oaApi));
          if (result === undefined) throw new AppError(404, '接口不存在。');
          return result instanceof Created ? json(201, result.body) : json(200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/invoices/inspect') {
          const { invoice } = await inspectInvoice(await readJson(req));
          return json(200, { invoice });
        }
        // 行程附件: parsed in memory for the page, never stored, never sent to OA.
        if (req.method === 'POST' && url.pathname === '/api/travel/parse') {
          const data = object(await readJson(req));
          if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200 || /[\u0000-\u001f/\\]/.test(data.name)) {
            throw new AppError(400, '附件文件名无效。');
          }
          if (typeof data.base64 !== 'string' || data.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.base64)) {
            throw new AppError(400, '附件编码无效或超过 8 MB。');
          }
          const name = data.name.trim(), bytes = Buffer.from(data.base64, 'base64');
          return json(200, { items: await parses.run(() => parseItineraryFile(name, bytes)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/travel/itinerary') {
          const items = sanitizeItems(object(await readJson(req)).items);
          if (!items) throw new AppError(400, '行程附件的解析结果无效，请重新添加附件。');
          return json(200, { itinerary: buildItinerary(items) });
        }
        if (req.method === 'POST' && url.pathname === '/api/invoices/split') return json(200, await splitInvoicePdf(await readJson(req)));
        if (req.method === 'GET' && url.pathname === '/api/jobs') return json(200, { jobs: store.list(owner) });
        // Jobs outside the page (demo, a browser worker with typed credentials) are for one's own computer only.
        if (req.method === 'POST' && url.pathname === '/api/jobs') {
          if (!shared) throw new AppError(404, '接口或任务不存在。');
          return json(201, { job: await service.create(await readJson(req)) });
        }
        const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(start|cancel|review|reconcile|complete-manual|plan))?$/);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET' && !action) return json(200, { job: store.get(id, owner) });
          if (req.method === 'GET' && action === 'plan') {
            const plan = service.getPlan(id, owner);
            if (url.searchParams.get('download') === '1') {
              res.setHeader('Content-Disposition', `attachment; filename="reimbursement.v${plan.version}.json"`);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify(plan, null, 2) + '\n');
            }
            return json(200, { plan });
          }
          if (req.method === 'POST' && action) {
            const body = await readJson(req);
            if (action === 'start') {
              if (!shared) throw new AppError(404, '接口或任务不存在。');
              return json(200, { job: service.start(id, body) });
            }
            if (action === 'cancel') return json(200, { job: service.cancel(id, owner) });
            if (action === 'review') return json(200, { job: await service.review(id, body, owner) });
            if (action === 'plan') return json(200, { job: await service.generatePlan(id, body, owner) });
            if (action === 'reconcile') return json(200, { job: service.reconcile(id, body, owner) });
            if (action === 'complete-manual') return json(200, { job: service.completeManual(id, body, owner) });
          }
        }
        throw new AppError(404, '接口或任务不存在。');
      }
      // The one-page reimbursement is the only UI.
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { Location: PAGE_PATH });
        return res.end();
      }
      const file = Object.hasOwn(STATIC_FILES, url.pathname) ? STATIC_FILES[url.pathname]
        : Object.hasOwn(pageModules, url.pathname) ? pageModules[url.pathname] : undefined;
      if (req.method === 'GET' && file) {
        res.writeHead(200, { 'Content-Type': file[1] });
        res.end(fs.readFileSync(path.join(publicDir, file[0])));
        return;
      }
      throw new AppError(404, '页面不存在。');
    } catch (error) {
      if (!res.headersSent) json(error instanceof AppError ? error.status : 500,
        { error: error instanceof AppError ? error.message : '操作失败，请检查本地服务状态后重试。' });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { service.shutdown(); sessions.close(); clearInterval(sampler); });
  return { server, service, store };
}

function applyHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
