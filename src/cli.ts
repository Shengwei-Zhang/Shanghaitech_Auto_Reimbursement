import dotenv from 'dotenv';
import { loadSiteProfile } from './infrastructure/site-profile';
dotenv.config();

async function main() {
  const { collectRuntimeInputs } = await import('./automation/config');
  const { executeAutomation } = await import('./automation/execute');
  const action = process.env.OA_ACTION || 'submit';
  if (action !== 'save' && action !== 'submit') throw new Error('OA_ACTION 必须为 save 或 submit。');
  const result = await executeAutomation(await collectRuntimeInputs(), { action, formMode: process.env.OA_FORM_MODE === 'reuse' ? 'reuse' : 'new',
    siteProfile: loadSiteProfile(process.env.OA_SITE_PROFILE),

  });
  console.log('本次执行结果（以 OA 回执核验为准）：', result);
}
main().catch(error => { console.error(error instanceof Error ? error.message : '执行失败'); process.exitCode = 1; });
