import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS, requireEnv } from './config';
import { uniqueVisible } from './controls';
import { activateFrameForSelector } from './dom';
import { assertExpectedInvoice } from './guards';
import { FlowError } from '../domain/workflow';
import { uploadRecordedPdf } from './recorded-upload';
import { findInvoiceInFolder, openInvoiceFolder, refreshInvoiceFolder } from './invoice-folder';
import { selectInvoice } from './invoice-selection';
import { waitForInvoiceEntry } from './invoice-entry';
import { checkInvoiceClaimInPage } from './invoice-claim';

function progress(evidence: string): void {
  // Only fixed operation descriptions; do not persist invoice numbers or DOM text.
  process.send?.({ type: 'stage', stage: 'attach invoice', state: 'started', evidence });
}

/** OA keeps a re-uploaded 已报销/报销中 invoice out of the 未报销 list the picker shows. */
async function assertInvoiceNotClaimed(ctx: AutomationContext, number: string): Promise<void> {
  const root = ctx.root();
  const fetchJson = (url: string) => root.evaluate(async target => {
    const token = (window as unknown as { $?: { CSRFToken?: () => string } }).$?.CSRFToken?.() || '';
    const response = await fetch(target, { credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', ...(token ? { csrfToken: token } : {}) } });
    return response.ok ? response.json() : null;
  }, url);
  let claim;
  try { claim = await checkInvoiceClaimInPage(fetchJson, number); }
  catch { return; } // Inconclusive lookups keep the normal wait; they never select or upload anything.
  if (claim.state === 'claimed') throw new FlowError('invoice_already_claimed');
  if (claim.state === 'claiming') throw new FlowError('invoice_claim_in_progress');
}

/** New VXE picker captured in steps 18–25. Returns false for the older invoice dialog. */
export async function attachRecordedInvoice(ctx: AutomationContext, file: string,
  timeout = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  progress('正在打开报销编辑页的“增值税发票/电子发票上传”入口。');
  await (await waitForInvoiceEntry(ctx, timeout)).click({ timeout });
  progress('已点击发票入口，正在等待票夹及上传控件。');
  await activateFrameForSelector(ctx, '.vxe-grid--toolbar-wrapper, input[placeholder*="电子发票"], textarea[placeholder*="电子发票"], #rbReimbursementInvoiceForm', timeout);
  const uploadButtons = ctx.locator('.vxe-grid--toolbar-wrapper button').filter({ hasText: /点击或拖拽上传|上传/ });
  // Toolbar/placeholder can render before its button. A momentary zero count
  // is not evidence of the legacy UI and must not reopen the invoice entry.
  if (!await ctx.locator('.vxe-grid--toolbar-wrapper').filter({ visible: true }).count()
    && await ctx.locator('#rbReimbursementInvoiceForm').filter({ visible: true }).count()) {
    progress('检测到旧版添加发票表单，转入旧版票夹操作。');
    return false;
  }
  await uniqueVisible(uploadButtons, timeout);

  const number = requireEnv('EXPECTED_INVOICE_NUMBER');
  if (!/^\d{20}$/.test(number)) throw new FlowError('configuration');
  ctx.state.invoicePath = file;
  ctx.state.invoiceNumber = number;
  // Follow the recording: upload first. Traversing the historical folder before
  // file selection blocked real uploads and is not part of the recorded flow.
  const uploadTimeout = timeout === DEFAULT_TIMEOUT_MS ? 120_000 : timeout;
  const upload = await uniqueVisible(uploadButtons, timeout);
  progress('按录制步骤点击“点击或拖拽上传”，选择本次任务的 PDF；上传前不遍历历史票夹。');
  await uploadRecordedPdf(ctx, upload, file, timeout, uploadTimeout);
  progress('上传请求已结束，正在切换“表单默认票夹”并按发票号等待 OA 处理结果。');
  await openInvoiceFolder(ctx, '表单默认票夹', timeout);
  const deadline = Date.now() + uploadTimeout;
  let row: Locator | null = null, nextClaimCheck = 0;
  progress('正在定位表格“发票号”列；必要时横向滚动，匹配后按行标识返回左侧勾选。');
  while (Date.now() < deadline) {
    row = await findInvoiceInFolder(ctx, number, timeout);
    if (row) break;
    if (Date.now() >= nextClaimCheck) {
      nextClaimCheck = Date.now() + 15_000;
      await assertInvoiceNotClaimed(ctx, number);
    }
    await ctx.page.waitForTimeout(Math.min(1000, Math.max(0, deadline - Date.now())));
    // Refresh the selected folder, not the upload action. OCR can finish after
    // the transfer response, and the tree may not reload an already selected node.
    await refreshInvoiceFolder(ctx, timeout);
  }
  if (!row) throw new FlowError('invoice_processing_pending');
  progress('已定位目标发票，正在检查已有勾选并选中目标行。');
  await selectInvoice(row, timeout);
  progress('已选中目标发票，正在点击“确定”并核验报销单中的发票行。');
  await (await uniqueVisible(ctx.locator('#ok').filter({ hasText: /^\s*确定\s*$/ }), timeout)).click({ timeout });
  await activateFrameForSelector(ctx, '#invoiceGrid', timeout);
  await ctx.locator('#invoiceGrid').filter({ hasText: number }).waitFor({ state: 'visible', timeout });
  await assertExpectedInvoice(ctx);
  return true;
}
