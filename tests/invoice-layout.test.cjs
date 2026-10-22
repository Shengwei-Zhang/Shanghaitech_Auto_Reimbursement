const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInvoicePdf, invoiceTextRows } = require('../dist/infrastructure/invoice-pdf');
const { JobService } = require('../dist/application/job-service');
const { JobStore } = require('../dist/infrastructure/job-store');

// Synthetic PDF kept in memory. Its content stream intentionally writes labels
// before values, unlike their visual reading order. No real invoice is committed.
function layoutPdf(items) {
  const chars = [...new Set(items.flatMap(item => [...item.text]))];
  const encode = text => [...text].map(char => (chars.indexOf(char) + 1).toString(16).padStart(2, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Test) /Ordering (Unicode) /Supplement 0 >> def
/CMapName /Test def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
${chars.length} beginbfchar
${chars.map((char, i) => `<${(i + 1).toString(16).padStart(2, '0')}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = items.map(({ text, x, y }) => `BT /F1 9 Tf ${x} ${y} Td <${encode(text)}> Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`];
  let result = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(result);
}
const items = [
  { text: '价税合计（大写）', x: 48, y: 109 },
  { text: '（小写）', x: 400, y: 109 },
  { text: '26117000000000000099', x: 400, y: 350 },
  { text: '¥396.04', x: 400, y: 129 },
  { text: '¥3.96', x: 550, y: 129 },
  { text: '¥', x: 440, y: 110.5 },
  { text: '400.00', x: 450, y: 110.5 },
];

test('per-glyph invoice text keeps the number, total and seller together', () => {
  const glyphs = (text, x, y, width) => [...text].map((ch, i) => ({
    str: ch, width, transform: [width, 0, 0, width, x + i * width, y],
  }));
  const rows = invoiceTextRows([
    ...glyphs('发票号码：', 40, 320, 9),
    ...glyphs('26312000004571729416', 150, 320, 4.5),
    ...glyphs('开票日期：2026年07月18日', 40, 300, 9),
    ...glyphs('售名称：上海盈科电子商务有限公司', 200, 260, 9),
    ...glyphs('价税合计（大写）柒拾壹圆肆角整（小写）¥71.40', 40, 100, 9),
  ]);
  const text = rows.join('\n');
  const { pickInvoiceNumberFromText } = require('../dist/automation/invoice-pdf');
  const { invoicePartiesFromText } = require('../dist/domain/invoice-rules');
  const { invoiceTotalFromText } = require('../dist/domain/invoice-total');
  assert.equal(pickInvoiceNumberFromText(text, null), '26312000004571729416');
  assert.deepEqual(invoicePartiesFromText(text), { date: '2026-07-18', seller: '上海盈科电子商务有限公司' });
  assert.equal(invoiceTotalFromText(rows.find(row => row.includes('价税合计'))), '71.40');
});

test('positioned PDF total is read beside its label despite shuffled content stream', async () => {
  const result = await readInvoicePdf(layoutPdf(items));
  assert.equal(result.amount, '400.00');
  assert.match(result.text, /26117000000000000099/);
  assert.equal((await readInvoicePdf(layoutPdf([...items].reverse()))).amount, '400.00');
});

test('a railway e-ticket uses 票价 and 中国国家铁路集团有限公司, not 价税合计', async () => {
  const { inspectInvoice } = require('../dist/application/job-service');
  const ticket = layoutPdf([
    { text: '电子发票（铁路电子客票）', x: 48, y: 350 },
    { text: '发票号码：26429165800004692416', x: 48, y: 330 },
    { text: '开票日期：2026年08月07日', x: 48, y: 310 },
    { text: '票价: ￥ 378. 00', x: 48, y: 200 },
    { text: '购买方名称: 上海科技大学', x: 48, y: 160 },
  ]);
  const result = await readInvoicePdf(ticket);
  assert.equal(result.amount, '378.00');
  const { invoice } = await inspectInvoice({ name: 'train.pdf', base64: ticket.toString('base64') });
  assert.equal(invoice.number, '26429165800004692416');
  assert.equal(invoice.amount, '378.00');
  assert.equal(invoice.seller, '中国国家铁路集团有限公司');
  assert.equal(invoice.date, '2026-08-07');
  assert.equal((await readInvoicePdf(layoutPdf([{ text: '票价: ￥ 378.00', x: 48, y: 200 }]))).amount, undefined);
});

test('unrelated adjacent rows and conflicting totals cannot become invoice defaults', async () => {
  assert.equal((await readInvoicePdf(layoutPdf(items.filter(item => item.y !== 110.5)))).amount, undefined);
  assert.equal((await readInvoicePdf(layoutPdf([...items, { text: '价税合计￥500.00', x: 48, y: 70 }]))).amount, undefined);
  assert.deepEqual(invoiceTextRows([{str: 'invalid', transform: []}]), []);
});

test('upload inspection defaults real amount and rejects an amount above the invoice total', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-layout-'));
  const service = new JobService(new JobStore(dir), { review: async () => { throw Error('unused'); } }, false);
  t.after(() => { service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const invoice = { name: 'synthetic.pdf', base64: layoutPdf(items).toString('base64') };
  const input = { purpose: '科研用途', reason: '', payeeCode: 'TEST01', fundingKeyword: '项目', budgetKeyword: '材料费', amount: '401.00', attachmentCount: 1 };
  await assert.rejects(service.create({ mode: 'live', input, invoice }), /不能超过/);
  const job = await service.create({ mode: 'live', input: { ...input, amount: '' }, invoice });
  assert.equal(job.invoice.amount, '400.00');
  assert.equal(job.input.amount, '400.00');
  assert.equal(job.input.reason, input.purpose);
});
