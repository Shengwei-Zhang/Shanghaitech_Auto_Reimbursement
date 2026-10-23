'use strict';

/** /print-list: the printable bills of 报销单查询, using the school login of the one-click page. */
const $ = id => document.getElementById(id);
const state = { csrf: '', rows: [], picked: new Set(), loading: 0, seq: 0, busy: new Map(),
  /** 打印文件 per bill: queued, requesting, ready (with its URLs) or failed. Kept across a reload of the list. */
  files: new Map() };
/** Bills whose 打印文件 are made at once (the server also limits its PDF renders). */
const PREPARE_AT_ONCE = 2;
const MAX_PICK = 20;

async function api(method, path, body) {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': state.csrf }),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

let toastTimer = 0;
function toast(text, isError = false) {
  $('toast').textContent = text;
  $('toast').className = isError ? 'toast error' : 'toast';
  $('toast').hidden = !text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 6000 : 4000);
}

function show(text, isError = false) {
  $('message').textContent = text;
  $('message').className = isError ? 'message error' : 'message';
  $('message').hidden = !text;
}

/** Trailing …/。 becomes a cycling "..."; any other write to the element ends it. */
function pending(element, text) {
  element.textContent = text.replace(/(…|\.+|。)$/, '');
  element.dataset.pending = element.dataset.pendingShown = element.textContent;
}
setInterval(() => {
  const dots = '.'.repeat(Math.floor(Date.now() / 400) % 4);
  for (const element of document.querySelectorAll('[data-pending]')) {
    if (element.textContent !== element.dataset.pendingShown) {
      delete element.dataset.pending;
      delete element.dataset.pendingShown;
    } else element.textContent = element.dataset.pendingShown = element.dataset.pending + dots;
  }
}, 400);

const yuan = value => (value ? `${value} 元` : '—');

/** No OA login on this server yet: the one-click page signs in, this page reuses it. */
function needLogin(text) {
  state.seq++;
  state.rows = [];
  state.picked.clear();
  render();
  $('print-refresh').disabled = false;
  show(text, true);
  const link = document.createElement('a');
  link.href = '/'; // redirects to the page, whatever its address
  link.textContent = '前往一键报销页面登录';
  $('message').append(document.createTextNode(' '), link);
  $('print-status').textContent = '';
}

/** The server asks OA for the newest 提交 bills only (状态 filter of 报销单查询, every bill type);
 * each is listed once OA's print permission check allows it. */
async function load() {
  const seq = ++state.seq;
  state.rows = [];
  state.picked.clear();
  show('');
  $('print-refresh').disabled = true;
  pending($('print-status'), '正在读取报销单…');
  render();
  try {
    const status = await api('GET', '/api/oa/status');
    if (seq !== state.seq) return;
    if (!status.loggedIn) return needLogin('还没有登录学校 OA。');
    const name = status.login ? status.login.userName || status.login.userAccount : '';
    $('account-name').textContent = name;
    $('account-id').textContent = status.login ? `工号 ${status.login.userAccount}` : '';
    $('account-avatar').textContent = name.slice(0, 1);
    const { rows, total } = await api('GET', '/api/oa/print');
    if (seq !== state.seq) return;
    const ask = rows.filter(row => row.print !== 'no');
    render();
    loadReady();
    const scope = `最近 ${rows.length} 张已提交的报销单${total > rows.length ? `（共 ${total} 张）` : ''}`;
    let failed = 0;
    for (const [index, row] of ask.entries()) {
      pending($('print-status'), `${scope}：正在逐张向 OA 确认能否打印（${index + 1}/${ask.length}），已列出 ${state.rows.length} 张…`);
      try {
        const result = await api('GET', `/api/oa/print/permission?bizId=${encodeURIComponent(row.bizId)}`);
        if (seq !== state.seq) return;
        if (result.allowed || row.print === 'yes') {
          state.rows.push(row);
          state.rows.sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
          render();
        }
      } catch (error) {
        if (error.status === 401) return needLogin('学校 OA 登录已失效，请重新登录。');
        failed++;
      }
    }
    if (seq !== state.seq) return;
    $('print-status').textContent = `${scope}，OA 允许打印 ${state.rows.length} 张。`
      + (failed ? `另有 ${failed} 张未能向 OA 确认，已略过。` : '');
  } catch (error) {
    if (seq !== state.seq) return;
    if (error.status === 401) return needLogin(error.message);
    $('print-status').textContent = `读取失败：${error.message}`;
  } finally {
    if (seq === state.seq) $('print-refresh').disabled = false;
  }
}

function shownRows() {
  const words = $('print-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.rows.filter(row => words.every(word => [row.billCode, row.kind, row.remark, row.amount, row.date].join(' ').toLowerCase().includes(word)));
}

function pick(row, checked) {
  if (checked && !state.picked.has(row.bizId) && state.picked.size >= MAX_PICK) toast(`一次最多打印 ${MAX_PICK} 张报销单。`, true);
  else if (checked) state.picked.add(row.bizId);
  else state.picked.delete(row.bizId);
  render();
}

function render() {
  const shown = shownRows();
  $('print-rows').replaceChildren(...shown.map(row => {
    const item = document.createElement('tr');
    item.className = state.picked.has(row.bizId) ? 'picked' : '';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.picked.has(row.bizId);
    box.setAttribute('aria-label', `选择 ${row.billCode}`);
    box.addEventListener('click', event => event.stopPropagation());
    box.addEventListener('change', () => pick(row, box.checked));
    const first = document.createElement('td');
    first.append(box);
    item.append(first, ...[row.billCode, row.kind, row.date, yuan(row.amount), row.remark].map((text, index) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (index === 3) cell.className = 'num';
      if (index === 4) cell.title = text;
      return cell;
    }), actionsCell(row));
    item.addEventListener('click', () => pick(row, !state.picked.has(row.bizId)));
    return item;
  }));
  if (!shown.length && !$('print-refresh').disabled) {
    const empty = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'hint';
    cell.textContent = state.rows.length ? '没有符合筛选条件的报销单。' : '没有可打印的报销单。';
    empty.append(cell);
    $('print-rows').replaceChildren(empty);
  }
  const count = state.picked.size, working = state.busy.size > 0;
  $('print-go').disabled = !count || working;
  $('print-go').textContent = count ? `合并打印所选（${count} 张）` : '合并打印所选';
  const unready = [...state.picked].filter(id => !readyFile(id) && !['queued', 'requesting'].includes(state.files.get(id)?.status)).length;
  $('print-prepare').disabled = !unready || working;
  $('print-prepare').textContent = unready ? `生成所选打印文件（${unready} 张）` : count ? '所选打印文件均已就绪' : '生成所选打印文件';
  $('print-download').disabled = !count || working;
  $('print-download').textContent = count ? `下载所选（${count} 张）` : '下载所选';
  $('print-count').hidden = !count;
  $('print-count').textContent = `已选 ${count} 张`;
  const free = shown.filter(row => !state.picked.has(row.bizId));
  $('print-all').textContent = shown.length && !free.length ? '取消全选' : '全选';
  $('print-all').disabled = !shown.length;
}

function toggleAll() {
  const shown = shownRows();
  if (shown.every(row => state.picked.has(row.bizId))) for (const row of shown) state.picked.delete(row.bizId);
  else {
    for (const row of shown) if (state.picked.size < MAX_PICK) state.picked.add(row.bizId);
    if (shown.some(row => !state.picked.has(row.bizId))) toast(`一次最多打印 ${MAX_PICK} 张，已选前 ${MAX_PICK} 张。`, true);
  }
  render();
}

function actionsCell(row) {
  const cell = document.createElement('td');
  cell.className = 'actions';
  const doing = state.busy.get(row.bizId);
  const button = (label, title, onClick, disabled = false) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'link';
    element.textContent = label;
    element.title = title;
    element.disabled = disabled || Boolean(doing) || state.busy.size > 0;
    element.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    return element;
  };
  if (doing) {
    const note = document.createElement('span');
    note.className = 'hint small';
    pending(note, doing === 'pdf' ? '正在生成 PDF…' : '正在读取…');
    cell.append(note);
    return cell;
  }
  const file = readyFile(row.bizId), entry = state.files.get(row.bizId);
  if (file) {
    // 报销文件已就绪: a state, not an action; 打印 and 下载 use the file made ahead.
    const done = button('报销文件已就绪', `${row.billCode} 的打印文件已生成，${expiresIn(file)}内有效`, () => undefined, true);
    done.classList.add('file-ready');
    const printed = file.printed || row.printed;
    const print = button(printed ? '已点击打印' : '打印', printed ? `已点击过打印，可再次打印 ${row.billCode}` : `打印 ${row.billCode}`, () => openReady(file));
    if (printed) print.classList.add('printed');
    cell.append(done, print,
      button('下载', `下载 ${row.billCode}.pdf`, () => saveReady(file)));
  } else if (entry?.status === 'queued' || entry?.status === 'requesting') {
    const waiting = button('', '', () => undefined, true);
    waiting.classList.add('requesting');
    if (entry.status === 'requesting') pending(waiting, '打印文件请求中…');
    else waiting.textContent = '等待生成…';
    cell.append(waiting);
  } else {
    // Clicked before (a file since expired, an earlier login): the server keeps it.
    if (row.printed) {
      const note = document.createElement('span');
      note.className = 'hint small printed';
      note.textContent = '已点击打印';
      note.title = `已点击过打印 ${row.billCode}；重新生成打印文件可再次打印`;
      cell.append(note);
    }
    const make = button(entry?.status === 'failed' ? '重新生成' : '生成打印文件',
      entry?.status === 'failed' ? `上次未能生成：${entry.error}` : `在后台生成 ${row.billCode} 的打印文件（PDF）`, () => prepareFiles([row.bizId]));
    make.classList.add('make');
    cell.append(make);
  }
  cell.append(button('添加附件', '正在接入 OA 的添加附件流程', () => undefined, true));
  return cell;
}

/** The ready 打印文件 of a bill, if it has not expired. */
function readyFile(bizId) {
  const entry = state.files.get(bizId);
  return entry?.status === 'ready' && Date.parse(entry.file.expiresAt) > Date.now() ? entry.file : undefined;
}

const expiresIn = file => `${Math.max(1, Math.round((Date.parse(file.expiresAt) - Date.now()) / 60_000))} 分钟`;

/** Opened apart from this page (noopener), so its print dialog never freezes the list. */
function openReady(file) {
  if (!readyFile(file.bizId)) return expired(file);
  window.open(file.printUrl, '_blank', 'noopener');
  // The server records it too (the print page was opened), so a reload, a restart or a new login still shows 已点击打印.
  file.printed = true;
  const row = state.rows.find(item => item.bizId === file.bizId);
  if (row) row.printed = true;
  render();
}

function saveReady(file) {
  if (!readyFile(file.bizId)) return expired(file);
  const link = document.createElement('a');
  link.href = `${file.pdfUrl}?download=1`;
  link.download = file.filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function expired(file) {
  state.files.delete(file.bizId);
  render();
  toast(`${file.billCode} 的打印文件已过期，请重新生成。`, true);
}

/** Makes the 打印文件 of each bill not ready yet, a few at a time; every row shows its own progress. */
async function prepareFiles(ids) {
  const todo = ids.filter(id => !readyFile(id) && !['queued', 'requesting'].includes(state.files.get(id)?.status));
  if (!todo.length) return;
  for (const id of todo) state.files.set(id, { status: 'queued' });
  render();
  const bills = id => state.rows.find(row => row.bizId === id)?.billCode ?? id;
  let done = 0, failed = 0;
  const status = () => pending($('print-status'), `正在生成打印文件：已完成 ${done} / ${todo.length}${failed ? `，${failed} 张未能生成` : ''}…`);
  status();
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(PREPARE_AT_ONCE, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      state.files.set(id, { status: 'requesting' });
      render();
      try {
        const file = await api('POST', '/api/oa/print/file', { bizId: id });
        state.files.set(id, { status: 'ready', file });
        done++;
      } catch (error) {
        if (error.status === 401) {
          for (const left of [id, ...queue.splice(0)]) state.files.delete(left);
          return needLogin(error.message);
        }
        state.files.set(id, { status: 'failed', error: error.message });
        failed++;
        toast(`${bills(id)} 未能生成打印文件：${error.message}`, true);
      }
      status();
      render();
    }
  }));
  $('print-status').textContent = `打印文件已生成 ${done} 张${failed ? `，${failed} 张未能生成（可点“重新生成”）` : ''}；就绪后点“打印”直接打印，30 分钟内有效。`;
  render();
}

/** 打印文件 the server still holds, e.g. after this page was reloaded. */
async function loadReady() {
  try {
    const { files } = await api('GET', '/api/oa/print/files');
    for (const [id, entry] of state.files) if (entry.status === 'ready') state.files.delete(id);
    for (const file of files) state.files.set(file.bizId, { status: 'ready', file });
    render();
  } catch { /* the rows still work without them */ }
}

const pickedIds = () => state.rows.filter(row => state.picked.has(row.bizId)).map(row => row.bizId);

/** The print window opens on the click (a later window.open is blocked), then receives the document. */
async function printBills(ids) {
  if (!ids.length || state.busy.size) return;
  const win = window.open('', '_blank');
  if (win) {
    win.document.title = '正在生成报销单打印页';
    win.document.body.textContent = `正在从学校 OA 读取 ${ids.length} 张报销单的打印内容，请稍候……`;
  }
  for (const id of ids) state.busy.set(id, 'print');
  render();
  pending($('print-status'), `正在读取 ${ids.length} 张报销单的打印内容，完成后在新窗口打开打印…`);
  try {
    const { url, bills } = await api('POST', '/api/oa/print', { bizIds: ids });
    if (win && !win.closed) win.location.replace(url);
    else window.open(url, '_blank');
    $('print-status').textContent = `已生成 ${bills.join('、')} 的打印页面，在新窗口中打印。`;
  } catch (error) {
    if (win && !win.closed) win.close();
    if (error.status === 401) return needLogin(error.message);
    $('print-status').textContent = `打印失败：${error.message}`;
    toast(`打印失败：${error.message}`, true);
  } finally {
    state.busy.clear();
    render();
  }
}

/** Same content as the print page, rendered to a PDF on this machine and saved by the browser. */
async function downloadBills(ids) {
  if (!ids.length || state.busy.size) return;
  for (const id of ids) state.busy.set(id, 'pdf');
  render();
  pending($('print-status'), `正在读取 ${ids.length} 张报销单的打印内容并生成 PDF…`);
  try {
    const { url, bills, filename } = await api('POST', '/api/oa/print', { bizIds: ids, format: 'pdf' });
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'print.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    $('print-status').textContent = `已下载 ${bills.join('、')} 的 PDF。`;
  } catch (error) {
    if (error.status === 401) return needLogin(error.message);
    $('print-status').textContent = `下载失败：${error.message}`;
    toast(`下载失败：${error.message}`, true);
  } finally {
    state.busy.clear();
    render();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('print-refresh').addEventListener('click', () => load());
  $('print-search').addEventListener('input', render);
  $('print-all').addEventListener('click', toggleAll);
  $('print-go').addEventListener('click', () => printBills(pickedIds()));
  $('print-prepare').addEventListener('click', () => prepareFiles(pickedIds()));
  $('print-download').addEventListener('click', () => downloadBills(pickedIds()));
  try { state.csrf = (await api('GET', '/api/session')).csrfToken; }
  catch (error) { return show(error.message, true); }
  load();
});
