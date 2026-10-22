import type { OaHttpClient } from './http-login';
import { BPM_ORIGIN } from './form-request';

export const INVOICE_FOLDERS_PATH = '/bpm-new/reimburInvoiceFolder/loadInvoiceFolderList1.ajax';
export const INVOICE_FOLDER_ROWS_PATH = '/bpm-new/reimburInvoiceFolder/queryBillImageListForClaims4WsNew.ajax';

/** 报销状态 filter values of the invoice dialog (the select's own option values). */
export const CLAIM_STATUSES = ['未报销', '报销中', '已报销'] as const;
export type ClaimStatus = typeof CLAIM_STATUSES[number];
/** 未报销 and 报销中 lists are short and read in full; 已报销 holds every past invoice, sorted by
 * most recent activity, and OA needs ~3 s per 10 rows, so only its first page is read. */
export const CLAIMED_PAGE_SIZE = 10;
/** OA 票夹列表一次最多查 100 条，票夹选择不再翻页。 */
export const FOLDER_PAGE_SIZE = 100;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export type InvoiceClaim =
  /** documents: bill codes OA lists as using the invoice, with their total actual amount. */
  | { state: 'claimed' | 'claiming' | 'unclaimed'; folders: string[]; documents?: string[]; claimedAmount?: string }
  /** Not in 未报销/报销中 nor the recent 已报销 page; older 已报销 entries were not read. */
  | { state: 'absent' };

export interface InvoiceFolder { id: string; name: string }
export interface FolderRow {
  invoiceNumber?: unknown; billClaimState?: unknown;
  /** Live 2026-10-15: electronicInvoice.billEnOut.{billCodeList: "A209900000006", totalActualAmount: 200}. */
  electronicInvoice?: { billEnOut?: { billCodeList?: unknown; totalActualAmount?: unknown } };
}
interface ClaimHit { status: ClaimStatus; folder: string; documents?: string[]; claimedAmount?: string }

function hitOf(row: FolderRow, status: ClaimStatus, folder: string): ClaimHit {
  const bill = row.electronicInvoice?.billEnOut;
  const documents = typeof bill?.billCodeList === 'string' ? bill.billCodeList.match(/A\d{1,32}/g) ?? [] : [];
  const amount = Number(bill?.totalActualAmount);
  return { status, folder, ...(documents.length ? { documents } : {}),
    ...(documents.length && Number.isFinite(amount) && amount > 0 ? { claimedAmount: amount.toFixed(2) } : {}) };
}

export class InvoiceClaimError extends Error {
  constructor(readonly code: 'authentication' | 'request_failed' | 'response_invalid') {
    super(code === 'authentication' ? '学校 OA 登录已失效。' : '票夹查询未完成，无法确认该发票是否已报销。');
  }
}

const STATE: Record<ClaimStatus, 'unclaimed' | 'claiming' | 'claimed'> = { 未报销: 'unclaimed', 报销中: 'claiming', 已报销: 'claimed' };
const RANK = { claimed: 3, claiming: 2, unclaimed: 1 } as const;

export function folderQuery(folderId: string, status: ClaimStatus, page: number, pageSize: number, reimbursementId = ''): string {
  return new URLSearchParams({ invoiceStatus: status, folderId, page: String(page), pagesize: String(pageSize),
    queryName: 'invoiceBillList', configType: 'invoice', status: '1', orgKindId: 'psm', invoiceReimbursementId: reimbursementId }).toString();
}

export function parseFolders(value: unknown): InvoiceFolder[] {
  const data = (value as { data?: unknown })?.data;
  if ((value as { status?: unknown })?.status !== 0 || !Array.isArray(data)) throw new InvoiceClaimError('response_invalid');
  return data.map(item => ({ id: String(item?.id ?? ''), name: String(item?.invoiceFolderName ?? '') }))
    .filter(folder => /^\d{1,32}$/.test(folder.id));
}

export function parseRows(value: unknown): { total: number; rows: FolderRow[] } {
  const data = (value as { data?: { Rows?: unknown; Total?: unknown } })?.data;
  if ((value as { status?: unknown })?.status !== 0 || !data || !Array.isArray(data.Rows)) throw new InvoiceClaimError('response_invalid');
  return { total: Number(data.Total) || 0, rows: data.Rows };
}

/** Strongest state wins: one 已报销 hit outweighs an 未报销 copy in another folder. */
export function classifyClaim(hits: ClaimHit[]): InvoiceClaim {
  if (!hits.length) return { state: 'absent' };
  const state = hits.map(hit => STATE[hit.status]).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  const strongest = hits.filter(hit => STATE[hit.status] === state);
  const documents = [...new Set(strongest.flatMap(hit => hit.documents ?? []))];
  const claimedAmount = strongest.find(hit => hit.claimedAmount)?.claimedAmount;
  return { state, folders: [...new Set(strongest.map(hit => hit.folder))],
    ...(documents.length ? { documents } : {}), ...(claimedAmount ? { claimedAmount } : {}) };
}

function claimedBy(claim: { documents?: string[]; claimedAmount?: string }): string {
  if (!claim.documents?.length) return '';
  return `（单据 ${claim.documents.join('、')}${claim.claimedAmount ? `，实报 ${claim.claimedAmount} 元` : ''}）`;
}

export function claimMessage(claim: InvoiceClaim): string {
  switch (claim.state) {
    case 'claimed': return `OA 票夹（${claim.folders.join('、')}）显示该发票已报销${claimedBy(claim)}，不能重复报销。`;
    case 'claiming': return `OA 票夹（${claim.folders.join('、')}）显示该发票正在其他报销单中（报销中${claimedBy(claim)}）。`;
    case 'unclaimed': return claim.documents?.length
      ? `该发票状态为未报销，但已关联在单据 ${claim.documents.join('、')} 上；请先在该单中移除发票或改用该单，不能再关联到新单。`
      : `该发票已在 OA 票夹（${claim.folders.join('、')}）中，状态为未报销，可以使用。`;
    default: return '票夹中未发现该发票（已报销记录只核对了最近一页）。';
  }
}

/** Same lookup from inside an open BPM frame (its cookies and csrfToken), limited to
 * 报销中 and the recent 已报销 page: explains an upload that never reaches 未报销. */
export async function checkInvoiceClaimInPage(fetchJson: (url: string) => Promise<unknown>,
  invoiceNumber: string): Promise<InvoiceClaim> {
  const folders = parseFolders(await fetchJson(INVOICE_FOLDERS_PATH));
  const hits: ClaimHit[] = [];
  await Promise.all(folders.flatMap(folder => (['报销中', '已报销'] as const).map(async status => {
    const { rows } = parseRows(await fetchJson(`${INVOICE_FOLDER_ROWS_PATH}?${folderQuery(folder.id, status, 1,
      status === '已报销' ? CLAIMED_PAGE_SIZE : PAGE_SIZE)}`));
    const row = rows.find(item => String(item.invoiceNumber ?? '') === invoiceNumber);
    if (row) hits.push(hitOf(row, status, folder.name));
  })));
  return classifyClaim(hits);
}

function folderGetter(client: OaHttpClient, page: { url: string; csrfToken: string }) {
  return async (pathname: string, query = '') => {
    let response;
    try {
      response = await client.request(`${BPM_ORIGIN}${pathname}${query ? `?${query}` : ''}`, { followRedirects: false,
        headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', csrfToken: page.csrfToken, referer: page.url } });
    } catch { throw new InvoiceClaimError('request_failed'); }
    if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) {
      throw new InvoiceClaimError('authentication');
    }
    try { return JSON.parse(response.text) as unknown; } catch { throw new InvoiceClaimError('response_invalid'); }
  };
}

/** One 未报销 invoice of an OA folder, as the invoice dialog lists it. */
export interface FolderInvoice {
  number: string;
  folderId: string;
  folder: string;
  fileName: string;
  seller: string;
  /** YYYY-MM-DD. */
  date: string;
  /** 价税合计. */
  amount: string;
  /** 可报余额; below amount once another form has claimed part of it. */
  balance: string;
  /** Bill codes already using it. */
  documents: string[];
  checkState: string;
}

const money = (value: unknown) => {
  const number = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(number) ? number.toFixed(2) : '';
};

/** 未报销 invoices of every folder (read-only): one request of at most 100 rows per folder. */
export async function listFolderInvoicesHttp(client: OaHttpClient, page: { url: string; csrfToken: string }):
  Promise<{ invoices: FolderInvoice[]; truncated: boolean }> {
  const get = folderGetter(client, page);
  const folders = parseFolders(await get(INVOICE_FOLDERS_PATH));
  if (!folders.length) throw new InvoiceClaimError('response_invalid');
  const found = new Map<string, FolderInvoice>();
  let truncated = false;
  const pages = await Promise.all(folders.map(folder => get(INVOICE_FOLDER_ROWS_PATH, folderQuery(folder.id, '未报销', 1, FOLDER_PAGE_SIZE))));
  for (const [index, folder] of folders.entries()) {
    const { total, rows } = parseRows(pages[index]);
    if (total > rows.length) truncated = true;
    for (const row of rows as Array<FolderRow & Record<string, unknown>>) {
      const number = String(row.invoiceNumber ?? '');
      if (!/^\d{20}$/.test(number) || found.has(`${folder.id}|${number}`)) continue;
      const bill = row.electronicInvoice?.billEnOut;
      found.set(`${folder.id}|${number}`, { number, folderId: folder.id, folder: folder.name,
        fileName: String(row.invoiceFilesName ?? ''), seller: String(row.salerName ?? ''), date: String(row.invoiceDate ?? '').slice(0, 10),
        amount: money(row.allValoremTax), balance: money(row.invoiceBalance),
        documents: typeof bill?.billCodeList === 'string' ? bill.billCodeList.match(/[A-Z]\d{6,32}/g) ?? [] : [],
        checkState: String(row.billCheckStateTextView ?? '') });
    }
  }
  return { invoices: [...found.values()], truncated };
}

export interface KnownInvoice {
  number: string;
  state: 'absent' | 'unclaimed' | 'claiming' | 'claimed';
  folderId?: string;
  folder?: string;
  seller?: string;
  date?: string;
  amount?: string;
  balance?: string;
  documents?: string[];
}

/** One 未报销 page per folder (read together) for a whole upload, to reuse invoices already there. 报销中 and
 * 已报销 are not read (slow lists): OA refuses such an invoice on upload, naming its bill. */
export async function lookupInvoicesHttp(client: OaHttpClient, page: { url: string; csrfToken: string },
  numbers: string[]): Promise<KnownInvoice[]> {
  const wanted = new Set(numbers);
  const get = folderGetter(client, page);
  const folders = parseFolders(await get(INVOICE_FOLDERS_PATH));
  if (!folders.length) throw new InvoiceClaimError('response_invalid');
  const found = new Map<string, KnownInvoice>();
  // The folders are read together, as OA's invoice dialog does; the first folder still wins a duplicate.
  const pages = await Promise.all(folders.map(folder => get(INVOICE_FOLDER_ROWS_PATH, folderQuery(folder.id, '未报销', 1, FOLDER_PAGE_SIZE))));
  for (const [index, folder] of folders.entries()) {
    const { rows } = parseRows(pages[index]);
    for (const row of rows as Array<FolderRow & Record<string, unknown>>) {
      const number = String(row.invoiceNumber ?? '');
      if (!wanted.has(number) || found.has(number)) continue;
      const bill = row.electronicInvoice?.billEnOut;
      const documents = typeof bill?.billCodeList === 'string' ? bill.billCodeList.match(/[A-Z]\d{6,32}/g) ?? [] : [];
      found.set(number, { number, state: 'unclaimed', folderId: folder.id, folder: folder.name,
        seller: String(row.salerName ?? ''), date: String(row.invoiceDate ?? '').slice(0, 10),
        amount: money(row.allValoremTax), balance: money(row.invoiceBalance), ...(documents.length ? { documents } : {}) });
    }
  }
  return numbers.map(number => found.get(number) ?? { number, state: 'absent' });
}

/** Read-only folder lookup with the csrfToken of any loaded BPM page. */
export async function checkInvoiceClaimHttp(client: OaHttpClient, page: { url: string; csrfToken: string },
  invoiceNumber: string): Promise<InvoiceClaim> {
  if (!/^\d{20}$/.test(invoiceNumber)) throw new InvoiceClaimError('response_invalid');
  const get = folderGetter(client, page);
  const folders = parseFolders(await get(INVOICE_FOLDERS_PATH));
  if (!folders.length) throw new InvoiceClaimError('response_invalid');
  const hits: ClaimHit[] = [];
  await Promise.all(folders.flatMap(folder => CLAIM_STATUSES.map(async status => {
    const size = status === '已报销' ? CLAIMED_PAGE_SIZE : PAGE_SIZE;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const { total, rows } = parseRows(await get(INVOICE_FOLDER_ROWS_PATH, folderQuery(folder.id, status, pageNo, size)));
      const row = rows.find(item => String(item.invoiceNumber ?? '') === invoiceNumber);
      if (row) { hits.push(hitOf(row, status, folder.name)); return; }
      if (status === '已报销' || !rows.length || pageNo * size >= total) return;
    }
    // Unread pages: a hit could be hidden there, so do not report the invoice as usable or absent.
    throw new InvoiceClaimError('response_invalid');
  })));
  return classifyClaim(hits);
}
