const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  buildOwnerListPayload, parseOwnerList, parseApplyTask, resolveListTarget,
  OWNER_QUERY_PATH, OWNER_LIST_PATH, APPLY_TASK_PATH,
} = require('../dist/automation/reimbursement-list');
const { BPM_ORIGIN } = require('../dist/automation/form-request');

// Shapes from the 2026-10-15 live responses; all identifiers are synthetic.
const ownerUrl = BPM_ORIGIN + OWNER_QUERY_PATH;
const bizA = 'A'.repeat(32), bizB = 'B'.repeat(32);
const taskA = '11111111-2222-3333-4444-555555555555';
const token = 'synthetic-browser-token';
const row = (id, billCode, status = 0, statusTextView = '预制') => ({ id, billCode, status, statusTextView,
  queryStatus: status, reimbursementKind: 'applyMoney', accountBook: 'ST00', reimbursementAmount: '', remark: '合成',
  fillinDate: '2026-10-14 10:00:00', mobilePhone: '00000000000' });
const ownerEnvelope = rows => ({ status: 0, data: { Total: rows.length, Rows: rows } });
const applyTask = (overrides = {}) => ({ status: 0, data: { id: taskA, businessKey: bizA, businessCode: 'A209900000016',
  statusId: 'ready', taskDefKey: 'Apply', name: '网上预约报销申请单', executorPersonId: '000000', ...overrides } });

test('owner-list payload reproduces the grid query body with a bill-code filter', () => {
  assert.deepEqual(buildOwnerListPayload({ billCode: 'A209900000016' }), { billCode: 'A209900000016', startYearMonth: '',
    endYearMonth: '', reimbursementKind: '', reimbursementKind_text: '', remark: '', supplier: '', invoiceCode: '',
    reimburSettleKindId: '', reimburSettleKindId_text: '', queryStatusKind: '', page: '1', pagesize: '20',
    sortname: 'fillinDate', sortorder: 'desc', sortfields: '[]' });
  for (const value of [{ billCode: 'B1' }, { billCode: 'A1&x=1' }, { page: 0 }, { pagesize: 101 }, { sortname: 'x' }, null]) {
    assert.throws(() => buildOwnerListPayload(value), { code: 'invalid_query' });
  }
});

test('owner list rows expose id as bizId and skip malformed rows; other envelopes are rejected', () => {
  const list = parseOwnerList(ownerEnvelope([row(bizA, 'A209900000016'), row('short', 'A209900000017'), row(bizB, '')]));
  assert.equal(list.total, 3);
  assert.equal(list.skipped, 2);
  assert.deepEqual({ ...list.rows[0] }, { bizId: bizA, billCode: 'A209900000016', status: '0', statusText: '预制',
    reimbursementKind: 'applyMoney', kindText: '', accountBook: 'ST00', reimbursementAmount: '', remark: '合成', fillinDate: '2026-10-14 10:00:00',
    blank: false });
  const { ANY_BILL_CODE } = require('../dist/automation/reimbursement-list.js');
  const any = parseOwnerList(ownerEnvelope([row(bizA, 'A209900000016'), row(bizB, 'D209900000036')]), ANY_BILL_CODE);
  assert.deepEqual(any.rows.map(item => item.billCode), ['A209900000016', 'D209900000036'], 'printing reads every bill type');
  assert.deepEqual(parseOwnerList(ownerEnvelope([row(bizB, 'D209900000036')])).rows.map(item => item.billCode), ['D209900000036'],
    'filling covers 用款申请单 (A) and 境内差旅单 (D)');
  assert.deepEqual(parseOwnerList(ownerEnvelope([row(bizB, 'B202609040014')])).rows, [], 'other bill types are not filled');
  for (const value of [{ status: 1, data: { Rows: [] } }, { data: { Rows: [] } }, { status: 0, data: {} }, [], null]) {
    assert.equal(parseOwnerList(value), undefined);
  }
});

test('apply task yields taskId, bizId and bill code only for a well-formed success envelope', () => {
  assert.deepEqual({ ...parseApplyTask(applyTask()) }, { taskId: taskA, bizId: bizA, documentNumber: 'A209900000016',
    statusId: 'ready', taskDefKey: 'Apply', name: '网上预约报销申请单' });
  for (const value of [applyTask({ id: 'x' }), applyTask({ businessKey: '' }), { status: 1, data: applyTask().data },
    { status: 0, data: null }, null]) {
    assert.equal(parseApplyTask(value), undefined);
  }
});

function sessionFixture(responses, options = {}) {
  const calls = [];
  let url = 'about:blank', closed = false;
  const page = {
    url: () => url, isClosed: () => closed, on: () => {}, frames: () => [page], mainFrame: () => page,
    getByText: () => ({ filter: () => ({ count: async () => 0 }) }),
    locator: () => ({ count: async () => options.noForm ? 0 : 1 }),
    goto: async destination => {
      calls.push(['goto', destination]);
      url = options.landing ?? (destination.startsWith('https://ids.') ? ownerUrl : destination);
      return { status: () => 200 };
    },
    close: async () => { closed = true; calls.push(['close']); },
    evaluate: async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
      args, location: { origin: BPM_ORIGIN, href: url }, window: { csrfToken: token },
      document: { querySelectorAll: () => [], getElementById: () => null },
      URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
      fetch: async (endpoint, request) => {
        calls.push(['fetch', new URL(endpoint).pathname, Object.fromEntries(new URLSearchParams(request.body)), request.headers]);
        const body = responses[new URL(endpoint).pathname];
        return { status: 200, ok: true, type: 'basic', url: endpoint,
          headers: { get: name => name === 'content-type' ? 'application/json;charset=UTF-8' : null },
          text: async () => JSON.stringify(body) };
      },
    }),
  };
  const portal = { synthetic: 'portal' };
  const session = { page: portal, context: { newPage: async () => { calls.push(['newPage']); return page; } } };
  return { session, page, portal, calls };
}

test('bill code resolves through the owner list and the apply task to an openable target', async () => {
  const f = sessionFixture({ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016'), row(bizB, 'A209900000021')]),
    [APPLY_TASK_PATH]: applyTask() });
  const found = await resolveListTarget(f.session, 'A209900000016');
  assert.deepEqual(found.target, { bizId: bizA, taskId: taskA, isReadOnly: false, expectedDocumentNumber: 'A209900000016' });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['newPage'], ['goto', ownerUrl],
    ['fetch', OWNER_LIST_PATH], ['fetch', APPLY_TASK_PATH], ['close']]);
  assert.equal(f.calls[2][2].billCode, 'A209900000016');
  assert.deepEqual(f.calls[3][2], { bizId: bizA, checkSubProcUnitId: 'financialContactPerson' });
  assert.equal(f.calls[3][3].csrfToken, token);
  assert.equal(f.session.page, f.portal);
});

test('missing, duplicated, mismatched, finished and other-person tasks never become targets', async () => {
  const cases = [
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizB, 'A209900000021')]) }, 'document_missing'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016'), row(bizB, 'A209900000016')]) }, 'document_ambiguous'],
    [{ [OWNER_LIST_PATH]: { status: 1, msg: 'x' } }, 'response_invalid'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016')]), [APPLY_TASK_PATH]: { status: 0, data: null } }, 'task_missing'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016')]), [APPLY_TASK_PATH]: applyTask({ businessKey: bizB }) }, 'task_mismatch'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016')]), [APPLY_TASK_PATH]: applyTask({ businessCode: 'A209900000021' }) }, 'task_mismatch'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016')]), [APPLY_TASK_PATH]: applyTask({ statusId: 'completed' }) }, 'task_missing'],
    [{ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016', 1, '提交')]),
      [APPLY_TASK_PATH]: applyTask({ taskDefKey: 'Approve', name: '审批网上预约报销单' }) }, 'not_editable'],
  ];
  for (const [responses, code] of cases) {
    const f = sessionFixture(responses);
    await assert.rejects(resolveListTarget(f.session, 'A209900000016'), { code }, code);
    assert.equal(f.calls.at(-1)[0], 'close');
  }
  const readOnly = sessionFixture({ [OWNER_LIST_PATH]: ownerEnvelope([row(bizA, 'A209900000016', 1, '提交')]),
    [APPLY_TASK_PATH]: applyTask({ taskDefKey: 'Approve' }) });
  assert.equal((await resolveListTarget(readOnly.session, 'A209900000016', true)).target.isReadOnly, true);
});

test('owner page must be the real BPM query page; login pages and bad input stop before any request', async () => {
  const login = sessionFixture({}, { landing: 'https://ids.shanghaitech.edu.cn/authserver/login' });
  await assert.rejects(resolveListTarget(login.session, 'A209900000016'), { code: 'authentication' });
  assert.equal(login.calls.filter(call => call[0] === 'fetch').length, 0);
  assert.equal(login.calls.filter(call => call[0] === 'goto').length, 2);
  const noForm = sessionFixture({}, { noForm: true });
  await assert.rejects(resolveListTarget(noForm.session, 'A209900000016'), { code: 'bpm_unavailable' });
  const invalid = sessionFixture({});
  await assert.rejects(resolveListTarget(invalid.session, 'B202607240022'), { code: 'invalid_query' });
  assert.equal(invalid.calls.length, 0);
});
