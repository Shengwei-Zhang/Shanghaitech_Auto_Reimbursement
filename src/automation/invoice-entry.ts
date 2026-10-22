import type { Frame, Locator } from 'playwright';
import type { AutomationContext, RootTarget } from './browser';
import { DEFAULT_TIMEOUT_MS } from './config';
import { FlowError } from '../domain/workflow';

export const INVOICE_ENTRY_CONTAINERS = '#rbReimbursementInvoiceButtons, .rbReimbursementInvoiceButtons';

const SINGLE_NAME = /^[\s\uE000-\uF8FF]*增值税发票\s*\/\s*电子发票上传\s*$/;
const BATCH_NAME = /^[\s\uE000-\uF8FF]*增值税发票\s*\/\s*电子发票上传\s*[（(]\s*批量\s*[）)]\s*$/;

export function invoiceEntryButtons(root: RootTarget, kind: 'single' | 'batch'): Locator {
  return root.locator(INVOICE_ENTRY_CONTAINERS)
    .getByRole('button', { name: kind === 'batch' ? BATCH_NAME : SINGLE_NAME }).filter({ visible: true });
}

/** Resolve the observed invoice entry without clicking. New forms have two
 * class-based rows: the batch entry opens the VXE picker, while the plain
 * entry opens the legacy dialog. Older forms expose just the plain entry. */
export async function waitForInvoiceEntry(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const deadline = Date.now() + timeout;
  do {
    const batches: Array<{ frame: Frame; locator: Locator }> = [];
    const singles: Array<{ frame: Frame; locator: Locator }> = [];
    for (const frame of ctx.page.frames()) {
      for (const [kind, matches] of [['batch', batches], ['single', singles]] as const) {
        const candidates = invoiceEntryButtons(frame, kind);
        for (const locator of await candidates.all()) matches.push({ frame, locator });
      }
    }
    if (batches.length > 1 || singles.length > 1
      || (batches.length === 1 && singles.length === 1 && batches[0].frame !== singles[0].frame)) {
      throw new FlowError('ambiguous_choice');
    }
    const match = batches[0] || singles[0];
    if (match && await match.locator.isEnabled()) {
      ctx.setActiveFrame(match.frame === ctx.page.mainFrame() ? null : match.frame);
      return match.locator;
    }
    await ctx.page.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new FlowError('control_missing');
}
