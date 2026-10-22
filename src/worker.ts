import { STAGES, jobInvoices, moneyToCents, type WorkerRequest, type WorkerEvent } from './domain/job';
import { failureOf } from './domain/workflow';
import { readPlan } from './infrastructure/reimbursement-plan-store';

const parentDisconnected = () => process.kill(process.pid, 'SIGTERM');
process.once('disconnect', parentDisconnected);

function send(event: WorkerEvent): Promise<void> {
  return new Promise(resolve => {
    if (!process.connected || !process.send) return resolve();
    process.send(event, () => resolve());
  });
}

process.once('message', async (request: WorkerRequest) => {
  try {
    if (request.job.mode === 'demo') {
      for (const stage of STAGES) {
        if (request.job.action === 'save' && ['prepare submission', 'confirm submission', 'verify submission'].includes(stage)) {
          await send({ type: 'stage', stage, state: 'skipped', evidence: '演示仅保存流程。' });
          continue;
        }
        await send({ type: 'stage', stage, state: 'started' });
        await new Promise(resolve => setTimeout(resolve, 350));
        await send({ type: 'stage', stage, state: 'completed' });
      }
      await send({ type: 'result', result: { documentNumber: '演示单据', amount: request.job.input.amount, action: request.job.action || 'save' } });
    } else {
      if (!request.job.invoice || (request.job.loginMode === 'credentials' && !request.credentials)) throw new Error('Missing inputs');
      const invoices = jobInvoices(request.job);
      if (invoices.length > 1 && request.submitOnly !== true) throw new Error('Multiple invoices are attached over HTTP only');
      const invoiceTotal = invoices.every(item => item.amount)
        ? invoices.reduce((sum, item) => sum + moneyToCents(item.amount!), 0) : undefined;
      // Read the exact reviewed JSON before any browser/automation module loads.
      const plan = request.job.plan ? readPlan(request.workDir, request.job) : undefined;
      const input = plan?.input || request.job.input;
      if (plan) await send({ type: 'stage', stage: 'authenticate', state: 'started',
        evidence: `已读取并校验报销 JSON v${plan.version} 和原始发票，后续操作使用该方案参数。` });
      Object.assign(process.env, {
        OA_LOGIN_MODE: request.job.loginMode || 'manual',
        OA_USERNAME: request.credentials?.username || '', OA_PASSWORD: request.credentials?.password || '',
        UPLOAD_FILE_PATH: request.invoicePath, FUNDING_ITEM_KEYWORD: input.fundingKeyword,
        FUNDING_KIND_KEYWORD: input.fundingKindKeyword || '被授权的项目',
        BUDGET_OUTLAY_KEYWORD: input.budgetKeyword, EXPECTED_AMOUNT: input.amount,
        EXPECTED_INVOICE_AMOUNT: invoiceTotal === undefined ? '' : (invoiceTotal / 100).toFixed(2),
        EXPECTED_INVOICE_NUMBER: invoices.map(item => item.number).join(','), OA_ARTIFACT_DIR: request.workDir,
        CAPTURE_DEBUG_ARTIFACTS: 'false', HEADLESS: 'false',
        KEEP_BROWSER_OPEN: 'false', PAUSE_ON_FAILURE: 'false',
      });
      request.credentials = undefined;
      const { executeAutomation } = await import('./automation/execute');
      const result = await executeAutomation({
        reimbursementPurpose: input.purpose, reimbursementReason: input.reason,
        attachmentCount: String(input.attachmentCount), payeePersonCode: input.payeeCode,
      }, { action: request.job.action || 'save', formMode: request.job.input.formMode || 'new', target: request.job.input.target,
        submitOnly: request.submitOnly === true,
        siteProfile: request.siteProfile, onSubmissionValidated: summary => send({ type: 'submission_validated', summary }),
        onFailureInspection: (failure, stage) => send({ type: 'inspection_required', failure, stage }),
      });
      await send({ type: 'result', result });
    }
  } catch (error) { await send({ type: 'failure', failure: failureOf(error) }); process.exitCode = 1; }
  finally {
    delete process.env.OA_USERNAME;
    delete process.env.OA_PASSWORD;
    process.off('disconnect', parentDisconnected);
    if (process.connected) process.disconnect();
  }
});
