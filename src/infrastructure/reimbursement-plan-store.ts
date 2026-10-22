import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, type Job } from '../domain/job';
import { planHash, validateStoredPlan, type ReimbursementPlan, type PlanReference } from '../domain/reimbursement-plan';

export function writePlan(directory: string, plan: ReimbursementPlan): PlanReference {
  const file = `reimbursement.v${plan.version}.json`;
  const json = JSON.stringify(plan, null, 2) + '\n';
  // Each revision is immutable. An interrupted write never replaces the prior plan.
  fs.writeFileSync(path.join(directory, file), json, { flag: 'wx', mode: 0o600 });
  return { file, version: plan.version, sha256: planHash(json) };
}

export function readPlan(directory: string, job: Job): ReimbursementPlan {
  const ref = job.plan;
  try {
    if (!ref || !Number.isSafeInteger(ref.version) || ref.version < 1
      || ref.file !== `reimbursement.v${ref.version}.json`) throw new Error('Invalid reference');
    const json = fs.readFileSync(path.join(directory, ref.file), 'utf8');
    if (planHash(json) !== ref.sha256) throw new Error('Plan changed');
    const plan = validateStoredPlan(JSON.parse(json), job);
    const invoice = fs.readFileSync(path.join(directory, plan.invoice.fileRef));
    // Hash raw bytes, not text, to match the original PDF inspection.
    if (invoice.length !== plan.invoice.size || createHash('sha256').update(invoice).digest('hex') !== plan.invoice.sha256) {
      throw new Error('Invoice changed');
    }
    return plan;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, '报销 JSON 或发票文件缺失、已改变，请重新核对；未启动 OA。');
  }
}
