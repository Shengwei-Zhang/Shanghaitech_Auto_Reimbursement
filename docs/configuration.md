# 配置、登录态与运行排查

核对日期：2026-10-15。返回 [README](../README.md)。配置模板见 [`.env.example`](../.env.example)，已有 `.env` 时直接修改，不重新复制覆盖。

## 配置加载与作用域

网页服务、`automation:cli`、`oa:connect`、`oa:tasks`、`oa:open`、`oa:funds` 和 `oa:budgets` 会从工作目录加载 `.env`。命令应在项目根目录运行；`scripts/start-local.sh` 会先切换到根目录。dotenv 不覆盖进程中已有的环境变量，因此终端显式设置的值优先。网页服务修改配置后需重启；CLI 每次重新启动时加载。

`batch:check` 和 `batch:draft` **不自动加载 `.env`**，只读进程环境中的 `OA_DATA_DIR`，未设置时使用当前目录下的 `data`。若网页使用自定义数据目录，批次命令也必须指向同一目录，才能检查已有任务：

```bash
OA_DATA_DIR='/绝对路径/私有数据目录' npm run batch:check -- '/绝对路径/batch.json'
```

## 通用配置

| 变量 | 默认行为 / 示例值 | 作用 |
| --- | --- | --- |
| `PORT` | `4317`，允许 1024–65535 | 网页服务端口；监听地址固定 `127.0.0.1` |
| `OA_DATA_DIR` | `data` | 任务、会话默认路径、查询结果；相对路径按进程工作目录解析 |
| `OA_LIVE_ENABLED` | `false` | 启用网页真实任务执行；不是所有 CLI 的总开关 |
| `OA_SITE_PROFILE` | 空 | 经实网校准的回执配置 JSON 路径；参考 [配置示例](../config/oa-site.example.json) |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 空 | 浏览器可执行文件；macOS 默认探测系统 Chrome，否则使用已安装的 Playwright Chromium |
| `OA_REMEMBER_SESSION` | `false` | 允许加载和保存专用 OA 登录态 |
| `OA_SESSION_STATE_PATH` | 空 | 覆盖默认会话文件路径；使用专用私有目录 |
| `DEEPSEEK_API_KEY` | 空 | 可选 AI 服务端密钥，详见 [DeepSeek](deepseek.md) |
| `OA_NODE_BINARY` | 未设置 | 仅启动 shell 脚本使用；指定 Node 22+ 可执行文件，须在运行脚本前设置 |

`OA_NODE_BINARY` 不能仅填在 `.env` 等待脚本读取：脚本选择 Node 在应用加载 `.env` 之前。npm 命令仍使用当前 shell 的 Node；脚本选择了新版本不等于全局 Node 已更新。

`OA_SITE_PROFILE` 中的占位路径、字段和状态不能直接作为生产配置。缺少有效回执核验时，执行器可能已经完成最终点击，仍不会把结果标为可靠提交；必须核对原单后处理。

## 专用 OA 登录态

开启 `OA_REMEMBER_SESSION=true` 后，默认保存位置为 `<OA_DATA_DIR>/browser-session/storage-state.json`。成功认证后保存，已确认认证的会话关闭前再次更新。只保留允许的学校域 Cookie 和 HTTPS 来源存储，文件权限 `0600`、专用目录 `0700`，以临时文件加重命名方式更新。

缓存包含 Cookie、localStorage、IndexedDB；不包含 sessionStorage、标签页、表单内容或业务检查点。过期或损坏缓存回到学校页面登录，不据缓存存在就判定认证成功。门户和 BPM 的会话分别核验；按 ID 打开原单或经费查询入口可能再经过一次 CAS。

网页任务与这些 CLI 共用缓存路径，但没有跨进程会话租约。网页队列本身串行，CLI 不受该队列约束，使用同一账号时需错开。明确选择账号密码认证时，不导入也不覆盖手动登录账户的缓存。

关闭正在使用缓存的浏览器/任务后，删除实际会话文件即可清除本机记忆；设置 `OA_REMEMBER_SESSION=false` 会停用加载和保存，但不自动删除旧文件。自定义目录的 Git 忽略和访问权限由使用者检查，默认 `data/` 已排除 Git。

本地工作台的 `oa_session` Cookie 与 `x-csrf-token` 是本地 HTTP API 保护；校园 BPM 请求的 Cookie 和 `csrfToken` 属于学校会话，两者不能混用。校园令牌不应填写到 `.env`。

## 原自动化 CLI 配置

以下参数供 `npm run automation:cli` 使用。网页任务的业务参数来自表单，worker 通过受限环境和 IPC 接收，不继承这些调试配置。

| 变量 | 行为 |
| --- | --- |
| `OA_ACTION` | `submit`（默认）或 `save`；提交模式会核验路线后尝试最终确认 |
| `OA_FORM_MODE` | 默认 `new`；`reuse` 才检查近期空单 |
| `OA_LOGIN_MODE` | 默认 `manual`；`credentials` 使用 `OA_USERNAME` / `OA_PASSWORD` |
| `UPLOAD_FILE_PATH` | 存在、可读、非空的单个 PDF；不接受目录或自动选第一张 |
| `REIMBURSEMENT_PURPOSE`、`REIMBURSEMENT_REASON` | 用途及说明；说明为空时沿用用途 |
| `PAYEE_PERSON_CODE` | 收款人工号 |
| `FUNDING_KIND_KEYWORD` | `被授权的项目` 或 `我负责的项目` |
| `FUNDING_ITEM_KEYWORD`、`BUDGET_OUTLAY_KEYWORD` | OA 中唯一匹配的经费项目和预算科目 |
| `ATTACHMENT_COUNT` | 模板设为 `1`；原 CLI 未配置时的代码回退是 `3`，应显式填写实际数量 |
| `EXPECTED_AMOUNT` | 本次实报金额 |
| `EXPECTED_INVOICE_AMOUNT`、`EXPECTED_INVOICE_NUMBER` | 预期票面金额和完整票号，用于核验 |
| `PLAYWRIGHT_TIMEOUT_MS` | 常规控件超时，默认 `20000` 毫秒；不替代上传等待、登录等待或网页任务总超时 |
| `HEADLESS` | 模板为 `false`；网页任务及登录/查询 CLI 强制有界面 |
| `START_FROM`、`RESUME_EXISTING` | 专家调试续跑；必须已有唯一可用 BPM 页，缺页或阶段不明时停止 |
| `PLAYWRIGHT_CDP_ENDPOINT`、`CHROME_DEBUGGER_ADDRESS` | 原 CLI 连接已有调试浏览器；新登录/查询命令主动忽略 |
| `KEEP_BROWSER_OPEN` | 原 CLI 控制退出时是否关闭浏览器；网页和新查询命令不继承 |
| `PAUSE_ON_FAILURE` | 原 CLI 流程失败时等待 Enter，再继续退出处理；默认关闭，需在交互终端使用 |
| `CAPTURE_DEBUG_ARTIFACTS` | 原 CLI 可选采集调试产物；网页任务强制关闭，登录阶段不采集 |

`PAUSE_ON_FAILURE` 由报销流程的错误处理调用，不覆盖启动浏览器前的文件校验等错误。网页 worker 强制关闭此开关；网页的最多 5 分钟现场查看通过独立回调实现。

`oa:connect`、`oa:open`、`oa:tasks`、`oa:funds`、`oa:budgets` 均强制手动登录、有界面和自动关闭，并清除 CDP 设置。旧单直开需要 Enter 后关闭，三个查询命令在保存结果后关闭。API 参数从命令行读取，不从业务关键词环境变量推导。

## 常见问题

| 现象 | 核对方法 |
| --- | --- |
| Node 太旧、`node:test` 或参数解析不可用 | `node --version` 应为 22+；修正 PATH 或给启动脚本设置 `OA_NODE_BINARY` |
| 浏览器无法启动 | 检查可执行路径；没有系统 Chrome 时运行 `npm run browser:install` |
| 修改配置无效 | 重启网页服务；检查终端环境是否覆盖 `.env`；批次命令不加载 `.env` |
| 数据目录已被占用 | 检查使用同一 `OA_DATA_DIR` 的服务；单实例锁会拒绝第二个服务，不随意删除活动锁 |
| 查询返回登录页、401 或 403 | 核对校园网络、账号和 BPM 会话；403 也可能是权限或令牌问题，不能当作空数据 |
| 预算查询 `csrf_missing` / `csrf_ambiguous` | 当前页面没有已识别令牌或来源冲突；重新打开原单，仍失败则校准实际页面来源，不粘贴旧 token |
| 旧单打开编号不符或任务失效 | 使用当前实际办理链接里的 ID，并用 `--document-number` 核对；不要改用新建 |
| 同一张发票想再提交一次 | 本机任务不再拦截。若 OA 返回“已被报销”，再打开对应单据核对 |
| 已点击提交但没有“流转已核验” | 查原单及站点回执配置；点击或 HTTP 200 都不能代替结果核验 |

更多执行证据和恢复条件见 [OA 流程](oa-flow.md)，当前架构及多人部署前置条件见 [架构说明](architecture.md)。
