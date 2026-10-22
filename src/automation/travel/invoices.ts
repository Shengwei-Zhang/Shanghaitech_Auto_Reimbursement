import type { OaHttpClient } from '../http-login';
import type { HttpForm } from '../http-bpm';
import { invoiceLimitProblems } from '../../domain/invoice-rules';
import { folderQuery, lookupInvoicesHttp, parseFolders, parseRows, FOLDER_PAGE_SIZE, INVOICE_FOLDERS_PATH, INVOICE_FOLDER_ROWS_PATH,
  type InvoiceFolder } from '../invoice-claim';
import { cents, envelope, getJson, gridRows, HttpTravelError, multipart, post, record, TRAVEL_PATHS, type TravelSend, type TravelStep } from './request';

/** 发票 of a 境内差旅单: the same folder upload and link as the OA invoice dialog (captured
 * 2026-10-21), a copy of 用款申请单's so the two forms can change apart. */
export interface TravelInvoice { fileName: string; number: string; bytes?: Uint8Array; folderId?: string }
export interface InvoiceOptions { invoiceWaitMs?: number; sleep?: (ms: number) => Promise<void> }

const DEFAULT_FOLDER = '表单默认票夹';
/** Simultaneous invoice uploads; OA's own page sends every selected file at once. */
const UPLOADS_AT_ONCE = 5;
const FILL_PATHS = TRAVEL_PATHS;

/** Invoices already linked to the form. */
export async function travelInvoiceCount(client: OaHttpClient, form: HttpForm): Promise<number> {
  return gridRows(envelope(await post(client, form, TRAVEL_PATHS.formInvoices, { form: { reimbursementId: form.context.bizId,
    page: '1', pagesize: '10', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' } }, 'invoice'), 'invoice'), 'invoice').length;
}

/** 发票 before anything is written to the form: invoices already in an OA folder are checked
 * read-only, the other PDFs uploaded into 表单默认票夹 (which leaves the form untouched) and
 * waited for there; the 500 元 limits are checked on the OA rows. Returns the folder rows by number. */
export async function prepareTravelInvoices(client: OaHttpClient, form: HttpForm, invoices: TravelInvoice[], send: TravelSend,
  progress: (step: TravelStep, message: string) => void, options: InvoiceOptions = {})
  : Promise<{ listed: Map<string, Record<string, unknown>>; uploaded: number }> {
  const bizId = form.context.bizId;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // 票夹中已有的发票：写入任何内容前只读确认它们仍未报销，并按 OA 数据核对报销限制
  const home = new Map(invoices.flatMap(item => item.folderId ? [[item.number, item.folderId] as [string, string]] : []));
  const listed = new Map<string, Record<string, unknown>>();
  const look = async () => {
    const folderIds = [...new Set([...home].filter(([number]) => !listed.has(number)).map(([, id]) => id))];
    const pages = await Promise.all(folderIds.map(folderId => getJson(client, form, INVOICE_FOLDER_ROWS_PATH,
      folderQuery(folderId, '未报销', 1, FOLDER_PAGE_SIZE, bizId), 'invoice')));
    for (const [index, folderId] of folderIds.entries()) {
      for (const item of parseRows(pages[index]).rows as Record<string, unknown>[]) {
        const number = String(item.invoiceNumber ?? '');
        if (home.get(number) === folderId && !listed.has(number)) listed.set(number, item);
      }
    }
  };
  const overLimit = (rows: Record<string, unknown>[]) => invoiceLimitProblems(rows.map(row => ({ number: String(row.invoiceNumber ?? ''),
    faceCents: cents(row.allValoremTax), usedCents: cents(row.invoiceBalance), seller: String(row.salerName ?? '') || undefined,
    date: String(row.invoiceDate ?? '').slice(0, 10) || undefined }))).length > 0;
  let folders: InvoiceFolder[] | undefined;
  const pdfs = invoices.filter(item => item.bytes);
  // Split PDFs are named after their page (merge-第3页.pdf), so name the row and file, not just the number.
  const named = (number: string) => {
    const index = invoices.findIndex(item => item.number === number);
    return index < 0 ? `发票 ${number}` : `第 ${index + 1} 张发票 ${number}（${invoices[index].fileName}）`;
  };
  if (pdfs.length) {
    const known = await lookupInvoicesHttp(client, form, pdfs.map(item => item.number));
    for (const invoice of pdfs) {
      const hit = known.find(item => item.number === invoice.number);
      if (hit?.state !== 'unclaimed' || !hit.folderId) continue;
      if (hit.documents?.length) {
        throw new HttpTravelError('invoice_claimed', 'invoice', `${named(invoice.number)} 已关联在单据 ${hit.documents.join('、')}，无法选择。`);
      }
      home.set(invoice.number, hit.folderId);
    }
  }
  const uploads = pdfs.filter(invoice => !home.has(invoice.number));
  if (home.size) {
    folders = parseFolders(await getJson(client, form, INVOICE_FOLDERS_PATH, '', 'invoice'));
    if ([...home.values()].some(id => !folders!.some(item => item.id === id))) throw new HttpTravelError('invoice_missing', 'invoice');
    await look();
    if (listed.size !== home.size) throw new HttpTravelError('invoice_missing', 'invoice');
    if (overLimit([...listed.values()])) throw new HttpTravelError('invoice_limit', 'invoice');
  }

  // 2. 再把尚未进票夹的 PDF 上传到“表单默认票夹”：每张一个请求，同时发出（OA 页面多选上传时就是这样，
  //    2026-10-21 抓包：两个请求同一毫秒发出，各返回一张）。一个请求放多个文件时 OA 只保存最后一个却照样回复
  //    成功。上传只进票夹、不写本单；OA 对已被占用的发票直接拒绝且不保存，所以这时停下本单仍未改动。
  folders ??= parseFolders(await getJson(client, form, INVOICE_FOLDERS_PATH, '', 'upload'));
  const folder = folders.find(item => item.name === DEFAULT_FOLDER);
  if (uploads.length && !folder) throw new HttpTravelError('folder_missing', 'upload');
  const count = invoices.length;
  const kept = pdfs.length - uploads.length;
  if (uploads.length) {
    progress('upload', `${kept ? `其中 ${kept} 张已在票夹中，将直接选中；` : ''}正在${uploads.length > 1 ? `同时上传 ${uploads.length} 张 PDF` : '上传发票 PDF'}`
      + '到“表单默认票夹”，尚未写入本单。');
    const uploadOne = async (invoice: typeof uploads[number]) => {
      const reply = await send(FILL_PATHS.upload, { multipart: multipart([['backurl', 'doSave'], ['folderId', folder!.id]],
        [{ field: 'upload', name: invoice.fileName, type: 'application/pdf', bytes: invoice.bytes! }]) }, 'upload',
      { accept: 'application/json, text/plain, */*', query: `?csrfToken=${encodeURIComponent(form.csrfToken)}` });
      // An invoice already on a bill comes back as an HTML error page, and nothing is stored:
      // "当前票据…（发票号码：…）已被报销，报销人[…]，报销单号[…]", or (live 2026-10-20)
      // "票据[<number>_…pdf]已被(报销人[…]，报销单号[…])报销使用".
      if (!reply.trimStart().startsWith('{') && /已被[^。]{0,120}?报销|报销中/.test(reply)) {
        const text = reply.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const bill = text.match(/报销单号\[([A-Z]\d{6,32})\]/)?.[1];
        throw new HttpTravelError('invoice_claimed', 'upload', `${named(invoice.number)} 已被报销${bill ? `（报销单号 ${bill}）` : ''}，请删除这一张后重新提交。`);
      }
      const uploaded = envelope(reply, 'upload');
      if (String(uploaded.status) !== '0') throw new HttpTravelError('upload_rejected', 'upload');
      const results = record(uploaded.data)?.invoiceResultList;
      const bills = Array.isArray(results) ? results.map(item => record(record(item)?.billEnOut) ?? {}) : [];
      const recognised = bills.filter(bill => bill.invoiceNumber === invoice.number);
      if (recognised.length > 1) throw new HttpTravelError('upload_rejected', 'upload');
      if (recognised.length === 1 && recognised[0].billClaimState !== 'UNDOING') {
        throw new HttpTravelError('invoice_claimed', 'upload', `${named(invoice.number)} 已被报销，请删除这一张后重新提交。`);
      }
    };
    // Every request is let finish, then the first problem in list order is reported.
    const settled: PromiseSettledResult<void>[] = [];
    for (let start = 0; start < uploads.length; start += UPLOADS_AT_ONCE) {
      settled.push(...await Promise.allSettled(uploads.slice(start, start + UPLOADS_AT_ONCE).map(uploadOne)));
    }
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed) throw failed.reason;
  }

  // 3. 写入本单前等票夹列出全部发票（实测上传返回后第一次查询即已列出；识别慢时最多等这里的时限）
  if (uploads.length) {
    progress('upload', uploads.length > 1 ? `${uploads.length} 张 PDF 均已上传，正在核对票夹已列出全部发票。`
      : '上传已返回，正在核对票夹已列出发票。');
    for (const item of uploads) home.set(item.number, folder!.id);
    const deadline = Date.now() + (options.invoiceWaitMs ?? 60_000 + 20_000 * uploads.length);
    for (;;) {
      await look();
      if (listed.size === count) break;
      if (Date.now() >= deadline) throw new HttpTravelError('invoice_pending', 'upload');
      await sleep(3000);
    }
  }
  if (overLimit([...listed.values()])) throw new HttpTravelError('invoice_limit', 'upload');
  return { listed, uploaded: uploads.length };
}

/** 关联发票: all invoices in one request, each for its full 可报余额; together they must cover `amount` (cents),
 * the payment less the subsidies, which need no invoice (D209900000033: payment 3130, invoices 2880). */
export async function linkTravelInvoices(send: TravelSend, form: HttpForm, invoices: TravelInvoice[],
  listed: Map<string, Record<string, unknown>>, amount: number): Promise<void> {
  const bizId = form.context.bizId;
  const count = invoices.length;
  let balances = 0;
  // 一次请求关联全部发票，与票夹“确定”按钮相同（2026-10-21 抓包：insertRecords 两条，回复 insertCount 2）
  const records = invoices.map(invoice => {
    const row = listed.get(invoice.number)!;
    const balance = cents(row.invoiceBalance);
    if (balance === null || balance <= 0) throw new HttpTravelError('invoice_balance', 'invoice');
    balances += balance;
    return { ...row, reimbursementId: bizId, reimbursementSettleName: row.salerName, actualAmount: row.invoiceBalance, flag: true,
      // The page's own mapping swaps these two fields.
      invoiceCode: row.invoiceNumber, invoiceNumber: row.invoiceCode };
  });
  if (balances < amount) throw new HttpTravelError('invoice_balance', 'invoice');
  const linked = envelope(await send(FILL_PATHS.linkInvoice, { json: { insertRecords: records,
    pendingRecords: [], updateRecords: [], removeRecords: [] } }, 'invoice'), 'invoice');
  if (String(linked.status) !== '0' || record(linked.data)?.insertCount !== count) throw new HttpTravelError('invoice_rejected', 'invoice');
  const onForm = gridRows(envelope(await send(FILL_PATHS.formInvoices, { form: { reimbursementId: bizId,
    page: '1', pagesize: '20', sortname: 'invoiceCode', sortorder: 'asc', sortfields: '[]' } }, 'invoice'), 'invoice'), 'invoice');
  if (onForm.length !== count || invoices.some(invoice =>
    onForm.filter(item => [item.invoiceCode, item.invoiceNumber].includes(invoice.number)).length !== 1)) {
    throw new HttpTravelError('invoice_rejected', 'invoice');
  }
}

