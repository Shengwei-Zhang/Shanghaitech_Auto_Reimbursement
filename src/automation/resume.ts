import type { Page } from 'playwright';
import { AutomationContext } from './browser';
import {
  isAddInvoiceDialogVisible,
  isAddInvoicePopulated,
  isInvoiceAttached,
  isInvoicePickerOpen,
} from './invoice-state';
import { resolveFrameForSelector } from './frames';

export interface ResumePageState {
  invoiceAttached: boolean;
  addInvoicePopulated: boolean;
  addInvoiceDialogVisible: boolean;
  invoicePickerOpen: boolean;
  fundingEditorVisible: boolean;
  url: string;
}

export function classifyResumeState(state: ResumePageState): string {
  if (!state.url.includes('sapbpm-new.shanghaitech.edu.cn')) {
    return '';
  }
  if (state.invoiceAttached) {
    return 'configure payment';
  }
  if (state.addInvoicePopulated || state.addInvoiceDialogVisible || state.invoicePickerOpen) {
    return 'attach invoice';
  }
  if (state.url.includes('forwardAddRbReimbursement')) {
    return 'prepare reimbursement form';
  }
  if (state.fundingEditorVisible || state.url.includes('showLoadRbReimbursement')) {
    return 'select funding item';
  }
  return '';
}

export async function detectResumeStep(page: Page): Promise<string> {
  const ctx = new AutomationContext(page);
  const url = page.url();

  if (!url.includes('sapbpm-new.shanghaitech.edu.cn')) {
    return '';
  }

  await resolveFrameForSelector(ctx, '#editReimburFundingItems').catch(() => undefined);
  return classifyResumeState({
    invoiceAttached: await isInvoiceAttached(ctx),
    addInvoicePopulated: await isAddInvoicePopulated(ctx),
    addInvoiceDialogVisible: await isAddInvoiceDialogVisible(ctx),
    invoicePickerOpen: await isInvoicePickerOpen(ctx),
    fundingEditorVisible: await ctx.locator('#editReimburFundingItems').isVisible().catch(() => false),
    url,
  });
}
