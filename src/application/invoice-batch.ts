import fs from 'node:fs';
import path from 'node:path';
import { JobService, inspectInvoice } from './job-service';
import { JobStore } from '../infrastructure/job-store';
import { AppError, moneyToCents, parseInput, type Invoice, type Job, type ReimbursementInput } from '../domain/job';

interface BatchEntry {
  sourcePath: string;
  invoice: Invoice;
  classificationConfirmed: boolean;
  input: Record<string, unknown>;
  status?: string;
  jobId?: string | null;
  documentNumber?: string;
}

interface BatchManifest {
  sourceDirectory: string;
  entries: BatchEntry[];
  liveForms?: Array<{ documentNumber: string; invoiceNumber?: string; invoiceNumbers?: string[]; status?: string }>;
}

interface CheckedEntry {
  entry: BatchEntry;
  input: ReimbursementInput;
  buffer: Buffer;
}

function requireManifest(value: unknown): BatchManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '批次清单格式无效。');
  const data = value as Partial<BatchManifest>;
  if (typeof data.sourceDirectory !== 'string' || !Array.isArray(data.entries) || !data.entries.length) {
    throw new AppError(400, '批次清单缺少源目录或发票条目。');
  }
  for (const entry of data.entries) {
    if (!entry || typeof entry !== 'object' || !entry.invoice || typeof entry.invoice.name !== 'string'
      || typeof entry.invoice.number !== 'string' || !entry.input || typeof entry.input !== 'object') {
      throw new AppError(400, '批次清单发票条目格式无效。');
    }
  }
  if (data.liveForms !== undefined && (!Array.isArray(data.liveForms) || data.liveForms.some(form =>
    !form || typeof form.documentNumber !== 'string' || !form.documentNumber.trim()))) {
    throw new AppError(400, '批次清单 OA 单据记录格式无效。');
  }
  return data as BatchManifest;
}

/** A browser-created OA form may have no local job. Never interpret that as a new invoice. */
function assertBatchNotStarted(manifest: BatchManifest): void {
  // Any recorded form blocks the whole batch: drafting is all-or-nothing, not a
  // silent skip/retry of partially completed work. This also handles old records
  // with only one invoiceNumber and grouped forms with invoiceNumbers.
  if (manifest.liveForms?.length) {
    throw new AppError(409, `批次已有 OA 单据 ${manifest.liveForms.map(form => form.documentNumber).join('、')}；请核对并继续原单，不得重新创建本批任务。`);
  }
  for (const entry of manifest.entries) {
    if (entry.documentNumber || entry.jobId || (entry.status !== undefined
      && !['not_started', 'awaiting_user_details', 'ready'].includes(entry.status))) {
      throw new AppError(409, `${entry.invoice.name} 已有办理记录或状态不明确；请核对原任务及 OA，不得重新创建。`);
    }
  }
}

/** Validate the whole batch before writing any local job. No OA operation occurs here. */
export async function checkInvoiceBatch(manifestPath: string, store: JobStore): Promise<CheckedEntry[]> {
  const manifest = requireManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  assertBatchNotStarted(manifest);
  const directory = fs.realpathSync(manifest.sourceDirectory);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(item => item.isFile() && /\.pdf$/i.test(item.name)).map(item => item.name).sort();
  const listed = manifest.entries.map(item => item?.invoice?.name).sort();
  if (JSON.stringify(files) !== JSON.stringify(listed)) {
    throw new AppError(409, '源目录与批次清单的 PDF 文件列表不一致，请重新核对。');
  }
  const seen = new Set<string>();
  const checked: CheckedEntry[] = [];
  for (const entry of manifest.entries) {
    const name = entry.invoice.name;
    if (typeof entry.sourcePath !== 'string' || path.basename(entry.sourcePath) !== name || !files.includes(name)
      || fs.realpathSync(entry.sourcePath) !== path.join(directory, name)) {
      throw new AppError(400, `发票路径不属于源目录：${name || '未知文件'}`);
    }
    if (entry.classificationConfirmed !== true) {
      throw new AppError(400, `${name} 的费用分类尚未确认。`);
    }
    if (seen.has(entry.invoice.number) || seen.has(entry.invoice.sha256)) {
      throw new AppError(409, `${name} 在批次中重复。`);
    }
    const buffer = fs.readFileSync(entry.sourcePath);
    const { invoice } = await inspectInvoice({ name, base64: buffer.toString('base64') });
    if (invoice.number !== entry.invoice.number || invoice.sha256 !== entry.invoice.sha256
      || invoice.amount !== entry.invoice.amount || invoice.size !== entry.invoice.size) {
      throw new AppError(409, `${name} 的原始 PDF 与批次清单不一致。`);
    }
    seen.add(invoice.number);
    seen.add(invoice.sha256);
    const input = parseInput(entry.input);
    if (!invoice.amount || moneyToCents(input.amount) > moneyToCents(invoice.amount)) {
      throw new AppError(400, `${name} 的实报金额超过或无法核对票面金额。`);
    }
    checked.push({ entry, input, buffer });
  }
  return checked;
}

export async function createInvoiceBatchDrafts(manifestPath: string, store: JobStore): Promise<Job[]> {
  const checked = await checkInvoiceBatch(manifestPath, store);
  const service = new JobService(store, { review: async () => { throw new Error('未启用 AI。'); } }, false);
  const jobs: Job[] = [];
  for (const { entry, input, buffer } of checked) {
    jobs.push(await service.create({ mode: 'live', action: 'submit', input,
      invoice: { name: entry.invoice.name, base64: buffer.toString('base64') } }));
  }
  return jobs;
}
