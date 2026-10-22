import type { Frame, Locator } from 'playwright';
import type { AutomationContext } from './browser';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { isEgateShellUrl, egateWorkbenchUrl } from './auth';
import { FlowError } from '../domain/workflow';

// Recorder steps 3–4: accessible name plus frame-local XPath. Do not use the
// recording's generic `input` fallback: it could match a task or login field.
export const RECORDED_SEARCH_XPATH = '//*[@id="home"]/header/div[2]/div[2]/div[1]/div/div[2]/div/div[1]/div[1]/input';
export const WORKFLOW_SEARCH_QUERY = '报销单';

export function workbenchSearchCandidates(frame: ReturnType<AutomationContext['page']['mainFrame']>): Locator {
  const name = /事\s*项\s*名\s*称/;
  return frame.getByPlaceholder(name)
    .or(frame.getByRole('textbox', { name }))
    .or(frame.locator(`xpath=${RECORDED_SEARCH_XPATH}`))
    .filter({ visible: true });
}

type Probe = { frame: Frame; fields: Locator[]; failed?: boolean };
// Keep at most one read-only probe in flight per frame. A frame whose execution
// context is still loading must not block the search in another ready frame.
const pendingProbes = new WeakMap<Frame, Promise<Probe>>();
function probeFrame(frame: Frame): Promise<Probe> {
  const pending = pendingProbes.get(frame);
  if (pending) return pending;
  const promise = (async (): Promise<Probe> => {
    try {
      const candidates = workbenchSearchCandidates(frame);
      const count = await candidates.count();
      const fields: Locator[] = [];
      for (let i = 0; i < count; i++) {
        const field = candidates.nth(i);
        if (await field.isEditable({ timeout: 150 }).catch(() => false)) fields.push(field);
      }
      return { frame, fields };
    } catch { return { frame, fields: [], failed: !frame.isDetached() }; }
  })();
  pendingProbes.set(frame, promise);
  void promise.finally(() => pendingProbes.delete(frame));
  return promise;
}

async function boundedProbe(frame: Frame, timeout: number): Promise<Probe | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probeFrame(frame), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function readySearch(ctx: AutomationContext, timeout: number): Promise<{
  field: Locator | null; pending: number; failed: number; frames: number;
}> {
  if (ctx.page.isClosed()) throw new FlowError('workbench_closed');
  const frames = ctx.page.frames().filter(frame => !frame.isDetached());
  const probes = await Promise.all(frames.map(frame => boundedProbe(frame, timeout)));
  const matches = probes.flatMap(probe => probe ? probe.fields.map(field => ({ frame: probe.frame, field })) : []);
  if (matches.length > 1) throw new FlowError('workbench_search_ambiguous');
  const result = { field: matches[0]?.field || null, pending: probes.filter(p => !p).length,
    failed: probes.filter(p => p?.failed).length, frames: frames.length };
  if (matches.length) ctx.setActiveFrame(matches[0].frame === ctx.page.mainFrame() ? null : matches[0].frame);
  return result;
}

export async function workbenchSearch(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<Locator> {
  const deadline = Date.now() + timeout;
  let last = { pending: 0, failed: 0, frames: 0 };
  while (Date.now() < deadline) {
    const probe = await readySearch(ctx, Math.min(500, Math.max(1, deadline - Date.now())));
    if (probe.field) return probe.field;
    last = probe;
    await ctx.page.waitForTimeout(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  process.send?.({ type: 'stage', stage: 'open workbench', state: 'started',
    evidence: `搜索框探测结束：检查 ${last.frames} 个页面框架，${last.pending} 个未响应，${last.failed} 个读取失败；未找到唯一可编辑的事项搜索框，尚未执行输入。` });
  throw new FlowError(last.failed ? 'workbench_search_error'
    : last.pending ? 'workbench_search_pending' : 'workbench_search_missing');
}

export async function fillWorkflowSearch(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const input = await workbenchSearch(ctx, timeout);
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '已找到事项搜索框，正在点击并输入“报销单”。' });
  try {
    // Use the actual click's normal actionability wait, not a 300 ms trial gate.
    await input.click({ timeout, noWaitAfter: true });
  } catch (cause) {
    process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
      evidence: '搜索框已定位，但实际点击失败；尚未输入，自动操作停止，请检查遮挡或页面跳转。' });
    throw new FlowError('workbench_search_blocked', { cause });
  }
  try {
    await input.fill(WORKFLOW_SEARCH_QUERY, { timeout });
    if (await input.inputValue({ timeout }) !== WORKFLOW_SEARCH_QUERY) throw new Error('readback mismatch');
  } catch (cause) {
    process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
      evidence: '搜索框点击已完成，但输入或回读失败；尚未点击报销创建入口，自动操作停止。' });
    throw new FlowError('workbench_search_input_failed', { cause });
  }
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '已输入“报销单”并回读一致，正在等待“报销单创建（电子签章）”搜索结果。' });
}

export async function openWorkbench(ctx: AutomationContext, options: { requireWorkRoute?: boolean } = {}): Promise<void> {
  ctx.setStage('open workbench');
  const url = ctx.page.url();
  process.send?.({ type: 'stage', stage: 'open workbench', state: 'started',
    evidence: '认证已完成，正在检查当前页面的事项搜索框是否已就绪。' });
  // The logged-in home and work views share the workflow search. Reuse the
  // already actionable control instead of navigating/reloading it again.
  if (isEgateShellUrl(url) && (!options.requireWorkRoute || new URL(url).hash === '#/work')
    && (await readySearch(ctx, 500)).field) {
    process.send?.({ type: 'stage', stage: 'open workbench', state: 'started',
      evidence: '已登录，当前事项搜索框已可编辑；进入实际点击和输入，不再使用短时试点击作为前置门槛。' });
    return;
  }
  if (!isEgateShellUrl(url) || new URL(url).hash !== '#/work') {
    try {
      process.send?.({ type: 'stage', stage: 'open workbench', state: 'started',
        evidence: '当前入口尚未就绪，正在进入工作台；页面开始响应后即检查控件，不等待整体加载。' });
      await ctx.page.goto(getEnvValue('EGATE_WORKBENCH_URL')
        || egateWorkbenchUrl(url),
      { waitUntil: 'commit', timeout: DEFAULT_TIMEOUT_MS });
      ctx.setActiveFrame(null);
    } catch (cause) {
      // A slow image/script must not reject an already usable workbench.
      if (!isEgateShellUrl(ctx.page.url()) || new URL(ctx.page.url()).hash !== '#/work') {
        throw new FlowError('workbench_navigation', { cause });
      }
    }
  }
  await workbenchSearch(ctx);
}
