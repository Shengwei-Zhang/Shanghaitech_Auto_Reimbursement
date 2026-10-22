import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import type { RuntimeInputs } from './types';
import { moneyToCents } from '../domain/job';
import { FlowError } from '../domain/workflow';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { uniqueVisible, fillAndVerify } from './controls';
import { gridRows, gridDataRows } from './grid';
import { assertExpectedInvoice } from './guards';
import { activateFrameForSelector, waitForNoBlockingMask } from './dom';
import { fillPaymentAmount } from './payment-amount';
import { watchRequestActivity, waitForRequestQuiet } from './request-activity';

const DIALOGS = '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog';
function bankDialog(ctx: AutomationContext): Locator {
  return ctx.locator(DIALOGS).filter({ hasText: '添加个人银行卡', visible: true });
}

async function personalPaymentGrid(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const section = ctx.locator('#rbReimbursementSettlement');
  const tab = await uniqueVisible(section.locator('.ui-tab-item').filter({ hasText: /^\s*个人银行卡\s*$/ }), timeout);
  const id = await tab.getAttribute('id');
  if (!id || !/^[\w-]+$/.test(id)) throw new FlowError('control_missing');
  const grids = section.locator(`[id="layout${id}"] .xx-ui-grid[id^="grid"]`).filter({ visible: true });
  const count = await grids.count();
  if (count > 1) {
    process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
      evidence: `个人银行卡页签出现 ${count} 个可见数据表，未继续填写或保存主单。` });
    throw new FlowError('payment_rows_ambiguous');
  }
  return uniqueVisible(grids, timeout);
}

export async function assertPaymentDetails(ctx: AutomationContext, inputs: RuntimeInputs, checkReimbursement = true): Promise<void> {
  const grid = await personalPaymentGrid(ctx);
  const rows = await gridRows(grid, ['personCode', 'paymentAmount']);
  const expected = getEnvValue('EXPECTED_AMOUNT') || (await ctx.locator('#actualTotalAmount').inputValue()).replace(/,/g, '').trim();
  if (rows.length !== 1) {
    process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
      evidence: `个人银行卡数据区核验到 ${rows.length} 条付款记录（已排除固定勾选列），尚未保存主单。` });
    throw new FlowError('payment_rows_ambiguous');
  }
  if (rows[0].personCode !== inputs.payeePersonCode
    || moneyToCents(rows[0].paymentAmount.replace(/,/g, '').trim()) !== moneyToCents(expected)) throw new FlowError('value_mismatch');
  const total = (await ctx.locator('#reimbursementSettlementAmount').inputValue()).replace(/,/g, '').trim();
  if (moneyToCents(total) !== moneyToCents(expected)) throw new FlowError('value_mismatch');
  await assertExpectedInvoice(ctx, checkReimbursement);
}

export async function configurePersonalBankCardPayment(ctx: AutomationContext, inputs: RuntimeInputs,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  await activateFrameForSelector(ctx, '#editReimbursementSettlement, #rbReimbursementSettlement', timeout);
  const section = ctx.locator('#rbReimbursementSettlement');
  if (await gridDataRows(section).count()) {
    // Existing rows are neither silently reused for a different payee nor deleted.
    await assertPaymentDetails(ctx, inputs, false);
    return;
  }
  if (!await bankDialog(ctx).count()) {
    const personalTab = section.locator('.ui-tab-item').filter({ hasText: '个人银行卡', visible: true });
    if (!await personalTab.count()) {
      const open = await uniqueVisible(ctx.locator('#editReimbursementSettlement'), timeout);
      await open.click({ timeout });
      const typeDialog = await uniqueVisible(ctx.locator(DIALOGS).filter({ hasText: '添加支付类型' }), timeout);
      const option = typeDialog.getByLabel(/个人.*银行/);
      const choice = await uniqueVisible(option, timeout);
      await choice.check({ timeout });
      const confirm = await uniqueVisible(typeDialog.locator('#ok').filter({ hasText: /保存|确定/ }), timeout);
      await confirm.click({ timeout });
      await typeDialog.waitFor({ state: 'hidden', timeout });
    }
    const tab = await uniqueVisible(personalTab, timeout);
    await tab.click({ timeout });
    const id = await tab.getAttribute('id');
    if (!id || !/^[\w-]+$/.test(id)) throw new FlowError('control_missing');
    const layout = await uniqueVisible(section.locator(`[id="layout${id}"]`), timeout);
    const recordedAdd = layout.locator('#toolbar_menuAdd').filter({ visible: true });
    const add = await uniqueVisible(await recordedAdd.count() ? recordedAdd
      : layout.locator('button, a').filter({ hasText: /^\s*添加\s*$/ }), timeout);
    await add.click({ timeout });
  }
  const dialog = await uniqueVisible(bankDialog(ctx), timeout);
  process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
    evidence: '正在填写收款人工号，等待 OA 回填姓名和银行卡。' });
  try {
    await fillAndVerify(dialog.locator('#personCode, input[name="personCode"]'), inputs.payeePersonCode);
  } catch (cause) {
    if (cause instanceof FlowError && cause.code === 'value_mismatch') throw new FlowError('payment_payee_unconfirmed', { cause });
    throw cause;
  }
  // Polling is read-only: bank details must have been populated by OA for the requested person.
  await ctx.root().waitForFunction(({ selectors, person }) => {
    const dialog = Array.from(document.querySelectorAll(selectors)).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /添加个人银行卡/.test(element.textContent || '');
    });
    const value = (selector: string) => (dialog?.querySelector(selector) as HTMLInputElement | null)?.value.trim() || '';
    return value('#personCode, input[name="personCode"]') === person
      && Boolean(value('#personName, input[name="personName"]'))
      && Boolean(value('#payeeCode, #bankAccount, input[name*="account" i]'));
  }, { selectors: DIALOGS, person: inputs.payeePersonCode }, { timeout }).catch(() => { throw new FlowError('payment_payee_unconfirmed'); });
  const amount = getEnvValue('EXPECTED_AMOUNT') || (await ctx.locator('#actualTotalAmount').inputValue()).replace(/,/g, '').trim();
  process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
    evidence: '收款人工号已匹配，姓名和银行卡已回填；正在直接输入实报金额，失焦后等待 OA 格式化并核验。' });
  await fillPaymentAmount(ctx, dialog.locator('#paymentAmount, input[name="paymentAmount"]'), amount, timeout);
  process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
    evidence: '支付金额回读与实报金额一致，正在保存个人银行卡付款行。' });
  const save = await uniqueVisible(dialog.locator('#ok').filter({ hasText: /保存|确定/ }), timeout);
  await save.click({ timeout });
  await dialog.waitFor({ state: 'hidden', timeout });
  process.send?.({ type: 'stage', stage: 'configure payment', state: 'started',
    evidence: '付款弹窗已关闭，正在核对个人银行卡页签的数据行；固定勾选列不计作额外付款记录。' });
  const grid = await personalPaymentGrid(ctx, timeout);
  await gridDataRows(grid).first().waitFor({ state: 'visible', timeout });
  await assertPaymentDetails(ctx, inputs, false);
}

export async function saveMainReimbursement(ctx: AutomationContext, inputs: RuntimeInputs,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  await assertPaymentDetails(ctx, inputs);
  await waitForNoBlockingMask(ctx, timeout);
  const save = await uniqueVisible(ctx.locator('#toolBar #save, button#save').filter({ hasText: /^\s*保存\s*$/ }), timeout);
  const activity = watchRequestActivity(ctx.page);
  try {
    await save.click({ timeout, noWaitAfter: true });
    process.send?.({ type: 'stage', stage: 'save reimbursement', state: 'started',
      evidence: '保存点击已返回，正在等待本页请求结束和加载遮罩消失，再进入流转准备；请求结束不等同于保存回执。' });
    await waitForRequestQuiet(ctx.page, activity, timeout);
    await waitForNoBlockingMask(ctx, timeout);
  } catch (cause) { throw new FlowError('save_unverified', { cause }); }
  finally { activity.dispose(); }
}

export async function getSavedReimbursementSummary(ctx: AutomationContext): Promise<{ documentNumber: string; amount: string }> {
  return ctx.root().evaluate(() => ({
    documentNumber: (document.body.innerText || '').match(/单据编号\s*[:：]?\s*(A\d+)/)?.[1] || '',
    amount: (document.querySelector('#reimbursementReimbursementAmount') as HTMLInputElement | null)?.value
      || (document.querySelector('#actualTotalAmount') as HTMLInputElement | null)?.value || '',
  }));
}
