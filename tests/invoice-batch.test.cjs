const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobStore } = require('../dist/infrastructure/job-store');
const { inspectInvoice } = require('../dist/application/job-service');
const { checkInvoiceBatch, createInvoiceBatchDrafts } = require('../dist/application/invoice-batch');

function pdf(number) {
  const labels = ['价税合计', '小写', `¥1.00`, number];
  const chars = [...new Set(labels.flatMap(label => [...label]))];
  const encode = value => [...value].map(char => (chars.indexOf(char) + 1).toString(16).padStart(2, '0')).join('');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Test) /Ordering (Unicode) /Supplement 0 >> def\n/CMapName /Test def /CMapType 2 def\n1 begincodespacerange <00> <FF> endcodespacerange\n${chars.length} beginbfchar\n${chars.map((char, i) => `<${(i + 1).toString(16).padStart(2, '0')}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = labels.map((label, i) => `BT /F1 14 Tf ${30 + i * 40} ${i === 3 ? 150 : 100} Td <${encode(label)}> Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(result);
}

test('batch validates every invoice before creating any draft and prevents replay', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceDirectory = path.join(dir, 'invoices');
  fs.mkdirSync(sourceDirectory);
  const store = new JobStore(path.join(dir, 'jobs'));
  const entries = [];
  for (const [index, number] of ['26117000000000000041', '26117000000000000042'].entries()) {
    const name = `${index}.pdf`, sourcePath = path.join(sourceDirectory, name), buffer = pdf(number);
    fs.writeFileSync(sourcePath, buffer);
    const { invoice } = await inspectInvoice({ name, base64: buffer.toString('base64') });
    entries.push({ sourcePath, invoice, classificationConfirmed: true,
      input: { purpose: '科研材料采购', reason: '实验用科研材料', payeeCode: 'TEST01',
        fundingKeyword: '项目A', budgetKeyword: '材料费', amount: '1.00', attachmentCount: 1 } });
  }
  const manifestPath = path.join(dir, 'batch.json');
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify({ sourceDirectory, entries }));
  write();
  entries[1].classificationConfirmed = false;
  write();
  await assert.rejects(createInvoiceBatchDrafts(manifestPath, store), /分类尚未确认/);
  assert.equal(store.list('local').length, 0);
  entries[1].classificationConfirmed = true;
  // Live OA work can exist outside the local job store (including one form
  // covering several invoices). Even stale per-entry statuses must not replay it.
  for (const liveForms of [
    [{ documentNumber: 'A209900000002', invoiceNumber: entries[0].invoice.number, status: 'submitted' }],
    [{ documentNumber: 'A209900000003', invoiceNumbers: entries.map(entry => entry.invoice.number), status: 'invoice_selection_confirmed' }],
    [{ documentNumber: 'A209900000004', status: 'created_selecting_funding' }],
  ]) {
    fs.writeFileSync(manifestPath, JSON.stringify({ sourceDirectory, entries, liveForms }));
    await assert.rejects(createInvoiceBatchDrafts(manifestPath, store), /已有 OA 单据/);
    assert.equal(store.list('local').length, 0);
  }
  for (const record of [
    { status: 'submitted' }, { status: 'invoice_selection_confirmed' },
    { status: 'unknown_status' }, { documentNumber: 'A209900000005' }, { jobId: 'prior-job' },
  ]) {
    const recorded = entries.map((entry, i) => i === 1 ? { ...entry, ...record } : entry);
    fs.writeFileSync(manifestPath, JSON.stringify({ sourceDirectory, entries: recorded }));
    await assert.rejects(createInvoiceBatchDrafts(manifestPath, store), /已有办理记录或状态不明确/);
    assert.equal(store.list('local').length, 0);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ sourceDirectory, entries, liveForms: {} }));
  await assert.rejects(checkInvoiceBatch(manifestPath, store), /OA 单据记录格式无效/);
  entries[0].status = 'ready';
  entries[1].status = 'awaiting_user_details';
  entries[1].input.budgetKeyword = '';
  write();
  await assert.rejects(createInvoiceBatchDrafts(manifestPath, store), /预算支出项/);
  assert.equal(store.list('local').length, 0);
  entries[1].input.budgetKeyword = '材料费';
  entries[1].invoice.sha256 = 'invalid';
  write();
  await assert.rejects(checkInvoiceBatch(manifestPath, store), /不一致/);
  entries[1].invoice.sha256 = (await inspectInvoice({ name: '1.pdf', base64: fs.readFileSync(entries[1].sourcePath).toString('base64') })).invoice.sha256;
  write();
  const jobs = await createInvoiceBatchDrafts(manifestPath, store);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(job => job.status === 'draft' && job.action === 'submit'));
  const again = await createInvoiceBatchDrafts(manifestPath, store);
  assert.equal(again.length, 2);
});
