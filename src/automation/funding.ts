import { moneyToCents } from '../domain/job';
import { FlowError } from '../domain/workflow';
import type { AutomationContext } from './browser';
import type { RuntimeInputs } from './types';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { uniqueVisible, fillAndVerify } from './controls';
import { gridRows } from './grid';
import { fillFundingCell } from './funding-editor';

export async function assertFundingChoice(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  // OA closes the wizard before its async update of the main form completes.
  // Only read/poll here: never reselect or save again to force a matching value.
  const normalize = (value: string) => value.replace(/\s+/g, '');
  const project = normalize(getEnvValue('FUNDING_ITEM_KEYWORD'));
  const budget = normalize(getEnvValue('BUDGET_OUTLAY_KEYWORD'));
  if (!project || !budget) throw new FlowError('configuration');
  const section = ctx.locator('#rbReimburFundingItems').filter({ visible: true });
  let projectMatched = false, budgetMatched = false, observed = false;
  const deadline = Date.now() + timeout;
  process.send?.({ type: 'stage', stage: 'select funding item', state: 'started',
    evidence: '经费选择已保存，正在等待主表单回填经费项目和预算科目。' });
  while (Date.now() < deadline) {
    const count = await section.count();
    if (count > 1) throw new FlowError('ambiguous_choice');
    // A detached/replaced section is not evidence of a different funding choice.
    const text = count === 1
      ? await section.innerText({ timeout: Math.max(1, Math.min(500, deadline - Date.now())) }).catch(() => null)
      : null;
    observed = text !== null;
    const actual = normalize(text || '');
    projectMatched = observed && actual.includes(project);
    budgetMatched = observed && actual.includes(budget);
    if (projectMatched && budgetMatched) return;
    await ctx.page.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  process.send?.({ type: 'stage', stage: 'select funding item', state: 'started',
    evidence: `经费回填核验未通过：经费项目${projectMatched ? '已匹配' : '未匹配'}；预算科目${budgetMatched ? '已匹配' : '未匹配'}。尚未进入发票、金额或收款人核验。` });
  if (!observed) throw new FlowError('control_missing');
  throw new FlowError(projectMatched ? 'funding_budget_mismatch'
    : budgetMatched ? 'funding_project_mismatch' : 'funding_choice_mismatch');
}

export async function assertReimbursementDetails(ctx: AutomationContext, inputs: RuntimeInputs): Promise<void> {
  const grid = await uniqueVisible(ctx.locator('#rbReimburFundingItems .xx-ui-grid[id^="grid"]'));
  const rows = await gridRows(grid, ['amount', 'attachmentNumber', 'remark']);
  if (rows.length !== 1) throw new FlowError('ambiguous_choice');
  const expected = getEnvValue('EXPECTED_AMOUNT') || await ctx.locator('#actualTotalAmount').inputValue();
  if (moneyToCents(rows[0].amount.replace(/,/g, '')) !== moneyToCents(expected)
      || rows[0].attachmentNumber !== inputs.attachmentCount || rows[0].remark !== inputs.reimbursementPurpose
      || await ctx.locator('#reimbursementRemark').inputValue() !== inputs.reimbursementReason
      || await ctx.locator('#reimbursementAttachmentNumber').inputValue() !== inputs.attachmentCount) {
    throw new FlowError('value_mismatch');
  }
}

export async function fillReimbursementDetails(ctx: AutomationContext, inputs: RuntimeInputs,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const grid = await uniqueVisible(ctx.locator('#rbReimburFundingItems .xx-ui-grid[id^="grid"]'), timeout);
  const invoiceAmount = (await ctx.locator('#actualTotalAmount').inputValue()).replace(/,/g, '').trim();
  const actualAmount = getEnvValue('EXPECTED_AMOUNT') || invoiceAmount;
  if (moneyToCents(actualAmount) > moneyToCents(invoiceAmount)) throw new FlowError('value_mismatch');
  process.send?.({ type: 'stage', stage: 'fill reimbursement details', state: 'started',
    evidence: '正在填写经费明细的报销金额、附件张数和用途，再填写报销事由。' });
  // Target each named cell explicitly. Locator clicks automatically account for nested iframe offsets.
  for (const [column, value] of [['amount', actualAmount], ['attachmentNumber', inputs.attachmentCount], ['remark', inputs.reimbursementPurpose]]) {
    await fillFundingCell(ctx, grid, column, value, timeout);
  }
  process.send?.({ type: 'stage', stage: 'fill reimbursement details', state: 'started', evidence: '经费三列均已回读一致，正在填写报销事由。' });
  await fillAndVerify(ctx.locator('#reimbursementRemark'), inputs.reimbursementReason);
  // Read-only totals MUST be computed by OA. We never synthesize successful form state.
  await ctx.root().waitForFunction(({ count, expected }) => {
    const attachment = (document.querySelector('#reimbursementAttachmentNumber') as HTMLInputElement | null)?.value;
    const total = (document.querySelector('#reimbursementReimbursementAmount') as HTMLInputElement | null)?.value || '';
    return attachment === count && Number(total.replace(/,/g, '')) === Number(expected);
  }, { count: inputs.attachmentCount, expected: actualAmount }, { timeout }).catch(() => { throw new FlowError('value_mismatch'); });
  await assertReimbursementDetails(ctx, inputs);
}
