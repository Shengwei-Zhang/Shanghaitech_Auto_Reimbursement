import type { Locator } from 'playwright';
import { FlowError } from '../domain/workflow';
import { DEFAULT_TIMEOUT_MS } from './config';

export async function uniqueVisible(locator: Locator, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const visible = locator.filter({ visible: true });
  await visible.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new FlowError('control_missing'); });
  if (await visible.count() !== 1) throw new FlowError('ambiguous_choice');
  return visible;
}

export async function readValue(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement ? element.value : element.textContent;
    return String(value || '').replace(/\s+/g, ' ').trim();
  });
}

export async function fillAndVerify(locator: Locator, value: string): Promise<void> {
  const field = await uniqueVisible(locator);
  await field.fill(value);
  await field.press('Tab');
  if (await field.inputValue() !== value) throw new FlowError('value_mismatch');
}
