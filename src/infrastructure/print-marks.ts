import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

/** Bills remembered per account, the newest kept. */
const MARKS_MAX = 1000;

interface MarksFile { version: 1; accounts: Record<string, Record<string, string>> }

/** Which bills each account has clicked 打印 for (报销单打印's 已点击打印), kept in <OA_DATA_DIR>/print-marks so a
 * restart, a new login or a new 打印文件 keeps it. Stored: OA's internal bill id and when, under a keyed hash of the
 * account (the key, `salt`, never leaves this directory); no account, name, bill number or amount. */
export class PrintMarks {
  private data: MarksFile;
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dir: string, private readonly now = () => new Date()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'marks.json');
    const saltFile = path.join(dir, 'salt');
    if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    this.key = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex');
    this.data = this.load();
  }

  private load(): MarksFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as MarksFile;
      if (data.version === 1 && data.accounts && typeof data.accounts === 'object') return data;
    } catch { /* missing or unreadable: start over */ }
    return { version: 1, accounts: {} };
  }

  private save(): void {
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  private who(account: string): string {
    return createHmac('sha256', this.key).update(account.trim().toLowerCase()).digest('hex').slice(0, 24);
  }

  has(account: string, bizId: string): boolean {
    return Object.hasOwn(this.data.accounts[this.who(account)] ?? {}, bizId);
  }

  /** Remembers the first click; a write that fails is dropped (printing goes on). */
  mark(account: string, bizId: string): void {
    const marks = this.data.accounts[this.who(account)] ??= {};
    if (Object.hasOwn(marks, bizId)) return;
    marks[bizId] = this.now().toISOString();
    const ids = Object.keys(marks);
    if (ids.length > MARKS_MAX) for (const id of ids.sort((a, b) => marks[a].localeCompare(marks[b])).slice(0, ids.length - MARKS_MAX)) delete marks[id];
    try { this.save(); } catch { /* ignore */ }
  }
}
