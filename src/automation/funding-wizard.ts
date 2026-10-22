import { FlowError } from '../domain/workflow';
import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { waitAndClick } from './actions';
import { uniqueVisible } from './controls';
import { chooseBudget } from './budget-picker';
import { waitForFundingEntry } from './editor-entry';
import { waitForInvoiceEntry } from './invoice-entry';

async function chooseUniqueVisible(
  candidates: Locator,
  description: string,
  timeoutMs: number,
): Promise<Locator> {
  await candidates.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => undefined);
  const visible: Locator[] = [];
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = candidates.nth(index);
    if (await item.isVisible().catch(() => false)) {
      visible.push(item);
    }
  }

  if (visible.length !== 1) {
    throw new Error(
      `${description} must match exactly one visible option, but matched ${visible.length}. `
      + 'Set FUNDING_ITEM_KEYWORD and BUDGET_OUTLAY_KEYWORD in .env.',
    );
  }
  return visible[0];
}

export async function selectFundingItem(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const fundingEntry = await waitForFundingEntry(ctx, timeoutMs);
  const fundingKeyword = getEnvValue('FUNDING_ITEM_KEYWORD');
  const budgetKeyword = getEnvValue('BUDGET_OUTLAY_KEYWORD');
  const kindKeyword = getEnvValue('FUNDING_KIND_KEYWORD') || '被授权的项目';
  if (!['被授权的项目', '我负责的项目'].includes(kindKeyword)) throw new FlowError('configuration');

  await waitAndClick(
    ctx,
    fundingEntry,
    'open-funding-item-wizard',
    timeoutMs,
  );

  {
    await (await uniqueVisible(ctx.locator('#fundingItemKind_text'), timeoutMs)).click();
    const preferredType = ctx.locator('#combox_droplist_wrap ul li').filter({ hasText: new RegExp(`^\\s*${kindKeyword}\\s*$`) });
    await (await uniqueVisible(preferredType, timeoutMs)).click();
  }

  const viewButton = ctx.locator('#chooseFundingItemsViewName');
  if (await viewButton.isVisible().catch(() => false)) {
    await viewButton.click();
  }

  const rows = ctx.locator('#easySearchTableListData tbody tr');
  const fundingRows = fundingKeyword
    ? rows.filter({ hasText: fundingKeyword })
    : rows;
  const fundingRow = await chooseUniqueVisible(
    fundingRows,
    fundingKeyword ? `Funding item "${fundingKeyword}"` : 'Funding item',
    timeoutMs,
  );
  await fundingRow.locator('td').first().click();

  await chooseBudget(ctx, budgetKeyword, timeoutMs);

  const saveButton = await uniqueVisible(ctx.locator('#ok').filter({ hasText: /保存|确定/ }), timeoutMs);
  process.send?.({ type: 'stage', stage: 'select funding item', state: 'started',
    evidence: '已唯一定位经费项目及预算科目，正在保存本次选择。' });
  await waitAndClick(ctx, saveButton, 'save-funding-item', timeoutMs);
  await saveButton.waitFor({ state: 'hidden', timeout: timeoutMs });
  await waitForInvoiceEntry(ctx, timeoutMs);
}
