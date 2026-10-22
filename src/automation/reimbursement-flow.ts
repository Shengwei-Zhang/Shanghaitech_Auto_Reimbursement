import { openWorkbench, fillWorkflowSearch } from './workbench';
import type { BrowserSession } from './browser';
import { AutomationContext, rememberAuthenticatedSession } from './browser';
import { DEFAULT_TIMEOUT_MS, getEnvValue, pauseOnFailureIfNeeded, requireEnv } from './config';
import { saveDebugState, takeScreenshot } from './actions';
import { runStep, assertStartFromMatched, getCurrentStep, skipStep, isResuming } from './runner';
import {
  authenticateSchool,
  isEgateLoggedIn,
  waitForBpmPageReady,
} from './auth';
import { openEmptyReimbursementTodoIfAvailable } from './todo-reimbursement';
import { switchToRecordedFrameOrElementContext } from './frames';
import { clickWorkflowSearchResult, waitForWorkflowSearchResults } from './workflow-search';
import { waitForFundingEntry } from './editor-entry';
import { focusBestBusinessPage, runAndFocusBpmPage } from './navigation';
import { createPaymentApplication } from './recorded-create';
import { selectFundingItem } from './funding-wizard';
import { attachNextPdfInvoice } from './invoice-pipeline';
import { fillReimbursementDetails, assertReimbursementDetails, assertFundingChoice } from './funding';
import {
  configurePersonalBankCardPayment,
  assertPaymentDetails,
  getSavedReimbursementSummary,
  saveMainReimbursement,
} from './payment';
import type { RuntimeInputs } from './types';
import { assertExpectedInvoice } from './guards';
import { FlowError, type CompletionAction, type SiteProfile, type WorkflowResult } from '../domain/workflow';
import { confirmedWrite, openSubmissionDialog, verifyReceipt } from './submission';
import { confirmSubmission } from './final-submission';
import { moneyToCents, type FormTarget } from '../domain/job';
import { openReimbursementByIds } from './open-reimbursement';
import { canUseBackupEntry, openBackupEntry } from './backup-entry';
import { withCreationLoginRecovery } from './login-recovery';

export interface ExecutionOptions {
  action?: CompletionAction;
  formMode?: 'new' | 'reuse' | 'target';
  /** formMode 'target': this exact form is opened by ID; nothing is created. */
  target?: FormTarget;
  /** The target was already filled and saved over HTTP: only re-read it and submit. */
  submitOnly?: boolean;
  siteProfile?: SiteProfile;
  signal?: AbortSignal;
  onSubmissionValidated?: (summary: { documentNumber: string; amount: string }) => Promise<void>;
}


async function authenticate(session: BrowserSession, ctx: AutomationContext): Promise<void> {
  ctx.setStage('authenticate');
  const manual = getEnvValue('OA_LOGIN_MODE') !== 'credentials';
  const authenticatedPage = await authenticateSchool(ctx.page, { mode: manual ? 'manual' : 'credentials',
    username: manual ? undefined : requireEnv('OA_USERNAME'), password: manual ? undefined : requireEnv('OA_PASSWORD'),
    reuseSession: session.restoredSession });
  session.page = authenticatedPage;
  ctx.updatePage(authenticatedPage);
  await rememberAuthenticatedSession(session);
}

async function createNewReimbursement(
  session: BrowserSession,
  ctx: AutomationContext,
  useBackup = false,
  allowBackup = true,
): Promise<void> {
  ctx.setStage('create reimbursement form');
  if (!useBackup) {
    try {
      await fillWorkflowSearch(ctx);
      await waitForWorkflowSearchResults(ctx);
      await runAndFocusBpmPage(session, ctx,
        () => clickWorkflowSearchResult(ctx, 'open-reimbursement-workflow'));
      await waitForBpmPageReady(session.page);
      process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
        evidence: '工作台搜索入口已打开 BPM 页面，本次未使用备用地址。' });
      return;
    } catch (error) {
      if (!allowBackup || ctx.state.entryAttempted || ctx.state.creationAttempted || !canUseBackupEntry(error)) throw error;
    }
  }
  process.send?.({ type: 'stage', stage: 'create reimbursement form', state: 'started',
    evidence: '工作台入口不可用，尚未尝试创建；在同一登录会话中新建标签页，单次打开无票据备用地址。' });
  await openBackupEntry(session, ctx);
}

async function prepareReimbursementForm(
  ctx: AutomationContext,
  openedExistingTodo: boolean,
  creationAllowed: boolean,
): Promise<void> {
  ctx.setStage('prepare reimbursement form');
  if (!openedExistingTodo && !creationAllowed && !isResuming()) {
    throw new Error(
      'New reimbursement creation was not selected for this execution.',
    );
  }
  // Both entry routes lead to the same operation. The showLoad URL can also
  // render the type-selection page, so its pathname must not skip creation.
  if (!openedExistingTodo && creationAllowed) {
    process.send?.({ type: 'stage', stage: 'prepare reimbursement form', state: 'started',
      evidence: '正在点击“用款申请单”的“创建”，随后确认创建并等待编辑页。' });
    await createPaymentApplication(ctx);
  } else {
    await waitForFundingEntry(ctx);
  }
}

export async function runReimbursementFlow(
  session: BrowserSession,
  runtimeInputs: RuntimeInputs,
  ctx = new AutomationContext(session.page),
  options: ExecutionOptions = {},
): Promise<WorkflowResult> {
  const uploadFilePath = requireEnv('UPLOAD_FILE_PATH');
  const action = options.action || 'save';
  if (isResuming()) await switchToRecordedFrameOrElementContext(ctx, '#editReimburFundingItems');
  let openedExistingTodo = false;
  let creationAllowed = false;
  let useBackup = false;

  if (options.formMode === 'target') {
    const target = options.target;
    if (!target || isResuming()) throw new FlowError('configuration');
    await runStep('authenticate', () => authenticate(session, ctx), async () => {
      if (!await isEgateLoggedIn(ctx.page)) throw new FlowError('authentication');
    });
    skipStep('open workbench', '已指定报销单，按单据 ID 直接打开，不经过工作台。');
    await runStep('select reimbursement form', async () => {
      ctx.setStage('select reimbursement form');
      const opened = await openReimbursementByIds(session, ctx, { bizId: target.bizId, taskId: target.taskId,
        isReadOnly: false, expectedDocumentNumber: target.documentNumber });
      if (opened.documentNumber !== target.documentNumber) throw new FlowError('value_mismatch');
      process.send?.({ type: 'stage', stage: 'select reimbursement form', state: 'started',
        evidence: `已打开指定的用款申请单 ${target.documentNumber}，单据 ID 与编号一致。` });
    });
    openedExistingTodo = true;
    if (options.submitOnly) return submitSavedForm(session, ctx, runtimeInputs, options);
  } else {
    if (options.submitOnly) throw new FlowError('configuration');
    await runStep('authenticate', () => authenticate(session, ctx), async () => {
      if (!await isEgateLoggedIn(ctx.page)) throw new FlowError('authentication');
    });
    try {
      await runStep('open workbench', () => openWorkbench(ctx, { requireWorkRoute: options.formMode === 'reuse' }));
    } catch (error) {
      if (options.formMode === 'reuse' || isResuming() || !canUseBackupEntry(error)) throw error;
      useBackup = true;
      skipStep('open workbench', '工作台搜索未就绪；新建模式将使用用户指定的备用入口，不再等待搜索框。');
    }
    await runStep('select reimbursement form', async () => {
      ctx.setStage('select reimbursement form');
      const result = options.formMode === 'reuse'
        ? await openEmptyReimbursementTodoIfAvailable(session, ctx) : 'create';
      openedExistingTodo = result === 'opened';
      creationAllowed = result === 'create';
      ctx.state.openedFromTodo = openedExistingTodo;
    });
  }

  await withCreationLoginRecovery(session, ctx,
    creationAllowed && !openedExistingTodo && !isResuming() && (options.formMode ?? 'new') === 'new', async recovered => {
      if (!openedExistingTodo && creationAllowed) {
        await runStep('create reimbursement form', () => createNewReimbursement(session, ctx, recovered ? false : useBackup, !recovered));
      } else {
        skipStep('create reimbursement form', '复用现有报销单，跳过创建。');
      }

      await runStep('prepare reimbursement form', () => prepareReimbursementForm(
        ctx,
        openedExistingTodo || ctx.state.openedFromTodo,
        creationAllowed,
      ));
  }, async () => {
    await runStep('authenticate', () => authenticate(session, ctx), async () => {
      if (!await isEgateLoggedIn(ctx.page)) throw new FlowError('authentication');
    });
    await runStep('open workbench', () => openWorkbench(ctx));
  }, options.signal);

  await runStep('select funding item', async () => {
    ctx.setStage('select funding item');
    await selectFundingItem(ctx);
  }, async () => assertFundingChoice(ctx));

  await runStep('attach invoice', async () => {
    ctx.setStage('attach invoice');
    await attachNextPdfInvoice(ctx, uploadFilePath);
    await assertExpectedInvoice(ctx);
  });

  await runStep('configure payment', async () => {
    ctx.setStage('configure payment');
    await configurePersonalBankCardPayment(ctx, runtimeInputs);
  }, async () => assertPaymentDetails(ctx, runtimeInputs, false));


  await runStep('fill reimbursement details', async () => {
    ctx.setStage('fill reimbursement details');
    await fillReimbursementDetails(ctx, runtimeInputs);
  }, async () => {
    await assertReimbursementDetails(ctx, runtimeInputs);
    await assertExpectedInvoice(ctx);
  });


  const summary = await getSavedReimbursementSummary(ctx);
  if (!summary.documentNumber) throw new FlowError('value_mismatch');
  const result: WorkflowResult = { ...summary, action, verification: 'unverified' };
  await runStep('save reimbursement', async () => {
    ctx.setStage('save reimbursement');
    if (options.siteProfile) {
      await confirmedWrite(ctx, options.siteProfile.saveResponse,
        () => saveMainReimbursement(ctx, runtimeInputs), 'save');
    } else {
      await saveMainReimbursement(ctx, runtimeInputs);
    }
  });
  if (options.siteProfile) {
    await runStep('verify saved form', async () => {
      ctx.setStage('verify saved form');
      const observed = await verifyReceipt(session.context, options.siteProfile!, summary, 'save');
      result.receipt = observed.receipt;
      result.verification = 'receipt';
      session.page = observed.page;
      ctx.updatePage(observed.page);
      ctx.setActiveFrame(observed.frame);
    });
  } else {
    skipStep('verify saved form', '尚未配置保存回执，只记录保存操作；由用户在 OA 核对。');
  }
  if (action === 'submit') {
    await submitReimbursement(session, ctx, runtimeInputs, summary, result, options);
  } else {
    for (const step of ['prepare submission', 'confirm submission', 'verify submission'] as const) {
      skipStep(step, '本任务仅保存，不进入流转确认。');
    }
  }

  assertStartFromMatched();
  return result;
}

const FILL_STEPS = ['create reimbursement form', 'prepare reimbursement form', 'select funding item', 'attach invoice',
  'configure payment', 'fill reimbursement details', 'save reimbursement', 'verify saved form'] as const;

/** A form the HTTP fill already saved: the browser re-reads every field against the task, then submits. */
async function submitSavedForm(session: BrowserSession, ctx: AutomationContext, runtimeInputs: RuntimeInputs,
  options: ExecutionOptions): Promise<WorkflowResult> {
  if (options.action !== 'submit') throw new FlowError('configuration');
  await waitForFundingEntry(ctx);
  for (const step of FILL_STEPS) skipStep(step, '已由接口填写并保存，浏览器只核对并提交。');
  await waitForSavedGrids(ctx);
  await assertFundingChoice(ctx);
  await assertExpectedInvoice(ctx);
  const summary = await getSavedReimbursementSummary(ctx);
  if (!summary.documentNumber || summary.documentNumber !== options.target?.documentNumber) throw new FlowError('value_mismatch');
  const result: WorkflowResult = { ...summary, action: 'submit', verification: 'unverified' };
  await submitReimbursement(session, ctx, runtimeInputs, summary, result, options);
  assertStartFromMatched();
  return result;
}

/** A freshly opened editor fills its invoice grid and totals by XHR after the page is
 * interactive; wait for them (read only) so the checks see the saved values. */
async function waitForSavedGrids(ctx: AutomationContext, timeout = DEFAULT_TIMEOUT_MS): Promise<void> {
  const expected = (getEnvValue('EXPECTED_INVOICE_NUMBER') || '').split(',');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await ctx.root().evaluate(numbers => {
      const grid = document.querySelector('#invoiceGrid') as HTMLElement | null;
      const value = (id: string) => (document.querySelector(id) as HTMLInputElement | null)?.value?.trim() || '';
      return numbers.every(number => grid?.innerText.includes(number)) && Boolean(value('#reimbursementReimbursementAmount'))
        && Boolean(value('#reimbursementSettlementAmount'));
    }, expected).catch(() => false);
    if (ready) {
      process.send?.({ type: 'stage', stage: 'prepare submission', state: 'started', evidence: '编辑页的发票、金额和付款表格已加载，开始逐项回读核对。' });
      return;
    }
    await ctx.page.waitForTimeout(200);
  }
  throw new FlowError('control_missing');
}

async function submitReimbursement(session: BrowserSession, ctx: AutomationContext, runtimeInputs: RuntimeInputs,
  summary: { documentNumber: string; amount: string }, result: WorkflowResult, options: ExecutionOptions): Promise<void> {
  await runStep('prepare submission', async () => {
    ctx.setStage('prepare submission');
    await switchToRecordedFrameOrElementContext(ctx, '#advance');
    await assertReimbursementDetails(ctx, runtimeInputs);
    await assertPaymentDetails(ctx, runtimeInputs);
    await openSubmissionDialog(ctx);
  });
  await runStep('confirm submission', async () => {
    ctx.setStage('confirm submission');
    await confirmSubmission(ctx, async () => {
      // The modal can live in an outer frame. Re-read the editor underneath it.
      await switchToRecordedFrameOrElementContext(ctx, '#reimbursementReimbursementAmount');
      await assertReimbursementDetails(ctx, runtimeInputs);
      await assertPaymentDetails(ctx, runtimeInputs);
      await assertFundingChoice(ctx);
      const current = await getSavedReimbursementSummary(ctx);
      const cents = (value: string) => moneyToCents(value.replace(/[,\s￥¥]/g, ''));
      if (current.documentNumber !== summary.documentNumber || cents(current.amount) !== cents(summary.amount)) {
        throw new FlowError('value_mismatch');
      }
    }, async () => options.onSubmissionValidated?.(summary), options.signal);
  });
  result.verification = 'unverified';
  delete result.receipt;
  await runStep('verify submission', async () => {
    ctx.setStage('verify submission');
    if (!options.siteProfile) {
      process.send?.({ type: 'stage', stage: 'verify submission', state: 'started',
        evidence: '最终确定已点击，但未配置可靠回执规则。保留现场核对，不重复提交。' });
      throw new FlowError('submission_unknown');
    }
    const observed = await verifyReceipt(session.context, options.siteProfile, summary, 'submit');
    result.receipt = observed.receipt;
    result.verification = 'receipt';
  });
}

export async function runReimbursementFlowWithErrorHandling(
  session: BrowserSession,
  runtimeInputs: RuntimeInputs,
  options: ExecutionOptions = {},
): Promise<WorkflowResult> {
  const ctx = new AutomationContext(session.page);
  try {
    return await runReimbursementFlow(session, runtimeInputs, ctx, options);
  } catch (error) {
    await focusBestBusinessPage(session, ctx).catch(() => undefined);
    const label = getCurrentStep() || ctx.state.stage || 'unhandled-failure';
    const screenshotPath = await takeScreenshot(ctx, label).catch(() => '(unavailable)');
    const debugState = await saveDebugState(ctx, label).catch(() => ({ jsonPath: '(unavailable)', htmlPath: '(unavailable)', ariaPath: '(unavailable)' }));
    const message = error instanceof Error ? error.message : String(error);
    const enriched = `${message}\nUnhandled failure screenshot saved to: ${screenshotPath}`
      + `\nDebug JSON saved to: ${debugState.jsonPath}`
      + `\nDebug HTML saved to: ${debugState.htmlPath}`
      + `\nARIA snapshot saved to: ${debugState.ariaPath}`;
    console.error(enriched);
    await pauseOnFailureIfNeeded();
    if (error instanceof FlowError) throw error;
    throw new Error(enriched, { cause: error });
  }
}
