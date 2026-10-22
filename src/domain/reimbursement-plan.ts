import { createHash } from 'node:crypto';
import { AppError, object, parseInput, type Job, type ReimbursementInput } from './job';

export interface PlanDraft {
  input: Omit<ReimbursementInput, 'payeeCode' | 'formMode' | 'reimbursementType'>;
  summary: string;
  concerns: string[];
}
export interface PlanReference { version: number; file: string; sha256: string }
export interface ReimbursementPlan {
  schemaVersion: 1;
  version: number;
  jobId: string;
  createdAt: string;
  source: 'deepseek';
  action: 'save' | 'submit';
  input: ReimbursementInput;
  invoice: NonNullable<Job['invoice']> & { fileRef: 'invoice.pdf' };
  review: { summary: string; concerns: string[] };
}

/** Only these business fields leave the machine. No file paths, invoice IDs, payee or PDF. */
export function planBusinessInput(input: ReimbursementInput): PlanDraft['input'] {
  return { purpose: input.purpose, reason: input.reason, amount: input.amount,
    attachmentCount: input.attachmentCount, fundingKindKeyword: input.fundingKindKeyword || '被授权的项目',
    fundingKeyword: input.fundingKeyword, budgetKeyword: input.budgetKeyword };
}

export function validatePlanDraft(value: unknown, input: ReimbursementInput): PlanDraft {
  try {
    const data = object(value);
    const proposed = object(data.input);
    const expected = planBusinessInput(input);
    if (Object.keys(data).sort().join() !== 'concerns,input,summary'
      || Object.keys(proposed).sort().join() !== Object.keys(expected).sort().join()
      || Object.entries(expected).some(([key, value]) => proposed[key] !== value)
      || typeof data.summary !== 'string' || !data.summary.trim() || data.summary.length > 2000
      || !Array.isArray(data.concerns) || data.concerns.length > 20
      || data.concerns.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)) {
      throw new Error('Invalid plan');
    }
    return { input: expected, summary: data.summary, concerns: data.concerns as string[] };
  } catch {
    throw new AppError(502, 'DeepSeek 返回的方案格式无效或改动了已填写参数，未保存本次方案。');
  }
}

export function buildPlan(job: Job, draft: PlanDraft, version: number): ReimbursementPlan {
  if (!job.invoice || job.mode !== 'live') throw new AppError(400, '请先上传发票并创建真实 OA 草稿。');
  const validated = validatePlanDraft(draft, job.input);
  return { schemaVersion: 1, version, jobId: job.id, source: 'deepseek', createdAt: new Date().toISOString(),
    action: job.action || 'save', input: parseInput({ ...job.input, ...validated.input }),
    invoice: { ...job.invoice, fileRef: 'invoice.pdf' },
    review: { summary: validated.summary, concerns: validated.concerns } };
}

export const planHash = (json: string): string => createHash('sha256').update(json).digest('hex');

/** Bind a persisted plan to the task; model output cannot choose selectors or files. */
export function validateStoredPlan(value: unknown, job: Job): ReimbursementPlan {
  try {
    const plan = object(value);
    const parsedInput = parseInput(plan.input);
    if (Object.keys(plan).sort().join() !== 'action,createdAt,input,invoice,jobId,review,schemaVersion,source,version'
      || Object.keys(object(plan.input)).sort().join() !== Object.keys(parsedInput).sort().join()
      || Object.entries(parsedInput).some(([key, value]) => object(plan.input)[key] !== value)
      || plan.schemaVersion !== 1 || plan.source !== 'deepseek' || plan.jobId !== job.id
      || plan.version !== job.plan?.version || plan.action !== (job.action || 'save')
      || !job.invoice || typeof plan.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt))
      || JSON.stringify(parsedInput) !== JSON.stringify(parseInput(job.input))) throw new Error('Mismatch');
    const invoice = object(plan.invoice);
    if (invoice.fileRef !== 'invoice.pdf'
      || Object.keys(invoice).sort().join() !== Object.keys({ ...job.invoice, fileRef: 'invoice.pdf' }).sort().join()
      || Object.entries(job.invoice).some(([key, value]) => invoice[key] !== value)) throw new Error('Invoice mismatch');
    const review = object(plan.review);
    if (Object.keys(review).sort().join() !== 'concerns,summary') throw new Error('Invalid review');
    validatePlanDraft({ input: planBusinessInput(parsedInput), ...review }, job.input);
    return plan as unknown as ReimbursementPlan;
  } catch { throw new AppError(409, '报销 JSON 与当前任务不一致，请重新核对方案；未启动 OA。'); }
}
