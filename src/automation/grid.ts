import type { Locator } from 'playwright';
import { FlowError } from '../domain/workflow';
import { uniqueVisible, readValue } from './controls';

/** Liger renders its frozen checkbox pane as a second set of rows. It must
 * not count as a second business record or supply the named data columns. */
export function gridDataRows(grid: Locator): Locator {
  return grid.locator('.l-grid-row:not(.l-grid1 .l-grid-row)').filter({ visible: true });
}

/** Liger columns have stable columnname metadata while their generated IDs change per page. */
export async function columnSuffix(grid: Locator, name: string): Promise<string> {
  const labels: Record<string, RegExp> = {
    amount: /^\s*\*?\s*报销金额\s*[/／]\s*元\s*$/,
    attachmentNumber: /^\s*\*?\s*附件张数\s*$/,
    remark: /^\s*\*?\s*用途\s*$/,
  };
  const named = grid.locator(`.l-grid-hd-cell[columnname="${name}"]:not(.l-grid1 .l-grid-hd-cell)`).filter({ visible: true });
  const candidates = await named.count() || !labels[name] ? named
    : grid.locator('.l-grid-hd-cell:not(.l-grid1 .l-grid-hd-cell)').filter({ hasText: labels[name] });
  const header = await uniqueVisible(candidates);
  const id = await header.getAttribute('id');
  const suffix = id?.split('|').pop();
  if (!suffix || !/^[\w-]+$/.test(suffix)) throw new FlowError('control_missing');
  return suffix;
}

export async function gridRows(grid: Locator, columns: string[]): Promise<Array<Record<string, string>>> {
  const suffixes = await Promise.all(columns.map(name => columnSuffix(grid, name)));
  const rows = await gridDataRows(grid).all();
  const results = [];
  for (const row of rows) {
    const result: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      const cell = await uniqueVisible(row.locator(`td[id$="|${suffixes[i]}"]`));
      const inputs = cell.locator('input:not([type="checkbox"]):not([type="hidden"]), textarea, select').filter({ visible: true });
      result[columns[i]] = await inputs.count() ? await readValue(await uniqueVisible(inputs))
        : (await cell.innerText()).replace(/\s+/g, ' ').trim();
    }
    results.push(result);
  }
  return results;
}

export async function singleGridCell(grid: Locator, column: string): Promise<Locator> {
  const suffix = await columnSuffix(grid, column);
  return uniqueVisible(gridDataRows(grid).locator(`td[id$="|${suffix}"]`));
}
