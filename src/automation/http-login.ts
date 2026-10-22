import { createCipheriv, randomInt } from 'node:crypto';
import type { StorageState } from './session-state';

export const IDS_ORIGIN = 'https://ids.shanghaitech.edu.cn';
export const EGATE_ORIGIN = 'https://egate-new.shanghaitech.edu.cn';
export const EGATE_SERVICE = `${EGATE_ORIGIN}/login`;
export const BPM_OWNER_QUERY_URL = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do';
const OA_HOSTS = new Set(['ids.shanghaitech.edu.cn', 'egate-new.shanghaitech.edu.cn', 'sapbpm-new.shanghaitech.edu.cn']);
const BPM_HOST = 'sapbpm-new.shanghaitech.edu.cn';
const COOKIE_DOMAIN = /(?:^|\.)shanghaitech\.edu\.cn$/;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const AES_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

const errors = {
  login_page_unrecognized: '统一身份认证登录页结构无法识别（缺少账号密码表单或 pwdEncryptSalt），未提交密码。',
  captcha_required: '统一身份认证要求输入图形验证码；请在交互终端运行以便输入验证码。',
  credentials_rejected: '统一身份认证拒绝了账号或密码。',
  additional_verification_required: '统一身份认证要求额外验证（多因素/二次认证等），无浏览器登录无法继续；请改用浏览器手动登录。',
  unexpected_redirect: '登录过程中出现了指向非学校 OA 地址的跳转，已停止。',
  too_many_redirects: '登录过程中跳转次数过多，已停止。',
  portal_unverified: '门户没有确认当前登录账号，未将其视为登录成功。',
  bpm_unverified: 'BPM 单点登录后没有到达“报销单查询”页面，未将其视为登录成功。',
  request_failed: '学校认证服务器请求未完成；请检查校园网络/VPN。',
  http_error: '学校认证服务器返回了异常的 HTTP 状态。',
} as const;

export class HttpLoginError extends Error {
  constructor(readonly code: keyof typeof errors, readonly detail?: string) {
    super(detail ? `${errors[code]}（${detail}）` : errors[code]);
    this.name = 'HttpLoginError';
  }
}

interface Cookie {
  name: string; value: string; domain: string; hostOnly: boolean; path: string;
  secure: boolean; httpOnly: boolean; sameSite: 'Strict' | 'Lax' | 'None'; expires: number;
}

/** Minimal RFC 6265 jar limited to shanghaitech.edu.cn hosts. */
export class CookieJar {
  private cookies: Cookie[] = [];

  store(url: string, headers: string[], now = Date.now()): void {
    const { hostname, pathname } = new URL(url);
    for (const header of headers) {
      const [pair, ...attributes] = header.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const cookie: Cookie = { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(),
        domain: hostname, hostOnly: true, path: pathname.replace(/\/[^/]*$/, '') || '/', secure: false,
        httpOnly: false, sameSite: 'Lax', expires: -1 };
      let rejected = false;
      for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split('=');
        const key = rawKey.trim().toLowerCase(), value = rest.join('=').trim();
        if (key === 'domain' && value) {
          const domain = value.replace(/^\./, '').toLowerCase();
          if (!COOKIE_DOMAIN.test(domain) || !(hostname === domain || hostname.endsWith(`.${domain}`))) rejected = true;
          else Object.assign(cookie, { domain, hostOnly: false });
        } else if (key === 'path' && value.startsWith('/')) cookie.path = value;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'samesite') {
          const sameSite = value.toLowerCase();
          cookie.sameSite = sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax';
        } else if (key === 'max-age' && /^-?\d+$/.test(value)) cookie.expires = now / 1000 + Number(value);
        else if (key === 'expires' && cookie.expires === -1 && !attributes.some(a => /^\s*max-age=/i.test(a))) {
          const time = Date.parse(value);
          if (Number.isFinite(time)) cookie.expires = time / 1000;
        }
      }
      if (rejected || !COOKIE_DOMAIN.test(cookie.domain)) continue;
      this.cookies = this.cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      if (cookie.expires === -1 || cookie.expires > now / 1000) this.cookies.push(cookie);
    }
  }

  header(url: string, now = Date.now()): string {
    const { hostname, pathname, protocol } = new URL(url);
    return this.cookies
      .filter(c => (c.expires === -1 || c.expires > now / 1000) && (!c.secure || protocol === 'https:')
        && (c.hostOnly ? hostname === c.domain : hostname === c.domain || hostname.endsWith(`.${c.domain}`))
        && (pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)
      .map(c => `${c.name}=${c.value}`).join('; ');
  }

  names(): string[] { return this.cookies.map(c => c.name); }

  /** The cookies that `keep` accepts, in a new jar. */
  copy(keep: (cookie: { name: string; domain: string; path: string }) => boolean): CookieJar {
    const jar = new CookieJar();
    jar.cookies = this.cookies.filter(keep).map(cookie => ({ ...cookie }));
    return jar;
  }

  /** Playwright storageState shape, so a browser can continue this session. */
  toStorageState(): StorageState {
    return { cookies: this.cookies.map(c => ({ name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`,
      path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })), origins: [] };
  }
}

export interface HttpResponse { url: string; status: number; headers: Headers; bytes: Buffer; text: string }
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Cookie-carrying client that follows redirects itself and only within OA hosts. */
export interface OaAccount { userAccount: string; userName: string }

export class OaHttpClient {
  jar = new CookieJar();
  /** Set by loginWithPassword after the portal confirmed the account. */
  account?: OaAccount;
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 20_000) {}

  /** A second client on the same school login: the CAS and portal cookies, without this BPM
   * session, so its first BPM request is issued a ticket and a BPM session of its own. */
  fork(): OaHttpClient {
    const client = new OaHttpClient(this.fetchImpl, this.timeoutMs);
    client.jar = this.jar.copy(cookie => cookie.domain !== BPM_HOST);
    client.account = this.account;
    return client;
  }

  /** followRedirects=false returns a 3xx as is (an API redirect means the session is gone). */
  async request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array;
    maxRedirects?: number; followRedirects?: boolean } = {}): Promise<HttpResponse> {
    let current = url, method = init.method ?? 'GET', headers = init.headers ?? {};
    let body: string | Uint8Array | undefined = init.body;
    for (let hop = 0; hop <= (init.maxRedirects ?? 10); hop++) {
      const target = new URL(current);
      if (target.protocol !== 'https:' || !OA_HOSTS.has(target.hostname)) {
        throw new HttpLoginError('unexpected_redirect', `${target.host}${target.pathname}`);
      }
      const cookie = this.jar.header(current);
      let response: Response;
      try {
        response = await this.fetchImpl(current, { method, body: body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
          headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9', ...headers, ...(cookie ? { cookie } : {}) } });
      } catch {
        throw new HttpLoginError('request_failed', `${target.host}${target.pathname}`);
      }
      this.jar.store(current, response.headers.getSetCookie());
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location && init.followRedirects !== false) {
        await response.arrayBuffer().catch(() => undefined);
        current = new URL(location, current).href;
        if (response.status !== 307 && response.status !== 308) { method = 'GET'; body = undefined; headers = {}; }
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { url: current, status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
    }
    throw new HttpLoginError('too_many_redirects');
  }
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

export function htmlInputs(html: string): Record<string, string>[] {
  return [...html.matchAll(/<input\b[^>]*>/gi)].map(match => attributes(match[0]));
}

export interface PasswordLoginForm { fields: Record<string, string>; salt: string }

/** The account/password form (#pwdFromId) of the Wisedu CAS login page. */
export function parsePasswordLoginForm(html: string): PasswordLoginForm | undefined {
  const form = html.match(/<form\b[^>]*\bid=["']pwdFromId["'][^>]*>([\s\S]*?)<\/form>/i)?.[1];
  if (!form) return undefined;
  const fields: Record<string, string> = {};
  let salt = '';
  for (const input of htmlInputs(form)) {
    if (input.id === 'pwdEncryptSalt') salt = input.value ?? '';
    if (input.type === 'hidden' && input.name && input.name !== 'password') fields[input.name] = input.value ?? '';
  }
  if (!fields.execution || fields._eventId !== 'submit' || !fields.cllt || ![16, 24, 32].includes(salt.trim().length)) return undefined;
  return { fields, salt: salt.trim() };
}

export function loginErrorMessage(html: string): string | undefined {
  for (const match of html.matchAll(/id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/(?:span|div|p)>/gi)) {
    const text = match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 200);
  }
  return undefined;
}

function randomString(length: number): string {
  let value = '';
  for (let i = 0; i < length; i++) value += AES_CHARS[randomInt(AES_CHARS.length)];
  return value;
}

/** encrypt.js: AES-CBC/PKCS7(randomString(64) + password, key=salt, iv=randomString(16)), base64. */
export function encryptPassword(password: string, salt: string, random: (length: number) => string = randomString): string {
  const key = Buffer.from(salt.trim(), 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new HttpLoginError('login_page_unrecognized');
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.from(random(16), 'utf8'));
  return Buffer.concat([cipher.update(random(64) + password, 'utf8'), cipher.final()]).toString('base64');
}

export interface PasswordLoginOptions {
  username: string;
  password: string;
  /** Called only when the server requires a captcha; receives the image bytes. */
  solveCaptcha?: (image: Buffer) => Promise<string>;
  client?: OaHttpClient;
}

function serviceLoginUrl(service: string): string {
  return `${IDS_ORIGIN}/authserver/login?service=${encodeURIComponent(service)}`;
}

/** Browserless CAS password login into egate; verified by the portal's own user API. */
export async function loginWithPassword(options: PasswordLoginOptions): Promise<OaHttpClient> {
  const username = options.username.trim();
  if (!username || !options.password) throw new HttpLoginError('credentials_rejected', '账号或密码为空');
  const client = options.client ?? new OaHttpClient();
  const loginUrl = serviceLoginUrl(EGATE_SERVICE);
  const page = await client.request(loginUrl);
  if (new URL(page.url).hostname === 'ids.shanghaitech.edu.cn') {
    const form = parsePasswordLoginForm(page.text);
    if (page.status !== 200 || !form) throw new HttpLoginError('login_page_unrecognized');
    let captcha = '';
    const check = await client.request(`${IDS_ORIGIN}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}&_=${Date.now()}`,
      { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } });
    let needCaptcha: unknown;
    try { needCaptcha = (JSON.parse(check.text) as { isNeed?: unknown }).isNeed; } catch { /* checked below */ }
    if (typeof needCaptcha !== 'boolean') throw new HttpLoginError('login_page_unrecognized', 'checkNeedCaptcha');
    if (needCaptcha) {
      if (!options.solveCaptcha) throw new HttpLoginError('captcha_required');
      const image = await client.request(`${IDS_ORIGIN}/authserver/getCaptcha.htl?${Date.now()}`);
      captcha = (await options.solveCaptcha(image.bytes)).trim();
    }
    const body = new URLSearchParams({ username, password: encryptPassword(options.password, form.salt), captcha,
      _eventId: form.fields._eventId, cllt: form.fields.cllt, dllt: form.fields.dllt ?? 'generalLogin',
      lt: form.fields.lt ?? '', execution: form.fields.execution });
    const result = await client.request(loginUrl, { method: 'POST', body: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (new URL(result.url).hostname === 'ids.shanghaitech.edu.cn') {
      const message = loginErrorMessage(result.text);
      if (message || parsePasswordLoginForm(result.text)) throw new HttpLoginError('credentials_rejected', message);
      throw new HttpLoginError('additional_verification_required');
    }
    if (result.status >= 400) throw new HttpLoginError('http_error', String(result.status));
  }
  client.account = await verifyEgateUser(client, username);
  return client;
}

export async function verifyEgateUser(client: OaHttpClient, username: string): Promise<OaAccount> {
  const response = await client.request(`${EGATE_ORIGIN}/getLoginUser?_t=${Math.random()}`,
    { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', referer: `${EGATE_ORIGIN}/index.html` } });
  let account: unknown, name: unknown;
  try {
    const json = JSON.parse(response.text) as { errcode?: unknown; data?: { userAccount?: unknown; userName?: unknown } };
    if (String(json.errcode) === '0') { account = json.data?.userAccount; name = json.data?.userName; }
  } catch { /* not JSON: login page */ }
  if (typeof account !== 'string' || account.toLowerCase() !== username.trim().toLowerCase()) {
    throw new HttpLoginError('portal_unverified');
  }
  return { userAccount: account, userName: typeof name === 'string' ? name.trim().slice(0, 100) : '' };
}

export interface BpmPage { url: string; html: string; csrfToken: string }

/** BPM is a separate CAS service; the CASTGC in the jar issues its ticket. */
export async function establishBpmSession(client: OaHttpClient, url = BPM_OWNER_QUERY_URL): Promise<BpmPage> {
  const page = await client.request(url);
  const final = new URL(page.url);
  const tokens = htmlInputs(page.text).filter(input => input.id === 'csrfTokenElement').map(input => input.value ?? '');
  if (final.hostname !== 'sapbpm-new.shanghaitech.edu.cn' || page.status !== 200
    || final.pathname.replace(/\/{2,}/g, '/') !== new URL(url).pathname || tokens.length !== 1 || !/^[\dA-F]{32}$/i.test(tokens[0])) {
    throw new HttpLoginError('bpm_unverified');
  }
  return { url: page.url, html: page.text, csrfToken: tokens[0] };
}
