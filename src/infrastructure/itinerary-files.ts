import zlib from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { readInvoicePdf } from './invoice-pdf';
import { decodeImage, OcrUnavailableError, pdfImages, recognizeText } from './ocr';
import { invoiceTotalFromText } from '../domain/invoice-total';
import { flightFromRows, hotelFromText, invoiceFromText, trainFromXml, type ItineraryItem } from '../domain/itinerary';

/** Files a PDF embeds (全电发票 carry their XBRL this way), decoded; empty when there are none. */
export async function embeddedFiles(buffer: Buffer): Promise<Array<{ name: string; text: string }>> {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = names?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const files: Array<{ name: string; text: string }> = [];
  for (let index = 0; list && index + 1 < list.size(); index += 2) {
    const stream = list.lookupMaybe(index + 1, PDFDict)?.lookupMaybe(PDFName.of('EF'), PDFDict)?.lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) continue;
    let bytes = Buffer.from(stream.contents);
    if (String(stream.dict.get(PDFName.of('Filter')) ?? '').includes('FlateDecode')) {
      try { bytes = zlib.inflateSync(bytes); } catch { continue; }
    }
    if (bytes.length > 2_000_000) continue;
    files.push({ name: String(list.get(index)), text: bytes.toString('utf8') });
  }
  return files;
}

/** word/document.xml of a .docx (a zip), as plain paragraphs; no other entry is read. */
export function docxText(buffer: Buffer): string {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let entry = 0; entry < count && at + 46 <= buffer.length; entry++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20), plain = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (name !== 'word/document.xml' || plain > 20_000_000) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    return xml.split(/<\/w:p>/).map(paragraph => [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join(''))
      .map(line => line.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim())
      .filter(Boolean).join('\n');
  }
  throw new Error('no document.xml');
}

const kindOf = (name: string, buffer: Buffer) => {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.subarray(0, 2).toString('latin1') === 'PK' && /\.docx$/i.test(name)) return 'docx';
  if (/\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(name)) return 'image';
  return 'other';
};

/** Folio, 住宿/会议 invoice or notice from plain text (a PDF text layer, or OCR). */
function fromText(text: string, name: string, amount: string | undefined, how: string): ItineraryItem[] {
  const total = amount ?? text.split('\n').filter(line => /小写|价税合计/.test(line)).map(invoiceTotalFromText).find(Boolean);
  const item = hotelFromText(text, name) ?? invoiceFromText(text, name, total);
  if (item) return [item];
  const notice = /通知|会议|研讨|年会|日程|邀请|论坛|交流/;
  // A notice saved under its own title says what the trip was for even when its pages are photos.
  const stem = name.replace(/\.[^.]+$/, '').replace(/[_\s]+/g, ' ').trim();
  const title = text.split('\n').map(line => line.trim()).find(line => notice.test(line) && line.length <= 80)
    ?? (notice.test(stem) && stem.length <= 80 ? stem : undefined);
  return title ? [{ type: 'document', file: name, title }] : [{ type: 'unknown', file: name, reason: `${how}未能识别为车票、机票、水单或住宿/会议发票，请手工核对。` }];
}

/** OCR of images; a missing model or runtime is reported per file and does not fail the rest. */
async function ocrItems(name: string, images: () => Promise<Array<{ width: number; height: number; data: Uint8Array }>>,
  what: string): Promise<ItineraryItem[]> {
  try {
    const list = await images();
    if (!list.length) return [{ type: 'unknown', file: name, reason: `${what}中没有可识别的图像，请手工核对。` }];
    const text = (await Promise.all(list.map(recognizeText))).join('\n');
    return text.trim() ? fromText(text, name, undefined, `${what}经 OCR 识别后`) : [{ type: 'unknown', file: name, reason: `${what}经 OCR 未识别出文字，请手工核对。` }];
  } catch (error) {
    const reason = error instanceof OcrUnavailableError ? error.message : 'OCR 识别失败';
    return [{ type: 'unknown', file: name, reason: `${what}，${reason}，请手工核对。` }];
  }
}

/** One 行程附件, read in memory: 火车票 (embedded XML), 携程 flight page, hotel folio, 住宿/会议 invoice,
 * or a notice whose first line suggests the 报销事由; images and scans through local OCR. Nothing is written anywhere. */
export async function parseItineraryFile(name: string, buffer: Buffer): Promise<ItineraryItem[]> {
  const kind = kindOf(name, buffer);
  if (kind === 'image') return ocrItems(name, async () => [await decodeImage(buffer)], '图片');
  if (kind === 'docx') {
    let text: string;
    try { text = docxText(buffer); } catch { return [{ type: 'unknown', file: name, reason: '无法读取该 Word 文件。' }]; }
    const title = text.split('\n').find(line => line.length >= 4 && line.length <= 80);
    return title ? [{ type: 'document', file: name, title }] : [{ type: 'unknown', file: name, reason: 'Word 文件中没有可用的文字。' }];
  }
  if (kind !== 'pdf') return [{ type: 'unknown', file: name, reason: '不是 PDF、Word 或图片文件。' }];
  const trains = (await embeddedFiles(buffer).catch(() => [])).flatMap(file => {
    const item = trainFromXml(file.text, name);
    return item ? [item] : [];
  });
  if (trains.length) return trains;
  let parsed: Awaited<ReturnType<typeof readInvoicePdf>>;
  try { parsed = await readInvoicePdf(buffer); } catch { return [{ type: 'unknown', file: name, reason: 'PDF 无法解析（可能已加密或损坏）。' }]; }
  const rows = parsed.pages.join('\n').split('\n');
  const text = parsed.pages.join('\n');
  const flight = flightFromRows(rows, name);
  if (flight) return [flight];
  if (text.replace(/[\s¥￥]/g, '').length < 20) return ocrItems(name, () => pdfImages(buffer), '扫描件 PDF');
  return fromText(text, name, parsed.amount, '');
}
