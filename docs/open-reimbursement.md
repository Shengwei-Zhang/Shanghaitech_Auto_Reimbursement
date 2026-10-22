# 按 bizId / taskId 打开旧报销单

核对日期：2026-10-15。返回 [README](../README.md)，登录态设置见[配置说明](configuration.md)。以下 ID 占位符需替换为当前原单的真实值，不能直接复制运行。

```bash
./scripts/start-local.sh --open --biz-id <bizId> --task-id <taskId>
# 只知道单据编号时，登录后从“报销单查询”取得 bizId，再取得申请环节 taskId
./scripts/start-local.sh --open --document-number A单据编号
```

Node.js 22+ 环境也可使用 `npm run oa:open -- ...`。请在本机交互终端运行，首次由你在学校页面完成登录；随后程序打开新标签页，核验旧单，保持浏览器供查看，按 Enter 结束并关闭独立浏览器。

| 参数 | 含义 |
| --- | --- |
| `--biz-id` | 报销业务 ID，32 位十六进制字符；与 `--task-id` 同时给出 |
| `--task-id` | 当前办理任务 ID，UUID 格式 |
| `--document-number` | 单据编号，格式为 `A` 加数字。与两个 ID 同用时作严格核对；单独使用时按编号从报销单列表取得 ID |
| `--read-only` | 可选，发送 `isReadOnly=true`，默认发送 `false` |
| `--help` | 显示帮助，不启动浏览器 |

单据编号不是 `bizId`。流程推进后 `taskId` 会变化，应使用当前任务 ID。

## 由报销单列表生成打开地址

只给单据编号时，按 BPM“报销单查询”页面自身的做法取得两个 ID（2026-10-15 实网抓取并验证），代码在 `src/automation/reimbursement-list.ts` 的 `resolveListTarget`：

1. 新标签页打开只读的 `/bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do`（必要时经一次 CAS）。
2. 在该页面内 POST `/bpm-new/rbReimbursementQuery/slicedQueryOwnerReimbursement.ajax`，请求体与列表“查询”相同，`billCode` 为单据编号，带页面 `#csrfTokenElement`。响应 `{ status: 0, data: { Rows, Total } }`；行的 `id` 即 `bizId`，`status` / `statusTextView` 为单据状态（`0` 预制、`1` 提交、`5` 已完成等）。单号必须恰好对应一条记录。
3. 列表行不含 taskId。页面通过 POST `/bpm-new/techCommonFunction/getApplyTaskInfo.ajax`（`bizId`、`checkSubProcUnitId=financialContactPerson`）取得当前任务：`data.id` 为 `taskId`，`data.businessKey` 必须等于 `bizId`，`data.businessCode` 必须等于单号，`statusId` 须为 `ready`。
4. 用 `bizId` 和 `taskId` 生成下文的 `showLoadRbReimbursement.job` 地址并打开、核验。

预制单返回申请人自己的任务（`taskDefKey: Apply`，与待办办理链接中的 taskId 一致）。已提交的单据返回审批人当前的任务（如 `taskDefKey: Approve`、“学院财务联络人”），此时办理模式会报 `not_editable` 拒绝打开，加 `--read-only` 可只读查看。查询页面在取得 ID 后关闭，不点击列表行。

[待办查询](todo-task-api.md)的 `targets` 也含 bizId/taskId，但只覆盖待办分页中的记录，故不作为单号解析来源。

## 请求及登录态

固定打开学校提供的地址：

```text
https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job?isReadOnly=false&bizId=<bizId>&taskId=<taskId>
```

这是浏览器 GET 页面导航，不需要 Python `requests`、请求体或手工设置 Cookie、Referer、User-Agent。浏览器根据实际导航自行处理请求头。配置 `OA_REMEMBER_SESSION=true` 后复用项目已有的本机登录态缓存。

门户与 BPM 使用不同会话。直接打开若明确遇到登录失效，程序只尝试一次 CAS SSO，回跳目标仍为同一旧单。HTTP 403、编号不符或未知页面不会触发这次恢复。成功打开后再次缓存会话，使新发的 BPM Cookie 也保存到本机。源码、日志和示例不包含粘贴的 Cookie。

## 结果核验及范围

返回地址必须与固定 origin、路径、`bizId`、`taskId` 和 `isReadOnly` 一致，还须出现可见报销表单字段及唯一单据编号；仅 HTTP 200 或地址匹配不足以判定成功。可选预期编号会作严格比较。

随后读取表单的隐藏字段（名称取自 2026-09-24 原单快照）：

| 字段 | 隐藏输入 | 用途 |
| --- | --- | --- |
| `bizId` / `taskId` | `#jobPageBizId` / `#jobPageId` | 与请求 ID 比较（不区分大小写），不同则报 `wrong_target` |
| `documentNumber` | `#jobPageBizCode` | 与页面单据编号比较，不同则报 `ambiguous_form` |
| `procInstId`、`processDefinitionKey`、`procInstStatusId`、`statusId` | `#jobPageProcInstId` 等 | 仅报告流程状态（如 `executing` / `ready`） |
| `accountBook`、`reimbursementKind` | `#mainAccountBook`、`#reimbursementKind` | 供[预算科目查询](budget-outlays-api.md)使用 |

格式不符的值视为缺失。旧页面缺少 ID 字段时仍按地址和编号核验，但结果标记 `identityVerified: false`，控制台会提示。页面核验失败时报告错误并关闭本命令的独立浏览器；原有个人浏览器标签页不受影响。

此命令只打开原单，不执行创建、填写、保存或提交，也不把 `isReadOnly=false` 当作当前账号具有编辑权限的证明。没有持久化业务检查点，不会自动恢复原任务、补填缺失行或判断哪些步骤已经完成。原 `START_FROM` / `RESUME_EXISTING` 调试入口与本命令尚未串联。

代码可复用 `src/automation/open-reimbursement.ts` 的 `openReimbursementByIds(session, ctx, target)`。返回核验后的页面、单据编号、请求只读标志、隐藏字段 `context` 和 `identityVerified`；表单在 iframe 时，同时更新 `ctx.activeFrame`。预算查询命令会复用该入口取得原单上下文，见[预算科目查询](budget-outlays-api.md)。

`tests/open-reimbursement.test.cjs` 使用模拟页面和请求验证 ID、精确地址、单据编号、隐藏字段比对、iframe、一次 CAS 恢复、按编号解析参数和 CLI 清理。真实单据是否仍可办理、当前任务权限和现场 DOM 仍需实网验证。
