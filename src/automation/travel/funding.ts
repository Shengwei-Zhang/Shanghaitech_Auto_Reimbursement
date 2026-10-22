import type { OaHttpClient } from '../http-login';
import { bpmEncodeURI, searchBudgetHttp, searchFundingHttp, type HttpForm } from '../http-bpm';
import type { FUNDING_KINDS, FundingItem } from '../funding-search';
import { cents, envelope, HttpTravelError, record, thousands, TRAVEL_KIND, TRAVEL_PATHS, yuan, type TravelSend } from './request';

/** 经费明细 of a 境内差旅单: one 经费项目 (OA allows one per form) and one or more 支出项目 under it,
 * each with its amount and 用途. Their sum must equal the 差旅合计 (OA refuses the advance otherwise). */
export interface FundingLine {
  /** expenditureItemName of exactly one budget row, e.g. 国内差旅/参会费. */
  budgetName: string;
  /** Yuan; at most one line may leave it out and takes what the others leave of the 差旅合计. */
  amount?: string;
  /** 经费明细的“用途”. */
  purpose: string;
}

export interface FundingChoice {
  fund: FundingItem;
  /** The budget row of each line, in line order. */
  rows: Record<string, unknown>[];
  /** requireAmount of the fund (cents), only sent back to OA in the funding save as its page does; never shown or
   * checked against (showAmount in budgetData is what this user may see). */
  fundBalance: number;
  budgetData?: Record<string, unknown>;
}

/** 按经费编号和每行预算科目名称唯一定位（只读）. Budget rows are those of the 差旅单 type. */
export async function chooseTravelFunding(client: OaHttpClient, form: HttpForm, fundingKind: keyof typeof FUNDING_KINDS,
  fundingCode: string, lines: FundingLine[]): Promise<FundingChoice> {
  let funds;
  try { funds = (await searchFundingHttp(client, form, { kind: fundingKind, paramValue: fundingCode, pageSize: 100 })).list.items; }
  catch (error) { throw new HttpTravelError((error as { code?: string })?.code === 'authentication' ? 'authentication' : 'request_failed', 'funding'); }
  const matches = funds.filter(item => item.projectId === fundingCode);
  if (matches.length !== 1) throw new HttpTravelError('funding_missing', 'funding');
  const fund = matches[0];
  const budgetRows: Record<string, unknown>[] = [];
  let budgetData: Record<string, unknown> | undefined;
  for (let page = 1; page <= 10; page++) {
    let budget;
    try { budget = await searchBudgetHttp(client, form, { fundingItemsCode: fund.projectId, reimbursementKind: TRAVEL_KIND, page, pagesize: 20 }); }
    catch (error) { throw new HttpTravelError((error as { code?: string })?.code === 'authentication' ? 'authentication' : 'request_failed', 'funding'); }
    const data = record(record(budget.response)?.data);
    if (!budget.outlays || !data || !Array.isArray(data.Rows)) throw new HttpTravelError('response_invalid', 'funding');
    budgetData ??= data;
    budgetRows.push(...data.Rows.map(row => record(row) ?? {}));
    if (!data.Rows.length || budgetRows.length >= Number(data.Total ?? 0)) break;
  }
  if (budgetRows.length < Number(budgetData?.Total ?? 0)) throw new HttpTravelError('response_invalid', 'funding');
  const rows = lines.map(line => {
    const hits = budgetRows.filter(row => row.expenditureItemName === line.budgetName.trim() && row.projectCode === fund.projectId);
    if (hits.length !== 1) throw new HttpTravelError('budget_missing', 'funding', line.budgetName);
    return hits[0];
  });
  const fundBalance = cents(budgetData?.requireAmount);
  if (fundBalance === null) throw new HttpTravelError('response_invalid', 'funding');
  return { fund, rows, fundBalance, budgetData };
}

/** 保存经费选择 with every line's budget row in one request (the dialog's grid is multi-select);
 * returns the new fundingItemsId. */
export async function saveTravelFunding(send: TravelSend, form: HttpForm, { fund, rows, fundBalance, budgetData }: FundingChoice): Promise<string> {
  const saved = envelope(await send(TRAVEL_PATHS.saveFunding, { form: {
    reimbursementId: form.context.bizId, projectCode: fund.projectId, projectName: fund.projectName, deptCode: fund.departmentId,
    deptName: fund.departmentName, requireAmount: thousands(fundBalance), // showAmount as OA returned it: empty when the balance is not authorized to this user, as the page sends it.
    showAmount: String(budgetData?.showAmount ?? ''),
    manager: fund.firstId, budgetOutlays: bpmEncodeURI(JSON.stringify(rows)),
  } }, 'funding'), 'funding');
  const fundingItemsId = typeof saved.data === 'string' ? saved.data : '';
  if (String(saved.status) !== '1' || !/^[\dA-F]{32}$/i.test(fundingItemsId)) throw new HttpTravelError('funding_rejected', 'funding');
  return fundingItemsId;
}

/** Each line's amount in cents once the 差旅合计 is known: the blank line takes the rest. Every line
 * must be positive and within the balance OA shows (showAmount) for its row and for the fund; a balance
 * not authorized to this user (empty showAmount) is not checked here, OA itself still is. */
export function lineAmounts(lines: FundingLine[], trip: number, choice: Pick<FundingChoice, 'rows' | 'budgetData'>): number[] {
  const given = lines.map(line => (line.amount === undefined || line.amount.trim() === '' ? null : cents(line.amount)));
  const rest = trip - given.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const amounts = given.map(value => value ?? rest);
  if (amounts.some(value => value <= 0) || amounts.reduce((sum, value) => sum + value, 0) !== trip) {
    throw new HttpTravelError('lines_invalid', 'save', `差旅合计 ${yuan(trip)} 元，各行 ${amounts.map(yuan).join(' + ')}`);
  }
  for (const [index, amount] of amounts.entries()) {
    const balance = cents(choice.rows[index].showAmount);
    if (balance !== null && amount > balance) {
      throw new HttpTravelError('budget_over', 'save', `${String(choice.rows[index].expenditureItemName)} ${yuan(amount)} 元，可用 ${yuan(balance)} 元`);
    }
  }
  const shown = cents(choice.budgetData?.showAmount);
  if (shown !== null && trip > shown) throw new HttpTravelError('budget_over', 'save', `经费可用 ${yuan(shown)} 元`);
  return amounts;
}
