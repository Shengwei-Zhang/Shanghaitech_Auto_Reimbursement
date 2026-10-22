import type { OaHttpClient } from './http-login';
import { BPM_ORIGIN } from './form-request';
import { bpmEncodeURI, type BpmDocument } from './http-bpm';

/** 银行汇款 payees are suppliers (供应商) of the school's supplier register, picked in the OA
 * payment dialog through mmSupplier/slicedQueryMmSupplier.ajax (captured live 2026-10-21). The
 * search is fuzzy (it also matches bank names and account numbers), so callers match the name. */
export const SUPPLIER_SEARCH_PATH = '/bpm-new/mmSupplier/slicedQueryMmSupplier.ajax';

export interface Supplier {
  supplierCode: string;
  /** 账户名 (payee); equal to the supplier name in the register. */
  name: string;
  /** 账号. */
  account: string;
  /** 所属银行, e.g. 上海银行. */
  ownedBank: string;
  /** 开户行名称, e.g. 上海银行市政大厦支行. */
  openingBankName: string;
  /** isMainData = 1 (是). */
  main: boolean;
  /** The row as OA returned it, posted back unchanged when the payment dialog is opened. */
  row: Record<string, unknown>;
}

export class PayeeError extends Error {
  constructor(readonly code: 'authentication' | 'request_failed' | 'response_invalid' | 'invalid_query') {
    super({ authentication: '学校 OA 登录已失效。', request_failed: '学校 OA 供应商查询未完成，请检查校园网络/VPN 后重试。',
      response_invalid: '学校 OA 返回了无法识别的供应商列表。', invalid_query: '请填写 2–100 个字符的银行转账户名。' }[code]);
  }
}

const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
/** Same name regardless of spacing or full/half-width brackets. */
export const sameName = (a: string, b: string) => a.normalize('NFKC').replace(/\s+/g, '') === b.normalize('NFKC').replace(/\s+/g, '');

/** Form body of the supplier dialog's search; keyValue goes through BPM's double encodeURI. */
export function supplierQuery(name: string, pagesize = 50): Record<string, string> {
  return { supplierKind: '1', keyValue: bpmEncodeURI(name), status: '1', isBank: '1', page: '1', pagesize: String(pagesize),
    sortname: 'code', sortorder: 'asc', sortfields: '[]' };
}

/** Rows that can be paid: an enabled supplier with an account and an opening bank. */
export function parseSuppliers(value: unknown): Supplier[] {
  const data = (value as { data?: { Rows?: unknown } })?.data;
  if ((value as { status?: unknown })?.status !== 0 || !data || !Array.isArray(data.Rows)) throw new PayeeError('response_invalid');
  return (data.Rows as Array<Record<string, unknown>>).flatMap(row => {
    const supplier = { supplierCode: text(row.supplierCode || row.code), name: text(row.payee || row.supplierName),
      account: text(row.payeeCode), ownedBank: text(row.ownedBank), openingBankName: text(row.openingBankName),
      main: String(row.isMainData) === '1', row };
    return /^\d{1,20}$/.test(supplier.supplierCode) && supplier.name && /^[\dA-Za-z-]{4,40}$/.test(supplier.account)
      && supplier.openingBankName && String(row.status ?? '1') === '1' ? [supplier] : [];
  });
}

/** Suppliers whose account name is exactly `name`, read with any BPM page's csrfToken. */
export async function searchSuppliersHttp(client: OaHttpClient, page: BpmDocument, name: string): Promise<Supplier[]> {
  const wanted = name.trim();
  if (wanted.length < 2 || wanted.length > 100 || /[\u0000-\u001f]/.test(wanted)) throw new PayeeError('invalid_query');
  let response;
  try {
    response = await client.request(`${BPM_ORIGIN}${SUPPLIER_SEARCH_PATH}`, { method: 'POST', followRedirects: false,
      body: new URLSearchParams(supplierQuery(wanted)).toString(),
      headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest', csrfToken: page.csrfToken, ...(page.procTaskId ? { procTaskId: page.procTaskId } : {}),
        origin: BPM_ORIGIN, referer: page.url } });
  } catch { throw new PayeeError('request_failed'); }
  if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) throw new PayeeError('authentication');
  if (response.status !== 200) throw new PayeeError('response_invalid');
  let data: unknown;
  try { data = JSON.parse(response.text); } catch { throw new PayeeError('response_invalid'); }
  if ((data as { isAuth?: unknown })?.isAuth !== undefined) throw new PayeeError('authentication');
  return parseSuppliers(data).filter(supplier => sameName(supplier.name, wanted));
}

/** 学号/工号 (个人银行卡) look like this; anything else is a 银行汇款 account name. */
export const PERSON_CODE = /^[a-zA-Z0-9_-]{2,32}$/;
