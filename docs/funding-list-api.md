# 经费列表接口

核对日期：2026-10-15（已实网验证）。返回 [README](../README.md)，登录态设置见[配置说明](configuration.md)。

```text
POST https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/easySearch.load
```

这是报销单“经费项目 → 选择项目”对话框加载项目列表的请求。2026-10-15 实测：空请求体（最初样例 `?accept=`）只返回 BPM 错误页“错误的请求!”；对话框实际发送的是下表的表单字段，并带 `csrfToken`、`procTaskId` 请求头，因此必须在已打开的报销单内发送。

## 使用

```bash
./scripts/start-local.sh --funds --document-number A单据编号
./scripts/start-local.sh --funds --document-number A单据编号 --keyword '项目名称片段'
./scripts/start-local.sh --funds --help
```

Node.js 22+ 环境也可使用 `npm run oa:funds -- ...`。原单可用 `--document-number`（登录后经[报销单列表](open-reimbursement.md#由报销单列表生成打开地址)取得 ID）或 `--biz-id` + `--task-id` 指定。命令打开并核验原单（见[旧单直开](open-reimbursement.md)），在表单页面内发送请求，不点击对话框、不选择项目、不保存报销单。

| 请求字段 | 值 | 来源 / CLI 参数 |
| --- | --- | --- |
| `queryName` | `queryFundingItems` | 固定 |
| `pageSize` | `8` | 对话框默认；`--page-size`。实测 `pageSize=8` 仍一次返回全部 46 条 |
| `configType` | `tech` | 固定 |
| `paramValue` | 空 | 对话框“关键字”框；`--param-value` |
| `fundingItemKind` | `1` 被授权的项目 / `0` 我负责的项目 | `--kind authorized`（默认）/ `responsible` |
| `accountBook` | 如 `ST00` | 原单 `#mainAccountBook`；`--account-book` 覆盖 |
| `isMultipleSelect` | `false` | 固定 |

| 请求头 | 来源 |
| --- | --- |
| Cookie、Referer | 浏览器在原单页面内同源 `fetch` 自动携带 |
| `csrfToken` | 原单 `#csrfTokenElement` 等候选，规则同[预算科目查询](budget-outlays-api.md) |
| `procTaskId` | 原单 `#jobPageId`（实测与 URL 的 taskId 相同），格式不符时不发送 |

`--keyword` 在返回的列表中匹配：项目编号精确相等，或恰有一个项目的 `label` 包含关键词（忽略空白）。零个或多个匹配都报错（结果文件仍已保存）。

## 响应解析

实测响应为 HTML 片段，`<table id="easySearchTableListData" dataCount='46' pageCount='1'>` 中每行 `<tr class="list">` 用隐藏输入存放字段。以纯文本方式解析（不构建 DOM、不执行脚本），结果放在 `list`：

| 字段 | 隐藏输入 `name` | 说明 |
| --- | --- | --- |
| `projectId` | `projectid` | 即预算科目查询的 `fundingItemsCode`，如 `2026A0116-201-02` |
| `projectName`、`label` | `projectname`、`projectnameTextView` | `label` 形如 `编号-名称` |
| `departmentId`、`departmentName` | `departmid`、`departmname` | 所属部门，可能为空 |
| `firstId`/`firstName`、`secondId`/`secondName` | 同名字段 | 实测 `firstName` 为项目负责人姓名 |

`dataCount`、`pageCount` 取自表格属性；编号格式不符的行计入 `skipped`。`pageCount` 大于 1 时只解析返回的这一页并提示。响应不含余额；项目余额见预算科目查询的 `showAmount`（未授权查看时为空，不显示余额）。

BPM 错误页（`#show_error_info`）报 `server_rejected`，登录页报 `authentication`，没有该表格报 `list_unrecognized`；都不当作空列表。HTTP 错误、重定向、超时同样明确报错。

## 保存及衔接

结果存入 `<OA_DATA_DIR>/oa-funding-search/<时间>-<随机ID>.json`，默认 `data/oa-funding-search/`，目录 `0700`、文件 `0600`，排除 Git。包含 `queriedAt`、实际发送的 `query`、`httpStatus`、原始 HTML `response` 和 `list`；回显的 token 已替换为 `[REDACTED]`。控制台只输出项目数和匹配结果。

- 代码入口：`src/automation/funding-search.ts` 的 `searchFundingItems(ctx, options)`，`ctx` 为已打开原单的 `AutomationContext`。表单内请求的公共部分在 `src/automation/form-request.ts`。
- [预算科目查询](budget-outlays-api.md)的 `--funding-keyword` 调用同一函数取得 `fundingItemsCode`。
- 网页流程仍按“经费类别 → 经费项目 → 预算科目”操作对话框并核验主表单回填，本接口不替代该流程。

`tests/funding-search.test.cjs` 用模拟页面覆盖请求体与请求头、表单字段缺失、token 脱敏、错误页/登录页、HTML 解析、关键词匹配和 CLI 流程。
