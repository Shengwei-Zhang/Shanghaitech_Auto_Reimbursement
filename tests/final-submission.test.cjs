const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { assertApprovalRoute, confirmSubmission, readApprovalRoute, approvalRouteIssue } = require('../dist/automation/final-submission');
const route = () => ({ rule: '流程审批规则：/网上预约报销审批', unresolved: false,
  tables: [[['', '环节', '处理人', '*发送消息', '分组号'],
    ['1', '经费负责人', '合成人甲', '是', '10'], ['2', '财务审核', '合成人乙', '否', '60'],
    ['3', '财务审核', '合成人丙', '否', '60']]] });

test('approval validation accepts complete OA routes without fixing employee names', () => {
  assert.doesNotThrow(() => assertApprovalRoute(route()));
  for (const change of [r => r.tables = [], r => r.tables.push(r.tables[0]),
    r => r.rule = '流程审批规则：/其他流程', r => r.unresolved = true,
    r => r.tables[0][1][2] = '', r => r.tables[0][2][2] = '请选择',
    r => r.tables[0][1][3] = '', r => r.tables[0][1][4] = '',
    r => r.tables[0] = [r.tables[0][0]], r => r.tables[0][0][2] = '未知列']) {
    const r = route(); change(r);
    assert.throws(() => assertApprovalRoute(r), { code: 'submission_route_unverified' });
  }
});

function fixture(mode = 'success') {
  let clicks = 0, visible = true;
  const empty = { filter: () => empty, count: async () => 0, all: async () => [] };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, frames: () => [], mainFrame: () => null,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))),
  });
  const button = { or: () => button, filter: () => button, first: () => button, waitFor: async () => {},
    count: async () => mode === 'ambiguous' ? 2 : 1, isEnabled: async () => mode !== 'disabled',
    click: async () => {
      clicks++;
      if (mode === 'click-error') throw Error('timeout after dispatch');
      if (mode === 'native') { page.emit('dialog'); return; }
      if (mode === 'inert') return;
      const req = { resourceType: () => 'xhr' };
      page.emit('request', req);
      if (mode === 'pending') return;
      if (mode === 'failed') page.emit('requestfailed', req);
      else page.emit('requestfinished', req);
      visible = false;
    } };
  const dialog = { locator: () => empty, getByRole: () => button, isVisible: async () => visible,
    evaluate: async () => route() };
  const matches = { filter: () => matches, all: async () => [dialog] };
  page.locator = () => matches;
  const ctx = { page, state: {}, setActiveFrame() {} };
  return { ctx, clicks: () => clicks, dialog };
}

test('final confirm checks form before sending, clicks exactly once and disposes listeners', async () => {
  const f = fixture(); const order = [];
  const check = async () => { assert.equal(f.clicks(), 0); order.push('readback'); };
  const record = async () => { assert.deepEqual(order, ['readback']); order.push('record'); };
  await confirmSubmission(f.ctx, check, record, undefined, 1500);
  assert.equal(f.clicks(), 1);
  assert.equal(f.ctx.page.listenerCount('request'), 0);
  assert.equal(f.ctx.page.listenerCount('dialog'), 0);
  await assert.rejects(confirmSubmission(f.ctx, check, record), { code: 'submission_unknown' });
  assert.equal(f.clicks(), 1);
});

test('form mismatch, invalid route, disabled or ambiguous button and cancellation stop before final click', async () => {
  for (const mode of ['mismatch', 'route', 'disabled', 'ambiguous', 'abort']) {
    const f = fixture(mode); const controller = new AbortController(); let recorded = 0;
    if (mode === 'route') f.dialog.evaluate = async () => ({ ...route(), unresolved: true });
    if (mode === 'abort') controller.abort();
    await assert.rejects(confirmSubmission(f.ctx, async () => {
      if (mode === 'mismatch') throw Error('amount changed');
    }, async () => { recorded++; }, controller.signal, 30));
    assert.equal(f.clicks(), 0);
    assert.equal(recorded, 0);
  }
});

test('final click timeout, transport failure, native prompt and no request never retry or report completion', async () => {
  for (const mode of ['click-error', 'failed', 'native', 'inert', 'pending']) {
    const f = fixture(mode);
    await assert.rejects(confirmSubmission(f.ctx, async () => {}, async () => {}, undefined, 30), { code: 'submission_unknown' });
    await assert.rejects(confirmSubmission(f.ctx, async () => {}, async () => {}, undefined, 30), { code: 'submission_unknown' });
    assert.equal(f.clicks(), 1);
    assert.equal(f.ctx.page.listenerCount('request'), 0);
  }
});


// Run the actual page extraction callback against DOM-shaped table nodes. These
// regressions previously escaped tests that returned an already-parsed route.
function tableDialog(rootIsTable, tabAfterRule = false) {
  const table = { getClientRects: () => [{}], rows: [] };
  const cell = (innerText, rowSpan = 1, colSpan = 1) => ({ innerText, rowSpan, colSpan, getClientRects: () => [{}] });
  const add = cells => table.rows.push({ cells, closest: () => table, getClientRects: () => [{}] });
  add([cell('', 1), cell('环节'), cell('处理人'), cell('*发送消息'), cell('分组号')]);
  add([cell('1'), cell('财务审核', 2), cell('合成甲'), cell('是'), cell('60')]);
  add([cell('2'), cell('合成乙'), cell('否'), cell('60')]);
  const element = rootIsTable ? table : {};
  Object.assign(element, { matches: selector => rootIsTable && selector === 'table',
    querySelectorAll: selector => selector === 'table' && !rootIsTable ? [table] : [],
    innerText: '流转确认\n流程审批规则： /网上预约报销审批' + (tabAfterRule ? '\t环节\t处理人' : '\n环节\t处理人') });
  return { evaluate: async callback => {
    const prior = global.getComputedStyle;
    global.getComputedStyle = () => ({ visibility: 'visible' });
    try { return callback(element); } finally {
      if (prior) global.getComputedStyle = prior; else delete global.getComputedStyle;
    }
  } };
}

test('actual extraction includes a table-shaped dialog root and expands merged handler rows', async () => {
  const parsed = await readApprovalRoute(tableDialog(true));
  assert.equal(parsed.tables.length, 1);
  assert.equal(parsed.tables[0][2][1], '财务审核');
  assert.equal(parsed.tables[0][2][2], '合成乙');
  assert.doesNotThrow(() => assertApprovalRoute(parsed));
});

// The live 流转确认 (2026-10-15) is a ligerGrid: header and body are separate tables in .l-grid2,
// with hidden merged/handlerData columns (the latter also titled 处理人).
function ligerDialog() {
  const cell = (innerText, { rowSpan = 1, hidden = false } = {}) => ({ innerText, rowSpan, colSpan: 1, getClientRects: () => hidden ? [] : [{}] });
  const row = cells => ({ cells, getClientRects: () => [{}] });
  const header = row([cell('环节'), cell('处理人'), cell('发送消息'), cell('已合并', { hidden: true }), cell('分组号'),
    cell('处理人', { hidden: true })]);
  const body = [
    row([cell('审批.经费负责人'), cell('甲组.甲'), cell('是'), cell('0', { hidden: true }), cell('10'), cell('', { hidden: true })]),
    row([cell('审批.财务审核岗', { rowSpan: 2 }), cell('财务处.乙'), cell('否'), cell('0', { hidden: true }), cell('60'), cell('', { hidden: true })]),
    row([cell('财务处.丙'), cell('否'), cell('0', { hidden: true }), cell('60'), cell('', { hidden: true })]),
  ];
  const tables = [{ getClientRects: () => [{}] }, { getClientRects: () => [{}] }];
  const part = { getClientRects: () => [{}], querySelectorAll: selector => selector === 'table.l-grid-header-table tr' ? [header]
    : selector === 'table.l-grid-body-table tr.l-grid-row' ? body : selector === 'table' ? tables : [] };
  const element = { matches: () => false, querySelectorAll: selector => selector === '.l-grid2' ? [part] : selector === 'table' ? tables : [],
    innerText: '流转确认\n流程审批规则：/网上预约报销审批\n环节\t处理人' };
  return { evaluate: async callback => {
    const prior = global.getComputedStyle;
    global.getComputedStyle = () => ({ visibility: 'visible' });
    try { return callback(element); } finally {
      if (prior) global.getComputedStyle = prior; else delete global.getComputedStyle;
    }
  } };
}

test('a ligerGrid route keeps visible columns only and expands the merged finance rows', async () => {
  const parsed = await readApprovalRoute(ligerDialog());
  assert.deepEqual(parsed.tables, [[['环节', '处理人', '发送消息', '分组号'], ['审批.经费负责人', '甲组.甲', '是', '10'],
    ['审批.财务审核岗', '财务处.乙', '否', '60'], ['审批.财务审核岗', '财务处.丙', '否', '60']]]);
  assert.equal(approvalRouteIssue(parsed), null);
});

test('rule extraction stops at tab-separated headers and still rejects a different rule', async () => {
  const parsed = await readApprovalRoute(tableDialog(false, true));
  assert.equal(parsed.rule, '流程审批规则：/网上预约报销审批');
  assert.doesNotThrow(() => assertApprovalRoute(parsed));
  parsed.rule += '其他流程';
  assert.match(approvalRouteIssue(parsed), /审批规则/);
});

test('route diagnostics distinguish rule, table, required controls, header and row failures', () => {
  const values = [
    [{ ...route(), rule: '' }, /规则/], [{ ...route(), tables: [] }, /0 张/],
    [{ ...route(), unresolved: true }, /可编辑选项/],
    [{ ...route(), tables: [[['环节']]] }, /表头/],
  ];
  for (const [value, expected] of values) assert.match(approvalRouteIssue(value), expected);
  const value = route(); value.tables[0][1][2] = '';
  assert.match(approvalRouteIssue(value), /数据行/);
});
