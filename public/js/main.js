import { $, currentForm, currentType, forms, leave, page, searchable, show, state } from './core.js';
import { initLogin, startLogin } from './login.js';
import { chooseFund, loadFunds, showBalance } from './funding.js';
import { initInvoices, resetInvoices } from './invoices.js';
import { initApplyMoney } from './apply-money.js';
import { initTravel } from './travel.js';
import { initItinerary, resetItinerary } from './itinerary.js';

/** The Easy page (/easy-v2): login, the shared fund picker and invoices, and one module per 报销类型
 * (apply-money.js 用款申请单, travel.js + itinerary.js 境内差旅单) registered in core.js. */

/** The overview panel, the header crumb and the 提交前检查 bar, from the current form's overview(). */
function refreshOverview() {
  const view = currentForm()?.overview?.();
  if (!view) return;
  $('claim-eyebrow').textContent = view.eyebrow;
  $('crumb').textContent = `报销 / ${view.eyebrow.replace(' · ', ' / ')}`;
  $('claim-subtitle').textContent = view.subtitle ?? '';
  $('claim-stats').replaceChildren(...view.stats.map(stat => {
    const box = document.createElement('div');
    box.className = `stat${stat.strong ? ' strong' : ''}`;
    box.append(Object.assign(document.createElement('dt'), { textContent: stat.label }),
      Object.assign(document.createElement('dd'), { textContent: stat.value }));
    if (stat.note) box.append(Object.assign(document.createElement('dd'), { className: 'note', textContent: stat.note }));
    return box;
  }));
  const action = document.querySelector('input[name="action"]:checked');
  const checks = [...view.checks, { label: '完成方式', ok: Boolean(action), detail: action ? action.closest('label').textContent.trim() : '未选择' }];
  const done = checks.filter(check => check.ok).length;
  $('ready-count').textContent = `${done} / ${checks.length}`;
  $('ready-note').textContent = done === checks.length ? '可以提交' : `${checks.length - done} 项未完成`;
  $('ready-checks').replaceChildren(...checks.map(check => {
    const item = document.createElement('li');
    item.className = `check${check.ok ? ' ok' : ''}`;
    item.append(Object.assign(document.createElement('strong'), { textContent: check.label }),
      Object.assign(document.createElement('span'), { textContent: check.detail ?? '' }));
    item.title = check.detail ?? '';
    return item;
  }));
}

let overviewQueued = false;
/** Several inputs change at once (a render, a typed key): refresh once per frame. */
function queueOverview() {
  if (overviewQueued) return;
  overviewQueued = true;
  requestAnimationFrame(() => { overviewQueued = false; refreshOverview(); });
}

/** One button per visible section (the legends), the one in view highlighted; a click scrolls to it. */
function buildSectionNav() {
  const sections = [...$('claim').querySelectorAll(':scope > fieldset')].filter(section => !section.hidden);
  $('section-nav').replaceChildren(...sections.map((section, index) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'seg' });
    button.dataset.target = section.id;
    button.append(Object.assign(document.createElement('span'), { className: 'mono', textContent: String(index + 1).padStart(2, '0') }),
      section.querySelector('legend').textContent);
    button.addEventListener('click', () => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return button;
  }));
  markSection();
}

function markSection() {
  const navBottom = $('section-nav').getBoundingClientRect().bottom;
  const buttons = [...$('section-nav').children];
  let current = buttons[0];
  for (const button of buttons) {
    const section = $(button.dataset.target);
    if (section && section.getBoundingClientRect().top <= navBottom + 24) current = button;
  }
  for (const button of buttons) button.classList.toggle('active', button === current);
}

function tick() {
  $('clock').textContent = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Shows the parts of the form that belong to the chosen 报销类型. */
function applyClaimType() {
  const type = currentType(), form = currentForm();
  for (const element of document.querySelectorAll('[data-claim]')) element.hidden = element.dataset.claim !== type;
  $('claim-title').textContent = form.title;
  $('money-legend').textContent = form.moneyLegend ?? '金额与用途';
  $('claim').dataset.type = form.layout ?? '';
  form.activate?.();
  buildSectionNav();
  queueOverview();
}

/** A fresh claim: every form, the invoices and the 行程附件 start over. */
function resetClaim() {
  $('claim').reset();
  $('claim-error').hidden = true;
  $('live-off').hidden = state.liveEnabled;
  $('submit').disabled = !state.liveEnabled;
  state.budgets = new Map();
  resetInvoices();
  resetItinerary();
  for (const form of forms.values()) form.reset();
  applyClaimType();
  $('claim').hidden = false;
}

/** Login does not wait. Funds go out first; each form's slower lists follow in the background. */
function loadWorkbench() {
  loadFunds({ quiet: true }).catch(error => {
    if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。');
    else show(error.message, true);
  });
  for (const form of forms.values()) form.load?.();
}

document.addEventListener('DOMContentLoaded', () => {
  page.reset = resetClaim;
  page.loadWorkbench = loadWorkbench;
  initLogin();
  $('fund-kind').addEventListener('change', () => loadFunds().catch(() => undefined));
  searchable($('fund-select'), { placeholder: '输入经费编号、名称或部门筛选', empty: '没有匹配的经费' });
  searchable($('subject-select'), { placeholder: '输入预算项编号、名称或额度筛选', empty: '没有匹配的预算项' });
  $('fund-select').addEventListener('change', () => chooseFund().catch(() => undefined).then(() => currentForm()?.onFund?.()));
  $('subject-select').addEventListener('change', showBalance);
  initInvoices();
  initApplyMoney();
  initTravel();
  initItinerary();
  $('claim').addEventListener('submit', event => { event.preventDefault(); currentForm().submit(); });
  $('claim-type').addEventListener('change', () => {
    $('claim-error').hidden = true;
    applyClaimType();
    state.budgets = new Map();
    chooseFund().catch(() => undefined).then(() => currentForm()?.onFund?.());
    currentForm()?.onSelect?.();
  });
  $('claim-new').addEventListener('click', () => {
    show('');
    resetClaim();
    loadWorkbench();
  });
  // Fields change by typing, by picking and by renders the forms do themselves (balances, OA lookups).
  for (const type of ['input', 'change', 'click']) $('claim').addEventListener(type, queueOverview);
  // The overview, the section nav and the checks are written by refreshOverview itself: not a change to react to.
  const own = node => Boolean(node.closest?.('.overview, #section-nav, #ready-checks, .ready') ?? node.parentElement?.closest('.overview, #section-nav, #ready-checks, .ready'));
  new MutationObserver(records => { if (records.some(record => !own(record.target))) queueOverview(); })
    .observe($('claim'), { childList: true, subtree: true });
  window.addEventListener('scroll', () => requestAnimationFrame(markSection), { passive: true });
  tick();
  setInterval(tick, 30_000);
  startLogin();
});
