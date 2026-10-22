import path from 'path';
import { DEFAULT_TIMEOUT_MS } from './config';
import { waitAndClick, clickViaJs, dismissBrowserUiOverlays } from './actions';
import { extractInvoiceNumberFromPdf, resolveFirstOrderedInvoiceFile, resolveNextInvoiceToUpload } from './invoice-pdf';
import { resolveFrameForSelector } from './frames';
import type { AutomationContext } from './browser';
import type { Locator } from 'playwright';
import { INVOICE_ENTRY_CONTAINERS, invoiceEntryButtons } from './invoice-entry';
import { uniqueVisible } from './controls';

function invoiceMatchTokens(ctx: AutomationContext, invoiceNumber: string): string[] {
  const tokens = new Set<string>([invoiceNumber]);
  const basename = path.basename(ctx.state.invoicePath, path.extname(ctx.state.invoicePath));
  tokens.add(basename);
  tokens.add(basename.replace(/^digital[_-]?/i, ''));
  return Array.from(tokens).filter(Boolean);
}

const PICKER_FOLDER_TABS = ['自行上传票据', '表单默认票夹'] as const;

async function ensureInvoiceFrameContext(ctx: AutomationContext): Promise<void> {
  const selectors = [
    '#rbReimbursementInvoiceForm',
    INVOICE_ENTRY_CONTAINERS,
    '#editReimburFundingItems',
  ];

  for (const selector of selectors) {
    if (await ctx.root().locator(selector).first().count().catch(() => 0)) {
      return;
    }
  }

  for (const selector of selectors) {
    await resolveFrameForSelector(ctx, selector).catch(() => undefined);
    if (await ctx.root().locator(selector).first().count().catch(() => 0)) {
      return;
    }
  }
}

async function clickPickerFolderTab(ctx: AutomationContext, tabName: string): Promise<boolean> {
  const clicked = await ctx.root().evaluate(({ name }) => {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    const picker = candidates.filter((element) => {
      const text = element.textContent || '';
      return text.includes('请选择') && text.includes('发票列表');
    }).pop();
    if (!picker) {
      return false;
    }

    const listItem = Array.from(picker.querySelectorAll('li'))
      .find((element) => (element.textContent || '').includes(name));
    if (listItem) {
      (listItem as HTMLElement).click();
      return true;
    }

    const textNode = Array.from(picker.querySelectorAll('a, span, div, td'))
      .find((element) => {
        const text = (element.textContent || '').replace(/\s+/g, '');
        return text === name.replace(/\s+/g, '');
      });
    if (textNode) {
      (textNode as HTMLElement).click();
      return true;
    }

    return false;
  }, { name: tabName });

  if (clicked) {
    await ctx.page.waitForTimeout(800);
    await ctx.root().waitForFunction(
      () => !(document.body.innerText || '').includes('加载中'),
      undefined,
      { timeout: 5000 },
    ).catch(() => undefined);
    return true;
  }

  const picker = getInvoicePickerDialog(ctx);
  const tab = picker.locator('li').filter({ hasText: tabName }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ force: true }).catch(() => undefined);
    await ctx.page.waitForTimeout(800);
    return true;
  }

  return false;
}

async function isInvoicePickerDialogVisible(ctx: AutomationContext): Promise<boolean> {
  return ctx.root().evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    return candidates.some((element) => {
      const text = element.textContent || '';
      if (!text.includes('请选择') || !text.includes('发票列表')) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    });
  });
}

async function scrapePickerInvoiceNumbers(ctx: AutomationContext): Promise<string[]> {
  return ctx.root().evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    const picker = candidates.filter((element) => {
      const text = element.textContent || '';
      return text.includes('请选择') && text.includes('发票列表');
    }).pop();
    if (!picker) {
      return [];
    }

    const numbers = new Set<string>();
    for (const row of Array.from(picker.querySelectorAll('tr, .l-grid-row'))) {
      const text = row.textContent || '';
      if (/票种|验真状态|销售方|金额\(含税\)|选择\s*操作/.test(text)) {
        continue;
      }
      for (const match of text.match(/[2]\d{19}/g) || []) {
        numbers.add(match);
      }
    }

    for (const match of picker.textContent?.match(/[2]\d{19}/g) || []) {
      numbers.add(match);
    }

    return Array.from(numbers);
  });
}

async function countPickerDataRows(ctx: AutomationContext): Promise<number> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return -1;
  }

  await ensureSelfUploadTab(ctx);
  await refreshInvoicePickerList(ctx);
  return (await collectNumbersOnCurrentPickerTab(ctx, DEFAULT_TIMEOUT_MS)).length;
}

async function extractCurrentPickerPageInvoiceNumbers(ctx: AutomationContext): Promise<string[]> {
  return ctx.root().evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    const picker = candidates.filter((element) => {
      const text = element.textContent || '';
      return text.includes('请选择') && text.includes('发票列表');
    }).pop();
    if (!picker) {
      return [];
    }

    const numbers = new Set<string>();
    for (const row of Array.from(picker.querySelectorAll('tr, .l-grid-row'))) {
      const text = row.textContent || '';
      if (/票种|验真状态|销售方|金额\(含税\)|选择\s*操作/.test(text)) {
        continue;
      }
      if (!(/[2]\d{19}/.test(text) || /\d+\.\d{2}/.test(text))) {
        continue;
      }
      for (const match of text.match(/[2]\d{19}/g) || []) {
        numbers.add(match);
      }
    }
    return Array.from(numbers);
  });
}

async function collectNumbersOnCurrentPickerTab(
  ctx: AutomationContext,
  timeoutMs: number,
): Promise<string[]> {
  const numbers: string[] = [];
  for (let page = 0; page < 20; page += 1) {
    numbers.push(...await extractCurrentPickerPageInvoiceNumbers(ctx));
    if (!(await goToNextPickerPage(ctx))) {
      break;
    }
  }

  // Return to first page so later steps start from a stable state.
  const picker = getInvoicePickerDialog(ctx);
  const firstPageButton = picker.locator('button').filter({ hasText: /^1$/ }).first();
  if (await firstPageButton.isVisible().catch(() => false)) {
    await firstPageButton.click().catch(() => undefined);
    await ctx.page.waitForTimeout(400);
  }

  return numbers;
}

async function goToNextPickerPage(ctx: AutomationContext): Promise<boolean> {
  const picker = getInvoicePickerDialog(ctx);
  const nextCandidates = [
    picker.locator('.l-bar-button .l-icon-next').first(),
    picker.locator('.l-icon-next').first(),
    picker.locator('button').filter({ hasText: /下一页|›/ }).first(),
  ];

  for (const nextButton of nextCandidates) {
    if (!(await nextButton.isVisible().catch(() => false))) {
      continue;
    }

    const disabled = await nextButton.evaluate((element) => {
      return element.classList.contains('l-disabled')
        || Boolean(element.closest('.l-disabled'));
    }).catch(() => true);
    if (disabled) {
      return false;
    }

    await nextButton.click({ force: true }).catch(() => undefined);
    await ctx.page.waitForTimeout(800);
    await ctx.root().waitForFunction(
      () => !(document.body.innerText || '').includes('加载中'),
      undefined,
      { timeout: 5000 },
    ).catch(() => undefined);
    return true;
  }

  return false;
}

export async function collectPickerInvoiceNumbers(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Set<string>> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    console.warn('Invoice picker dialog not visible; cannot scan invoice numbers.');
    return new Set();
  }

  console.log('扫描票夹发票号（自行上传票据 + 表单默认票夹）…');
  await refreshInvoicePickerList(ctx, timeoutMs);
  await ctx.page.waitForTimeout(500);

  const numbers = new Set<string>();

  for (const tabName of PICKER_FOLDER_TABS) {
    const switched = await clickPickerFolderTab(ctx, tabName);
    if (!switched) {
      console.warn(`Could not switch to picker tab "${tabName}".`);
    }

    await refreshInvoicePickerList(ctx, timeoutMs);
    const tabNumbers = await collectNumbersOnCurrentPickerTab(ctx, timeoutMs);
    tabNumbers.forEach((value) => numbers.add(value));

    if (tabNumbers.length > 0) {
      console.log(`Picker tab "${tabName}": ${tabNumbers.length} invoice(s) found.`);
    }
  }

  const scraped = await scrapePickerInvoiceNumbers(ctx);
  const beforeScrape = numbers.size;
  scraped.forEach((value) => numbers.add(value));
  if (scraped.length > 0 && beforeScrape === 0) {
    console.log(`Picker fallback scan found ${scraped.length} invoice number(s).`);
  }

  if (numbers.size > 0) {
    console.log(
      `Picker contains ${numbers.size} invoice number(s): ${Array.from(numbers).slice(0, 5).join(', ')}${numbers.size > 5 ? '...' : ''}`,
    );
  } else {
    console.warn('No invoice numbers found in picker after scanning all tabs.');
  }

  return numbers;
}

async function collectPickerInvoiceNumbersWithRetry(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Set<string>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const numbers = await collectPickerInvoiceNumbers(ctx, timeoutMs);
    if (numbers.size > 0) {
      return numbers;
    }
    await ctx.page.waitForTimeout(1000);
  }
  return collectPickerInvoiceNumbers(ctx, timeoutMs);
}

async function findUploadedInvoiceRowIndex(
  ctx: AutomationContext,
  invoiceNumber: string,
): Promise<number> {
  return ctx.root().evaluate(({ number }) => {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    const picker = candidates.filter((element) => {
      const text = element.textContent || '';
      return text.includes('请选择') && text.includes('发票列表');
    }).pop();
    if (!picker) {
      return -1;
    }

    const dataRows = Array.from(picker.querySelectorAll('tr, .l-grid-row')).filter((row) => {
      const text = row.textContent || '';
      if (/票种|验真状态|销售方|金额\(含税\)|选择\s*操作/.test(text)) {
        return false;
      }
      return /[2]\d{19}/.test(text) || /\d+\.\d{2}/.test(text);
    });

    return dataRows.findIndex((row) => (row.textContent || '').includes(number));
  }, { number: invoiceNumber });
}

async function refreshInvoicePickerList(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return;
  }

  const picker = getInvoicePickerDialog(ctx);
  const searchButton = picker.locator('button').filter({ hasText: '查询' }).first();
  if (await searchButton.isVisible().catch(() => false)) {
    console.log('Refreshing invoice picker list (查询)...');
    await clickViaJs(ctx, searchButton, 'refresh-invoice-picker', timeoutMs);
    await waitForBlockingMaskToClear(ctx, Math.min(timeoutMs, 15000)).catch(() => undefined);
    await ctx.root().waitForFunction(
      () => !(document.body.innerText || '').includes('加载中'),
      undefined,
      { timeout: Math.min(timeoutMs, 15000) },
    ).catch(() => undefined);
  }
}

async function ensureInvoicePickerOpenForSelection(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (await isInvoicePickerDialogVisible(ctx)) {
    return;
  }

  if (await isAddInvoiceDialogOpen(ctx)) {
    console.log('发票选择列表已关闭，从「添加发票」对话框重新打开…');
    await clickInvoiceUploadButton(ctx, timeoutMs);
    await assertInvoicePickerOpen(ctx, timeoutMs);
    await refreshInvoicePickerList(ctx, timeoutMs);
    return;
  }

  console.log('发票选择列表未打开，尝试从主表单打开…');
  await ensureInvoicePickerReady(ctx, timeoutMs);
  await assertInvoicePickerOpen(ctx, timeoutMs);
}

async function selectUploadedInvoiceRow(
  ctx: AutomationContext,
  invoiceNumber: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return false;
  }

  for (const tabName of PICKER_FOLDER_TABS) {
    if (!(await clickPickerFolderTab(ctx, tabName))) {
      continue;
    }

    await refreshInvoicePickerList(ctx, timeoutMs);

    for (let page = 0; page < 20; page += 1) {
      const rowIndex = await findUploadedInvoiceRowIndex(ctx, invoiceNumber);
      if (rowIndex >= 0) {
        const picker = getInvoicePickerDialog(ctx);
        const chooseLink = picker.getByRole('link', { name: '选择', exact: true }).nth(rowIndex);
        await chooseLink.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 10000) });
        console.log(
          `Clicking 选择 in tab "${tabName}", page ${page + 1}, row ${rowIndex} for invoice ${invoiceNumber}`,
        );
        await clickViaJs(ctx, chooseLink, 'choose-uploaded-row', timeoutMs);
        return true;
      }

      if (!(await goToNextPickerPage(ctx))) {
        break;
      }
    }
  }

  console.warn(`Invoice row not found for invoice number ${invoiceNumber}.`);
  return false;
}

function getInvoicePickerDialog(ctx: AutomationContext): Locator {
  return ctx.root().locator('.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog')
    .filter({ hasText: '请选择' })
    .filter({ hasText: '发票列表' })
    .last();
}

function getAddInvoiceDialog(ctx: AutomationContext): Locator {
  return ctx.root().locator('.ui_dialog, .ui-dialog')
    .filter({ has: ctx.root().locator('#rbReimbursementInvoiceForm') })
    .last();
}

export async function isAddInvoiceFormPopulated(ctx: AutomationContext): Promise<boolean> {
  return ctx.root().evaluate(() => {
    const amount = document.querySelector('#actualAmount') as HTMLInputElement | null;
    const code = document.querySelector('#invoiceCode') as HTMLInputElement | null;
    return Boolean(String(amount?.value || '').trim() || String(code?.value || '').trim());
  });
}

export async function waitForAddInvoiceFormPopulated(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ctx.root().waitForFunction(() => {
    const amount = document.querySelector('#actualAmount') as HTMLInputElement | null;
    const code = document.querySelector('#invoiceCode') as HTMLInputElement | null;
    return Boolean(String(amount?.value || '').trim() || String(code?.value || '').trim());
  }, undefined, { timeout: timeoutMs });
}

async function waitForInvoicePickerReady(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ensureInvoicePickerReady(ctx, timeoutMs);
}

/** Open 添加发票 dialog + invoice file picker when resuming from a closed state. */
export async function ensureInvoicePickerReady(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ensureInvoiceFrameContext(ctx);

  if (await isInvoicePickerDialogVisible(ctx)) {
    return;
  }

  if (!(await isAddInvoiceDialogOpen(ctx))) {
    console.log('No 添加发票 dialog visible; opening invoice upload from main form...');
    await waitForBlockingMaskToClear(ctx, Math.min(timeoutMs, 10000)).catch(() => undefined);

    const mainUploadButton = await uniqueVisible(invoiceEntryButtons(ctx.root(), 'single'), timeoutMs);
    await mainUploadButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await waitAndClick(ctx, mainUploadButton, 'main-invoice-upload-button', timeoutMs);

    if (!(await isAddInvoiceDialogOpen(ctx))) {
      await openAddInvoiceDialog(ctx);
    }
  }

  if (!(await isInvoiceFilePickerOpen(ctx)) && (await isAddInvoiceDialogOpen(ctx))) {
    console.log('Opening invoice file picker from 添加发票 dialog...');
    await clickInvoiceUploadButton(ctx, timeoutMs);
  }

  if (!(await isInvoiceFilePickerOpen(ctx))) {
    const toolbarUpload = ctx.locator('#toolbar_menuuploadInvoice').first();
    if (await toolbarUpload.isVisible().catch(() => false)) {
      await clickViaJs(ctx, toolbarUpload, 'toolbar-upload-invoice', timeoutMs);
    }
  }

  await ctx.root().waitForFunction(() => {
    const text = document.body.innerText || '';
    return text.includes('发票列表') && text.includes('请选择');
  }, undefined, { timeout: timeoutMs });

  if (!(await isInvoicePickerDialogVisible(ctx))) {
    throw new Error(
      'Invoice file picker did not open. Close any blocking dialogs and retry from "open invoice buttons".',
    );
  }
}

function pickerUploadSuccessCheckScript() {
  return function pickerUploadSuccessCheck({ beforeCount, tokens }: { beforeCount: number; tokens: string[] }) {
    const candidates = Array.from(document.querySelectorAll(
      '.ui_dialog, .ui-dialog, [id^="ldg_dialog"], .l-dialog',
    ));
    const picker = candidates.filter((element) => {
      const text = element.textContent || '';
      return text.includes('请选择') && text.includes('发票列表');
    }).pop();
    if (!picker) {
      return false;
    }

    const dataRows = Array.from(picker.querySelectorAll('tr, .l-grid-row')).filter((row) => {
      const text = row.textContent || '';
      return /\d+\.\d{2}/.test(text)
        && !/票种|验真状态|销售方|金额\(含税\)|选择\s*操作/.test(text);
    });

    const tokenMatched = dataRows.some((row) => {
      const text = row.textContent || '';
      return tokens.some((token) => token.length >= 8 && text.includes(token));
    });
    if (tokenMatched) {
      return true;
    }

    return beforeCount >= 0 && dataRows.length > beforeCount;
  };
}

async function waitForPickerUploadSuccess(
  ctx: AutomationContext,
  rowCountBefore: number,
  invoiceNumber: string,
  timeoutMs: number,
): Promise<void> {
  const matchTokens = invoiceMatchTokens(ctx, invoiceNumber);
  await ctx.root().waitForFunction(
    pickerUploadSuccessCheckScript(),
    { beforeCount: rowCountBefore, tokens: matchTokens },
    { timeout: timeoutMs },
  );
}

async function assertInvoicePickerOpen(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ensureInvoiceFrameContext(ctx);

  if (await isInvoicePickerDialogVisible(ctx)) {
    return;
  }

  console.log('Invoice picker not visible; reopening from 添加发票 dialog...');
  if (await isAddInvoiceDialogOpen(ctx)) {
    await clickInvoiceUploadButton(ctx, timeoutMs);
  } else {
    await ensureInvoicePickerReady(ctx, timeoutMs);
  }

  await ctx.root().waitForFunction(() => {
    const text = document.body.innerText || '';
    return text.includes('自行上传票据') && text.includes('发票列表');
  }, undefined, { timeout: timeoutMs });

  if (!(await isInvoicePickerDialogVisible(ctx))) {
    throw new Error('Invoice picker (请选择 / 发票列表) is not open.');
  }
}

function getPickerUploadInput(ctx: AutomationContext): Locator {
  return ctx.root().locator(
    'input[name="upload"], input[type="file"], .webuploader-element-invisible',
  );
}

async function setFilesOnAnyUploadInput(
  ctx: AutomationContext,
  resolvedPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const selector = 'input[name="upload"], input[type="file"], .webuploader-element-invisible';
  await ctx.root().waitForFunction(
    (inputSelector) => document.querySelectorAll(inputSelector).length > 0,
    selector,
    { timeout: Math.min(timeoutMs, 10000) },
  ).catch(() => undefined);

  const inputs = getPickerUploadInput(ctx);
  const count = await inputs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    try {
      await input.waitFor({ state: 'attached', timeout: Math.min(timeoutMs, 5000) });
      await input.setInputFiles(resolvedPath);
      await input.evaluate((element) => {
        const fileInput = element as HTMLInputElement;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return true;
    } catch {
      // try next input
    }
  }

  return false;
}

async function clickPickerUploadButton(ctx: AutomationContext, label: string, timeoutMs: number): Promise<void> {
  await assertInvoicePickerOpen(ctx, timeoutMs);

  const candidates = [
    getInvoicePickerDialog(ctx).locator('button').filter({ hasText: '上传' }).first(),
    getInvoicePickerDialog(ctx).getByRole('button', { name: /上传/ }).first(),
    ctx.root().locator('button:visible').filter({ hasText: /^上传$/ }).last(),
    ctx.root().locator('button:visible').filter({ has: ctx.root().locator('i.fa-upload') }).last(),
  ];

  for (const button of candidates) {
    if (await button.isVisible().catch(() => false)) {
      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      console.log('Clicking picker 上传 button...');
      await button.click({ timeout: timeoutMs, force: true }).catch(async () => {
        await clickViaJs(ctx, button, `${label}-picker-upload`, timeoutMs);
      });
      return;
    }
  }

  throw new Error('Picker 上传 button not found.');
}

/**
 * Upload PDF without relying on macOS Open dialog (Katalon: input[name=upload].sendKeys).
 * Falls back to 上传 click + setInputFiles, then macOS dialog only if needed.
 */
async function uploadPdfInPicker(
  ctx: AutomationContext,
  filePath: string,
  label: string,
  rowCountBefore: number,
  invoiceNumber: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const waitMs = Math.min(timeoutMs, 60000);

  await assertInvoicePickerOpen(ctx, timeoutMs);
  await ensureSelfUploadTab(ctx);

  // Method B first: click 上传 → pick file (matches manual workflow in screenshot)
  console.log('Method B: click 上传, then attach invoice PDF...');
  try {
    const fileChooserPromise = ctx.page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    await clickPickerUploadButton(ctx, label, timeoutMs);
    const fileChooser = await fileChooserPromise;

    if (fileChooser) {
      await fileChooser.setFiles(resolvedPath);
    } else {
      const attached = await setFilesOnAnyUploadInput(ctx, resolvedPath, timeoutMs);
      if (!attached) {
        throw new Error('No file input found after clicking 上传.');
      }
    }

    await waitForPickerUploadSuccess(ctx, rowCountBefore, invoiceNumber, waitMs);
    console.log('Upload succeeded after 上传 click + file attach.');
    await refreshInvoicePickerList(ctx, timeoutMs);
    return;
  } catch (errorB) {
    const messageB = errorB instanceof Error ? errorB.message : String(errorB);
    console.warn(`Method B failed: ${messageB}`);
  }

  await assertInvoicePickerOpen(ctx, timeoutMs);

  // Method A fallback: direct setInputFiles (Katalon sendKeys style)
  console.log(`Method A: setInputFiles on page file inputs → ${resolvedPath}`);
  try {
    const uploadResponse = ctx.page.waitForResponse(
      (response) => response.ok() && /upload|invoice|attach|file|webuploader/i.test(response.url()),
      { timeout: waitMs },
    ).catch(() => null);

    const attached = await setFilesOnAnyUploadInput(ctx, resolvedPath, timeoutMs);
    if (!attached) {
      throw new Error('No file input found on page.');
    }

    await uploadResponse;
    await waitForPickerUploadSuccess(ctx, rowCountBefore, invoiceNumber, waitMs);
    console.log('Upload succeeded via hidden input (no OS file dialog).');
    await refreshInvoicePickerList(ctx, timeoutMs);
    return;
  } catch (errorA) {
    const messageA = errorA instanceof Error ? errorA.message : String(errorA);
    console.warn(`Method A failed: ${messageA}`);
  }

  await assertInvoicePickerOpen(ctx, timeoutMs);

  throw new Error(
    `Upload failed for ${resolvedPath}. `
    + 'Use Playwright file attach (上传 + setInputFiles). Do not enable macOS dialog fallback for invoices.',
  );
}

async function closeInvoicePickerIfOpen(
  ctx: AutomationContext,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return;
  }

  const closeButton = getInvoicePickerDialog(ctx).getByRole('button', { name: '关闭' }).first();
  if (await closeButton.isVisible().catch(() => false)) {
    await clickViaJs(ctx, closeButton, `${label}-close-picker`, timeoutMs);
    await ctx.root().waitForFunction(
      () => !document.body.innerText.includes('自行上传票据') || !document.body.innerText.includes('显示0到0,共0条'),
      undefined,
      { timeout: Math.min(timeoutMs, 5000) },
    ).catch(() => undefined);
  }
}

/** After 选择: wait for OCR to fill 添加发票 or invoice to appear on main form. */
async function waitForInvoiceSelectionApplied(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ctx.root().waitForFunction(() => {
    const amount = document.querySelector('#actualAmount') as HTMLInputElement | null;
    const code = document.querySelector('#invoiceCode') as HTMLInputElement | null;
    const populated = Boolean(String(amount?.value || '').trim() || String(code?.value || '').trim());

    const totalAmount = document.querySelector('#actualTotalAmount') as HTMLInputElement | null;
    const totalAmountValue = totalAmount ? String(totalAmount.value || '').trim() : '';
    const invoiceRows = Array.from(document.querySelectorAll('#invoiceGrid tr, #invoiceGrid .l-grid-row'));
    const hasInvoiceRow = invoiceRows.some((row) => /\d+\.\d{2}/.test(row.textContent || ''));

    return populated || hasInvoiceRow || Boolean(totalAmountValue && totalAmountValue !== '0.00');
  }, undefined, { timeout: timeoutMs });
}

export async function saveAddInvoiceDialog(
  ctx: AutomationContext,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!(await isAddInvoiceDialogOpen(ctx))) {
    return;
  }

  await waitForAddInvoiceFormPopulated(ctx, timeoutMs);

  const saveButton = getAddInvoiceDialog(ctx).locator('#ok').first();
  await clickViaJs(ctx, saveButton, label, timeoutMs);
  await waitForBlockingMaskToClear(ctx, Math.min(timeoutMs, 10000)).catch(() => undefined);
  await waitForUploadedInvoiceReady(ctx, timeoutMs);
}

export async function ensureInvoiceSavedToMainForm(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (await isUploadedInvoiceReady(ctx)) {
    return;
  }

  if (await isInvoicePickerDialogVisible(ctx)) {
    const invoiceNumber = ctx.state.invoiceNumber
      || (ctx.state.invoicePath
        ? await extractInvoiceNumberFromPdf(ctx.state.invoicePath).catch(() => '')
        : '');
    if (invoiceNumber && await selectUploadedInvoiceRow(ctx, invoiceNumber, timeoutMs)) {
      await waitForInvoiceSelectionApplied(ctx, timeoutMs).catch(() => undefined);
    }
    await closeInvoicePickerIfOpen(ctx, 'ensure-invoice-saved', timeoutMs);
  }

  if (await isAddInvoiceDialogOpen(ctx)) {
    await saveAddInvoiceDialog(ctx, 'ensure-invoice-saved', timeoutMs);
  }
}

export async function isAddInvoiceDialogOpen(ctx: AutomationContext): Promise<boolean> {
  return ctx.root().evaluate(() => {
    function isVisible(element: Element | null) {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0;
    }

    return Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder]'))
      .some((element) => {
        const placeholder = element.getAttribute('placeholder') || '';
        return isVisible(element) && placeholder.includes('电子发票');
      });
  });
}

/** Invoice file picker dialog: 请选择… / 发票列表 */
export async function isInvoiceFilePickerOpen(ctx: AutomationContext): Promise<boolean> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return false;
  }

  const picker = getInvoicePickerDialog(ctx);
  const hasUploadAction = await picker.locator('button').filter({ hasText: '上传' }).first()
    .isVisible()
    .catch(() => false);
  return hasUploadAction;
}

export async function waitForBlockingMaskToClear(ctx: AutomationContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await ctx.root().waitForFunction(() => {
    const masks = Array.from(document.querySelectorAll('#ldg_lockmask, .lockmask, .ui-widget-overlay, .modal-backdrop'));
    return masks.every((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width === 0
        || rect.height === 0
        || style.display === 'none'
        || style.visibility === 'hidden'
        || Number(style.opacity) === 0;
    });
  }, undefined, { timeout: timeoutMs });
}

export async function openAddInvoiceDialog(ctx: AutomationContext): Promise<void> {
  await ensureInvoiceFrameContext(ctx);

  if (await isAddInvoiceDialogOpen(ctx)) {
    return;
  }

  await waitForBlockingMaskToClear(ctx);
  await waitAndClick(
    ctx,
    await uniqueVisible(invoiceEntryButtons(ctx.root(), 'single')),
    'invoice-button',
  );
  await ctx.root().waitForFunction(() => {
    function isVisible(element: Element | null) {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    return Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder]'))
      .some((element) => isVisible(element) && (element.getAttribute('placeholder') || '').includes('电子发票'));
  }, undefined, { timeout: DEFAULT_TIMEOUT_MS });
}

export async function clickInvoiceUploadButton(ctx: AutomationContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await ensureInvoiceFrameContext(ctx);

  const dialogUploadButton = getAddInvoiceDialog(ctx)
    .locator('#invoiceCode_click button, #invoiceCode_click .btn-choose button')
    .first();

  if (await dialogUploadButton.isVisible().catch(() => false)) {
    await dialogUploadButton.click({ timeout: timeoutMs, force: true }).catch(async () => {
      await clickViaJs(ctx, dialogUploadButton, 'add-invoice-upload-button', timeoutMs);
    });
    return;
  }

  await ctx.root().waitForFunction(() => {
    function isVisible(element: Element | null) {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity) !== 0;
    }

    const invoiceInput = Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder]'))
      .find((element) => {
        const placeholder = element.getAttribute('placeholder') || '';
        return isVisible(element) && placeholder.includes('电子发票');
      });

    if (!invoiceInput) {
      return false;
    }

    const inputRect = invoiceInput.getBoundingClientRect();
    const inputCenterY = inputRect.top + inputRect.height / 2;
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, .l-btn, .we-button'))
      .filter((element) => {
        if (!isVisible(element)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const isRightOfInput = rect.left >= inputRect.right - 4;
        const isSameRow = Math.abs((rect.top + rect.height / 2) - inputCenterY) < 24;
        return isRightOfInput && isSameRow;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    const uploadButton = candidates[0];
    if (!uploadButton) {
      return false;
    }

    uploadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, undefined, { timeout: timeoutMs });
}

export async function isUploadedInvoiceReady(ctx: AutomationContext): Promise<boolean> {
  return ctx.root().evaluate(() => {
    const totalAmount = document.querySelector('#actualTotalAmount') as HTMLInputElement | null;
    const totalAmountValue = totalAmount ? String(totalAmount.value || '').trim() : '';
    const invoiceRows = Array.from(document.querySelectorAll('#invoiceGrid tr, #invoiceGrid .l-grid-row'));
    const hasInvoiceRow = invoiceRows.some((row) => /\d+\.\d{2}/.test(row.textContent || ''));

    return Boolean(hasInvoiceRow || (totalAmountValue && totalAmountValue !== '0.00'));
  });
}

export async function waitForUploadedInvoiceReady(ctx: AutomationContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await ctx.root().waitForFunction(() => {
    const totalAmount = document.querySelector('#actualTotalAmount') as HTMLInputElement | null;
    const totalAmountValue = totalAmount ? String(totalAmount.value || '').trim() : '';
    const invoiceRows = Array.from(document.querySelectorAll('#invoiceGrid tr, #invoiceGrid .l-grid-row'));
    const hasInvoiceRow = invoiceRows.some((row) => /\d+\.\d{2}/.test(row.textContent || ''));
    return Boolean(hasInvoiceRow || (totalAmountValue && totalAmountValue !== '0.00'));
  }, undefined, { timeout: timeoutMs });
}

async function ensureSelfUploadTab(ctx: AutomationContext): Promise<void> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    return;
  }

  await clickPickerFolderTab(ctx, '自行上传票据');
}

export async function clickInvoiceDialogUploadButton(ctx: AutomationContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await ensureInvoiceFrameContext(ctx);

  if (await isUploadedInvoiceReady(ctx)) {
    console.log('Invoice already uploaded; skipping invoice dialog upload button.');
    return;
  }

  if (await isInvoicePickerDialogVisible(ctx)) {
    console.log('Invoice file picker already open; skipping toolbar upload button click.');
    return;
  }

  await ensureInvoicePickerReady(ctx, timeoutMs);
}

export async function uploadInvoiceFile(
  ctx: AutomationContext,
  filePath: string,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ensureInvoiceFrameContext(ctx);
  await dismissBrowserUiOverlays(ctx);
  await waitForInvoicePickerReady(ctx, timeoutMs);
  await assertInvoicePickerOpen(ctx, timeoutMs);

  const pickerNumbers = await collectPickerInvoiceNumbersWithRetry(ctx, timeoutMs);
  const nextInvoice = await resolveNextInvoiceToUpload(filePath, pickerNumbers);

  if (!nextInvoice) {
    const firstOrdered = await resolveFirstOrderedInvoiceFile(filePath);
    ctx.state.invoicePath = firstOrdered.filePath;
    ctx.state.invoiceNumber = firstOrdered.invoiceNumber;
    console.log(
      `将选择排序第一的发票 ${firstOrdered.invoiceNumber}（${path.basename(firstOrdered.filePath)}）。`,
    );
    return;
  }

  const { filePath: resolvedPath, invoiceNumber } = nextInvoice;
  ctx.state.invoicePath = resolvedPath;
  ctx.state.invoiceNumber = invoiceNumber;

  await ensureSelfUploadTab(ctx);
  await refreshInvoicePickerList(ctx, timeoutMs);

  const rowCountBefore = await countPickerDataRows(ctx);
  if (rowCountBefore < 0) {
    throw new Error('Invoice picker is not open; cannot count existing invoice rows.');
  }
  ctx.state.pickerRowCountBefore = rowCountBefore;

  console.log(`Uploading invoice ${invoiceNumber} (picker rows before: ${rowCountBefore})`);

  await uploadPdfInPicker(
    ctx,
    resolvedPath,
    label,
    rowCountBefore,
    invoiceNumber,
    timeoutMs,
  );

  await waitForBlockingMaskToClear(ctx, Math.min(timeoutMs, 15000)).catch(() => undefined);

  if (!(await isInvoicePickerDialogVisible(ctx))) {
    throw new Error('Invoice picker closed before upload finished. Re-open the picker and retry upload.');
  }

  await waitForNewInvoiceRowInPicker(ctx, rowCountBefore, invoiceNumber, timeoutMs);
}

export async function waitForNewInvoiceRowInPicker(
  ctx: AutomationContext,
  rowCountBefore: number,
  invoiceNumber: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    throw new Error('Invoice picker is not open while waiting for newly uploaded invoice row.');
  }

  const matchTokens = invoiceMatchTokens(ctx, invoiceNumber);
  await ctx.root().waitForFunction(
    pickerUploadSuccessCheckScript(),
    { beforeCount: rowCountBefore, tokens: matchTokens },
    { timeout: timeoutMs },
  );
}

export async function waitForInvoiceRowInPicker(
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (!(await isInvoicePickerDialogVisible(ctx))) {
    throw new Error('Invoice picker is not open while waiting for uploaded invoice row.');
  }

  await ctx.root().waitForFunction(() => {
    const bodyText = document.body.innerText || '';
    if (/显示[1-9]\d*到[1-9]\d*,共[1-9]\d*条/.test(bodyText)) {
      return true;
    }

    return Array.from(document.querySelectorAll('tr, .l-grid-row'))
      .some((row) => {
        const text = row.textContent || '';
        return /\d+\.\d{2}/.test(text)
          && !/票种|验真状态|销售方|金额\(含税\)/.test(text);
      });
  }, undefined, { timeout: timeoutMs });
}

export async function chooseUploadedInvoiceInPicker(
  ctx: AutomationContext,
  label: string,
  filePath?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ensureInvoiceFrameContext(ctx);
  await dismissBrowserUiOverlays(ctx);
  if (await isUploadedInvoiceReady(ctx)) {
    return;
  }

  let invoiceNumber = ctx.state.invoiceNumber;
  if (!invoiceNumber && filePath) {
    if (!ctx.state.invoicePath) {
      const pickerNumbers = await isInvoicePickerDialogVisible(ctx)
        ? await collectPickerInvoiceNumbers(ctx, timeoutMs)
        : new Set<string>();
      const next = await resolveNextInvoiceToUpload(filePath, pickerNumbers);
      if (next) {
        ctx.state.invoicePath = next.filePath;
        ctx.state.invoiceNumber = next.invoiceNumber;
        invoiceNumber = next.invoiceNumber;
      } else {
        const firstOrdered = await resolveFirstOrderedInvoiceFile(filePath);
        ctx.state.invoicePath = firstOrdered.filePath;
        ctx.state.invoiceNumber = firstOrdered.invoiceNumber;
        invoiceNumber = firstOrdered.invoiceNumber;
      }
    }
  }
  if (!invoiceNumber && ctx.state.invoicePath) {
    invoiceNumber = await extractInvoiceNumberFromPdf(ctx.state.invoicePath).catch(() => '');
    ctx.state.invoiceNumber = invoiceNumber;
  }

  if (!invoiceNumber) {
    throw new Error('No uploaded invoice number recorded. Run upload invoice file step first.');
  }

  if (await isAddInvoiceDialogOpen(ctx) && !(await isInvoicePickerDialogVisible(ctx))) {
    const hasManualData = await ctx.root().evaluate(() => {
      const amount = document.querySelector('#actualAmount') as HTMLInputElement | null;
      const code = document.querySelector('#invoiceCode') as HTMLInputElement | null;
      return Boolean(String(amount?.value || '').trim() || String(code?.value || '').trim());
    });

    if (hasManualData) {
      console.log('Manual 添加发票 dialog has OCR data; skipping picker 选择 step.');
      return;
    }
  }

  await ensureInvoicePickerOpenForSelection(ctx, timeoutMs);

  if (await isInvoicePickerDialogVisible(ctx)) {
    await clickPickerFolderTab(ctx, '自行上传票据');
    await refreshInvoicePickerList(ctx, timeoutMs);
    await waitForNewInvoiceRowInPicker(
      ctx,
      ctx.state.pickerRowCountBefore >= 0 ? ctx.state.pickerRowCountBefore : 0,
      invoiceNumber,
      timeoutMs,
    ).catch(() => undefined);
  }

  console.log(`Selecting invoice in picker by number: ${invoiceNumber}`);
  let selected = await selectUploadedInvoiceRow(ctx, invoiceNumber, timeoutMs);
  if (!selected) {
    await refreshInvoicePickerList(ctx, timeoutMs);
    selected = await selectUploadedInvoiceRow(ctx, invoiceNumber, timeoutMs);
  }
  if (!selected) {
    throw new Error(
      `Could not find invoice ${invoiceNumber} in the picker list. `
      + 'Ensure upload succeeded and the invoice number appears in the 发票号 column.',
    );
  }

  await waitForInvoiceSelectionApplied(ctx, Math.min(timeoutMs, 30000));
}

export async function confirmUploadedInvoiceSelection(
  ctx: AutomationContext,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (await isUploadedInvoiceReady(ctx)) {
    return;
  }

  if (!(await isAddInvoiceFormPopulated(ctx))) {
    if (await isInvoicePickerDialogVisible(ctx)) {
      throw new Error(
        '添加发票 form is still empty — 选择 did not apply. Re-run from "choose uploaded file".',
      );
    }
    await waitForAddInvoiceFormPopulated(ctx, timeoutMs);
  }

  if (await isInvoicePickerDialogVisible(ctx)) {
    await closeInvoicePickerIfOpen(ctx, label, timeoutMs);
  }

  if (await isUploadedInvoiceReady(ctx)) {
    return;
  }

  if (await isAddInvoiceDialogOpen(ctx)) {
    await saveAddInvoiceDialog(ctx, label, timeoutMs);
    return;
  }

  if (!(await isUploadedInvoiceReady(ctx))) {
    throw new Error('Invoice was not saved to the reimbursement form after confirmation.');
  }
}

export async function skipIfInvoiceUploaded(
  ctx: AutomationContext,
  action: () => Promise<void>,
  message?: string,
): Promise<void> {
  if (await isUploadedInvoiceReady(ctx)) {
    console.log(message || 'Invoice already uploaded; skipping step.');
    return;
  }

  await action();
}
