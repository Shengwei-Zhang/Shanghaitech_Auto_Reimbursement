import { moneyToCents } from './job';

export const RAILWAY_ETICKET = '铁路电子客票';
/** OA 票夹里铁路电子客票的销售方名称. */
export const RAILWAY_SELLER = '中国国家铁路集团有限公司';

/** Read the labelled tax-inclusive total; never guess from line items or tax amounts. */
export function invoiceTotalFromText(text: string): string | undefined {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '');
  const amounts = new Set<string>();
  const patterns = [
    /价税合计(?:\(大写\))?[^\d]{0,80}?(?:\(小写\)|小写)[:：]?[¥￥]?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g,
    /(?:\(小写\)|小写)[:：]?[¥￥]((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g,
    /价税合计[:：]?[¥￥]((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g,
  ];
  for (const pattern of patterns) for (const match of normalized.matchAll(pattern)) {
    const value = match[1].replace(/,/g, '');
    try { moneyToCents(value); amounts.add(value); } catch { return undefined; }
  }
  return amounts.size === 1 ? [...amounts][0] : undefined;
}

/** 铁路电子客票 has 票价, not 价税合计. A 票价 on any other invoice is ignored.
 * Spaces are removed per line only: collapsing the whole page would glue 378.00
 * onto the passenger-id digits and `(?!\d)` would reject the fare. */
export function railwayFareFromText(text: string): string | undefined {
  const folded = text.normalize('NFKC');
  if (!folded.replace(/\s+/g, '').includes(RAILWAY_ETICKET)) return undefined;
  const amounts = new Set<string>();
  for (const line of folded.split(/\r?\n/)) {
    const compact = line.replace(/\s+/g, '');
    for (const match of compact.matchAll(/票价[:：]?[¥￥]?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g)) {
      const value = match[1].replace(/,/g, '');
      try { moneyToCents(value); amounts.add(value); } catch { return undefined; }
    }
  }
  return amounts.size === 1 ? [...amounts][0] : undefined;
}
