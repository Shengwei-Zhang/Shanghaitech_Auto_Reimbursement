const test = require('node:test');
const assert = require('node:assert/strict');
const { invoiceLimitProblems, invoicePartiesFromText } = require('../dist/domain/invoice-rules.js');

const item = (number, face, extra = {}) => ({ number, faceCents: face, ...extra });

test('a single invoice has no 500 元 cap', () => {
  assert.deepEqual(invoiceLimitProblems([item('1', 49_999)]), []);
  assert.deepEqual(invoiceLimitProblems([item('2', 80_000)]), []);
  assert.deepEqual(invoiceLimitProblems([item('3', null)]), []);
});

test('one seller on one day stays below 500 元 per form, whatever the bracket width', () => {
  const day = { date: '2026-09-08' };
  const group = [item('1', 30_000, { seller: '东莞市某经营部（个体工商户）', ...day }), item('2', 19_999, { seller: '东莞市某经营部(个体工商户)', ...day })];
  assert.deepEqual(invoiceLimitProblems(group), []);
  const over = invoiceLimitProblems([...group, item('3', 1, { seller: '东莞市某经营部 (个体工商户)', ...day })]);
  assert.equal(over.length, 1);
  assert.match(over[0], /3 张发票合计 500\.00 元/);
  assert.deepEqual(invoiceLimitProblems([item('1', 30_000, { seller: 'A', date: '2026-09-08' }), item('2', 30_000, { seller: 'A', date: '2026-09-09' }),
    item('3', 30_000, { seller: 'B', date: '2026-09-08' })]), [], 'other days and other sellers are separate');
  assert.deepEqual(invoiceLimitProblems([item('1', 30_000, { seller: 'A', date: '2026-09-08', usedCents: 10_000 }),
    item('2', 30_000, { seller: 'A', date: '2026-09-08' })]), [], 'the group sums what this form reimburses');
});

test('seller and invoice date come from the 全电发票 text rows', () => {
  const text = '电子发票（普通发票） 发票号码： 26422000000000000001\n开票日期： 2026年10月08日\n'
    + '购 名称： 上海科技大学 销 名称： 思讯叶科（湖北省）科技有限公司\n买 售';
  assert.deepEqual(invoicePartiesFromText(text), { date: '2026-10-08', seller: '思讯叶科（湖北省）科技有限公司' });
  assert.deepEqual(invoicePartiesFromText('无关文字'), {});
  assert.deepEqual(invoicePartiesFromText('电子发票（铁路电子客票） 发票号码：26429165800004692416\n开票日期：2026年08月07日\n票价: ￥ 378. 00'),
    { date: '2026-08-07', seller: '中国国家铁路集团有限公司' });
});
