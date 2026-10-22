import { retryStep } from './actions';
import { getEnvValue } from './config';
import { STAGES, type Stage } from '../domain/job';
import { CONTRACTS } from './contracts';

let startFromStep = '';
let shouldRunSteps = true;
let startFromMatched = true;
let currentStep = '';

const STEP_ALIASES: Record<string, string> = {
  'open new tab page': 'authenticate',
  'open login page': 'authenticate',
  'type username': 'authenticate',
  'type password': 'authenticate',
  'submit login': 'authenticate',
  'open green index': 'open workbench',
  'open work page': 'open workbench',
  'open empty reimbursement todo from workbench': 'select reimbursement form',
  'switch to recorded frame context': 'create reimbursement form',
  'click search input': 'create reimbursement form',
  'type workflow name': 'create reimbursement form',
  'open reimbursement workflow': 'create reimbursement form',
  'switch to newest window': 'create reimbursement form',
  'open add reimbursement page': 'create reimbursement form',
  'select reimbursement account set': 'prepare reimbursement form',
  'confirm account set': 'prepare reimbursement form',
  'wait for loaded reimbursement page': 'prepare reimbursement form',
  'edit funding items': 'select funding item',
  'open funding item dropdown': 'select funding item',
  'choose funding item type': 'select funding item',
  'choose funding items view name': 'select funding item',
  'select funding item row': 'select funding item',
  'select budget outlay': 'select funding item',
  'confirm funding item': 'select funding item',
  'open invoice buttons': 'attach invoice',
  'click invoice button': 'attach invoice',
  'click upload field': 'attach invoice',
  'stay on current reimbursement page after recorded work navigation': 'attach invoice',
  'stay on current reimbursement page after recorded hash navigation': 'attach invoice',
  'click invoice dialog upload button': 'attach invoice',
  'upload invoice file': 'attach invoice',
  'choose uploaded file': 'attach invoice',
  'confirm uploaded file': 'attach invoice',
  'click actual total amount': 'fill reimbursement details',
  'click invoice amount cell': 'fill reimbursement details',
  'type invoice amount': 'fill reimbursement details',
  'click invoice category cell': 'fill reimbursement details',
  'click invoice remark cell': 'fill reimbursement details',
  'type invoice remark': 'fill reimbursement details',
  'click invoice grid area': 'fill reimbursement details',
  'edit reimbursement settlement': 'configure payment',
  'choose settlement label 2': 'configure payment',
  'choose settlement label 3 input': 'configure payment',
  'choose settlement label 2 again': 'configure payment',
  'confirm settlement kind': 'configure payment',
  'open payee section': 'configure payment',
  'click person code first': 'configure payment',
  'click payee code': 'configure payment',
  'click person name': 'configure payment',
  'click person code second': 'configure payment',
  'type person code': 'configure payment',
  'click payee code again': 'configure payment',
  'click payment amount': 'configure payment',
  'click payment amount following div': 'configure payment',
  'confirm payment': 'configure payment',
  'save first time': 'save reimbursement',
  'click invoice remark cell again': 'save reimbursement',
  'click reimbursement remark': 'save reimbursement',
  'type reimbursement remark': 'save reimbursement',
  'save second time': 'save reimbursement',
  'click advance': 'prepare submission',
  'close dialog': 'save reimbursement',
};

export const CANONICAL_STEPS = STAGES;

export function initializeRunnerFromEnv(): void {
  setStartFromStep(getEnvValue('START_FROM'));
}

export function getStartFromStep(): string {
  return startFromStep;
}

export function setStartFromStep(value: string): void {
  const next = canonicalStep(value);
  if (next && !(CANONICAL_STEPS as readonly string[]).includes(next)) {
    throw new Error(`Unknown START_FROM: ${next}`);
  }
  startFromStep = next;
  currentStep = '';
  shouldRunSteps = !startFromStep;
  startFromMatched = !startFromStep;
}

export function isResuming(): boolean {
  return Boolean(startFromStep);
}

function normalizeStepLabel(label: string): string {
  return String(label).trim().toLowerCase();
}

export function canonicalStep(label: string): string {
  const normalized = normalizeStepLabel(label);
  return STEP_ALIASES[normalized] || normalized;
}

function isStartStep(label: string): boolean {
  return canonicalStep(label) === startFromStep;
}

export async function runStep<T>(label: string, step: () => Promise<T>, verify?: (result: T) => Promise<void>): Promise<T | undefined> {
  const canonicalLabel = canonicalStep(label);
  if (!shouldRunSteps) {
    if (!isStartStep(canonicalLabel)) {
      console.log(`Skipping step before START_FROM: ${canonicalLabel}`);
      return undefined;
    }

    shouldRunSteps = true;
    startFromMatched = true;
    console.log(`START_FROM matched, resuming at step: ${canonicalLabel}`);
  }

  currentStep = canonicalLabel;
  console.log(`Running step: ${canonicalLabel}`);
  process.send?.({ type: 'stage', stage: canonicalLabel as Stage, state: 'started' });
  // Only navigation is safe to replay as a whole stage. Upload/create/payment/save are not.
  const result = await retryStep(canonicalLabel, step, canonicalLabel === 'open workbench' ? 2 : 1);
  if (verify) await verify(result);
  process.send?.({ type: 'stage', stage: canonicalLabel as Stage, state: 'completed', evidence: CONTRACTS[canonicalLabel as Stage]?.success });
  return result;
}

export function skipStep(stage: Stage, evidence: string): void {
  process.send?.({ type: 'stage', stage, state: 'skipped', evidence });
}

export function assertStartFromMatched(): void {
  if (!startFromMatched) {
    throw new Error(
      `START_FROM did not match any step: ${startFromStep}. `
      + `Available stages: ${CANONICAL_STEPS.join(', ')}`,
    );
  }
}

export function getCurrentStep(): string {
  return currentStep;
}
