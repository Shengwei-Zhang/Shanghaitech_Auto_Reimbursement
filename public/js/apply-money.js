/** 用款申请单: blank-form list, payee, amount, template, submission as a job and the job list. */
import { $, balanceText, api, busy, cents, forms, KIND_LABEL, leave, NEW_FORM, option, page, pending, PERSON_CODE, registerForm, rowButton, show, state, toast, yuan } from './core.js';
import { chooseFund, loadFunds, prefetchBalances, refreshBudgets, selectedSubject, showBalance, subjectKey } from './funding.js';
import { assessInvoices, countedInvoices, invoiceTotal, renderInvoices } from './invoices.js';

const STAGE_LABEL = {
  'authenticate': '登录', 'open workbench': '打开工作台', 'select reimbursement form': '选择单据',
  'create reimbursement form': '新建单据', 'prepare reimbursement form': '准备表单', 'select funding item': '选择经费与预算',
  'attach invoice': '上传并关联发票', 'configure payment': '付款信息', 'fill reimbursement details': '填写明细',
  'save reimbursement': '保存', 'verify saved form': '核对保存结果', 'prepare submission': '打开流转确认',
  'confirm submission': '确认提交', 'verify submission': '核对提交结果',
};
const STATUS = {
  draft: ['草稿', ''], queued: ['排队中', ''], running: ['执行中', ''], waiting_manual: ['等待人工确认', 'warn'],
  waiting_review: ['已暂停，请查看浏览器', 'bad'], submitted: ['已提交并核验', ''], completed: ['已完成', ''],
  needs_review: ['已结束，请在 OA 核对', 'warn'], failed: ['失败', 'bad'], cancelled: ['已取消', 'bad'],
  interrupted: ['已中断，请在 OA 核对', 'bad'], verified: ['已人工核验', ''], released: ['已释放', ''],
};
const ACTIVE = ['queued', 'running', 'waiting_manual', 'waiting_review'];
let formsSeq = 0;
/** Lists the todo forms, then checks them one at a time; each blank one joins the select as soon as it is confirmed. */
async function loadForms(selected) {
  const seq = ++formsSeq;
  $('form-select').replaceChildren(option(NEW_FORM, '＋ 新建用款申请单'));
  $('form-refresh').disabled = true;
  pending($('form-filter'), '正在查找空单…');
  try {
    const { forms } = await api('GET', '/api/oa/forms');
    let blank = 0, failed = 0;
    for (const form of forms) {
      if (state.jobs.some(job => ACTIVE.includes(job.status) && jobDocument(job) === form.documentNumber)) continue;
      let checked;
      try { checked = await api('GET', `/api/oa/forms/check?documentNumber=${encodeURIComponent(form.documentNumber)}`); }
      catch (error) {
        if (error.status === 401) throw error;
        failed++;
      }
      if (seq !== formsSeq) return;
      if (!checked?.blank) continue;
      blank++;
      const item = option(form.documentNumber, `${form.documentNumber}（${form.date}，空单）`);
      $('form-select').append(item);
      if (form.documentNumber === selected) item.selected = true;
    }
    $('form-filter').textContent = (blank ? '' : '没有空单，可以直接新建。') + (failed ? `${failed} 张未能核对，已略过。` : '');
  } catch (error) {
    if (seq !== formsSeq) return;
    if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。');
    else $('form-filter').textContent = error.message;
    throw error;
  } finally { if (seq === formsSeq) $('form-refresh').disabled = false; }
}

let payeeSeq = 0, payeeTimer = 0, payeeLooked = '';
function payeeKind() {
  const value = $('payee').value.trim();
  return !value ? '' : PERSON_CODE.test(value) ? 'card' : 'bank';
}

/** Shows how the payee will be paid; for 银行汇款, looks the account name up among OA's suppliers. */
async function checkPayee(keep = '') {
  const kind = payeeKind(), name = $('payee').value.trim();
  // Leaving the box (e.g. clicking 提交) must not reload an account list that is already shown.
  if (kind === 'bank' && name === payeeLooked && !keep) return;
  const seq = ++payeeSeq;
  payeeLooked = kind === 'bank' ? name : '';
  $('bank-row').hidden = kind !== 'bank';
  showTransfer();
  if (kind !== 'bank') {
    $('payee-hint').textContent = kind === 'card' ? '个人银行卡：提交后按学号/工号在 OA 中查询收款人姓名和银行卡号。' : '';
    return;
  }
  if (name.length < 2) {
    $('bank-supplier').replaceChildren(option('', '户名至少 2 个字符'));
    $('payee-hint').textContent = '';
    return;
  }
  $('bank-supplier').replaceChildren(pending(option('', ''), '正在 OA 供应商中查找该户名的银行账户…'));
  $('bank-supplier').disabled = true;
  $('payee-hint').textContent = '银行汇款：收款账户取自 OA 供应商库，不手工填写账号。';
  try {
    const { suppliers } = await api('GET', `/api/oa/payees?name=${encodeURIComponent(name)}`);
    if (seq !== payeeSeq) return;
    const label = item => `${item.bank} ${item.account}（供应商编码 ${item.supplierCode}${item.main ? '' : '，非主数据'}）`;
    $('bank-supplier').replaceChildren(...(suppliers.length
      ? [option('', suppliers.length > 1 ? `请选择收款账户（共 ${suppliers.length} 个）` : '请选择收款账户'),
        ...suppliers.map(item => option(item.supplierCode, label(item)))]
      : [option('', 'OA 供应商中没有该户名的银行账户')]));
    $('bank-supplier').disabled = !suppliers.length;
    const wanted = keep || (suppliers.length === 1 ? suppliers[0].supplierCode : '');
    if (suppliers.some(item => item.supplierCode === wanted)) $('bank-supplier').value = wanted;
    if (!suppliers.length) $('payee-hint').textContent = `OA 供应商中没有户名为“${name}”的银行账户。请核对户名（须与供应商名称完全一致），或先在 OA 中添加该供应商。`;
  } catch (error) {
    if (seq !== payeeSeq) return;
    if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
    payeeLooked = '';
    $('bank-supplier').replaceChildren(option('', '查询失败，修改户名后重试'));
    $('payee-hint').textContent = `供应商查询失败：${error.message}`;
  }
}

/** The transfer is the claim itself: OA requires 结算金额 = 报销金额, so it follows 实报金额. */
function showTransfer() {
  const amount = $('amount').value.trim();
  $('bank-amount').textContent = payeeKind() === 'bank'
    ? `转账金额：${amount ? `${amount} 元` : '—'}（等于实报金额，默认为发票合计）` : '';
}

/** 经费、预算项、收款人工号、用途、报销事由 of the last started claim, per account; browser storage only. */
const TEMPLATE_KEY = 'easy-claim-template';
function saveTemplate(template) {
  try { localStorage.setItem(`${TEMPLATE_KEY}:${state.account}`, JSON.stringify(template)); } catch { /* storage unavailable */ }
}
function loadTemplate() {
  try { return JSON.parse(localStorage.getItem(`${TEMPLATE_KEY}:${state.account}`) || 'null'); } catch { return null; }
}

/** A blank claim prefilled from the template; funds and subjects are re-read, so a used-up one is not chosen. */
async function reuseTemplate() {
  const template = loadTemplate();
  show('');
  page.reset();
  if (!template) return page.loadWorkbench();
  $('fund-kind').value = template.kind;
  $('payee').value = template.payee;
  $('remit-purpose').value = template.remitPurpose ?? '';
  checkPayee(template.supplierCode);
  $('purpose').value = template.purpose ?? '';
  $('reason').value = template.reason ?? '';
  loadForms().catch(error => { if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。'); });
  // Strict order: funds, then the template fund's budget items, then the list balances.
  try {
    await loadFunds({ quiet: true, prefetch: false });
    if (!state.funds.some(fund => fund.code === template.fundCode)) {
      prefetchBalances(state.funds);
      return show(`模板中的经费 ${template.fundCode} 已不在${KIND_LABEL[template.kind]}列表中，请重新选择。`, true);
    }
    $('fund-select').value = template.fundCode;
    await chooseFund();
    prefetchBalances(state.funds);
    if (!state.subjects.some(subject => subjectKey(subject) === template.subject)) {
      return show(`模板中的预算项“${template.subjectName}”已不在该经费下，请重新选择。`, true);
    }
    $('subject-select').value = template.subject;
    showBalance();
    show(`已套用模板：${template.fundLabel}，${template.subjectName}，收款人 ${template.payee}${template.purpose ? '，用途' : ''}${template.reason ? '，报销事由' : ''}。请添加发票并填写金额。`);
  } catch (error) {
    if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。');
    else show(error.message, true);
  }
}

/** Amount and attachment count follow the invoices until the user types their own. */
function syncAmounts() {
  const total = invoiceTotal();
  if (!state.amountEdited) $('amount').value = total === null ? '' : (total / 100).toFixed(2);
  if (!state.attachmentsEdited) $('attachments').value = String(Math.max(1, countedInvoices().length));
  showAmountHint();
  showTransfer();
}

function showAmountHint() {
  const total = invoiceTotal(), wanted = cents($('amount').value.trim());
  let text = '', tone = '';
  if (state.invoices.length && total === null && state.invoices.every(item => item.number)) text = '有发票未能识别票面金额，请手工填写实报金额。';
  else if (total !== null && wanted !== null && wanted > total) [text, tone] = [`实报金额超过发票合计 ${yuan((total / 100).toFixed(2))}，OA 不会接受，请改小。`, 'error'];
  else if (total !== null && wanted !== null && wanted < total) {
    [text, tone] = [`注意：实报金额比发票合计少 ${yuan(((total - wanted) / 100).toFixed(2))}。全部发票仍会关联到本单，但只报销 ${yuan($('amount').value.trim())}。`, 'warn'];
  }
  if ((state.amountEdited || state.attachmentsEdited) && state.invoices.length) text = `${text}${text ? '　' : ''}已手工修改金额或附件张数，清空后恢复自动计算。`;
  $('amount-hint').textContent = text;
  $('amount-hint').className = `hint small ${tone}`;
  $('amount-hint').hidden = !text;
}

/** Every keyword the browser will search for must point at exactly this one row. */
function collect() {
  const problems = [];
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  const subject = selectedSubject();
  const action = document.querySelector('input[name="action"]:checked')?.value;
  const amount = $('amount').value.trim(), purpose = $('purpose').value.trim(), payee = $('payee').value.trim();
  const attachments = Number($('attachments').value);
  if (!fund) problems.push('请选择经费。');
  else if (state.funds.some(item => item !== fund && `${item.label} ${item.code}`.includes(fund.code))) {
    problems.push('所选经费编号同时出现在其他经费中，程序无法唯一定位，请改为在 OA 中手工选择。');
  }
  if (!subject) problems.push('请选择预算项。');
  else if (state.subjects.some(item => item !== subject && `${item.name} ${item.quotaName}`.includes(subject.name))) {
    problems.push(`预算项名称“${subject.name}”不唯一，程序无法唯一定位，请改为在 OA 中手工选择。`);
  }
  const assessed = assessInvoices();
  if (!state.invoices.length) problems.push('请添加全电发票 PDF，或从 OA 票夹选择发票。');
  else if (state.invoices.some(item => assessed.get(item).status === 'checking')) problems.push('还有发票正在核对，请稍候。');
  else if (state.invoices.some(item => assessed.get(item).status !== 'ok')) problems.push('请先删除或重试列表中标红的发票。');
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) problems.push('实报金额须为正数，最多两位小数。');
  else {
    const wanted = cents(amount), total = invoiceTotal();
    if (total !== null && wanted > total) problems.push(`实报金额不能超过发票金额合计（${(total / 100).toFixed(2)} 元）。`);
    else if (subject && cents(subject.balance) !== null && wanted > cents(subject.balance)) problems.push(`实报金额超过预算项可用余额（${subject.balance} 元）。`);
    else if (fund && cents(state.fundBalance) !== null && wanted > cents(state.fundBalance)) problems.push(`实报金额超过经费可用余额（${state.fundBalance} 元）。`);
  }
  if (!Number.isInteger(attachments) || attachments < 1 || attachments > 100) problems.push('附件张数应为 1–100 的整数。');
  const kind = payeeKind();
  if (!kind) problems.push('请填写收款人学号、工号或银行转账户名。');
  else if (kind === 'bank') {
    if (payee.length < 2) problems.push('银行转账户名至少 2 个字符。');
    else if (!$('bank-supplier').value) problems.push('请为银行转账选择 OA 供应商中的收款账户。');
    if (!$('remit-purpose').value.trim()) problems.push('请填写银行转账的汇款用途。');
  }
  if (!purpose) problems.push('请填写报销用途。');
  if (!action) problems.push('请选择完成方式。');
  if (problems.length) return { problems };
  const documentNumber = $('form-select').value === NEW_FORM ? null : $('form-select').value;
  return { fund, subject, action, payload: { confirmed: true, action, documentNumber, invoices: state.invoices.map(item => item.folderId ? { folderId: item.folderId, number: item.number } : item.upload),
    input: { reimbursementType: $('claim-type').value, fundingKindKeyword: KIND_LABEL[$('fund-kind').value], fundingKeyword: fund.code, budgetKeyword: subject.name,
      amount, attachmentCount: attachments, payeeCode: payee, purpose, reason: $('reason').value.trim(),
      ...(kind === 'bank' ? { payeeKind: 'bank', supplierCode: $('bank-supplier').value, remitPurpose: $('remit-purpose').value.trim() } : {}) } } };
}

async function submit() {
  $('claim-error').hidden = true;
  const claim = collect();
  if (claim.problems) {
    $('claim-error').textContent = claim.problems.join('\n');
    $('claim-error').hidden = false;
    return;
  }
  const { payload, fund, subject } = claim;
  const summary = [
    `类型：${payload.input.reimbursementType}`,
    `单据：${payload.documentNumber || '新建用款申请单'}`,
    `经费：${fund.label}（可用 ${balanceText(state.fundBalance)}）`,
    `预算项：${subject.code} ${subject.name}（可用 ${balanceText(subject.balance)}）`,
    `发票：${state.invoices.length} 张，合计 ${yuan(invoiceTotal() === null ? '' : (invoiceTotal() / 100).toFixed(2))}`,
    ...state.invoices.map((item, index) => `　${index + 1}. ${item.number}　${yuan(item.balance || item.amount)}　${item.seller || ''}${item.folderId ? '（票夹）' : ''}`),
    `实报金额：${payload.input.amount} 元${cents(payload.input.amount) < (invoiceTotal() ?? 0) ? '（少于发票合计）' : ''}，附件 ${payload.input.attachmentCount} 张`,
    payload.input.payeeKind === 'bank'
      ? `收款：银行汇款给 ${payload.input.payeeCode}（${$('bank-supplier').selectedOptions[0]?.textContent || ''}），转账 ${payload.input.amount} 元，汇款用途：${payload.input.remitPurpose}`
      : `收款：个人银行卡，学号/工号 ${payload.input.payeeCode}`,
    `用途：${payload.input.purpose}`,
    '',
    payload.action === 'submit' ? '将保存并自动提交流转，提交后不能由程序撤回。' : '将填写并保存，不提交流转。',
    '确定开始吗？',
  ].join('\n');
  if (!window.confirm(summary)) return;
  $('submit').disabled = true;
  pending($('submit'), '正在提交…');
  try {
    const { job } = await busy('正在启动执行…', () => api('POST', '/api/oa/submit', payload));
    state.job = job;
    saveTemplate({ kind: $('fund-kind').value, fundCode: fund.code, fundLabel: fund.label,
      subject: subjectKey(subject), subjectName: subject.name, payee: payload.input.payeeCode, purpose: payload.input.purpose, reason: payload.input.reason,
      ...(payload.input.payeeKind === 'bank' ? { supplierCode: payload.input.supplierCode, remitPurpose: payload.input.remitPurpose } : {}) });
    queued(job, payload.documentNumber);
  } catch (error) {
    $('claim-error').textContent = error.message;
    $('claim-error').hidden = false;
  } finally {
    $('submit').disabled = !state.liveEnabled;
    $('submit').textContent = '提交';
  }
}

/** The job joins the list; the form keeps 经费、预算项、收款人、用途、事由 and the completion
 * choice, and clears what belongs to one claim (发票、金额、所用空单) for the next one. */
function queued(job, documentNumber) {
  state.jobs.unshift(job);
  renderJobs();
  const waiting = state.jobs.filter(item => ACTIVE.includes(item.status)).length - 1;
  toast(waiting ? `已提交，前面还有 ${waiting} 个任务，完成后自动开始。可以继续填写下一单。` : '已提交并开始执行，可以继续填写下一单。');
  state.invoices = [];
  state.amountEdited = false;
  state.attachmentsEdited = false;
  state.folder = null;
  state.folderPicked = new Set();
  $('folder-panel').hidden = true;
  $('invoice-info').textContent = '';
  $('amount').value = '';
  if (documentNumber) [...$('form-select').options].find(item => item.value === documentNumber)?.remove();
  $('form-select').value = NEW_FORM;
  $('claim-reuse').hidden = false;
  renderInvoices();
}

/** The form a job fills: the chosen blank form, or the new one once the job has opened it. */
function jobDocument(job) {
  return job.result?.documentNumber || job.input?.target?.documentNumber
    || job.events.map(event => event.evidence?.match(/已打开 (A\d+)/)?.[1]).find(Boolean) || '';
}

function cell(text, className = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** One row per job submitted from this page, newest first; 详情 opens its event log. */
function renderJobs() {
  $('jobs-card').hidden = !state.jobs.length;
  const active = state.jobs.filter(job => ACTIVE.includes(job.status)).length;
  $('jobs-count').textContent = active ? `${active} 个执行中或排队` : `共 ${state.jobs.length} 个`;
  $('jobs').replaceChildren(...state.jobs.map((job, index) => {
    const [label, tone] = STATUS[job.status] || [job.status, ''];
    const running = ACTIVE.includes(job.status);
    const last = job.events[job.events.length - 1];
    const step = last ? `${last.stage ? `【${STAGE_LABEL[last.stage] || last.stage}】` : ''}${last.evidence || last.message}` : '';
    const invoices = [job.invoice, ...(job.extraInvoices || [])].filter(Boolean).length;
    const item = document.createElement('li');
    item.className = `job ${['failed', 'interrupted', 'cancelled'].includes(job.status) ? 'bad' : ''}`;
    const row = document.createElement('div');
    row.className = 'job-row';
    const badge = cell(label, `badge ${tone}`);
    const stepCell = cell('', 'job-step');
    if (running && last?.state === 'started') pending(stepCell, step);
    else stepCell.textContent = step;
    stepCell.title = step;
    const actions = document.createElement('span');
    actions.className = 'job-actions';
    if (running) {
      const stop = rowButton('停止', async () => {
        if (!window.confirm('停止这个任务的后续自动操作吗？已经发生的 OA 操作不会回滚。')) return;
        try { updateJob((await api('POST', `/api/jobs/${job.id}/cancel`)).job); } catch (error) { show(error.message, true); }
      }, 'danger');
      actions.append(stop);
    }
    const open = state.jobsOpen.has(job.id);
    actions.append(rowButton(open ? '收起' : '详情', () => {
      if (open) state.jobsOpen.delete(job.id); else state.jobsOpen.add(job.id);
      renderJobs();
    }));
    const labelled = (name, element) => { element.dataset.label = name; return element; };
    row.append(labelled('#', cell(String(state.jobs.length - index), 'num')),
      labelled('提交时间', cell(new Date(job.createdAt).toLocaleTimeString('zh-CN'))),
      labelled('单据', cell(jobDocument(job) || (job.input?.formMode === 'new' ? '新建' : '—'))),
      labelled('发票', cell(`${invoices} 张`)),
      labelled('实报金额', cell(yuan(job.input?.amount), 'num')),
      labelled('收款人', cell(job.input?.payeeCode || '')),
      labelled('状态', cell('')), labelled('当前步骤', stepCell), actions);
    row.children[6].append(badge);
    item.append(row);
    if (open) {
      const log = document.createElement('ol');
      log.className = 'events';
      log.replaceChildren(...eventItems(job));
      item.append(log);
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    return item;
  }));
  if (active && !state.timer) state.timer = setInterval(pollJobs, 2000);
  if (!active && state.timer) { clearInterval(state.timer); state.timer = 0; }
}

function updateJob(job) {
  const index = state.jobs.findIndex(item => item.id === job.id);
  if (index < 0) return;
  const ended = ACTIVE.includes(state.jobs[index].status) && !ACTIVE.includes(job.status);
  state.jobs[index] = job;
  if (ended) {
    const [label] = STATUS[job.status] || [job.status];
    const number = jobDocument(job);
    toast(`${number ? `单据 ${number}` : '任务'}：${label}。`, ['failed', 'interrupted', 'cancelled', 'needs_review'].includes(job.status), true);
    refreshBudgets();
  }
  renderJobs();
}

let jobsPolling = false;
async function pollJobs() {
  if (jobsPolling) return;
  jobsPolling = true;
  try {
    for (const job of state.jobs.filter(item => ACTIVE.includes(item.status))) {
      try { updateJob((await api('GET', `/api/jobs/${job.id}`)).job); }
      catch (error) { show(error.message, true); }
    }
  } finally { jobsPolling = false; }
}

/** The job's event log; the newest event of a running job is the step in progress. */
function eventItems(job) {
  const active = ACTIVE.includes(job.status);
  return job.events.map((event, index) => {
    const item = document.createElement('li');
    const stage = event.stage ? `【${STAGE_LABEL[event.stage] || event.stage}】` : '';
    const title = document.createElement('span');
    const text = `${new Date(event.at).toLocaleTimeString('zh-CN')} ${stage}${event.message}`;
    const current = active && index === job.events.length - 1 && event.state === 'started';
    if (current && !event.evidence) pending(title, text);
    else title.textContent = text;
    item.append(title);
    if (event.evidence) {
      const detail = document.createElement('small');
      if (current) pending(detail, event.evidence);
      else detail.textContent = event.evidence;
      item.append(detail);
    }
    return item;
  });
}


/** The overview figures and the 提交前检查 of a 用款申请单, from what the page holds now. Only a
 * summary: collect() still checks everything when 提交 is clicked. */
function applyMoneyOverview() {
  const fund = state.funds.find(item => item.code === $('fund-select').value);
  const subject = selectedSubject();
  const assessed = assessInvoices();
  const counted = countedInvoices(), total = invoiceTotal();
  const amount = $('amount').value.trim(), wanted = cents(amount);
  const kind = payeeKind();
  const document = $('form-select').value;
  const invoicesOk = state.invoices.length > 0 && state.invoices.every(item => assessed.get(item)?.status === 'ok');
  return {
    eyebrow: `用款申请单 · ${!document || document === NEW_FORM ? '新建' : document}`,
    subtitle: fund ? fund.label : '先选择经费和预算项',
    stats: [
      { label: '经费可用', value: fund ? balanceText(state.fundBalance) : '—' },
      { label: '预算项可用', value: subject ? balanceText(subject.balance) : '—', note: subject?.name },
      { label: '发票', value: `${counted.length} 张`, note: total === null ? '' : `合计 ${(total / 100).toFixed(2)} 元` },
      { label: '实报金额', value: wanted ? `${(wanted / 100).toFixed(2)} 元` : '—', strong: true },
    ],
    checks: [
      { label: '经费与预算项', ok: Boolean(fund && subject), detail: subject ? subject.name : '未选择' },
      { label: '发票', ok: invoicesOk, detail: state.invoices.length ? `${counted.length} / ${state.invoices.length} 张可用` : '未添加' },
      { label: '实报金额', ok: wanted > 0 && (total === null || wanted <= total), detail: wanted > 0 ? `${amount} 元` : '未填写' },
      { label: '收款人', ok: kind === 'card' || (kind === 'bank' && Boolean($('bank-supplier').value) && Boolean($('remit-purpose').value.trim())),
        detail: kind === 'card' ? `个人银行卡 ${$('payee').value.trim()}` : kind === 'bank' ? '银行汇款' : '未填写' },
      { label: '用途', ok: Boolean($('purpose').value.trim()), detail: $('purpose').value.trim() || '未填写' },
    ],
  };
}

function resetApplyMoney() {
  $('payee').value = state.account;
  $('remit-purpose').value = '';
  payeeLooked = '';
  checkPayee();
  state.amountEdited = false;
  state.attachmentsEdited = false;
  $('claim-reuse').hidden = !loadTemplate();
}

/** 用款申请单's own controls: its blank-form list, payee, amount and attachment fields, the template. */
function initApplyMoney() {
  $('form-refresh').addEventListener('click', () => loadForms($('form-select').value).catch(() => undefined));
  $('form-select').addEventListener('change', () => { $('claim-error').hidden = true; $('claim-error').textContent = ''; });
  $('payee').addEventListener('input', () => { clearTimeout(payeeTimer); payeeTimer = setTimeout(() => checkPayee(), 500); });
  $('payee').addEventListener('change', () => { clearTimeout(payeeTimer); checkPayee(); });
  $('amount').addEventListener('input', showTransfer);
  for (const [id, flag] of [['amount', 'amountEdited'], ['attachments', 'attachmentsEdited']]) {
    $(id).addEventListener('input', () => { state[flag] = true; showAmountHint(); });
    $(id).addEventListener('change', () => { if (!$(id).value.trim()) { state[flag] = false; syncAmounts(); } });
  }
  $('claim-reuse').addEventListener('click', () => reuseTemplate());
  registerForm('用款申请单', {
    title: '填写用款申请单', budgetsPath: '/api/oa/budgets', reset: resetApplyMoney, submit: () => submit(),
    load: () => loadForms().catch(error => { if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。'); }),
    activate: () => { $('attachments').min = '1'; }, onInvoices: syncAmounts, overview: applyMoneyOverview,
  });
}

export { initApplyMoney };
