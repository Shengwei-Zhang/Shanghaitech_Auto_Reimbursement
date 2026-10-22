import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Job } from '../domain/job';

/** Local single-process repository. Replace this boundary with transactional SQL for deployment. */
export class JobStore {
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError(404, '任务不存在。');
    return path.join(this.root, id);
  }

  list(ownerId: string): Job[] {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)
        && fs.existsSync(path.join(this.root, entry.name, 'job.json')))
      .map(entry => this.read(entry.name))
      .filter(job => job.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private read(id: string): Job {
    const file = path.join(this.directory(id), 'job.json');
    if (!fs.existsSync(file)) throw new AppError(404, '任务不存在。');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
  }

  get(id: string, ownerId: string): Job {
    const job = this.read(id);
    if (job.ownerId !== ownerId) throw new AppError(404, '任务不存在。');
    return job;
  }

  save(job: Job): void {
    const dir = this.directory(job.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `job.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(temp, path.join(dir, 'job.json'));
  }

  update(id: string, ownerId: string, update: (job: Job) => void): Job {
    const job = this.get(id, ownerId);
    update(job);
    job.updatedAt = new Date().toISOString();
    this.save(job);
    return job;
  }

  recover(ownerId: string): void {
    for (const job of this.list(ownerId)) {
      if (['running', 'queued', 'waiting_manual', 'waiting_review'].includes(job.status)) {
        this.update(job.id, ownerId, current => {
          current.status = 'interrupted';
          current.events.push({ at: new Date().toISOString(), message: '服务重启，任务已中断。请核对 OA 现有单据；系统不会自动重放。' });
        });
      }
    }
  }
}
