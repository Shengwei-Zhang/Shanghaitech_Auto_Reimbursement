# 门户待办任务查询

核对日期：2026-10-15。返回 [README](../README.md)，登录态设置见[配置说明](configuration.md)。

接口来源：用户于 2026-10-14 提供的请求样例。请求方法为 `POST`，地址固定为 `https://egate-new.shanghaitech.edu.cn/custom/api/v2/casp-tdc/task/search`。2026-10-15 已实网验证：响应为 `{ errcode: "0", errmsg: "success", total, pageNumber, pageSize, pages, datas: [...] }`。

## 使用

在项目根目录运行（Node.js 22+）：

```bash
npm run oa:tasks
npm run oa:tasks -- --subject '待查询的单据编号或标题' --page 1 --page-size 10
```

本机默认 Node 较旧时可使用现有启动脚本选择可用运行时：

```bash
./scripts/start-local.sh --tasks --subject '待查询的单据编号或标题'
./scripts/start-local.sh --tasks --help
```

命令启动独立查询浏览器，按现有 `OA_REMEMBER_SESSION` 配置加载登录态；无有效登录时，在学校页面完成正常认证。认证完成后只发送一次待办查询，不触发创建、上传、付款或流转。不要与正在使用同一账号的真实报销任务同时运行。

响应保存到 `<OA_DATA_DIR>/oa-task-search/<时间>-<随机ID>.json`，默认位于已排除 Git 的 `data` 下，目录权限 `0700`、文件权限 `0600`。控制台只输出结果位置和 HTTP 状态，不输出请求头、Cookie 或待办正文。

代码入口：`src/automation/task-search.ts` 的 `searchTodoTasks(page, options)`；命令入口：`src/tasks.ts`。已有浏览器流程可将登录后的门户 `Page` 直接传入查询函数，避免另开会话。

## 参数如何获得

| 参数 | 获取方式 |
| --- | --- |
| Cookie（含 HttpOnly Cookie） | 由门户页面内的同源 `fetch` 自动携带；无需读取 `document.cookie` 或手工拼接 |
| Origin、Referer、User-Agent、Sec-Fetch-*、sec-ch-ua*、Accept-Language | 由运行中的浏览器提供，使用当前页面与浏览器状态 |
| `_t` | 每次请求实时生成 `Date.now()`，不复用抓包时间戳 |
| `type` | 按用户样例固定为 `1`，本入口只查询待办 |
| `pageNumber`、`pageSize` | 默认 `1`、`10`；命令参数 `--page`、`--page-size`，单页上限 `100` |
| `subject` | 标题或单号筛选条件，默认空；命令参数 `--subject`，匹配语义以 OA 为准 |
| `bizSceneCode`、`startTime`、`endTime`、`taskType`、`priority`、`isExpire` | 默认空；对应 `--biz-scene-code`、`--start-time`、`--end-time`、`--task-type`、`--priority`、`--is-expire`；日期格式及枚举仍以 OA 为准 |
| `isIgnore` | 按样例默认字符串 `"0"`，可传 `--is-ignore 1` |
| 额外 Authorization/CSRF 头 | 用户样例未出现，没有猜填；若真实请求需要，必须根据浏览器实际网络请求核实 |

用户提供的 Cookie 未复制到源码、配置或测试。请求发生在学校门户页面内，自动携带符合域名、路径及浏览器规则的 Cookie。程序只设置 `Accept` 和 `Content-Type`；不伪造浏览器身份头，也不重放样例中的会话值。

补充识别用户样例中的 `/CUS_TEMPLATE_OFFICIAL/pc/index.html` 门户路径；认证仍需实际页面控件佐证，单凭这个 URL 不判定登录成功。待办 API 请求不依赖旧任务中心的 DOM 搜索框。

## 结果与错误

输出包含 `queriedAt`、实际查询参数 `query`、`httpStatus`、原始 `response` 和 `targets`。`errcode` 为 `"0"` 且含 `total`、`pages`、`datas` 时，命令报告门户声明的待办总数、页数和本页条数；其他结构只报告“收到 JSON 响应”，不当作业务成功或空列表。

实测 `datas[]` 中与报销相关的字段：`subject`（如 `张三[用款申请单-A2026…](2026-09-24)`）、`nodeName`、`bizKey`、`pcViewUrl` / `h5ViewUrl`（BPM 办理地址）、`realTaskId`（等于链接中的 taskId）。记录自身的 `taskId` 是门户任务 ID，不是 BPM taskId。其他系统的待办（合同审批等）链接到别的域名，会被忽略。

401/403、重定向、HTML、非 JSON、超时和网络错误均显式停止。不跟随接口返回的重定向，也不打开响应里的任务链接。分页为按需查询单页，不自动遍历所有个人任务。

## 办理目标提取

真实响应信封尚未校准，因此 `extractTodoTargets` 不假定 `rows` / `records` 等字段名，而是遍历整个 JSON（深度 ≤ 12），只认两类证据：

- 字符串为 BPM 办理地址 `https://sapbpm-new.shanghaitech.edu.cn:9091/bpm-new/rbReimbursement/showLoadRbReimbursement.job`，且恰有一个合法 `bizId`（32 位十六进制）和一个合法 `taskId`（UUID）。被 CAS `service=` 等参数或 hash 编码包裹的地址最多解开 3 层；其他域名、端口、路径一律忽略。
- 同一对象中并列的 `bizId`、`taskId` 字段（键名不区分大小写），格式同上。

同一对象的字符串中恰好出现一个 `A` 加 12 位以上数字的单号时，记为该目标的 `documentNumber`。每个目标同时记录 `source`（`link` / `fields`）、`kind` 和 JSON 路径。

`kind` 区分办理任务和通知任务。实测“通知任务”（如“网上报销打印通知”“报销单已被驳回”）也链接到同一 BPM 表单页，但它们的 `nodeName` / `subject` 以“通知任务”开头，链接中 `isReadOnly` 出现两次，`bizKey` 形如 `UUID_xxx` 而不等于 `bizId`。满足任一特征即记为 `notification`；办理任务的 `bizKey` 等于 `bizId`，记为 `handling`。

`resolveTodoTarget(page, documentNumber)` 以单号为 `subject` 查询，再由 `selectTodoTarget` 选择：只考虑 `handling` 目标，优先取单号相同的目标；只有全部目标都没有单号时才考虑无单号目标；必须恰好一个，否则报 `target_missing` 或 `target_ambiguous`。所选 ID 仍需在[打开原单](open-reimbursement.md)后与隐藏字段比对，才算确认。

## 验证范围与后续衔接

`tests/task-search.test.cjs` 在隔离 JS 环境执行实际页面请求回调，替换网络响应，覆盖参数、同源请求、跳转、过期登录、错误 JSON、超时、私有文件和 CLI 调用链。认证和会话缓存另有定向测试。提取规则另有按实网记录形状构造的回归测试（标识均为合成值）。

2026-10-15 实测第 1 页 20 条中识别出 13 个办理目标和 4 条通知任务，其 taskId 与申请环节任务一致。`oa:open`、`oa:funds`、`oa:budgets` 的 `--document-number` 改为从[报销单列表](open-reimbursement.md#由报销单列表生成打开地址)解析，因为待办只覆盖分页内的记录；`resolveTodoTarget` 保留为可复用函数。这个模块尚未接入原流程的待办 DOM 搜索。历史单次测试数量和浏览器连接故障不代表当前系统运行状态，执行验证命令见 [README](../README.md)。
