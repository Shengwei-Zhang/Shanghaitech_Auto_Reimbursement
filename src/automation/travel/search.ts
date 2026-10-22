import { htmlInputs, type OaHttpClient } from '../http-login';
import { bpmEncodeURI, bpmPost, type BpmDocument } from '../http-bpm';
import { decodeEntities } from '../funding-search';
import { cents, envelope, HttpTravelError, JSON_ACCEPT, record, TEXT_ACCEPT, TRAVEL_PATHS, yuan } from './request';

/** Read-only lookups of the 境内差旅单 editor: 出差人 and 携程借款单. The page calls them with any BPM
 * page's csrfToken (the reading session's 报销单查询); the fill repeats them on the form itself. */

/** 出差人类别 option labels; 校外 has no lookup and is not supported. */
export const TRAVELLER_KINDS = { staff: '教工', student: '学生' } as const;
export type TravellerKind = keyof typeof TRAVELLER_KINDS;
/** 出差人 lookups of the traveller dialog: 教工 through the org tree, 学生 through the student list. */
const PERSON_QUERIES = {
  staff: { orgKindId: 'psm', orgRoot: 'orgRoot', status: '1', isVirtual: '0', queryName: 'techOrgSearch' },
  student: { queryName: 'queryStudent' },
} as const;

/** The traveller dialog's 出差人 lookup by name (paramValue encoded once, as the dialog sends it). */
export function personQuery(kind: TravellerKind, name: string, pageSize = 20): Record<string, string> {
  return { ...PERSON_QUERIES[kind], paramValue: encodeURI(name.trim()), pageSize: String(pageSize), configType: 'tech', intPage: '1',
    isMultipleSelect: 'false' };
}

/** Rows of an easySearch.load table: each <tr class='list'>'s hidden inputs by name. */
export function easySearchRows(html: string): Array<Record<string, string>> {
  return [...html.matchAll(/<tr\b[^>]*class=['"]list['"][^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    Object.fromEntries(htmlInputs(row).filter(attrs => attrs.name).map(attrs => [attrs.name, decodeEntities(attrs.value ?? '')])));
}

/** <option value>label pairs of one <select id=...> in a BPM fragment. */
export function selectOptions(html: string, id: string): Array<{ value: string; label: string }> {
  const block = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</select>`, 'i'))?.[1] ?? '';
  return [...block.matchAll(/<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([^<]*)/gi)]
    .map(([, value, label]) => ({ value: decodeEntities(value), label: decodeEntities(label).trim() })).filter(item => item.value);
}

export interface TravellerMatch { code: string; name: string; /** 部门 of 教工; empty for 学生. */ dept: string }

/** 教工 or 学生 whose name matches `name` (OA's own fuzzy search), for the page's traveller picker. */
export async function searchTravellersHttp(client: OaHttpClient, page: BpmDocument, kind: TravellerKind, name: string)
  : Promise<TravellerMatch[]> {
  const result = await bpmPost(client, page, TRAVEL_PATHS.personSearch, personQuery(kind, name, 50), TEXT_ACCEPT);
  if (result.error) throw new HttpTravelError(result.error === 'authentication' ? 'authentication' : 'request_failed', 'traveller',
    undefined, '学校 OA 出差人查询未完成。');
  if (!/easySearchTableListData/.test(result.text)) {
    throw new HttpTravelError(/登录超时|重新登录/.test(result.text) ? 'authentication' : 'response_invalid', 'traveller', undefined,
      '学校 OA 返回了无法识别的人员列表。');
  }
  const seen = new Set<string>();
  return easySearchRows(result.text).flatMap(row => {
    if (!/^[A-Za-z0-9]{2,32}$/.test(row.code ?? '') || !row.name || seen.has(row.code)) return [];
    seen.add(row.code);
    return [{ code: row.code, name: row.name, dept: row.deptName ?? '' }];
  });
}

/** 携程借款单 tab of the write-off dialog (reimburWriteOff.js): keyValue 携程, per fund. */
export function ctripBorrowQuery(accountBook: string, fundingCode: string): Record<string, string> {
  return { borrowKind: '1', accountBook, keyValue: bpmEncodeURI('携程'), fundingItemsCode: fundingCode, sortfields: '[]' };
}

export interface CtripBorrow {
  /** 订单号 (borrowMoneyCode). */
  order: string;
  /** 摘要, e.g. 携程机票#…上海至大连_… */
  remark: string;
  personName: string;
  /** 未清余额, written off in full. */
  outstanding: string;
  /** 借款日期 (voucherDate). */
  date: string;
}

/** Open 携程借款单 a form could write off, newest first. */
export async function searchCtripBorrowsHttp(client: OaHttpClient, page: BpmDocument, fundingCode: string,
  accountBook = 'ST00'): Promise<CtripBorrow[]> {
  const result = await bpmPost(client, page, TRAVEL_PATHS.ctripBorrows, ctripBorrowQuery(accountBook, fundingCode), JSON_ACCEPT);
  if (result.error) throw new HttpTravelError(result.error === 'authentication' ? 'authentication' : 'request_failed', 'writeoff',
    undefined, '学校 OA 携程借款单查询未完成。');
  let value: unknown;
  try { value = envelope(result.text, 'writeoff'); } catch (error) {
    throw new HttpTravelError(error instanceof HttpTravelError ? error.code : 'response_invalid', 'writeoff', undefined,
      '学校 OA 返回了无法识别的携程借款单列表。');
  }
  const rows = record(record(value)?.data)?.Rows;
  if (!Array.isArray(rows)) throw new HttpTravelError('response_invalid', 'writeoff', undefined, '学校 OA 返回了无法识别的携程借款单列表。');
  return rows.map(row => record(row) ?? {}).flatMap(row => {
    const outstanding = cents(row.outstandingAmount);
    const order = String(row.borrowMoneyCode ?? '');
    return /^\d{4,32}$/.test(order) && outstanding !== null && outstanding > 0 ? [{ order, remark: String(row.remark ?? ''),
      personName: String(row.personName ?? ''), outstanding: yuan(outstanding), date: String(row.voucherDate ?? '').slice(0, 10) }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date) || a.order.localeCompare(b.order));
}
