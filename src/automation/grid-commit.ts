import type { Locator } from 'playwright';
import { uniqueVisible } from './controls';
import { FlowError } from '../domain/workflow';

/** Recorder step 51 clicks the Liger body outside the edited row. DOM reads
 * identify a genuinely empty hit target; the commit is a normal mouse click. */
export async function commitGridEditor(grid: Locator, timeout: number): Promise<void> {
  const body = await uniqueVisible(grid.locator('.l-grid2 > .l-grid-body'), timeout);
  await body.scrollIntoViewIfNeeded({ timeout });
  const point = await body.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const left = rect.left + element.clientLeft, top = rect.top + element.clientTop;
    const width = element.clientWidth, height = element.clientHeight;
    for (const y of [height - 20, height - 40, height / 2]) {
      for (const x of [width / 2, 20, width - 25]) {
        if (x < 1 || y < 1) continue;
        const hit = document.elementFromPoint(left + x, top + y);
        if (hit && (hit === element || element.contains(hit))
          && !hit.closest('tr, input, textarea, button, a, [role="button"], .l-grid-row, .l-grid-loading')
          && (hit === element || !(hit.textContent || '').trim())) return { x, y };
      }
    }
    return null;
  });
  if (!point) throw new FlowError('funding_commit_unverified');
  await body.click({ position: point, timeout });
}
