import { appendFileSync, openSync, closeSync } from 'fs';
import type { BrowserContext, Request } from 'playwright';

const BPM_HOST = 'sapbpm-new.shanghaitech.edu.cn';
const STATIC = /\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(?:$|\?)/i;
const KEPT_HEADERS = ['content-type', 'accept', 'x-requested-with', 'csrftoken', 'proctaskid', 'referer', 'origin'];
const MAX_BODY = 200_000;

/** Tokens rotate per session; record where they appear, never their values. */
function scrub(text: string, secrets: Set<string>): string {
  let result = text;
  for (const secret of secrets) if (secret.length >= 16) result = result.split(secret).join('[REDACTED]');
  return result.replace(/(ticket=)ST-[\w.-]+/g, '$1[REDACTED]');
}

function postBody(request: Request): unknown {
  const type = request.headers()['content-type'] || '';
  const buffer = request.postDataBuffer();
  if (!buffer) return undefined;
  if (/multipart\/form-data/i.test(type)) {
    // Keep text fields and file metadata; drop file bytes.
    const text = buffer.toString('latin1');
    const parts = text.split(/--[^\r\n]+\r\n/).filter(Boolean).map(part => {
      const [head, ...rest] = part.split('\r\n\r\n');
      const name = head.match(/name="([^"]*)"/)?.[1];
      const filename = head.match(/filename="([^"]*)"/)?.[1];
      const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
      return filename !== undefined
        ? { name, filename: Buffer.from(filename, 'latin1').toString('utf8'), bytes: body.length }
        : { name, value: Buffer.from(body, 'latin1').toString('utf8').slice(0, 2000) };
    }).filter(part => part.name);
    return { multipart: parts };
  }
  return buffer.toString('utf8').slice(0, MAX_BODY);
}

/** Opt-in (OA_NETWORK_CAPTURE_FILE): every non-static BPM request and its response,
 * one JSON line each, so browser steps can be replayed as plain HTTP. */
export function attachNetworkCapture(context: BrowserContext, file: string): void {
  closeSync(openSync(file, 'a', 0o600));
  const secrets = new Set<string>();
  const started = new Map<Request, number>();
  let seq = 0;
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== BPM_HOST || STATIC.test(url.pathname)) return;
    started.set(request, Date.now());
    const token = request.headers().csrftoken;
    if (token) secrets.add(token);
  });
  context.on('requestfinished', async request => {
    const at = started.get(request);
    if (at === undefined) return;
    started.delete(request);
    const response = await request.response().catch(() => null);
    const headers = request.headers();
    const type = response?.headers()['content-type'] || '';
    let body: string | undefined;
    if (response && /json|text|html|javascript/i.test(type)) {
      body = (await response.text().catch(() => '')).slice(0, MAX_BODY);
    }
    for (const match of (body || '').matchAll(/id=["']csrfTokenElement["'][^>]*value=["']([^"']+)/gi)) secrets.add(match[1]);
    const entry = {
      seq: ++seq, at: new Date(at).toISOString(), ms: Date.now() - at, frame: request.frame()?.url().split('?')[0],
      method: request.method(), url: request.url(), resourceType: request.resourceType(),
      headers: Object.fromEntries(KEPT_HEADERS.filter(key => headers[key]).map(key => [key, headers[key]])),
      body: postBody(request), status: response?.status(), responseType: type, response: body,
    };
    appendFileSync(file, `${scrub(JSON.stringify(entry), secrets)}\n`);
  });
}
