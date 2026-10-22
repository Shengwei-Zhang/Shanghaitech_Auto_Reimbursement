# 按经费编号查询预算科目

核对日期：2026-10-15（已实网验证）。返回 [README](../README.md)，登录态设置见[配置说明](configuration.md)。

接入用户提供的接口：

```text
POST https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimburFundingItems/queryChooseBudgetOutlays.ajax
```

此请求查询指定经费项目可用的预算支出科目，同时返回项目可用余额。

## 使用

```bash
./scripts/start-local.sh --budgets \
  --funding-code '实际经费编号' \
  --biz-id <原单bizId> \
  --task-id <原单taskId>

# 只给单据编号和项目关键词：登录后自动取得其余参数
./scripts/start-local.sh --budgets \
  --funding-keyword '项目名称或编号中的唯一片段' \
  --document-number A单据编号

./scripts/start-local.sh --budgets --help
```

运行前将经费编号和尖括号占位符替换为实际值。Node.js 22+ 环境也可用 `npm run oa:budgets -- ...`。`--funding-code` 与 `--funding-keyword` 二选一：关键词模式在原单内调用[经费列表](funding-list-api.md)（`--funding-kind authorized|responsible` 选择被授权的项目或我负责的项目，默认前者），项目编号精确相等或恰有一个项目名称包含关键词（忽略空白）时才采用，零个或多个匹配都会停止。不会设为默认项目或覆盖现有报销批次的经费。

启用 `OA_REMEMBER_SESSION=true` 时，命令复用本机保存的登录态；默认未启用则使用新会话。命令在独立浏览器打开已有报销单，核验页面和单据编号后发起查询。原单可用 `--biz-id` + `--task-id` 指定（可加 `--document-number` 严格核对）；只给 `--document-number` 时，登录后经[报销单列表](open-reimbursement.md#由报销单列表生成打开地址)取得 bizId/taskId。使用与用户请求一致的 `isReadOnly=false` 办理页面取得表单上下文，仅打开和查询，不操作保存、提交或科目选择控件。需要时在浏览器完成学校登录。

登录后各参数来源：

| 参数 | 来源 |
| --- | --- |
| Cookie | 浏览器同源 `fetch` 自动携带，含 HttpOnly |
| `csrfToken` 请求头 | 原单页面的隐藏输入 `#csrfTokenElement` 等候选，见下节 |
| `procTaskId` 请求头 | 原单 `#jobPageId`；页面自身的 Ajax 请求也带此头（2026-10-15 抓取），格式不符时不发送 |
| `bizId`、`taskId` | 命令参数，或按单据编号从“报销单查询”及申请环节任务取得；打开后与页面隐藏字段 `#jobPageBizId`、`#jobPageId` 比对 |
| `fundingItemsCode` | `--funding-code`，或按 `--funding-keyword` 从经费列表唯一匹配的 `projectid` |
| `accountBook`、`reimbursementKind` | 原单隐藏字段 `#mainAccountBook`、`#reimbursementKind`（2026-09-24 快照为 `ST00`、`applyMoney`） |

表单字段与默认值：

| 字段 | CLI 参数 | 默认值 |
| --- | --- | --- |
| `fundingItemsCode` | `--funding-code` / `--funding-keyword` | 必填其一，无默认值 |
| `accountBook` | `--account-book` | 读取原单 `#mainAccountBook`；缺失或格式异常则发送前停止 |
| `reimbursementKind` | `--reimbursement-kind` | 读取原单 `#reimbursementKind`；同上 |
| `page` | `--page` | `1` |
| `pagesize` | `--page-size` | `20`，允许 1–100 |
| `sortfields` | 不开放覆盖 | `[]` |

请求体由 `URLSearchParams` 编码，保留小写 `pagesize`。其他账套或报销类型需使用学校实际支持的值，程序仅校验格式，不推测可用枚举。每次只查询指定页，不推测响应中的分页字段或声称已取全。

## Cookie 与 csrfToken

请求在原单的活动页面或 iframe 内使用同源 `fetch`。浏览器提供 Cookie（包括 HttpOnly）、Origin 和 Referer；代码设置 JSON Accept、表单 Content-Type、X-Requested-With 和动态 `csrfToken`。不会把用户粘贴的 Cookie 或 token 写入源码、环境变量或命令行。

每次查询即时读取当前活动文档的明确命名候选：

- `input[id="csrfTokenElement"]` 的值（2026-09-24 原单快照中的实际来源）；
- `input[name="csrfToken"]`、`input[id="csrfToken"]` 的值；
- `meta[name="csrfToken"]` 的 content；
- `window.csrfToken`；
- `window.jQuery.ajaxSettings.headers` 或 `window.$.ajaxSettings.headers` 中的 csrfToken 请求头，头名不区分大小写。

忽略空值；所有非空候选必须格式合法且相同。没有候选、候选冲突或格式异常都会在发送请求前停止。仅检查当前活动文档中的匹配元素和变量，不遍历其他页面/iframe，不使用 URL 里的 csrfToken，也不复用上次查询的 token。同名输入框自动暴露为 `window.csrfToken` 时按同一 DOM 来源处理，不把元素对象误判为令牌。token 的读取和使用均留在浏览器内；响应若回显当前 token，保存前替换为 `[REDACTED]`。

原单 URL 里的 csrfToken 与 `#csrfTokenElement` 不同，因此不用 URL 值。2026-10-15 实网查询确认服务端接受 `#csrfTokenElement` 作为请求头；其余为兼容性候选。若页面改版导致没有候选，会明确报 `csrf_missing`，不能将该错误解释为项目没有预算科目。请求的公共部分在 `src/automation/form-request.ts`，经费列表查询复用同一实现。

## 返回值与系统调用

```ts
import { searchBudgetOutlays } from './automation/budget-search';

// ctx 是已经登录并定位到报销表单的 AutomationContext。
const result = await searchBudgetOutlays(ctx, {
  fundingItemsCode: '实际经费编号', // 替换为 OA 中的项目编号。
  // accountBook、reimbursementKind 省略时读取当前表单。
  page: 1,
  pagesize: 20,
});
```

`ctx.root()` 自动使用 `activeFrame`，无需为已打开的表单再启动浏览器。请求前及浏览器内部均核对 BPM 来源和当前文档 URL，禁止跨站发送或跟随接口重定向。

实测成功响应（2026-10-15）：

```text
{ status: 0, data: { Rows: [...], Total: 10, requireAmount: "<项目可用余额>", showAmount: "", fundingManager: "<工号>" } }
```

`parseBudgetOutlays` 把它解析为 `outlays`：

| 字段 | 含义 |
| --- | --- |
| `rows[].expenditureItemCode`、`expenditureItemName` | 预算支出科目，如 `05 国内差旅费` |
| `rows[].quotaCode`、`quotaName` | 额度类别，如 `02 行政运行费` |
| `rows[].showAmount` | 该科目所属额度（`quotaCode`）**允许本人查看**的可用余额；未授权查看时为空串。程序只读这个字段 |
| `rows[].projectCode`、`projectName` | 必须等于请求的 `fundingItemsCode`，否则该行计入 `skipped` |
| `total`、`showAmount` | 接口声明的科目总数、**允许本人查看**的项目可用余额；未授权查看时为空串 |

**余额是否显示以 `showAmount` 为准。** OA 对未授权查看余额的经费（例如别人授权给你使用、但不授权看余额的经费）把 `showAmount` 置为空串，而 `requireAmount` 和每行的 `budgetBalance` 仍然有值（2026-10-22 实测：`requireAmount` 为实际余额、`showAmount: ""`）。程序不读取、不显示、也不用这两个字段做余额校验：页面显示“未授权查看”，超额与否交给 OA 自己判断。保存经费时 `showAmount` 按 OA 返回原样回传（未授权时为空串，与 OA 页面相同）；`requireAmount` 只按 OA 页面的做法回传给 OA，不展示。

`status` 非 0 或结构不同时不生成 `outlays`，原样保存，不当作空列表。也接受不带外层的 `{ Rows, Total }`。

输出包含 `queriedAt`、实际发送的 `query`（含从表单读取的账套和报销类型）、`httpStatus`、`response` 和 `outlays`，保存于 `<OA_DATA_DIR>/oa-budget-search/<时间>-<随机ID>.json`，默认 `data/oa-budget-search/`。目录权限 `0700`、文件 `0600`，默认数据目录排除 Git。控制台列出科目编号、名称和项目余额，不打印凭据。兼容旧接口将 JSON 标成 text/plain 或 text/html；认证拒绝或重定向、超时、HTTP 错误、非 JSON 和格式异常会明确失败。

当前提供可复用接口和 CLI 查询入口，尚未把结果绑定到网页下拉框或替换现有预算选择流程。现有 `chooseBudget` 负责唯一科目匹配和选择，上层经费流程通过 `funding.ts` 核对主表单回填。

## 验证范围

`tests/budget-search.test.cjs` 的模拟测试覆盖请求字段、从表单读取账套和报销类型、`#csrfTokenElement`、活动 iframe、动态 token、命名元素别名、令牌轮换与回显脱敏、`procTaskId`、实网响应结构解析、认证/请求异常、按单据编号和项目关键词自动串联，以及 CLI 文件保存和浏览器清理。2026-10-15 已用真实原单完成“待办 → 打开原单 → 经费列表 → 预算科目”全链路查询。

配合使用：[旧单直开](open-reimbursement.md)提供表单上下文；[经费列表](funding-list-api.md)提供项目编号；报销单列表提供原单 ID。API 不决定费用应归属哪个预算科目，也不改变已确认的项目。
