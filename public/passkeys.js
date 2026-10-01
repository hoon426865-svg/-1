export async function passkeyLibrary(){
  if(!globalThis.SimpleWebAuthnBrowser)await new Promise((ok,no)=>{const script=document.createElement('script');script.src='/vendor/passkeys.js';script.onload=ok;script.onerror=no;document.head.append(script);});
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
export function renderPasskeyLogin(screen,bindForm,api,load){
  screen.innerHTML=`<section class="card auth-card"><h1>패스키 로그인</h1><p>기기의 생체인증 또는 PIN으로 로그인하세요.</p><form id="passkey-login"><p role="alert" class="task-error"></p><button class="primary">패스키로 로그인</button></form><details><summary>기존 계정의 패스키 등록</summary><p>기존 비밀번호를 로컬에서 확인한 후 발급받은 일회성 등록권을 사용하세요.</p><form id="passkey-enroll"><label>등록권<input name="ticket" type="password" autocomplete="off" required></label><p role="alert" class="task-error"></p><button class="secondary">이 기기에 패스키 등록</button></form></details></section>`;
  bindForm('#passkey-login',async()=>{
    const lib=await passkeyLibrary(),options=await api('/api/passkeys/login/options',{});
    const response=await lib.startAuthentication({optionsJSON:options.options});
    await api('/api/passkeys/login/verify',{challengeId:options.challengeId,response});await load();
  });
  bindForm('#passkey-enroll',async(body,form)=>{
    const lib=await passkeyLibrary(),options=await api('/api/passkeys/enroll/options',{ticket:body.ticket});
    const response=await lib.startRegistration({optionsJSON:options.options});
    await api('/api/passkeys/enroll/verify',{ticket:body.ticket,challengeId:options.challengeId,response});form.reset();await load();
  });
}
