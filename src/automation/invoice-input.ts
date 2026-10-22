import { open, stat } from 'node:fs/promises';

const TASK_GUIDANCE = '请为每张发票单独创建任务；不同经费项目或预算科目请分别办理。';

function invalidInput(message: string, cause?: unknown): Error {
  return new Error(`${message}${TASK_GUIDANCE}`, cause === undefined ? undefined : { cause });
}

/** Both CLI and worker runs accept one PDF, never a directory's first invoice.
 * Check before launching a browser so invalid input cannot leave a new OA form. */
export async function validateInvoiceInput(file: string): Promise<void> {
  if (!file.trim()) throw invalidInput('尚未设置 UPLOAD_FILE_PATH，请指定一个发票 PDF 文件。');
  const metadata = await stat(file).catch(cause => {
    throw invalidInput('发票文件不存在或无法访问，请检查 UPLOAD_FILE_PATH。', cause);
  });
  if (metadata.isDirectory()) throw invalidInput('UPLOAD_FILE_PATH 指向目录，当前仅支持单个发票 PDF 文件。');
  if (!metadata.isFile()) throw invalidInput('UPLOAD_FILE_PATH 必须指向普通发票 PDF 文件。');
  if (!metadata.size) throw invalidInput('发票文件为空，请选择非空的发票 PDF 文件。');
  if (!/\.pdf$/i.test(file)) throw invalidInput('发票文件必须使用 .pdf 扩展名。');

  const handle = await open(file, 'r').catch(cause => {
    throw invalidInput('发票文件无法读取，请检查文件权限。', cause);
  });
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0).catch(cause => {
      throw invalidInput('发票文件无法读取，请检查文件权限。', cause);
    });
    if (bytesRead !== header.length || !header.equals(Buffer.from('%PDF-'))) {
      throw invalidInput('发票文件内容不是 PDF，请选择原始发票 PDF 文件。');
    }
  } finally {
    await handle.close();
  }
}
