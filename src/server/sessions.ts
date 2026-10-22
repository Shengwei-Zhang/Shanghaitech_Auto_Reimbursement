import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../domain/job';
import type { OaApi } from './oa-api';

/** One browser: its cookie secret, its CSRF token and its own OaApi (school login, request queues, lists,
 * 差旅单 run). Nothing in one session is visible from another. */
export interface BrowserSession {
  /** Value of the oa_session cookie. */
  id: string;
  csrf: string;
  api: OaApi;
  lastSeen: number;
}

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Browser sessions held in memory. 'local' keeps exactly one, shared by every tab of the one user, as before;
 * 'server' gives each browser its own, dropped after `idleMs` or when `max` is reached (oldest idle first). */
export class SessionRegistry {
  private sessions = new Map<string, BrowserSession>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly makeApi: () => OaApi, private readonly options: { shared: boolean; idleMs: number; max: number },
    private readonly now = () => Date.now()) {
    if (options.shared) this.add();
    else {
      this.sweeper = setInterval(() => this.sweep(), Math.min(60_000, options.idleMs));
      this.sweeper.unref();
    }
  }

  private add(): BrowserSession {
    const session = { id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), api: this.makeApi(), lastSeen: this.now() };
    this.sessions.set(session.id, session);
    return session;
  }

  /** The browser's session for a page load (GET /api/session): the one it has, or a new one. */
  open(cookie: string): BrowserSession {
    const known = this.find(cookie);
    if (known) return known;
    if (this.options.shared) return [...this.sessions.values()][0];
    this.sweep();
    if (this.sessions.size >= this.options.max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.drop(oldest);
    }
    return this.add();
  }

  /** The session of an API call; the cookie must name a live one. */
  require(cookie: string): BrowserSession {
    const session = this.find(cookie);
    if (!session) throw new AppError(401, '本地会话已失效，请刷新页面。');
    return session;
  }

  private find(cookie: string): BrowserSession | undefined {
    if (!/^[0-9a-f]{64}$/.test(cookie)) return undefined;
    // Compared in constant time against each id; a map lookup alone would be enough, but leaks nothing either way.
    let found: BrowserSession | undefined;
    for (const session of this.sessions.values()) if (equalSecret(session.id, cookie)) found = session;
    if (!found) return undefined;
    if (!this.options.shared && this.now() - found.lastSeen > this.options.idleMs) {
      this.drop(found);
      return undefined;
    }
    found.lastSeen = this.now();
    return found;
  }

  private drop(session: BrowserSession): void {
    this.sessions.delete(session.id);
    // The school login ends with it; a run still going finishes on its own.
    session.api.signOut();
  }

  /** Sessions idle past the limit end, with their school logins. */
  sweep(): void {
    for (const session of [...this.sessions.values()]) if (this.now() - session.lastSeen > this.options.idleMs) this.drop(session);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Every session's OaApi (e.g. to find the one a job belongs to). */
  apis(): OaApi[] {
    return [...this.sessions.values()].map(session => session.api);
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }
}
