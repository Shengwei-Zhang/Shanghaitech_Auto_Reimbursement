import type { Frame, Locator, Page } from 'playwright';
import { DEFAULT_TIMEOUT_MS, getEnvValue } from './config';
import { AutomationContext, type BrowserSession, type RootTarget } from './browser';
import { findFrameWithSelector, searchRoots } from './dom';
import { runAndFocusBpmPage } from './navigation';
import { switchToRecordedFrameOrElementContext } from './frames';
import { clickWorkflowSearchResult, waitForWorkflowSearchResults } from './workflow-search';
import { fillWorkflowSearch } from './workbench';
import { saveDebugState } from './actions';
import { egateTaskListUrl } from './auth';
import { watchRequestActivity, waitForRequestQuiet } from './request-activity';

const OWNER_QUERY_URL = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do';
const CAS_LOGIN_URL = 'https://ids.shanghaitech.edu.cn/authserver/login?service=';
const DOCUMENT_NUMBER_PATTERN = /A\d{12,}/;
const REQUIRED_REIMBURSEMENT_CHECKS = 3;
const BPM_BASE_URL = 'https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new';

export type ReimbursementSelectionResult = 'opened' | 'create';
interface OwnerQueryCandidate {
  root: RootTarget;
  row: Locator;
  number: string;
  bizId?: string;
}

function documentNumberFromText(text: string): string {
  return text.match(DOCUMENT_NUMBER_PATTERN)?.[0] || '';
}

async function pageShowsLoginTimeout(page: Page): Promise<boolean> {
  for (const root of searchRoots(page)) {
    const text = await root.locator('body').innerText().catch(() => '');
    if (/登录超时|请重新登录|登录失效/.test(text)) {
      return true;
    }
  }
  return false;
}

async function ownerQueryIsReady(page: Page): Promise<boolean> {
  if (await pageShowsLoginTimeout(page) || page.url().includes('authserver/login')) {
    return false;
  }
  if (!page.url().includes('/rbReimbursementQuery/')) {
    return false;
  }
  for (const root of searchRoots(page)) {
    const text = await root.locator('body').innerText().catch(() => '');
    if (/单据编号|报销单查询|我的报销|A\d{12,}/.test(text)) {
      return true;
    }
  }
  return false;
}

async function bootstrapBpmSessionFromWorkbench(
  session: BrowserSession,
  ctx: AutomationContext,
  workbenchPage: Page,
  timeoutMs: number,
): Promise<Page> {
  session.page = workbenchPage;
  ctx.updatePage(workbenchPage);
  await workbenchPage.bringToFront().catch(() => undefined);
  await fillWorkflowSearch(ctx, timeoutMs);
  await waitForWorkflowSearchResults(ctx, timeoutMs);
  const bpmPage = await runAndFocusBpmPage(
    session,
    ctx,
    () => clickWorkflowSearchResult(ctx, 'bootstrap-bpm-session'),
    timeoutMs,
  );
  await bpmPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  return bpmPage;
}

async function openOwnerQueryWithSso(
  session: BrowserSession,
  ctx: AutomationContext,
  workbenchPage: Page,
  timeoutMs: number,
): Promise<Page> {
  let page = await session.context.newPage();
  await page.goto(OWNER_QUERY_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (!await ownerQueryIsReady(page)) {
    console.log('Owner query requires a fresh SSO ticket; reopening through CAS.');
    await page.goto(`${CAS_LOGIN_URL}${encodeURIComponent(OWNER_QUERY_URL)}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  }

  if (!await ownerQueryIsReady(page)) {
    console.log('Direct CAS access failed; bootstrapping BPM session from egate service.');
    await page.close().catch(() => undefined);
    page = await bootstrapBpmSessionFromWorkbench(session, ctx, workbenchPage, timeoutMs);
    await page.goto(OWNER_QUERY_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  if (!await ownerQueryIsReady(page)) {
    throw new Error(
      'BPM owner query is still unavailable after egate SSO bootstrap. '
      + 'Automation stopped without creating a reimbursement form.',
    );
  }
  return page;
}

export async function loadOwnerQueryGrid(page: Page, timeoutMs: number): Promise<void> {
  for (const root of searchRoots(page)) {
    if (!(await root.locator('#maingrid').count().catch(() => 0))) {
      continue;
    }
    await root.waitForFunction(() => {
      const grid = (window as Window & {
        gridManager?: { getData?: () => unknown[]; loadData?: () => void };
      }).gridManager;
      return Boolean(grid?.getData);
    }, undefined, { timeout: timeoutMs });

    // The live query initially renders a hidden loading indicator and “0 rows”.
    // Observe this query's transport before triggering it; that initial UI is
    // not evidence that the query has completed.
    const activity = watchRequestActivity(page, request => {
      const url = new URL(request.url());
      const ownerUrl = new URL(page.url());
      return ['xhr', 'fetch'].includes(request.resourceType())
        && url.origin === ownerUrl.origin
        && url.pathname.startsWith(`${ownerUrl.pathname.split('/rbReimbursementQuery/')[0]}/rbReimbursementQuery/`);
    });
    try {
      await root.evaluate(() => {
        const runtime = window as Window & {
          gridManager?: { getData?: () => unknown[]; loadData?: () => void };
          query?: (form: HTMLFormElement) => void;
        };
        const form = document.querySelector('#queryMainForm') as HTMLFormElement | null;
        if (runtime.query && form) {
          runtime.query(form);
        } else {
          runtime.gridManager?.loadData?.();
        }
      });
      await waitForRequestQuiet(page, activity, timeoutMs, 250, true);
    } finally {
      activity.dispose();
    }

    await root.waitForFunction(() => {
      const grid = (window as Window & {
        gridManager?: { getData?: () => unknown[] };
      }).gridManager;
      const loading = document.querySelector('#maingrid .l-grid-loading') as HTMLElement | null;
      return Boolean(grid?.getData)
        && (!loading || window.getComputedStyle(loading).display === 'none');
    }, undefined, { timeout: timeoutMs });
    return;
  }
  throw new Error('Owner-query LigerUI grid was not found.');
}

async function ownerQueryRows(page: Page): Promise<OwnerQueryCandidate[]> {
  const result: OwnerQueryCandidate[] = [];
  for (const root of searchRoots(page)) {
    if (await root.locator('#maingrid').count().catch(() => 0)) {
      const data = await root.evaluate(() => {
        const grid = (window as Window & {
          gridManager?: { getData?: () => Array<Record<string, unknown>> };
        }).gridManager;
        return (grid?.getData?.() || []).map((item) => ({
          billCode: String(item.billCode || ''),
          bizId: String(item.id || item.bizId || ''),
        }));
      }).catch(() => [] as Array<{ billCode: string; bizId: string }>);
      const gridRows = root.locator('#maingrid .l-grid2 .l-grid-row');
      data.forEach((item, index) => {
        const number = documentNumberFromText(item.billCode);
        if (number && !result.some((candidate) => candidate.number === number)) {
          result.push({ root, row: gridRows.nth(index), number, bizId: item.bizId });
        }
      });
      if (result.length > 0) {
        continue;
      }
    }

    const rows = root.locator('tr, .l-grid-row, .el-table__row, [role="row"]');
    const count = Math.min(await rows.count().catch(() => 0), 100);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) {
        continue;
      }
      const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const number = documentNumberFromText(text);
      if (number && !result.some((item) => item.number === number)) {
        result.push({ root, row, number });
      }
    }

    const leafNumbers = root.locator(
      "xpath=//*[contains(normalize-space(.), 'A20')]"
      + "[not(descendant::*[contains(normalize-space(.), 'A20')])]",
    );
    const leafCount = Math.min(await leafNumbers.count().catch(() => 0), 100);
    for (let index = 0; index < leafCount; index += 1) {
      const leaf = leafNumbers.nth(index);
      if (!(await leaf.isVisible().catch(() => false))) {
        continue;
      }
      const text = (await leaf.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const number = documentNumberFromText(text);
      if (!number || result.some((item) => item.number === number)) {
        continue;
      }
      const row = leaf.locator('xpath=ancestor::tr[1] | ancestor::*[contains(@class,"l-grid-row")][1]');
      result.push({
        root,
        row: await row.count().catch(() => 0) ? row.first() : leaf,
        number,
      });
    }
  }
  return result;
}

async function reimbursementHasInvoice(page: Page): Promise<boolean> {
  const frame = await findFrameWithSelector(page, '#invoiceGrid, #actualTotalAmount', false);
  if (!frame) {
    throw new Error('Reimbursement detail did not expose invoice fields.');
  }
  return frame.evaluate(() => {
    const invoiceText = document.querySelector('#invoiceGrid')?.textContent || '';
    const total = (document.querySelector('#actualTotalAmount') as HTMLInputElement | null)?.value || '';
    return /[2]\d{19}/.test(invoiceText)
      || (/\d+\.\d{2}/.test(invoiceText) && !/显示0到0|共0条/.test(invoiceText))
      || Boolean(total && total !== '0.00');
  });
}

async function openOwnerRow(
  session: BrowserSession,
  queryPage: Page,
  candidate: OwnerQueryCandidate,
  timeoutMs: number,
): Promise<Page> {
  if (candidate.bizId) {
    const detailPage = await session.context.newPage();
    await detailPage.goto(
      `${BPM_BASE_URL}/rbReimbursement/showLoadRbReimbursement.job?isReadOnly=true&bizId=${encodeURIComponent(candidate.bizId)}`,
      { waitUntil: 'domcontentloaded', timeout: timeoutMs },
    );
    return detailPage;
  }

  const row = candidate.row;
  const pagesBefore = new Set(session.context.pages());
  const popupPromise = session.context.waitForEvent('page', {
    timeout: Math.min(timeoutMs, 8000),
  }).catch(() => null);

  const action = row.locator('a, button, [role="button"]')
    .filter({ hasText: /查看|详情|办理|编辑|打开|A\d{12,}/ })
    .first();
  if (await action.isVisible().catch(() => false)) {
    await action.click({ force: true });
  } else {
    await row.dblclick({ force: true });
  }

  const popup = await popupPromise;
  const createdPage = popup || session.context.pages().find((page) => !pagesBefore.has(page));
  const detailPage = createdPage || queryPage;
  await detailPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  return detailPage;
}

async function findEmptyReimbursementNumber(
  session: BrowserSession,
  ctx: AutomationContext,
  workbenchPage: Page,
  timeoutMs: number,
): Promise<{ documentNumber: string; checkedCount: number }> {
  let queryPage: Page | null = null;
  try {
    console.log(`Opening reimbursement owner query: ${OWNER_QUERY_URL}`);
    queryPage = await openOwnerQueryWithSso(session, ctx, workbenchPage, timeoutMs);
    await loadOwnerQueryGrid(queryPage, timeoutMs);
    const initialRows = await ownerQueryRows(queryPage);
    console.log(`Owner query returned ${initialRows.length} reimbursement record(s).`);
    if (initialRows.length === 0) {
      const debugCtx = new AutomationContext(queryPage);
      debugCtx.setStage('inspect owner query');
      const debug = await saveDebugState(debugCtx, 'owner-query-empty');
      console.warn(`Owner query returned no records; diagnostic saved to ${debug.jsonPath}`);
    }

    let checkedCount = 0;
    for (
      let index = 0;
      index < initialRows.length && checkedCount < REQUIRED_REIMBURSEMENT_CHECKS;
      index += 1
    ) {
      const currentRows = await ownerQueryRows(queryPage);
      const candidate = currentRows[index];
      if (!candidate) {
        break;
      }
      console.log(`Checking reimbursement ${index + 1}/${initialRows.length}: ${candidate.number}`);
      const detailPage = await openOwnerRow(session, queryPage, candidate, timeoutMs);
      let hasInvoice: boolean;
      try {
        hasInvoice = await reimbursementHasInvoice(detailPage);
        checkedCount += 1;
      } finally {
        if (detailPage !== queryPage) {
          await detailPage.close().catch(() => undefined);
          await queryPage.bringToFront().catch(() => undefined);
        } else {
          await queryPage.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
          await loadOwnerQueryGrid(queryPage, timeoutMs);
        }
      }

      if (!hasInvoice) {
        console.log(`Found reimbursement without uploaded invoice: ${candidate.number}`);
        return { documentNumber: candidate.number, checkedCount };
      }
    }
    return { documentNumber: '', checkedCount };
  } finally {
    await queryPage?.close().catch(() => undefined);
  }
}

async function findTaskSearchInput(page: Page): Promise<{ root: RootTarget; input: Locator } | null> {
  for (const root of searchRoots(page)) {
    const inputs = root.locator('input:visible, textarea:visible');
    const count = Math.min(await inputs.count().catch(() => 0), 50);
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const description = await input.evaluate((element) => {
        const node = element as HTMLInputElement;
        return [
          node.placeholder,
          node.name,
          node.id,
          node.getAttribute('aria-label'),
          node.closest('form, .search, .filter, .toolbar, div')?.textContent,
        ].filter(Boolean).join(' ');
      }).catch(() => '');
      if (/任务|标题|单据|编号|关键字|名称|搜索|查询/.test(description)
        && !/事项名称|服务事项|智能搜索/.test(description)) {
        return { root, input };
      }
    }
  }
  return null;
}

async function searchTaskByDocumentNumber(
  session: BrowserSession,
  ctx: AutomationContext,
  documentNumber: string,
  timeoutMs: number,
): Promise<boolean> {
  const workbenchPage = session.page;
  await workbenchPage.goto(
    getEnvValue('EGATE_TASK_LIST_URL') || egateTaskListUrl(workbenchPage.url()),
    { waitUntil: 'domcontentloaded', timeout: timeoutMs },
  );
  ctx.updatePage(workbenchPage);
  await workbenchPage.waitForTimeout(1500);

  const search = await findTaskSearchInput(workbenchPage);
  if (!search) {
    throw new Error(`Task-center search input was not found at ${workbenchPage.url()}.`);
  }

  ctx.setActiveFrame(search.root === workbenchPage ? null : search.root as Frame);
  await search.input.fill(documentNumber);
  await search.input.press('Enter').catch(() => undefined);
  const searchButton = search.root.getByRole('button', { name: /查询|搜索/ }).first();
  if (await searchButton.isVisible().catch(() => false)) {
    await searchButton.click().catch(() => undefined);
  }
  ctx.setActiveFrame(null);
  await workbenchPage.waitForTimeout(1500);

  for (const root of searchRoots(workbenchPage)) {
    const result = root.locator('tr, .el-table__row, [role="row"], li, a')
      .filter({ hasText: documentNumber })
      .first();
    if (!(await result.isVisible().catch(() => false))) {
      continue;
    }
    await runAndFocusBpmPage(
      session,
      ctx,
      () => result.click({ force: true }),
      timeoutMs,
    );
    console.log(`Opened todo task for reimbursement ${documentNumber}.`);
    return true;
  }

  console.warn(`No todo task found for reimbursement ${documentNumber}.`);
  return false;
}

export async function openEmptyReimbursementTodoIfAvailable(
  session: BrowserSession,
  ctx: AutomationContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReimbursementSelectionResult> {
  const workbenchPage = session.page;
  const inspection = await findEmptyReimbursementNumber(session, ctx, workbenchPage, timeoutMs);

  session.page = workbenchPage;
  ctx.updatePage(workbenchPage);
  await workbenchPage.bringToFront().catch(() => undefined);

  if (!inspection.documentNumber) {
    if (inspection.checkedCount < REQUIRED_REIMBURSEMENT_CHECKS) {
      throw new Error(
        `Only ${inspection.checkedCount} reimbursement form(s) could be inspected. `
        + `At least ${REQUIRED_REIMBURSEMENT_CHECKS} must be checked before creation is allowed.`,
      );
    }
    console.log(
      `The first ${REQUIRED_REIMBURSEMENT_CHECKS} reimbursement forms all contain invoices; `
      + 'creating a new reimbursement form is allowed.',
    );
    return 'create';
  }

  const opened = await searchTaskByDocumentNumber(
    session,
    ctx,
    inspection.documentNumber,
    timeoutMs,
  );
  if (!opened) {
    throw new Error(
      `An empty reimbursement ${inspection.documentNumber} exists, but its todo task could not be opened. `
      + 'Creation is not allowed.',
    );
  }
  return 'opened';
}
