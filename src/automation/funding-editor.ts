import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { uniqueVisible, readValue } from './controls';
import { singleGridCell } from './grid';
import { FlowError } from '../domain/workflow';
import { paymentAmountCents } from './payment-amount';
import { commitGridEditor } from './grid-commit';

const EDITOR = 'input:not([type="checkbox"]):not([type="hidden"]), textarea';
const labels: Record<string, string> = { amount: '报销金额', attachmentNumber: '附件张数', remark: '用途' };
const progress = (evidence: string) => process.send?.({ type: 'stage', stage: 'fill reimbursement details', state: 'started', evidence });

export async function fillFundingCell(ctx: AutomationContext, grid: Locator, column: string, value: string,
  timeout: number): Promise<void> {
  const label = labels[column] || column;
  progress(`正在定位“${label}”列及唯一数据单元格。`);
  let cell: Locator;
  try { cell = await singleGridCell(grid, column); }
  catch (cause) {
    progress(`“${label}”列或数据单元格未能唯一定位，尚未填写该列。`);
    throw cause;
  }
  // Recorder clicks the cell's inner div, not its outer td. Prefer a mounted
  // inline editor; otherwise activate the recorded inner click target.
  const inline = cell.locator(EDITOR).filter({ visible: true });
  if (!await inline.count()) {
    const inner = cell.locator(':scope > div').filter({ visible: true });
    await (await uniqueVisible(await inner.count() ? inner : cell, timeout)).click({ timeout });
  }
  progress(`已定位“${label}”单元格，正在等待可编辑输入框。`);
  const deadline = Date.now() + timeout;
  let editor: Locator | null = null;
  while (Date.now() < deadline) {
    if (await inline.count()) editor = await uniqueVisible(inline, timeout);
    else {
      // Some Liger editors are floating siblings. Accept the focused input
      // only when it overlaps the target cell; never fill an unrelated focus.
      const focused = ctx.locator('input:focus:not([type="checkbox"]), textarea:focus').filter({ visible: true });
      if (await focused.count() === 1) {
        const [field, target] = await Promise.all([focused.boundingBox(), cell.boundingBox()]);
        if (field && target && field.x < target.x + target.width && field.x + field.width > target.x
          && field.y < target.y + target.height && field.y + field.height > target.y) editor = focused;
      }
    }
    if (editor && await editor.isEditable({ timeout: Math.min(500, timeout) })) break;
    editor = null;
    await ctx.page.waitForTimeout(100);
  }
  if (!editor) throw new FlowError('funding_editor_missing');
  await editor.fill(value, { timeout });
  progress(`“${label}”已输入，正在按录制点击表格空白处结束单元格编辑。`);
  await commitGridEditor(grid, timeout);
  // A floating editor retaining the value is not proof of a committed cell.
  const verifyDeadline = Date.now() + Math.min(5000, timeout);
  let actual = '';
  let source = '单元格文本';
  while (Date.now() < verifyDeadline) {
    const hasInline = await inline.count();
    const current = hasInline ? await uniqueVisible(inline, timeout) : cell;
    source = hasInline ? '单元格内输入框' : '单元格可见文本';
    actual = hasInline ? await readValue(current) : (await cell.innerText()).replace(/\s+/g, ' ').trim();
    if (column === 'amount' ? paymentAmountCents(actual) === paymentAmountCents(value) : actual === value) {
      progress(`“${label}”已填写，失焦后回读一致。`);
      return;
    }
    await ctx.page.waitForTimeout(100);
  }
  const detail = column === 'remark' ? `期望 ${value.length} 字，实际 ${actual.length} 字`
    : `期望 ${value}，实际 ${/^[\d,.\s]*$/.test(actual) ? actual || '空值' : '非数字内容'}`;
  progress(`“${label}”点击空白处后回读未通过（${source}；${detail}），停止后续填写。`);
  throw new FlowError('funding_cell_mismatch');
}
