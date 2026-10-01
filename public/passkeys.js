export function renderPasskeyLogin(screen,bindForm,api,load){
  screen.innerHTML=`<section class="card auth-card"><h1>패스키 로그인</h1><p>기기의 생체인증 또는 PIN으로 로그인하세요.</p><form id="passkey-login"><p role="alert" class="task-error"></p><button class="primary">패스키로 로그인</button></form><details><summary>기존 계정의 패스키 등록</summary><p>기존 비밀번호를 로컬에서 확인한 후 발급받은 일회성 등록권을 사용하세요.</p><form id="passkey-enroll"><label>등록권<input name="ticket" type="password" autocomplete="off" required></label><p role="alert" class="task-error"></p><button class="secondary">이 기기에 패스키 등록</button></form></details></section>`;
  const library=async()=>{
    if(!globalThis.SimpleWebAuthnBrowser)await new Promise((ok,no)=>{const script=document.createElement('script');script.src='/vendor/passkeys.js';script.onload=ok;script.onerror=no;document.head.append(script);});
    return globalThis.SimpleWebAuthnBrowser;
  };
  bindForm('#passkey-login',async()=>{
    const lib=await library(),options=await api('/api/passkeys/login/options',{});
    const response=await lib.startAuthentication({optionsJSON:options.options});
    await api('/api/passkeys/login/verify',{challengeId:options.challengeId,response});await load();
  });
  bindForm('#passkey-enroll',async(body,form)=>{
    const lib=await library(),options=await api('/api/passkeys/enroll/options',{ticket:body.ticket});
    const response=await lib.startRegistration({optionsJSON:options.options});
    await api('/api/passkeys/enroll/verify',{ticket:body.ticket,challengeId:options.challengeId,response});form.reset();await load();
  });
}
