import type { Locator, Frame } from 'playwright';
import { DEFAULT_TIMEOUT_MS } from './config';
import type { AutomationContext } from './browser';
import { FlowError } from '../domain/workflow';

// egate highlights the query in a child span and theme variants insert spaces
// before the parenthesis. Keep the full business name anchored: never match
// 审核/查询, a containing menu, or another workflow with a similar prefix.
export const WORKFLOW_NAME = /^\s*报\s*销\s*单\s*创\s*建\s*[（(]\s*电\s*子\s*签\s*章\s*[）)]\s*$/;

type Result = { frame: Frame; target: Locator };
type Probe = { matches: Result[]; failed?: boolean };
const pending = new WeakMap<Frame, Promise<Probe>>();
function probeFrame(frame: Frame): Promise<Probe> {
  const running = pending.get(frame);
  if (running) return running;
  const result = (async (): Promise<Probe> => {
    try {
      const targets = frame.getByText(WORKFLOW_NAME).filter({ visible: true });
      return { matches: (await targets.all()).map(target => ({ frame, target })) };
    } catch { return { matches: [], failed: !frame.isDetached() }; }
  })();
  pending.set(frame, result);
  void result.finally(() => pending.delete(frame));
  return result;
}

async function boundedProbe(frame: Frame, timeout: number): Promise<Probe | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probeFrame(frame), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function findResult(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<{ frame: Frame; target: Locator }> {
  const deadline = Date.now() + timeout;
  let unresponsive = 0, failed = 0;
  while (Date.now() < deadline) {
    if (ctx.page.isClosed()) throw new FlowError('workbench_closed');
    const frames = ctx.page.frames().filter(frame => !frame.isDetached());
    const probes = await Promise.all(frames.map(frame => boundedProbe(frame,
      Math.max(1, Math.min(500, deadline - Date.now())))));
    const matches = probes.flatMap(probe => probe?.matches || []);
    unresponsive = probes.filter(probe => !probe).length;
    failed = probes.filter(probe => probe?.failed).length;
    if (matches.length > 1) throw new FlowError('ambiguous_choice');
    if (matches.length === 1) return matches[0];
    await ctx.page.waitForTimeout(Math.min(150, Math.max(0, deadline - Date.now())));
  }
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: `已输入搜索词，但未找到唯一可见的“报销单创建（电子签章）”：${unresponsive} 个框架未响应，${failed} 个读取失败；尚未点击入口。` });
  throw new FlowError('control_missing');
}

export async function waitForWorkflowSearchResults(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  await findResult(ctx, timeout);
}

export async function clickWorkflowSearchResult(ctx: AutomationContext, _label: string,
  timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const { frame, target } = await findResult(ctx, timeout);
  ctx.setActiveFrame(frame === ctx.page.mainFrame() ? null : frame);
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '已唯一匹配“报销单创建（电子签章）”，正在点击该入口。' });
  ctx.state.entryAttempted = true;
  try { await target.click({ timeout, noWaitAfter: true }); }
  catch (cause) { throw new FlowError('entry_result_unknown', { cause }); }
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '创建入口点击已返回，正在等待 BPM 页面；不会重复点击或另开备用入口。' });
}
