/** 行程附件 → 境内差旅单 legs. Attachments are parsed in memory and never stored; this module is
 * pure: it reads what infrastructure/itinerary-files extracted (text rows, embedded XML) and
 * assembles legs in the shape of the page's traveller table. Amounts are yuan strings, 2 decimals. */

export type ItineraryItem =
  | { type: 'train'; file: string; passenger: string; number: string; date: string; time: string; from: string; to: string;
    fromStation: string; toStation: string; fare: string; seat: string; invoiceNumber: string; refund: boolean }
  | { type: 'flight'; file: string; order: string; number: string; date: string; time: string; arriveDate: string; arriveTime: string;
    from: string; to: string; fromCode: string; toCode: string; total: string }
  | { type: 'flight_other'; file: string; order: string; total: string }
  | { type: 'hotel'; file: string; guest: string; arrival: string; departure: string; nights: number; amount: string;
    /** Folios print DD/MM or MM/DD; when both read as dates, the trip decides (see buildItinerary). */
    alternatives?: Array<{ arrival: string; departure: string }> }
  | { type: 'hotel_invoice' | 'meeting_invoice'; file: string; amount: string; seller: string; date: string }
  | { type: 'document'; file: string; title: string }
  | { type: 'unknown'; file: string; reason: string };

export interface ItineraryLeg {
  startDate: string; startAddress: string; arriveDate: string; arriveAddress: string;
  vehicle: 'aircraft' | 'train'; trafficExpense: string; travelDays: number;
  hotelExpense: string; meetingAmount: string;
  /** Where the leg came from, e.g. "G252 长沙南→上海虹桥 一等座（火车票.pdf）". */
  source: string;
}
export interface ItineraryGroup {
  /** From the rail ticket; null for flights, which carry no readable passenger name. */
  passenger: string | null;
  legs: ItineraryLeg[];
}
export interface Itinerary {
  groups: ItineraryGroup[];
  /** 携程 order numbers of the flights: the same numbers as 携程借款单 订单号. */
  ctripOrders: string[];
  /** Suggested 报销事由 from a meeting notice or schedule. */
  reason?: string;
  /** Folio dates as read against the trip (a DD/MM vs MM/DD folio is settled here). */
  hotels: Array<{ file: string; arrival: string; departure: string; nights: number }>;
  warnings: string[];
}

/** Airports of the 携程 flight pages (their Chinese names are not in the text layer). */
export const AIRPORT_CITIES: Record<string, string> = {
  PVG: '上海', SHA: '上海', PEK: '北京', PKX: '北京', CAN: '广州', SZX: '深圳', CSX: '长沙', NKG: '南京', DLC: '大连', WEH: '威海',
  HGH: '杭州', CTU: '成都', TFU: '成都', CKG: '重庆', XIY: '西安', WUH: '武汉', TAO: '青岛', XMN: '厦门', KMG: '昆明', TSN: '天津',
  SHE: '沈阳', HRB: '哈尔滨', CGO: '郑州', TNA: '济南', FOC: '福州', NNG: '南宁', HAK: '海口', SYX: '三亚', KWE: '贵阳', CGQ: '长春',
  HFE: '合肥', KHN: '南昌', TYN: '太原', SJW: '石家庄', URC: '乌鲁木齐', LHW: '兰州', INC: '银川', XNN: '西宁', HET: '呼和浩特',
  LXA: '拉萨', NGB: '宁波', WNZ: '温州', YNT: '烟台', ZUH: '珠海', SWA: '揭阳', DYG: '张家界', LJG: '丽江', JHG: '西双版纳',
  WUX: '无锡', CZX: '常州', NTG: '南通', YTY: '扬州', XUZ: '徐州', LYI: '临沂', HKG: '香港', MFM: '澳门', TPE: '台北',
};

const money = (value: number) => value.toFixed(2);
const cents = (value: string) => Math.round(Number(value) * 100);
const pad = (value: number | string) => String(value).padStart(2, '0');
const validDate = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** 长沙南 → 长沙, 上海虹桥 → 上海, 南京南 → 南京; 济南 stays (one character would be left). */
export function stationCity(station: string): string {
  const name = station.trim().replace(/站$/, '');
  const stripped = name.replace(/(虹桥|南|北|东|西)$/, '');
  return stripped.length >= 2 ? stripped : name;
}

/** The 铁路电子客票 XBRL a 全电发票 PDF embeds (rai_issuer_*.xml). */
export function trainFromXml(xml: string, file: string): ItineraryItem | undefined {
  const value = (tag: string) => xml.match(new RegExp(`<rai:${tag}\\b[^>]*>([^<]*)</rai:${tag}>`))?.[1]?.trim() ?? '';
  if (!/铁路电子客票/.test(value('TypeOfVoucher'))) return undefined;
  const fare = value('Fare'), date = value('TravelDate');
  if (!/^\d+(\.\d{1,2})?$/.test(fare) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const refunded = value('AmountRefunded');
  return { type: 'train', file, passenger: value('Name'), number: value('TrainNumber'), date, time: value('DepartureTime'),
    fromStation: value('DepartureStation'), toStation: value('DestinationStation'),
    from: stationCity(value('DepartureStation')), to: stationCity(value('DestinationStation')),
    fare: money(Number(fare)), seat: value('SeatLevel'), invoiceNumber: value('ElectronicInvoiceRailwayETicketNumber'),
    refund: value('TypeOfBusiness') === '退' || (refunded !== '' && Number(refunded) > 0) };
}

/** A 携程 flight order page, from its text rows (see readInvoicePdf). The first "¥… x1" line is the
 * ticket + airport fee + fuel subtotal; what follows is each charge, so 总支付 = the sum after it
 * (it equals the 携程借款单 amount: 1233, 1383 and 882 checked 2026-10-22). */
export function flightFromRows(rows: string[], file: string): ItineraryItem | undefined {
  const text = rows.join('\n');
  const order = text.match(/(?:^|\D)(1\d{15})(?!\d)/m)?.[1];
  if (!order || !/ctrip/i.test(text)) return undefined;
  const items = [...text.matchAll(/¥(\d+(?:\.\d{1,2})?)\s*x(\d+)/g)];
  if (items.length < 2 || items.some(item => item[2] !== '1')) return { type: 'flight_other', file, order, total: '' };
  const total = money(items.slice(1).reduce((sum, item) => sum + Number(item[1]), 0));
  const booked = text.match(/(20\d\d) (\d{1,2}) (\d{1,2}) \d{1,2}:\d{2}:\d{2}/);
  const ends = rows.flatMap(row => {
    const match = row.trim().match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}:\d{2}) ([A-Z]{3})\b/);
    return match ? [{ month: Number(match[1]), day: Number(match[2]), time: match[3], code: match[4] }] : [];
  });
  // Airline codes may start with a digit (9C 春秋).
  const number = rows.map(row => row.match(/\d+h\d+m\s+([A-Z0-9][A-Z0-9]\d{3,4})\b/)?.[1]).find(Boolean);
  // A refund or a page without both ends of the flight gives no leg.
  if (!booked || ends.length !== 2 || !number) return { type: 'flight_other', file, order, total };
  const year = (month: number) => Number(booked[1]) + (month < Number(booked[2]) - 6 ? 1 : 0);
  const [out, back] = ends;
  if (!validDate(year(out.month), out.month, out.day) || !validDate(year(back.month), back.month, back.day)) {
    return { type: 'flight_other', file, order, total };
  }
  return { type: 'flight', file, order, number, date: iso(year(out.month), out.month, out.day), time: out.time,
    arriveDate: iso(year(back.month), back.month, back.day), arriveTime: back.time, fromCode: out.code, toCode: back.code,
    from: AIRPORT_CITIES[out.code] ?? out.code, to: AIRPORT_CITIES[back.code] ?? back.code, total };
}

/** A hotel folio (水单): guest, arrival/departure, amount due. */
export function hotelFromText(text: string, file: string): ItineraryItem | undefined {
  if (!/(Arrival|到店|到达|入住)/i.test(text) || !/(Departure|离店|离开)/i.test(text)) return undefined;
  const flat = text.normalize('NFKC');
  const amount = flat.match(/(?:应付总额|余额|Balance)\s*\/?\s*(?:Balance)?\s*[:：]?\s*([\d,]+\.\d{2})/i)?.[1]
    ?? flat.match(/(?:总计|Total)\s*\/?\s*(?:Total)?\s*[:：]?\s*([\d,]+\.\d{2})/i)?.[1];
  const guest = flat.match(/^\s*([一-龥]{2,4})\s+(?:到店|离店)/m)?.[1] ?? flat.match(/(?:客人姓名|姓名)\s*(?:Name)?\s*[:：]\s*([一-龥]{2,4})/i)?.[1]
    ?? flat.match(/\b([A-Z][a-z]+),\s*([A-Z][a-z]+)\b/)?.slice(1).reverse().join(' ') ?? '';
  // Opera folios also print ISO dates in a header: GA:2026-06-09|GD:2026-06-10.
  const header = flat.match(/GA:(\d{4}-\d{2}-\d{2})\|GD:(\d{4}-\d{2}-\d{2})/);
  let options: Array<{ arrival: string; departure: string }>;
  if (header) options = [{ arrival: header[1], departure: header[2] }];
  else {
    // The date after the label ("Departure : 04-08-26"); some folios print it just before ("04-08-26Departure").
    const near = (label: RegExp) => {
      const index = flat.search(label);
      if (index < 0) return undefined;
      // Year first (2026/06/1910:25:04 runs into the time, so the day takes two digits at most) or last.
      const date = /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})/g;
      const parts = (match: RegExpMatchArray | undefined) => (match ? (match[1] ? match.slice(0, 4) : [match[0], ...match.slice(4, 7)]) : undefined);
      const after = flat.slice(index, index + 40).match(new RegExp(date.source)) ?? undefined;
      const before = [...flat.slice(Math.max(0, index - 12), index).matchAll(date)].pop();
      return parts(after ?? before);
    };
    const a = near(/Arrival|到店日期|到达日期/i), d = near(/Departure|离店日期|离开日期/i);
    if (!a || !d) return undefined;
    const year = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));
    // 2026/06/17 (year first) is unambiguous; 09/06/2026 and 04-07-26 may be day- or month-first.
    const yearFirst = a[1].length === 4 && d[1].length === 4;
    options = (yearFirst ? [[3, 2, 1]] : [[1, 2, 3], [2, 1, 3]]).flatMap(([dayAt, monthAt, yearAt]) => {
      const arrival = [year(a[yearAt]), Number(a[monthAt]), Number(a[dayAt])] as const;
      const departure = [year(d[yearAt]), Number(d[monthAt]), Number(d[dayAt])] as const;
      if (!validDate(...arrival) || !validDate(...departure)) return [];
      const option = { arrival: iso(...arrival), departure: iso(...departure) };
      const nights = dayNumber(option.departure) - dayNumber(option.arrival);
      return nights >= 0 && nights <= 60 ? [option] : [];
    }).filter((option, index, all) => all.findIndex(other => other.arrival === option.arrival && other.departure === option.departure) === index);
  }
  if (!options.length) return undefined;
  const [first] = options;
  return { type: 'hotel', file, guest, arrival: first.arrival, departure: first.departure,
    nights: dayNumber(first.departure) - dayNumber(first.arrival), amount: amount ? money(Number(amount.replace(/,/g, ''))) : '',
    ...(options.length > 1 ? { alternatives: options } : {}) };
}

/** A 全电发票 for 住宿 or 会议/注册费: its 价税合计 goes to 住宿费 or 会务/注册费. */
export function invoiceFromText(text: string, file: string, amount: string | undefined): ItineraryItem | undefined {
  if (!amount || !/发票/.test(text)) return undefined;
  const flat = text.normalize('NFKC').replace(/\s+/g, '');
  const type = /住宿/.test(flat) ? 'hotel_invoice' : /会议|会务|注册费/.test(flat) ? 'meeting_invoice' : undefined;
  if (!type) return undefined;
  const date = flat.match(/开票日期[:：]?(\d{4})年(\d{2})月(\d{2})日/);
  // 销售方 名称; bank and address lines that also contain 名称 are not it.
  const seller = text.match(/名称[:：]\s*([^\n]+)/g)?.map(row => row.replace(/名称[:：]\s*/, '').trim())
    .find(name => !/上海科技大学|银行|账号|地址|电话/.test(name) && name.length <= 40) ?? '';
  return { type, file, amount, seller, date: date ? `${date[1]}-${date[2]}-${date[3]}` : '' };
}

const legOrder = (item: { date: string; time: string }) => `${item.date} ${item.time.padStart(5, '0')}`;

/** Legs per passenger in time order; the whole trip's days, 住宿费 and 会务费 go on the first leg
 * and the other legs get 0 days, as in the 2026-10-21 recording. Nothing here is final: the page
 * shows it for review and every cell stays editable. */
export function buildItinerary(items: ItineraryItem[]): Itinerary {
  const warnings: string[] = [];
  const named = (item: ItineraryItem) => `“${item.file}”`;
  const tickets = items.filter((item): item is Extract<ItineraryItem, { type: 'train' | 'flight' }> =>
    (item.type === 'train' && !item.refund) || item.type === 'flight');
  for (const item of items) {
    if (item.type === 'train' && item.refund) warnings.push(`${named(item)} 是退票，未生成行程；退票费请核对后填入“其他”。`);
    if (item.type === 'flight_other') warnings.push(`${named(item)} 是携程订单 ${item.order} 的退票、改签或无法读出航段的页面，未生成行程，请核对。`);
    if (item.type === 'flight' && (!AIRPORT_CITIES[item.fromCode] || !AIRPORT_CITIES[item.toCode])) {
      warnings.push(`${named(item)} 的机场代码 ${item.fromCode}/${item.toCode} 不在城市对照表中，请改成城市名。`);
    }
    if (item.type === 'unknown') warnings.push(`${named(item)} ${item.reason}`);
  }
  // Flights carry no readable passenger name: they go with a sole rail passenger, else unnamed.
  const passengers = [...new Set(tickets.flatMap(item => (item.type === 'train' && item.passenger ? [item.passenger] : [])))];
  const owner = (item: (typeof tickets)[number]) => (item.type === 'train' && item.passenger ? item.passenger
    : passengers.length === 1 ? passengers[0] : null);
  if (passengers.length > 1 && tickets.some(item => item.type === 'flight')) {
    warnings.push('火车票上有多位乘车人，机票页面读不出乘机人姓名，机票行程暂放在“未识别姓名”的出差人下，请移到对应的人。');
  }
  const groups = new Map<string | null, typeof tickets>();
  for (const item of [...tickets].sort((a, b) => legOrder(a).localeCompare(legOrder(b)))) {
    const key = owner(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const hotels = items.filter((item): item is Extract<ItineraryItem, { type: 'hotel' }> => item.type === 'hotel');
  type InvoiceItem = Extract<ItineraryItem, { type: 'hotel_invoice' | 'meeting_invoice' }>;
  const hotelInvoices = items.filter((item): item is InvoiceItem => item.type === 'hotel_invoice');
  const meetings = items.filter((item): item is InvoiceItem => item.type === 'meeting_invoice');
  const result: ItineraryGroup[] = [];
  let index = 0;
  for (const [passenger, legs] of groups) {
    const first = legs[0], last = legs[legs.length - 1];
    const end = last.type === 'flight' ? last.arriveDate : last.date;
    const days = dayNumber(end) - dayNumber(first.date) + 1;
    for (let i = 1; i < legs.length; i++) {
      const gap = dayNumber(legs[i].date) - dayNumber(legs[i - 1].type === 'flight' ? (legs[i - 1] as { arriveDate: string }).arriveDate : legs[i - 1].date);
      if (legs[i - 1].to !== legs[i].from) warnings.push(`${passenger ?? '机票'}：${legs[i - 1].to} 到达后下一段从 ${legs[i].from} 出发，中间缺少一段行程。`);
      if (gap > 7) warnings.push(`${passenger ?? '机票'}：${legs[i - 1].date} 与 ${legs[i].date} 相隔 ${gap} 天，像是两次出差，请分开报销。`);
    }
    if (last.type === 'flight' && last.arriveDate !== last.date) {
      warnings.push(`${passenger ?? '机票'}：最后一段 ${last.arriveTime} 次日到达，差旅天数按到达日计为 ${days} 天，请核对。`);
    }
    if (legs.length > 1 && first.from !== last.to) warnings.push(`${passenger ?? '机票'}：行程从 ${first.from} 出发、到 ${last.to} 结束，不是往返。`);
    // Folios: the reading whose dates fall inside this trip; 住宿费 from hotel invoices when there are any.
    const inTrip = (date: string) => dayNumber(date) >= dayNumber(first.date) && dayNumber(date) <= dayNumber(end);
    const stays = index === 0 ? hotels : [];
    for (const stay of stays) {
      const fit = (stay.alternatives ?? [stay]).filter(option => inTrip(option.arrival) && inTrip(option.departure));
      if (fit.length === 1) Object.assign(stay, fit[0], { nights: dayNumber(fit[0].departure) - dayNumber(fit[0].arrival) });
      else warnings.push(`${named(stay)} 的入住日期 ${stay.arrival}–${stay.departure} ${fit.length ? '有两种读法' : '不在行程日期内'}，请核对。`);
    }
    // 住宿费 follows the hotel invoices; a folio only stands in when no invoice was given.
    const sum = (list: Array<{ amount: string }>) => list.reduce((total, item) => total + cents(item.amount || '0'), 0);
    const folio = sum(stays);
    const hotelTotal = index === 0 ? (hotelInvoices.length ? sum(hotelInvoices) : folio) : 0;
    if (index === 0 && hotelInvoices.length && stays.length && folio !== hotelTotal) {
      warnings.push(`住宿费按酒店发票填 ${money(hotelTotal / 100)} 元；水单金额为 ${money(folio / 100)} 元。`);
    }
    if (index === 0 && !hotelInvoices.length && folio) {
      warnings.push(`没有识别到酒店发票，住宿费暂按水单金额 ${money(folio / 100)} 元填写；请以酒店发票金额为准（可把发票加入“发票”或“行程附件”）。`);
    }
    const meetingTotal = index === 0 ? sum(meetings) : 0;
    result.push({ passenger, legs: legs.map((item, at) => ({
      startDate: item.date, startAddress: item.from, arriveDate: item.type === 'flight' ? item.arriveDate : item.date,
      arriveAddress: item.to, vehicle: item.type === 'flight' ? 'aircraft' : 'train',
      trafficExpense: item.type === 'flight' ? item.total : item.fare, travelDays: at === 0 ? days : 0,
      hotelExpense: at === 0 && hotelTotal ? money(hotelTotal / 100) : '', meetingAmount: at === 0 && meetingTotal ? money(meetingTotal / 100) : '',
      source: item.type === 'flight' ? `${item.number} ${item.fromCode}→${item.toCode} ${item.time}，携程订单 ${item.order}（${item.file}）`
        : `${item.number} ${item.fromStation}→${item.toStation} ${item.time} ${item.seat}（${item.file}）`,
    })) });
    index++;
  }
  if (!tickets.length) warnings.push('附件中没有识别出火车票或机票，未生成行程。');
  if (hotels.length && result.length > 1) warnings.push('住宿费只填在第一位出差人的第一段行程上，请按实际情况调整。');
  const reason = items.find((item): item is Extract<ItineraryItem, { type: 'document' }> => item.type === 'document')?.title;
  return { groups: result, ctripOrders: [...new Set(tickets.flatMap(item => (item.type === 'flight' ? [item.order] : [])))],
    ...(reason ? { reason } : {}), hotels: hotels.map(({ file, arrival, departure, nights }) => ({ file, arrival, departure, nights })), warnings };
}

const FIELDS: Record<ItineraryItem['type'], { text: string[]; numbers?: string[]; flags?: string[] }> = {
  train: { text: ['file', 'passenger', 'number', 'date', 'time', 'from', 'to', 'fromStation', 'toStation', 'fare', 'seat', 'invoiceNumber'], flags: ['refund'] },
  flight: { text: ['file', 'order', 'number', 'date', 'time', 'arriveDate', 'arriveTime', 'from', 'to', 'fromCode', 'toCode', 'total'] },
  flight_other: { text: ['file', 'order', 'total'] },
  hotel: { text: ['file', 'guest', 'arrival', 'departure', 'amount'], numbers: ['nights'] },
  hotel_invoice: { text: ['file', 'amount', 'seller', 'date'] },
  meeting_invoice: { text: ['file', 'amount', 'seller', 'date'] },
  document: { text: ['file', 'title'] },
  unknown: { text: ['file', 'reason'] },
};
const DATE_FIELDS = new Set(['date', 'arriveDate', 'arrival', 'departure']);
const MONEY_FIELDS = new Set(['fare', 'total', 'amount']);

/** Items sent back by the page, re-checked field by field before buildItinerary sees them. */
export function sanitizeItems(value: unknown): ItineraryItem[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  const items: ItineraryItem[] = [];
  for (const raw of value) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const spec = data && typeof data.type === 'string' && Object.hasOwn(FIELDS, data.type) ? FIELDS[data.type as ItineraryItem['type']] : undefined;
    if (!data || !spec) return undefined;
    const item: Record<string, unknown> = { type: data.type };
    for (const key of spec.text) {
      const text = data[key];
      if (typeof text !== 'string' || text.length > 300 || /[\u0000-\u001f]/.test(text)) return undefined;
      if (DATE_FIELDS.has(key) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
      if (MONEY_FIELDS.has(key) && text !== '' && !/^\d{1,9}\.\d{2}$/.test(text)) return undefined;
      item[key] = text;
    }
    for (const key of spec.numbers ?? []) {
      if (!Number.isInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 366) return undefined;
      item[key] = data[key];
    }
    for (const key of spec.flags ?? []) item[key] = data[key] === true;
    if (data.type === 'hotel' && Array.isArray(data.alternatives)) {
      const options = data.alternatives.filter((option): option is { arrival: string; departure: string } => Boolean(option)
        && typeof option === 'object' && [option.arrival, option.departure].every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)))
        .slice(0, 2).map(option => ({ arrival: option.arrival, departure: option.departure }));
      if (options.length > 1) item.alternatives = options;
    }
    items.push(item as ItineraryItem);
  }
  return items;
}
