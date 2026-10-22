/** 行程附件 of a 境内差旅单: tickets, folios and notices parsed on this machine, reviewed, then filled in. */
import { $, api, droppedFiles, dropZone, leave, MAX_INVOICE_BYTES, pending, readFile, rowButton, state, toast } from './core.js';
import { addInvoices } from './invoices.js';
import { lookupTraveller, paintBorrows, renderCtripPicked, renderLines, renderTravellers, VEHICLES } from './travel.js';

/* ---------- 行程附件 (境内差旅单): parsed in memory on this machine, then reviewed and filled in ---------- */
const ITINERARY_TYPES = { train: '火车票', flight: '机票', flight_other: '携程退改', hotel: '酒店水单', hotel_invoice: '住宿发票',
  meeting_invoice: '会务发票', document: '通知/日程', unknown: '未识别' };
const ITINERARY_EXT = /\.(pdf|docx|png|jpe?g)$/i;
const fileKey = file => `${file.name}|${file.size}|${file.lastModified}`;
state.itinerary = { files: [], cache: new Map(), result: null, seq: 0 };

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
    case 'hotel_invoice': case 'meeting_invoice': return `${item.amount} 元${item.seller ? `，${item.seller}` : ''}${item.date ? `，开票 ${item.date}` : ''}`;
    case 'document': return item.title;
    default: return item.reason;
  }
}

/** The page's own files plus the PDFs already in 发票 (their 住宿/会议 amounts count too). */
function itinerarySources() {
  const own = state.itinerary.files.map(entry => ({ entry, file: entry.file, invoice: false }));
  const invoices = state.invoices.filter(item => item.file && !own.some(source => fileKey(source.file) === fileKey(item.file)))
    .map(item => ({ entry: null, file: item.file, invoice: true }));
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

let itinerarySeq = 0;
/** Parses what is not parsed yet (three at a time), then asks the server to assemble the legs. */
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
      if (seq === itinerarySeq) renderItinerary();
    }
  }));
  if (seq !== itinerarySeq) return;
  const all = sources.flatMap(source => items.get(source) ?? []);
  try {
    state.itinerary.result = all.length ? (await api('POST', '/api/travel/itinerary', { items: all })).itinerary : null;
    state.itinerary.items = all;
  } catch (error) {
    state.itinerary.result = { groups: [], ctripOrders: [], warnings: [`行程整理失败：${error.message}`] };
  }
  if (seq === itinerarySeq) renderItinerary();
}

function renderItinerary() {
  const { files, result } = state.itinerary;
  const invoiceSources = itinerarySources().filter(source => source.invoice);
  $('itinerary-result').hidden = !files.length && !invoiceSources.length;
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
  $('itinerary-file-rows').replaceChildren(
    ...files.flatMap(entry => {
      const remove = rowButton('删除', () => {
        state.itinerary.files = state.itinerary.files.filter(other => other !== entry);
        renderItinerary();
        rebuildItinerary();
      }, 'danger');
      if (entry.status === 'parsing') return [row([entry.file.name, pending(document.createElement('span'), '解析中'), '', remove], 'pending')];
      if (entry.status === 'error') return [row([entry.file.name, '解析失败', entry.message, remove], 'bad')];
      return entry.items.map((item, index) => row([index ? '' : entry.file.name, ITINERARY_TYPES[item.type] || item.type, itemSummary(item),
        index ? '' : remove], item.type === 'unknown' || item.type === 'flight_other' ? 'bad' : ''));
    }),
    ...invoiceSources.map(source => row([`${source.file.name}（发票）`, '一并解析', '已在“发票”中，住宿或会务金额会计入行程', ''], 'pending')));
  const groups = result?.groups ?? [];
  $('itinerary-preview').replaceChildren(...groups.map(group => {
    const box = document.createElement('div');
    box.className = 'itinerary-group';
    const title = document.createElement('h3');
    title.textContent = `出差人：${group.passenger ?? '（机票上读不出姓名，填入第一位出差人）'}，${group.legs.length} 段行程`;
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'invoices';
    const head = document.createElement('tr');
    head.append(...['启程', '出发地', '到达', '目的地', '交通工具', '交通费', '天数', '住宿费', '会务/注册费', '来源']
      .map(text => Object.assign(document.createElement('th'), { textContent: text })));
    const body = document.createElement('tbody');
    body.append(...group.legs.map(leg => {
      const tr = row([leg.startDate, leg.startAddress, leg.arriveDate, leg.arriveAddress, VEHICLES[leg.vehicle], leg.trafficExpense,
        String(leg.travelDays), leg.hotelExpense || '—', leg.meetingAmount || '—', leg.source]);
      tr.lastChild.className = 'source';
      return tr;
    }));
    table.append(Object.assign(document.createElement('thead'), {}), body);
    table.firstChild.append(head);
    scroll.append(table);
    box.append(title, scroll);
    return box;
  }));
  $('itinerary-warnings').replaceChildren(...(result?.warnings ?? []).map(text => Object.assign(document.createElement('li'), { textContent: text })));
  const busy = files.some(entry => entry.status === 'parsing');
  $('itinerary-apply').disabled = busy || !groups.length;
  const orders = result?.ctripOrders ?? [];
  $('itinerary-ctrip').hidden = !orders.length;
  $('itinerary-ctrip').textContent = `勾选匹配的携程借款单（${orders.length} 个订单）`;
  const tickets = itineraryTickets();
  $('itinerary-invoices').hidden = !tickets.length;
  $('itinerary-invoices').textContent = `把 ${tickets.length} 张火车票加入发票`;
}

/** Rail e-tickets are invoices too; the ones not yet in 发票. */
function itineraryTickets() {
  return state.itinerary.files.filter(entry => entry.items.some(item => item.type === 'train')
    && !state.invoices.some(item => item.file && fileKey(item.file) === fileKey(entry.file))).map(entry => entry.file);
}

function applyItinerary() {
  const result = state.itinerary.result;
  if (!result?.groups.length) return;
  const filled = state.travellers.some(item => item.name.trim() || item.legs.some(leg => leg.startDate || leg.trafficExpense));
  if (filled && !window.confirm('将用解析出的行程替换当前填写的出差人与行程，确定吗？')) return;
  const firstName = state.travellers[0]?.name.trim() || '';
  const firstKind = state.travellers[0]?.kind || 'staff';
  state.travellers = result.groups.map((group, index) => ({ kind: index ? 'staff' : firstKind, code: '',
    name: group.passenger ?? (index ? '' : firstName), matches: null,
    legs: group.legs.map(leg => ({ startDate: leg.startDate, startAddress: leg.startAddress, arriveDate: leg.arriveDate,
      arriveAddress: leg.arriveAddress, vehicle: leg.vehicle, trafficExpense: leg.trafficExpense, travelDays: String(leg.travelDays),
      subsidyAmount: '', hotelExpense: leg.hotelExpense, meetingAmount: leg.meetingAmount, otherAmount: '' })) }));
  renderTravellers();
  // Each named traveller is looked up in OA, as if the name had been typed.
  for (const traveller of state.travellers) if (traveller.name) lookupTraveller(traveller, renderTravellers);
  if (result.reason) {
    if (!$('reason').value.trim()) $('reason').value = result.reason;
    if (state.lines?.[0] && !state.lines[0].purpose.trim()) { state.lines[0].purpose = result.reason; renderLines(); }
  }
  toast(`已填入 ${result.groups.reduce((sum, group) => sum + group.legs.length, 0)} 段行程，请逐项核对；补贴按 OA 每日标准计算。`);
  $('travellers').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pickItineraryBorrows() {
  const orders = state.itinerary.result?.ctripOrders ?? [];
  if (!state.ctrip.borrows.length) return toast('请先选择经费，等携程借款单列表加载后再点。', true);
  const found = state.ctrip.borrows.filter(item => orders.includes(item.order) && !state.ctrip.picked.includes(item));
  state.ctrip.picked.push(...found);
  renderCtripPicked();
  paintBorrows();
  const missing = orders.filter(order => !state.ctrip.borrows.some(item => item.order === order));
  toast(`${found.length ? `已勾选 ${found.length} 张携程借款单。` : '没有新的可勾选借款单。'}${missing.length ? `订单 ${missing.join('、')} 不在该经费的未清借款中（可能已冲销，或不是携程借款支付）。` : ''}`, Boolean(missing.length));
}


function resetItinerary() {
  state.itinerary.files = [];
  state.itinerary.result = null;
  renderItinerary();
}

function initItinerary() {
  for (const input of [$('itinerary-files'), $('itinerary-folder')]) {
    input.addEventListener('change', () => { addItineraryFiles([...input.files]); input.value = ''; });
  }
  $('itinerary-pick-files').addEventListener('click', () => $('itinerary-files').click());
  $('itinerary-pick-folder').addEventListener('click', () => $('itinerary-folder').click());
  dropZone($('itinerary-drop'), async transfer => addItineraryFiles(await droppedFiles(transfer)),
    error => toast(`未能读取拖入的文件：${error.message}`, true));
  // Apply re-reads first, so invoices added to 发票 afterwards still count.
  $('itinerary-apply').addEventListener('click', async () => { await rebuildItinerary(); applyItinerary(); });
  $('itinerary-ctrip').addEventListener('click', pickItineraryBorrows);
  $('itinerary-invoices').addEventListener('click', () => { addInvoices(itineraryTickets()); renderItinerary(); });
  $('itinerary-clear').addEventListener('click', resetItinerary);
}

export { initItinerary, resetItinerary };
