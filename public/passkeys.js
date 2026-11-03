import {reportAuthFailure} from './auth-diagnostics.js';
export async function passkeyLibrary(){
  if(!globalThis.SimpleWebAuthnBrowser)await new Promise((ok,no)=>{
    const script=document.createElement('script');let timer;
    const fail=()=>{clearTimeout(timer);script.remove();no(Object.assign(Error('패스키 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.'),{code:'LIBRARY_LOAD_FAILED'}));};
    timer=setTimeout(fail,15000);script.src='/vendor/passkeys.js';script.onload=()=>{clearTimeout(timer);globalThis.SimpleWebAuthnBrowser?ok():fail();};script.onerror=fail;document.head.append(script);
  });
  return globalThis.SimpleWebAuthnBrowser;
}
export async function authorizePasskeyOperation(api,operation,details){
  const lib=await passkeyLibrary(),options=await api('/api/admin/passkeys/authorize/options',{operation,details});
  return {challengeId:options.challengeId,response:await lib.startAuthentication({optionsJSON:options.options})};
}
export function showEnrollmentInvite(result){
  const dialog=document.createElement('dialog'),heading=document.createElement('h2'),info=document.createElement('p'),input=document.createElement('input'),close=document.createElement('button');
  heading.textContent='패스키 등록권';info.textContent=`${result.login} 직원의 본인을 확인한 뒤 등록권을 안전하게 전달하세요. 15분 후 만료되며 이 창을 닫으면 다시 표시하지 않습니다.`;
  input.type='text';input.readOnly=true;input.autocomplete='off';input.value=result.enrollmentTicket;input.setAttribute('aria-label','일회용 등록권');close.textContent='전달 완료 · 닫기';
  close.onclick=()=>dialog.close();dialog.onclose=()=>{input.value='';dialog.remove();};dialog.append(heading,info,input,close);document.body.append(dialog);dialog.showModal();input.select();
}
export function renderPasskeyLogin(screen,bindForm,api,load,onEnrolled){
  screen.innerHTML=`<section class="card auth-card"><h1>패스키 로그인</h1><p>계정을 입력하고 기기의 생체인증 또는 PIN으로 로그인하세요.</p><form id="passkey-login"><label>계정<input name="login" autocomplete="username" placeholder="관리자: ADMIN · 직원: 사번" pattern="[A-Za-z0-9-]{1,30}" maxlength="30" required></label><p role="status" aria-live="polite"></p><p role="alert" class="task-error"></p><button class="primary">패스키로 로그인</button></form><details><summary>기존 계정의 패스키 등록</summary><p>기존 비밀번호를 로컬에서 확인한 후 발급받은 일회성 등록권을 사용하세요. 등록 완료 후 패스키로 로그인 버튼을 눌러주세요.</p><form id="passkey-enroll"><label>등록권<input name="ticket" type="password" autocomplete="off" required></label><p role="status" aria-live="polite"></p><p role="alert" class="task-error"></p><button class="secondary">이 기기에 패스키 등록</button></form></details></section>`;
  const progress=(form,message)=>{form.querySelector('[role="status"]').textContent=message;};
  const failure=(stage,error,form)=>{
    if(stage.endsWith('-device')){
      const cancelled=error.name==='NotAllowedError'||error.code==='ERROR_PASSTHROUGH_SEE_CAUSE';
      error=Object.assign(Error(cancelled?'기기 확인이 취소되었거나 시간이 지났습니다. 패스키로 로그인을 다시 눌러주세요.':'기기에서 패스키 확인을 마치지 못했습니다. 같은 브라우저에서 다시 시도해주세요.'),{code:cancelled?'DEVICE_CANCELLED':'DEVICE_ERROR'});
    }
    reportAuthFailure(error.stage||stage,error);progress(form,'');
    if(error.requestId)error.message+=` (확인 번호: ${error.requestId})`;
    throw error;
  };
  bindForm('#passkey-login',async(body,form)=>{
    let stage='login-options';
    try{
      progress(form,'로그인 요청을 준비하고 있습니다.');
      const lib=await passkeyLibrary(),options=await api('/api/passkeys/login/options',{login:body.login.trim()});
      stage='login-device';progress(form,'Windows PIN 또는 생체인증을 완료해주세요.');
      const response=await lib.startAuthentication({optionsJSON:options.options});
      stage='login-verify';progress(form,'기기 확인이 끝났습니다. 서버에서 로그인을 확인하고 있습니다.');
      await api('/api/passkeys/login/verify',{challengeId:options.challengeId,response});
      stage='session-check';progress(form,'로그인이 확인되었습니다. 업무 화면을 불러오고 있습니다.');
      await load({afterLogin:true});
    }catch(error){failure(stage,error,form);}
  });
  bindForm('#passkey-enroll',async(body,form)=>{
    let stage='enroll-options';
    try{
      progress(form,'패스키 등록을 준비하고 있습니다.');
      const lib=await passkeyLibrary(),options=await api('/api/passkeys/enroll/options',{ticket:body.ticket});
      stage='enroll-device';progress(form,'Windows PIN 또는 생체인증으로 패스키를 등록해주세요.');
      const response=await lib.startRegistration({optionsJSON:options.options});
      stage='enroll-verify';progress(form,'기기 확인이 끝났습니다. 패스키 등록을 확인하고 있습니다.');
      const enrolled=await api('/api/passkeys/enroll/verify',{ticket:body.ticket,challengeId:options.challengeId,response});form.reset();
      onEnrolled(enrolled.login);
    }catch(error){failure(stage,error,form);}
  });
}
