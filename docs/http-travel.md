# 接口方式填写境内差旅单（`src/automation/travel/`）

境内差旅单（`reimbursementKind=domesticTravel`，单号以 **D** 开头，如 D209900000037）的填写与[用款申请单](http-fill.md)共用登录、经费定位、付款和主表单保存，另加出差人、行程和冲借款三步。`fillTravelFormHttp` 只填写并保存；选择“保存并提交流转”时，再由 `submitTravelFormHttp` 回读核对后提交（见“提交”一节）。

**与用款申请单的代码隔离。** 差旅单的请求链全部在 `src/automation/travel/`（`request` 请求与主表单字段、`search` 出差人与携程借款单查询、`funding` 经费与经费明细、`invoices` 发票上传与关联、`payees` 收款人、`fill` 填写、`submit` 提交），服务端在 `src/server/travel-api.ts`（`TravelApi`，只借用 `OaApi` 的登录会话、请求队列和只读会话）。它不引用 `http-fill.ts` / `http-submit.ts`，用款申请单也不引用它；两者只共用与单据类型无关的部分：登录与 HTTP 客户端、BPM 编码、经费与预算查询、票夹接口、供应商查询、发票限额规则。经费、发票、付款和提交的逻辑有意各保留一份，改一种单据不会影响另一种。

请求链来自 2026-10-21 在 D209900000037 上的浏览器抓包（`tmp/capture-travel.cjs`，记录写在 `tmp/travel-capture/`，不提交），字段规则来自页面脚本 `domesticTravelDetail.js`、`reimbursementBusinessTrip.js` 和 `reimburWriteOff.js`。请求头、编码和串行要求与用款申请单相同。

| 步骤 | 请求 | 关键参数 | 成功判定 |
|---|---|---|---|
| 空单检查 | 编辑页、`queryRbBusinessTravellers.ajax`、`queryRbReimburWriteOff.ajax`、`slicedQueryRbReimbursementInvoices.ajax` | reimbursementId | 没有经费页签、出差人、冲借款和发票 |
| 经费（只读） | `easySearch.load`、`queryChooseBudgetOutlays.ajax`（reimbursementKind=domesticTravel） | 经费编号唯一，**每行**经费明细的预算科目名称唯一 | — |
| 出差人（只读） | `showInsertRbBusinessTraveller.load` → `easySearch.load` | 类别取下拉中的“教工”/“学生”；教工 `queryName=techOrgSearch`（orgKindId=psm），学生 `queryName=queryStudent`；按姓名查询，paramValue 编码一次 | 结果中有该学号/工号的行，且姓名一致（学生可能重名，所以必须给学号） |
| 冲借款（只读） | `queryCtripBorrows.ajax` | borrowKind=1、accountBook、keyValue=“携程”（两次编码）、fundingItemsCode | 每个订单号（borrowMoneyCode）唯一，未清余额 > 0；编辑页 `hasCtripBorrowAccount=true` |
| 经费 | `saveRbReimburBudgetOutlays.ajax`（本单的第一个写入） | budgetOutlays = 各行预算科目的 JSON 数组（选择弹窗是多选表格，一次保存） | `status 1`，data 为 fundingItemsId |
| 出差人 | `saveRbBusinessTraveller.ajax`，每人一个请求 | id=空、travellerCode、travellerTypeId、travellerTypeId_text/traveller/remark（两次编码）、reimbursementId | `status 1`；回读出差人列表，按 travellerCode 取唯一一行的 id 和每日补贴 `subsidyAmount`（实测教工 180、学生 100） |
| 行程 | `showInsertRbBusinessDetail.load` → `saveRbBusinessDetails.ajax`，每段一个请求 | businessDetails=一行的 JSON 数组（两次编码），字段见下 | `status 1`；每人回读 `queryRbBusinessDetail.ajax`，行数和 `totalFields.totalAmount` 与输入一致 |
| 冲借款 | `saveRbReimburWriteOff.ajax`，一次保存全部 | writeOffs=所选借款行 + `id:''`、`strikeBalanceAmount`=未清余额（页面默认） | `status 1`；回读冲账行和金额合计 |
| 付款 | 需要的付款方式各添加一次 → 每位收款人 `showInsertRbReimbursementSettle.load` →（个人银行卡）`queryPersonInfo.ajax` / （银行汇款）供应商查询 → `saveRbReimbursementSettle.ajax` | 各收款人金额之和 = 差旅合计 − 冲账合计；为 0 时不添加付款行 | 每次 `status 1`、data=金额，且该付款方式下的付款行数加一 |
| 保存 | `queryRbReimburBudgetOutlays.ajax` → `saveBizData.ajax` | 每行经费明细的金额、用途；附件数填在第一行、其余行 0；主表单比用款申请单多 `explain`（情况说明）和 `businessDetails=[]`，没有 `currencyKind` | 回执 `businessTripAmount`=`reimbursementAmount`=差旅合计，`reverseEntryAmount`=冲账，`settlementAmount`=付款，附件数一致 |

行程一行的字段（与弹窗表单相同）：`id`（空）、`travellerSubsidyAmount`（每日补贴，元）、`startDate`、`startAddress`、`arriveDate`、`arriveAddress`、`vehicle`（aircraft / train / car / other）、`vehicle_text`（飞机 / 火车 / 汽车 / 其他）、`trafficExpense`、`travelDays`、`standardSubsidyAmount`（= 每日补贴 × 天数）、`subsidyAmount`（实际补贴，默认等于标准补贴）、`hotelExpense`、`meetingAmount`、`otherAmount`。金额两位小数，未填的可选金额为空串。OA 计算的行合计 = 交通费 + 实际补贴 + 住宿费 + 会务/注册费 + 其他。

页面规则在发出任何请求前检查：到达日期不早于启程日期，差旅天数不超过两日期之间的天数 + 1。实际补贴不得高于标准补贴，这一条要等 OA 返回出差人的每日补贴后才能检查，所以此时经费和出差人已经写入（`partial: true`），对应的那段行程不会保存。

所有只读核对（出差人、携程借款单）都放在第一个写入之前：学号或订单号不对时停止，本单不做任何改动（`partial: false`）。

## 金额关系

- **报销总金额 = 差旅费用合计。** 2026-10-21 抓包中，经费明细填 1000、行程合计 4371，点击“提交”时 `queryAdvance.ajax` 被拒：“报销总金额不等于差旅费用金额,请确认。”程序把经费明细金额设为行程合计。
- **冲账 + 付款 = 差旅合计**：已提交的 D209900000033 印证：差旅合计 5,380 = 冲账 2,250（两张携程机票 1,267 + 983）+ 支付 3,130。
- **经费明细合计 = 差旅合计**：可以分到同一经费下的多个支出项目（预算科目），每行有自己的金额和用途；至多一行留空，取差旅合计减去其余各行（OA 算出差旅合计后才确定）。每行不得超过该预算科目的可用余额（`showAmount`；余额未授权查看时不在本机校验，由 OA 判断）。
- **收款人合计 = 差旅合计 − 冲账**：可以有多位收款人（个人银行卡或银行汇款），按谁垫付了什么分开，例如 D209900000033 中报销人甲 2,200（代付会议注册费）、教师丙 930（补贴和住宿）；至多一位留空，取剩余。
- **发票合计 ≥ 付款 − 补贴**：补贴不需要发票（D209900000033：付款 3,130，发票 2,880）。

经费明细行数和收款人人数在第一个写入之前就核对过格式；能否加总要等 OA 算出差旅合计（出差人和行程已写入）之后才确定，不符时在冲借款、付款和主表单保存之前停止（`partial: true`）。**多行经费明细和多位收款人尚未在真实 OA 中验证**：请求与单行时相同（多行预算科目一次保存，付款行逐条添加），提交前逐行、逐人回读核对。

## 提交（`submitTravelFormHttp`，`src/automation/travel/submit.ts`）

D209900000037 的抓包显示，差旅单点击“提交”发出的请求与用款申请单相同：`checkAdvanceBillInvoice.ajax`（回 `no`）→ `showQueryHandlers.ajax`（`true`）→ `saveBizData.ajax`（showTips=false，`budgetOutlays`/`writeOffs`/`businessDetails` 均为 `[]`，保留已保存的行）→ `queryHandlers.ajax` → 流转确认“确定”的 `queryAdvance.ajax`（附 procUnitHandlers、hasGatewayManual）。审批规则同为 `/网上预约报销审批`，没有手工分支；当时的路线为经费负责人 → 学院财务联络人 → 财务审核岗（3 人同组）。

发出任何提交请求前，先回读本单并与本次填写逐项核对：

- 经费页签唯一且编号一致；经费明细唯一，金额等于差旅合计，附件数和预算科目一致；
- 出差人集合一致，各人 `queryRbBusinessDetail.ajax` 的合计相加等于差旅合计；
- 冲借款的订单号集合一致，冲账金额合计一致；
- 发票集合一致（可以没有发票）；
- 付款为 0 时没有付款行，否则只有一行，收款人和金额（差旅合计 − 冲账）一致。

保存回执须满足 `reimbursementAmount` = `businessTripAmount` = 差旅合计、`reverseEntryAmount` = 冲账、`settlementAmount` = 付款（无付款行时可缺省或为 0），附件数一致。审批路线按用款申请单的规则核对，经费负责人须是所选经费的负责人。`queryAdvance` 只发一次、不重试，之后以“报销单查询”状态“提交”且金额等于差旅合计为准。

**尚未实测**：至今没有一次成功的差旅单提交，`queryAdvance` 成功时的回复、报销单查询中差旅单的金额列，按用款申请单推定。回复无法识别时任务标为“已结束，请在 OA 核对”，不会重试。

## 尚未覆盖

- 校外出差人（弹窗没有查询，需要单独抓包）、预付借款单页签（`queryChooseBorrows.ajax`）。

## Easy 页面

页面的“报销类型”选“境内差旅单”后：

- **单据**：“＋ 新建境内差旅单”，或复用空白差旅单。列表来自 `GET /api/oa/travel/forms`：报销单查询中本人状态为预制、`reimbursementKind=domesticTravel`、内容列全空的单据。选中后按单号经 `resolveListTargetHttp` 取得申请环节任务再打开；填写前 `fillTravelFormHttp` 仍会核对本单没有出差人、经费、冲借款和发票。
- **预算项**：`GET /api/oa/travel/budgets?fundingCode=…`（差旅单自己的查询，`reimbursementKind=domesticTravel`）。预算行随报销类型不同，例如 2099F9999-000-01 在差旅单下只有 4 项（市内交通/参会费、境内专家来访差旅费、国内差旅/参会费、招聘费用）。
- **补贴标准**：选“教工/学生”后在类别旁显示每日补贴标准，实际补贴留空的格子显示“标准 = 每日标准 × 天数”，合计按此估算；实际补贴不得高于标准。OA 只在出差人保存到单据后才返回其标准（`queryRbBusinessTravellers.ajax` 的 `subsidyAmount`），页面因此用 D209900000037 实测值：教工 180、学生 100 元/天；填写时 `fillTravelFormHttp` 以 OA 返回的标准计算并核对。
- **出差人与行程**：携程借款单和情况说明在前，出差人在后。每位出差人一张卡片：选类别、输入姓名，页面按姓名经 `GET /api/oa/travel/people?kind=staff|student&name=…` 在 OA 中查找（与 OA 弹窗相同的 `easySearch.load` 查询），再从结果中选学号/工号；只有一人时自动选中，同名时按学号/工号和部门选择。行程是可编辑的表格。
- **携程借款单**：可输入筛选的下拉框，与经费下拉相同，可多选，选中的显示在下方，可逐个移除。列表来自 `GET /api/oa/travel/borrows?fundingCode=…`（只读，`queryCtripBorrows.ajax`），只列未清余额大于 0 的，按借款日期从新到旧排列。换经费时清空已选。
- **发票**：与用款申请单相同，可上传 PDF 或从 OA 票夹选择，0–10 张。合计须不少于付款金额减去补贴（补贴不需要发票。已提交的 D209900000033：付款 3,130，发票合计 2,880，其中补贴不需发票）。上传在写入本单之前，关联在冲借款之后、付款之前。
- **经费明细与收款人**：两张表，替代用款申请单的“预算项”“收款人”“报销用途”。经费明细每行选预算项、填金额和用途，“＋增加支出项目”加行；收款人每行填学号/工号（个人银行卡）或户名（银行汇款，再选 OA 供应商账户和汇款用途）及金额，“＋增加收款人”加人。各留一行空金额即取剩余，表下实时显示按页面估算的合计是否相符。没有“实报金额”。完成方式可选“只保存”或“保存并提交流转”。

`POST /api/oa/travel`（`{ confirmed, action: 'save' | 'submit', input: { fundingKind, fundingCode, lines: [{ budgetName, amount?, purpose }], payees: [{ kind: 'card' | 'bank', code, supplierCode?, remitPurpose?, amount? }], attachmentCount, reason, explain?, travellers, ctripOrders? }, documentNumber?, invoices? }`，需 `OA_LIVE_ENABLED=true`）检查后开始一次填写，同一时间只运行一张。`GET /api/oa/travel` 返回进度（只在内存中，服务重启后不保留），`POST /api/oa/travel/stop` 在下一步之前停止。也可以用 `tmp/run-travel.cjs` 从 JSON 文件运行。页面代码在 `public/js/travel.js`（出差人、行程、携程、经费明细、收款人）和 `itinerary.js`（行程附件），不与用款申请单的 `apply-money.js` 互相引用。

## 行程附件（`src/domain/itinerary.ts`、`src/infrastructure/itinerary-files.ts`）

页面上差旅单的“发票”之后是“行程附件”：拖入或选择火车票、机票（携程订单页）、酒店水单、会议通知等文件（PDF、Word、PNG/JPEG）。每个文件经 `POST /api/travel/parse`（`{ name, base64 }`，≤ 8 MB）在本机内存中解析，**不写入磁盘、不发给 OA 或任何外部服务**；“发票”中已加入的 PDF 也一并解析（住宿、会务金额计入行程）。`POST /api/travel/itinerary`（`{ items }`，逐字段复核）把解析结果整理成行程，页面先展示预览和需要核对的提示，点击“填入出差人与行程”才写入出差人表格（之后仍可手工修改，保存和提交走原有流程）。

| 附件 | 读取方式 | 得到 |
|---|---|---|
| 铁路电子客票（全电发票） | PDF 内嵌的 XBRL（`rai_issuer_*.xml`），页面文字层为空 | 乘车人、车次、日期时间、出发/到达站（去掉“南/北/东/西/虹桥”后缀作城市）、席别、票价、是否退票 |
| 携程机票订单页 | 文字行（中文字体无字符映射，只剩数字和字母） | 订单号、航班号、起降日期时间、机场代码（内置代码 → 城市表）、**总支付金额** |
| 酒店水单 | 文字层；Opera 页眉的 `GA:/GD:` ISO 日期优先 | 入住/离店日期、晚数、金额、客人姓名 |
| 住宿 / 会议费全电发票 | 文字层（价税合计） | 住宿费 / 会务注册费金额 |
| 会议通知、日程（Word/PDF） | 段落文字，或文件名 | 报销事由建议 |
| 图片、扫描件 PDF | 本机 OCR（见下），再按水单、发票、通知识别 | 同上 |

**机票金额**：携程订单页第一行“¥… x1”是票价 + 机建 + 燃油小计，其后逐项列出各项费用；总支付 = 小计之后各项之和（含保险、服务费），与携程借款单金额一致（2026-10-22 核对 1990000000000007 = 1233、1990000000000005 = 1383、1990000000000006 = 882）。

**整理规则**：同一乘车人的车票、机票按时间排序为各段行程（机票读不出乘机人，有唯一乘车人时归他，否则单列）；差旅天数 = 首段出发到末段到达（含首尾），填在第一段，其余段 0 天（与 2026-10-21 录制一致）；**住宿费以酒店发票金额为准**，没有酒店发票时暂用水单金额并提示；会务发票金额填第一段。水单的日/月顺序有歧义时，取落在行程日期内的读法。以下情况只提示、不自动处理：退票或改签页面、行程中间缺段、两段相隔超过 7 天、非往返、凌晨次日到达、机场代码不在对照表、无法识别的图片。

“勾选匹配的携程借款单”按机票的携程订单号在所选经费的借款单中勾选；“把火车票加入发票”把识别出的铁路电子客票加入“发票”。

### 本机 OCR（PaddleOCR.js）

图片和没有文字层的扫描件用 [paddleocr.js](https://github.com/x3zvawq/paddleocr.js)（npm `paddleocr@1.2.0`，PP-OCRv5 mobile）在 `onnxruntime-node@1.30.0` 上识别；PNG/JPEG 用纯 JS 的 `pngjs`、`jpeg-js` 解码，扫描件 PDF 直接取出页面图像（JPEG，或 8 位 RGB/灰度/ICCBased 的 Flate 图像，跳过透明遮罩），不渲染 PDF。模型在首次识别时加载一次，之后每张图约 2 秒；整页由矢量绘制、没有图像的“扫描件”无法识别。

模型文件不在仓库中，放在 `OA_OCR_MODEL_DIR`（默认 `data/ocr-models`）。Hugging Face 在校内网络不可达，从 ModelScope 下载（RapidAI/RapidOCR 的 ONNX 转换）：

```sh
mkdir -p data/ocr-models && cd data/ocr-models
base=https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master
curl -LO $base/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx                     # 4819576 字节
curl -LO $base/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx                     # 16631306 字节
curl -LO $base/onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx  # 1018508 字节
curl -LO $base/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt       # 74012 字节
```

识别字典需在末尾补一个空格类（模型输出 = 空白 + 字典 + 空格），`src/infrastructure/ocr.ts` 已处理。缺少模型或运行库时，图片和扫描件逐个标为“本机 OCR 不可用”，其余附件照常解析。`onnxruntime-node` 的 install 脚本未运行也可用：macOS arm64 的运行库已随包提供（该脚本只为 Linux 下载 CUDA 文件）。
