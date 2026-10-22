import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { uniqueVisible } from './controls';
import { FlowError } from '../domain/workflow';

/** Inspect every page before selecting; scrolling never selects unrelated rows. */
export async function chooseBudget(ctx: AutomationContext, keyword: string, timeout: number): Promise<void> {
  const grid = await uniqueVisible(ctx.locator('#chooseBudgetOutlaysGrid'), timeout);
  // Frozen columns repeat rows. Exclude that pane and outer layout/header rows.
  const pane = await grid.locator('.l-grid2').count() ? grid.locator('.l-grid2') : grid;
  await pane.locator('.l-grid-row, tbody > tr').first().waitFor({ state: 'visible', timeout });
  const rows = (await pane.locator('.l-grid-row').count()
    ? pane.locator('.l-grid-row') : pane.locator('tbody > tr:not(:has(table))')).filter({ visible: true });
  const next = grid.locator('.l-bar-btnnext, .l-bar-btnnext-disabled').filter({ visible: true });
  const prev = grid.locator('.l-bar-btnprev, .l-bar-btnprev-disabled').filter({ visible: true });
  const enabled = async (control: Locator) => {
    if (!await control.count()) return false;
    const item = await uniqueVisible(control, timeout);
    return item.evaluate(el => {
      const disabled = '[disabled], [aria-disabled="true"], .l-bar-btnnext-disabled, .l-bar-btnprev-disabled, .l-bar-button-disabled, .l-disabled';
      return !el.closest(disabled) && !el.querySelector(disabled);
    });
  };
  const snapshot = () => rows.evaluateAll(elements => elements.map((el, index) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // Virtual grids can reuse row IDs while scrolling.
    return { key: `${el.id || el.getAttribute('data-row-key') || index}:${text}`, text };
  }));
  const signature = async () => JSON.stringify(await snapshot());
  const bodies = pane.locator('.l-grid-body').filter({ visible: true });
  const scroll = () => bodies.evaluateAll(elements => {
    let moved = false;
    for (const element of elements) {
      const el = element as HTMLElement;
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, before + Math.max(1, el.clientHeight * 0.8));
      moved ||= el.scrollTop > before;
    }
    return moved;
  });
  const resetScroll = async () => {
    await bodies.evaluateAll(elements => elements.forEach(el => { el.scrollTop = 0; }));
    await ctx.page.waitForTimeout(100);
  };
  const move = async (control: Locator) => {
    if (!await enabled(control)) throw new FlowError('control_missing');
    await resetScroll();
    const before = await signature();
    const button = await uniqueVisible(control, timeout);
    const icon = button.locator('span').filter({ visible: true });
    await (await icon.count() === 1 ? icon : button).click({ timeout });
    const deadline = Date.now() + timeout;
    let last = '', stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await signature();
      if (current !== last) { last = current; stableSince = Date.now(); }
      const loading = await grid.locator('.l-grid-loading').filter({ visible: true }).count();
      if (!loading && await rows.count() && current !== before && Date.now() - stableSince >= 150) return;
      await ctx.page.waitForTimeout(50);
    }
    throw new FlowError('control_missing');
  };
  const scan = async (target?: string): Promise<Set<string> | Locator> => {
    await resetScroll();
    const matches = new Set<string>();
    for (let step = 0; step < 500; step++) {
      const entries = await snapshot();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (target && entry.key === target) {
          // A positional locator can point at a different row after virtual scrolling.
          const exactText = entry.text.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
          return uniqueVisible(rows.filter({ hasText: new RegExp(`^\\s*${exactText}\\s*$`) }), timeout);
        }
        if (entry.text && (!keyword || entry.text.includes(keyword))) matches.add(entry.key);
      }
      if (matches.size > 1 && !target) throw new FlowError('ambiguous_choice');
      if (!await scroll()) return matches;
      await ctx.page.waitForTimeout(100);
    }
    throw new FlowError('control_missing');
  };
  for (let p = 0; await enabled(prev); p++) {
    if (p >= 50) throw new FlowError('control_missing');
    await move(prev);
  }
  let selectedPage = -1, selectedKey = '', currentPage = 0;
  const signatures = new Set<string>();
  while (true) {
    await resetScroll();
    const current = await signature();
    if (signatures.has(current)) throw new FlowError('control_missing');
    signatures.add(current);
    const matches = await scan() as Set<string>;
    if (matches.size && selectedPage !== -1) throw new FlowError('ambiguous_choice');
    if (matches.size) { selectedPage = currentPage; selectedKey = [...matches][0]; }
    if (!await enabled(next)) break;
    if (++currentPage >= 50) throw new FlowError('control_missing');
    await move(next);
  }
  if (selectedPage < 0) throw new FlowError('control_missing');
  while (currentPage > selectedPage) { await move(prev); currentPage--; }
  const selected = await scan(selectedKey);
  if (selected instanceof Set) throw new FlowError('control_missing');
  await selected.scrollIntoViewIfNeeded({ timeout });
  let selectionRow = selected;
  const rowId = (await selected.getAttribute('id'))?.match(/^(.*)\|[12]\|(r[^|]+)$/);
  if (rowId && !await selected.locator('input[type="checkbox"], .l-grid-row-cell-btn-checkbox').count()) {
    // Liger may keep the checkbox in the frozen pane (|1|), and the subject in |2|.
    const frozen = grid.locator(`[id=${JSON.stringify(`${rowId[1]}|1|${rowId[2]}`)}]`).filter({ visible: true });
    if (await frozen.count() === 1) selectionRow = frozen;
  }
  const checkbox = selectionRow.locator('input[type="checkbox"]').filter({ visible: true });
  if (await checkbox.count() === 1) await checkbox.check({ timeout });
  else {
    const ligerCheckbox = selectionRow.locator('.l-grid-row-cell-btn-checkbox').filter({ visible: true });
    if (await ligerCheckbox.count() === 1) await ligerCheckbox.click({ timeout });
    else {
      const cell = selected.locator('td').filter({ hasText: keyword }).first();
      await (await cell.count() ? cell : selected).click({ timeout });
    }
  }
}
