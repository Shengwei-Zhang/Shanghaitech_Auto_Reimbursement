import type { Page } from '@playwright/test';
import type { SiteProfile } from '../../src/domain/workflow';

export const profile: SiteProfile = {
  version: 1, saveResponse: { pathname: '/save', field: 'success', equals: true },
  receipt: { container: '#receipt', documentNumber: '.number', amount: '.amount', status: '.status',
    savedStatuses: ['已保存'], submittedStatuses: ['审批中'] },
};
export const inputs = { reimbursementPurpose: '科研耗材采购', reimbursementReason: '科研样本制备所需耗材', attachmentCount: '2', payeePersonCode: 'TEST01' };
export const number = '26117000000000000001';

interface InvoiceOptions {
  existingInvoice?: boolean; duplicateInvoice?: boolean; uploadFails?: boolean;
  invoiceUploadDelayMs?: number; invoiceProcessingDelayMs?: number; invoiceFolderDelayMs?: number;
  invoicePages?: number; wrongUploadedInvoice?: boolean; crossPageDuplicate?: boolean;
  fundingReadbackDelayMs?: number;
}
export async function installOaFixture(page: Page, options: InvoiceOptions & { saveOk?: boolean; wrongReceipt?: boolean; recorded?: boolean; loginPopup?: boolean; expireFirstCreate?: boolean; theme?: 'green' | 'orange'; missingSearchResult?: boolean; backupMenu?: boolean } = {}) {
  const state = { creationAttempts: 0, status: '草稿', amount: '', count: '', purpose: '', reason: '', person: '', payment: '', saves: 0, submits: 0,
    creates: 0, uploads: 0, uploadedSyntheticPdf: false, attached: !options.recorded, funded: !options.recorded, order: [] as string[] };
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    const html = (body: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    if (options.recorded && url.hostname === 'ids.shanghaitech.edu.cn') return html(options.loginPopup
      ? `<button onclick="window.open('https://egate-new.shanghaitech.edu.cn/${options.theme || 'green'}/index.html#/work')">模拟登录</button>`
      : `<script>location.replace("https://egate-new.shanghaitech.edu.cn/${options.theme || 'green'}/index.html#/work")</script>`);
    if (options.recorded && url.hostname === 'egate-new.shanghaitech.edu.cn') {
      if (url.pathname === '/shell') return html(`<input placeholder="请输入您想要的事项名称"><div class="search__dropdown" hidden><div>报销单审核 （电子签章）</div><div>报销单查询</div><div id="create"><span>报销单</span>创建 （电子签章）</div></div><script>
        document.querySelector('input').oninput=()=>document.querySelector('.search__dropdown').hidden=${options.missingSearchResult ? 'true' : 'false'};
        document.querySelector('#create').onclick=()=>window.open('https://sapbpm-new.shanghaitech.edu.cn/bpm-new/rbReimbursement/forwardAddRbReimbursement.do');</script>`);
      return html('<iframe src="/shell" style="width:1100px;height:800px"></iframe>');
    }
    if (url.hostname !== 'sapbpm-new.shanghaitech.edu.cn') return route.abort();
    if (options.recorded && (url.pathname.endsWith('/forwardAddRbReimbursement.do')
      || (options.backupMenu && state.creates === 0 && url.pathname.endsWith('/showLoadRbReimbursement.job')))) return html(`<h2>网上预约报销</h2>
      <a href="#">报销账套：上海科技大学<button>选择账套</button></a>
      <a href="#">境内差旅单 <button>创建</button></a><a href="#" id="application">用款申请单 <button>创建</button></a>
      <div class="ui_dialog" hidden id="createDialog">用款申请单<button id="ok">确定</button></div><script>
      document.querySelector('#application button').onclick=()=>document.querySelector('#createDialog').hidden=false;
      document.querySelector('#ok').onclick=async()=>{const response=await fetch('/create',{method:'POST'});if(response.status===401){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='登录超时，请重新登录！';document.body.append(alert);return;}location.href='/bpm-new/rbReimbursement/showLoadRbReimbursement.job';};</script>`);
    if (url.pathname === '/create') { state.creationAttempts++; if (options.expireFirstCreate && state.creationAttempts === 1) return route.fulfill({ status: 401, json: { success: false } }); state.creates++; state.order.push('create'); return route.fulfill({ json: { success: true } }); }
    if (url.pathname === '/invoice-upload') {
      state.uploads++; state.order.push('upload');
      // Raw PDF transport lets the synthetic server inspect every byte; browser
      // multipart requests may omit file payloads from Playwright's postDataBuffer.
      state.uploadedSyntheticPdf = route.request().method() === 'POST'
        && route.request().headers()['content-type'] === 'application/pdf'
        && Boolean(route.request().postDataBuffer()?.equals(Buffer.from('%PDF-1.4 synthetic upload fixture')));
      await new Promise(resolve => setTimeout(resolve, options.invoiceUploadDelayMs || 0));
      return route.fulfill({ status: state.uploadedSyntheticPdf ? 200 : 422,
        json: { success: state.uploadedSyntheticPdf && !options.uploadFails } });
    }
    if (url.pathname === '/event') {
      const event = route.request().postData() || '';
      state.order.push(event);
      if (event === 'upload') state.uploads++;
      if (event === 'attach') state.attached = true;
      if (event === 'funding') state.funded = true;
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === '/save') {
      state.saves++; state.order.push('save');
      if (options.saveOk !== false) { const payload = route.request().postDataJSON(); for (const key of ['amount', 'count', 'purpose', 'reason', 'person', 'payment'] as const) state[key] = payload[key]; state.status = '已保存'; }
      return route.fulfill({ json: { success: options.saveOk !== false } });
    }
    if (url.pathname === '/submit') { state.submits++; state.status = '审批中'; return route.fulfill({ json: { success: true } }); }
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<iframe title="OA业务" src="/form" style="margin:60px;width:1000px;height:900px"></iframe>' });
    if (url.pathname !== '/form' && !(options.recorded && url.pathname.endsWith('/showLoadRbReimbursement.job'))) return route.abort();
    const row = (id: string, vals: string[]) => `<tr class="l-grid-row">${vals.map((v, i) => `<td id="${id}|r1|c${i}" style="min-width:100px">${v}</td>`).join('')}</tr>`;
    const headers = (id: string, names: string[]) => `<tr>${names.map((n, i) => `<th class="l-grid-hd-cell" columnname="${n}" id="${id}|c${i}">${n}</th>`).join('')}</tr>`;
    const body = `<!doctype html><html><body><p>单据编号：A20260001</p>
      <button id="editReimburFundingItems">编辑经费</button><div id="rbReimbursementInvoiceButtons"><button>增值税发票/电子发票上传</button></div>
      <div id="invoiceGrid">${state.attached ? number : ''}</div><input id="actualTotalAmount" readonly value="${state.attached ? '120.10' : '0.00'}">
      <section id="rbReimburFundingItems"><span id="funding-label">${state.funded ? '项目A 材料费' : ''}</span><div class="xx-ui-grid" id="gridfund"><div class="l-grid2"><div class="l-grid-body" style="height:240px"><table>${headers('gridfund', ['amount', 'attachmentNumber', 'remark'])}${row('gridfund', [state.amount || '0.00', state.count || '0', state.purpose])}</table></div></div></div></section>
      <input id="reimbursementReimbursementAmount" readonly value="${state.amount}"><input id="reimbursementAttachmentNumber" readonly value="${state.count}"><input id="reimbursementRemark" value="${state.reason}">
      <button id="editReimbursementSettlement">添加支付类型</button>
      <div class="ui_dialog" id="paymentType" hidden>添加支付类型<label><input type="radio" name="paymentKind">个人银行卡</label><button id="ok">保存</button></div>
      <section id="rbReimbursementSettlement"><div class="ui-tab-item" id="bank" ${options.recorded && !state.person ? 'hidden' : ''}>个人银行卡</div><div id="layoutbank" ${options.recorded && !state.person ? 'hidden' : ''}><button id="addBank">添加</button>
      <div class="xx-ui-grid" id="gridpay"><table>${headers('gridpay', ['personCode', 'paymentAmount'])}<tbody id="payrows">${state.person ? row('gridpay', [state.person, state.payment]) : ''}</tbody></table></div></div></section>
      <input id="reimbursementSettlementAmount" readonly value="${state.payment}">
      <div class="ui_dialog" id="bankDialog" style="display:none">添加个人银行卡<input id="personCode"><input id="personName" readonly><input id="payeeCode" readonly><input id="paymentAmount"><button id="ok">保存</button></div>
      <div id="toolBar"><button id="save">保存</button><button id="advance">提交</button></div>
      <div class="ui_dialog" id="flowDialog" style="display:none">流转确认<div>流程审批规则：/网上预约报销审批</div><table><tr><th>环节</th><th>处理人</th><th>*发送消息</th><th>分组号</th></tr><tr><td rowspan="2">财务审核</td><td>合成审批人甲</td><td>是</td><td>60</td></tr><tr><td>合成审批人乙</td><td>否</td><td>60</td></tr></table><button id="finalConfirm">确定</button></div>
      <div id="receipt"><span class="number">${options.wrongReceipt ? 'A99999999' : 'A20260001'}</span><span class="amount">120.10</span><span class="status">${state.status}</span></div>
      <script>
      const $ = s => document.querySelector(s);
      const values = ${JSON.stringify(state)};
      $('#editReimbursementSettlement').onclick=()=>$('#paymentType').hidden=false;
      $('#paymentType #ok').onclick=()=>{if(!$('#paymentType input').checked)return;$('#bank').hidden=false;$('#layoutbank').hidden=false;$('#paymentType').hidden=true;};
      document.querySelectorAll('#gridfund .l-grid-row td').forEach((cell, index) => cell.onclick = () => {
        if (cell.querySelector('input')) return;
        const old = cell.textContent; cell.textContent = ''; const editor = document.createElement('input'); cell.append(editor); editor.value=old; editor.focus();
        const commit = () => { if(!editor.isConnected)return; values[['amount','count','purpose'][index]]=editor.value; cell.textContent=editor.value; $('#reimbursementReimbursementAmount').value=values.amount; $('#reimbursementAttachmentNumber').value=values.count; };
        editor.onblur = commit;
        editor.onkeydown = e => { if(e.key==='Enter') commit(); };
      });
      $('#addBank').onclick=()=>$('#bankDialog').style.display='block';
      $('#personCode').onblur=()=>{ $('#personName').value='合成测试人'; $('#payeeCode').value='TEST-ACCOUNT'; };
      $('#bankDialog #ok').onclick=()=>{values.person=$('#personCode').value;values.payment=$('#paymentAmount').value;$('#payrows').innerHTML='<tr class="l-grid-row"><td id="gridpay|r1|c0">'+values.person+'</td><td id="gridpay|r1|c1">'+values.payment+'</td></tr>';$('#reimbursementSettlementAmount').value=values.payment;$('#bankDialog').style.display='none';fetch('/event',{method:'POST',body:'payment'});};
      $('#save').onclick=async()=>{values.reason=$('#reimbursementRemark').value;await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});};
      $('#advance').onclick=()=>$('#flowDialog').style.display='block';
      $('#finalConfirm').onclick=async()=>{await fetch('/submit',{method:'POST'});$('#flowDialog').style.display='none';};
      </script>${options.recorded ? recordedDialogs(options) : ''}</body></html>`;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.goto('https://sapbpm-new.shanghaitech.edu.cn/fixture');
  await page.frameLocator('iframe').locator('#editReimburFundingItems').waitFor();
  return state;
}

function recordedDialogs(options: InvoiceOptions): string {
  return `<div id="fundWizard" hidden>
    <input id="fundingItemKind_text" readonly value="请选择"><div id="combox_droplist_wrap" hidden><ul><li>被授权的项目</li><li>我负责的项目</li></ul></div>
    <button id="chooseFundingItemsViewName">选择项目</button><table id="easySearchTableListData" hidden><tbody><tr><td>项目A</td></tr><tr><td>项目B</td></tr></tbody></table>
    <div id="chooseBudgetOutlaysGrid" hidden><table><tbody><tr class="l-grid-row"><td>材料费</td><td><input type="checkbox"></td></tr><tr class="l-grid-row"><td>差旅费</td></tr></tbody></table></div>
    <button id="ok">保存</button></div>
    <div id="invoicePicker" hidden><div class="vxe-grid--toolbar-wrapper"><button>点击或拖拽上传</button></div><input id="invoiceUpload" type="file" hidden>
    <div id="selfFolder" class="vxe-tree--node-item-inner is--current">自行上传票据</div>
    <div id="defaultFolder" class="vxe-tree--node-item-inner">表单默认票夹</div>
    <button id="searchInvoices">搜索</button><div class="vxe-loading" hidden>加载中</div>
    <div class="vxe-table"><div class="vxe-table--header-wrapper"><table><thead><tr><th class="col_select">选择</th><th class="col_invoice">发票号</th></tr></thead></table></div>
    <div class="vxe-table--body-wrapper"><table><tbody id="invoiceRows"></tbody></table><div class="vxe-table--empty-placeholder">暂无数据</div></div></div>
    <button class="vxe-pager--prev-btn">上一页</button><input class="vxe-pager--goto" value="1" readonly><button class="vxe-pager--next-btn">下一页</button><button id="ok">确定</button></div>
    <script>
    $('#editReimburFundingItems').onclick=()=>$('#fundWizard').hidden=false;
    $('#fundingItemKind_text').onclick=()=>$('#combox_droplist_wrap').hidden=false;
    document.querySelectorAll('#combox_droplist_wrap li').forEach(el=>el.onclick=()=>{$('#fundingItemKind_text').value=el.textContent;$('#combox_droplist_wrap').hidden=true;});
    $('#chooseFundingItemsViewName').onclick=()=>{$('#easySearchTableListData').hidden=false;};
    $('#easySearchTableListData td').onclick=()=>{$('#chooseBudgetOutlaysGrid').hidden=false;};
    $('#fundWizard #ok').onclick=async()=>{if(!$('#chooseBudgetOutlaysGrid input').checked) return;await fetch('/event',{method:'POST',body:'funding'});$('#fundWizard').hidden=true;setTimeout(()=>{$('#funding-label').textContent='项目A 材料费';},${options.fundingReadbackDelayMs || 0});};
    let uploaded=${Boolean(options.existingInvoice)};
    let invoiceFolder='self', invoicePage=0, uploading=false;
    const invoicePages=${options.invoicePages || 1};
    const invoiceRows=()=>{
      const target=uploaded && (invoicePage===invoicePages-1 || ${!!options.crossPageDuplicate});
      const id=${options.wrongUploadedInvoice ? "'26117000000000000009'" : JSON.stringify(number)};
      const values=invoiceFolder==='self'?['26117000000000000999']:(target?[id${options.duplicateInvoice ? ',id' : ''}]:(invoicePages>1?['26117000000000000'+String(100+invoicePage)]:[]));
      $('#invoiceRows').innerHTML=values.map((value,index)=>'<tr rowid="row-'+invoicePage+'-'+index+'"><td class="col_select"><span class="vxe-cell--checkbox"></span></td><td class="col_invoice">'+value+'</td></tr>').join('');
      $('.vxe-table--empty-placeholder').hidden=values.length>0;
      $('.vxe-pager--prev-btn').disabled=invoicePage===0;
      $('.vxe-pager--goto').value=String(invoicePage+1);
      $('.vxe-pager--next-btn').disabled=invoiceFolder==='self'||invoicePage===invoicePages-1;
      document.querySelectorAll('.vxe-cell--checkbox').forEach(el=>{el.textContent='选择';el.onclick=()=>el.classList.toggle('is--checked');});};
    $('#rbReimbursementInvoiceButtons button').onclick=()=>{$('#invoicePicker').hidden=false;invoiceRows();};
    const switchFolder=(name)=>{
      if(uploading)document.body.dataset.prematureSwitch='true';
      if(!$('#invoiceUpload').files.length)document.body.dataset.folderBeforeUpload='true';
      document.querySelectorAll('.vxe-tree--node-item-inner').forEach(el=>el.classList.remove('is--current'));
      $('.vxe-loading').hidden=false;
      setTimeout(()=>{invoiceFolder=name;invoicePage=0;$('#'+(name==='self'?'selfFolder':'defaultFolder')).classList.add('is--current');invoiceRows();$('.vxe-loading').hidden=true;},${options.invoiceFolderDelayMs || 0});
    };
    $('#selfFolder').onclick=()=>switchFolder('self');
    $('#defaultFolder').onclick=()=>switchFolder('default');
    $('#searchInvoices').onclick=()=>invoiceRows();
    $('.vxe-pager--next-btn').onclick=()=>{invoicePage++;invoiceRows();};
    $('.vxe-pager--prev-btn').onclick=()=>{invoicePage--;invoiceRows();};
    $('.vxe-grid--toolbar-wrapper button').onclick=()=>$('#invoiceUpload').click();
    $('#invoiceUpload').onchange=async()=>{
      uploading=true;
      const data=await $('#invoiceUpload').files[0].arrayBuffer();
      const response=await fetch('/invoice-upload',{method:'POST',headers:{'Content-Type':'application/pdf'},body:data});
      const result=await response.json();uploading=false;
      setTimeout(()=>{uploaded=response.ok && result.success;},${options.invoiceProcessingDelayMs || 0});
    };
    $('#invoicePicker #ok').onclick=async()=>{if(!$('.vxe-cell--checkbox.is--checked'))return;await fetch('/event',{method:'POST',body:'attach'});$('#invoiceGrid').textContent='${number}';$('#actualTotalAmount').value='120.10';$('#invoicePicker').hidden=true;};
    </script>`;
}
