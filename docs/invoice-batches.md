# 发票目录、批次清单与逐票草稿

核对日期：2026-10-15。返回 [README](../README.md)。实现位于 `src/application/invoice-batch.ts` 和 `src/batch.ts`。

批次入口将已经整理并确认的清单转换为一票一任务的本地草稿。它不扫描目录后自动确定用途、收款人、项目或科目，不连接 OA，也不将多票自动合并为一张单据。当前没有自动生成完整清单的 CLI；需要先整理清单，再运行检查。

## 清单结构

建议放在 `data/batches/<批次名称>/batch.json`。下面是格式模板，路径、票号、摘要、文件大小及金额必须替换成原始 PDF 的实际解析结果，业务参数必须经过确认；占位值不能通过校验。

```json
{
  "sourceDirectory": "/绝对路径/发票目录",
  "entries": [
    {
      "sourcePath": "/绝对路径/发票目录/示例发票.pdf",
      "invoice": {
        "name": "示例发票.pdf",
        "number": "PDF中识别的20位发票号",
        "sha256": "原始PDF的SHA-256",
        "size": 12345,
        "amount": "100.00"
      },
      "classificationConfirmed": true,
      "status": "ready",
      "input": {
        "reimbursementType": "用款申请单",
        "formMode": "new",
        "fundingKindKeyword": "被授权的项目",
        "purpose": "已确认的实际用途",
        "reason": "已确认的报销说明",
        "payeeCode": "收款人工号",
        "fundingKeyword": "在OA唯一匹配的经费项目",
        "budgetKeyword": "在OA唯一匹配的预算科目",
        "amount": "100.00",
        "attachmentCount": 1
      }
    }
  ]
}
```

`invoice` 字段采用与网页发票检查相同的结构。程序会重新解析原始文件并逐项对照，不能仅凭文件名填写票号或金额。`classificationConfirmed=true` 表示已由使用者核实分类；程序不会验证该分类符合学校财务政策。服务、耗材、设备等不同费用应分别确认，不复制同一科目覆盖整批。

`sourceDirectory` 只包含其**直接子文件**中的 PDF，当前不递归读取子目录。清单必须完整且恰好列出这些 PDF；路径建议使用绝对路径，`sourcePath` 必须解析到该目录下相应文件。

## 检查与创建

```bash
npm run batch:check -- 'data/batches/批次名称/batch.json'
npm run batch:draft -- 'data/batches/批次名称/batch.json'
```

先检查、再创建。两个命令都执行完整校验；`draft` 不会信任上次 `check` 的结果直接写入。批次命令不读取 `.env`，自定义数据目录时显式设置 `OA_DATA_DIR`，并与网页服务保持一致，详见[配置说明](configuration.md)。

检查顺序包括：

1. 拒绝已有 OA 办理记录、任务关联或不明确状态的清单。
2. 核对源目录 PDF 列表与清单完全一致、路径真实属于该目录。
3. 确认每项分类已核实，批次内票号和文件摘要无重复。
4. 重新读取 PDF，核对号码、SHA-256、字节数和价税合计与清单一致。
5. 检查同一数据目录中的现有真实任务；除已取消或已释放的任务外，重复票号/摘要均拦截。
6. 验证业务参数和正数实报金额；批次必须有可识别的票面金额，实报不能超出。

`batch:draft` 在全部校验通过后逐项写入本地任务，当前任务配置固定为 `mode=live`、`action=submit`，状态为草稿，不自动入队，不执行提交，也不调用 AI。成功时输出每张票对应的任务 ID；清单本身不会自动回写任务 ID 或状态。查看工作台草稿后再决定是否执行。

批次写入不是数据库事务，后半批写入失败时，前面已创建的草稿会保留。不要直接重跑或清除已有记录来绕过查重；先核对任务库，再整理未办理部分。批次 CLI 不持有网页服务的单实例锁，运行创建草稿时应避免网页并发创建任务。

## 已开始办理的批次

清单可以保留 `liveForms` 数组和条目 `jobId`、`documentNumber`、`status`，用于防止重复办理。`liveForms` 支持单票 `invoiceNumber` 或多票 `invoiceNumbers`；只要数组非空，整批就拒绝再次创建草稿，即使本地任务库没有对应记录。

条目已有 `jobId`、`documentNumber` 或显式状态不是 `not_started`、`awaiting_user_details`、`ready` 时，也会停止。缺少 `status` 的旧清单仍兼容原检查，但“没有记录”不能证明 OA 没有单据。

这些检查只使用清单和本地任务库，不查询 OA，不保证校园范围的全局查重。上传、关联、保存、流转、审批、到账应分别记录证据；曾经查重为零不代表现在可以再次建单。

已有合并单或状态不确定时，先用[旧单直开](open-reimbursement.md)或 OA 页面核对原单。`oa:open` 不自动恢复批次，单票执行器也不能接管多票、多科目的现存单据。后续能力见[自动化改造方案](browser-automation-plan.md)。
