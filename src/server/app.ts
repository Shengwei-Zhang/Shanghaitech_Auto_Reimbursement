import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, MAX_INVOICES, object } from '../domain/job';
import { buildItinerary, sanitizeItems } from '../domain/itinerary';
import { parseItineraryFile } from '../infrastructure/itinerary-files';

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
import { writeSessionState } from '../automation/session-state';
import { JobStore } from '../infrastructure/job-store';
import { DeepSeekAdvisor, type Advisor } from '../infrastructure/deepseek';
import { JobService, inspectInvoice, splitInvoicePdf, launchWorker, LOCAL_OWNER, type LaunchWorker } from '../application/job-service';
import type { SiteProfile } from '../domain/workflow';
import { CONTRACTS } from '../automation/contracts';
import { OaApi, handleOaRoute } from './oa-api';

/** The page's address. The development repository serves /Reim-Copilot; the published copy (scripts/export-deploy.mjs)
 * serves /Reim-Copilot. / redirects here. */
export const PAGE_PATH = '/Reim-Copilot';

const MAX_BODY = 12 * 1024 * 1024;
const STATIC_FILES: Record<string, [string, string]> = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/easy.css': ['easy.css', 'text/css; charset=utf-8'],
  // The Easy page's modules, one per shared part and per 报销类型 (see public/js/main.js).
  ...Object.fromEntries(['core', 'login', 'funding', 'invoices', 'apply-money', 'travel', 'itinerary', 'main']
    .map(name => [`/js/${name}.js`, [`js/${name}.js`, 'text/javascript; charset=utf-8'] as [string, string]])),
  [PAGE_PATH]: ['easy-v2.html', 'text/html; charset=utf-8'],
  '/easy-v2.css': ['easy-v2.css', 'text/css; charset=utf-8'],
  '/print.js': ['print.js', 'text/javascript; charset=utf-8'],
  '/print-list': ['print-list.html', 'text/html; charset=utf-8'],
  '/print-list.js': ['print-list.js', 'text/javascript; charset=utf-8'],
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

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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
  oaApi?: OaApi;
}

export function createApp(options: AppOptions) {
  const store = new JobStore(path.join(options.dataDir, 'jobs'));
  store.recover(LOCAL_OWNER);
  const oaApi = options.oaApi || new OaApi();
  // Filling runs over HTTP; submission has not been mapped to requests yet, so a browser submits the saved form.
  const launcher: LaunchWorker = options.launcher || ((request, onEvent, onExit) =>
    request.job.mode === 'live' && request.sessionStateFile && process.env.OA_HTTP_FILL !== 'false'
      ? oaApi.fillJob(request, onEvent, onExit, launchWorker) : launchWorker(request, onEvent, onExit));
  const service = new JobService(store, options.advisor || new DeepSeekAdvisor(options.deepSeekKey || ''),
    options.liveEnabled === true, launcher, options.timeoutMs, options.siteProfile);
  const sessionSecret = randomBytes(32).toString('hex');
  const csrfSecret = randomBytes(32).toString('hex');
  const publicDir = options.publicDir || path.resolve(__dirname, '../../public');

  /** One page → one live job: the chosen blank form (or a new one), the inputs and the
   * invoice; the browser continues the page's school login instead of logging in again. */
  async function submitFromEasyPage(value: unknown) {
    const data = object(value);
    if (data.confirmed !== true) throw new AppError(400, '请先确认全部报销信息。');
    if (data.action !== 'save' && data.action !== 'submit') throw new AppError(400, '请选择只保存，或保存后提交流转。');
    if (!service.liveEnabled) throw new AppError(403, '真实 OA 执行未启用，请在 .env 中设置 OA_LIVE_ENABLED=true 并重启服务。');
    const uploads = data.invoices === undefined ? [data.invoice] : data.invoices;
    if (!Array.isArray(uploads) || !uploads.length || uploads.length > MAX_INVOICES) throw new AppError(400, `每张报销单可关联 1–${MAX_INVOICES} 张发票。`);
    const numbers: string[] = [];
    const picks: Array<{ folderId: string; number: string }> = [];
    for (const upload of uploads) {
      const item = object(upload);
      let number: string;
      if (item.folderId !== undefined) {
        if (typeof item.folderId !== 'string' || !/^\d{1,32}$/.test(item.folderId) || typeof item.number !== 'string' || !/^\d{20}$/.test(item.number)) {
          throw new AppError(400, '票夹发票参数无效。');
        }
        picks.push({ folderId: item.folderId, number: item.number });
        number = item.number;
      } else {
        const { invoice } = await inspectInvoice(upload);
        if (!invoice.number) throw new AppError(400, '未能从 PDF 识别发票号码，无法核对是否已报销。');
        number = invoice.number;
      }
      if (numbers.includes(number)) throw new AppError(400, `同一张发票（${number}）选择了多次。`);
      numbers.push(number);
    }
    const folder = await oaApi.pickedInvoices(picks);
    const { target, storageState } = await oaApi.handoff(data.documentNumber ?? null);
    const { formMode: _mode, target: _target, ...input } = object(data.input);
    const job = await service.create({ mode: 'live', action: data.action, invoices: uploads,
      input: { ...input, ...(target ? { formMode: 'target', target } : { formMode: 'new' }) } }, { folder })
      .catch(error => { if (target) oaApi.release(target.documentNumber); throw error; });
    const file = path.join(store.directory(job.id), 'oa-session.json');
    try {
      await writeSessionState(storageState, file);
      return service.start(job.id, { confirmed: true, loginMode: 'manual' }, file);
    } catch (error) {
      fs.rmSync(file, { force: true });
      service.cancel(job.id);
      if (target) oaApi.release(target.documentNumber);
      throw error instanceof AppError ? error : new AppError(500, '未能启动执行，任务已取消，没有操作 OA。');
    }
  }

  /** The page's invoices for a 境内差旅单: PDFs read here like a job's, folder picks re-read in OA. */
  async function travelInvoices(value: unknown): Promise<Array<{ fileName: string; number: string; bytes?: Buffer; folderId?: string }>> {
    const uploads = value === undefined ? [] : value;
    if (!Array.isArray(uploads) || uploads.length > MAX_INVOICES) throw new AppError(400, `每张报销单可关联 0–${MAX_INVOICES} 张发票。`);
    const invoices: Array<{ fileName: string; number: string; bytes?: Buffer; folderId?: string }> = [];
    const picks: Array<{ folderId: string; number: string }> = [];
    for (const upload of uploads) {
      const item = object(upload);
      if (item.folderId !== undefined) {
        if (typeof item.folderId !== 'string' || !/^\d{1,32}$/.test(item.folderId) || typeof item.number !== 'string' || !/^\d{20}$/.test(item.number)) {
          throw new AppError(400, '票夹发票参数无效。');
        }
        picks.push({ folderId: item.folderId, number: item.number });
        invoices.push({ fileName: '', number: item.number, folderId: item.folderId });
      } else {
        const { invoice, buffer } = await inspectInvoice(upload);
        if (!invoice.number) throw new AppError(400, '未能从 PDF 识别发票号码，无法核对是否已报销。');
        invoices.push({ fileName: invoice.name, number: invoice.number, bytes: buffer });
      }
      if (invoices.filter(entry => entry.number === invoices[invoices.length - 1].number).length > 1) {
        throw new AppError(400, `同一张发票（${invoices[invoices.length - 1].number}）选择了多次。`);
      }
    }
    for (const picked of await oaApi.pickedInvoices(picks)) {
      const entry = invoices.find(item => item.folderId === picked.folderId && item.number === picked.number);
      if (entry) entry.fileName = picked.name;
    }
    return invoices;
  }

  const server = http.createServer(async (req, res) => {
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    applyHeaders(res);
    try {
      // This edition deliberately has no public bind address. A proxy is not an authentication layer.
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host || '')) throw new AppError(403, '仅允许本机访问。');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new AppError(403, '请求来源不被允许。');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '不接受跨站请求。');
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/session') {
        res.setHeader('Set-Cookie', `oa_session=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`);
        return json(200, { csrfToken: csrfSecret, liveEnabled: service.liveEnabled,
          aiConfigured: Boolean(options.deepSeekKey || options.advisor), edition: 'local', maxPdfMB: 8,
          planConfigured: Boolean(options.advisor ? options.advisor.generatePlan : options.deepSeekKey?.trim()),
          receiptConfigured: Boolean(options.siteProfile), stages: CONTRACTS });
      }
      const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('oa_session='))?.slice(11) || '';
      const printToken = req.method === 'GET' ? url.pathname.match(/^\/print\/([\w-]{24})$/)?.[1] : undefined;
      if (printToken) {
        if (!equalSecret(cookie, sessionSecret)) throw new AppError(401, '本地会话已失效，请刷新页面。');
        const file = oaApi.takePrint(printToken);
        if (!file) throw new AppError(404, '打印内容已过期或已打开过，请回到报销单打印页面重新点击。');
        // OA's page: inline data images, inline styles (watermark layer), and only our print.js.
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200, { 'Content-Type': file.type, ...(file.filename
          ? { 'Content-Disposition': `attachment; filename="print.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename)}` } : {}) });
        return res.end(file.body);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!equalSecret(cookie, sessionSecret)) throw new AppError(401, '本地会话已失效，请刷新页面。');
        if (req.method !== 'GET' && !equalSecret(String(req.headers['x-csrf-token'] || ''), csrfSecret)) {
          throw new AppError(403, '请求校验失败，请刷新页面后重试。');
        }
        if (req.method === 'POST' && url.pathname === '/api/oa/submit') return json(201, { job: await submitFromEasyPage(await readJson(req)) });
        if (req.method === 'POST' && url.pathname === '/api/oa/travel') {
          const data = object(await readJson(req));
          if (data.confirmed !== true) throw new AppError(400, '请先确认全部差旅单信息。');
          if (!service.liveEnabled) throw new AppError(403, '真实 OA 执行未启用，请在 .env 中设置 OA_LIVE_ENABLED=true 并重启服务。');
          if (data.documentNumber !== undefined && data.documentNumber !== null
            && (typeof data.documentNumber !== 'string' || !/^D\d{1,32}$/.test(data.documentNumber))) throw new AppError(400, '差旅单编号无效。');
          if (data.action !== undefined && data.action !== 'save' && data.action !== 'submit') throw new AppError(400, '请选择只保存，或保存后提交流转。');
          return json(201, oaApi.travel.start(data.input, (data.documentNumber as string | null | undefined) ?? null, await travelInvoices(data.invoices),
            data.action === 'submit' ? 'submit' : 'save'));
        }
        if (url.pathname.startsWith('/api/oa/')) {
          const result = await handleOaRoute(oaApi, req.method || 'GET', url, () => readJson(req));
          if (result === undefined) throw new AppError(404, '接口不存在。');
          return json(200, result);
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
          return json(200, { items: await parseItineraryFile(data.name.trim(), Buffer.from(data.base64, 'base64')) });
        }
        if (req.method === 'POST' && url.pathname === '/api/travel/itinerary') {
          const items = sanitizeItems(object(await readJson(req)).items);
          if (!items) throw new AppError(400, '行程附件的解析结果无效，请重新添加附件。');
          return json(200, { itinerary: buildItinerary(items) });
        }
        if (req.method === 'POST' && url.pathname === '/api/invoices/split') return json(200, await splitInvoicePdf(await readJson(req)));
        if (req.method === 'GET' && url.pathname === '/api/jobs') return json(200, { jobs: store.list(LOCAL_OWNER) });
        if (req.method === 'POST' && url.pathname === '/api/jobs') return json(201, { job: await service.create(await readJson(req)) });
        const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(start|cancel|review|reconcile|complete-manual|plan))?$/);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET' && !action) return json(200, { job: store.get(id, LOCAL_OWNER) });
          if (req.method === 'GET' && action === 'plan') {
            const plan = service.getPlan(id);
            if (url.searchParams.get('download') === '1') {
              res.setHeader('Content-Disposition', `attachment; filename="reimbursement.v${plan.version}.json"`);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify(plan, null, 2) + '\n');
            }
            return json(200, { plan });
          }
          if (req.method === 'POST' && action) {
            const body = await readJson(req);
            if (action === 'start') return json(200, { job: service.start(id, body) });
            if (action === 'cancel') return json(200, { job: service.cancel(id) });
            if (action === 'review') return json(200, { job: await service.review(id, body) });
            if (action === 'plan') return json(200, { job: await service.generatePlan(id, body) });
            if (action === 'reconcile') return json(200, { job: service.reconcile(id, body) });
            if (action === 'complete-manual') return json(200, { job: service.completeManual(id, body) });
          }
        }
        throw new AppError(404, '接口或任务不存在。');
      }
      // The one-page reimbursement is the only UI.
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { Location: PAGE_PATH });
        return res.end();
      }
      const file = STATIC_FILES[url.pathname];
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
  server.on('close', () => service.shutdown());
  return { server, service, store };
}

function applyHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
