const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PDFDocument } = require('pdf-lib');
const { trainFromXml, flightFromRows, hotelFromText, invoiceFromText, buildItinerary, sanitizeItems, stationCity }
  = require('../dist/domain/itinerary.js');
const { parseItineraryFile, docxText } = require('../dist/infrastructure/itinerary-files.js');

// Synthetic documents shaped like the 2026-10-22 samples (no real tickets are stored here).
const railXml = ({ name = '张三', from = '长沙南', to = '上海虹桥', train = 'G252', date = '2026-04-08', time = '18:40', fare = '786.00',
  business = '售', refunded = '' } = {}) => `<?xml version="1.0" encoding="UTF-8"?><xbrl xmlns:rai="http://xbrl.mof.gov.cn/taxonomy/2021-11-30/rai">
<rai:TypeOfVoucher contextRef="c">电子发票（铁路电子客票）</rai:TypeOfVoucher>
<rai:ElectronicInvoiceRailwayETicketNumber contextRef="c">26429165818000000001</rai:ElectronicInvoiceRailwayETicketNumber>
<rai:DateOfIssue contextRef="c">2026-09-19</rai:DateOfIssue>
<rai:TypeOfBusiness contextRef="c">${business}</rai:TypeOfBusiness><rai:DepartureStation contextRef="c">${from}</rai:DepartureStation>
<rai:DestinationStation contextRef="c">${to}</rai:DestinationStation><rai:TrainNumber contextRef="c">${train}</rai:TrainNumber>
<rai:TravelDate contextRef="c">${date}</rai:TravelDate><rai:DepartureTime contextRef="c">${time}</rai:DepartureTime>
<rai:SeatLevel contextRef="c">一等座</rai:SeatLevel><rai:Fare contextRef="c" unitRef="CNY" decimals="2">${fare}</rai:Fare>
${refunded ? `<rai:AmountRefunded contextRef="c" unitRef="CNY">${refunded}</rai:AmountRefunded>` : '<rai:AmountRefunded contextRef="c" xsi:nil="true"/>'}
<rai:Name contextRef="c">${name}</rai:Name></xbrl>`;
const flightRows = ({ order = '1990000000000001', booked = '2026 4 6 16:00:07', out = '4 7 21:20 PVG T2', back = '4 7 23:30 CSX T2',
  number = 'CZ3970', prices = ['700', '530', '50', '120', '23'] } = {}) => ['&', '/ /', `- :${order}`, booked,
  ...prices.map((price, index) => `${index === 1 ? '3.9 ' : ''}¥${price}x1`), '&', out.split(' ').slice(0, 2).join(' ') + '  - ', out,
  `2h10m ${number} 320( ) (Q)`, back, '1101***********001', 'Copyright©1999-2026,ctrip.com.all rightsreserved.'];
const IHG_FOLIO = `Conf No. : 18082390\n Yi Teacher Room No. : 2801\nArrival : 04-07-26\nDeparture : 04-08-26\nTeacher, Yi\nINFORMATION INVOICE
04-07-26 Room Charge 416.00\nTotal 416.00 0.00\nBalance 416.00 CNY`;
const OPERA_FOLIO = `~{[G#:131354|RN:0926|GA:2026-06-09|GD:2026-06-10|GF:Lan|GN:Xu]}\nYi Teacher 到店日期/Arrival : 09/06/2026
教师乙 离店日期/Departure : 10/06/2026\n总计/Total 432.01 0.00\n应付总额/Balance 432.01 人民币/CNY`;
const OCR_FOLIO = `结账单\n客人姓名Name： 张三 到达日期ARRIVAL :2026/06/17 23:59:59\n公司 Company 离开日期 DEPARTURE\n:\n：2026/06/1910:25:04
小计 Subtotal 990.00 0.00\n总额Total 990.00 0.00\n余额Balance 990.00`;

test('a 铁路电子客票 is read from its embedded XBRL; stations become cities', () => {
  const item = trainFromXml(railXml(), 'g252.pdf');
  assert.deepEqual({ ...item }, { type: 'train', file: 'g252.pdf', passenger: '张三', number: 'G252', date: '2026-04-08', time: '18:40',
    fromStation: '长沙南', toStation: '上海虹桥', from: '长沙', to: '上海', fare: '786.00', seat: '一等座',
    invoiceNumber: '26429165818000000001', refund: false, issued: '2026-09-19' });
  assert.equal(trainFromXml(railXml({ business: '退' }), 'x').refund, true);
  assert.equal(trainFromXml(railXml({ refunded: '120.00' }), 'x').refund, true);
  assert.equal(trainFromXml('<rai:TypeOfVoucher>增值税电子普通发票</rai:TypeOfVoucher>', 'x'), undefined);
  assert.deepEqual(['北京南', '南京南', '济南', '西安北', '上海站'].map(stationCity), ['北京', '南京', '济南', '西安', '上海']);
});

test('a 携程 flight page gives date, airports and 总支付 = every charge after the subtotal line', () => {
  const item = flightFromRows(flightRows(), 'cz3970.pdf');
  assert.deepEqual({ ...item }, { type: 'flight', file: 'cz3970.pdf', order: '1990000000000001', number: 'CZ3970', date: '2026-04-07',
    time: '21:20', arriveDate: '2026-04-07', arriveTime: '23:30', fromCode: 'PVG', toCode: 'CSX', from: '上海', to: '长沙', total: '723.00' });
  // 1170 subtotal; 1050 + 50 + 70 + 40 + 23 = 1233, the 携程借款单 amount.
  assert.equal(flightFromRows(flightRows({ prices: ['1170', '1050', '50', '70', '40', '23'] }), 'x').total, '1233.00');
  // 9C (春秋) starts with a digit; an arrival after midnight moves to the next day; December bookings fly next year.
  const late = flightFromRows(flightRows({ booked: '2026 12 20 10:00:00', out: '1 4 22:55 WEH', back: '1 5 00:45 PVG T2', number: '9C6390' }), 'x');
  assert.deepEqual([late.number, late.date, late.arriveDate, late.from, late.to], ['9C6390', '2027-01-04', '2027-01-05', '威海', '上海']);
  // A refund page has no airports: kept as flight_other, never a leg.
  assert.equal(flightFromRows(flightRows({ out: '6 9  -  21:10-23:00 1h50m', back: '' }), 'x').type, 'flight_other');
  assert.equal(flightFromRows(['no order here', 'ctrip.com'], 'x'), undefined);
});

test('hotel folios: IHG (MM-DD-YY), Opera (ISO header) and an OCR folio (year first, run into the time)', () => {
  const ihg = hotelFromText(IHG_FOLIO, 'ihg.pdf');
  assert.deepEqual([ihg.guest, ihg.amount], ['Yi Teacher', '416.00']);
  assert.deepEqual(ihg.alternatives, [{ arrival: '2026-07-04', departure: '2026-08-04' }, { arrival: '2026-04-07', departure: '2026-04-08' }],
    'day- and month-first are both possible until the trip decides');
  assert.deepEqual(['arrival', 'departure', 'nights', 'amount', 'guest'].map(key => hotelFromText(OPERA_FOLIO, 'x')[key]),
    ['2026-06-09', '2026-06-10', 1, '432.01', '教师乙']);
  const ocr = hotelFromText(OCR_FOLIO, 'x');
  assert.deepEqual([ocr.arrival, ocr.departure, ocr.nights, ocr.amount, ocr.guest, ocr.alternatives], ['2026-06-17', '2026-06-19', 2, '990.00', '张三', undefined]);
  assert.equal(hotelFromText('电子发票 价税合计 ¥466.00', 'x'), undefined);
});

test('住宿 and 会议 invoices are told apart by their items', () => {
  assert.equal(invoiceFromText('电子发票（普通发票）\n*生产生活服务*代订住宿\n名称：上海科技大学\n名称：某旅行社', 'h.pdf', '466.00').type, 'hotel_invoice');
  assert.equal(invoiceFromText('电子发票\n*现代服务*会议费\n开票日期：2026年08月10日', 'm.pdf', '1200.00').date, '2026-08-10');
  assert.equal(invoiceFromText('电子发票\n*信息技术服务*软件', 'x.pdf', '99.00'), undefined);
});

test('buildItinerary: legs in time order, the trip\'s days and the hotel invoice on the first leg, orders for 携程借款单', () => {
  const items = [
    trainFromXml(railXml(), 'g252.pdf'),
    flightFromRows(flightRows(), 'cz3970.pdf'),
    hotelFromText(IHG_FOLIO, 'ihg.pdf'),
    invoiceFromText('电子发票\n代订住宿', 'hotel.pdf', '466.00'),
    { type: 'document', file: 'notice.docx', title: '技术交流日程安排' },
    { type: 'unknown', file: 'photo.png', reason: '图片经 OCR 识别后未能识别。' },
  ];
  const trip = buildItinerary(items);
  assert.equal(trip.groups.length, 1, 'the flight joins the only rail passenger');
  assert.equal(trip.groups[0].passenger, '张三');
  assert.deepEqual(trip.groups[0].legs.map(leg => [leg.startDate, leg.startAddress, leg.arriveAddress, leg.vehicle, leg.trafficExpense,
    leg.travelDays, leg.hotelExpense]), [['2026-04-07', '上海', '长沙', 'aircraft', '723.00', 2, '466.00'], ['2026-04-08', '长沙', '上海', 'train', '786.00', 0, '']]);
  assert.deepEqual(trip.ctripOrders, ['1990000000000001']);
  assert.equal(trip.reason, '技术交流日程安排');
  assert.ok(trip.warnings.some(text => /按酒店发票填 466\.00 元；水单金额为 416\.00/.test(text)), 'invoice beats folio, and the gap is shown');
  assert.ok(trip.warnings.some(text => /photo\.png/.test(text)));
  assert.equal(items[2].arrival, '2026-04-07', 'the folio reading inside the trip is kept');
});

test('buildItinerary flags what needs a person: folio-only hotels, gaps, two trips, refunds, overnight arrivals', () => {
  const folioOnly = buildItinerary([flightFromRows(flightRows(), 'a.pdf'), hotelFromText(OPERA_FOLIO.replace(/2026-06-09/, '2026-04-07')
    .replace(/2026-06-10/, '2026-04-08'), 'f.pdf'), trainFromXml(railXml(), 't.pdf')]);
  assert.equal(folioOnly.groups[0].legs[0].hotelExpense, '432.01');
  assert.ok(folioOnly.warnings.some(text => /没有识别到酒店发票.*以酒店发票金额为准/.test(text)));

  const gap = buildItinerary([trainFromXml(railXml({ from: '上海虹桥', to: '长沙南', date: '2026-04-07', time: '08:00' }), 'a.pdf'),
    trainFromXml(railXml({ from: '南京南', to: '上海虹桥', date: '2026-04-20' }), 'b.pdf'),
    trainFromXml(railXml({ business: '退' }), 'c.pdf'),
    { type: 'flight_other', file: 'r.pdf', order: '1990000000000002', total: '912.00' }]);
  assert.equal(gap.groups[0].legs.length, 2, 'the refunded ticket gives no leg');
  for (const pattern of [/长沙 到达后下一段从 南京 出发/, /相隔 13 天/, /c\.pdf.*退票/, /1990000000000002/]) {
    assert.ok(gap.warnings.some(text => pattern.test(text)), String(pattern));
  }
  const late = buildItinerary([flightFromRows(flightRows({ out: '7 3 20:04 PVG T1', back: '7 3 21:29 WEH' }), 'o.pdf'),
    flightFromRows(flightRows({ order: '1990000000000003', out: '7 4 22:55 WEH', back: '7 5 00:45 PVG T2', number: '9C6390' }), 'b.pdf')]);
  assert.equal(late.groups[0].passenger, null);
  assert.equal(late.groups[0].legs[0].travelDays, 3);
  assert.ok(late.warnings.some(text => /00:45 次日到达/.test(text)));
  assert.match(buildItinerary([]).warnings[0], /没有识别出火车票或机票/);
});

test('sanitizeItems keeps well-formed items only', () => {
  const good = [trainFromXml(railXml(), 'a.pdf'), hotelFromText(IHG_FOLIO, 'b.pdf')];
  assert.equal(sanitizeItems(JSON.parse(JSON.stringify(good))).length, 2);
  assert.deepEqual(sanitizeItems(JSON.parse(JSON.stringify(good)))[1].alternatives.length, 2);
  for (const bad of [[{ type: 'script' }], [{ ...good[0], fare: '1e9' }], [{ ...good[0], date: 'tomorrow' }], [{ ...good[0], file: 'a\nb' }], {}, null]) {
    assert.equal(sanitizeItems(bad), undefined, JSON.stringify(bad).slice(0, 60));
  }
});

/** A .docx holding only word/document.xml, stored or deflated. */
function docx(paragraphs, deflate = true) {
  const xml = Buffer.from(`<w:document><w:body>${paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const data = deflate ? zlib.deflateRawSync(xml) : xml;
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, data]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, name, end]);
}

test('files: a PDF with the rail XML attached, a Word notice, and images when OCR is not installed', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  await doc.attach(Buffer.from(railXml()), 'rai_issuer_20260919_1.xml', { mimeType: 'application/xml' });
  const [train] = await parseItineraryFile('火车票.pdf', Buffer.from(await doc.save()));
  assert.deepEqual([train.type, train.number, train.from, train.to], ['train', 'G252', '长沙', '上海']);

  assert.equal(docxText(docx(['上海科技大学与芒果 TV 技术交流日程安排', '9:00 报到'])), '上海科技大学与芒果 TV 技术交流日程安排\n9:00 报到');
  assert.deepEqual(await parseItineraryFile('日程.docx', docx(['技术交流日程安排'], false)), [{ type: 'document', file: '日程.docx', title: '技术交流日程安排' }]);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-none-'));
  const before = process.env.OA_OCR_MODEL_DIR;
  process.env.OA_OCR_MODEL_DIR = empty;
  try {
    const { PNG } = require('pngjs');
    const png = PNG.sync.write(Object.assign(new PNG({ width: 4, height: 4 }), {}));
    const [image] = await parseItineraryFile('水单.png', png);
    assert.equal(image.type, 'unknown');
    assert.match(image.reason, /OCR 不可用.*缺少模型文件/);
  } finally {
    if (before === undefined) delete process.env.OA_OCR_MODEL_DIR; else process.env.OA_OCR_MODEL_DIR = before;
    fs.rmSync(empty, { recursive: true, force: true });
  }
  assert.equal((await parseItineraryFile('readme.txt', Buffer.from('hello')))[0].type, 'unknown');
});

test('发票 reads a 铁路电子客票 whose page has no text from its embedded XML: number, 票价, 国铁集团, 开票日期', async () => {
  const { inspectInvoice } = require('../dist/application/job-service.js');
  const doc = await PDFDocument.create();
  doc.addPage();
  await doc.attach(Buffer.from(railXml({ fare: '1005.00' })), 'rai_issuer_20260919_1.xml', { mimeType: 'application/xml' });
  const { invoice } = await inspectInvoice({ name: '火车票.pdf', base64: Buffer.from(await doc.save()).toString('base64') });
  assert.deepEqual([invoice.number, invoice.amount, invoice.seller, invoice.date],
    ['26429165818000000001', '1005.00', '中国国家铁路集团有限公司', '2026-09-19']);
  // A PDF with neither text nor a ticket XML is still refused.
  const blank = await PDFDocument.create();
  blank.addPage();
  await assert.rejects(inspectInvoice({ name: 'x.pdf', base64: Buffer.from(await blank.save()).toString('base64') }), /无法从 PDF 内容唯一识别/);
});
