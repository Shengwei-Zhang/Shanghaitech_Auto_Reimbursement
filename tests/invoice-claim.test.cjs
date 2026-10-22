const test = require('node:test');
const assert = require('node:assert/strict');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const claim = require('../dist/automation/invoice-claim.js');

const NUMBER = '26422000000000000001';
const PAGE = { url: 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/x.do', csrfToken: 'TOKEN' };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function client(rowsFor) {
  const queries = [];
  return { queries, client: new OaHttpClient(async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === claim.INVOICE_FOLDERS_PATH) return json({ status: 0, data: [{ id: '1', invoiceFolderName: '自行上传票据' }] });
    queries.push(searchParams);
    return json({ status: 0, data: rowsFor(searchParams.get('invoiceStatus'), Number(searchParams.get('page'))) });
  }) };
}

test('the strongest folder state wins and is reported with its folders', () => {
  assert.deepEqual(claim.classifyClaim([]), { state: 'absent' });
  assert.deepEqual(claim.classifyClaim([{ status: '未报销', folder: 'A' }, { status: '已报销', folder: 'B' }]),
    { state: 'claimed', folders: ['B'] });
  assert.equal(claim.classifyClaim([{ status: '报销中', folder: 'A' }, { status: '未报销', folder: 'A' }]).state, 'claiming');
  assert.match(claim.claimMessage({ state: 'claimed', folders: ['自行上传票据'] }), /已报销，不能重复报销/);
  assert.match(claim.claimMessage({ state: 'unclaimed', folders: ['表单默认票夹'], documents: ['A209900000010'] }),
    /未报销，但已关联在单据 A209900000010 上/);
});

test('a 已报销 hit names the bill that used the invoice and its actual amount', async () => {
  const row = { invoiceNumber: NUMBER, billClaimState: 'DONE',
    electronicInvoice: { billEnOut: { billCodeList: 'A209900000006', totalActualAmount: 200 } } };
  const done = client(status => status === '已报销' ? { Total: 511, Rows: [row] } : { Total: 0, Rows: [] });
  const result = await claim.checkInvoiceClaimHttp(done.client, PAGE, NUMBER);
  assert.deepEqual(result, { state: 'claimed', folders: ['自行上传票据'], documents: ['A209900000006'], claimedAmount: '200.00' });
  assert.equal(claim.claimMessage(result), 'OA 票夹（自行上传票据）显示该发票已报销（单据 A209900000006，实报 200.00 元），不能重复报销。');
  const inPage = await claim.checkInvoiceClaimInPage(async url => url.includes('loadInvoiceFolderList1')
    ? { status: 0, data: [{ id: '1', invoiceFolderName: '表单默认票夹' }] }
    : { status: 0, data: new URL(url, 'https://x').searchParams.get('invoiceStatus') === '已报销' ? { Total: 1, Rows: [row] } : { Total: 0, Rows: [] } }, NUMBER);
  assert.deepEqual(inPage.documents, ['A209900000006']);
});

test('an unclaimed invoice on a later page is found; unread pages fail closed', async () => {
  const later = client((status, page) => status === '未报销'
    ? { Total: 60, Rows: page === 2 ? [{ invoiceNumber: NUMBER }] : Array(50).fill({ invoiceNumber: '1' }) }
    : { Total: 0, Rows: [] });
  assert.deepEqual(await claim.checkInvoiceClaimHttp(later.client, PAGE, NUMBER), { state: 'unclaimed', folders: ['自行上传票据'] });

  const endless = client(status => status === '报销中'
    ? { Total: 10_000, Rows: Array(50).fill({ invoiceNumber: '1' }) } : { Total: 0, Rows: [] });
  await assert.rejects(claim.checkInvoiceClaimHttp(endless.client, PAGE, NUMBER), { code: 'response_invalid' });
});

test('a batch lookup reuses an invoice already in the folder and flags one that was reimbursed', async () => {
  const already = '26312000004571729416', reimbursed = '26952000003089545651', fresh = '26322000006312361996';
  const queries = [];
  const http = new OaHttpClient(async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === claim.INVOICE_FOLDERS_PATH) return json({ status: 0, data: [{ id: '9', invoiceFolderName: '表单默认票夹' }] });
    queries.push(searchParams);
    const rows = [{ invoiceNumber: already, salerName: '上海盈科电子商务有限公司', invoiceDate: '2026-07-18', allValoremTax: 71.4, invoiceBalance: 71.4 },
      { invoiceNumber: reimbursed, salerName: '某公司', invoiceDate: '2026-07-01', allValoremTax: 10, invoiceBalance: 0,
        electronicInvoice: { billEnOut: { billCodeList: 'A209900000024' } } }];
    return json({ status: 0, data: { Total: rows.length, Rows: rows } });
  });
  const found = await claim.lookupInvoicesHttp(http, PAGE, [already, reimbursed, fresh]);
  assert.equal(found[0].state, 'unclaimed');
  assert.equal(found[0].folderId, '9');
  assert.equal(found[0].amount, '71.40');
  assert.equal(found[0].seller, '上海盈科电子商务有限公司');
  assert.deepEqual(found[1].documents, ['A209900000024']);
  assert.equal(found[2].state, 'absent');
  assert.deepEqual(queries.map(query => [query.get('page'), query.get('pagesize'), query.get('invoiceStatus')]),
    [['1', '100', '未报销']], '报销中 and 已报销 are not read: OA refuses such an invoice on upload');
});

test('the folder picker asks each folder once for 100 rows and does not turn the page', async () => {
  const queries = [];
  const http = new OaHttpClient(async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === claim.INVOICE_FOLDERS_PATH) return json({ status: 0, data: [
      { id: '1', invoiceFolderName: '自行上传票据' }, { id: '2', invoiceFolderName: '表单默认票夹' }] });
    queries.push(searchParams);
    const folderId = searchParams.get('folderId');
    const rows = Array.from({ length: folderId === '1' ? 100 : 2 }, (_, index) => ({
      invoiceNumber: `${folderId}${String(index).padStart(19, '0')}`, allValoremTax: '10.00', invoiceBalance: '10.00', invoiceDate: '2026-10-01' }));
    return json({ status: 0, data: { Total: folderId === '1' ? 140 : 2, Rows: rows } });
  });
  const listed = await claim.listFolderInvoicesHttp(http, PAGE);
  assert.equal(listed.truncated, true);
  assert.equal(listed.invoices.length, 102);
  assert.deepEqual(queries.map(query => [query.get('folderId'), query.get('page'), query.get('pagesize'), query.get('invoiceStatus')]),
    [['1', '1', '100', '未报销'], ['2', '1', '100', '未报销']]);
});

test('only the first 已报销 page is read and a rejected response is not treated as absent', async () => {
  const recent = client(status => status === '已报销' ? { Total: 511, Rows: [{ invoiceNumber: '9' }] } : { Total: 0, Rows: [] });
  assert.deepEqual(await claim.checkInvoiceClaimHttp(recent.client, PAGE, NUMBER), { state: 'absent' });
  assert.deepEqual(recent.queries.filter(q => q.get('invoiceStatus') === '已报销').map(q => [q.get('page'), q.get('pagesize')]), [['1', '10']]);

  const rejected = new OaHttpClient(async () => json({ isAuth: 1, message: '错误的请求!', status: '2' }));
  await assert.rejects(claim.checkInvoiceClaimHttp(rejected, PAGE, NUMBER), { code: 'response_invalid' });
});
