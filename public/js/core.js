/** Shared by every 报销类型: element lookup, the page API, messages, the searchable select, files, the form registry. */

const $ = id => document.getElementById(id);
const NEW_FORM = '__new__';
const KIND_LABEL = { authorized: '被授权的项目', responsible: '我负责的项目' };
const state = { csrf: '', liveEnabled: false, savedUsername: '', account: '', funds: [], subjects: [], budgets: new Map(),
  invoices: [], folder: null, folderTruncated: false, folderPicked: new Set(), job: null, timer: 0, jobs: [], jobsOpen: new Set() };

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
function toast(text, isError = false, stay = false) {
  const element = $('toast');
  element.textContent = text;
  element.className = isError ? 'toast error' : 'toast';
  element.hidden = !text;
  clearTimeout(toastTimer);
  if (text && !stay) toastTimer = setTimeout(() => { element.hidden = true; }, isError ? 6000 : 4000);
}

function show(text, isError = false) {
  $('message').textContent = text;
  $('message').className = isError ? 'message error' : 'message';
  $('message').hidden = !text;
}

function option(value, text) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = text;
  return element;
}

/** In-progress text: its trailing …/。 becomes a cycling "..." (JS, so it also works inside
 * <option>). Any later textContent write by other code ends the animation. */
function pending(element, text) {
  element.textContent = text.replace(/(…|\.+|。)$/, '');
  element.dataset.pending = element.dataset.pendingShown = element.textContent;
  return element;
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

/** v2 keeps the page usable: while a job holds the OA session a query can wait minutes, so the
 * select or button being loaded shows the pending text instead of a full-page overlay. */
/** A keyword search box in front of a <select>. The select stays the source of truth (its value,
 * options and change event, which the rest of this page uses); the box lists the options whose
 * text holds every typed keyword, and choosing one sets the select and fires its change. */
const normalizeText = text => String(text || '').normalize('NFKC').toLowerCase();
function searchable(select, { placeholder = '输入关键词筛选', empty = '没有匹配的项' } = {}) {
  const listId = `${select.id}-list`;
  const box = document.createElement('div');
  box.className = 'combo';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combo-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  const list = document.createElement('ul');
  list.id = listId;
  list.className = 'combo-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  box.append(input, list);
  // Before the select, so a click on the wrapping <label> focuses the box.
  select.before(box);
  select.classList.add('combo-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  let matches = [], active = 0;

  const chosen = () => select.options[select.selectedIndex];
  const sync = () => {
    input.disabled = select.disabled;
    if (document.activeElement === input && !list.hidden) return render();
    const option = chosen();
    if (option?.value) { input.value = option.textContent; input.placeholder = ''; }
    else { input.value = ''; input.placeholder = option?.textContent || ''; }
    input.title = input.value;
  };
  const render = () => {
    const words = normalizeText(input.value).split(/\s+/).filter(Boolean);
    matches = [...select.options].filter(item => item.value && !item.disabled && words.every(word => normalizeText(item.textContent).includes(word)));
    active = Math.min(active, Math.max(0, matches.length - 1));
    const scroll = list.scrollTop;
    list.replaceChildren(...(matches.length ? matches.map((item, index) => {
      const row = document.createElement('li');
      row.id = `${listId}-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === active));
      row.className = `${index === active ? 'active' : ''} ${item.value === select.value ? 'current' : ''}`;
      row.textContent = item.textContent;
      row.addEventListener('mousedown', event => { event.preventDefault(); choose(item); });
      row.addEventListener('mousemove', () => { if (active !== index) { active = index; render(); } });
      return row;
    }) : [Object.assign(document.createElement('li'), { className: 'combo-empty', textContent: empty })]));
    list.scrollTop = scroll;
    input.setAttribute('aria-activedescendant', matches.length ? `${listId}-${active}` : '');
  };
  const open = () => {
    if (select.disabled) return;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
    // A wide list under the rightmost column opens leftwards instead of past the window edge.
    list.style.left = '0';
    list.style.right = 'auto';
    if (list.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
      list.style.left = 'auto';
      list.style.right = '0';
    }
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    sync();
  };
  const choose = item => {
    const changed = select.value !== item.value;
    select.value = item.value;
    input.blur();
    close();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const keep = () => {
    const row = list.children[active];
    if (row && (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)) row.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', () => {
    // Start from the full list; the current choice stays visible as the placeholder.
    const option = chosen();
    input.placeholder = option?.value ? option.textContent : placeholder;
    input.value = '';
    active = Math.max(0, [...select.options].filter(item => item.value && !item.disabled).findIndex(item => item.value === select.value));
    open();
    keep();
  });
  input.addEventListener('blur', close);
  input.addEventListener('input', () => { active = 0; open(); list.scrollTop = 0; });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) return open();
      if (matches.length) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      render();
      keep();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!list.hidden && matches[active]) choose(matches[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.blur();
    }
  });
  // Options are rebuilt, relabelled (balances, the loading dots) and enabled from elsewhere.
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  // Programmatic choices (复用模板, form reset) do not fire change; follow them too.
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', { configurable: true, get() { return native.get.call(this); }, set(value) { native.set.call(this, value); sync(); } });
  select.form?.addEventListener('reset', () => setTimeout(sync));
  select.addEventListener('change', sync);
  sync();
}

/** Runs a page request; the page stays usable meanwhile (a job may hold the OA session for minutes).
 * A lost login returns to the login screen, any other error is shown. `text` names the request. */
async function busy(text, task) {
  try { return await task(); }
  catch (error) {
    if (error.status === 401 && !$('app').hidden) leave('学校 OA 登录已失效，请重新登录。');
    else show(error.message, true);
    throw error;
  }
}

function leave(reason) {
  clearInterval(state.timer);
  state.timer = 0;
  hideCaptcha();
  $('app').hidden = true;
  $('login-screen').hidden = false;
  $('login-error').textContent = reason || '';
  $('login-error').hidden = !reason;
  $('password').focus();
}

function hideCaptcha() {
  $('captcha-row').hidden = true;
  $('captcha').required = false;
  $('captcha-image').removeAttribute('src');
  $('username').readOnly = false;
  $('password').readOnly = false;
  $('login-button').textContent = '登录';
}

/** 学号/工号 → 个人银行卡; anything else is a 银行汇款 account name, paid to one OA supplier. */
const PERSON_CODE = /^[a-zA-Z0-9_-]{2,32}$/;
const yuan = value => (value ? `${value} 元` : '未知');
/** A balance from OA's showAmount: empty means OA does not let this user see it. */
const balanceText = value => (value ? `${value} 元` : '未授权查看');
const cents = value => (/^-?\d+(\.\d{1,2})?$/.test(value || '') ? Math.round(Number(value) * 100) : null);

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.readAsDataURL(file);
  });
}

const MAX_INVOICE_BYTES = 8 * 1024 * 1024;
/** Files from a drop, descending into dropped folders. */
async function droppedFiles(transfer) {
  const entries = [...transfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...transfer.files];
  const files = [];
  const walk = async entry => {
    if (entry.isFile) files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

/** `tone`: 'danger' for removing or stopping (red on the page). */
function rowButton(text, onClick, tone = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `link ${tone}`.trim();
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}


/** 报销类型 → its page module, so the shared parts (funds, invoices, reset, 提交) never call a form directly:
 * { title, layout?, budgetsPath, reset(), load?(), activate?(), onSelect?(), onFund?(), onSubjects?(), onInvoices?(), submit() }. */
const forms = new Map();
const registerForm = (type, form) => forms.set(type, form);
const currentType = () => $('claim-type')?.value || '用款申请单';
const currentForm = () => forms.get(currentType());
/** Page-level actions main.js provides: a fresh claim, and reloading funds and forms. */
const page = { reset: () => {}, loadWorkbench: () => {} };

const fileDrag = event => [...event.dataTransfer?.types ?? []].includes('Files');
/** Files may be dropped on a .drop zone only; anywhere else the browser must not open them. */
window.addEventListener('dragover', event => {
  if (!fileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = event.target.closest?.('.drop') ? 'copy' : 'none';
});
window.addEventListener('drop', event => { if (fileDrag(event)) event.preventDefault(); });

/** A drop zone that hands the dropped transfer to `onDrop` and reports a failure to `onError`. */
function dropZone(zone, onDrop, onError) {
  zone.addEventListener('dragenter', event => { if (fileDrag(event)) { event.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragover', event => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('over'); });
  zone.addEventListener('drop', async event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('over');
    try { await onDrop(event.dataTransfer); } catch (error) { onError(error); }
  });
}

export { $, api, balanceText, busy, cents, currentForm, currentType, droppedFiles, dropZone, forms, hideCaptcha, KIND_LABEL, leave, MAX_INVOICE_BYTES, NEW_FORM, option, page, pending, PERSON_CODE, readFile, registerForm, rowButton, searchable, show, state, toast, yuan };
