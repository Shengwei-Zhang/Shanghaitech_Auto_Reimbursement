/** 境内差旅单: drafts, travellers and legs, 携程 write-offs, 经费明细, 收款人, the run's progress. */
import { $, balanceText, api, busy, cents, forms, leave, NEW_FORM, option, pending, PERSON_CODE, registerForm, rowButton, searchable, show, showProblems, state, toast, yuan } from './core.js';
import { refreshBudgets, subjectKey } from './funding.js';
import { assessInvoices, invoiceTotal, renderInvoices } from './invoices.js';

/* ---------- 境内差旅单: travellers and legs, saved over HTTP, never submitted ---------- */
const TRAVEL = '境内差旅单';
const TRAVELLER_KINDS = { staff: '教工', student: '学生' };
/** 每日补贴标准, yuan: what OA returned for 教工/学生 travellers on D209900000038 (2026-10-21). OA states a
 * traveller's rate only once the traveller is saved on a form, so the page shows these; the fill uses
 * and checks OA's own rate. */
const SUBSIDY_RATES = { staff: 180, student: 100 };
const standardSubsidy = (traveller, leg) => {
  const days = Number(leg.travelDays);
  return Number.isInteger(days) && days > 0 ? SUBSIDY_RATES[traveller.kind] * days * 100 : 0;
};
const VEHICLES = { aircraft: '飞机', train: '火车', car: '汽车', other: '其他' };
const MONEY = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const TRAVEL_STATUS = { running: ['执行中', ''], completed: ['已保存，未提交', ''], submitted: ['已提交并核验', ''],
  needs_review: ['已结束，请在 OA 核对', 'warn'], failed: ['失败', 'bad'], cancelled: ['已停止', 'bad'] };
const isTravel = () => $('claim-type')?.value === TRAVEL;
const blankLeg = () => ({ startDate: '', startAddress: '', arriveDate: '', arriveAddress: '', vehicle: 'train', trafficExpense: '',
  travelDays: '', subsidyAmount: '', hotelExpense: '', meetingAmount: '', otherAmount: '' });
/** `matches`: OA's people for the typed name — null (not looked up), 'loading', an error text, or the list. */
const blankTraveller = () => ({ kind: 'staff', code: '', name: '', matches: null, legs: [blankLeg()] });

/** 出差人 are found by name in OA (教工 / 学生 lists, as the OA dialog does); the 学号/工号 is picked from the result. */
function lookupTraveller(traveller, paint) {
  clearTimeout(traveller.timer);
  traveller.code = '';
  const name = traveller.name.trim();
  traveller.matches = name ? 'loading' : null;
  paint();
  if (!name) return;
  const seq = traveller.seq = (traveller.seq || 0) + 1;
  traveller.timer = setTimeout(async () => {
    try {
      const { people } = await api('GET', `/api/oa/travel/people?kind=${traveller.kind}&name=${encodeURIComponent(name)}`);
      if (seq !== traveller.seq) return;
      traveller.matches = people;
      // One match is the person; several (namesakes) wait for a choice.
      if (people.length === 1) { traveller.code = people[0].code; traveller.name = people[0].name; syncPayeeCode(); }
    } catch (error) {
      if (seq !== traveller.seq) return;
      if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
      traveller.matches = `查询失败：${error.message}`;
    }
    paint();
  }, 400);
}

function resetTravel() {
  if (!$('travel')) return;
  state.travellers = [blankTraveller()];
  state.ctrip = { fund: '', borrows: [], picked: [] };
  resetMoney();
  $('travel-form-select').replaceChildren(option(NEW_FORM, '＋ 新建境内差旅单'));
  $('ctrip-select').replaceChildren(option('', '请先选择经费'));
  $('ctrip-select').disabled = true;
  renderCtripPicked();
  $('travel-explain').value = '';
  renderTravellers();
}

/** The input of each traveller, leg, line and payee field, so a problem can point at it: fieldOf(leg, 'travelDays'). */
const fields = new WeakMap();
const keep = (row, key, element) => { if (!fields.has(row)) fields.set(row, {}); fields.get(row)[key] = element; return element; };
const fieldOf = (row, key) => fields.get(row)?.[key];
/** A problem for showProblems, with the field(s) to fix. */
const at = (text, ...field) => ({ text, field });

function travelInputCell(leg, key, attrs = {}, onInput) {
  const td = document.createElement('td');
  const input = keep(leg, key, document.createElement('input'));
  Object.assign(input, attrs);
  input.value = leg[key];
  input.addEventListener('input', () => { leg[key] = input.value; onInput?.(); showTravelTotal(); });
  td.append(input);
  return td;
}

/** Rebuilt on add/remove only, so typing keeps focus. */
function renderTravellers() {
  $('travellers').replaceChildren(...state.travellers.map((traveller, index) => {
    const card = document.createElement('div');
    card.className = 'traveller';
    const head = document.createElement('div');
    head.className = 'traveller-head';
    const kind = document.createElement('select');
    kind.append(...Object.entries(TRAVELLER_KINDS).map(([value, text]) => option(value, text)));
    kind.value = traveller.kind;
    const field = (label, element) => { const wrap = document.createElement('label'); wrap.className = 'field'; wrap.append(label, element); return wrap; };
    const name = Object.assign(document.createElement('input'), { maxLength: 30, autocomplete: 'off', value: traveller.name, placeholder: '输入姓名，在 OA 中查找' });
    const pick = document.createElement('select');
    const note = document.createElement('p');
    note.className = 'hint small';
    const rate = Object.assign(document.createElement('output'), { className: 'subsidy-rate' });
    // 实际补贴 cells of this card show their standard as placeholder; days and 类别 change it.
    const subsidyCells = [];
    const paintSubsidies = () => {
      rate.textContent = `${SUBSIDY_RATES[traveller.kind]} 元/天`;
      for (const { leg, input } of subsidyCells) {
        const standard = standardSubsidy(traveller, leg);
        input.placeholder = standard ? `标准 ${(standard / 100).toFixed(2)}` : '无补贴';
        input.title = `${TRAVELLER_KINDS[traveller.kind]} ${SUBSIDY_RATES[traveller.kind]} 元/天 × ${Number(leg.travelDays) || 0} 天；留空即按标准，可改小不可超过`;
      }
    };
    const paint = () => {
      const { matches } = traveller;
      const label = item => `${item.code}　${item.name}${item.dept ? `　${item.dept}` : ''}`;
      if (Array.isArray(matches) && matches.length) {
        pick.replaceChildren(option('', `请选择（OA 中有 ${matches.length} 人）`), ...matches.map(item => option(item.code, label(item))));
        pick.value = traveller.code;
      } else if (Array.isArray(matches)) pick.replaceChildren(option('', `OA ${TRAVELLER_KINDS[traveller.kind]}中没有“${traveller.name.trim()}”`));
      else if (matches === 'loading') pick.replaceChildren(pending(option('', ''), '正在 OA 中查找…'));
      else pick.replaceChildren(option('', matches || '先输入姓名'));
      pick.disabled = !Array.isArray(matches) || !matches.length;
      if (name.value !== traveller.name && document.activeElement !== name) name.value = traveller.name;
      note.textContent = `出差人 ${index + 1}：`
        + (Array.isArray(matches) && matches.length > 1 && !traveller.code ? '有同名人员，请按学号/工号和部门选择。' : '按姓名在 OA 中查找后选择学号/工号。')
        + '实际补贴留空即按标准 × 天数，保存时以 OA 返回的标准为准。';
      paintSubsidies();
    };
    name.addEventListener('input', () => { traveller.name = name.value; lookupTraveller(traveller, paint); });
    kind.addEventListener('change', () => { traveller.kind = kind.value; lookupTraveller(traveller, paint); showTravelTotal(); });
    pick.addEventListener('change', () => {
      traveller.code = pick.value;
      const match = Array.isArray(traveller.matches) ? traveller.matches.find(item => item.code === pick.value) : undefined;
      if (match) { traveller.name = match.name; name.value = match.name; }
      syncPayeeCode();
    });
    paint();
    keep(traveller, 'name', name); keep(traveller, 'code', pick);
    head.append(field('类别', kind), field('补贴标准', rate), field('姓名', name), field('学号 / 工号', pick), note,
      rowButton('删除出差人', () => { state.travellers.splice(index, 1); if (!state.travellers.length) state.travellers.push(blankTraveller()); renderTravellers(); }, 'danger'));
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'invoices legs';
    const headRow = document.createElement('tr');
    headRow.append(...['启程日期', '出发地', '到达日期', '目的地', '交通工具', '交通费', '天数', '实际补贴', '住宿费', '会务/注册费', '其他', '']
      .map(label => { const th = document.createElement('th'); th.textContent = label; return th; }));
    const thead = document.createElement('thead');
    thead.append(headRow);
    const body = document.createElement('tbody');
    body.append(...traveller.legs.map((leg, legIndex) => {
      const row = document.createElement('tr');
      const vehicle = document.createElement('select');
      vehicle.append(...Object.entries(VEHICLES).map(([value, label]) => option(value, label)));
      vehicle.value = leg.vehicle;
      vehicle.addEventListener('change', () => { leg.vehicle = vehicle.value; });
      const vehicleCell = document.createElement('td');
      vehicleCell.append(vehicle);
      const remove = document.createElement('td');
      remove.className = 'actions';
      remove.append(rowButton('删除', () => { traveller.legs.splice(legIndex, 1); renderTravellers(); }, 'danger'));
      const money = { inputMode: 'decimal' };
      const subsidyCell = travelInputCell(leg, 'subsidyAmount', { inputMode: 'decimal' });
      subsidyCells.push({ leg, input: subsidyCell.firstChild });
      row.append(travelInputCell(leg, 'startDate', { type: 'date' }), travelInputCell(leg, 'startAddress', { maxLength: 32 }),
        travelInputCell(leg, 'arriveDate', { type: 'date' }), travelInputCell(leg, 'arriveAddress', { maxLength: 32 }), vehicleCell,
        travelInputCell(leg, 'trafficExpense', { ...money, placeholder: '0' }),
        travelInputCell(leg, 'travelDays', { inputMode: 'numeric', placeholder: '0' }, paintSubsidies),
        subsidyCell, travelInputCell(leg, 'hotelExpense', money),
        travelInputCell(leg, 'meetingAmount', money), travelInputCell(leg, 'otherAmount', money), remove);
      return row;
    }));
    table.append(thead, body);
    scroll.append(table);
    const add = document.createElement('div');
    add.className = 'travel-actions';
    add.append(Object.assign(document.createElement('button'), { type: 'button', className: 'add', textContent: '＋ 添加行程',
      onclick: () => { const last = traveller.legs[traveller.legs.length - 1];
        // The next leg usually starts where the last one ended.
        traveller.legs.push({ ...blankLeg(), startAddress: last?.arriveAddress ?? '', startDate: last?.arriveDate ?? '', vehicle: last?.vehicle ?? 'train' });
        renderTravellers(); } }));
    card.append(head, traveller.legs.length ? scroll : '', add);
    paintSubsidies();
    return card;
  }));
  showTravelTotal();
  syncPayeeCode();
}

const ctripOrders = () => state.ctrip.picked.map(item => item.order);
const borrowText = item => `${item.order}　${item.date}　${item.personName}　未清 ${item.outstanding} 元　${item.remark}`;

let travelFormsSeq = 0;
/** Blank 境内差旅单 drafts from 报销单查询 (预制, nothing saved); the fill re-checks before writing. */
async function loadTravelForms(selected) {
  const seq = ++travelFormsSeq, select = $('travel-form-select');
  select.replaceChildren(option(NEW_FORM, '＋ 新建境内差旅单'), Object.assign(pending(option('', ''), '正在查找空白差旅单…'), { disabled: true }));
  select.value = NEW_FORM;
  try {
    const { forms } = await api('GET', '/api/oa/travel/forms');
    if (seq !== travelFormsSeq) return;
    select.replaceChildren(option(NEW_FORM, '＋ 新建境内差旅单'),
      ...forms.map(item => option(item.documentNumber, `${item.documentNumber}（${item.date} 创建的空白差旅单）`)));
    select.value = forms.some(item => item.documentNumber === selected) ? selected : NEW_FORM;
  } catch (error) {
    if (seq !== travelFormsSeq) return;
    if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
    select.replaceChildren(option(NEW_FORM, '＋ 新建境内差旅单'), Object.assign(option('', `空白差旅单查询失败：${error.message}`), { disabled: true }));
    select.value = NEW_FORM;
  }
}

let borrowSeq = 0;
/** 携程借款单 are listed per fund; a new fund drops the loans picked under the old one. */
async function loadBorrows() {
  if (!isTravel()) return;
  const code = $('fund-select').value, seq = ++borrowSeq;
  if (code !== state.ctrip.fund) { state.ctrip = { fund: code, borrows: [], picked: [] }; renderCtripPicked(); }
  const select = $('ctrip-select');
  select.disabled = true;
  if (!code) return select.replaceChildren(option('', '请先选择经费'));
  select.replaceChildren(pending(option('', ''), '正在查询携程借款单…'));
  try {
    const { borrows } = await api('GET', `/api/oa/travel/borrows?fundingCode=${encodeURIComponent(code)}`);
    if (seq !== borrowSeq) return;
    state.ctrip.borrows = borrows;
    paintBorrows();
    // The 票据 module picks the loans of the flights it read.
    document.dispatchEvent(new CustomEvent('ctrip-borrows'));
  } catch (error) {
    if (seq !== borrowSeq) return;
    if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
    select.replaceChildren(option('', `携程借款单查询失败：${error.message}`));
  }
}

/** Picked loans stay listed but cannot be picked twice. */
function paintBorrows() {
  const { borrows, picked } = state.ctrip;
  const select = $('ctrip-select');
  select.replaceChildren(option('', borrows.length ? `选择要冲销的携程借款单（共 ${borrows.length} 张，可输入订单号、摘要或借款人筛选）` : '该经费下没有未清的携程借款单'),
    ...borrows.map(item => Object.assign(option(item.order, borrowText(item)), { disabled: picked.some(chosen => chosen.order === item.order) })));
  select.value = '';
  select.disabled = !borrows.length;
}

function renderCtripPicked() {
  const box = $('ctrip-picked');
  box.hidden = !state.ctrip.picked.length;
  box.replaceChildren(...state.ctrip.picked.map(item => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = borrowText(item);
    chip.append(`${item.order}　${item.personName}　${item.outstanding} 元　${item.remark}`, rowButton('×', () => {
      state.ctrip.picked = state.ctrip.picked.filter(chosen => chosen !== item);
      renderCtripPicked();
      paintBorrows();
    }));
    return chip;
  }));
  if (state.travellers) showTravelTotal();
}

function pickBorrow() {
  const item = state.ctrip.borrows.find(borrow => borrow.order === $('ctrip-select').value);
  if (!item || state.ctrip.picked.includes(item)) return;
  state.ctrip.picked.push(item);
  renderCtripPicked();
  paintBorrows();
}
const legCents = value => (String(value).trim() ? cents(String(value).trim()) : 0);

/** The trip total as OA will compute it, with blank 实际补贴 at the standard rate. */
function showTravelTotal() {
  const { trip, subsidies, reverse, payment } = travelEstimate();
  $('travel-total').textContent = `差旅合计约 ${yuanOf(trip)} 元（其中补贴 ${yuanOf(subsidies)} 元，按教工 ${SUBSIDY_RATES.staff}、学生 ${SUBSIDY_RATES.student} 元/天计算）。`
    + `${reverse ? `携程冲账 ${state.ctrip.picked.length} 张共 ${yuanOf(reverse)} 元，` : ''}应付收款人约 ${yuanOf(payment)} 元。`;
  showMoneyTotals();
}

/* ---------- 经费明细 and 收款人 of a 境内差旅单: several 支出项目 and payees; one of each may take the rest ---------- */
const blankLine = () => ({ subject: '', amount: '', purpose: '' });
/** autoCode: the code the page filled in (the login, then the first traveller found); while the code is still it, or
 * empty, it follows the travellers. Typing another one keeps that. */
const blankPayee = (code = '') => ({ code, autoCode: code, traveller: '', amount: '', supplierCode: '', remitPurpose: '', suppliers: null, seq: 0 });

/** The first payee is the first traveller found in OA (学号/工号, paid to their card), unless the user typed another. */
function syncPayeeCode() {
  const payee = state.payees?.[0];
  const traveller = state.travellers?.find(item => item.code.trim());
  if (!payee || !traveller || (payee.code.trim() && payee.code.trim() !== payee.autoCode)) return;
  const code = traveller.code.trim();
  if (payee.code === code && payee.traveller === traveller.name.trim()) return;
  Object.assign(payee, { code, autoCode: code, traveller: traveller.name.trim(), suppliers: null, supplierCode: '' });
  renderPayees();
}
const yuanOf = value => (value / 100).toFixed(2);

function resetMoney() {
  state.lines = [blankLine()];
  state.payees = [blankPayee(state.account || '')];
  renderLines();
  renderPayees();
}

/** The trip as the page can estimate it: blank 实际补贴 at the standard rate, write-offs at their balance. */
function travelEstimate() {
  let trip = 0, subsidies = 0;
  for (const traveller of state.travellers ?? []) {
    for (const leg of traveller.legs) {
      for (const key of ['trafficExpense', 'hotelExpense', 'meetingAmount', 'otherAmount']) trip += legCents(leg[key]) ?? 0;
      const subsidy = String(leg.subsidyAmount).trim() ? legCents(leg.subsidyAmount) ?? 0 : standardSubsidy(traveller, leg);
      subsidies += subsidy;
      trip += subsidy;
    }
  }
  const reverse = (state.ctrip?.picked ?? []).reduce((sum, item) => sum + (cents(item.outstanding) ?? 0), 0);
  return { trip, subsidies, reverse, payment: Math.max(0, trip - reverse) };
}

/** Rows given an amount, the rest left to the one blank row; null when they cannot add up to `total`. */
function split(rows, total) {
  const given = rows.filter(row => String(row.amount).trim());
  const sum = given.reduce((acc, row) => acc + (cents(String(row.amount).trim()) ?? NaN), 0);
  const blanks = rows.length - given.length;
  const rest = total - sum;
  return { sum, blanks, rest, ok: Number.isFinite(sum) && blanks <= 1 && (blanks ? rest > 0 : rest === 0) };
}

/** An amount the user types; left empty, it is the row paintAuto fills in. */
function autoAmountInput(row, placeholder) {
  const input = Object.assign(document.createElement('input'), { className: 'num', inputMode: 'decimal', value: row.amount, placeholder });
  input.dataset.placeholder = placeholder;
  input.addEventListener('input', () => { row.amount = input.value; showMoneyTotals(); });
  // An automatic amount is selected on focus, so typing replaces it.
  input.addEventListener('focus', () => { if (!String(row.amount).trim()) input.select(); });
  input.addEventListener('blur', showMoneyTotals);
  return keep(row, 'amount', input);
}

/** The one row left empty shows what it takes: `total` less the other rows. Its amount stays '' and is sent so,
 * so the run takes the rest of OA's own total (this one is the page's estimate); typing a value makes it manual. */
function paintAuto(rows, total) {
  const typed = row => String(row.amount).trim();
  // The first empty row takes the rest; a row added after it waits for its own amount (so adding one never empties the first).
  const autoRow = rows.find(row => !typed(row));
  const rest = total - rows.reduce((sum, row) => sum + (typed(row) ? cents(typed(row)) ?? 0 : 0), 0);
  for (const row of rows) {
    const input = fieldOf(row, 'amount');
    // The field being edited is left alone; it is painted again on blur.
    if (!input || document.activeElement === input || typed(row)) { input?.classList.remove('auto'); continue; }
    const auto = row === autoRow && rest > 0;
    input.classList.toggle('auto', auto);
    input.value = auto ? yuanOf(rest) : '';
    input.placeholder = row === autoRow ? input.dataset.placeholder : '填写金额';
    input.title = auto ? '自动填入：总额减去其他行，按页面估算，保存时以 OA 算出的差旅合计为准；输入金额即改为手填，清空恢复自动' : '';
  }
}

/** Empty rows after the first: each still needs its amount (the first empty one takes the rest). */
const unfilled = rows => rows.filter(row => !String(row.amount).trim()).slice(1);

function renderLines() {
  if (!$('line-rows')) return;
  const subjects = state.subjects ?? [];
  // The first line defaults to the usual 差旅 item.
  if (state.lines.length === 1 && !state.lines[0].subject) {
    const usual = subjects.find(item => item.name === '国内差旅/参会费');
    if (usual) state.lines[0].subject = subjectKey(usual);
  }
  $('line-rows').replaceChildren(...state.lines.map((line, index) => {
    const tr = document.createElement('tr');
    const select = document.createElement('select');
    select.append(option('', subjects.length ? '请选择预算项' : '请先选择经费'),
      ...subjects.map(item => Object.assign(option(subjectKey(item), `${item.code} ${item.name}（${item.quotaName}，可用 ${balanceText(item.balance)}）`),
        { disabled: state.lines.some((other, at) => at !== index && other.subject === subjectKey(item)) })));
    select.value = subjects.some(item => subjectKey(item) === line.subject) ? line.subject : '';
    if (!select.value) line.subject = '';
    select.disabled = !subjects.length;
    select.addEventListener('change', () => { line.subject = select.value; renderLines(); });
    keep(line, 'subject', select);
    const amount = autoAmountInput(line, state.lines.length > 1 ? '留空 = 剩余' : '留空 = 差旅合计');
    const purpose = Object.assign(document.createElement('input'), { maxLength: 200, value: line.purpose, placeholder: '例如：参加 2026 中国图像图形大会' });
    purpose.addEventListener('input', () => { line.purpose = purpose.value; });
    keep(line, 'purpose', purpose);
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (state.lines.length > 1) actions.append(rowButton('删除', () => { state.lines.splice(index, 1); renderLines(); }, 'danger'));
    tr.append(...[select, amount, purpose].map(element => { const td = document.createElement('td'); td.append(element); return td; }), actions);
    return tr;
  }));
  $('line-add').disabled = state.lines.length >= Math.min(10, subjects.length || 1);
  showMoneyTotals();
}

const payeeIsCard = payee => PERSON_CODE.test(payee.code.trim());

/** 银行汇款 accounts come from OA's supplier register by exact account name, as for 用款申请单. */
function lookupSuppliers(payee) {
  const name = payee.code.trim();
  const seq = ++payee.seq;
  payee.suppliers = name.length >= 2 ? 'loading' : null;
  clearTimeout(payee.timer);
  if (name.length < 2) return renderPayees();
  payee.timer = setTimeout(async () => {
    try {
      const { suppliers } = await api('GET', `/api/oa/payees?name=${encodeURIComponent(name)}`);
      if (seq !== payee.seq) return;
      payee.suppliers = suppliers;
      if (suppliers.length === 1) payee.supplierCode = suppliers[0].supplierCode;
      else if (!suppliers.some(item => item.supplierCode === payee.supplierCode)) payee.supplierCode = '';
    } catch (error) {
      if (seq !== payee.seq) return;
      if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
      payee.suppliers = `查询失败：${error.message}`;
    }
    renderPayees();
  }, 500);
}

function renderPayees() {
  if (!$('payee-rows')) return;
  $('payee-rows').replaceChildren(...state.payees.map((payee, index) => {
    const tr = document.createElement('tr');
    const code = Object.assign(document.createElement('input'), { maxLength: 100, autocomplete: 'off', value: payee.code,
      placeholder: '学号/工号：个人银行卡；单位户名：银行汇款' });
    code.addEventListener('change', () => {
      payee.code = code.value;
      if (payeeIsCard(payee)) { payee.suppliers = null; payee.supplierCode = ''; renderPayees(); } else lookupSuppliers(payee);
    });
    code.addEventListener('input', () => { payee.code = code.value; });
    keep(payee, 'code', code);
    const who = document.createElement('div');
    who.className = 'stack';
    who.append(code);
    const followed = payee.traveller && payee.code.trim() === payee.autoCode;
    code.classList.toggle('auto', Boolean(followed));
    if (followed) who.append(Object.assign(document.createElement('span'), { className: 'note', textContent: `按出差人 ${payee.traveller} 自动填入，可改为其他学号/工号或户名。` }));
    if (payee.code.trim() && payeeIsCard(payee)) {
      who.append(Object.assign(document.createElement('span'), { className: 'note', textContent: '个人银行卡：保存时按学号/工号在 OA 中查询姓名和卡号。' }));
    }
    // The transfer account and purpose only for a 银行汇款 (a name that is not a 学号/工号), at the right.
    const account = document.createElement('div');
    account.className = 'stack';
    if (payee.code.trim() && !payeeIsCard(payee)) {
      const select = document.createElement('select');
      const list = payee.suppliers;
      if (Array.isArray(list) && list.length) {
        select.append(option('', list.length > 1 ? `请选择收款账户（共 ${list.length} 个）` : '请选择收款账户'),
          ...list.map(item => option(item.supplierCode, `${item.bank} ${item.account}（供应商编码 ${item.supplierCode}${item.main ? '' : '，非主数据'}）`)));
        select.value = payee.supplierCode;
      } else if (Array.isArray(list)) select.append(option('', `OA 供应商中没有户名为“${payee.code.trim()}”的银行账户`));
      else if (list === 'loading') select.append(pending(option('', ''), '正在 OA 供应商中查找…'));
      else select.append(option('', list || '户名至少 2 个字符'));
      select.disabled = !Array.isArray(list) || !list.length;
      select.addEventListener('change', () => { payee.supplierCode = select.value; });
      keep(payee, 'supplierCode', select);
      const purpose = Object.assign(document.createElement('input'), { maxLength: 100, value: payee.remitPurpose, placeholder: '汇款用途，例如：会议注册费' });
      purpose.addEventListener('input', () => { payee.remitPurpose = purpose.value; });
      keep(payee, 'remitPurpose', purpose);
      account.append(select, purpose);
    }
    const amount = autoAmountInput(payee, state.payees.length > 1 ? '留空 = 剩余' : '留空 = 应付全额');
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (state.payees.length > 1) actions.append(rowButton('删除', () => { state.payees.splice(index, 1); renderPayees(); }, 'danger'));
    tr.append(...[who, amount, account].map(element => { const td = document.createElement('td'); td.append(element); return td; }), actions);
    return tr;
  }));
  $('payee-account-head').textContent = state.payees.some(payee => payee.code.trim() && !payeeIsCard(payee)) ? '银行转账账户与汇款用途' : '';
  $('payee-add').disabled = state.payees.length >= 10;
  showMoneyTotals();
}

/** Whether the lines add up to the trip and the payees to what is left after the write-offs. */
function showMoneyTotals() {
  if (!$('line-total') || !state.lines || !state.payees) return;
  const { trip, payment, reverse } = travelEstimate();
  const lines = split(state.lines, trip), payees = split(state.payees, payment);
  paintAuto(state.lines, trip);
  paintAuto(state.payees, payment);
  const say = (element, text, ok) => { element.textContent = text; element.className = `hint small${ok ? '' : ' error'}`; };
  say($('line-total'), `经费明细合计须等于差旅合计（约 ${yuanOf(trip)} 元）。`
    + (lines.blanks ? `已填 ${yuanOf(lines.sum)} 元，自动填入的一行约 ${yuanOf(lines.rest)} 元（以 OA 算出的差旅合计为准）。`
      : `已填 ${yuanOf(lines.sum)} 元${lines.ok ? '。' : `，相差 ${yuanOf(Math.abs(lines.rest))} 元；可把其中一行留空，自动取剩余。`}`)
    + (lines.blanks > 1 ? `第 ${unfilled(state.lines).map(row => state.lines.indexOf(row) + 1).join('、')} 行还没有金额：填写后，自动填入的一行随之减少。` : ''), lines.ok || !trip);
  say($('payee-total'), `收款人合计须等于差旅合计减去携程冲账（约 ${yuanOf(payment)} 元${reverse ? `，已冲账 ${yuanOf(reverse)} 元` : ''}）。`
    + (payees.blanks ? `已填 ${yuanOf(payees.sum)} 元，自动填入的一位约 ${yuanOf(Math.max(0, payees.rest))} 元。`
      : `已填 ${yuanOf(payees.sum)} 元${payees.ok ? '。' : `，相差 ${yuanOf(Math.abs(payees.rest))} 元。`}`)
    + (payees.blanks > 1 ? `第 ${unfilled(state.payees).map(row => state.payees.indexOf(row) + 1).join('、')} 位还没有金额：填写后，自动填入的一位随之减少。` : ''),
    payees.ok || !trip || (payees.blanks === 1 && payees.rest === 0));
}

/** The page's lines and payees as the API takes them, or the problems found. */
function collectMoney(problems) {
  const subjects = state.subjects ?? [];
  const lines = state.lines.map((line, index) => {
    const subject = subjects.find(item => subjectKey(item) === line.subject);
    const where = `经费明细第 ${index + 1} 行`;
    if (!subject) problems.push(at(`${where}：请选择预算项。`, fieldOf(line, 'subject')));
    else if (subjects.some(item => item !== subject && item.name === subject.name)) problems.push(at(`${where}：预算项名称“${subject.name}”不唯一，程序无法唯一定位。`, fieldOf(line, 'subject')));
    if (String(line.amount).trim() && (!MONEY.test(String(line.amount).trim()) || !(cents(String(line.amount).trim()) > 0))) problems.push(at(`${where}：金额须为正数，最多两位小数。`, fieldOf(line, 'amount')));
    else if (subject && cents(subject.balance) !== null && cents(String(line.amount).trim()) > cents(subject.balance)) problems.push(at(`${where}：金额超过预算项可用余额 ${subject.balance} 元。`, fieldOf(line, 'amount')));
    if (!line.purpose.trim()) problems.push(at(`${where}：请填写用途。`, fieldOf(line, 'purpose')));
    return { budgetName: subject?.name ?? '', amount: String(line.amount).trim(), purpose: line.purpose.trim() };
  });
  const { trip, payment } = travelEstimate();
  const lineSplit = split(state.lines, trip), payeeSplit = split(state.payees, payment);
  const lineAmounts = state.lines.map(line => fieldOf(line, 'amount'));
  if (lineSplit.blanks > 1) for (const line of unfilled(state.lines)) problems.push(at(`经费明细第 ${state.lines.indexOf(line) + 1} 行：请填写金额（留空的第一行自动取剩余）。`, fieldOf(line, 'amount')));
  else if (trip && !lineSplit.ok) problems.push(at(`经费明细合计须等于差旅合计（约 ${yuanOf(trip)} 元）；可把其中一行金额留空，自动取剩余。`, ...lineAmounts));
  const payees = state.payees.filter(payee => payee.code.trim() || String(payee.amount).trim()).map((payee, index) => {
    const where = `收款人第 ${index + 1} 位`;
    if (!payee.code.trim()) problems.push(at(`${where}：请填写学号、工号或银行转账户名。`, fieldOf(payee, 'code')));
    else if (!payeeIsCard(payee)) {
      if (payee.code.trim().length < 2) problems.push(at(`${where}：银行转账户名至少 2 个字符。`, fieldOf(payee, 'code')));
      else if (!payee.supplierCode) problems.push(at(`${where}：请选择 OA 供应商中的收款账户。`, fieldOf(payee, 'supplierCode')));
      if (!payee.remitPurpose.trim()) problems.push(at(`${where}：请填写汇款用途。`, fieldOf(payee, 'remitPurpose')));
    }
    if (String(payee.amount).trim() && (!MONEY.test(String(payee.amount).trim()) || !(cents(String(payee.amount).trim()) > 0))) problems.push(at(`${where}：金额须为正数，最多两位小数。`, fieldOf(payee, 'amount')));
    return payeeIsCard(payee) ? { kind: 'card', code: payee.code.trim(), amount: String(payee.amount).trim() }
      : { kind: 'bank', code: payee.code.trim(), supplierCode: payee.supplierCode, remitPurpose: payee.remitPurpose.trim(), amount: String(payee.amount).trim() };
  });
  const payeeAmounts = state.payees.map(payee => fieldOf(payee, 'amount'));
  if (payeeSplit.blanks > 1) for (const payee of unfilled(state.payees)) problems.push(at(`收款人第 ${state.payees.indexOf(payee) + 1} 位：请填写金额（留空的第一位自动取剩余）。`, fieldOf(payee, 'amount')));
  else if (payment && !payees.length) problems.push(at('请填写收款人。', fieldOf(state.payees[0], 'code')));
  else if (payment && !(payeeSplit.ok || (payeeSplit.blanks === 1 && payeeSplit.rest === 0))) {
    problems.push(at(`收款人合计须等于差旅合计减去携程冲账（约 ${yuanOf(payment)} 元）；可把其中一位金额留空，自动取剩余。`, ...payeeAmounts));
  }
  if (new Set(payees.map(payee => `${payee.kind}|${payee.code}|${payee.supplierCode ?? ''}`)).size !== payees.length) problems.push(at('收款人有重复。', ...state.payees.map(payee => fieldOf(payee, 'code'))));
  return { lines, payees };
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** Calendar days of a traveller's whole trip, first start to last arrival, both counted. */
const tripDays = legs => daysBetween([...legs.map(leg => leg.startDate)].sort()[0], [...legs.map(leg => leg.arriveDate)].sort().at(-1)) + 1;

function collectTravel() {
  const problems = [];
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  const attachments = Number($('attachments').value);
  if (!fund) problems.push(at('请选择经费。', 'fund-select'));
  const codes = new Set();
  let legs = 0;
  state.travellers.forEach((traveller, index) => {
    const who = `出差人 ${index + 1}${traveller.name.trim() ? `（${traveller.name.trim()}）` : ''}`;
    if (!traveller.name.trim()) problems.push(at(`${who}：请输入姓名并在 OA 中查找。`, fieldOf(traveller, 'name')));
    else if (!/^[A-Za-z0-9]{2,32}$/.test(traveller.code.trim())) problems.push(at(`${who}：请在查找结果中选择学号/工号。`, fieldOf(traveller, 'code')));
    else if (codes.has(traveller.code.trim())) problems.push(at(`${who}：学号/工号与其他出差人重复。`, fieldOf(traveller, 'code')));
    codes.add(traveller.code.trim());
    traveller.legs.forEach((leg, legIndex) => {
      legs++;
      const where = `${who}第 ${legIndex + 1} 段行程`;
      const field = key => fieldOf(leg, key);
      const days = leg.travelDays === '' ? NaN : Number(leg.travelDays);
      if (!Number.isInteger(days) || days < 0 || days > 999) problems.push(at(`${where}：差旅天数须为 0–999 的整数。`, field('travelDays')));
      if (!leg.startDate || !leg.arriveDate) {
        problems.push(at(`${where}：请填写启程和到达日期。`, ...['startDate', 'arriveDate'].filter(key => !leg[key]).map(field)));
      } else if (daysBetween(leg.startDate, leg.arriveDate) < 0) problems.push(at(`${where}：到达日期早于启程日期。`, field('arriveDate')));
      if (!leg.startAddress.trim() || !leg.arriveAddress.trim()) {
        problems.push(at(`${where}：请填写出发地和目的地。`, ...['startAddress', 'arriveAddress'].filter(key => !leg[key].trim()).map(field)));
      }
      if (!MONEY.test(leg.trafficExpense.trim())) problems.push(at(`${where}：交通费须为金额（没有填 0）。`, field('trafficExpense')));
      for (const [key, label] of [['subsidyAmount', '实际补贴'], ['hotelExpense', '住宿费'], ['meetingAmount', '会务/注册费'], ['otherAmount', '其他']]) {
        if (String(leg[key]).trim() && !MONEY.test(String(leg[key]).trim())) problems.push(at(`${where}：${label}须为金额。`, field(key)));
      }
      const standard = standardSubsidy(traveller, leg), actual = legCents(leg.subsidyAmount);
      if (String(leg.subsidyAmount).trim() && actual !== null && actual > standard) {
        problems.push(at(`${where}：实际补贴 ${leg.subsidyAmount} 元高于标准 ${(standard / 100).toFixed(2)} 元（${TRAVELLER_KINDS[traveller.kind]} ${SUBSIDY_RATES[traveller.kind]} 元/天 × ${Number(leg.travelDays) || 0} 天）。`, field('subsidyAmount')));
      }
    });
    // 差旅天数 are checked for the whole trip only: together they equal first start to last arrival; any one leg may hold them all.
    const dated = traveller.legs.length && traveller.legs.every(leg => leg.startDate && leg.arriveDate && daysBetween(leg.startDate, leg.arriveDate) >= 0
      && Number.isInteger(Number(leg.travelDays)) && String(leg.travelDays).trim() !== '');
    if (dated) {
      const total = tripDays(traveller.legs), sum = traveller.legs.reduce((acc, leg) => acc + Number(leg.travelDays), 0);
      if (sum !== total) {
        problems.push(at(`${who}：各段差旅天数合计 ${sum} 天，应等于行程总天数 ${total} 天（${[...traveller.legs.map(leg => leg.startDate)].sort()[0]} 至 `
          + `${[...traveller.legs.map(leg => leg.arriveDate)].sort().at(-1)}，含首尾）；天数可以都填在其中一段。`, ...traveller.legs.map(leg => fieldOf(leg, 'travelDays'))));
      }
    }
  });
  if (!legs) problems.push('请至少填写一段行程。');
  const orders = ctripOrders();
  const assessed = assessInvoices();
  if (state.invoices.some(item => assessed.get(item).status === 'checking')) problems.push('还有发票正在核对，请稍候。');
  else if (state.invoices.some(item => assessed.get(item).status !== 'ok')) problems.push('请先删除或重试列表中标红的发票。');
  if (!Number.isInteger(attachments) || attachments < 0 || attachments > 100) problems.push(at('附件张数应为 0–100 的整数。', 'attachments'));
  const { lines, payees } = collectMoney(problems);
  const reason = $('reason').value.trim() || lines[0]?.purpose || '';
  if (!reason) problems.push(at('请填写报销说明（报销事由）。', 'reason'));
  const action = document.querySelector('input[name="action"]:checked')?.value;
  if (!action) problems.push('请选择完成方式。');
  if (problems.length) return { problems };
  const trim = value => String(value).trim();
  const documentNumber = $('travel-form-select').value === NEW_FORM ? null : $('travel-form-select').value || null;
  return { fund, action, documentNumber, invoices: state.invoices.map(item => item.folderId ? { folderId: item.folderId, number: item.number } : item.upload),
    input: { fundingKind: $('fund-kind').value, fundingCode: fund.code, lines, payees,
    attachmentCount: attachments, reason, explain: $('travel-explain').value.trim(),
    travellers: state.travellers.map(item => ({ kind: item.kind, code: item.code.trim(), name: item.name.trim(),
      legs: item.legs.map(leg => ({ ...Object.fromEntries(Object.entries(leg).map(([key, value]) => [key, trim(value)])), travelDays: Number(leg.travelDays) })) })),
    ctripOrders: orders } };
}

async function submitTravel() {
  const claim = collectTravel();
  if (claim.problems) return showProblems(claim.problems);
  const { input, fund, action, documentNumber, invoices } = claim;
  const { trip, payment } = travelEstimate();
  const summary = [
    `类型：${TRAVEL}`,
    `单据：${documentNumber || '新建境内差旅单'}`,
    `经费：${fund.label}（可用 ${balanceText(state.fundBalance)}）`,
    `经费明细（合计须等于差旅合计，约 ${yuanOf(trip)} 元）：`,
    ...input.lines.map((line, index) => `　${index + 1}. ${line.budgetName}　${line.amount ? `${line.amount} 元` : `自动 约 ${yuanOf(split(state.lines, trip).rest)} 元`}　${line.purpose}`),
    ...input.travellers.flatMap(item => [`出差人：${TRAVELLER_KINDS[item.kind]} ${item.code} ${item.name}，${item.legs.length} 段行程`,
      ...item.legs.map(leg => `　${leg.startDate} ${leg.startAddress} → ${leg.arriveDate} ${leg.arriveAddress}，${VEHICLES[leg.vehicle]} ${leg.trafficExpense} 元，${leg.travelDays} 天`)]),
    `发票：${state.invoices.length ? `${state.invoices.length} 张，合计 ${yuan(invoiceTotal() === null ? '' : (invoiceTotal() / 100).toFixed(2))}（须不少于付款金额减去补贴）` : '无'}`,
    ...state.invoices.map((item, index) => `　${index + 1}. ${item.number}　${yuan(item.balance || item.amount)}　${item.seller || ''}${item.folderId ? '（票夹）' : ''}`),
    `携程冲账：${state.ctrip.picked.length ? '' : '无'}`,
    ...state.ctrip.picked.map(item => `　${item.order}　${item.personName}　${item.outstanding} 元　${item.remark}`),
    `收款人（合计约 ${yuanOf(payment)} 元）：${input.payees.length ? '' : '无'}`,
    ...input.payees.map((payee, index) => `　${index + 1}. ${payee.kind === 'bank' ? `银行汇款给 ${payee.code}（汇款用途：${payee.remitPurpose}）` : `个人银行卡，学号/工号 ${payee.code}`}　${payee.amount ? `${payee.amount} 元` : `自动 约 ${yuanOf(Math.max(0, split(state.payees, payment).rest))} 元`}`),
    `附件 ${input.attachmentCount} 张；报销事由：${input.reason}`,
    '',
    action === 'submit' ? '将填写、保存，回读核对无误后自动提交流转（审批路线用 OA 自动生成的），提交后不能由程序撤回。'
      : `将${documentNumber ? '填写' : '新建境内差旅单、填写'}并保存，不提交流转。`,
    '确定开始吗？',
  ].join('\n');
  if (!window.confirm(summary)) return;
  $('submit').disabled = true;
  try {
    const { run } = await busy('正在启动差旅单填写…', () => api('POST', '/api/oa/travel', { confirmed: true, action, input, documentNumber, invoices }));
    // The invoices and the draft now belong to this run; the next claim starts without them.
    state.invoices = [];
    state.folder = null;
    state.folderPicked = new Set();
    $('folder-panel').hidden = true;
    $('invoice-info').textContent = '';
    renderInvoices();
    if (documentNumber) [...$('travel-form-select').options].find(item => item.value === documentNumber)?.remove();
    $('travel-form-select').value = NEW_FORM;
    showTravelRun(run);
  } catch (error) {
    $('claim-error').textContent = error.message;
    $('claim-error').hidden = false;
  } finally {
    $('submit').disabled = !state.liveEnabled;
  }
}

function paintTravelToggle(steps = $('travel-events').children.length) {
  const collapsed = $('travel-card').classList.contains('collapsed');
  $('travel-toggle').textContent = collapsed ? `展开全部 ${steps} 步` : '收起';
  $('travel-toggle').setAttribute('aria-expanded', String(!collapsed));
}

function showTravelRun(run) {
  const [label, tone] = TRAVEL_STATUS[run.status] || [run.status, ''];
  $('travel-card').hidden = false;
  $('travel-doc').textContent = run.documentNumber || '';
  $('travel-status').textContent = label;
  $('travel-status').className = `badge ${tone}`;
  // A new run opens expanded; collapsed, only its latest step shows.
  if (run.status === 'running' && state.travelShown !== 'running') $('travel-card').classList.remove('collapsed');
  paintTravelToggle(run.events.length);
  $('travel-events').replaceChildren(...run.events.map((event, index) => {
    const item = document.createElement('li');
    const text = `${new Date(event.at).toLocaleTimeString('zh-CN')} ${event.message}`;
    if (run.status === 'running' && index === run.events.length - 1) pending(item, text);
    else item.textContent = text;
    return item;
  }));
  $('travel-stop').hidden = run.status !== 'running';
  clearTimeout(state.travelTimer);
  if (run.status === 'running') {
    state.travelTimer = setTimeout(async () => {
      try { showTravelRun((await api('GET', '/api/oa/travel')).run); }
      catch (error) { if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。'); else show(error.message, true); }
    }, 1500);
  } else if (state.travelShown === 'running') {
    toast(`${run.documentNumber ? `差旅单 ${run.documentNumber}` : '差旅单'}：${label}。`, !['completed', 'submitted'].includes(run.status));
    refreshBudgets();
    if (isTravel()) loadTravelForms();
  }
  state.travelShown = run.status;
}


/** The overview figures and the 提交前检查 of a 境内差旅单, as the page estimates them (blank 实际补贴 at
 * the standard). Only a summary: collectTravel() still checks everything when 提交 is clicked. */
function travelOverview() {
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  const { trip, subsidies, reverse, payment } = travelEstimate();
  const lines = split(state.lines, trip), payees = split(state.payees, payment);
  const legs = state.travellers.flatMap(item => item.legs);
  const people = state.travellers.filter(item => item.name.trim() && item.code.trim()).length;
  const legsOk = legs.length > 0 && legs.every(leg => leg.startDate && leg.arriveDate && leg.startAddress.trim() && leg.arriveAddress.trim()
    && String(leg.trafficExpense).trim() !== '' && String(leg.travelDays).trim() !== '');
  const assessed = assessInvoices();
  const document = $('travel-form-select').value;
  // Every payee row names someone; a 银行汇款 one also has its account and 汇款用途.
  const payeesFilled = state.payees.length > 0 && state.payees.every(payee => payee.code.trim()
    && (payeeIsCard(payee) || (payee.supplierCode && payee.remitPurpose.trim())));
  return {
    eyebrow: `境内差旅单 · ${!document || document === NEW_FORM ? '新建' : document}`,
    subtitle: fund ? fund.label : '先选择经费',
    stats: [
      { label: '经费可用', value: fund ? balanceText(state.fundBalance) : '—' },
      { label: '差旅合计', value: `${yuanOf(trip)} 元`, note: `补贴 ${yuanOf(subsidies)} 元`, strong: true },
      { label: '携程冲账', value: `${yuanOf(reverse)} 元`, note: `${state.ctrip.picked.length} 张借款单` },
      { label: '应付收款人', value: `${yuanOf(payment)} 元`, note: `${state.payees.length} 位收款人` },
    ],
    checks: [
      { label: '经费', ok: Boolean(fund), detail: fund ? fund.code : '未选择' },
      { label: '出差人', ok: people === state.travellers.length && people > 0, detail: `${people} / ${state.travellers.length} 位已核对` },
      { label: '行程', ok: legsOk, detail: `${legs.length} 段` },
      { label: '经费明细', ok: trip > 0 && lines.ok && state.lines.every(line => line.subject && line.purpose.trim()),
        detail: trip ? (lines.ok ? `${state.lines.length} 行，合计 ${yuanOf(trip)} 元` : `相差 ${yuanOf(Math.abs(lines.rest))} 元`) : '待填行程' },
      // Nothing to pay is only settled once there is a trip (and the write-offs cover it).
      { label: '收款人', ok: trip > 0 && (payment === 0 || (payeesFilled && (payees.ok || (payees.blanks === 1 && payees.rest === 0)))),
        detail: !trip ? '待填行程' : !payment ? '冲账已覆盖' : payeesFilled ? `应付 ${yuanOf(payment)} 元` : '未填写收款人' },
      // Invoices are optional on a 差旅单 (subsidies need none): shown, not counted, until one is added.
      { label: '发票', optional: !state.invoices.length, ok: state.invoices.length > 0 && state.invoices.every(item => assessed.get(item)?.status === 'ok'),
        detail: state.invoices.length ? `${state.invoices.length} 张，合计 ${yuan(invoiceTotal() === null ? '' : (invoiceTotal() / 100).toFixed(2))}` : '可选，未添加' },
    ],
  };
}

/** 境内差旅单's own controls: draft list, 携程 picker, travellers, 经费明细, 收款人, the run's stop button. */
function initTravel() {
  $('travel-form-refresh').addEventListener('click', () => loadTravelForms($('travel-form-select').value));
  $('travel-toggle').addEventListener('click', () => { $('travel-card').classList.toggle('collapsed'); paintTravelToggle(); });
  searchable($('ctrip-select'), { placeholder: '输入订单号、摘要或借款人筛选', empty: '没有匹配的携程借款单' });
  $('ctrip-select').addEventListener('change', pickBorrow);
  $('traveller-add').addEventListener('click', () => { state.travellers.push(blankTraveller()); renderTravellers(); });
  $('line-add').addEventListener('click', () => { state.lines.push(blankLine()); renderLines(); });
  $('payee-add').addEventListener('click', () => { state.payees.push(blankPayee()); renderPayees(); });
  $('travel-stop').addEventListener('click', async () => {
    if (!window.confirm('停止后续自动操作吗？已经写入 OA 的内容不会回滚。')) return;
    try { showTravelRun((await api('POST', '/api/oa/travel/stop')).run); } catch (error) { show(error.message, true); }
  });
  resetTravel();
  registerForm(TRAVEL, {
    title: '填写境内差旅单', moneyLegend: '收款人', invoiceLegend: '票据（发票与行程附件）', layout: 'travel', budgetsPath: '/api/oa/travel/budgets', reset: resetTravel, submit: () => submitTravel(),
    // A run started before a page reload is still followed.
    load: () => api('GET', '/api/oa/travel').then(({ run }) => { if (run) showTravelRun(run); }).catch(() => undefined),
    activate: () => { $('attachments').min = '0'; }, onSelect: () => loadTravelForms(), onFund: loadBorrows, onSubjects: renderLines,
    overview: travelOverview,
  });
}

export { initTravel, lookupTraveller, paintBorrows, renderCtripPicked, renderLines, renderTravellers, VEHICLES };
