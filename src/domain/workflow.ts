import { AppError, object } from './job';

export type CompletionAction = 'save' | 'submit';
export interface WriteResponseRule { pathname: string; field: string; equals: string | boolean | number }
export interface SiteProfile {
  version: 1;
  saveResponse: WriteResponseRule;
  receipt: {
    container: string;
    documentNumber: string;
    amount: string;
    status: string;
    savedStatuses: string[];
    submittedStatuses: string[];
  };
}
export interface Receipt {
  documentNumber: string;
  amount: string;
  status: string;
  verifiedAt: string;
  /** oa_owner_list: 报销单查询 read over HTTP after the API submission. */
  source: 'reloaded_oa_page' | 'oa_owner_list';
}
export interface WorkflowResult {
  documentNumber: string;
  amount: string;
  action?: CompletionAction;
  receipt?: Receipt;
  verification?: 'unverified' | 'user_confirmed' | 'receipt';
}

export const FAILURE_MESSAGES = {
  resume_page_ambiguous: ['发现多个可用于续跑的 OA 标签页，无法确定原单所在页面。', '核对原单并保留唯一目标页面后再继续；程序不会猜选第一个标签或新建单据。'],
  resume_page_missing: ['未找到可用于续跑的 OA 页面，或该页面已关闭、跳转。', '重新打开原单并核对单号后再继续；程序不会退回新建报销流程。'],
  editor_entry_unavailable: ['创建确认后，报销编辑页的经费选择入口未就绪。', '查看经费入口检测记录，核对现有单据；不会重新创建。尚未选择经费、上传发票或提交。'],
  invoice_selection_unconfirmed: ['已按发票号找到目标发票，但勾选后的选中状态未确认，尚未点击票夹确定。', '检查目标行的复选框是否选中及 OA 提示；不会重复上传或反复点击勾选。'],
  invoice_selection_disabled: ['已找到目标发票，但其复选框不可选择。', '检查发票是否已被其他单据占用或 OA 限制；尚未点击票夹确定。'],
  submission_route_unverified: ['流转确认的审批规则、处理人或必填选项尚未通过核验，未点击最终确定。', '核对 OA 自动生成的审批路线及未选项；程序不会猜选审批人。'],
  funding_commit_unverified: ['无法确认经费表格中可点击的空白区域，尚未完成单元格提交。', '保留当前编辑值供核对；不会点击其他行、删除按钮或重复填写来跳过校验。'],
  funding_editor_missing: ['经费单元格已定位，但未出现可编辑输入框。', '查看最后一条进度确定具体列；不会把内容填入其他焦点控件。'],
  funding_cell_mismatch: ['经费单元格输入后，失焦回读仍与任务不一致。', '查看最后一条进度确定具体列；核对该列输入及 OA 校验提示，尚未保存主单。'],
  payment_rows_ambiguous: ['个人银行卡付款数据表或付款记录数量不唯一。', '核对个人银行卡页签及任务中的数据行数量；不会删除付款记录或重复添加，尚未保存主报销单。'],
  payment_payee_unconfirmed: ['收款人工号或 OA 回填的银行卡信息尚未通过核验。', '核对个人银行卡弹窗中的工号、姓名和账号；尚未保存付款行。'],
  payment_amount_input_failed: ['支付金额控件未接受输入，或失焦后仍为零、空值或不完整金额。', '核对个人银行卡弹窗的支付金额；尚未点击保存，不会重复输入或改写只读字段。'],
  payment_amount_mismatch: ['个人银行卡弹窗中的支付金额与实报金额不一致。', '金额已按整数分比较，忽略正常千分位及小数位格式差异；尚未保存付款行，请核对显示金额。'],
  invoice_number_column_missing: ['未能定位票夹表格的“发票号”列。', '检查横向滚动后的表头；不会以备注、其他数字或行号替代发票号选择。'],
  invoice_row_identity_missing: ['已找到发票号，但无法确认对应行的稳定标识。', '请核对目标行；横向滚动后不会按第一行或旧位置猜选复选框。'],
  invoice_file_mismatch: ['OA 文件选择器中的文件与本次任务的 PDF 不一致。', '已停止后续关联；请核对上传结果。本次不会再次选择或上传文件。'],
  workbench_search_pending: ['搜索框探测超时，部分页面框架未响应。', '尚未执行搜索输入。核对工作台加载状态与任务内的框架探测记录。'],
  workbench_search_blocked: ['已找到搜索框，但实际点击未成功。', '检查加载遮罩、弹窗或页面跳转；不会把点击受阻误报为没有搜索框，也不会自动另建单据。'],
  workbench_search_input_failed: ['已点击搜索框，但输入或回读“报销单”失败。', '检查搜索框是否被页面重置或替换；尚未点击创建入口。'],
  funding_project_mismatch: ['等待回填后，主表单经费项目仍未匹配任务；预算科目已匹配。', '核对“选择经费项目”保存后主表单显示的项目与任务经费关键词。尚未进入发票或付款操作。'],
  funding_budget_mismatch: ['等待回填后，主表单预算科目仍未匹配任务；经费项目已匹配。', '核对主表单的支出项目与任务预算关键词。尚未进入发票或付款操作。'],
  funding_choice_mismatch: ['等待回填后，主表单经费项目和预算科目均未匹配任务。', '核对经费选择是否保存成功、主表单是否已更新，以及经费与预算关键词。尚未进入发票或付款操作。'],
  invoice_upload_failed: ['发票文件上传请求失败。', '检查 OA 上传提示及票夹是否已有该发票；不会自动重传。'],
  invoice_upload_pending: ['尚未确认发票文件上传结束。', '请等待或核对 OA 上传状态；本次不会重复上传，也不会提前勾选发票。'],
  invoice_folder_unconfirmed: ['尚未确认切换到指定票夹。', '检查左侧票夹的选中状态；不会使用切换前的列表判断发票不存在。'],
  invoice_processing_pending: ['上传请求已结束，但默认票夹尚未出现唯一匹配的发票。', '请按本次发票号核对 OA 处理结果；不会重复上传或选择列表第一张发票。'],
  invoice_already_claimed: ['OA 票夹显示该发票已报销，不能再关联到本单。', '请核对此前报销该发票的单据；本次未勾选发票、未保存主单，也不会重复上传。'],
  invoice_claim_in_progress: ['OA 票夹显示该发票正在其他报销单中（报销中）。', '请先在 OA 处理原单据（撤回或删除发票）；本次未勾选发票、未保存主单。'],
  invoice_pagination_unchecked: ['票夹分页未能完成核查。', '请在现有票夹核对目标发票；程序已停止，未重复上传，也不会重新创建报销单。'],
  entry_result_unknown: ['已经尝试打开或创建报销单，结果需要核对。', '检查现有 OA 标签页，不自动打开备用入口或再次创建。'],
  backup_entry_unavailable: ['备用入口未显示可核验的用款申请单创建入口。', '检查保留的浏览器页面及 BPM 登录状态；本次备用跳转不会自动重试。'],
  backup_form_review: ['备用地址打开了报销编辑页，尚不能确认是新单还是已有单据。', '请核对该页单据号及内容；自动填写已暂停，不把页面跳转当作新建成功。'],
  workbench_search_error: ['读取工作台搜索框时发生定位器错误。', '需检查浏览器适配器或定位表达式；这与搜索框不存在不同。'],
  workbench_navigation: ['未能完成工作台导航。', '检查校园网络及认证跳转是否完成。'],
  workbench_closed: ['工作台页面已关闭。', '检查是否手动关闭了本次任务的浏览器。'],
  workbench_search_missing: ['工作台事项搜索框未在等待时间内变为可操作。', '核对 OA 页面是否显示“请输入您想要的事项名称”，以及是否有遮挡或登录提示。'],
  workbench_search_ambiguous: ['工作台出现多个可操作的事项搜索框。', '需要核对当前页面结构，程序不会随意选择一个搜索框。'],
  configuration: ['提交站点配置不完整。', '先校准保存响应及回执字段；未配置时仅能人工核验。'],
  authentication: ['校园登录未完成或登录已失效。', '检查校园网络、账号及验证码，再核对现有单据。'],
  ambiguous_choice: ['页面存在多个匹配选项，无法唯一选择。', '补充项目或预算关键词，人工核实具体选项。'],
  control_missing: ['所需控件未出现或页面结构已变化。', '核对当前 OA 页面和阶段，调整对应定位器。'],
  value_mismatch: ['页面回读值与任务内容不一致。', '核对发票、金额、附件数量、用途及收款人；不会通过改写只读字段跳过校验。'],
  save_unverified: ['已尝试保存，但没有取得可靠保存回执。', '请在 OA 核对单据，不要直接重新执行保存。'],
  submission_unknown: ['已尝试提交，但无法确认最终结果。', '先在 OA 查询该单据的流程状态；禁止自动再次提交。'],
  submission_rejected: ['提交后未进入配置的目标流程状态。', '检查 OA 校验提示及流转要求，处理后人工核对。'],
  http_fill_rejected: ['接口填写在写入 OA 之前停止。', '本单未被修改；按上一条记录的原因处理后可重新执行。'],
  http_fill_partial: ['接口填写中途停止，本单已有部分内容写入 OA。', '请按上一条记录的步骤在 OA 核对本单（经费、发票、付款行），不要直接重新执行。'],
  http_submit_blocked: ['本单已由接口保存，但提交前的回读核对未通过，未发送提交请求。', '按上一条记录的原因在 OA 核对本单；单据仍为预制状态，可在 OA 中手动提交。'],
  http_submit_rejected: ['OA 拒绝了接口提交，本单仍为预制状态。', '按上一条记录中的 OA 提示处理后，在 OA 中手动提交；程序不会自动重试。'],
  unexpected: ['真实 OA 执行发生异常。', '根据最后完成阶段核对现有单据，再决定后续操作。'],
} as const;
export type FailureCode = keyof typeof FAILURE_MESSAGES;
export interface Failure { code: FailureCode; message: string; recovery: string; uncertain: boolean }
export class FlowError extends Error {
  constructor(readonly code: FailureCode, options?: ErrorOptions) { super(FAILURE_MESSAGES[code][0], options); }
}
export function failureOf(error: unknown): Failure {
  const text = error instanceof Error ? error.message : '';
  const code: FailureCode = error instanceof FlowError ? error.code
    : /login|登录|authserver|credential/i.test(text) ? 'authentication'
    : /exactly one|matched \d|unique/i.test(text) ? 'ambiguous_choice'
    : /expected invoice|amount|金额|totals do not match/i.test(text) ? 'value_mismatch'
    : /Timeout|selector|visible|locator|owner query|报销单查询|Only \d+ reimbursement form/i.test(text) ? 'control_missing' : 'unexpected';
  return failureByCode(code);
}
export function failureByCode(code: FailureCode): Failure {
  const [message, recovery] = FAILURE_MESSAGES[code];
  return { code, message, recovery, uncertain: code === 'save_unverified' || code === 'submission_unknown' || code === 'http_fill_partial' };
}

export function parseSiteProfile(value: unknown): SiteProfile {
  const data = object(value), receipt = object(data.receipt);
  const string = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 300 || /TODO|待填写|待校准/i.test(value)) {
      throw new AppError(400, 'OA 站点配置存在未校准的按钮或字段。');
    }
    return value.trim();
  };
  const statuses = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new AppError(400, '必须配置明确的保存和提交状态。');
    return value.map(string);
  };
  const responseRule = (value: unknown): WriteResponseRule => {
    const rule = object(value);
    const pathname = string(rule.pathname), field = string(rule.field);
    if (!/^\/[\w/.-]+$/.test(pathname) || !/^[\w]+(?:\.[\w]+)*$/.test(field)
      || !['string', 'boolean', 'number'].includes(typeof rule.equals)) throw new AppError(400, '必须配置精确的写入响应路径与业务成功字段。');
    return { pathname, field, equals: rule.equals as string | boolean | number };
  };
  if (data.version !== 1) throw new AppError(400, '不支持该站点配置版本。');
  const parsed: SiteProfile = { version: 1, saveResponse: responseRule(data.saveResponse), receipt: {
    container: string(receipt.container), documentNumber: string(receipt.documentNumber),
    amount: string(receipt.amount), status: string(receipt.status),
    savedStatuses: statuses(receipt.savedStatuses), submittedStatuses: statuses(receipt.submittedStatuses),
  } };
  if (parsed.receipt.savedStatuses.some(status => parsed.receipt.submittedStatuses.includes(status))) {
    throw new AppError(400, '保存状态与提交状态不能重叠。');
  }
  return parsed;
}
