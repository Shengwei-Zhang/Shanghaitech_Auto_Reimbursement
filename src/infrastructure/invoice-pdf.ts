import pdfParse from 'pdf-parse';
import { invoiceTotalFromText, railwayFareFromText } from '../domain/invoice-total';

export interface PdfTextItem {
  str: string;
  transform: number[];
  /** Advance width. Some invoices emit one glyph per item; adjacent glyphs must not gain a space. */
  width?: number;
}

/** A gap wider than this, in PDF points, is a space between fields rather than the next glyph. */
const GLYPH_GAP = 2;

function joinRow(items: PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  let text = '';
  let edge = -Infinity;
  for (const item of sorted) {
    if (text && item.transform[4] - edge > GLYPH_GAP) text += ' ';
    text += item.str;
    const width = typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : 0;
    edge = Math.max(edge, item.transform[4] + width);
  }
  return text;
}

/** PDF content-stream order is not reading order. Keep each physical row together. */
export function invoiceTextRows(items: PdfTextItem[]): string[] {
  const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
  const positioned = items.filter(item => item.str.trim() && Number.isFinite(item.transform[4])
    && Number.isFinite(item.transform[5]));
  for (const item of [...positioned].sort((a, b) => b.transform[5] - a.transform[5])) {
    const y = item.transform[5];
    // Labels and values in the standard electronic invoice differ by ~1.5 PDF
    // points in baseline; the subtotal and tax-inclusive total are separate rows.
    const row = rows.find(candidate => Math.abs(candidate.y - y) <= 3);
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows.map(row => joinRow(row.items));
}

/** pages: the text rows of each page, in page order. */
export async function readInvoicePdf(buffer: Buffer): Promise<{ text: string; amount?: string; pages: string[] }> {
  const pageTotals: Array<string | undefined> = [];
  const pages: string[] = [];
  let renderFailed = false;
  const parsed = await pdfParse({ data: new Uint8Array(buffer), isEvalSupported: false }, {
    pagerender: async (page: { pageNumber?: number; getTextContent(): Promise<{ items: PdfTextItem[] }> }) => {
      try {
        const { items } = await page.getTextContent();
        const rows = invoiceTextRows(items);
        pages[(page.pageNumber ?? pages.length + 1) - 1] = rows.join('\n');
        // Parse totals only within a physical row; never join a detached label
        // to unrelated amounts on the next line or on another page.
        for (const row of rows) {
          const compact = row.normalize('NFKC').replace(/\s+/g, '');
          if (/小写|价税合计/.test(compact)) pageTotals.push(invoiceTotalFromText(row));
        }
        return rows.join('\n');
      } catch (error) {
        // pdf-parse swallows pagerender errors, so explicitly propagate failure.
        renderFailed = true;
        throw error;
      }
    },
  });
  if (renderFailed) throw new Error('Invoice text extraction failed.');
  const totals = new Set(pageTotals);
  return { text: parsed.text, amount: (totals.size === 1 ? [...totals][0] : undefined) ?? railwayFareFromText(parsed.text),
    pages: Array.from(pages, page => page ?? '') };
}
