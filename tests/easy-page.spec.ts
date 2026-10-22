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
  expect(submit.body).toMatchObject({ confirmed: true, action: 'save', documentNumber: null,
    invoices: [{ folderId: '1879423340632997890', number: '26117000000000000041' }],
    input: { fundingKeyword: 'P001', budgetKeyword: '委托服务费', amount: '300.00', attachmentCount: 1, payeeCode: '900001', purpose: '大模型API使用费' } });
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

  // 经费明细: 会议费 2400 + 国内差旅 the rest; 收款人: 报销人甲 2400 + 教师乙 the rest.
  await page.click('#line-add');
  const second = page.locator('#line-rows tr').nth(1);
  await second.locator('select').selectOption('02:10');
  await second.locator('input').first().fill('2400');
  await page.locator('#line-rows tr').first().locator('input').nth(1).fill('交通与补贴');
  await second.locator('input').nth(1).fill('会议注册费');
  await expect(page.locator('#line-total')).toContainText('留空的一行约 1360.00 元');
  await page.locator('#payee-rows tr:first-child input.num').fill('2400');
  await page.click('#payee-add');
  const payee = page.locator('#payee-rows tr').nth(1);
  await payee.locator('input').first().fill('900002');
  await payee.locator('input').first().dispatchEvent('change');
  await expect(page.locator('#payee-total')).toContainText('留空的一位约 1360.00 元');
  await page.fill('#reason', '教师乙北京出差');
  await page.check('input[name=action][value=save]');
  await page.click('#submit');
  await expect(page.locator('#travel-card')).toBeVisible();

  const travel = stub.posts.find(post => post.path === '/api/oa/travel')!;
  expect(travel.body).toMatchObject({ confirmed: true, action: 'save', documentNumber: null, invoices: [], input: {
    fundingCode: '2099F9999-000-01', attachmentCount: 1, reason: '教师乙北京出差', ctripOrders: [],
    lines: [{ budgetName: '国内差旅/参会费', amount: '', purpose: '交通与补贴' }, { budgetName: '会议费', amount: '2400', purpose: '会议注册费' }],
    payees: [{ kind: 'card', code: '900001', amount: '2400' }, { kind: 'card', code: '900002', amount: '' }],
    travellers: [{ kind: 'staff', code: '900002', name: '教师乙', legs: [{ startDate: '2026-10-19', startAddress: '上海', arriveDate: '2026-10-20',
      arriveAddress: '北京', vehicle: 'aircraft', trafficExpense: '1000', travelDays: 2, subsidyAmount: '', meetingAmount: '2400' }] }] } });
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
  // Back to 用款申请单: its own fields return and its budget query is used again.
  const budgets = page.waitForRequest(request => /\/api\/oa\/budgets\?/.test(request.url()));
  await page.locator('#claim-type').selectOption('用款申请单');
  await budgets;
  for (const id of ['#subject-select', '#payee', '#purpose']) await expect(page.locator(id)).toBeAttached();
  await expect(page.locator('#travel')).toBeHidden();
  expect(stub.errors).toEqual([]);
});

test('行程附件: a parsed ticket is previewed, then fills the traveller and the first leg', async ({ page }) => {
  const stub = await openPage(page);
  const ticket = { type: 'train', file: 'g1.pdf', passenger: '教师乙', number: 'G1', date: '2026-07-05', time: '07:00', from: '上海', to: '北京',
    fromStation: '上海虹桥', toStation: '北京南', fare: '553.00', seat: '二等座', invoiceNumber: '26429165818000000001', refund: false };
  const parsed: string[] = [];
  await page.route('**/api/travel/parse', route => { parsed.push(route.request().postDataJSON().name); return route.fulfill({ json: { items: [ticket] } }); });
  await page.route('**/api/travel/itinerary', route => route.fulfill({ json: { itinerary: { groups: [{ passenger: '教师乙', legs: [{
    startDate: '2026-07-05', startAddress: '上海', arriveDate: '2026-07-05', arriveAddress: '北京', vehicle: 'train', trafficExpense: '553.00',
    travelDays: 1, hotelExpense: '', meetingAmount: '', source: 'G1 上海虹桥→北京南（g1.pdf）' }] }], ctripOrders: [], hotels: [], warnings: [] } } }));
  await page.locator('#claim-type').selectOption('境内差旅单');
  await page.setInputFiles('#itinerary-files', { name: 'g1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 test') });
  await expect(page.locator('#itinerary-file-rows')).toContainText('G1 上海虹桥→北京南');
  await expect(page.locator('#itinerary-apply')).toBeEnabled();
  await page.click('#itinerary-apply');
  const card = page.locator('.traveller').first();
  await expect(card.locator('.traveller-head input').first()).toHaveValue('教师乙');
  await expect(card.locator('.traveller-head select').nth(1)).toHaveValue('900002');
  await expect(card.locator('.legs tbody tr').first().locator('td').nth(5).locator('input')).toHaveValue('553.00');
  // The file goes to the local parser once (parsed results are cached) and nowhere else.
  expect(parsed).toEqual(['g1.pdf']);
  expect(stub.posts.some(post => post.path === '/api/oa/travel')).toBe(false);
  expect(stub.errors).toEqual([]);
});
