import {captureDrafts,restoreDrafts,acceptForm} from './drafts.js';
import {authorizePasskeyOperation,showEnrollmentInvite} from './passkeys.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reasonField='<label>발급 사유<textarea name="reason" maxlength="500" required></textarea></label>';
const confirmation='<label class="ops-check"><input type="checkbox" name="adminRightsConfirmed" required> 이 계정에 온워크 전체 관리자 권한을 부여하는 것을 확인했습니다.</label>';

export function mountAdminAccounts({root,api,me}){
  let accounts=[],serial=0,busy=false,message='';
  function draw(){
    if(!root.isConnected||busy)return;
    const drafts=captureDrafts(root);
    root.innerHTML=`<section class="card admin-accounts-panel"><h2>관리자 계정</h2>
      <p>관리자마다 별도 계정을 만들면 승인·수정 이력에 각자의 로그인 계정이 남습니다. 등록권 발급 시 현재 관리자의 패스키로 본인 확인합니다.</p>
      <form id="admin-account-create" class="employee-form">
        <label>새 관리자 로그인 계정<input name="login" placeholder="예: MGR-01" pattern="[A-Za-z0-9-]{1,30}" maxlength="30" autocomplete="off" required></label>
        ${reasonField}${confirmation}<button class="primary">관리자 추가 · 등록권 발급</button><p role="alert" class="task-error"></p>
      </form>
      <p class="small">다른 관리자는 자신의 PC에서 온워크 로그인 화면 → 패스키 등록 · 등록권 입력으로 등록합니다. 기존 관리자 비밀번호는 필요하지 않습니다.</p>
      <div class="ops-toolbar"><h3>등록된 관리자</h3><button type="button" class="secondary" data-admin-reload>목록 새로고침</button></div>
      <div data-admin-accounts>${accounts.map(a=>`<article class="ops-row"><div><strong>${esc(a.login)}${a.id===me.id?' (내 계정)':''}</strong><p>${a.mustChange?'등록 대기':a.passkeyCount?'등록 완료':'패스키 등록 확인 필요'} · 패스키 ${esc(a.passkeyCount)}개</p></div>${a.canReissue?`<form id="admin-reinvite-${esc(a.id)}" class="employee-form admin-invite-reissue" data-id="${esc(a.id)}"><p>${esc(a.login)} 계정의 이전 미사용 등록권을 취소하고 새 등록권을 발급합니다.</p>${reasonField}${confirmation}<button class="secondary">등록권 다시 발급</button><p role="alert" class="task-error"></p></form>`:''}</article>`).join('')}</div>
      <p data-admin-message role="status">${esc(message)}</p><p data-admin-error role="alert" class="task-error"></p></section>`;
    restoreDrafts(root,drafts);
    root.querySelector('[data-admin-reload]').onclick=refresh;
    root.querySelectorAll('form').forEach(form=>form.onsubmit=event=>{
      event.preventDefault();if(busy)return;
      const values=Object.fromEntries(new FormData(form)),reissue=form.classList.contains('admin-invite-reissue');
      const details={...(reissue?{id:form.dataset.id}:{login:values.login.trim().toUpperCase()}),reason:values.reason,adminRightsConfirmed:values.adminRightsConfirmed==='on'};
      submit(form,reissue,details);
    });
  }
  async function submit(form,reissue,details){
    busy=true;const buttons=[...root.querySelectorAll('button')],error=form.querySelector('[role="alert"]');
    buttons.forEach(button=>button.disabled=true);error.textContent='';
    root.querySelector('[data-admin-message]').textContent='현재 관리자의 패스키로 본인 확인을 진행합니다.';
    try{
      const authorization=await authorizePasskeyOperation(api,reissue?'reinvite-admin':'create-admin',details);
      if(!root.isConnected)return;
      const result=await api('/api/admin/accounts'+(reissue?'/reissue':''),{...details,authorization});
      if(!root.isConnected)return;
      form.reset();acceptForm(form);message=`${result.login} 계정의 등록권을 발급했습니다.`;
      // The one-time secret must remain available even if the subsequent list refresh fails.
      showEnrollmentInvite(result);busy=false;await refresh();
    }catch(failure){
      if(form.isConnected)error.textContent=failure.name==='NotAllowedError'||failure.code==='ERROR_PASSTHROUGH_SEE_CAUSE'?'패스키 확인이 취소되었거나 시간이 지났습니다. 입력 내용을 확인하고 다시 발급하세요.':failure.message;
    }finally{
      busy=false;buttons.forEach(button=>button.disabled=false);
      if(root.isConnected)root.querySelector('[data-admin-message]').textContent=message;
    }
  }
  async function refresh(){
    if(busy||!root.isConnected)return;const current=++serial;
    try{
      const data=await api('/api/admin/accounts');
      if(current!==serial||!root.isConnected||busy)return;
      accounts=data.accounts;draw();
    }catch(error){
      if(current!==serial||!root.isConnected)return;
      root.querySelector('[data-admin-error]').textContent=error.message;
    }
  }
  draw();refresh();return {refresh};
}
