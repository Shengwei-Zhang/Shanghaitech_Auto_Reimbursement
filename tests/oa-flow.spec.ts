import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { runReimbursementFlow } from '../src/automation/reimbursement-flow';
import { setStartFromStep } from '../src/automation/runner';
import { assertPaymentDetails } from '../src/automation/payment';
import { verifyReceipt } from '../src/automation/submission';
import { installOaFixture, inputs, number, profile } from './fixtures/oa';

test.beforeEach(() => {
  process.env.UPLOAD_FILE_PATH = '/synthetic/not-uploaded.pdf';
  process.env.EXPECTED_AMOUNT = '120.10'; process.env.EXPECTED_INVOICE_NUMBER = number;
  process.env.FUNDING_ITEM_KEYWORD = '项目A'; process.env.BUDGET_OUTLAY_KEYWORD = '材料费';
  setStartFromStep('configure payment');
});

test('real DOM operations fill iframe fields, verify payment, save once and automatically confirm exactly once', async ({ page, browser }) => {
  const state = await installOaFixture(page);
  const ctx = new AutomationContext(page);
  let handedOff = false;
  const result = await runReimbursementFlow({ page, browser, context: page.context() }, inputs, ctx, {
    action: 'submit', siteProfile: profile,
    onSubmissionValidated: async summary => {
      handedOff = true;
      expect(summary.documentNumber).toBe('A20260001');
      expect(state.submits).toBe(0);
      await expect(page.frameLocator('iframe').getByText('流转确认', { exact: false })).toBeVisible();
    },
  });
  expect(handedOff).toBe(true);
  expect(state.saves).toBe(1); expect(state.submits).toBe(1);
  expect(state.count).toBe('2'); expect(state.person).toBe('TEST01'); expect(state.payment).toBe('120.10');
  expect(result.verification).toBe('receipt'); expect(result.receipt?.status).toBe('审批中');
});

test('without a receipt profile final click occurs once but success remains unknown', async ({ page, browser }) => {
  const state = await installOaFixture(page);
  await expect(runReimbursementFlow({ page, browser, context: page.context() }, inputs, new AutomationContext(page), {
    action: 'submit',
  })).rejects.toMatchObject({ code: 'submission_unknown' });
  expect(state.submits).toBe(1);
});

test('business save failure stops before opening final confirmation and is never retried', async ({ page, browser }) => {
  const state = await installOaFixture(page, { saveOk: false });
  let manualCalls = 0;
  await expect(runReimbursementFlow({ page, browser, context: page.context() }, inputs, new AutomationContext(page), {
    action: 'submit', siteProfile: profile, onSubmissionValidated: async () => { manualCalls++; },
  })).rejects.toMatchObject({ code: 'save_unverified' });
  expect(state.saves).toBe(1); expect(state.submits).toBe(0); expect(manualCalls).toBe(0);
});

test('receipt for another document or a draft cannot prove submission', async ({ page }) => {
  await installOaFixture(page, { wrongReceipt: true });
  await expect(verifyReceipt(page.context(), profile, { documentNumber: 'A20260001', amount: '120.10' }, 'submit', 400))
    .rejects.toMatchObject({ code: 'submission_unknown' });
});

test('payee mismatch is detected by the exact grid column, not amount substring', async ({ page }) => {
  const state = await installOaFixture(page);
  state.person = 'WRONG01'; state.payment = '1120.10'; state.amount = '120.10';
  await page.reload();
  await page.frameLocator('iframe').locator('#gridpay .l-grid-row').waitFor();
  const ctx = new AutomationContext(page); ctx.setActiveFrame(page.frames().find(frame => frame.url().endsWith('/form'))!);
  await expect(assertPaymentDetails(ctx, inputs)).rejects.toMatchObject({ code: 'value_mismatch' });
  expect(state.saves).toBe(0); expect(state.submits).toBe(0);
});
