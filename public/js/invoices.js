/** 发票: PDFs and OA folder picks, shared by every 报销类型; a form reacts through its onInvoices hook. */
import { $, api, cents, currentForm, droppedFiles, dropZone, leave, MAX_INVOICE_BYTES, pending, readFile, rowButton, state, toast, yuan } from './core.js';

const MAX_INVOICES = 10;
const CHECKS_AT_ONCE = 3;
let invoiceSeq = 0;

const isPdf = file => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

/** Each invoice is checked on its own: a bad file is marked, the others stay. */
function addInvoices(files) {
  const notes = [];
  const pdfs = files.filter(isPdf);
  if (pdfs.length < files.length) notes.push(`已忽略 ${files.length - pdfs.length} 个非 PDF 文件。`);
  const fresh = pdfs.filter(file => !state.invoices.some(item => item.file && item.file.name === file.name && item.file.size === file.size));
  if (fresh.length < pdfs.length) notes.push(`${pdfs.length - fresh.length} 个文件已在列表中，未重复添加。`);
  const room = MAX_INVOICES - state.invoices.length;
  if (fresh.length > room) notes.push(`一张报销单最多 ${MAX_INVOICES} 张发票，另有 ${fresh.length - room} 个文件未添加。`);
  const added = fresh.slice(0, Math.max(0, room)).map(file => ({ id: ++invoiceSeq, file, name: file.name, status: 'checking', message: '等待识别…' }));
  state.invoices.push(...added);
  $('invoice-info').textContent = notes.join('\n');
  renderInvoices();
  checkInvoices(added);
}

/** Local recognition only. Whether OA already holds or reimbursed an invoice is learned when
 * the job uploads it: OA refuses an invoice on another bill and names that bill. */
async function checkInvoices(items) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, queue.length) }, async () => {
    while (queue.length) await checkInvoice(queue.shift());
  }));
}

async function checkInvoice(item) {
  const listed = () => state.invoices.includes(item);
  const mark = (status, message) => { if (listed()) Object.assign(item, { status, message }); renderInvoices(); };
  try {
    if (item.file && !item.number) {
      if (item.file.size > MAX_INVOICE_BYTES) return mark('bad', 'PDF 超过 8 MB。');
      mark('checking', '正在识别…');
      const { parts, skipped } = await api('POST', '/api/invoices/split', { name: item.file.name, base64: await readFile(item.file) });
      if (!listed()) return;
      const fill = (target, part) => Object.assign(target, { upload: { name: part.name, base64: part.base64 }, number: part.invoice.number,
        amount: part.invoice.amount || '', seller: part.invoice.seller || '', date: part.invoice.date || '' });
      if (parts.length > 1) return splitInvoiceRow(item, parts, skipped, fill);
      fill(item, parts[0]);
    }
    mark('ok', item.folderId ? '来自 OA 票夹，提交后直接关联。' : '已识别，提交后上传到票夹并关联。');
  } catch (error) {
    if (error.status === 401) leave('学校 OA 登录已失效，请重新登录。');
    else mark('error', `识别失败：${error.message}`);
  }
}

/** One PDF holding several invoices takes one row per invoice, in its place in the list. */
function splitInvoiceRow(item, parts, skipped, fill) {
  const room = MAX_INVOICES - state.invoices.length + 1;
  const rows = parts.slice(0, room).map(part => fill({ id: ++invoiceSeq, file: item.file, name: part.name,
    status: 'ok', message: '已识别，提交后上传到票夹并关联。' }, part));
  state.invoices.splice(state.invoices.indexOf(item), 1, ...rows);
  const notes = [`${item.file.name} 含 ${parts.length} 张发票，已按页拆成 ${rows.length} 行，提交时一次性上传。`];
  if (skipped.length) notes.push(`第 ${skipped.join('、')} 页没有发票号码（如行程单），未上传。`);
  if (rows.length < parts.length) notes.push(`一张报销单最多 ${MAX_INVOICES} 张发票，另有 ${parts.length - rows.length} 张未加入。`);
  $('invoice-info').textContent = [$('invoice-info').textContent, ...notes].filter(Boolean).join('\n');
  renderInvoices();
  checkInvoices(rows);
}

const INVOICE_LIMIT = 50000;
const sellerKey = name => String(name || '').normalize('NFKC').replace(/\s+/g, '');
const usedCents = item => cents(item.balance || item.amount);

/** Status of every row: its own check, then duplicates, then the 500 元 limits over the rows still counted. */
function assessInvoices() {
  const result = new Map();
  state.invoices.forEach((item, index) => {
    const first = item.number ? state.invoices.findIndex(other => other.number === item.number) : index;
    result.set(item, first !== index
      ? { status: 'bad', message: `与第 ${first + 1} 张发票号码相同，请删除其中一张。` }
      : { status: item.status, message: item.message });
  });
  const live = () => state.invoices.filter(item => result.get(item).status !== 'bad');
  const groups = new Map();
  for (const item of live()) {
    if (!item.seller || !item.date) continue;
    const key = `${sellerKey(item.seller)}|${item.date}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  for (const group of groups.values()) {
    const amounts = group.map(usedCents);
    if (group.length < 2 || amounts.some(value => value === null)) continue;
    const total = amounts.reduce((sum, value) => sum + value, 0);
    if (total < INVOICE_LIMIT) continue;
    const rows = group.map(item => state.invoices.indexOf(item) + 1).join('、');
    for (const item of group) {
      result.set(item, { status: 'bad', message: `第 ${rows} 张为同一销售方同日开具，合计 ${yuan((total / 100).toFixed(2))}，超过 499.99 元；请删除其中部分发票。` });
    }
  }
  return result;
}

/** The rows still counted: not refused, not duplicates, within the limits. */
function countedInvoices() {
  const assessed = assessInvoices();
  return state.invoices.filter(item => assessed.get(item).status !== 'bad');
}

/** Sum of what this form reimburses from the counted invoices (a folder invoice's balance). */
function invoiceTotal() {
  const amounts = countedInvoices().map(usedCents);
  return amounts.length && amounts.every(value => value !== null) ? amounts.reduce((sum, value) => sum + value, 0) : null;
}

function renderInvoices() {
  const assessed = assessInvoices();
  const rows = state.invoices.map((item, index) => {
    const { status, message } = assessed.get(item);
    const row = document.createElement('tr');
    row.className = status === 'ok' ? '' : status === 'checking' ? 'pending' : 'bad';
    const source = item.folderId ? `票夹：${item.folder}` : item.name;
    const parties = [item.seller, item.date].filter(Boolean).join('\n') || (item.number ? '未识别' : '—');
    const cells = [String(index + 1), source, item.number || '—', parties, item.amount ? yuan(item.amount) : item.number ? '未识别' : '—', message];
    row.append(...cells.map((text, column) => {
      const cell = document.createElement('td');
      if (column === 5 && status === 'checking') pending(cell, text);
      else cell.textContent = text;
      if (column === 4) cell.className = 'num';
      if (column === 1 || column === 3) cell.title = text;
      return cell;
    }));
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (item.status === 'error') actions.append(rowButton('重试', () => checkInvoice(item)));
    actions.append(rowButton('删除', () => {
      state.invoices = state.invoices.filter(other => other !== item);
      $('invoice-info').textContent = '';
      renderInvoices();
      renderFolder();
    }, 'danger'));
    row.append(actions);
    return row;
  });
  $('invoice-rows').replaceChildren(...rows);
  $('invoice-table').hidden = !rows.length;
  const total = invoiceTotal();
  const checking = state.invoices.filter(item => assessed.get(item).status === 'checking').length;
  const bad = state.invoices.filter(item => !['ok', 'checking'].includes(assessed.get(item).status)).length;
  $('invoice-count').textContent = `共 ${state.invoices.length} 张${checking ? `，${checking} 张核对中` : ''}${bad ? `，${bad} 张不可用` : ''}`;
  $('invoice-total').textContent = total === null ? '合计未知' : `合计 ${yuan((total / 100).toFixed(2))}`;
  currentForm()?.onInvoices?.();
}

/** OA folder picker: 未报销 invoices already uploaded; by default only whole ones (amount = balance). */
async function openFolder() {
  $('folder-panel').hidden = false;
  if (!state.folder) await loadFolder();
  else renderFolder();
}

let folderLoading = false;
async function loadFolder() {
  if (folderLoading) return;
  folderLoading = true;
  const started = Date.now();
  toast('已向学校 OA 发出票夹请求，每个票夹查询一次…', false, true);
  pending($('toast'), $('toast').textContent);
  pending($('folder-status'), '请求已发出，每个票夹读取最多 100 张未报销发票…');
  $('folder-rows').replaceChildren();
  $('folder-refresh').disabled = true;
  $('pick-folder-oa').disabled = true;
  try {
    const listed = await api('GET', '/api/oa/folder-invoices');
    state.folder = listed.invoices;
    state.folderTruncated = listed.truncated;
    state.folderPicked = new Set();
    renderFolder();
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    toast(`票夹请求完成，用时 ${seconds} 秒，共 ${state.folder.length} 张未报销发票。${listed.truncated ? '有票夹超过 100 张，只列出前 100 张。' : ''}`);
  } catch (error) {
    if (error.status === 401) { toast(''); leave('学校 OA 登录已失效，请重新登录。'); return; }
    $('folder-status').textContent = `读取失败：${error.message}`;
    toast(`票夹请求失败：${error.message}`, true);
  } finally {
    folderLoading = false;
    $('folder-refresh').disabled = false;
    $('pick-folder-oa').disabled = false;
  }
}

const folderKey = row => `${row.folderId}|${row.number}`;

function renderFolder() {
  if (!state.folder || $('folder-panel').hidden) return;
  const all = $('folder-all').checked, query = $('folder-search').value.trim().toLowerCase();
  const inList = new Set(state.invoices.map(item => item.number));
  const rows = state.folder.filter(row => (all || row.amount === row.balance)
    && (!query || `${row.number} ${row.seller} ${row.date} ${row.amount}`.toLowerCase().includes(query)));
  $('folder-rows').replaceChildren(...rows.map(row => {
    const key = folderKey(row), taken = inList.has(row.number);
    const tr = document.createElement('tr');
    if (!row.selectable) tr.className = 'pending';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = !row.selectable || taken;
    box.checked = state.folderPicked.has(key) && !box.disabled;
    box.addEventListener('change', () => {
      if (box.checked) state.folderPicked.add(key); else state.folderPicked.delete(key);
      renderFolderCount();
    });
    const pick = document.createElement('td');
    pick.append(box);
    const note = taken ? '已在发票列表中' : row.reason || row.checkState;
    tr.append(pick, ...[row.number, row.seller, row.date, yuan(row.amount), yuan(row.balance), [row.folder, note].filter(Boolean).join('：')].map((text, column) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (column === 3 || column === 4) cell.className = 'num';
      if (column === 1) cell.title = text;
      return cell;
    }));
    tr.addEventListener('click', event => { if (event.target !== box && !box.disabled) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } });
    return tr;
  }));
  const hidden = state.folder.length - state.folder.filter(row => all || row.amount === row.balance).length;
  $('folder-status').textContent = `OA 票夹中共 ${state.folder.length} 张未报销发票，显示 ${rows.length} 张`
    + (hidden ? `；另有 ${hidden} 张金额与可报金额不一致，勾选“显示全部”查看。` : '。')
    + (state.folderTruncated ? '有票夹超过 100 张，只列出了前 100 张。' : '');
  $('folder-empty').hidden = rows.length > 0;
  renderFolderCount();
}

function renderFolderCount() {
  const count = [...state.folderPicked].filter(key => state.folder.some(row => folderKey(row) === key)).length;
  $('folder-add').textContent = count ? `加入所选（${count} 张）` : '加入所选';
  $('folder-add').disabled = !count;
}

function addFolderInvoices() {
  const chosen = state.folder.filter(row => state.folderPicked.has(folderKey(row)) && row.selectable
    && !state.invoices.some(item => item.number === row.number));
  const room = MAX_INVOICES - state.invoices.length;
  const added = chosen.slice(0, Math.max(0, room)).map(row => ({ id: ++invoiceSeq, name: row.fileName || row.number, folderId: row.folderId,
    folder: row.folder, number: row.number, amount: row.amount, balance: row.balance, seller: row.seller, date: row.date,
    status: 'ok', message: '来自 OA 票夹，提交后直接关联。' }));
  state.invoices.push(...added);
  $('invoice-info').textContent = chosen.length > added.length ? `一张报销单最多 ${MAX_INVOICES} 张发票，另有 ${chosen.length - added.length} 张未加入。` : '';
  state.folderPicked = new Set();
  $('folder-panel').hidden = true;
  renderInvoices();
  checkInvoices(added);
}


function resetInvoices() {
  $('invoice-info').textContent = '';
  state.invoices = [];
  state.folder = null;
  state.folderPicked = new Set();
  $('folder-panel').hidden = true;
  renderInvoices();
}

/** File pickers, the OA folder picker and the drop zone of 发票. */
function initInvoices() {
  for (const input of [$('invoice'), $('invoice-folder')]) {
    input.addEventListener('change', () => { addInvoices([...input.files]); input.value = ''; });
  }
  $('pick-folder-oa').addEventListener('click', () => openFolder());
  $('folder-refresh').addEventListener('click', () => loadFolder());
  $('folder-close').addEventListener('click', () => { $('folder-panel').hidden = true; });
  $('folder-add').addEventListener('click', addFolderInvoices);
  $('folder-all').addEventListener('change', renderFolder);
  $('folder-search').addEventListener('input', renderFolder);
  $('pick-files').addEventListener('click', () => $('invoice').click());
  $('pick-folder').addEventListener('click', () => $('invoice-folder').click());
  dropZone($('drop'), async transfer => addInvoices(await droppedFiles(transfer)),
    error => { $('invoice-info').textContent = `未能读取拖入的文件：${error.message}`; });
}

export { addInvoices, assessInvoices, countedInvoices, initInvoices, invoiceTotal, renderInvoices, resetInvoices };
