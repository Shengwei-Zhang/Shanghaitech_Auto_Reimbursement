import path from 'node:path';
import { JobStore } from './infrastructure/job-store';
import { checkInvoiceBatch, createInvoiceBatchDrafts } from './application/invoice-batch';

async function main(): Promise<void> {
  const [action, manifest] = process.argv.slice(2);
  if (!['check', 'draft'].includes(action) || !manifest) {
    throw new Error('用法：npm run batch:check -- <清单.json> 或 npm run batch:draft -- <清单.json>');
  }
  const store = new JobStore(path.resolve(process.env.OA_DATA_DIR || 'data', 'jobs'));
  if (action === 'check') {
    const entries = await checkInvoiceBatch(manifest, store);
    console.log(`全部 ${entries.length} 张发票、分类及报销信息已核对，可创建草稿。`);
    return;
  }
  const jobs = await createInvoiceBatchDrafts(manifest, store);
  console.log(`已创建 ${jobs.length} 个待确认的报销草稿任务，尚未连接 OA：`);
  for (const job of jobs) console.log(`${job.invoice?.number} ${job.id}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : '批次处理失败。'); process.exitCode = 1; });
