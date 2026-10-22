'use strict';

/** /admin: usage statistics for the administrator's school account (REIM_ADMIN_ACCOUNTS), using the login of the main page. */
const $ = id => document.getElementById(id);

async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(text, isError = false) {
  $('message').textContent = text;
  $('message').className = isError ? 'message error' : 'message';
  $('message').hidden = !text;
}

const stat = (label, value, note) => {
  const box = document.createElement('div');
  box.className = 'stat';
  box.append(Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: String(value) }));
  if (note) box.append(Object.assign(document.createElement('dd'), { className: 'note', textContent: note }));
  return box;
};
const cell = (value, numeric = true) => Object.assign(document.createElement('td'), { textContent: String(value), className: numeric ? 'num' : '' });
const row = cells => { const tr = document.createElement('tr'); tr.append(...cells); return tr; };
const sumForms = forms => Object.values(forms).reduce((total, item) => {
  for (const [key, value] of Object.entries(item)) total[key] = (total[key] ?? 0) + value;
  return total;
}, { started: 0, saved: 0, submitted: 0, needs_review: 0, failed: 0, cancelled: 0 });
const rate = item => {
  const ended = item.saved + item.submitted + item.needs_review + item.failed;
  return ended ? `${Math.round((item.saved + item.submitted) / ended * 100)}%` : '—';
};
const FAILURES = { credentials_rejected: '账号或密码错误', login_page_unrecognized: '认证页面无法识别', portal_unverified: '门户未确认账号',
  authentication: '登录失效', other: '其他' };

function render(data) {
  const { now, totals, days, since } = data;
  $('admin-updated').textContent = `${new Date().toLocaleTimeString('zh-CN')} 更新，每 30 秒刷新`;
  $('now-stats').replaceChildren(
    stat('在线', now.online, '最近 5 分钟有操作的浏览器'),
    stat('已登录学校 OA', now.loggedIn),
    stat('正在执行', now.jobsRunning + now.travelRunning, `用款申请单 ${now.jobsRunning}，差旅单 ${now.travelRunning}`),
    stat('排队中', now.jobsQueued),
    stat('会话总数', now.sessions, now.mode === 'server' ? '多用户模式' : '本机单用户模式'));
  const all = sumForms(totals.forms);
  $('admin-since').textContent = `自 ${new Date(since).toLocaleDateString('zh-CN')} 起`;
  $('total-stats').replaceChildren(
    stat('服务用户', totals.users, `其中 ${totals.formUsers} 人发起过报销单`),
    stat('处理报销单', all.started),
    stat('成功', all.saved + all.submitted, `已提交 ${all.submitted}，只保存 ${all.saved}`),
    stat('成功率', rate(all), '不计已停止的'),
    stat('登录次数', totals.logins, `验证码 ${totals.captchas} 次`),
    stat('在线峰值', totals.peakOnline));
  const types = Object.entries(totals.forms);
  $('form-rows').replaceChildren(...(types.length ? types.map(([type, item]) => row([cell(type, false), cell(item.started), cell(item.submitted),
    cell(item.saved), cell(item.needs_review), cell(item.failed), cell(item.cancelled), cell(rate(item))]))
    : [row([Object.assign(cell('还没有报销单。', false), { colSpan: 8 })])]));
  const failures = Object.entries(totals.loginFailures);
  $('login-failures').textContent = failures.length ? `登录失败：${failures.map(([code, count]) => `${FAILURES[code] ?? code} ${count} 次`).join('，')}。` : '';
  $('day-rows').replaceChildren(...days.map(day => {
    const forms = sumForms(day.forms);
    const failed = Object.values(day.loginFailures).reduce((total, count) => total + count, 0);
    return row([cell(day.date, false), cell(day.users), cell(day.logins), cell(day.captchas), cell(failed), cell(day.peakOnline),
      cell(forms.started), cell(forms.saved + forms.submitted), cell(forms.failed + forms.needs_review)]);
  }));
  for (const id of ['admin-now', 'admin-totals', 'admin-days']) $(id).hidden = false;
}

async function load() {
  try {
    render(await api('/api/admin/stats'));
    show('');
  } catch (error) {
    for (const id of ['admin-now', 'admin-totals', 'admin-days']) $(id).hidden = true;
    show(error.status === 404 || error.status === 401
      ? '请先在报销助手页面用管理员的学校账号登录，再打开本页。' : `统计读取失败：${error.message}`, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // The local session cookie comes from /api/session, as on the main page.
  try { await api('/api/session'); } catch { /* shown by load */ }
  $('admin-refresh').addEventListener('click', load);
  await load();
  setInterval(load, 30_000);
});
