import { test, expect, type Page, type Route } from '@playwright/test';
import { PAGE_PATH } from '../src/server/app';

/** The Easy page (PAGE_PATH) in a real browser. Every /api call is answered here, so the page runs
 * against the shapes the server returns without a school login; the server only serves the files. */

const FUNDS = { total: 2, pageCount: 1, items: [
  { code: '2099F9999-000-01', name: '教师乙启动经费', label: '2099F9999-000-01-教师乙启动经费', department: '教师乙组' },
  { code: 'P001', name: '测试项目', label: 'P001-测试项目', department: '信息学院' }] };
const MONEY_SUBJECTS = [{ code: '30', name: '委托服务费', quotaCode: '01', quotaName: '业务费', balance: '9000.00' }];
const TRAVEL_SUBJECTS = [{ code: '09', name: '国内差旅/参会费', quotaCode: '02', quotaName: '业务费', balance: '4910.83' },
  { code: '10', name: '会议费', quotaCode: '02', quotaName: '业务费', balance: '3000.00' }];

interface Stub { posts: Array<{ path: string; body: Record<string, unknown> }>; errors: string[] }

async function openPage(page: Page): Promise<Stub> {
  const stub: Stub = { posts: [], errors: [] };
  // The combo arrow is a data: SVG in easy.css, which the page CSP (img-src 'self') blocks; that is cosmetic.
  page.on('console', message => { if (message.type() === 'error' && !/data:image\/svg/.test(message.text())) stub.errors.push(message.text()); });
  page.on('pageerror', error => stub.errors.push(error.message));
  const json = (route: Route, body: unknown) => route.fulfill({ json: body });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'POST') stub.posts.push({ path: url.pathname, body: route.request().postDataJSON() ?? {} });
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/session': return json(route, { csrfToken: 'test-csrf', liveEnabled: true });
      case 'GET /api/oa/status': return json(route, { loggedIn: false, savedUsername: null });
      case 'POST /api/oa/login': return json(route, { loggedIn: true, login: { userAccount: '900001', userName: '报销人甲',
        at: '2026-10-22T08:00:00.000Z', savedPassword: false, steps: ['统一身份认证'] } });
      case 'GET /api/oa/funds': return json(route, FUNDS);
      case 'GET /api/oa/budgets': return json(route, { fundingCode: url.searchParams.get('fundingCode'), total: 1, balance: '193110.83', subjects: MONEY_SUBJECTS });
      case 'GET /api/oa/travel/budgets': return json(route, { fundingCode: url.searchParams.get('fundingCode'), total: 2, balance: '193110.83', subjects: TRAVEL_SUBJECTS });
      case 'GET /api/oa/forms': return json(route, { forms: [] });
      case 'GET /api/oa/folder-invoices': return json(route, { invoices: [{ folderId: '1879423340632997890', folderName: '自行上传票据',
        number: '26117000000000000041', seller: '某商贸公司', date: '2026-09-08', amount: '300.00', balance: '300.00', selectable: true, reason: '' }], truncated: false });
      case 'GET /api/oa/travel': return json(route, { run: null });
      case 'GET /api/oa/travel/forms': return json(route, { forms: [{ documentNumber: 'D209900000038', date: '2026-10-21' }] });
      case 'GET /api/oa/travel/borrows': return json(route, { borrows: [
        { order: '1990000000000006', remark: '携程机票 上海至大连', personName: '教师乙', outstanding: '882.00', date: '2026-08-16' }] });
      case 'GET /api/oa/travel/people': return json(route, { people: url.searchParams.get('name') === '教师乙'
        ? [{ code: '900002', name: '教师乙', dept: '教师乙组' }] : [] });
      case 'POST /api/oa/submit': return json(route, { job: { id: 'job-1', status: 'queued', createdAt: '2026-10-22T08:00:00.000Z', events: [],
        input: route.request().postDataJSON().input, invoice: null } });
      case 'GET /api/jobs/job-1': return json(route, { job: { id: 'job-1', status: 'queued', createdAt: '2026-10-22T08:00:00.000Z', events: [], input: {} } });
      case 'POST /api/oa/travel': return json(route, { run: { id: 'r1', status: 'running', action: 'save', startedAt: '2026-10-22T08:00:00.000Z',
        events: [{ at: '2026-10-22T08:00:00.000Z', step: 'create', message: '正在新建境内差旅单。' }] } });
      default: return route.fulfill({ status: 404, json: { error: `test has no answer for ${method} ${url.pathname}` } });
    }
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(PAGE_PATH);
  await page.fill('#username', '900001');
  await page.fill('#password', 'any');
  await page.click('#login-button');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#fund-select')).toBeEnabled();
  return stub;
}

/** The native select behind a searchable combo box. */
async function choose(page: Page, select: string, value: string) {
  await page.locator(select).selectOption(value, { force: true });
}

test('/ lands on the page, which loads as ES modules', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`${PAGE_PATH}$`));
  await expect(page.locator('script[type="module"][src="/js/main.js"]')).toHaveCount(1);
});

test('用款申请单: fund, budget item, a folder invoice, payee and purpose become one /api/oa/submit', async ({ page }) => {
  const stub = await openPage(page);
  await expect(page.locator('#claim-title')).toHaveText('填写用款申请单');
  await expect(page.locator('#travel')).toBeHidden();
  // 保存并提交流转 is the default, also after 清空重填.
  await expect(page.locator('input[name=action][value=submit]')).toBeChecked();
  await page.check('input[name=action][value=save]');
  await page.click('#claim-new');
  await expect(page.locator('input[name=action][value=submit]')).toBeChecked();
  await choose(page, '#fund-select', 'P001');
  await expect(page.locator('#subject-select')).toBeEnabled();
  await choose(page, '#subject-select', '01:30');
  await page.click('#pick-folder-oa');
  await page.locator('#folder-rows input[type=checkbox]').first().check();
  await page.click('#folder-add');
  await expect(page.locator('#amount')).toHaveValue('300.00');
  await page.fill('#purpose', '大模型API使用费');
  await page.check('input[name=action][value=save]');
  await page.click('#submit');
  await expect(page.locator('#jobs-card')).toBeVisible();
  const submit = stub.posts.find(post => post.path === '/api/oa/submit')!;
  // Exactly this body: a field added or dropped by a refactor fails here.
  expect(submit.body).toEqual({ confirmed: true, action: 'save', documentNumber: null,
    invoices: [{ folderId: '1879423340632997890', number: '26117000000000000041' }],
    input: { reimbursementType: '用款申请单', fundingKindKeyword: '被授权的项目', fundingKeyword: 'P001', budgetKeyword: '委托服务费',
      amount: '300.00', attachmentCount: 1, payeeCode: '900001', purpose: '大模型API使用费', reason: '' } });
  expect(stub.posts.some(post => post.path === '/api/oa/travel')).toBe(false);
  expect(stub.errors).toEqual([]);
});

test('境内差旅单: its own budget query, a traveller found by name, two lines and two payees become one /api/oa/travel', async ({ page }) => {
  const stub = await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  await expect(page.locator('#claim-title')).toHaveText('填写境内差旅单');
  for (const id of ['#travel', '#travel-lines', '#travel-payees', '#itinerary']) await expect(page.locator(id)).toBeVisible();
  for (const id of ['#subject-select', '#payee', '#purpose', '#amount']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('#travel-form-select option')).toHaveCount(2);

  const budgets = page.waitForRequest(request => request.url().includes('/api/oa/travel/budgets'));
  await choose(page, '#fund-select', '2099F9999-000-01');
  await budgets;
  // The first line defaults to 国内差旅/参会费, and the 携程 loans of the fund are listed.
  await expect(page.locator('#line-rows tr:first-child select')).toHaveValue('02:09');
  await expect(page.locator('#ctrip-select option')).toHaveCount(2);

  const card = page.locator('.traveller').first();
  await card.locator('.traveller-head input').first().fill('教师乙');
  await expect(card.locator('.traveller-head select').nth(1)).toHaveValue('900002');
  await expect(card.locator('.subsidy-rate')).toHaveText('180 元/天');
  const leg = card.locator('.legs tbody tr').first();
  const cell = (index: number) => leg.locator('td').nth(index).locator('input, select').first();
  await cell(0).fill('2026-10-19');
  await cell(1).fill('上海');
  await cell(2).fill('2026-10-20');
  await cell(3).fill('北京');
  await cell(4).selectOption('aircraft');
  await cell(5).fill('1000');
  await cell(6).fill('2');
  await expect(cell(7)).toHaveAttribute('placeholder', '标准 360.00');
  await cell(9).fill('2400');

  // 经费明细: 会议费 2400 + 国内差旅 the rest; 收款人: 教师乙 (followed from the traveller) 2400 + 报销人甲 the rest.
  await page.click('#line-add');
  const second = page.locator('#line-rows tr').nth(1);
  await second.locator('select').selectOption('02:10');
  await second.locator('input').first().fill('2400');
  await page.locator('#line-rows tr').first().locator('input').nth(1).fill('交通与补贴');
  await second.locator('input').nth(1).fill('会议注册费');
  await expect(page.locator('#line-total')).toContainText('自动填入的一行约 1360.00 元');
  await page.locator('#payee-rows tr:first-child input.num').fill('2400');
  await page.click('#payee-add');
  const payee = page.locator('#payee-rows tr').nth(1);
  await expect(page.locator('#payee-rows tr:first-child input').first()).toHaveValue('900002');
  await payee.locator('input').first().fill('900001');
  await payee.locator('input').first().dispatchEvent('change');
  await expect(page.locator('#payee-total')).toContainText('自动填入的一位约 1360.00 元');
  // Amount right after the payee; the transfer column only for a 银行汇款.
  await expect(page.locator('#payee-rows tr:first-child td').nth(1).locator('input.num')).toHaveCount(1);
  await expect(page.locator('#payee-account-head')).toHaveText('');
  await page.fill('#reason', '教师乙北京出差');
  await page.check('input[name=action][value=save]');
  await page.click('#submit');
  await expect(page.locator('#travel-card')).toBeVisible();
  // 执行进度 collapses to its latest step and expands again.
  await expect(page.locator('#travel-toggle')).toHaveText('收起');
  await page.click('#travel-toggle');
  await expect(page.locator('#travel-toggle')).toHaveText(/展开全部 \d+ 步/);
  await expect(page.locator('#travel-card .travel-note')).toBeHidden();
  await page.click('#travel-toggle');
  await expect(page.locator('#travel-card .travel-note')).toBeVisible();

  const travel = stub.posts.find(post => post.path === '/api/oa/travel')!;
  // Exactly this body: a field added or dropped by a refactor fails here.
  expect(travel.body).toEqual({ confirmed: true, action: 'save', documentNumber: null, invoices: [], input: {
    fundingKind: 'authorized', fundingCode: '2099F9999-000-01', attachmentCount: 1, reason: '教师乙北京出差', explain: '', ctripOrders: [],
    lines: [{ budgetName: '国内差旅/参会费', amount: '', purpose: '交通与补贴' }, { budgetName: '会议费', amount: '2400', purpose: '会议注册费' }],
    payees: [{ kind: 'card', code: '900002', amount: '2400' }, { kind: 'card', code: '900001', amount: '' }],
    travellers: [{ kind: 'staff', code: '900002', name: '教师乙', legs: [{ startDate: '2026-10-19', startAddress: '上海', arriveDate: '2026-10-20',
      arriveAddress: '北京', vehicle: 'aircraft', trafficExpense: '1000', travelDays: 2, subsidyAmount: '', hotelExpense: '', meetingAmount: '2400',
      otherAmount: '' }] }] } });
  expect(stub.posts.some(post => post.path === '/api/oa/submit')).toBe(false);
  expect(stub.errors).toEqual([]);
});

test('境内差旅单 lines that cannot add up are refused on the page, before any request', async ({ page }) => {
  const stub = await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  await choose(page, '#fund-select', '2099F9999-000-01');
  await expect(page.locator('#line-rows tr:first-child select')).toHaveValue('02:09');
  // A 1000 元 leg, but the only line asks for 99 元 and nothing is left to a blank line.
  await page.locator('.legs tbody tr').first().locator('td').nth(5).locator('input').fill('1000');
  await page.locator('#line-rows tr:first-child input.num').fill('99');
  await page.check('input[name=action][value=save]');
  await page.click('#submit');
  await expect(page.locator('#claim-error')).toContainText('经费明细合计须等于差旅合计（约 1000.00 元）');
  await expect(page.locator('#claim-error')).toContainText('请填写启程和到达日期');
  await expect(page.locator('#claim-error')).toContainText('请输入姓名并在 OA 中查找');
  expect(stub.posts.some(post => post.path === '/api/oa/travel')).toBe(false);
  // Each problem marks its field; the first is focused, and a problem's line jumps to its own field.
  const nameInput = page.locator('.traveller-head input').first(), lineAmount = page.locator('#line-rows tr:first-child input.num');
  await expect(nameInput).toHaveClass(/field-invalid/);
  await expect(nameInput).toBeFocused();
  await expect(lineAmount).toHaveClass(/field-invalid/);
  await expect(page.locator('.legs tbody tr').first().locator('input[type=date]').first()).toHaveClass(/field-invalid/);
  await page.locator('#claim-error .problem-jump', { hasText: '经费明细合计' }).click();
  await expect(lineAmount).toBeFocused();
  await lineAmount.fill('1000');
  await expect(lineAmount).not.toHaveClass(/field-invalid/);
  // Back to 用款申请单: its own fields return and its budget query is used again.
  const budgets = page.waitForRequest(request => /\/api\/oa\/budgets\?/.test(request.url()));
  await page.locator('#claim-type').selectOption('用款申请单');
  await budgets;
  for (const id of ['#subject-select', '#payee', '#purpose']) await expect(page.locator(id)).toBeAttached();
  await expect(page.locator('#travel')).toBeHidden();
  expect(stub.errors).toEqual([]);
});

test('票据 in one place: invoices go to 票夹, the rest is parsed only; legs, the 携程借款单 and the amounts fill themselves', async ({ page }) => {
  const stub = await openPage(page);
  const ticket = { type: 'train', file: 'g1.pdf', passenger: '教师乙', number: 'G1', date: '2026-07-05', time: '07:00', from: '上海', to: '北京',
    fromStation: '上海虹桥', toStation: '北京南', fare: '553.00', seat: '二等座', invoiceNumber: '26429165818000000001', refund: false };
  const flight = { type: 'flight', file: 'order.pdf', order: '1990000000000006', number: 'MU5100', date: '2026-07-07', time: '18:00',
    arriveDate: '2026-07-07', arriveTime: '20:10', from: '北京', to: '上海', fromCode: 'PEK', toCode: 'SHA', total: '882.00' };
  const notice = { type: 'document', file: 'notice.docx', title: '关于召开 2026 年度学术会议的通知' };
  const parsed: string[] = [];
  await page.route('**/api/travel/parse', route => {
    const name = route.request().postDataJSON().name;
    parsed.push(name);
    return route.fulfill({ json: { items: [name === 'g1.pdf' ? ticket : name === 'order.pdf' ? flight : notice] } });
  });
  await page.route('**/api/invoices/split', route => route.fulfill({ json: { skipped: [], parts: [{ name: 'g1.pdf', base64: 'JVBERi0=',
    invoice: { number: '26429165818000000001', amount: '553.00', seller: '中国国家铁路集团有限公司', date: '2026-07-05' } }] } }));
  await page.route('**/api/travel/itinerary', route => route.fulfill({ json: { itinerary: { groups: [{ passenger: '教师乙', legs: [
    { startDate: '2026-07-05', startAddress: '上海', arriveDate: '2026-07-05', arriveAddress: '北京', vehicle: 'train', trafficExpense: '553.00',
      travelDays: 3, hotelExpense: '', meetingAmount: '', otherAmount: '', source: 'G1 上海虹桥→北京南（g1.pdf）' },
    { startDate: '2026-07-07', startAddress: '北京', arriveDate: '2026-07-07', arriveAddress: '上海', vehicle: 'aircraft', trafficExpense: '882.00',
      travelDays: 0, hotelExpense: '', meetingAmount: '', otherAmount: '', source: 'MU5100 PEK→SHA（order.pdf）' }] }],
    ctripOrders: ['1990000000000006'], reason: notice.title, hotels: [], warnings: [] } } }));
  await page.locator('#claim-type').selectOption('境内差旅单');
  await expect(page.locator('#invoice-legend')).toHaveText('票据（发票与行程附件）');
  await expect(page.locator('#drop')).toBeHidden();
  await page.setInputFiles('#itinerary-files', ['g1.pdf', 'order.pdf', 'notice.docx'].map(name =>
    ({ name, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', buffer: Buffer.from(`%PDF-1.7 ${name}`) })));
  // Sorted: the rail ticket is an invoice for 票夹, the order page and the notice are parsed only.
  const rows = page.locator('#itinerary-file-rows');
  await expect(rows).toContainText('发票：提交时上传到 OA 票夹（1）');
  await expect(rows).toContainText('其他票据：只在本机解析，不上传（2）');
  await expect(rows.locator('tr', { hasText: 'g1.pdf' })).toContainText('上传票夹');
  await expect(rows.locator('tr', { hasText: 'order.pdf' })).toContainText('仅解析');
  await expect(page.locator('#invoice-rows')).toContainText('26429165818000000001');
  // Travellers and legs without a click, the traveller found in OA, the notice as 报销事由.
  const card = page.locator('.traveller').first();
  await expect(card.locator('.traveller-head input').first()).toHaveValue('教师乙');
  await expect(card.locator('.traveller-head select').nth(1)).toHaveValue('900002');
  await expect(card.locator('.legs tbody tr')).toHaveCount(2);
  await expect(card.locator('.legs tbody tr').nth(1).locator('td').nth(5).locator('input')).toHaveValue('882.00');
  await expect(page.locator('#reason')).toHaveValue(notice.title);
  await expect(page.locator('#itinerary-status')).toContainText('选择经费后自动勾选');
  // The fund's loans are listed: the flight's order is picked, and the payee is owed the trip less it.
  await choose(page, '#fund-select', '2099F9999-000-01');
  await expect(page.locator('#ctrip-picked')).toContainText('1990000000000006');
  await expect(page.locator('#itinerary-status')).toContainText('已勾选携程借款单：订单 1990000000000006');
  // 553 + 882 交通 + 540 补贴 (教工 180 × 3) = 1975; less the 882 loan = 1093.
  await expect(page.locator('#line-rows tr:first-child input.num')).toHaveValue('1975.00');
  await expect(page.locator('#payee-rows tr:first-child input.num')).toHaveValue('1093.00');
  // Removing the ticket takes its invoice out of 票夹 too.
  await rows.locator('tr', { hasText: 'g1.pdf' }).getByRole('button', { name: '删除' }).click();
  await expect(page.locator('#invoice-rows')).not.toContainText('26429165818000000001');
  // Each file goes to the local parser once (parsed results are cached) and nowhere else.
  expect(parsed.sort()).toEqual(['g1.pdf', 'notice.docx', 'order.pdf']);
  expect(stub.posts.some(post => post.path === '/api/oa/travel')).toBe(false);
  expect(stub.errors).toEqual([]);
});

test('境内差旅单 counts nothing as done that was not filled in; invoices are optional, not done', async ({ page }) => {
  await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  // Only 完成方式 (default 保存并提交流转) is done; 收款人 is not "done" just because nothing is owed yet.
  await expect(page.locator('#ready-count')).toHaveText('1 / 6');
  await expect(page.locator('.check', { hasText: '收款人' })).not.toHaveClass(/\bok\b/);
  await expect(page.locator('.check', { hasText: '收款人' })).toContainText('待填行程');
  await expect(page.locator('.check', { hasText: '发票' })).toHaveClass(/\boptional\b/);
  await choose(page, '#fund-select', '2099F9999-000-01');
  await expect(page.locator('#ready-count')).toHaveText('2 / 6');
});

test('an open dropdown that is still loading is not redrawn (no flicker)', async ({ page }) => {
  await openPage(page);
  // The draft list never answers: its loading option stays.
  await page.route('**/api/oa/travel/forms', () => new Promise(() => {}));
  await page.locator('#claim-type').selectOption('境内差旅单');
  const loading = page.locator('#travel-form-select option').nth(1);
  await expect(loading).toBeDisabled();
  await page.locator('#travel-form-select').focus();
  const before = await loading.textContent();
  await page.waitForTimeout(1300);
  expect(await loading.textContent()).toBe(before);
  // Unfocused, it animates again.
  await page.locator('#fund-kind').focus();
  await expect.poll(() => loading.textContent(), { timeout: 2000 }).not.toBe(before);
});

test('清空重填 keeps the 报销类型: a 境内差旅单 starts over as a 境内差旅单', async ({ page }) => {
  await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  await page.locator('.traveller').first().locator('.traveller-head input').first().fill('教师乙');
  await page.click('#claim-new');
  await expect(page.locator('#claim-type')).toHaveValue('境内差旅单');
  await expect(page.locator('#claim-title')).toHaveText('填写境内差旅单');
  await expect(page.locator('#travel')).toBeVisible();
  await expect(page.locator('.traveller').first().locator('.traveller-head input').first()).toHaveValue('');
  await page.locator('#claim-type').selectOption('用款申请单');
  await page.click('#claim-new');
  await expect(page.locator('#claim-type')).toHaveValue('用款申请单');
});

test('the trip total fills the 经费明细 amount and the amount owed fills the payee, and are still sent as the rest', async ({ page }) => {
  const stub = await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  await choose(page, '#fund-select', '2099F9999-000-01');
  const card = page.locator('.traveller').first();
  await card.locator('.traveller-head input').first().fill('教师乙');
  await expect(card.locator('.traveller-head select').nth(1)).toHaveValue('900002');
  const leg = card.locator('.legs tbody tr').first();
  const cell = (index: number) => leg.locator('td').nth(index).locator('input, select').first();
  await cell(0).fill('2026-10-19'); await cell(1).fill('上海'); await cell(2).fill('2026-10-20'); await cell(3).fill('北京');
  await cell(5).fill('1000'); await cell(6).fill('2');
  // 1000 交通 + 360 补贴 (教工 180 × 2).
  const line = page.locator('#line-rows tr:first-child input.num'), payee = page.locator('#payee-rows tr:first-child input.num');
  await expect(line).toHaveValue('1360.00');
  await expect(line).toHaveClass(/\bauto\b/);
  await expect(payee).toHaveValue('1360.00');
  // A second line with its own amount: the automatic one takes the rest.
  await page.click('#line-add');
  const second = page.locator('#line-rows tr').nth(1);
  await second.locator('select').selectOption('02:10');
  await second.locator('input.num').fill('360');
  await expect(line).toHaveValue('1000.00');
  // Typed over, it is manual; cleared, automatic again.
  await line.fill('900');
  await expect(line).not.toHaveClass(/\bauto\b/);
  await line.fill('');
  await page.locator('#reason').click();
  await expect(line).toHaveValue('1000.00');
  await page.locator('#line-rows tr:first-child input').nth(1).fill('交通与补贴');
  await second.locator('input').nth(1).fill('会议费');
  await page.fill('#reason', '教师乙北京出差');
  await page.check('input[name=action][value=save]');
  await page.click('#submit');
  await expect(page.locator('#travel-card')).toBeVisible();
  const travel = stub.posts.find(post => post.path === '/api/oa/travel')!;
  expect((travel.body as any).input.lines.map((l: any) => l.amount)).toEqual(['', '360']);
  expect((travel.body as any).input.payees.map((p: any) => p.amount)).toEqual(['']);

  // A 银行汇款 payee (a name, not a 学号/工号) brings the transfer account and purpose, after the amount.
  await page.click('#payee-add');
  const bank = page.locator('#payee-rows tr').nth(1);
  await bank.locator('input').first().fill('某某会务有限公司');
  await bank.locator('input').first().dispatchEvent('change');
  await expect(page.locator('#payee-account-head')).toHaveText('银行转账账户与汇款用途');
  await expect(bank.locator('td').nth(2).locator('select')).toHaveCount(1);
  await expect(bank.locator('td').nth(2).locator('input')).toHaveAttribute('placeholder', /汇款用途/);
});

test('差旅天数 only have to add up to the whole trip; any one leg may hold them all', async ({ page }) => {
  await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  const card = page.locator('.traveller').first();
  await card.locator('button', { hasText: '添加行程' }).click();
  const legs = card.locator('.legs tbody tr');
  const cell = (row: number, index: number) => legs.nth(row).locator('td').nth(index).locator('input, select').first();
  // 10-19 → 10-19, then 10-21 → 10-21: a trip of 3 days, all on the first leg.
  for (const [row, from, to, a, b] of [[0, '2026-10-19', '2026-10-19', '上海', '北京'], [1, '2026-10-21', '2026-10-21', '北京', '上海']] as const) {
    await cell(row, 0).fill(from); await cell(row, 1).fill(a); await cell(row, 2).fill(to); await cell(row, 3).fill(b); await cell(row, 5).fill('100');
  }
  await cell(0, 6).fill('3'); await cell(1, 6).fill('0');
  await page.click('#submit');
  await expect(page.locator('#claim-error')).not.toContainText('差旅天数');
  await cell(1, 6).fill('1');
  await page.click('#submit');
  await expect(page.locator('#claim-error')).toContainText('各段差旅天数合计 4 天，应等于行程总天数 3 天');
  await expect(cell(0, 6)).toHaveClass(/field-invalid/);
  await expect(cell(1, 6)).toHaveClass(/field-invalid/);
});

test('the payee follows the traveller found in OA, until another payee is typed', async ({ page }) => {
  await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  const payee = page.locator('#payee-rows tr:first-child input').first();
  // Before any traveller: the login's own 工号.
  await expect(payee).toHaveValue('900001');
  await page.locator('.traveller-head input').first().fill('教师乙');
  await expect(payee).toHaveValue('900002');
  await expect(payee).toHaveClass(/\bauto\b/);
  await expect(page.locator('#payee-rows')).toContainText('按出差人 教师乙 自动填入');
  // Typed by hand, it stays.
  await payee.fill('2020000001');
  await payee.dispatchEvent('change');
  await page.locator('.traveller-head input').first().fill('');
  await page.locator('.traveller-head input').first().fill('教师乙');
  await expect(page.locator('.traveller-head select').nth(1)).toHaveValue('900002');
  await expect(payee).toHaveValue('2020000001');
});

test('adding a payee keeps the first one\'s amount: it takes what the others leave, the total stays what is owed', async ({ page }) => {
  await openPage(page);
  await page.locator('#claim-type').selectOption('境内差旅单');
  const card = page.locator('.traveller').first();
  const cell = (index: number) => card.locator('.legs tbody tr').first().locator('td').nth(index).locator('input, select').first();
  await cell(5).fill('1000'); await cell(6).fill('0');
  const first = page.locator('#payee-rows tr').nth(0).locator('input.num');
  await expect(first).toHaveValue('1000.00');
  await page.click('#payee-add');
  const second = page.locator('#payee-rows tr').nth(1).locator('input.num');
  await expect(first).toHaveValue('1000.00');
  await expect(second).toHaveValue('');
  await expect(second).toHaveAttribute('placeholder', '填写金额');
  await expect(page.locator('#payee-total')).toContainText('第 2 位还没有金额');
  await second.fill('300');
  await expect(first).toHaveValue('700.00');
  await expect(page.locator('#payee-total')).not.toHaveClass(/error/);
  // The same for 经费明细 (its rows need the fund's 支出项目).
  await choose(page, '#fund-select', '2099F9999-000-01');
  await expect(page.locator('#line-add')).toBeEnabled();
  await page.click('#line-add');
  await expect(page.locator('#line-rows tr').nth(0).locator('input.num')).toHaveValue('1000.00');
});

test('the login page explains the project, and every page has the footer', async ({ page }) => {
  await page.goto(PAGE_PATH);
  await expect(page.locator('.login-card .about')).toHaveText('本项目旨在帮助各位同事更加便捷地制作各种报销单。通过封装真实的 egate 数据接口，减少繁琐、冗余的操作，提高办公效率。');
  await expect(page.locator('.site-footer')).toBeVisible();
  await expect(page.locator('.site-footer')).toContainText('实现高效的办公。');
  // The address comes from REIM_CONTACT_EMAIL (help@reimbursement-copilot.invalid for the test server).
  await expect(page.locator('#footer-contact')).toHaveText('有任何问题请邮件联系 help@reimbursement-copilot.invalid。');
  await expect(page.locator('#footer-email')).toHaveAttribute('href', 'mailto:help@reimbursement-copilot.invalid');
  for (const path of ['/print-list', '/admin']) {
    await page.goto(path);
    await expect(page.locator('.site-footer')).toContainText('本项目旨在帮助各位同事便捷制作各种报销单');
  }
});
