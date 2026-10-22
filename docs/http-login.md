# 无浏览器登录（统一身份认证 → 门户 → BPM）

2026-10-15 在干净浏览器中手动账号密码登录并抓包得到以下流程；`src/automation/http-login.ts` 按此用纯 HTTP 复现，命令为 `npm run oa:login`。

## 1. 统一身份认证（金智 CAS，`ids.shanghaitech.edu.cn`）

1. `GET /authserver/login?service=https://egate-new.shanghaitech.edu.cn/login`
   - 下发 `route`、`JSESSIONID`（Path=/authserver）。
   - 页面有多个表单：`fidoLogin`、`dynamicLogin`（短信）、`qrLogin`（微信扫码）和账号密码表单 `#pwdFromId`。
   - `#pwdFromId` 的隐藏字段：`_eventId=submit`、`cllt=userNameLogin`、`dllt=generalLogin`、`lt=""`、`execution=e1s1`（Spring Web Flow 状态，每次刷新页面递增），以及仅供前端使用的 `#pwdEncryptSalt`（16 字符，随会话变化）。
2. `GET /authserver/checkNeedCaptcha.htl?username=<账号>&_=<时间戳>`，返回 `{"isNeed":false}`；为 `true` 时验证码图片为 `GET /authserver/getCaptcha.htl?<时间戳>`（同一 CAS 会话，2026-10-15 实测返回 `image/jpeg`），答案放在登录表单的 `captcha` 字段。登录页当前 `captchaSwitch = "1"`（图形验证码；`"2"` 才是滑块，本实现不支持），`_badCredentialsCount = "3"`，即同一账号连续输错几次密码后开始要求验证码。
3. 密码加密（`encrypt.js`）：

   ```
   password = Base64( AES-CBC-PKCS7( randomString(64) + 明文密码, key = pwdEncryptSalt, iv = randomString(16) ) )
   randomString 字符集 = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
   ```

   key 与 iv 均按 UTF-8 字节使用；6 位密码得到 108 字符密文，与实抓一致。
4. `POST /authserver/login?service=…`（`application/x-www-form-urlencoded`），字段顺序：`username, password(密文), captcha, _eventId, cllt, dllt, lt, execution`。
   - 成功：`302 Location: https://egate-new…/login?ticket=ST-…`，并下发 `CASTGC`（Path=/authserver，后续各服务单点登录都靠它）。
   - 失败：返回登录页，`#showErrorTip` 中是服务器错误文案。
   - 其他页面（多因素/二次认证等）：本实现停止，提示改用浏览器登录。

## 2. 门户（`egate-new.shanghaitech.edu.cn`）

1. `GET /login?ticket=ST-…`：`302 → /login`，下发 `WISCPSID`（门户会话）和 `casp-portal`。
2. `GET /login`：`303 → /index.html`，下发 `COM.WISEDU.CASP.*`。
3. 校验：`GET /getLoginUser?_t=…` 返回 `{errcode:"0", data:{userAccount, userName, …}}`，要求 `userAccount` 与登录账号一致。
4. 门户 API（如待办 `POST /custom/api/v2/casp-tdc/task/search`）只需 Cookie，不需要 csrf 头。

## 3. BPM（`sapbpm-new.shanghaitech.edu.cn:9091`）

1. `GET /bpm-new/rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do`：未登录时下发 `ShanghaiTech`（Path=/bpm-new）并 `302` 到 `ids…/authserver/login?service=…/bpm-new//rbReimbursementQuery/forwardRbReimbursementOwnerQuery.do?null`。
2. CAS 凭 `CASTGC` 直接 `302` 回 `…?null=&ticket=ST-…`，BPM 校验 ticket 后返回页面，不需要再次提交密码。
3. 页面 `#csrfTokenElement` 即后续 `.ajax` 请求的 `csrfToken` 头，例如本人报销单列表 `slicedQueryOwnerReimbursement.ajax`。

## 4. 无浏览器查询（`npm run oa:http -- <命令>`）

`src/automation/http-bpm.ts` 在同一个 Cookie 会话里直接请求接口，请求头与页面自身的 jQuery 调用一致（`csrfToken`、`procTaskId`、`X-Requested-With`、页面 URL 作为 Referer）。2026-10-15 实测全部通过：

| 命令 | 链路 |
| --- | --- |
| `tasks` | 门户 `task/search`（JSON） |
| `target --document-number A…` | 报销单查询页 csrfToken → `slicedQueryOwnerReimbursement.ajax`（bizId）→ `getApplyTaskInfo.ajax`（taskId） |
| `funds` | 报销单查询页 csrfToken → `easySearch.load`（不需要报销单） |
| `budgets --funding-code …` | 报销单查询页 csrfToken → `queryChooseBudgetOutlays.ajax`（不需要报销单） |
| `funds/budgets --document-number A…` | 上一行的 target 链路 → `GET showLoadRbReimbursement.job`（服务端 HTML 已含 `#jobPageBizId`、`#jobPageId`、`#jobPageBizCode`、`#mainAccountBook`、`#reimbursementKind`、`#csrfTokenElement`）→ 以原单的账套、报销类型和 procTaskId 查询 |

经费和预算接口只校验 BPM 会话及 `csrfToken`，任意 BPM 页面（如报销单查询页）的 token 均可；`procTaskId` 不是必需的。实测（2026-10-15）：
- 用报销单查询页的 token 直接查，结果与在原单内查完全一致：46 个项目；20 个科目，余额 765246.00。
- 不带 `csrfToken` 时，GET 和 POST 都被拒绝：经费列表返回 `#show_error_info` 错误页，预算接口返回 `{"status":"2","message":"错误的请求!"}`。
- 不指定原单时，账套默认 `ST00`、报销类型默认 `applyMoney`，可用 `--account-book`、`--reimbursement-kind` 覆盖。

- 原单页面只解析文本，不执行脚本。隐藏字段中的 bizId、taskId 必须与目标一致，单据编号须与参数一致。
- BPM 的 `.ajax` 请求不跟随跳转，出现 302、401 或 403 都视为会话失效。
- 已离开申请环节的单据不以办理模式打开，与浏览器命令一致。
- 参数解析、结果保存和输出格式复用 `oa:tasks`、`oa:funds`、`oa:budgets`。

## 5. 一键报销页面（`http://127.0.0.1:4317/Reim-Copilot`）

`npm start` 后打开 `/Reim-Copilot`（发布版为 `/Reim-Copilot`；`/` 会转到这里）。页面依次完成：

1. 登录页：输入学号、密码。测试时如果 `.env` 中设置了 `OA_USERNAME`/`OA_PASSWORD`，页面会自动填入学号；密码框留空直接点“登录”，后台就用 `.env` 中的密码登录（`POST /api/oa/login {useSaved:true}`）。密码不会发给浏览器，`/api/oa/status` 只返回 `savedUsername`。每次打开页面都要先登录，即使后台还保留着上次的会话也不跳过。每次登录都由后台重新执行 CAS → 门户 → BPM 全流程，并清掉之前选好的单据；登录后页面顶部显示后台返回的登录时间和三个步骤。
2. 登录后只有一个表单：用款申请单（第一项“新建”，其余为空单）、项目类别、经费、预算项（显示可用余额）、全电发票 PDF（当场识别票号和票面金额）、实报金额（默认票面金额）、附件张数、收款人（学号/工号走个人银行卡，单位户名走银行汇款并选择 OA 供应商账户、填写汇款用途；默认本人工号）、用途、说明，以及完成方式（默认保存并提交流转，可改选只保存）。
3. 点“提交”并确认摘要后，`POST /api/oa/submit` 生成一个真实任务并立即执行：后台沿用本页的学校登录直接调用 OA 接口（不打开浏览器），完成选单（新建，或按 bizId/taskId 打开所选空单并核对单号）、经费与预算、上传并关联发票、付款、明细、保存，选了提交时再回读核对、核验审批路线并只发送一次提交，见 [接口填写与提交](http-fill.md)。页面每 2 秒刷新执行进度，可随时停止后续操作。

一键提交的约束：

- 需要 `.env` 中 `OA_LIVE_ENABLED=true`；未启用时在建任务前拒绝（403）。
- 所选空单在建任务前再查一次，已有内容、已关联发票或已选过经费项目则拒绝（409）；页面传来的 `formMode`/`target` 一律忽略，只用后台核对过的单据。
- 回执：“保存并提交”以“报销单查询”中状态“提交”且金额一致为准，记为“已提交并核验”，不需要 `OA_SITE_PROFILE`；“只保存”结束后为“待人工核对”。
- 以下两条只适用于 `OA_HTTP_FILL=false` / `OA_HTTP_SUBMIT=false` 时的浏览器备用路径。浏览器沿用本页登录：后台把 HTTP 会话的学校 Cookie 写成 Playwright storageState，放在该任务私有目录（`oa-session.json`，0600），执行进程结束或任务取消时删除。密码不传给执行进程，Cookie 不返回页面。若登录已失效，浏览器停在学校登录页，可手动登录后继续。2026-10-15 实测：仅凭这些 Cookie，无头 Chrome 1.7 秒通过门户登录检查，并以只读方式打开了空单 A209900000010。
- 经费按经费编号、预算按预算项名称查找唯一行；页面提交前会检查这两个关键字在当前列表中是否唯一，不唯一时拒绝提交。

后端为 `src/server/oa-api.ts`，接口挂在 `/api/oa/*` 下，沿用本机服务的会话 Cookie 和 CSRF 校验。

后台对每次登录用两个 BPM 会话：主会话给任务填写和提交使用；只读查询（经费、预算项、空单列表与核对、票夹、报销单打印）用 `OaHttpClient.fork()` 开的第二个会话——复制 CAS 和门户的 Cookie、不带主会话的 BPM Cookie，首次访问 BPM 时由 CAS 签发新票据，得到独立的 BPM 会话 Cookie 和 csrfToken（2026-10-21 实测约 0.8 秒，两个会话同时请求互不影响）。两个会话各有自己的请求队列，任务长时间占用主会话时，页面查询不受影响。第二个会话被 OA 判为失效时重开一次；开不出来时退回主会话。

| 接口 | 作用 |
| --- | --- |
| `POST /api/oa/login` `{username,password}` | 无浏览器登录；密码只用于这次请求，不保存，只在内存中保留 Cookie。返回 `login: {at, userAccount, userName, steps}`。CAS 要求验证码时登录暂停，返回 `{loggedIn:false, captcha:{image}}`（data URL）；页面再发 `{captcha}` 继续同一次登录。暂停最多 3 分钟，期间密码只留在这次登录的内存中；超时、退出或重新登录即作废。验证码或密码错误时这次登录结束，需重新点击登录 |
| `POST /api/oa/login/captcha` | 在暂停的登录上换一张验证码 |
| `GET /api/oa/forms` | 门户待办 `subject=用款申请单`，只保留主题形如 `[用款申请单-A…](日期)`、环节为“网上预约报销申请单”、且办理地址能解析出唯一 bizId/taskId 的任务（最多 5 页、每页 100 条），一次返回 `{forms}`。这些单据都还不能选，须逐张经下一个接口核对 |
| `GET /api/oa/forms/check?documentNumber=…` | 核对上一步列出的一张单据，返回 `{documentNumber, blank}`。空单 = “报销单查询”中状态 0 预制、`applyMoney`、bizId 与待办一致，且 `DRAFT_CONTENT_FIELDS` 中的内容列（说明、备注、经费、各类金额、附件数、收款人等）全部存在且为空（缺列视为非空）；并且编辑页没有关联发票、没有经费项目（中途停止的任务会留下这类主表为空的单据）。只有核对为空的单据可以选择和提交。页面逐张核对，每核对出一张空单就加入下拉框 |
| `POST /api/oa/forms` `{confirmed:true}` | 新建用款申请单（固定为 `applyMoney`、账套 ST00），见下文 |
| `POST /api/oa/select` `{documentNumber}` | 只接受已核对为空单的单据；打开前再查一次该单是否仍为空单，不是则拒绝（409）；再用待办里的 bizId/taskId 打开原单并核对身份 |
| `GET /api/oa/funds?kind=authorized\|responsible` | 查询经费；已选报销单时用其上下文，否则用“报销单查询”页的 csrfToken 和 ST00/applyMoney |
| `GET /api/oa/budgets?fundingCode=…` | 同上，查询预算项及余额 |
| `POST /api/oa/submit` `{confirmed, action, documentNumber\|null, invoice, input}` | 一键生成并启动真实任务，见上文 |
| `GET /api/oa/payees?name=…` | 银行汇款：在 OA 供应商库中查找户名完全一致、有账号和开户行的供应商，返回 `{suppliers:[{supplierCode, name, bank, account(仅后四位), main}]}` |
| `GET /api/oa/print`、`GET /api/oa/print/permission`、`POST /api/oa/print` | 报销单打印页面使用，见 [报销单打印](http-print.md) |

一键提交中的“新建”与 `POST /api/oa/forms` 使用同一个 HTTP 创建接口，对应 `rbReimbursementAdd.js` 的“创建 → 确定”：

- 请求为 `POST /bpm-new/rbReimbursement/createReimbursement.ajax`，参数 `reimbursementKind`、`accountBook`、`accountBookName`，其中 `accountBookName` 经 BPM `Public.encodeURI` 两次编码。
- 成功时返回 `{status:0, data}`，前端直接把 `data` 作为 `showLoadRbReimbursement.job` 的参数。程序要求 `data` 中有合法的 bizId 和 taskId，并打开新单核对隐藏字段。
- 只发送一次，不重试；同一时间只允许一个创建请求。结果不明时提示先刷新列表查看，不自动重试。
- 2026-10-15 实测：一键任务通过该接口新建了 A209900000024、A209900000025，并打开新单核对通过。
## 实现与安全约束

- 只在学校的三个 OA 主机之间手动跟随跳转；跳到其他地址（如微信扫码 `open.weixin.qq.com`）立即停止。
- Cookie 只接受 `shanghaitech.edu.cn` 及其子域；`Domain=edu.cn` 这类公共后缀 Cookie 直接丢弃。
- 不打印密码、Cookie、ticket 或 csrfToken；验证码图片以 0600 权限临时保存，输入后删除。
- `--save-session` 把 Cookie 按 Playwright storageState 格式写入 `OA_SESSION_STATE_PATH`（需 `OA_REMEMBER_SESSION=true`），之后的浏览器命令会先验证再复用。
- 二次认证和扫码登录不在无浏览器范围内；遇到时按原流程用 `oa:connect` 手动登录。
