import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { AutomationContext } from '../src/automation/browser';
import { runReimbursementFlow } from '../src/automation/reimbursement-flow';
import { setStartFromStep } from '../src/automation/runner';
import { attachRecordedInvoice } from '../src/automation/recorded-invoice';
import { chooseBudget } from '../src/automation/budget-picker';
import { createPaymentApplication } from '../src/automation/recorded-create';
import { selectFundingItem } from '../src/automation/funding-wizard';
import { assertFundingChoice } from '../src/automation/funding';
import { installOaFixture, inputs, number, profile } from './fixtures/oa';

test.beforeEach(async ({}, info) => {
  const file = info.outputPath('synthetic-invoice.pdf');
  await writeFile(file, '%PDF-1.4 synthetic upload fixture');
  Object.assign(process.env, { UPLOAD_FILE_PATH: file, EXPECTED_AMOUNT: '120.10', EXPECTED_INVOICE_AMOUNT: '120.10',
    EXPECTED_INVOICE_NUMBER: number, FUNDING_ITEM_KEYWORD: '项目A', BUDGET_OUTLAY_KEYWORD: '材料费',
    FUNDING_KIND_KEYWORD: '被授权的项目', OA_LOGIN_MODE: 'manual', CAPTURE_DEBUG_ARTIFACTS: 'false' });
  setStartFromStep('');
});

test('orange login continues to create exactly one application, upload and save', async ({ page, browser }) => {
  const state = await installOaFixture(page, { recorded: true, theme: 'orange' });
  const session = { page, browser, context: page.context() };
  const result = await runReimbursementFlow(session, inputs, new AutomationContext(page), {
    formMode: 'new', action: 'submit', siteProfile: profile,
    onSubmissionValidated: async () => {
      expect(state.creates).toBe(1); expect(state.uploads).toBe(1); expect(state.saves).toBe(1);
      expect(state.submits).toBe(0);
      expect(state.order.slice(0, 5)).toEqual(['create', 'funding', 'upload', 'attach', 'payment']);
      expect(state.person).toBe(inputs.payeePersonCode); expect(state.payment).toBe('120.10');
      expect(state.amount).toBe('120.10'); expect(state.count).toBe('2'); expect(state.purpose).toBe(inputs.reimbursementPurpose);
      expect(session.page).not.toBe(page);
    },
  });
  expect(result.verification).toBe('receipt'); expect(state.submits).toBe(1);
});

test('recorded flow uploads the supplied file before opening the default folder', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, existingInvoice: true });
  const ctx = new AutomationContext(page);
  await attachRecordedInvoice(ctx, process.env.UPLOAD_FILE_PATH!, 2000);
  expect(await page.frameLocator('iframe').locator('#invoiceUpload').evaluate(async input =>
    (input as HTMLInputElement).files?.[0]?.text())).toBe('%PDF-1.4 synthetic upload fixture');
  expect(state.uploadedSyntheticPdf).toBe(true);
  await expect(page.frameLocator('iframe').locator('body')).not.toHaveAttribute('data-folder-before-upload', 'true');
  expect(state.uploads).toBe(1); expect(state.attached).toBe(true);
});

test('funding wizard may close before the main form displays the selected project and budget', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, fundingReadbackDelayMs: 600 });
  const ctx = new AutomationContext(page);
  await selectFundingItem(ctx, 2000);
  await expect(page.frameLocator('iframe').locator('#fundWizard')).toBeHidden();
  await assertFundingChoice(ctx, 2000);
  await expect(page.frameLocator('iframe').locator('#funding-label')).toHaveText('项目A 材料费');
  expect(state.order).toEqual(['funding']);
  expect(state.uploads).toBe(0);
});

test('late-rendered VXE upload button does not switch to the legacy invoice flow', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, existingInvoice: true });
  await page.frameLocator('iframe').locator('.vxe-grid--toolbar-wrapper button').evaluate(button => {
    button.remove();
    const entry = document.querySelector('#rbReimbursementInvoiceButtons button') as HTMLElement;
    entry.addEventListener('click', () => setTimeout(() => {
      document.querySelector('.vxe-grid--toolbar-wrapper')!.append(button);
    }, 300));
  });
  expect(await attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 2000)).toBe(true);
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(true);
});

test('class-based ordinary and batch invoice entries complete funding and upload through batch only', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true });
  await page.frameLocator('iframe').locator('#rbReimbursementInvoiceButtons').evaluate(container => {
    const batch = container.querySelector('button')!;
    container.removeAttribute('id');
    container.classList.add('rbReimbursementInvoiceButtons');
    batch.innerHTML = '<i class="fa fa-plus"></i>&nbsp;增值税发票/电子发票上传(批量)';
    batch.addEventListener('click', () => {
      document.body.dataset.batchClicks = String(Number(document.body.dataset.batchClicks || 0) + 1);
    });
    const ordinary = document.createElement('div');
    ordinary.className = 'rbReimbursementInvoiceButtons';
    ordinary.innerHTML = '<button type="button"><i class="fa fa-plus"></i>&nbsp;增值税发票/电子发票上传</button>';
    ordinary.querySelector('button')!.onclick = () => { document.body.dataset.ordinaryClicked = 'true'; };
    container.before(ordinary);
  });
  const ctx = new AutomationContext(page);
  await selectFundingItem(ctx, 2000);
  await assertFundingChoice(ctx, 2000);
  expect(await attachRecordedInvoice(ctx, process.env.UPLOAD_FILE_PATH!, 2000)).toBe(true);
  const body = page.frameLocator('iframe').locator('body');
  await expect(body).not.toHaveAttribute('data-ordinary-clicked', 'true');
  await expect(body).toHaveAttribute('data-batch-clicks', '1');
  expect(state.order).toEqual(['funding', 'upload', 'attach']);
  expect(await page.frameLocator('iframe').locator('#invoiceUpload').evaluate(async input =>
    (input as HTMLInputElement).files?.[0]?.text())).toBe('%PDF-1.4 synthetic upload fixture');
  expect(state.uploadedSyntheticPdf).toBe(true);
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(true);
});

test('uploaded invoice on a later default-folder page is matched by number', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, existingInvoice: true, invoicePages: 3 });
  await attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 2000);
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(true);
});

test('upload finishes before folder switch; delayed OCR is refreshed and matched by invoice number', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true,
    invoiceUploadDelayMs: 700, invoiceProcessingDelayMs: 1800, invoiceFolderDelayMs: 400, invoicePages: 2 });
  await attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 5000);
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(true);
  await expect(page.frameLocator('iframe').locator('body')).not.toHaveAttribute('data-premature-switch', 'true');
});

test('first-page invoice is attached without checking any later folder page', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, invoicePages: 41, crossPageDuplicate: true });
  await page.frameLocator('iframe').locator('.vxe-pager--next-btn').evaluate(button => {
    button.addEventListener('click', () => { document.body.dataset.unwantedPagination = 'true'; });
  });
  await attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 2000);
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(true);
  await expect(page.frameLocator('iframe').locator('body')).not.toHaveAttribute('data-unwanted-pagination', 'true');
});

test('a newly uploaded invoice with another number is never attached', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, wrongUploadedInvoice: true });
  await expect(attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 1500))
    .rejects.toMatchObject({ code: 'invoice_processing_pending' });
  expect(state.uploads).toBe(1);
  expect(state.attached).toBe(false);
});

test('login in a new tab continues through workbench search and saves exactly once', async ({ page, browser }) => {
  const state = await installOaFixture(page, { recorded: true, loginPopup: true });
  const session = { page, browser, context: page.context() };
  const flow = runReimbursementFlow(session, inputs, new AutomationContext(page), {
    formMode: 'new', action: 'save', siteProfile: profile,
  });
  // Simulated user finishes school login in a second tab; the original tab remains open.
  await page.getByRole('button', { name: '模拟登录' }).click();
  const result = await flow;
  expect(result.verification).toBe('receipt');
  expect(state.creates).toBe(1); expect(state.saves).toBe(1); expect(state.submits).toBe(0);
  expect(page.url()).toContain('ids.shanghaitech.edu.cn');
  expect(session.page).not.toBe(page);
});

test('ambiguous invoice rows stop before confirm without reupload', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, existingInvoice: true, duplicateInvoice: true });
  await expect(attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 1500))
    .rejects.toMatchObject({ code: 'ambiguous_choice' });
  expect(state.uploads).toBe(1); expect(state.attached).toBe(false);
});

test('an upload without a matching invoice row stops, without retrying the upload', async ({ page }) => {
  const state = await installOaFixture(page, { recorded: true, uploadFails: true });
  await expect(attachRecordedInvoice(new AutomationContext(page), process.env.UPLOAD_FILE_PATH!, 800))
    .rejects.toMatchObject({ code: 'invoice_processing_pending' });
  expect(state.uploads).toBe(1); expect(state.attached).toBe(false);
});

test('budget pagination selects a unique later-page row, and rejects cross-page duplicates', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="chooseBudgetOutlaysGrid"><table><tbody></tbody></table>
    <button class="l-bar-btnprev">上一页</button><button class="l-bar-btnnext">下一页</button></div><script>
    let current=0; window.selected=''; window.duplicate=false;
    const render=()=>{document.querySelector('tbody').innerHTML='<tr class="l-grid-row"><td>'+(current===0 ? (window.duplicate?'材料费 A':'差旅费'):'材料费 B')+'</td></tr>';
      document.querySelector('.l-bar-btnprev').disabled=current===0;document.querySelector('.l-bar-btnnext').disabled=current===1;
      document.querySelector('tr').onclick=()=>window.selected=document.querySelector('tr').textContent;};
    document.querySelector('.l-bar-btnprev').onclick=()=>{current--;render();};document.querySelector('.l-bar-btnnext').onclick=()=>{current++;render();};render();</script>` }));
  await page.goto('http://budget.test');
  await chooseBudget(new AutomationContext(page), '材料费', 1000);
  expect(await page.evaluate(() => (window as any).selected)).toBe('材料费 B');
  await page.evaluate(() => { (window as any).duplicate = true; (window as any).selected = ''; });
  await expect(chooseBudget(new AutomationContext(page), '材料费', 1000)).rejects.toMatchObject({ code: 'ambiguous_choice' });
  expect(await page.evaluate(() => (window as any).selected)).toBe('');
});

test('creation never confirms a dialog for a different form', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="#">用款申请单 <button onclick="document.querySelector('[role=dialog]').hidden=false">创建</button></a>
    <div role="dialog" hidden>境内差旅单<button id="ok" onclick="document.body.dataset.confirmed='true'">确定</button></div>` }));
  await page.goto('https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/forwardAddRbReimbursement.do');
  await expect(createPaymentApplication(new AutomationContext(page), 500)).rejects.toMatchObject({ code: 'control_missing' });
  await expect(page.locator('body')).not.toHaveAttribute('data-confirmed', 'true');
});


test('backup showLoad menu continues through application create, funding, invoice, payment and save', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const state = await installOaFixture(page, { recorded: true, missingSearchResult: true, backupMenu: true });
  const session = { page, browser, context: page.context() };
  const ctx = new AutomationContext(page);
  const result = await runReimbursementFlow(session, inputs, ctx, { formMode: 'new', action: 'save', siteProfile: profile });
  expect(ctx.state.backupEntryAttempted).toBe(true);
  expect(ctx.state.entryAttempted).toBe(false);
  expect(ctx.state.creationAttempted).toBe(true);
  expect(state.creates).toBe(1);
  expect(state.order.slice(0, 5)).toEqual(['create', 'funding', 'upload', 'attach', 'payment']);
  expect(state.uploads).toBe(1);
  expect(state.saves).toBe(1);
  expect(state.submits).toBe(0);
  expect(result.verification).toBe('receipt');
  expect(session.page).not.toBe(page);
});


test('creation login timeout closes expired tab, searches again and creates only one actual document', async ({ page, browser }) => {
  const state = await installOaFixture(page, { recorded: true, theme: 'orange', expireFirstCreate: true });
  const session = { page, browser, context: page.context() };
  const opened = [] as import('@playwright/test').Page[];
  page.context().on('page', created => opened.push(created));
  const result = await runReimbursementFlow(session, inputs, new AutomationContext(page), {
    formMode: 'new', action: 'save', siteProfile: profile,
  });
  expect(state.creationAttempts).toBe(2);
  expect(state.creates).toBe(1);
  expect(state.uploads).toBe(1);
  expect(state.saves).toBe(1);
  expect(state.submits).toBe(0);
  expect(opened).toHaveLength(2);
  expect(opened[0].isClosed()).toBe(true);
  expect(opened[1]).toBe(session.page);
  expect(page.isClosed()).toBe(false);
  expect(result.verification).toBe('receipt');
});
