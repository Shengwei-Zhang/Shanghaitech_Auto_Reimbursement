const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moneyToCents, parseInput } = require('../dist/domain/job');
const { pickInvoiceNumberFromText } = require('../dist/automation/invoice-pdf');
const { DeepSeekAdvisor } = require('../dist/infrastructure/deepseek');
const input = { purpose: '科研材料', reason: '采购实验耗材用于样本制备', payeeCode: 'TEST01', fundingKeyword: '项目A', budgetKeyword: '材料费', amount: '0.10', attachmentCount: 1 };

test('recorded flow defaults to new creation and validates category and explicit reuse', () => {
  assert.equal(parseInput(input).formMode, 'new');
  assert.equal(parseInput(input).fundingKindKeyword, '被授权的项目');
  assert.throws(() => parseInput({ ...input, fundingKindKeyword: '其他项目' }), /只能选择/);
  assert.equal(parseInput({ ...input, formMode: 'reuse', fundingKindKeyword: ' 我负责的项目 ' }).fundingKindKeyword, '我负责的项目');
  assert.equal(parseInput({ ...input, formMode: 'reuse' }).formMode, 'reuse');
  assert.throws(() => parseInput({ ...input, formMode: 'unknown' }));
  assert.throws(() => parseInput({ ...input, fundingKindKeyword: 'a\n' }));
});

test('money validation uses integer cents and rejects rounding/exponent/negative values', () => {
  assert.equal(moneyToCents('0.10') + moneyToCents('0.20'), moneyToCents('0.30'));
  assert.equal(parseInput({ ...input, amount: '12.3' }).amount, '12.30');
  for (const value of ['0', '-1', '1e3', 'NaN', '1.001', '01.50', '1000000000']) assert.throws(() => moneyToCents(value));
  assert.throws(() => parseInput({ ...input, attachmentCount: 1.5 }));
  assert.throws(() => parseInput({ ...input, fundingKeyword: '' }));
});
test('invoice identity must come from content; ambiguous unlabeled numbers fail closed', () => {
  const a = '26117000000774404378', b = '26117000000774404386';
  assert.equal(pickInvoiceNumberFromText('', a), null);
  assert.equal(pickInvoiceNumberFromText(`${a} ${b}`, a), null);
  assert.equal(pickInvoiceNumberFromText(`${a} ${a}`, null), a);
  assert.equal(pickInvoiceNumberFromText(`发票号码：${a} 购方编号 ${b}`, null), a);
  assert.equal(pickInvoiceNumberFromText(`发票号码：${a} 发票号码：${b}`, null), null);
});

test('mutating automation stages are never replayed after a partial failure', async () => {
  const { runStep, setStartFromStep } = require('../dist/automation/runner');
  setStartFromStep('');
  let calls = 0;
  await assert.rejects(runStep('attach invoice', async () => { calls++; throw new Error('Upload already sent, result unknown'); }));
  assert.equal(calls, 1);
  assert.throws(() => setStartFromStep('misspelled stage'), /Unknown START_FROM/);
});

test('pre-save guard refuses the wrong invoice or mismatched settlement amount', async () => {
  const { assertExpectedInvoice } = require('../dist/automation/guards');
  const beforeAmount = process.env.EXPECTED_AMOUNT, beforeNumber = process.env.EXPECTED_INVOICE_NUMBER;
  process.env.EXPECTED_AMOUNT = '120.10'; process.env.EXPECTED_INVOICE_NUMBER = '26117000000000000001';
  const values = { invoiceText: '26117000000000000001', amount: '120.10', reimbursement: '120.10', payment: '120.10' };
  const ctx = { root: () => ({ evaluate: async () => values }) };
  try {
    await assertExpectedInvoice(ctx, true);
    for (const text of [
      '26117000000000000001 26117000000000000002',
      '126117000000000000001', '261170000000000000010', '',
    ]) {
      values.invoiceText = text;
      await assert.rejects(assertExpectedInvoice(ctx), /expected invoice/);
    }
    values.invoiceText = '26117000000000000001';
    values.payment = '120.11'; await assert.rejects(assertExpectedInvoice(ctx, true), /totals do not match/);
    values.invoiceText = '26117000000000000002'; await assert.rejects(assertExpectedInvoice(ctx), /expected invoice/);
  } finally {
    if (beforeAmount === undefined) delete process.env.EXPECTED_AMOUNT; else process.env.EXPECTED_AMOUNT = beforeAmount;
    if (beforeNumber === undefined) delete process.env.EXPECTED_INVOICE_NUMBER; else process.env.EXPECTED_INVOICE_NUMBER = beforeNumber;
  }
});
test('DeepSeek sends only allowed fields and validates the result', async () => {
  let payload;
  const advisor = new DeepSeekAdvisor('test-key', async (_, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '请核对用途', concerns: ['待核实'], suggestions: ['补充说明'] }) } }] }) };
  });
  const result = await advisor.review(input, '需要补充哪些用途说明？');
  assert.deepEqual(JSON.parse(payload.messages[1].content), { purpose: input.purpose, reason: input.reason, amount: input.amount, question: '需要补充哪些用途说明？' });
  assert.equal(JSON.stringify(payload).includes('TEST01'), false);
  assert.equal(result.source, 'deepseek');
  const invalid = new DeepSeekAdvisor('key', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"summary":true}' } }] }) }));
  await assert.rejects(invalid.review(input, '需要补充哪些用途说明？'), /格式/);
  await assert.rejects(new DeepSeekAdvisor('').review(input, '需要补充哪些用途说明？'), /未配置/);
  const failed = new DeepSeekAdvisor('key', async () => { throw new Error('secret provider details'); });
  await assert.rejects(failed.review(input, '需要补充哪些用途说明？'), error => !error.message.includes('secret') && error.status === 502);
});

test('purpose is required, reason defaults to purpose, and only payment application is enabled', () => {
  for (const reason of [undefined, '', '   ']) {
    const parsed = parseInput({ ...input, reason });
    assert.equal(parsed.reason, input.purpose);
    assert.equal(parsed.reimbursementType, '用款申请单');
  }
  assert.throws(() => parseInput({ ...input, purpose: '' }));
  assert.throws(() => parseInput({ ...input, reimbursementType: '境内差旅单' }), /仅开放/);
  assert.throws(() => parseInput({ ...input, reason: 123 }));
  assert.equal(parseInput(input).reason, input.reason);
});

test('invoice amount uses labelled tax-inclusive total and refuses ambiguous totals', () => {
  const { invoiceTotalFromText } = require('../dist/domain/invoice-total');
  assert.equal(invoiceTotalFromText('金额 100.00 税额 13.00 价税合计（大写）壹佰壹拾叁元整（小写）￥113.00'), '113.00');
  assert.equal(invoiceTotalFromText('价 税 合 计\n（小写） ¥ 1,234.56'), '1234.56');
  assert.equal(invoiceTotalFromText('价税合计：￥120.10'), '120.10');
  assert.equal(invoiceTotalFromText('金额 100.00 税额 13.00'), undefined);
  assert.equal(invoiceTotalFromText('价税合计￥120.10 价税合计￥130.10'), undefined);
  assert.equal(invoiceTotalFromText('价税合计￥120.101'), undefined);
  const { railwayFareFromText } = require('../dist/domain/invoice-total');
  assert.equal(railwayFareFromText('电子发票（铁路电子客票）\n票价: ￥ 378. 00\n5101212002****1018 林俊凯'), '378.00');
  assert.equal(railwayFareFromText('电子发票（铁路电子客票） 票价：¥1,234.50'), '1234.50');
  assert.equal(railwayFareFromText('电子发票（普通发票）\n票价: ￥ 378.00'), undefined, '票价 is ignored unless it is a railway e-ticket');
  assert.equal(railwayFareFromText('电子发票（铁路电子客票）\n票价￥100.00\n票价￥200.00'), undefined);
});

test('partial reimbursement validates invoice total separately from payment total', async () => {
  const { assertExpectedInvoice } = require('../dist/automation/guards');
  const keys = ['EXPECTED_AMOUNT', 'EXPECTED_INVOICE_AMOUNT', 'EXPECTED_INVOICE_NUMBER'];
  const before = keys.map(key => process.env[key]);
  Object.assign(process.env, { EXPECTED_AMOUNT: '100.00', EXPECTED_INVOICE_AMOUNT: '120.10', EXPECTED_INVOICE_NUMBER: '26117000000000000001' });
  const values = { invoiceText: '26117000000000000001', amount: '120.10', reimbursement: '100.00', payment: '100.00' };
  try {
    const ctx = { root: () => ({ evaluate: async () => values }) };
    await assertExpectedInvoice(ctx, true);
    values.payment = '120.10'; await assert.rejects(assertExpectedInvoice(ctx, true));
    values.amount = '119.10'; await assert.rejects(assertExpectedInvoice(ctx));
    values.amount = '120.10'; process.env.EXPECTED_AMOUNT = '121.00';
    await assert.rejects(assertExpectedInvoice(ctx));
  } finally {
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
  }
});
