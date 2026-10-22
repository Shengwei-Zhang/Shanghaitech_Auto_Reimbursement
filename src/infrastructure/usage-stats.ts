import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

/** What became of one form the page sent: saved only, submitted (报销单查询 shows 提交), unclear, failed, stopped. */
export type FormOutcome = 'saved' | 'submitted' | 'needs_review' | 'failed' | 'cancelled';
export const FORM_OUTCOMES: FormOutcome[] = ['saved', 'submitted', 'needs_review', 'failed', 'cancelled'];

interface FormCounts { started: number; saved: number; submitted: number; needs_review: number; failed: number; cancelled: number }
interface Day {
  /** Keyed account hashes of who logged in / sent a form that day. */
  users: string[];
  formUsers: string[];
  logins: number;
  captchas: number;
  loginFailures: Record<string, number>;
  forms: Record<string, FormCounts>;
  /** Most browsers online at once that day. */
  peakOnline: number;
}
interface StatsFile { version: 1; since: string; users: string[]; formUsers: string[]; days: Record<string, Day> }

const blankForms = (): FormCounts => ({ started: 0, saved: 0, submitted: 0, needs_review: 0, failed: 0, cancelled: 0 });
const blankDay = (): Day => ({ users: [], formUsers: [], logins: 0, captchas: 0, loginFailures: {}, forms: {}, peakOnline: 0 });
/** Days in China time, as OA and its users count them. */
const dayOf = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Usage counts for the administrator, kept in <OA_DATA_DIR>/stats. No account, name, bill number or amount is
 * stored: a user is counted by a keyed hash of their account (the key, `salt`, never leaves this directory). */
export class UsageStats {
  private data: StatsFile;
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dir: string, private readonly now = () => new Date()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'stats.json');
    const saltFile = path.join(dir, 'salt');
    if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    this.key = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex');
    this.data = this.load();
  }

  private load(): StatsFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StatsFile;
      if (data.version === 1 && data.days && Array.isArray(data.users)) return { ...data, formUsers: data.formUsers ?? [] };
    } catch { /* missing or unreadable: start over */ }
    return { version: 1, since: this.now().toISOString(), users: [], formUsers: [], days: {} };
  }

  private save(): void {
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  /** The keyed hash a user is counted by. */
  private who(account: string): string {
    return createHmac('sha256', this.key).update(account.trim().toLowerCase()).digest('hex').slice(0, 24);
  }

  private today(): Day {
    const key = dayOf(this.now());
    this.data.days[key] ??= blankDay();
    return this.data.days[key];
  }

  private record(change: (day: Day) => void): void {
    // Statistics never get in the way of a reimbursement: a write that fails is dropped.
    try { change(this.today()); this.save(); } catch { /* ignore */ }
  }

  login(account: string): void {
    const user = this.who(account);
    this.record(day => {
      day.logins++;
      if (!day.users.includes(user)) day.users.push(user);
      if (!this.data.users.includes(user)) this.data.users.push(user);
    });
  }

  captcha(): void {
    this.record(day => { day.captchas++; });
  }

  loginFailed(code: string): void {
    const key = /^[a-z_]{1,40}$/.test(code) ? code : 'other';
    this.record(day => { day.loginFailures[key] = (day.loginFailures[key] ?? 0) + 1; });
  }

  formStarted(type: string, account: string | undefined): void {
    const user = account ? this.who(account) : undefined;
    this.record(day => {
      (day.forms[type] ??= blankForms()).started++;
      if (user && !day.formUsers.includes(user)) day.formUsers.push(user);
      if (user && !this.data.formUsers.includes(user)) this.data.formUsers.push(user);
    });
  }

  formFinished(type: string, outcome: FormOutcome): void {
    this.record(day => { (day.forms[type] ??= blankForms())[outcome]++; });
  }

  /** The number online now; kept as the day's peak when it is higher. */
  online(count: number): void {
    const day = this.today();
    if (count <= day.peakOnline) return;
    this.record(current => { current.peakOnline = Math.max(current.peakOnline, count); });
  }

  /** Totals since the first record and the last `days` days, newest first; no hash leaves this method. */
  report(days = 30) {
    const keys = Object.keys(this.data.days).sort().reverse();
    const sum = (pick: (day: Day) => number) => keys.reduce((total, key) => total + pick(this.data.days[key]), 0);
    const types = [...new Set(keys.flatMap(key => Object.keys(this.data.days[key].forms)))];
    const formsOf = (list: Day[]) => Object.fromEntries(types.map(type => [type, Object.fromEntries((Object.keys(blankForms()) as Array<keyof FormCounts>)
      .map(field => [field, list.reduce((total, day) => total + (day.forms[type]?.[field] ?? 0), 0)]))]));
    const failures: Record<string, number> = {};
    for (const key of keys) for (const [code, count] of Object.entries(this.data.days[key].loginFailures)) failures[code] = (failures[code] ?? 0) + count;
    return {
      since: this.data.since,
      totals: { users: this.data.users.length, formUsers: this.data.formUsers.length, logins: sum(day => day.logins), captchas: sum(day => day.captchas),
        loginFailures: failures, forms: formsOf(keys.map(key => this.data.days[key])),
        peakOnline: Math.max(0, ...keys.map(key => this.data.days[key].peakOnline)) },
      days: keys.slice(0, days).map(key => {
        const day = this.data.days[key];
        return { date: key, users: day.users.length, formUsers: day.formUsers.length, logins: day.logins, captchas: day.captchas,
          loginFailures: day.loginFailures, forms: formsOf([day]), peakOnline: day.peakOnline };
      }),
    };
  }
}
