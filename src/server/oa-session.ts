import { AppError } from '../domain/job';
import { establishBpmSession, HttpLoginError, IDS_ORIGIN, loginWithPassword, OaHttpClient } from '../automation/http-login';
import { CreateReimbursementError, openOwnerQueryHttp, searchOwnerHttp, type QueryDocument } from '../automation/http-bpm';
import { OpenReimbursementError } from '../automation/open-reimbursement';
import { ReimbursementListError } from '../automation/reimbursement-list';
import { FundingSearchError } from '../automation/funding-search';
import { BudgetSearchError } from '../automation/budget-search';
import { TaskSearchError } from '../automation/task-search';
import { InvoiceClaimError } from '../automation/invoice-claim';
import { PrintError } from '../automation/http-print';
import { PayeeError } from '../automation/http-payee';

export interface LoginHooks {
  client?: OaHttpClient;
  /** Called only when CAS asks for a captcha; resolves with the user's answer. */
  solveCaptcha?: (image: Buffer) => Promise<string>;
}
export type PasswordLogin = (username: string, password: string, hooks?: LoginHooks) => Promise<OaHttpClient>;

const CAPTCHA_WAIT_MS = 3 * 60_000;
const CAPTCHA_ANSWER = /^[A-Za-z0-9]{1,10}$/;

function captchaImage(bytes: Buffer): string {
  const type = bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg'
    : bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : '';
  if (!type || bytes.length > 200_000) throw new HttpLoginError('login_page_unrecognized', '验证码图片');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

export function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '请求格式无效。');
  return body as Record<string, unknown>;
}

/** Each login runs the full CAS → portal → BPM exchange on the server and replaces
 * any previous school session. The password is used only for that exchange. */
export const defaultLogin: PasswordLogin = async (username, password, hooks = {}) => {
  const client = await loginWithPassword({ username, password, ...hooks });
  await establishBpmSession(client);
  return client;
};

export interface LoginEvidence { at: string; userAccount: string; userName: string; savedPassword: boolean; steps: string[] }

export interface SavedCredentials { username: string; password: string }

/** OA_USERNAME / OA_PASSWORD from .env, for test use; the password never leaves the server. */
export function savedCredentials(env: NodeJS.ProcessEnv = process.env): SavedCredentials | undefined {
  const username = env.OA_USERNAME?.trim() ?? '', password = env.OA_PASSWORD ?? '';
  return /^\w{1,32}$/.test(username) && password && password.length <= 128 ? { username, password } : undefined;
}

/** What every 报销类型's server module borrows from the one school login (see docs/architecture.md):
 * the session, its request queue, the reading session, the end of a login, and 报销单查询 as receipt. */
export interface FormHost {
  session(): OaHttpClient;
  /** The login's client, or undefined once it has ended. */
  current(): OaHttpClient | undefined;
  serial<T>(task: () => Promise<T>): Promise<T>;
  read<T>(task: (client: OaHttpClient, page: QueryDocument) => Promise<T>): Promise<T>;
  reset(): void;
  fail(error: unknown): never;
  ownerStatus(client: OaHttpClient, billCode: string, until?: string): Promise<{ status: string; amount: string } | undefined>;
}

/** One school session per local server, held only in memory: login (with the CAS captcha), the request
 * queue every write waits in, and a second BPM session for read-only queries. No 报销类型 logic. */
export class OaSession implements FormHost {
  protected client?: OaHttpClient;
  protected login?: LoginEvidence;
  private direct?: QueryDocument;
  /** Read-only page queries (funds, budgets, blank forms, folders, printing) run on a second BPM
   * session of the same school login, with a queue of their own, so they never wait for a job that
   * holds the main session for minutes. `shared` = no second session could be opened. */
  private reader?: OaHttpClient;
  private shared = false;
  private readQueue: Promise<unknown> = Promise.resolve();
  /** A login paused on the CAS captcha; the password stays only in that login's closure. */
  private captcha?: { client: OaHttpClient; login: Promise<OaHttpClient>; savedPassword: boolean;
    answer: (text: string) => void; cancel: (error: Error) => void; timer: NodeJS.Timeout };
  /** BPM answers overlapping requests on one session with "登录超时" (live 2026-10-15),
   * so every call to it waits for the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly signInWith: PasswordLogin = defaultLogin,
    protected readonly saved: SavedCredentials | undefined = savedCredentials()) {}

  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A read-only task on the reading session with its 报销单查询 page (ST00 用款申请单 context).
   * A session OA has dropped is opened again once; without a second session, the main one serves. */
  read<T>(task: (client: OaHttpClient, page: QueryDocument) => Promise<T>): Promise<T> {
    if (this.shared) return this.serial(async () => task(this.session(), await this.readPage(this.session())));
    const run = async () => {
      if (!this.reader) {
        const reader = this.session().fork();
        try { this.direct = await this.readPage(reader, true); }
        catch {
          // The CAS login did not open a second BPM session: fall back to the main one.
          this.shared = true;
          return this.serial(async () => task(this.session(), await this.readPage(this.session(), true)));
        }
        this.reader = reader;
      }
      return task(this.reader, await this.readPage(this.reader));
    };
    const job = this.readQueue.then(() => run().catch(error => {
      if ((error as { code?: string })?.code !== 'authentication' || !this.reader) throw error;
      this.reader = undefined;
      this.direct = undefined;
      return run();
    }));
    this.readQueue = job.catch(() => undefined);
    return job;
  }

  private async readPage(client: OaHttpClient, fresh = false): Promise<QueryDocument> {
    if (fresh) this.direct = undefined;
    this.direct ??= { ...await openOwnerQueryHttp(client), context: { accountBook: 'ST00', reimbursementKind: 'applyMoney' } };
    return this.direct;
  }

  session(): OaHttpClient {
    if (!this.client) throw new AppError(401, '请先登录学校 OA。');
    return this.client;
  }

  current(): OaHttpClient | undefined {
    return this.client;
  }

  /** Ends the login; what each 报销类型 keeps of it is dropped in onReset. */
  reset(): void {
    this.dropCaptcha();
    this.client = undefined;
    this.login = undefined;
    this.direct = undefined;
    this.reader = undefined;
    this.shared = false;
    this.onReset();
  }

  protected onReset(): void {}

  fail(error: unknown): never {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string })?.code === 'authentication') {
      this.reset();
      throw new AppError(401, '学校 OA 登录已失效，请重新登录。');
    }
    if (error instanceof HttpLoginError || error instanceof CreateReimbursementError || error instanceof OpenReimbursementError
      || error instanceof ReimbursementListError || error instanceof FundingSearchError || error instanceof BudgetSearchError
      || error instanceof TaskSearchError || error instanceof InvoiceClaimError || error instanceof PrintError || error instanceof PayeeError) {
      throw new AppError(error instanceof HttpLoginError && error.code === 'credentials_rejected' ? 401 : 502, error.message);
    }
    throw new AppError(502, '学校 OA 请求未完成，请检查校园网络/VPN 后重试。');
  }

  status(): Record<string, unknown> {
    return { loggedIn: Boolean(this.client), login: this.login ?? null, savedUsername: this.saved?.username ?? null };
  }

  private dropCaptcha(): void {
    if (!this.captcha) return;
    clearTimeout(this.captcha.timer);
    this.captcha.cancel(new AppError(409, '登录已取消，请重新登录。'));
    this.captcha = undefined;
  }

  /** Second half of a login that stopped on the captcha. */
  private async answerCaptcha(answer: unknown) {
    const pending = this.captcha;
    if (!pending) throw new AppError(409, '验证码已失效，请重新点击登录。');
    if (typeof answer !== 'string' || !CAPTCHA_ANSWER.test(answer.trim())) throw new AppError(400, '请输入图片中的验证码。');
    clearTimeout(pending.timer);
    this.captcha = undefined;
    pending.answer(answer.trim());
    return this.finishLogin(pending.login, pending.savedPassword);
  }

  async refreshCaptcha() {
    const pending = this.captcha;
    if (!pending) throw new AppError(409, '验证码已失效，请重新点击登录。');
    try {
      const image = await pending.client.request(`${IDS_ORIGIN}/authserver/getCaptcha.htl?${Date.now()}`);
      return { captcha: { image: captchaImage(image.bytes) } };
    } catch (error) { this.fail(error); }
  }

  private async finishLogin(login: Promise<OaHttpClient>, savedPassword: boolean) {
    try {
      const client = await login;
      if (!client.account) throw new HttpLoginError('portal_unverified');
      this.client = client;
      this.login = { at: new Date().toISOString(), userAccount: client.account.userAccount, userName: client.account.userName,
        savedPassword,
        steps: ['统一身份认证（CAS）接受账号密码并签发登录票据', `门户 getLoginUser 确认账号 ${client.account.userAccount}`,
          'BPM 报销系统单点登录完成并取得页面令牌'] };
      return this.status();
    } catch (error) { this.fail(error); }
  }

  async signIn(body: unknown) {
    const input = record(body);
    if (input.captcha !== undefined) return this.answerCaptcha(input.captcha);
    const useSaved = input.useSaved === true;
    if (useSaved && !this.saved) throw new AppError(400, '.env 中没有设置 OA_USERNAME / OA_PASSWORD。');
    const username = useSaved ? this.saved!.username : input.username;
    const password = useSaved ? this.saved!.password : input.password;
    if (typeof username !== 'string' || !/^\w{1,32}$/.test(username.trim()) || typeof password !== 'string'
      || !password || password.length > 128) throw new AppError(400, '请输入学号/工号和密码。');
    this.reset();
    const client = new OaHttpClient();
    let asked!: (image: Buffer) => void, answer!: (text: string) => void, cancel!: (error: Error) => void;
    const askedFor = new Promise<Buffer>(resolve => { asked = resolve; });
    const answered = new Promise<string>((resolve, reject) => { answer = resolve; cancel = reject; });
    const login = this.signInWith(username.trim(), password, { client, solveCaptcha: image => { asked(image); return answered; } });
    login.catch(() => undefined);
    const first = await Promise.race([login.then(() => undefined), askedFor]).catch(error => this.fail(error));
    if (!first) return this.finishLogin(login, useSaved);
    let image: string;
    try { image = captchaImage(first); } catch (error) {
      cancel(error as Error);
      this.fail(error);
    }
    const timer = setTimeout(() => {
      if (this.captcha?.login !== login) return;
      this.captcha = undefined;
      cancel(new AppError(409, '验证码等待超时，请重新登录。'));
    }, CAPTCHA_WAIT_MS);
    timer.unref?.();
    this.captcha = { client, login, savedPassword: useSaved, answer, cancel, timer };
    return { ...this.status(), captcha: { image } };
  }

  signOut() {
    this.reset();
    return this.status();
  }

  /** 报销单查询 status and amount of one bill; `until` polls briefly for a status change. */
  async ownerStatus(client: OaHttpClient, billCode: string, until?: string, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
    for (let attempt = 0; ; attempt++) {
      const page = await openOwnerQueryHttp(client);
      const { list } = await searchOwnerHttp(client, page, { billCode });
      const matches = list.rows.filter(row => row.billCode === billCode);
      const row = matches.length === 1 ? { status: matches[0].statusText, amount: matches[0].reimbursementAmount } : undefined;
      if (!until || row?.status === until || attempt >= 2) return row;
      await sleep(2000);
    }
  }
}
