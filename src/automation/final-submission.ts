import type { Locator } from 'playwright';
import type { AutomationContext } from './browser';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { uniqueVisible } from './controls';
import { FlowError } from '../domain/workflow';
import { watchRequestActivity } from './request-activity';
import { findSubmissionDialog } from './submission';

export interface ApprovalRoute {
  rule: string;
  tables: string[][][];
  unresolved: boolean;
}

/** Validate the OA-generated route; never choose or replace approvers. */
export function approvalRouteIssue(route: ApprovalRoute): string | null {
  const clean = (value: string) => value.replace(/[\s*＊]/g, '');
  if (!/^流程审批规则[:：]\/网上预约报销审批$/.test(route.rule.replace(/\s/g, ''))) return '未读取到预期的流程审批规则';
  if (route.unresolved) return '审批窗口存在未校准的可编辑选项或校验提示';
  if (route.tables.length !== 1) return `识别到 ${route.tables.length} 张审批路线表，要求唯一`;
  const [headers, ...rows] = route.tables[0];
  const names = ['环节', '处理人', '发送消息', '分组号'];
  const columns = names.map(name => headers?.findIndex(header => clean(header) === name) ?? -1);
  if (!rows.length || columns.some(index => index < 0)
    || names.some(name => headers.filter(header => clean(header) === name).length !== 1)) {
    return '审批路线表头缺失、重复，或处理人数据行尚未出现';
  }
  for (const row of rows) {
    const [step, person, message, group] = columns.map(index => clean(row[index] || ''));
    if (!step || !person || /请选择|待选择|未选择|未指定|待指定/.test(step + person)
      || !['是', '否'].includes(message) || !/^\d+$/.test(group)) return '审批数据行中的环节、处理人、发送消息或分组号未完整读取';
  }
  return null;
}

export function assertApprovalRoute(route: ApprovalRoute): void {
  if (approvalRouteIssue(route)) throw new FlowError('submission_route_unverified');
}

export async function readApprovalRoute(dialog: Locator): Promise<ApprovalRoute> {
  return dialog.evaluate(element => {
    const visible = (el: Element) => !!(el as HTMLElement).getClientRects().length
      && getComputedStyle(el).visibility !== 'hidden';
    const clean = (text: string) => text.replace(/[\s*＊]/g, '');
    const tables: string[][][] = [];
    const names = ['环节', '处理人', '发送消息', '分组号'];
    const isHeader = (row: HTMLTableRowElement) =>
      names.every(name => Array.from(row.cells).some(cell => visible(cell) && clean(cell.innerText) === name));
    // Hidden (display:none) columns are left out of headers and rows alike.
    // The finance approval step spans several handler rows in the real OA.
    const toGrid = (sourceRows: HTMLTableRowElement[]) => {
      const grid: string[][] = [];
      for (const [r, row] of sourceRows.entries()) {
        grid[r] ||= [];
        let col = 0;
        for (const cell of Array.from(row.cells).filter(visible)) {
          while (grid[r][col] !== undefined) col++;
          const value = cell.innerText.trim();
          const span = cell.rowSpan || sourceRows.length - r;
          for (let y = r; y < r + span; y++) {
            grid[y] ||= [];
            for (let x = col; x < col + cell.colSpan; x++) grid[y][x] = value;
          }
          col += cell.colSpan;
        }
      }
      return grid;
    };
    const ligerTables = new Set<Element>();
    // ligerGrid (live 2026-10-15): header and body are separate tables inside one .l-grid2.
    for (const part of Array.from(element.querySelectorAll('.l-grid2')).filter(visible)) {
      const header = Array.from(part.querySelectorAll<HTMLTableRowElement>('table.l-grid-header-table tr')).filter(isHeader);
      const body = Array.from(part.querySelectorAll<HTMLTableRowElement>('table.l-grid-body-table tr.l-grid-row')).filter(visible);
      part.querySelectorAll('table').forEach(table => ligerTables.add(table));
      if (header.length === 1) tables.push(toGrid([header[0], ...body]));
    }
    // querySelectorAll excludes the root. OA's .ui_dialog can itself be a table.
    const candidates = [...(element.matches('table') ? [element as HTMLTableElement] : []),
      ...Array.from(element.querySelectorAll('table'))];
    for (const table of candidates) {
      if (!visible(table) || ligerTables.has(table)) continue;
      const sourceRows = Array.from(table.rows).filter(row => row.closest('table') === table && visible(row));
      const start = sourceRows.findIndex(isHeader);
      if (start < 0) continue;
      tables.push(toGrid(sourceRows.slice(start)));
    }
    const unresolved = Array.from(element.querySelectorAll('input, select, textarea, [aria-invalid="true"], [role="alert"]'))
      .filter(visible).some(el => {
        if (el.getAttribute('aria-invalid') === 'true' || el.getAttribute('role') === 'alert') return true;
        const control = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (control.disabled) return false;
        if (!control.validity.valid) return true;
        // Unknown editable route choices need calibration instead of a guess.
        return control instanceof HTMLSelectElement
          || (control instanceof HTMLTextAreaElement && !control.readOnly)
          || (control instanceof HTMLInputElement && !control.readOnly
            && !['hidden', 'button', 'submit'].includes(control.type));
      });
    const text = (element as HTMLElement).innerText;
    // Table innerText separates adjacent cells with tabs, not necessarily a newline.
    // Do not append the first header to the rule and then remove that separator.
    const rule = text.match(/流程审批规则\s*[:：]\s*\/?[^\r\n\t]+/)?.[0].replace(/\s+/g, '') || '';
    return { rule, tables, unresolved };
  });
}

/** The unrecognised dialog, kept beside the job for calibrating the route reader. */
async function saveRouteDialog(dialog: Locator, route: ApprovalRoute): Promise<void> {
  const dir = getEnvValue('OA_ARTIFACT_DIR');
  if (!dir) return;
  const html = await dialog.evaluate(element => element.outerHTML).catch(() => '');
  fs.writeFileSync(path.join(dir, 'route-dialog.html'), `<!-- ${JSON.stringify(route).replace(/--/g, '- -')} -->\n${html}`, { mode: 0o600 });
}

/** Final confirmation is irreversible: mark before dispatch and never retry it.
 * Returning only means transport settled and the dialog closed, not success. */
export async function confirmSubmission(ctx: AutomationContext, revalidate: () => Promise<void>,
  onValidated: () => Promise<void>, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (ctx.state.submissionFinalAttempted) throw new FlowError('submission_unknown');
  const dialog = await findSubmissionDialog(ctx);
  if (!dialog) throw new FlowError('submission_route_unverified');
  const deadline = Date.now() + timeout;
  let lastIssue: string | null = null;
  while (true) {
    signal?.throwIfAborted();
    const route = await readApprovalRoute(dialog);
    const issue = approvalRouteIssue(route);
    if (!issue) break;
    if (issue !== lastIssue) process.send?.({ type: 'stage', stage: 'confirm submission', state: 'started',
      evidence: `最终确定前核验：${issue}；尚未点击。` });
    lastIssue = issue;
    if (Date.now() >= deadline) {
      await saveRouteDialog(dialog, route);
      throw new FlowError('submission_route_unverified');
    }
    await ctx.page.waitForTimeout(100);
  }
  process.send?.({ type: 'stage', stage: 'confirm submission', state: 'started', evidence: '审批规则及路线已核验，正在回读同一张报销单。' });
  await revalidate();
  assertApprovalRoute(await readApprovalRoute(dialog));
  // #ok + exact text is also recorded in the user's final confirmation step.
  const confirm = await uniqueVisible(dialog.getByRole('button', { name: '确定', exact: true })
    .or(dialog.locator('#ok').filter({ hasText: /^\s*确定\s*$/ })), timeout);
  if (!await confirm.isEnabled()) throw new FlowError('submission_route_unverified');
  signal?.throwIfAborted();
  await onValidated();
  signal?.throwIfAborted();
  const activity = watchRequestActivity(ctx.page);
  let nativeDialog = false;
  const stop = () => { nativeDialog = true; };
  ctx.page.on('dialog', stop);
  try {
    ctx.state.submissionFinalAttempted = true;
    process.send?.({ type: 'stage', stage: 'confirm submission', state: 'started', evidence: '表单和审批路线已通过核验，开始单次点击最终“确定”。' });
    await confirm.click({ timeout, noWaitAfter: true });
    process.send?.({ type: 'stage', stage: 'confirm submission', state: 'started',
      evidence: '已单次点击流转确认“确定”，正在等待 OA 请求结束；尚未核验提交成功。' });
    const settledDeadline = Date.now() + timeout;
    while (Date.now() < settledDeadline) {
      signal?.throwIfAborted();
      const state = activity.snapshot();
      if (state.failed || nativeDialog || ctx.page.isClosed()) throw new FlowError('submission_unknown');
      if (state.started > 0 && !state.pending && state.quietMs >= 750 && !await dialog.isVisible()) return;
      await ctx.page.waitForTimeout(100);
    }
    throw new FlowError('submission_unknown');
  } catch (cause) { throw new FlowError('submission_unknown', { cause }); }
  finally { activity.dispose(); ctx.page.off('dialog', stop); }
}
