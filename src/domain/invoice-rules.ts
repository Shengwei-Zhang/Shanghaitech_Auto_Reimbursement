import { RAILWAY_ETICKET, RAILWAY_SELLER } from './invoice-total';

/** Same seller on the same day stays below 500 元 on one form (at most 499.99 元).
 * A single invoice has no amount cap. */
export const INVOICE_LIMIT_CENTS = 50_000;

export interface LimitedInvoice {
  number: string;
  /** 价税合计 in cents. */
  faceCents: number | null;
  /** What this form reimburses from it, in cents (its balance); defaults to the face amount. */
  usedCents?: number | null;
  seller?: string;
  /** YYYY-MM-DD. */
  date?: string;
}

const yuan = (value: number) => (value / 100).toFixed(2);

/** Same seller regardless of spacing or full/half-width brackets. */
export function sellerKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '');
}

export function invoiceLimitProblems(items: LimitedInvoice[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, LimitedInvoice[]>();
  for (const item of items) {
    if (!item.seller || !item.date) continue;
    const key = `${sellerKey(item.seller)}|${item.date}`;
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const amounts = group.map(item => item.usedCents ?? item.faceCents);
    if (amounts.some(value => value === null || value === undefined)) continue;
    const total = (amounts as number[]).reduce((sum, value) => sum + value, 0);
    if (total >= INVOICE_LIMIT_CENTS) {
      problems.push(`${group[0].seller} 在 ${group[0].date} 开具的 ${group.length} 张发票合计 ${yuan(total)} 元；`
        + '同一销售方同一开票日期的发票在一张报销单内合计不能超过 499.99 元。');
    }
  }
  return problems;
}

/** 开票日期 and 销售方名称 of a standard 全电发票 from its text rows.
 * 铁路电子客票 has no 销名称; OA lists it as 中国国家铁路集团有限公司. */
export function invoicePartiesFromText(text: string): { seller?: string; date?: string } {
  const compact = text.normalize('NFKC');
  const day = compact.match(/开票日期[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  // 销 is sometimes drawn on the row above 售名称, one glyph at a time.
  const seller = text.match(/(?:销|售)\s*名\s*称[:：]\s*(\S+)/)?.[1]
    ?? (compact.includes(RAILWAY_ETICKET) ? RAILWAY_SELLER : undefined);
  return {
    ...(day ? { date: `${day[1]}-${day[2].padStart(2, '0')}-${day[3].padStart(2, '0')}` } : {}),
    ...(seller ? { seller } : {}),
  };
}
