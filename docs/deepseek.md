# DeepSeek 辅助与版本化报销 JSON

核对日期：2026-10-15。返回 [README](../README.md)。AI 是可选能力，未配置或调用失败时仍可使用规则预检和正常报销流程。

## 配置与使用

在本机 `.env` 设置 `DEEPSEEK_API_KEY` 后重启工作台。页面的“已配置”仅表示服务读到了密钥；首次成功调用才证明接口可用。真实 OA 网页执行还需单独启用 `OA_LIVE_ENABLED=true`。

当前固定使用 `https://api.deepseek.com/chat/completions`、`deepseek-chat` 和 JSON 输出模式，调用超时 20 秒；模型名和地址没有暴露为环境配置。

| 功能 | 使用方式 | 结果 |
| --- | --- | --- |
| AI 辅助检查 | 在草稿详情填写具体业务歧义（最多 500 字），勾选同意后调用 | 摘要、需核实事项和建议 |
| 生成报销 JSON | 创建真实草稿时勾选生成，或在已上传发票的真实草稿详情中同意生成 | 本地验证后写入版本文件，可查看/下载 |

AI 不能修改已确认金额、收款人、经费或执行范围，不能选择审批人或判定财务批准。当前没有内置校方财务政策，也没有向模型自动提供 OA 可选科目列表。

## 发送的数据

| 功能 | 发往 DeepSeek 的字段 |
| --- | --- |
| 歧义检查 | 具体问题、用途、说明、实报金额 |
| JSON 生成 | 用途、说明、实报金额、附件数、经费类别/项目/预算关键词，以及已识别的票面金额 |

不发送 PDF 文件、校园账号密码、Cookie、收款人工号或发票号码作为独立字段；自由文本中包含的信息仍会随文本发送。密钥只在本地服务端使用，不传给网页或 OA worker。默认不调用模型，每次通过界面/API 明确同意。

## 方案版本与执行

文件保存在 `<OA_DATA_DIR>/jobs/<任务ID>/reimbursement.v1.json`，再次生成写入 v2、v3，不覆盖旧版。当前结构包含 `schemaVersion`、`version`、`jobId`、`createdAt`、`source`、`action`、`input`、`invoice` 和 `review`；`schemaVersion` 当前为 `1`。

模型只返回经过约束的业务参数、摘要和待核实事项。程序要求已填写参数逐项不变，在本地合并工号、单据类型、执行范围和票据信息。篡改金额、未知字段、不完整 JSON 或生成期间任务发生变化时，结果不进入可执行方案。

用户点击确认执行时，网页提交当前 `planSha256`。服务核验版本与参数，worker 再次读取方案并核验摘要；原始 PDF 启动前也需通过摘要检查。若任务有有效方案，worker 使用方案参数驱动现有自动化；没有方案时使用已确认的任务表单参数。

JSON 中没有可执行代码、页面选择器或任意导航地址。生成失败保留草稿和已保存的旧版本，可以在草稿状态重试；不要手动修改归档方案或 PDF 来改变任务。当前仍是一票一项目一科目，不自动拆分或合并多票。

## 本地 API

这些是工作台 API，与校园 OA 的查询接口不同。请求需本机会话，非 GET 请求还需本地 `x-csrf-token`。

| 方法与路径 | 参数 / 含义 |
| --- | --- |
| `POST /api/jobs/:id/review` | `{ "consent": true, "question": "具体业务问题" }` |
| `POST /api/jobs/:id/plan` | `{ "consent": true }`，生成新版本 |
| `GET /api/jobs/:id/plan` | 返回当前方案 |
| `GET /api/jobs/:id/plan?download=1` | 下载当前方案 JSON |
| `POST /api/jobs/:id/start` | 有方案时除执行确认参数外还须携带当前 `planSha256`；网页自动处理 |

实现见 `src/infrastructure/deepseek.ts`、`src/domain/reimbursement-plan.ts`、`src/infrastructure/reimbursement-plan-store.ts` 和 `src/application/job-service.ts`。相关模拟测试不代表真实 DeepSeek 或校园 OA 已联调通过；测试方式见 [README](../README.md)。
