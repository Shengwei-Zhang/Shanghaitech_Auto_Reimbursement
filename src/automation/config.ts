import readline from 'readline/promises';
import type { RuntimeInputs } from './types';

export const DEFAULT_TIMEOUT_MS = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || process.env.SELENIUM_TIMEOUT_MS || 20000);

export function getEnvValue(name: string): string {
  return process.env[name]?.trim() || '';
}

export function isEnvTrue(name: string): boolean {
  return getEnvValue(name).toLowerCase() === 'true';
}

export function requireEnv(name: string): string {
  const value = getEnvValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function askQuestion(prompt: string, defaultValue = ''): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`Interactive input unavailable: ${prompt}. Configure the required input before running.`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? `（默认：${defaultValue}）` : '';
  try {
    const answer = await rl.question(`${prompt}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally { rl.close(); }
}

export async function collectRuntimeInputs(): Promise<RuntimeInputs> {
  const reimbursementPurpose = getEnvValue('REIMBURSEMENT_PURPOSE')
    || await askQuestion('请输入用途');
  const payeePersonCode = getEnvValue('PAYEE_PERSON_CODE')
    || await askQuestion('请输入收款人工号');
  const attachmentCount = getEnvValue('ATTACHMENT_COUNT') || '3';
  const reimbursementReason = getEnvValue('REIMBURSEMENT_REASON') || reimbursementPurpose;

  return {
    reimbursementPurpose,
    reimbursementReason,
    attachmentCount,
    payeePersonCode,
  };
}

export async function pauseOnFailureIfNeeded(): Promise<void> {
  if (!isEnvTrue('PAUSE_ON_FAILURE')) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await rl.question('PAUSE_ON_FAILURE=true, browser is kept at the failure point. Press Enter to exit...');
  rl.close();
}
