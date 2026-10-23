# 报销单打印（`/print-list`，`src/automation/http-print.ts`）

从一键报销页面右上角的“报销单打印”在新标签页打开，沿用一键报销页面的学校登录；服务重启或未登录时提示先回一键报销页面登录。请求链来自 2026-10-21 在“报销单查询”页面上的浏览器抓包，以及该页脚本 `rbReimbursementOwnerQuery.js`、`rbReimbursementQueryCommonFun.js`。

## 列出需要打印的报销单

| 步骤 | 请求 | 关键参数 | 说明 |
| --- | --- | --- | --- |
| 列表 | `rbReimbursementQuery/slicedQueryOwnerReimbursement.ajax` | `queryStatusKind=1`、`page=1`、`pagesize=100`、`sortname=fillinDate`、`sortorder=desc` | 由 OA 按状态筛选，只返回状态“提交”的最近 100 张；包含所有报销类别（单号 A 用款申请单、D 境内差旅单、G 采购预付及报销单等） |
| 预检 | `rbReimbursement/testReimbursementPrintPermission.ajax` | `bizId` | 页面逐张调用；`{"data":{"success":true},"status":0}` 才列出 |

`queryStatusKind` 是查询表单“状态”勾选框的值：0 预制、1 提交、2 预收、3 接收、4 驳回、5 已完成、6 已中止，多个用逗号连接（2026-10-21 实测 `1` 只返回“提交”，`1,3` 返回“提交”和“接收”）。若 OA 返回了其他状态的行，程序丢弃它们。

OA 列表页的打印按钮规则（`checkPrintBtnStatus`）：状态 2、3、5 直接可打印；-1、0、4、6 不可打印；其余（1 提交）先调用权限检查。本页只要“提交”的单。2026-10-21 实测 49 张“提交”中 37 张允许打印，12 张返回“单据当前不允许打印，请等待审批节点到达财务联络人或财务审核岗时进行打印”。

## 打印与下载

每一行有“生成打印文件”和“添加附件”两个按钮；勾选多行后可用“生成所选打印文件”，以及合并成一份的“合并打印所选”“下载所选”（一次最多 20 张）。

**打印文件**：点“生成打印文件”后，服务在后台向 OA 取这张单的打印页并生成 PDF，该行显示“打印文件请求中…”（批量时其余显示“等待生成…”，同时生成 2 张）；完成后显示“报销文件已就绪”（不可点击），旁边的“打印”直接打开打印页并弹出打印对话框（点过后显示“已点击打印”，仍可再次打印；由服务按账号记在 `<OA_DATA_DIR>/print-marks`，刷新、重启服务、重新登录或文件过期后重新生成都保留，文件未就绪时该行在“生成打印文件”前显示“已点击打印”；浏览器无法得知打印对话框里点的是确认还是取消），“下载”保存 PDF。已就绪的文件在 30 分钟内可反复打印、下载，刷新页面后仍保持就绪；退出登录即删除。文件只在服务的内存中，每个浏览器最多保留 20 份。打印页在独立窗口（`noopener`）中打开，打印对话框不会冻结列表页，可以连续打印多张。整个服务同时最多渲染 2 份 PDF（每份启动一次无头 Chrome），其余排队。

| 步骤 | 请求 | 关键参数 | 判定 |
| --- | --- | --- | --- |
| 打印状态 | `rbReimbursement/checkReimbursementPrintStatus.ajax` | `id`=bizId | `{"data":"ok","status":1}` |
| 水印 | `techPdf/queryWatermarkPathByBizIdOrTaskId.ajax` | `bizId` | `data` 为水印图片路径，如 `images/20190826094407.png` |
| 打印页 | `rbReimbursement/printRbReimbursement.load`（普通表单 POST，非 ajax） | `id`、`outputType=img`、`markImagePath`、`csrfToken` | HTML，每页一张内联 JPEG：报销单主图在前，电子发票每张一页，带页眉页脚和单号平铺水印 |

与 OA 的“打印”按钮相同，程序也调用 `checkReimbursementPrintStatus`，OA 可能借此记录已打印。

- **打印**：所选报销单的打印页合并为一个本机页面 `/print/<token>`，每张单从新的一页开始，在新窗口打开后自动弹出打印对话框。合并时只保留 OA 页面的 `<style>` 和图片区块，去掉脚本、事件属性和非 `data:` 图片；该页的 CSP 只允许内联图片、内联样式和本机 `print.js`。
- **下载**：同一页面在本机用无头 Chrome（禁用脚本、拒绝所有网络请求）渲染为 A4 PDF，文件名为单号，多张为“报销单-N张.pdf”。2026-10-21 实测一张含 4 张发票的单生成 6 页、约 1.9 MB，用时约 8 秒。
- 每个 `/print/<token>`（合并打印、下载所选）只能打开一次，10 分钟后失效；打印文件的 `/print/ready/<token>`（打印页）和 `/print/ready/<token>.pdf`（PDF，加 `?download=1` 为下载）在有效期内可反复打开。都校验本机会话 Cookie。
- **添加附件**：按钮已占位、暂不可用，待抓取 OA 的添加附件请求后接入。

## 本机接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/oa/print` | 最近 100 张“提交”状态的报销单：`{total, rows:[{bizId, billCode, kind, status, statusText, amount, remark, date, print}]}` |
| `GET /api/oa/print/permission?bizId=…` | 对上一步列出的单调用 OA 权限检查：`{bizId, allowed, message?}` |
| `POST /api/oa/print` `{bizIds, format?: 'html'\|'pdf'}` | 逐张取打印页并合并；只接受已列出且已通过检查的单；返回 `{url, bills, filename?}` |
| `POST /api/oa/print/file` `{bizId}` | 生成一张单的打印文件（打印页和 PDF），已就绪的直接返回：`{bizId, billCode, printUrl, pdfUrl, filename, expiresAt}` |
| `GET /api/oa/print/files` | 仍就绪的打印文件：`{files:[…]}` |
