import type { Locator } from 'playwright';
import { uniqueVisible } from './controls';
import { FlowError } from '../domain/workflow';

export const INVOICE_CHECKBOX = 'input[type="checkbox"], .vxe-cell--checkbox, [role="checkbox"]';
export const INVOICE_CHECKED = 'input[type="checkbox"]:checked, .vxe-cell--checkbox.is--checked, [role="checkbox"][aria-checked="true"], td.col--checkbox.is--checked, .vxe-checkbox--checked-icon, .vxe-icon-checkbox-checked';

/** Read rendered checkbox semantics only; row hover/current highlight is not selection. */
export async function invoiceSelectionState(row: Locator): Promise<{ checked: boolean; disabled: boolean; mixed: boolean }> {
  return row.evaluate((el, checkedSelector) => {
    const controls = Array.from(el.querySelectorAll('input[type="checkbox"], .vxe-cell--checkbox, [role="checkbox"]'));
    const disabled = controls.some(control => control.matches(':disabled, [disabled], [aria-disabled="true"], .is--disabled')
      || Boolean(control.closest('td.col--checkbox.is--disabled')));
    const mixed = controls.some(control => control.getAttribute('aria-checked') === 'mixed'
      || control.classList.contains('is--indeterminate')
      || (control instanceof HTMLInputElement && control.indeterminate));
    // VXE versions place checked state on the cell, the row or the icon.
    const checked = el.classList.contains('row--checked') || Array.from(el.querySelectorAll(checkedSelector)).some(marker => {
      // Some versions keep both icon templates in the DOM and hide one by CSS.
      if (marker.matches('.vxe-checkbox--checked-icon, .vxe-icon-checkbox-checked')) {
        return marker.getClientRects().length > 0 && getComputedStyle(marker).visibility !== 'hidden';
      }
      return true;
    });
    return { checked: checked && !mixed, disabled, mixed };
  }, INVOICE_CHECKED);
}

export async function selectInvoice(row: Locator, timeout: number): Promise<void> {
  const state = await invoiceSelectionState(row);
  if (state.mixed) throw new FlowError('invoice_selection_unconfirmed');
  if (state.checked) return;
  if (state.disabled) throw new FlowError('invoice_selection_disabled');
  const native = row.locator('input[type="checkbox"]').filter({ visible: true });
  if (await native.count() === 1) await native.check({ timeout });
  else {
    const checkbox = await uniqueVisible(row.locator('.vxe-cell--checkbox, [role="checkbox"]'), timeout);
    await checkbox.click({ timeout });
  }
  process.send?.({ type: 'stage', stage: 'attach invoice', state: 'started',
    evidence: '目标发票勾选操作已返回，正在核对该行的复选框、单元格及行选中状态；不会重复点击。' });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const observed = await invoiceSelectionState(row);
    if (observed.checked) return;
    if (observed.disabled) throw new FlowError('invoice_selection_disabled');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new FlowError('invoice_selection_unconfirmed');
}
