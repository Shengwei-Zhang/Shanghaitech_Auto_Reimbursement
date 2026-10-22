/** 经费 and 预算项 pickers, shared by every 报销类型; each form names its own budget query (core.js registry). */
import { $, balanceText, api, busy, currentForm, KIND_LABEL, leave, option, pending, state, yuan } from './core.js';

/** One budget query per fund (and form type) per login; it also carries the fund's available balance.
 * 境内差旅单 lists other budget items (国内差旅/参会费), so its query names the type. */
function budgetsOf(code) {
  const path = currentForm()?.budgetsPath ?? '/api/oa/budgets';
  const key = `${path}|${code}`;
  if (!state.budgets.has(key)) {
    state.budgets.set(key, api('GET', `${path}?fundingCode=${encodeURIComponent(code)}`)
      .catch(error => { state.budgets.delete(key); throw error; }));
  }
  return state.budgets.get(key);
}

/** Balance first: long project names are cut off at the right edge of the box. */
const fundText = (fund, balance) => `【${balance === undefined ? '余额查询中…' : balance === null ? '余额查询失败，选中后重试'
  : balance ? `可用 ${balance} 元` : '余额未授权查看'}】${fund.department ? `${fund.label}（${fund.department}）` : fund.label}`;

function setFundBalance(fund, balance) {
  fund.shownBalance = balance;
  paintFundOptions();
}

/** Balances arrive one by one; the search box over the select follows the new option text. */
function paintFundOptions() {
  for (const element of $('fund-select').options) {
    const fund = state.funds.find(item => item.code === element.value);
    if (!fund) continue;
    const text = fundText(fund, Object.hasOwn(fund, 'shownBalance') ? fund.shownBalance : undefined);
    if (element.textContent !== text) element.textContent = text;
  }
}

/** Fills in every listed fund's balance in the background, one query at a time
 * (overlapping budget queries end the BPM session); failures get one retry at the end. */
async function prefetchBalances(funds) {
  const failed = [];
  let expired = false;
  const fill = async (fund, last) => {
    try { setFundBalance(fund, (await budgetsOf(fund.code)).balance); }
    catch (error) {
      if (error.status === 401) expired = true;
      else if (last) setFundBalance(fund, null);
      else failed.push(fund);
    }
  };
  // The chosen fund's budget items always go first; the list balances wait for them.
  const yieldToChoice = () => (state.choosing ? state.choosing.catch(() => undefined) : undefined);
  for (const fund of funds) if (state.funds === funds && !expired) { await yieldToChoice(); await fill(fund, false); }
  for (const fund of failed) if (state.funds === funds && !expired) { await yieldToChoice(); await fill(fund, true); }
  if (expired && state.funds === funds && !$('app').hidden) leave('学校 OA 登录已失效，请重新登录。');
}

async function loadFunds(options = {}) {
  const kind = $('fund-kind').value;
  $('fund-select').disabled = true;
  $('fund-select').replaceChildren(pending(option('', ''), '正在加载…'));
  clearSubjects('请先选择经费');
  const run = () => api('GET', `/api/oa/funds?kind=${encodeURIComponent(kind)}`);
  const result = options.quiet ? await run() : await busy('正在查询经费…', run);
  state.funds = result.items;
  const choices = [
    option('', result.items.length ? `请选择经费（${KIND_LABEL[kind]}共 ${result.items.length} 个）` : `没有${KIND_LABEL[kind]}`),
    ...result.items.map(fund => option(fund.code, fundText(fund)))];
  choices[0].selected = true;
  $('fund-select').replaceChildren(...choices);
  $('fund-select').disabled = !result.items.length;
  if (options.prefetch !== false) prefetchBalances(result.items);
}

function clearSubjects(text) {
  state.subjects = [];
  $('subject-select').replaceChildren(text.endsWith('…') ? pending(option('', ''), text) : option('', text));
  $('subject-select').disabled = true;
  state.fundBalance = '';
  $('balance').textContent = '';
}

/** Budget codes repeat across quotas (04 校内薪酬 / 04 印刷费), so key by quota too. */
const subjectKey = subject => `${subject.quotaCode}:${subject.code}`;
const selectedSubject = () => state.subjects.find(item => subjectKey(item) === $('subject-select').value);
function showBalance() {
  const subject = selectedSubject();
  $('balance').textContent = `经费可用余额：${balanceText(state.fundBalance)}`
    + (subject ? `；预算项可用余额：${balanceText(subject.balance)}（额度：${subject.quotaName}）` : '');
}

async function chooseFund() {
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  clearSubjects(fund ? '正在加载…' : '请先选择经费');
  if (!fund) return;
  const choosing = state.choosing = budgetsOf(fund.code);
  const result = await busy('正在查询预算项…', () => choosing).finally(() => { if (state.choosing === choosing) state.choosing = null; });
  if ($('fund-select').value !== fund.code) return;
  state.subjects = result.subjects;
  $('subject-select').replaceChildren(
    option('', result.subjects.length ? `请选择预算项（共 ${result.subjects.length} 个）` : '该经费没有可选的预算项'),
    ...result.subjects.map(subject => option(subjectKey(subject),
      `${subject.code} ${subject.name}（${subject.quotaName}，可用 ${balanceText(subject.balance)}）`)));
  $('subject-select').disabled = !result.subjects.length;
  state.fundBalance = result.balance;
  setFundBalance(fund, result.balance);
  showBalance();
  currentForm()?.onSubjects?.();
}

/** Re-reads the chosen fund's budget items and balances (a finished job has used some), keeping the choice. */
async function refreshBudgets() {
  state.budgets = new Map();
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  if (!fund) return;
  const subject = $('subject-select').value;
  await chooseFund().catch(() => undefined);
  if ($('fund-select').value === fund.code && state.subjects.some(item => subjectKey(item) === subject)) {
    $('subject-select').value = subject;
    showBalance();
  }
}

export { chooseFund, loadFunds, prefetchBalances, refreshBudgets, selectedSubject, showBalance, subjectKey };
