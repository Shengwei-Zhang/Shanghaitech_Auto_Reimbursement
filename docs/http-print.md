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

每一行有“打印”“添加附件”“下载”三个按钮；勾选多行后可用“打印所选”“下载所选”（一次最多 20 张）。

| 步骤 | 请求 | 关键参数 | 判定 |
| --- | --- | --- | --- |
| 打印状态 | `rbReimbursement/checkReimbursementPrintStatus.ajax` | `id`=bizId | `{"data":"ok","status":1}` |
| 水印 | `techPdf/queryWatermarkPathByBizIdOrTaskId.ajax` | `bizId` | `data` 为水印图片路径，如 `images/20190826094407.png` |
| 打印页 | `rbReimbursement/printRbReimbursement.load`（普通表单 POST，非 ajax） | `id`、`outputType=img`、`markImagePath`、`csrfToken` | HTML，每页一张内联 JPEG：报销单主图在前，电子发票每张一页，带页眉页脚和单号平铺水印 |

与 OA 的“打印”按钮相同，程序也调用 `checkReimbursementPrintStatus`，OA 可能借此记录已打印。

- **打印**：所选报销单的打印页合并为一个本机页面 `/print/<token>`，每张单从新的一页开始，在新窗口打开后自动弹出打印对话框。合并时只保留 OA 页面的 `<style>` 和图片区块，去掉脚本、事件属性和非 `data:` 图片；该页的 CSP 只允许内联图片、内联样式和本机 `print.js`。
- **下载**：同一页面在本机用无头 Chrome（禁用脚本、拒绝所有网络请求）渲染为 A4 PDF，文件名为单号，多张为“报销单-N张.pdf”。2026-10-21 实测一张含 4 张发票的单生成 6 页、约 1.9 MB，用时约 8 秒。
- 每个 `/print/<token>` 只能打开一次，10 分钟后失效，打开时校验本机会话 Cookie。
- **添加附件**：按钮已占位、暂不可用，待抓取 OA 的添加附件请求后接入。

## 本机接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/oa/print` | 最近 100 张“提交”状态的报销单：`{total, rows:[{bizId, billCode, kind, status, statusText, amount, remark, date, print}]}` |
| `GET /api/oa/print/permission?bizId=…` | 对上一步列出的单调用 OA 权限检查：`{bizId, allowed, message?}` |
| `POST /api/oa/print` `{bizIds, format?: 'html'\|'pdf'}` | 逐张取打印页并合并；只接受已列出且已通过检查的单；返回 `{url, bills, filename?}` |
