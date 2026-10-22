import type { CompletionAction, Failure, SiteProfile, WorkflowResult } from './workflow';
import type { PlanReference } from './reimbursement-plan';

export const STAGES = [
  'authenticate', 'open workbench', 'select reimbursement form', 'create reimbursement form',
  'prepare reimbursement form', 'select funding item', 'attach invoice',
  'configure payment', 'fill reimbursement details', 'save reimbursement',
  'verify saved form', 'prepare submission', 'confirm submission', 'verify submission',
] as const;
export type Stage = typeof STAGES[number];
export type Status = 'draft' | 'queued' | 'running' | 'waiting_manual' | 'waiting_review' | 'submitted' | 'completed' | 'needs_review' | 'failed' | 'cancelled' | 'interrupted' | 'verified' | 'released';
/** An existing form chosen before execution (identity verified again when opened). */
export interface FormTarget { bizId: string; taskId: string; documentNumber: string }
export interface ReimbursementInput {
  reimbursementType?: '用款申请单';
  formMode?: 'new' | 'reuse' | 'target';
  target?: FormTarget;
  fundingKindKeyword?: '被授权的项目' | '我负责的项目';
  purpose: string;
  reason: string;
  /** 个人银行卡: the payee's 学号/工号. 银行汇款: the account name (账户名) of the supplier. */
  payeeCode: string;
  /** Default 'card' (个人银行卡). */
  payeeKind?: 'card' | 'bank';
  /** 银行汇款 only: the chosen supplier (供应商编码) and the 汇款用途. */
  supplierCode?: string;
  remitPurpose?: string;
  fundingKeyword: string;
  budgetKeyword: string;
  amount: string;
  attachmentCount: number;
}
export interface Invoice {
  name: string;
  sha256: string;
  number: string;
  size: number;
  amount?: string;
  seller?: string;
  /** 开票日期 YYYY-MM-DD. */
  date?: string;
  /** Picked from an OA invoice folder instead of uploaded: no PDF is stored (sha256 '' and size 0). */
  folderId?: string;
  /** 可报余额 of a folder invoice, equal to its amount when picked. */
  balance?: string;
}
export interface Finding { level: 'pass' | 'warning' | 'error'; code: string; message: string }
export interface Advisory {
  source: 'deepseek';
  createdAt: string;
  summary: string;
  concerns: string[];
  suggestions: string[];
  question?: string;
}
export interface JobEvent {
  at: string;
  message: string;
  stage?: Stage;
  state?: 'started' | 'completed' | 'skipped';
  evidence?: string;
}
export interface Job {
  id: string;
  ownerId: string;
  mode: 'demo' | 'live';
  action?: CompletionAction;
  loginMode?: 'manual' | 'credentials';
  status: Status;
  createdAt: string;
  updatedAt: string;
  input: ReimbursementInput;
  invoice: Invoice | null;
  /** Further invoices on the same form (invoice-2.pdf, invoice-3.pdf, …); only the HTTP fill attaches them. */
  extraInvoices?: Invoice[];
  checks: Finding[];
  events: JobEvent[];
  advisory?: Advisory;
  plan?: PlanReference;
  result?: WorkflowResult;
  failure?: Failure;
  submissionSummary?: { documentNumber: string; amount: string };
  manualSummary?: { documentNumber: string; amount: string };
}
export const MAX_INVOICES = 10;
export function jobInvoices(job: Pick<Job, 'invoice' | 'extraInvoices'>): Invoice[] {
  return job.invoice ? [job.invoice, ...(job.extraInvoices ?? [])] : [];
}
/** Stored file of the n-th (0-based) invoice in the job directory. */
export function invoiceFileName(index: number): string {
  return index ? `invoice-${index + 1}.pdf` : 'invoice.pdf';
}
export interface Credentials { username: string; password: string }
export interface WorkerRequest { job: Job; credentials?: Credentials; workDir: string; invoicePath: string; siteProfile?: SiteProfile;
  /** Private storageState of a school session established elsewhere, deleted after the run. */
  sessionStateFile?: string;
  /** The target form was already filled and saved over HTTP; the browser only re-reads and submits it. */
  submitOnly?: boolean }
export type WorkerEvent =
  | { type: 'stage'; stage: Stage; state: 'started' | 'completed' | 'skipped'; evidence?: string }
  | { type: 'submission_validated'; summary: { documentNumber: string; amount: string } }
  | { type: 'manual_required'; summary: { documentNumber: string; amount: string } }
  | { type: 'result'; result: WorkflowResult }
  | { type: 'inspection_required'; failure: Failure; stage: string }
  | { type: 'failure'; failure?: Failure };

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '请求格式不正确。');
  return value as Record<string, unknown>;
}

// All business comparisons use integer cents; binary floating point never decides a match.
export function moneyToCents(value: string): number {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(value)) throw new AppError(400, '金额须为正数，最多两位小数、九位整数。');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0) throw new AppError(400, '实报金额必须大于 0。');
  return cents;
}

export function parseInput(value: unknown): ReimbursementInput {
  const data = object(value);
  const read = (key: string, label: string, max = 200): string => {
    const value = data[key];
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
      throw new AppError(400, `${label}不能为空，且不能超过 ${max} 个字符或包含控制字符。`);
    }
    return value.trim();
  };
  if (data.reimbursementType !== undefined && data.reimbursementType !== '用款申请单') throw new AppError(400, '当前仅开放用款申请单。');
  if (data.formMode !== undefined && (typeof data.formMode !== 'string' || !['new', 'reuse', 'target'].includes(data.formMode))) throw new AppError(400, '单据创建方式不正确。');
  let target: FormTarget | undefined;
  if (data.formMode === 'target') {
    const raw = object(data.target);
    if (typeof raw.bizId !== 'string' || !/^[\da-f]{32}$/i.test(raw.bizId)
      || typeof raw.taskId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(raw.taskId)
      || typeof raw.documentNumber !== 'string' || !/^A\d{1,32}$/.test(raw.documentNumber)) throw new AppError(400, '指定的报销单无效。');
    target = { bizId: raw.bizId, taskId: raw.taskId, documentNumber: raw.documentNumber };
  } else if (data.target !== undefined) throw new AppError(400, '只有指定单据模式可以携带目标报销单。');
  const fundingKindKeyword = data.fundingKindKeyword === undefined || data.fundingKindKeyword === ''
    ? '被授权的项目' : read('fundingKindKeyword', '经费类别', 100);
  if (fundingKindKeyword !== '被授权的项目' && fundingKindKeyword !== '我负责的项目') {
    throw new AppError(400, '经费类别只能选择被授权的项目或我负责的项目。');
  }
  const purpose = read('purpose', '报销用途');
  if (data.reason !== undefined && typeof data.reason !== 'string') throw new AppError(400, '报销说明格式不正确。');
  const rawReason = typeof data.reason === 'string' ? data.reason.trim() : '';
  const reason = rawReason || purpose;
  if (reason.length > 1000 || /[\u0000-\u001f]/.test(reason)) throw new AppError(400, '报销说明不能超过 1000 个字符或包含控制字符。');
  if (data.payeeKind !== undefined && data.payeeKind !== 'card' && data.payeeKind !== 'bank') throw new AppError(400, '收款方式不正确。');
  const bank = data.payeeKind === 'bank';
  const payeeCode = read('payeeCode', bank ? '银行转账户名' : '收款人学号/工号', bank ? 100 : 32);
  if (!bank && !/^[a-zA-Z0-9_-]{2,32}$/.test(payeeCode)) throw new AppError(400, '收款人学号/工号格式不正确。');
  let payment: Pick<ReimbursementInput, 'payeeKind' | 'supplierCode' | 'remitPurpose'> = {};
  if (bank) {
    if (payeeCode.length < 2) throw new AppError(400, '银行转账户名至少 2 个字符。');
    if (typeof data.supplierCode !== 'string' || !/^\d{1,20}$/.test(data.supplierCode)) throw new AppError(400, '请在 OA 供应商中选择银行转账的收款账户。');
    payment = { payeeKind: 'bank', supplierCode: data.supplierCode, remitPurpose: read('remitPurpose', '汇款用途', 100) };
  } else if (data.supplierCode !== undefined || data.remitPurpose !== undefined) throw new AppError(400, '只有银行转账可以填写收款账户和汇款用途。');
  const amount = read('amount', '实报金额', 12);
  const cents = moneyToCents(amount);
  if (!Number.isInteger(data.attachmentCount) || Number(data.attachmentCount) < 1 || Number(data.attachmentCount) > 100) {
    throw new AppError(400, '附件数量应为 1–100 的整数。');
  }
  return {
    reimbursementType: '用款申请单', formMode: target ? 'target' : data.formMode === 'reuse' ? 'reuse' : 'new',
    ...(target ? { target } : {}), fundingKindKeyword, purpose, reason, payeeCode, ...payment,
    amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
    attachmentCount: Number(data.attachmentCount),
    fundingKeyword: read('fundingKeyword', '经费项目', 100),
    budgetKeyword: read('budgetKeyword', '预算支出项', 100),
  };
}

export function preflight(input: ReimbursementInput, invoice: Invoice | null, demo: boolean, extra: Invoice[] = []): Finding[] {
  const findings: Finding[] = [
    { level: 'pass', code: 'inputs', message: '用途、收款人工号、经费项目及预算支出项已填写。' },
    { level: 'pass', code: 'amount', message: `实报金额 ¥${input.amount}；执行时核对发票金额及实际支付金额。` },
    { level: 'warning', code: 'policy', message: '尚未配置学校报销政策，预检不代表财务审批通过。' },
  ];
  if (demo) findings.push({ level: 'warning', code: 'demo', message: '演示任务使用模拟数据，不连接校园 OA。' });
  else if (!invoice) findings.push({ level: 'error', code: 'invoice', message: '请上传一张可提取文字的全电发票 PDF。' });
  else {
    const all = [invoice, ...extra], picked = all.filter(item => item.folderId).length, pdfs = all.length - picked;
    const sources = [pdfs ? `${pdfs} 张 PDF` : '', picked ? `OA 票夹中选择的 ${picked} 张` : ''].filter(Boolean).join('和');
    findings.push({ level: 'pass', code: 'invoice', message: all.length > 1
      ? `已从 ${sources}发票确认发票号 ${all.map(item => item.number).join('、')}，将关联到同一张报销单。`
      : picked ? `已从 OA 票夹选择发票 ${invoice.number}。` : `已从 PDF 内容识别发票号 ${invoice.number}。` });
  }
  if (input.reason.length < 10) findings.push({ level: 'warning', code: 'reason', message: '报销说明较短，建议补充采购内容及其与项目的关系。' });
  return findings;
}

export function parseCredentials(value: unknown): Credentials {
  const data = object(value);
  if (typeof data.username !== 'string' || !/^[\w.@-]{2,100}$/.test(data.username)
      || typeof data.password !== 'string' || !data.password || data.password.length > 256) {
    throw new AppError(400, '请输入有效的校园账号和密码。');
  }
  return { username: data.username, password: data.password };
}
