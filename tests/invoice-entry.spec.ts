import { test, expect } from '@playwright/test';
import { AutomationContext } from '../src/automation/browser';
import { waitForInvoiceEntry } from '../src/automation/invoice-entry';

function invoiceButtons(options: { ordinary?: string; batch?: string } = {}): string {
  const ordinary = options.ordinary === undefined ? 'ordinary' : options.ordinary;
  const batch = options.batch === undefined ? 'batch' : options.batch;
  return `<div class="rbReimbursementInvoiceButtons">
    ${ordinary ? `<button id="${ordinary}"><i class="fa fa-plus"></i>&nbsp;增值税发票/电子发票上传</button>` : ''}
  </div>
  <div class="rbReimbursementInvoiceButtons">
    ${batch ? `<button id="${batch}"><i class="fa fa-plus"></i>&nbsp;增值税发票/电子发票上传(批量)</button>` : ''}
  </div>`;
}

test('real two-container markup returns the batch upload entry', async ({ page }) => {
  await page.setContent(invoiceButtons());
  const entry = await waitForInvoiceEntry(new AutomationContext(page), 500);
  await expect(entry).toHaveAttribute('id', 'batch');
});

test('when batch is absent, the single ordinary upload entry is accepted', async ({ page }) => {
  await page.setContent(invoiceButtons({ batch: '' }));
  const entry = await waitForInvoiceEntry(new AutomationContext(page), 500);
  await expect(entry).toHaveAttribute('id', 'ordinary');
});

test('the legacy invoice entry id remains supported', async ({ page }) => {
  await page.setContent(`<div id="rbReimbursementInvoiceButtons"><button id="legacy">增值税发票/电子发票上传</button></div>`);
  const entry = await waitForInvoiceEntry(new AutomationContext(page), 500);
  await expect(entry).toHaveAttribute('id', 'legacy');
});

test('hidden ordinary or batch duplicates do not make the visible entry ambiguous', async ({ page }) => {
  await page.setContent(`<div hidden>${invoiceButtons({ ordinary: 'hidden-ordinary', batch: 'hidden-batch' })}</div>
    ${invoiceButtons({ ordinary: 'ordinary', batch: 'batch' })}`);
  const entry = await waitForInvoiceEntry(new AutomationContext(page), 500);
  await expect(entry).toHaveAttribute('id', 'batch');
});

test('invoice entry is found in a nested iframe and adopts its frame', async ({ page }) => {
  await page.setContent('<iframe title="outer" style="width:900px;height:500px"></iframe>');
  await page.frameLocator('iframe').locator('body').evaluate((body, markup) => {
    const frame = document.createElement('iframe');
    frame.title = 'inner';
    frame.style.cssText = 'width:800px;height:400px';
    frame.srcdoc = markup;
    body.append(frame);
  }, invoiceButtons({ ordinary: 'inner-ordinary', batch: 'inner-batch' }));
  const ctx = new AutomationContext(page);
  const entry = await waitForInvoiceEntry(ctx, 1000);
  await expect(entry).toHaveAttribute('id', 'inner-batch');
  expect(ctx.activeFrame).not.toBeNull();
  expect(ctx.activeFrame?.url()).toContain('srcdoc');
});

test('a leading private-use icon is accepted in the batch accessible name', async ({ page }) => {
  await page.setContent('<div class="rbReimbursementInvoiceButtons"><button id="icon-batch">&#xf067;&nbsp;增值税发票/电子发票上传（批量）</button></div>');
  const entry = await waitForInvoiceEntry(new AutomationContext(page), 500);
  await expect(entry).toHaveAttribute('id', 'icon-batch');
});

test('multiple visible batch buttons fail closed before any click', async ({ page }) => {
  await page.setContent(`<div class="rbReimbursementInvoiceButtons">
      <button>增值税发票/电子发票上传(批量)</button>
    </div>
    <div class="rbReimbursementInvoiceButtons">
      <button>增值税发票/电子发票上传(批量)</button>
    </div>`);
  await page.locator('body').evaluate(body => body.addEventListener('click', () => { body.dataset.clicked = 'true'; }));
  await expect(waitForInvoiceEntry(new AutomationContext(page), 500))
    .rejects.toMatchObject({ code: 'ambiguous_choice' });
  await expect(page.locator('body')).not.toHaveAttribute('data-clicked', 'true');
});
