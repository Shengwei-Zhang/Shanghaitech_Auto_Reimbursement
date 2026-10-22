/** 票据 of a 境内差旅单, all in one place: every file is parsed on this machine and sorted into 发票 (uploaded to
 * OA's 票夹 with the form) and 其他票据 (parsed only, never stored); then the travellers and legs, the 携程借款单
 * and, through them, the amounts are filled in. */
import { $, api, droppedFiles, dropZone, leave, MAX_INVOICE_BYTES, pending, readFile, rowButton, state, toast } from './core.js';
import { addInvoices, renderInvoices } from './invoices.js';
import { lookupTraveller, paintBorrows, renderCtripPicked, renderLines, renderTravellers, VEHICLES } from './travel.js';

const ITINERARY_TYPES = { train: '火车票', flight: '机票订单', flight_other: '携程退改', hotel: '酒店水单', hotel_invoice: '住宿发票',
  meeting_invoice: '会议注册发票', flight_invoice: '机票行程单', other_invoice: '其他发票', document: '通知/日程', unknown: '未识别' };
/** What OA's 票夹 takes: every 全电发票, the rail e-ticket included. The rest is read for the legs only. */
const INVOICE_TYPES = new Set(['train', 'hotel_invoice', 'meeting_invoice', 'flight_invoice', 'other_invoice']);
const ITINERARY_EXT = /\.(pdf|docx|png|jpe?g)$/i;
const fileKey = file => `${file.name}|${file.size}|${file.lastModified}`;
/** applied: the travellers as last filled in from the 票据, so a later file may refill them while nobody edited them.
 * picked: `fund|order` loans already picked for the user once (an unpicked one is not picked again). */
state.itinerary = { files: [], cache: new Map(), result: null, seq: 0, applied: null, picked: new Set() };

const isInvoiceEntry = entry => entry.status === 'done' && entry.items.some(item => INVOICE_TYPES.has(item.type));

function itemSummary(item) {
  switch (item.type) {
    case 'train': return `${item.date} ${item.time} ${item.number} ${item.fromStation}→${item.toStation} ${item.seat} ${item.fare} 元${item.passenger ? `，乘车人 ${item.passenger}` : ''}${item.refund ? '（退票）' : ''}`;
    case 'flight': return `${item.date} ${item.time} ${item.number} ${item.from}→${item.to}（${item.fromCode}→${item.toCode}）实付 ${item.total} 元，携程订单 ${item.order}`;
    case 'flight_other': return `携程订单 ${item.order}${item.total ? `，金额 ${item.total} 元` : ''}：退票、改签或无法读出航段`;
    case 'hotel': {
      // A DD/MM vs MM/DD folio is settled against the trip by the server.
      const stay = state.itinerary.result?.hotels?.find(hotel => hotel.file === item.file) ?? item;
      return `${stay.arrival} 至 ${stay.departure}，${stay.nights} 晚${item.amount ? `，${item.amount} 元` : ''}${item.guest ? `，${item.guest}` : ''}`;
    }
    case 'hotel_invoice': case 'meeting_invoice': case 'other_invoice':
      return `${item.amount} 元${item.seller ? `，${item.seller}` : ''}${item.date ? `，开票 ${item.date}` : ''}`;
    case 'flight_invoice': return `${item.amount} 元${item.seller ? `，${item.seller}` : ''}；机票费用按携程订单的实付金额计`;
    case 'document': return item.title;
    default: return item.reason;
  }
}

/** The 票据 plus invoices picked from OA's 票夹 that came with a file (their 住宿/会议 amounts count too). */
function itinerarySources() {
  const own = state.itinerary.files.map(entry => ({ entry, file: entry.file }));
  const invoices = state.invoices.filter(item => item.file && !own.some(source => fileKey(source.file) === fileKey(item.file)))
    .filter((item, index, list) => list.findIndex(other => other.file === item.file) === index)
    .map(item => ({ entry: null, file: item.file }));
  return [...own, ...invoices];
}

async function parseItineraryFile(file) {
  const key = fileKey(file);
  if (!state.itinerary.cache.has(key)) {
    const run = (async () => {
      if (file.size > MAX_INVOICE_BYTES) throw new Error('超过 8 MB');
      return (await api('POST', '/api/travel/parse', { name: file.name, base64: await readFile(file) })).items;
    })();
    state.itinerary.cache.set(key, run);
    run.catch(() => state.itinerary.cache.delete(key));
  }
  return state.itinerary.cache.get(key);
}

function addItineraryFiles(files) {
  const usable = files.filter(file => ITINERARY_EXT.test(file.name) && !file.name.startsWith('.'));
  const fresh = usable.filter(file => !state.itinerary.files.some(entry => fileKey(entry.file) === fileKey(file)));
  for (const file of fresh) state.itinerary.files.push({ id: ++state.itinerary.seq, file, status: 'parsing', items: [] });
  const skipped = files.length - usable.length;
  if (skipped) toast(`已忽略 ${skipped} 个不是 PDF、Word 或图片的文件。`);
  renderItinerary();
  rebuildItinerary();
}

/** A 票据 that is an invoice goes to 发票 (OA's 票夹) as soon as it is recognized. */
function fileInvoices() {
  const fresh = state.itinerary.files.filter(entry => isInvoiceEntry(entry)
    && !state.invoices.some(item => item.file && fileKey(item.file) === fileKey(entry.file)));
  if (fresh.length) addInvoices(fresh.map(entry => entry.file));
}

function removeFile(entry) {
  state.itinerary.files = state.itinerary.files.filter(other => other !== entry);
  // Its invoice rows (one per page of a multi-invoice PDF) leave 发票 with it.
  const kept = state.invoices.filter(item => !(item.file && fileKey(item.file) === fileKey(entry.file)));
  if (kept.length !== state.invoices.length) { state.invoices = kept; renderInvoices(); }
  renderItinerary();
  rebuildItinerary();
}

let itinerarySeq = 0;
/** Parses what is not parsed yet (three at a time), asks the server to assemble the legs, then fills them in. */
async function rebuildItinerary() {
  const seq = ++itinerarySeq;
  const sources = itinerarySources();
  if (!sources.length) { state.itinerary.result = null; return renderItinerary(); }
  const queue = [...sources];
  const items = new Map();
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      try {
        const parsed = await parseItineraryFile(source.file);
        items.set(source, parsed);
        if (source.entry) Object.assign(source.entry, { status: 'done', items: parsed });
      } catch (error) {
        if (error.status === 401) return leave('学校 OA 登录已失效，请重新登录。');
        if (source.entry) Object.assign(source.entry, { status: 'error', message: error.message });
      }
      if (seq === itinerarySeq) { fileInvoices(); renderItinerary(); }
    }
  }));
  if (seq !== itinerarySeq) return;
  const all = sources.flatMap(source => items.get(source) ?? []);
  try {
    state.itinerary.result = all.length ? (await api('POST', '/api/travel/itinerary', { items: all })).itinerary : null;
  } catch (error) {
    state.itinerary.result = { groups: [], ctripOrders: [], warnings: [`行程整理失败：${error.message}`] };
  }
  if (seq !== itinerarySeq) return;
  autoApply();
  pickBorrows();
  renderItinerary();
}

/** The travellers as the user sees them (OA's codes, looked up after, left out). */
const travellerShape = () => JSON.stringify(state.travellers.map(item => [item.name.trim(),
  item.legs.map(leg => Object.values({ ...leg }).map(value => String(value).trim()))]));
const travellersBlank = () => state.travellers.every(item => !item.name.trim()
  && item.legs.every(leg => Object.values(leg).every(value => !String(value).trim() || value === 'train' || value === 'aircraft')));

/** Fills in the legs by itself while the travellers are blank or still as the 票据 last filled them; once edited, only the button does. */
function autoApply() {
  if (!state.itinerary.result?.groups.length) return;
  if (travellersBlank() || travellerShape() === state.itinerary.applied) applyItinerary(false);
}

function applyItinerary(ask = true) {
  const result = state.itinerary.result;
  if (!result?.groups.length) return;
  if (ask && !travellersBlank() && travellerShape() !== state.itinerary.applied
    && !window.confirm('将用票据识别出的行程替换当前填写的出差人与行程，确定吗？')) return;
  // A traveller already found keeps its 类别 and 学号/工号.
  const before = state.travellers;
  const firstName = before[0]?.name.trim() || '';
  state.travellers = result.groups.map((group, index) => {
    const name = group.passenger ?? (index ? '' : firstName);
    const known = before.find(item => name && item.name.trim() === name) ?? (index ? undefined : before[0]);
    const same = known && known.name.trim() === name;
    return { kind: known?.kind || 'staff', code: same ? known.code : '', name, matches: same ? known.matches : null,
      legs: group.legs.map(leg => ({ startDate: leg.startDate, startAddress: leg.startAddress, arriveDate: leg.arriveDate,
        arriveAddress: leg.arriveAddress, vehicle: leg.vehicle, trafficExpense: leg.trafficExpense, travelDays: String(leg.travelDays),
        subsidyAmount: '', hotelExpense: leg.hotelExpense, meetingAmount: leg.meetingAmount, otherAmount: leg.otherAmount ?? '' })) };
  });
  renderTravellers();
  // Each named traveller not found yet is looked up in OA, as if the name had been typed.
  for (const traveller of state.travellers) if (traveller.name && !traveller.code) lookupTraveller(traveller, renderTravellers);
  if (result.reason) {
    if (!$('reason').value.trim()) $('reason').value = result.reason;
    if (state.lines?.[0] && !state.lines[0].purpose.trim()) { state.lines[0].purpose = result.reason; renderLines(); }
  }
  state.itinerary.applied = travellerShape();
  const legs = result.groups.reduce((sum, group) => sum + group.legs.length, 0);
  toast(`已按票据填入 ${result.groups.length} 位出差人、${legs} 段行程，请逐项核对；补贴按 OA 每日标准计算。`);
}

/** The 携程借款单 of the flights read, once the fund's loans are listed; each is picked for the user once. */
function pickBorrows() {
  const orders = state.itinerary.result?.ctripOrders ?? [];
  const { fund, borrows, picked } = state.ctrip;
  if (!orders.length || !borrows.length) return;
  const found = borrows.filter(item => orders.includes(item.order) && !picked.includes(item) && !state.itinerary.picked.has(`${fund}|${item.order}`));
  if (!found.length) return;
  for (const item of found) state.itinerary.picked.add(`${fund}|${item.order}`);
  picked.push(...found);
  renderCtripPicked();
  paintBorrows();
  toast(`已按机票订单勾选 ${found.length} 张携程借款单，按未清余额冲账。`);
}

/** What became of the 携程 orders read from the flights. */
function ctripStatus() {
  const orders = state.itinerary.result?.ctripOrders ?? [];
  if (!orders.length) return '';
  const { fund, borrows, picked } = state.ctrip;
  if (!fund) return `机票订单 ${orders.join('、')}：选择经费后自动勾选对应的携程借款单。`;
  if (!borrows.length) return `机票订单 ${orders.join('、')}：正在查询或该经费下没有未清的携程借款单。`;
  const chosen = orders.filter(order => picked.some(item => item.order === order));
  const missing = orders.filter(order => !borrows.some(item => item.order === order));
  return [chosen.length ? `已勾选携程借款单：订单 ${chosen.join('、')}。` : '',
    missing.length ? `订单 ${missing.join('、')} 不在该经费的未清借款中（可能已冲销，或不是携程借款支付）。` : ''].filter(Boolean).join('');
}

function renderItinerary() {
  const { files, result } = state.itinerary;
  $('itinerary-result').hidden = !files.length;
  const row = (cells, className = '') => {
    const tr = document.createElement('tr');
    tr.className = className;
    for (const value of cells) {
      const td = document.createElement('td');
      td.append(value);
      tr.append(td);
    }
    return tr;
  };
  const destination = entry => {
    const invoice = isInvoiceEntry(entry);
    return Object.assign(document.createElement('span'), { className: invoice ? 'badge' : 'badge plain', textContent: invoice ? '上传票夹' : '仅解析' });
  };
  const fileRows = entry => {
    const remove = rowButton('删除', () => removeFile(entry), 'danger');
    if (entry.status === 'parsing') return [row([entry.file.name, pending(document.createElement('span'), '识别中'), '', '', remove], 'pending')];
    if (entry.status === 'error') return [row([entry.file.name, '识别失败', entry.message, '', remove], 'bad')];
    return entry.items.map((item, index) => row([index ? '' : entry.file.name, ITINERARY_TYPES[item.type] || item.type, itemSummary(item),
      index ? '' : destination(entry), index ? '' : remove], item.type === 'unknown' || item.type === 'flight_other' ? 'bad' : ''));
  };
  const group = (title, entries) => (entries.length ? [Object.assign(document.createElement('tr'), { className: 'group' }), ...entries.flatMap(fileRows)] : [])
    .map((tr, index) => {
      if (index) return tr;
      tr.append(Object.assign(document.createElement('th'), { colSpan: 5, textContent: `${title}（${entries.length}）` }));
      return tr;
    });
  const done = files.filter(entry => entry.status === 'done');
  $('itinerary-file-rows').replaceChildren(
    ...group('发票：提交时上传到 OA 票夹', done.filter(isInvoiceEntry)),
    ...group('其他票据：只在本机解析，不上传', done.filter(entry => !isInvoiceEntry(entry))),
    ...group('正在识别或识别失败', files.filter(entry => entry.status !== 'done')));
  const groups = result?.groups ?? [];
  $('itinerary-review').hidden = !result;
  $('itinerary-preview').replaceChildren(...groups.map(item => {
    const box = document.createElement('div');
    box.className = 'itinerary-group';
    const title = document.createElement('h3');
    title.textContent = `识别出的行程 · 出差人：${item.passenger ?? '（机票上读不出姓名，填入第一位出差人）'}，${item.legs.length} 段`;
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'invoices';
    const head = document.createElement('tr');
    head.append(...['启程', '出发地', '到达', '目的地', '交通工具', '交通费', '天数', '住宿费', '会务/注册费', '其他', '来源']
      .map(text => Object.assign(document.createElement('th'), { textContent: text })));
    const body = document.createElement('tbody');
    body.append(...item.legs.map(leg => {
      const tr = row([leg.startDate, leg.startAddress, leg.arriveDate, leg.arriveAddress, VEHICLES[leg.vehicle], leg.trafficExpense,
        String(leg.travelDays), leg.hotelExpense || '—', leg.meetingAmount || '—', leg.otherAmount || '—', leg.source]);
      tr.lastChild.className = 'source';
      return tr;
    }));
    const thead = document.createElement('thead');
    thead.append(head);
    table.append(thead, body);
    scroll.append(table);
    box.append(title, scroll);
    return box;
  }));
  $('itinerary-warnings').replaceChildren(...(result?.warnings ?? []).map(text => Object.assign(document.createElement('li'), { textContent: text })));
  const applied = groups.length && travellerShape() === state.itinerary.applied;
  $('itinerary-status').textContent = [groups.length ? (applied ? '出差人与行程已按票据填入（下方可修改）。'
    : '出差人与行程已有手工修改，新识别的行程未自动覆盖；需要时点“用票据重新填入”。') : '', ctripStatus()].filter(Boolean).join(' ');
  $('itinerary-apply').disabled = files.some(entry => entry.status === 'parsing') || !groups.length;
}

function resetItinerary() {
  Object.assign(state.itinerary, { files: [], result: null, applied: null, picked: new Set() });
  renderItinerary();
}

function initItinerary() {
  for (const input of [$('itinerary-files'), $('itinerary-folder')]) {
    input.addEventListener('change', () => { addItineraryFiles([...input.files]); input.value = ''; });
  }
  $('itinerary-pick-files').addEventListener('click', () => $('itinerary-files').click());
  $('itinerary-pick-folder').addEventListener('click', () => $('itinerary-folder').click());
  // OA's 票夹 picker of 发票, for invoices uploaded earlier.
  $('itinerary-pick-oa').addEventListener('click', () => $('pick-folder-oa').click());
  dropZone($('itinerary-drop'), async transfer => addItineraryFiles(await droppedFiles(transfer)),
    error => toast(`未能读取拖入的文件：${error.message}`, true));
  // Re-reads first, so invoices picked from 票夹 afterwards still count.
  $('itinerary-apply').addEventListener('click', async () => { await rebuildItinerary(); applyItinerary(); renderItinerary(); });
  $('itinerary-clear').addEventListener('click', () => {
    for (const entry of [...state.itinerary.files]) state.invoices = state.invoices.filter(item => !(item.file && fileKey(item.file) === fileKey(entry.file)));
    renderInvoices();
    resetItinerary();
  });
  document.addEventListener('ctrip-borrows', () => { pickBorrows(); renderItinerary(); });
}

export { initItinerary, resetItinerary };
