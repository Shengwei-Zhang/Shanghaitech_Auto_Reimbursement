import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { FlowError } from '../domain/workflow';
import { watchInvoiceUpload } from './invoice-upload-wait';

/** Recorder steps 19–20: click the upload button, attach this job's PDF once. */
export async function uploadRecordedPdf(ctx: AutomationContext, upload: Locator, file: string,
  timeout: number, uploadTimeout: number): Promise<void> {
  if (ctx.state.invoiceUploadAttempted) throw new FlowError('invoice_upload_pending');
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0) throw new FlowError('configuration');
  const [chooser] = await Promise.all([
    ctx.page.waitForEvent('filechooser', { timeout }),
    upload.click({ timeout }),
  ]);
  const transfer = watchInvoiceUpload(ctx.page);
  try {
    // Mark before setting the input, since its change event can start uploading
    // even when a later browser/readback operation fails.
    ctx.state.invoiceUploadAttempted = true;
    await chooser.setFiles(file, { timeout });
    process.send?.({ type: 'stage', stage: 'attach invoice', state: 'started',
      evidence: '已将本次任务保存的 PDF 交给 OA 文件选择器，正在核验选中文件。' });
    const files = await chooser.element().evaluate(element =>
      Array.from((element as HTMLInputElement).files || []).map(item => ({ name: item.name, size: item.size })));
    if (files.length !== 1 || files[0].name !== path.basename(file) || files[0].size !== metadata.size) {
      throw new FlowError('invoice_file_mismatch');
    }
    process.send?.({ type: 'stage', stage: 'attach invoice', state: 'started',
      evidence: '已核对选中文件的名称及字节数，正在等待上传请求结束；不会重复上传。' });
    await transfer.wait(uploadTimeout);
  } finally { transfer.dispose(); }
}
