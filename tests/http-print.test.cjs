const test = require('node:test');
const assert = require('node:assert/strict');
const { OaHttpClient } = require('../dist/automation/http-login.js');
const print = require('../dist/automation/http-print.js');

const PAGE = { url: 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new//rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do', csrfToken: 'CSRF-TOKEN-0123456789' };
const BIZ = '5E406998470A3720E0632D2A0F0A452D';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'text/html;charset=utf-8' } });
// Shape of printRbReimbursement.load as captured on 2026-10-21 (images shortened).
const OA_PAGE = `<!DOCTYPE html><html><head>
<script src='https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/lib/jquery/jquery.min.js' type='text/javascript'></script>
<style type="text/css">.page-break { page-break-before: always; } .watermark-tile { position: absolute; }</style>
<script type="text/javascript">$(document).ready(function () { if(!$.isMobile()){ window.print(); } });</script>
</head><body><div class="container-fluid">
<div class="hg-form" align="center"><div class="page-break" style="page-break-before: auto;"><div class="page-image"><img src="${JPEG}" /></div></div></div>
<div class="hg-form" align="center"><div class="page-break"><div class="page-header"><div>A209900000026 - 电子发票附件</div></div>
<div class="page-image"><img src="${JPEG}" onload="steal()" /><div class="watermark-tile" style="background-image: url('data:image/svg+xml;utf8,<svg></svg>');"></div>
<img src="https://evil.example/x.png"><script>alert(1)</script></div><div class="page-footer">电子发票[26442000007291976941] 第 1 页</div></div></div>
</div></body></html>`;

test('print rule follows the OA list button: 2/3/5 print, 取消/预制/驳回/终止 never, others ask OA', () => {
  for (const status of ['2', '3', '5']) assert.equal(print.printRule(status), 'yes');
  for (const status of ['-1', '0', '4', '6']) assert.equal(print.printRule(status), 'no');
  assert.equal(print.printRule('1'), 'check');
});

test('a bill is fetched with the captured chain: 打印状态, watermark path, then the form POST with csrfToken', async () => {
  const calls = [];
  const client = new OaHttpClient(async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ pathname, body: new URLSearchParams(init.body), headers: init.headers });
    if (pathname === print.PRINT_PATHS.status) return json({ data: 'ok', status: 1 });
    if (pathname === print.PRINT_PATHS.watermark) return json({ data: 'images/20190826094407.png', status: 0 });
    if (pathname === print.PRINT_PATHS.page) return new Response(OA_PAGE);
    throw new Error(`unexpected ${url}`);
  });
  const html = await print.fetchPrintPageHttp(client, PAGE, BIZ);
  assert.equal(html, OA_PAGE);
  assert.deepEqual(calls.map(call => call.pathname), [print.PRINT_PATHS.status, print.PRINT_PATHS.watermark, print.PRINT_PATHS.page]);
  assert.equal(calls[0].body.get('id'), BIZ);
  assert.equal(calls[1].body.get('bizId'), BIZ);
  assert.deepEqual(Object.fromEntries(calls[2].body), { id: BIZ, outputType: 'img', markImagePath: 'images/20190826094407.png', csrfToken: PAGE.csrfToken });
  assert.equal(calls[2].headers['x-requested-with'], undefined, 'the page is a form POST into a window, not an ajax call');
  for (const call of calls) assert.equal(call.headers.csrfToken, PAGE.csrfToken);
});

test('OA refusing the 打印状态 check, or a page without images, stops before anything is printed', async () => {
  const refuse = new OaHttpClient(async () => json({ message: '该单据不允许打印', status: 0 }));
  await assert.rejects(print.fetchPrintPageHttp(refuse, PAGE, BIZ), { code: 'not_printable', message: '该单据不允许打印' });
  const empty = new OaHttpClient(async url => new URL(url).pathname === print.PRINT_PATHS.page
    ? new Response('<html><body>出现错误！</body></html>') : json({ data: 'ok', status: 1 }));
  await assert.rejects(print.fetchPrintPageHttp(empty, PAGE, BIZ), { code: 'response_invalid' });
  const expired = new OaHttpClient(async () => json({ isAuth: 1, message: '登录超时，请重新登录!', status: '2' }));
  await assert.rejects(print.fetchPrintPageHttp(expired, PAGE, BIZ), { code: 'authentication' });
});

test('the permission check reads {"data":{"success":true}}', async () => {
  const allow = new OaHttpClient(async () => json({ data: { success: true }, status: 0 }));
  assert.deepEqual(await print.printPermissionHttp(allow, PAGE, BIZ), { allowed: true });
  const deny = new OaHttpClient(async () => json({ data: { success: false, message: '无打印权限' }, status: 0 }));
  assert.deepEqual(await print.printPermissionHttp(deny, PAGE, BIZ), { allowed: false, message: '无打印权限' });
});

test('combined print page keeps OA pages and styles, drops scripts, handlers and remote images', () => {
  const html = print.combinePrintPages([{ billCode: 'A209900000026', html: OA_PAGE }, { billCode: 'A209900000027', html: OA_PAGE }]);
  assert.equal((html.match(/<section class="bill"/g) || []).length, 2);
  assert.equal((html.match(/page-break-before:always"/g) || []).length, 1, 'every bill after the first starts a new sheet');
  assert.equal((html.match(/src="data:image\/jpeg/g) || []).length, 4);
  assert.match(html, /电子发票\[26442000007291976941\] 第 1 页/);
  assert.match(html, /watermark-tile/);
  assert.match(html, /\.page-break \{ page-break-before: always; \}/);
  assert.match(html, /<script src="\/print\.js" defer><\/script>/);
  assert.equal((html.match(/<script/g) || []).length, 1, 'only our print.js');
  assert.doesNotMatch(html, /onload=|steal\(|alert\(|evil\.example|jquery/);
});

test('the 报销单查询 payload carries the 状态 filter and rejects anything but status codes', () => {
  const { buildOwnerListPayload } = require('../dist/automation/reimbursement-list.js');
  assert.equal(buildOwnerListPayload({ pagesize: 100, queryStatusKind: '1' }).queryStatusKind, '1');
  assert.equal(buildOwnerListPayload({ queryStatusKind: '1,3' }).queryStatusKind, '1,3');
  assert.equal(buildOwnerListPayload({}).queryStatusKind, '');
  for (const bad of ['7', '1;', 'a', '1,,3', ' 1']) assert.throws(() => buildOwnerListPayload({ queryStatusKind: bad }), { code: 'invalid_query' });
  assert.equal(print.PRINT_STATUS_KIND, '1');
});
