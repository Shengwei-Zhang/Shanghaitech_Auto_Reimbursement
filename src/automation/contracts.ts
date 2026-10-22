import type { Stage } from '../domain/job';

export const CONTRACTS: Record<Stage, { label: string; operation: string; success: string; recovery: string }> = {
  'authenticate': { label: '校园身份认证', operation: '打开学校认证页，等待用户登录；可选本次自动填写凭据', success: 'egate 登录标识及工作台内容可见', recovery: '检查网络、账号或人工完成验证码' },
  'open workbench': { label: '打开工作台', operation: '进入工作台并定位事项搜索框', success: '事项搜索框可操作', recovery: '检查登录状态与页面结构' },
  'select reimbursement form': { label: '确定单据创建方式', operation: '按任务选择新建，或检查最近单据后复用空单', success: '已确定本任务的新建或复用方式', recovery: '核对已有任务及单据，避免重复创建' },
  'create reimbursement form': { label: '打开报销入口', operation: '优先工作台入口；点击前失败时单次新开备用标签页', success: '已打开 BPM 入口；下一步创建用款申请单', recovery: '核对是否已创建，不自动再次创建' },
  'prepare reimbursement form': { label: '准备报销表单', operation: '点击用款申请单创建并确认，进入编辑页', success: '编辑页存在唯一且启用的经费选择按钮', recovery: '检查账套及页面类型' },
  'select funding item': { label: '选择经费项目', operation: '唯一匹配经费和预算，确认选择', success: '表单已显示选中的经费及预算关键词', recovery: '多个候选时人工补充关键词' },
  'attach invoice': { label: '关联电子发票', operation: '单次上传本次 PDF，等待上传结束，在默认票夹按号选择并确认', success: '发票号和票据总额与任务一致', recovery: '检查票夹，不自动重传' },
  'fill reimbursement details': { label: '填写报销详情', operation: '逐字段填写金额、附件数量、用途及说明', success: '逐字段回读一致，汇总由 OA 自行计算', recovery: '检查控件，没有强制改写只读金额' },
  'configure payment': { label: '配置收款信息', operation: '填写工号，等待银行卡回填，确认支付明细', success: '唯一支付行的工号与金额一致，支付总额匹配', recovery: '已有不匹配支付行时人工处理' },
  'save reimbursement': { label: '保存报销单', operation: '核对表单后单次点击保存', success: '保存操作已返回；持久化由下一阶段单独核验', recovery: '结果不确定时查单，不自动再次保存' },
  'verify saved form': { label: '核验保存结果', operation: '收到业务成功响应后刷新读取同一单据', success: '单据号、金额及已保存状态一致', recovery: '未配置回执时转人工核验' },
  'prepare submission': { label: '打开流转确认', operation: '点击 OA 提交入口；完全无请求及页面变化时最多尝试三次', success: '唯一流转确认窗口可见', recovery: '页面不确定时检查 OA，不重复点击' },
  'confirm submission': { label: '核对并最终提交', operation: '核对同一单据、表单及 OA 自动生成的审批路线，单次点击确定', success: '已点击最终确定、请求结束且弹窗关闭；仍须核验回执', recovery: '结果不明时停止并保留现场，禁止重复最终提交' },
  'verify submission': { label: '核验流转结果', operation: '最终确定后，按站点规则刷新读取流程状态', success: '同一单据及金额进入明确配置的提交状态', recovery: '缺少可靠回执时保留结果未知，不重复提交' },
};
