# 接口方式填写用款申请单（`src/automation/http-fill.ts`）

Easy 页面登录后，“只保存”和“保存后提交流转”都不启动浏览器：服务端沿用页面这次的学校登录，按浏览器操作时实际发出的请求顺序直接调用 BPM 接口（提交见文末“提交”一节，`src/automation/http-submit.ts`）。设置 `OA_HTTP_FILL=false` 让整个任务回到浏览器；`OA_HTTP_SUBMIT=false` 只让提交环节回到浏览器（接口保存后由浏览器回读并点击“提交”）。

请求链来自 2026-10-15 在 A209900000010 上的浏览器抓包（`OA_NETWORK_CAPTURE=true` 时写入任务目录 `network.jsonl`），并用 `tmp/replay-fill.cjs` 把抓包回放给本模块逐字段比对：7 个写请求的业务字段与浏览器一致，唯一差别是浏览器表格组件附带的行元数据（`__id`/`__status`/`__isEditor` 等），接口方式不发送。

所有请求头带编辑页的 `csrfToken`（及 `procTaskId`），Referer 为编辑页；同一登录的 BPM 请求必须串行（并发会被回“登录超时”）。

| 步骤 | 请求 | 关键参数 | 成功判定 |
|---|---|---|---|
| 空单检查 | `slicedQueryRbReimbursementInvoices.ajax` | reimbursementId | 本单无发票 |
| 经费（只读） | `easySearch.load`、`queryChooseBudgetOutlays.ajax`（每页 20，翻完） | 经费编号唯一、预算科目名称唯一 | — |
| 发票 | `loadInvoiceFolderList1.ajax` → `uploadFillingInvoiceFiles.ajax?csrfToken=` | multipart：backurl=doSave、folderId=表单默认票夹、**每张 PDF 一个请求**（一个 `upload` 文件字段），各请求同时发出（最多 5 个） | 每个回复的 `invoiceResultList` 含该张发票且 `billClaimState=UNDOING` |
| 发票 | `queryBillImageListForClaims4WsNew.ajax`（未报销，invoiceReimbursementId=本单） | 全部上传返回后查询票夹（多个票夹同时查询）；未列全时每 3 秒再查，最长 60 秒 + 每张上传 20 秒 | 列出全部发票才继续；任何一张未列出则不保存经费、一张都不关联 |
| 经费 | `saveRbReimburBudgetOutlays.ajax`（本单的第一个写入） | projectCode/Name、deptCode/Name、requireAmount（千分位）、showAmount、manager、budgetOutlays=两次编码的所选行 JSON | `status 1`，data 为 fundingItemsId |
| 发票 | `insertRbReimbursementInvoice1.ajax`（JSON），**全部发票一次请求**，`insertRecords` 每张一条 | 票夹行 + reimbursementId、reimbursementSettleName=salerName、actualAmount=invoiceBalance、flag；invoiceCode/invoiceNumber 按页面映射互换 | `insertCount` 等于发票张数，可报余额合计 ≥ 实报金额，回读本单发票 |

上传只把发票放进票夹，不写本单，所以排在保存经费之前：发票被占用、上传后迟迟未入票夹或超过报销限制时，任务在本单写入任何内容之前停止（`partial: false`），新建的单据仍是空单，可以直接复用。

从票夹选择的发票（任务中带 `folderId`、不存 PDF）不上传：在保存经费之前，先按所在票夹只读查询“未报销”列表，确认它仍在且没有被其他单据占用，否则以 `invoice_missing` 停止，本单不做任何改动。页面的票夹列表来自 `GET /api/oa/folder-invoices`：每个票夹只请求一次“未报销”列表，`pagesize=100`（OA 单次上限），不再翻页；超过 100 张时页面会说明只列出了前 100 张。同一票夹内按发票号去重；可报余额等于发票金额、且没有关联单号的才可选。提交时服务端按同样的一次 100 条重新读取所在票夹，核对所选发票仍可选后才建任务。

铁路电子客票没有「价税合计」和「销名称」：金额读「票价」（按行识别，避免票价小数点后紧跟上证件号），销售方记为 OA 票夹使用的「中国国家铁路集团有限公司」。普通发票仍只认价税合计，出现「票价」也不采用。

报销限制（`src/domain/invoice-rules.ts`）：单张发票不设 500 元上限；同一销售方（忽略空格和全/半角括号）同一开票日期的发票，本单报销金额合计 < 500 元。核对分三层：页面加入发票时从 PDF 识别销售方和开票日期，不查询票夹；建任务时再按识别结果核对一次；接口填写时，上传后等票夹列出刚上传的发票，再按 OA 行的 `salerName`、`invoiceDate`、`allValoremTax`、`invoiceBalance` 最后核对，不通过以 `invoice_limit` 停止，经费不保存、一张都不关联。

页面加入发票时只在本机识别，不查询 OA。真正填写时，每个票夹只读「未报销」第一页（最多 100 条）对照全部发票号，不读「报销中」和「已报销」（这两个列表很慢）。已在「未报销」里且未关联单据的，直接在该票夹选中并关联，不再上传 PDF；已经挂在单据上的以 `invoice_claimed` 停止并给出单号。其余 PDF 每张一个请求同时上传；发票是否已被报销以上传接口的回复为准，返回“已被报销”时指出那一张及占用它的报销单号并停止。

**一个请求只能放一个文件。** 2026-10-21 实测：一个 `uploadFillingInvoiceFiles.ajax` 里放 2、3、5 个 `upload` 字段时，OA 只保存最后一个文件，回复却仍是成功，其余发票永远不会出现在票夹里（此前任务“限时内未列出全部发票”的原因）。同日抓包 OA 新版发票界面的多选上传：选中 2 张时发出 2 个上传请求、同一毫秒发出、各返回一张，约 6 秒；随后一次 `insertRbReimbursementInvoice1.ajax`（`insertRecords` 两条，回复 `insertCount: 2`）关联，再调用 `fillQueryRbElectronicInvoices.ajax` 补全显示信息（程序不需要，改为回读本单发票）。上传一返回，发票就已在票夹的“未报销”列表中。程序照此实现。其他 2026-10-16 实测记录：
- 一个 PDF 无论几页，都只返回一条 `invoiceResultList`。
- 空白 PDF 会被收进票夹，票种为“未知票种（业务票）”，发票号为空，金额为 0。
- 已报销的发票不返回 JSON，而是返回 HTML 错误页“当前票据…（发票号码：…）已被报销，报销人[…]，报销单号[…]”，且不入票夹。2026-10-20 实测另一种写法（状态 200，text/html）：“票据[<发票号>_…pdf]已被(报销人[…]，报销单号[…])报销使用”。程序把这两种错误页都按 `invoice_claimed` 处理。

因此，一个 PDF 里有多张发票时，由本机先拆开（`POST /api/invoices/split`，`splitInvoicePdf`）：每页识别发票号，相邻且发票号相同的页算同一张，没有发票号的页（行程单等）不上传。拆出的每张发票仍是单独的 PDF，与其余 PDF 一样各自一个上传请求。只有一张发票的 PDF 保持原文件不变。

全部 PDF 同时上传，全部返回后一起核对票夹，最后一次关联。OA 页面本身就同时发出多个上传请求和多个票夹查询，程序只在这两处并行；同一登录上的其他请求仍然串行。
| 付款 | `querySettlementKindByReimbursementId.ajax`；没有时 `showInsertRbReimburSettleKind.load` + `insertRbReimburSettleKind.ajax` | settleKindIds=“个人银行卡” | 回读到 `tech.rb.settlement.kind.007` |
| 付款 | `queryRbReimbursementSettle.ajax` | — | 无已有付款行 |
| 付款 | `showInsertRbReimbursementSettle.load` → `queryPersonInfo.ajax` | encryptedPayload：弹窗表单 JSON（只填 personCode），见下 | 返回姓名和卡号 |
| 付款 | `saveRbReimbursementSettle.ajax` | 弹窗表单字段 + personName（两次编码）、payeeCode=卡号、paymentAmount、isSelectHistory/isCash | `status 1`，data=金额 |
| 银行汇款 | `insertRbReimburSettleKind.ajax`（settleKindIds=“银行汇款”）→ `queryRbReimbursementSettle.ajax` | 读回 `tech.rb.settlement.kind.006`（isSelectHistory 1） | 无已有付款行 |
| 银行汇款 | `mmSupplier/slicedQueryMmSupplier.ajax` | supplierKind=1、keyValue=户名（两次编码）、status=1、isBank=1、page/pagesize、sortname=code | 模糊搜索；只取户名完全一致、供应商编码等于页面所选、有账号和开户行的唯一一行 |
| 银行汇款 | `showInsertRbReimbursementSettle.load` | 选中的供应商行原样提交 + isSelectHistory/isCash、reimburSettleKindId、reimbursementId | 弹窗表单预填 supplierCode、payee、payeeCode、ownedBank、openingBankName |
| 银行汇款 | `saveRbReimbursementSettle.ajax` | 弹窗表单字段（全部两次编码）+ purpose=汇款用途、paymentAmount=实报金额、isSelectHistory/isCash | `status 1`，data=金额；提交前回读付款行的 supplierCode 与所选一致 |
| 主表单 | `queryRbReimburBudgetOutlays.ajax` → 重新 GET 编辑页 → `workflow/saveBizData.ajax` | `#submitForm` 字段（不含 hasSchoolLeader）、bizId、procUnitId、procInstId、taskKindId=task、taskId、flowKind=APPROVAL、handleResult=0 等、remark=报销事由、budgetOutlays=[明细行+金额/附件数/用途]、writeOffs=[]、currencyKind；全部两次编码 | `status 1`，回执报销/结算金额与附件数一致 |

两次编码即页面的 `encodeURI(encodeURI(v).replace(/&/g,'%26').replace(/\+/g,'%2B'))`，再按表单编码发送。

收款人查询的加密：弹窗页带 `__POPUP_SESSION_ID` 和 `__CORE_JS_B64`。脚本每次弹窗不同，结构为 PBKDF2-SHA256（字面量密码与盐，10000 次）派生 AES-256-CBC 密钥，随机 16 字节 IV 放在密文前，整体 base64。程序只用正则读取这三个字面量并校验结构，从不执行该脚本；结构变化时停止并报 `encryption_unrecognized`。

失败处理：任一回执不符即停止、不重试。尚未发出写请求时任务记为失败（本单未改动）；已发出写请求则记为需人工核对，并在事件中写明停在哪一步。

## 提交（2026-10-15 在 A209900000023 上实测并抓包）

“保存后提交流转”时，接口先填写并保存，再启动浏览器以 `submitOnly` 方式打开同一张单：等发票表和金额加载后逐项回读核对，点击“提交”，核对流转确认的审批规则与路线，再单次点击“确定”。浏览器点击“提交”和“确定”时发出的请求：

1. `rbReimbursement/checkAdvanceBillInvoice.ajax`（reimbursementId）→ `{"message":"no","status":0}`
2. `workflow/showQueryHandlers.ajax`（bizId、processDefinitionKey=rbReimbursementProc、procUnitId=Apply）→ `{"data":"true"}`
3. `workflow/saveBizData.ajax`（与保存相同的字段）
4. `workflow/queryHandlers.ajax`（同 saveBizData 字段）→ `procApprovalRuleFullName=/网上预约报销审批`，Rows 为 OA 自动生成的审批人（经费负责人、学院财务联络人、财务审核岗……）
5. 点击“确定”：`workflow/queryAdvance.ajax` = saveBizData 字段 + `procUnitHandlers`（第 4 步的 Rows JSON）+ `hasGatewayManual=false`，响应体为空；之后单据状态变为“提交”，发票变为“报销中”。

流转确认窗口是 ligerGrid（表头和数据行在 `.l-grid2` 内的两张表，另有隐藏的“已合并”和第二个“处理人”列），浏览器方式的路线读取已按此结构核对。

### 接口方式提交（`submitFormHttp`）

2026-10-15 实测：新建单据，被授权的启动经费 / 委托服务费，一张 200 元全电发票，收款人为学生工号。整单接口保存、回读核对、审批路线（经费负责人 → 学院财务联络人 → 财务审核岗 3 人）均通过；发出一次 queryAdvance 后，“报销单查询”显示状态“提交”、报销/结算 200 元、附件 1 张。

接口保存成功后，同一登录上按以下顺序执行，任一核对不通过即停止：

1. 回读本单：编辑页只有一个经费页签，且编号和金额与任务一致；经费明细只有一行，金额、附件数和预算科目一致；发票集合与任务完全相同；付款只有一行“个人银行卡”，工号和金额一致。
2. `checkAdvanceBillInvoice` 必须返回 `no`，`showQueryHandlers` 必须返回 `"true"`；之后的 `saveBizData`（`budgetOutlays=[]`、`showTips=false`）回执金额和附件数须一致。
3. `queryHandlers` 核验：审批规则为 `/网上预约报销审批`，无需手工选择分支或处理人（`hasSelection=false`、`hasGatewayManual=false`），每行处理人完整且 bizId/单号属于本单，“经费负责人”恰有一位，其 handlerId 以所选经费的 `firstId` 开头（2026-10-15 已用两个不同负责人的经费实抓核对）。
4. 只发送一次 `queryAdvance`：字段与 `queryHandlers` 相同，另加 `procUnitHandlers`（第 3 步的 Rows 加上表格附带的 `canMerge=0`、`merged=0`、`__id`、`__isEditor`，两次编码）和 `hasGatewayManual`。响应为空（早先抓包）或 `{"data":"ok","status":1}`（2026-10-15 A209900000024/0140 实测）表示 OA 已接受；`status 2` 加 message 为拒绝；网络中断或其他响应为“结果未知”。不论哪种结果都不重试。
5. 回执：OA 的回复不属于上述任何一种时，响应内容写入任务记录，同样以“报销单查询”为准。在“报销单查询”中按单号读取，状态为“提交”且金额一致才把任务记为“已提交并核验”。拒绝后状态仍为“预制”时记为 `http_submit_rejected`；其余情况记为需人工核对（`submission_unknown`）。queryAdvance 之前停止的记为 `http_submit_blocked` 或 `submission_route_unverified`，单据仍为预制。

只读核对脚本：`tmp/live-readonly-fill.cjs <bizId> <taskId> <工号>` 在已保存的单据上实测弹窗页与加密查询，不发送写请求。
