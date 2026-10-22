import { createBrowserSession, closeBrowserSession, attachToExistingBusinessPage, type BrowserSession } from './browser';
import { initializeRunnerFromEnv, getStartFromStep, setStartFromStep } from './runner';
import { getEnvValue, isEnvTrue } from './config';
import { validateInvoiceInput } from './invoice-input';
import { detectResumeStep } from './resume';
import { runReimbursementFlowWithErrorHandling, type ExecutionOptions } from './reimbursement-flow';
import { waitForFailureInspection } from './failure-inspection';
import { failureOf, FlowError, type Failure } from '../domain/workflow';
import { getCurrentStep } from './runner';
import type { RuntimeInputs } from './types';

export async function executeAutomation(inputs: RuntimeInputs, options: ExecutionOptions & { onFailureInspection?: (failure: Failure, stage: string) => Promise<void> } = {}) {
  await validateInvoiceInput(getEnvValue('UPLOAD_FILE_PATH'));
  const abort = new AbortController();
  initializeRunnerFromEnv();
  let session: BrowserSession | null = null;
  let stopping = false;
  const stop = () => { stopping = true; abort.abort(); void session?.browser.close().catch(() => undefined); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    session = await createBrowserSession();
    session.browser.once('disconnected', () => abort.abort());
    if (stopping) throw new Error('Execution cancelled before the browser was ready.');
    if (getStartFromStep() || isEnvTrue('RESUME_EXISTING')) {
      if (!await attachToExistingBusinessPage(session, { sapbpmOnly: true })) {
        throw new FlowError('resume_page_missing');
      }
      if (!getStartFromStep()) {
        const stage = await detectResumeStep(session.page);
        if (!stage) throw new Error('Cannot safely determine the resume stage.');
        setStartFromStep(stage);
      }
    }
    return await runReimbursementFlowWithErrorHandling(session, inputs, { ...options, signal: abort.signal });
  } catch (error) {
    if (!stopping && session?.browser.isConnected() && options.onFailureInspection) {
      await options.onFailureInspection(failureOf(error), getCurrentStep());
      await waitForFailureInspection(session, abort.signal);
    }
    throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await closeBrowserSession(session);
  }
}
