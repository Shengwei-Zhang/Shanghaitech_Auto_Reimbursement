import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';

const UPLOAD_FILE_EXTENSIONS = new Set(['.pdf']);
const INVOICE_SUBDIR_NAME = 'invoice';

/** 20-digit electronic invoice numbers (全电发票). */
const INVOICE_NUMBER_PATTERN = /^[2]\d{19}$/;

function isLikelyInvoiceNumber(value: string): boolean {
  return INVOICE_NUMBER_PATTERN.test(value);
}

function invoiceNumberFromFilename(filePath: string): string | null {
  const basename = path.basename(filePath, path.extname(filePath));
  const digitalMatch = basename.match(/^digital[_-]?(\d{18,22})$/i);
  if (digitalMatch) {
    return digitalMatch[1];
  }

  const digitGroups = basename.match(/\d{18,22}/g) || [];
  const invoiceLike = digitGroups.filter(isLikelyInvoiceNumber);
  return invoiceLike[0] || digitGroups[0] || null;
}

export function pickInvoiceNumberFromText(text: string, _filenameHint: string | null): string | null {
  const normalized = text.replace(/\s+/g, ' ');

  const labeled = [...new Set([...normalized.matchAll(/发票号码[\s:：]*?(\d{18,22})/g)]
    .map(match => match[1]).filter(isLikelyInvoiceNumber))];
  if (labeled.length > 1) return null;
  if (labeled.length === 1) return labeled[0];

  const beforeDateMatch = text.match(/(\d{18,22})[\s\r\n]*\d{4}年\d{1,2}月\d{1,2}日/);
  if (beforeDateMatch && isLikelyInvoiceNumber(beforeDateMatch[1])) {
    return beforeDateMatch[1];
  }

  const candidates = [...new Set((text.match(/\d{18,22}/g) || []).filter(isLikelyInvoiceNumber))];

  if (candidates.length === 1) {
    return candidates[0];
  }

  return null;
}

export async function extractInvoiceNumberFromPdf(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const filenameHint = invoiceNumberFromFilename(filePath);

  if (ext !== '.pdf') {
    throw new Error(`Cannot extract invoice number from non-PDF file: ${filePath}`);
  }

  const buffer = await fs.readFile(filePath);
  const parsed = await pdfParse({ data: new Uint8Array(buffer), isEvalSupported: false });
  const invoiceNumber = pickInvoiceNumberFromText(parsed.text || '', filenameHint);

  if (!invoiceNumber) {
    throw new Error(`Could not extract invoice number from PDF: ${filePath}`);
  }

  return invoiceNumber;
}

async function listUploadCandidates(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => UPLOAD_FILE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(directoryPath, name));
}

async function resolveUploadDirectory(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);

  if (stat.isDirectory()) {
    const nested = path.join(resolvedPath, INVOICE_SUBDIR_NAME);
    const nestedStat = await fs.stat(nested).catch(() => null);
    if (nestedStat?.isDirectory()) {
      const nestedCandidates = await listUploadCandidates(nested);
      if (nestedCandidates.length > 0) {
        return nested;
      }
    }
    return resolvedPath;
  }

  return path.dirname(resolvedPath);
}

/** 按文件名排序返回文件夹内全部发票文件路径。 */
export async function listOrderedInvoiceFiles(uploadPath: string): Promise<string[]> {
  const resolvedPath = path.resolve(uploadPath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw new Error(`Upload path does not exist: ${resolvedPath}`);
  }

  if (stat.isFile()) {
    return [resolvedPath];
  }

  const candidates = await listUploadCandidates(await resolveUploadDirectory(resolvedPath));
  if (candidates.length === 0) {
    throw new Error(
      `No invoice files found under ${resolvedPath}. Set UPLOAD_FILE_PATH=files/invoice in .env.`,
    );
  }

  return candidates;
}

/** 返回排序后的第一个发票文件及其发票号。 */
export async function resolveFirstOrderedInvoiceFile(
  uploadPath: string,
): Promise<{ filePath: string; invoiceNumber: string }> {
  const candidateFiles = await listOrderedInvoiceFiles(uploadPath);
  const filePath = candidateFiles[0];
  const invoiceNumber = await extractInvoiceNumberFromPdf(filePath);
  return { filePath, invoiceNumber };
}

/**
 * 按文件顺序读取 PDF 发票号，与票夹已有号码（自行上传票据 + 表单默认票夹）比对：
 * 已存在则检查下一张，不存在则返回该文件供上传。
 */
export async function resolveNextInvoiceToUpload(
  uploadPath: string,
  pickerInvoiceNumbers: Iterable<string> = [],
): Promise<{ filePath: string; invoiceNumber: string } | null> {
  const pickerSet = new Set(pickerInvoiceNumbers);
  const candidateFiles = await listOrderedInvoiceFiles(uploadPath);

  console.log(`按顺序检查 ${candidateFiles.length} 个发票文件（与票夹中已有发票号比对）…`);

  for (const filePath of candidateFiles) {
    const invoiceNumber = await extractInvoiceNumberFromPdf(filePath);
    const basename = path.basename(filePath);

    if (pickerSet.has(invoiceNumber)) {
      console.log(
        `[${basename}] 发票号 ${invoiceNumber} 已在票夹（自行上传票据 / 表单默认票夹）中，跳过，检查下一张…`,
      );
      continue;
    }

    console.log(`[${basename}] 发票号 ${invoiceNumber} 不在票夹中，准备上传。`);
    return { filePath, invoiceNumber };
  }

  console.log('文件夹内所有发票均已存在于票夹中，无需上传。');
  return null;
}

export function selectFirstMissingInvoice(
  candidates: Array<{ filePath: string; invoiceNumber: string }>,
  existingInvoiceNumbers: Iterable<string>,
): { filePath: string; invoiceNumber: string } | null {
  const existing = new Set(existingInvoiceNumbers);
  return candidates.find((candidate) => !existing.has(candidate.invoiceNumber)) || null;
}
