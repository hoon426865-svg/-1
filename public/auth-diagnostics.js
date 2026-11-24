// Only fixed categories and server-generated correlation IDs leave the browser.
const stages=new Set(['login-options','login-device','login-verify','session-check','state-load','screen-render','enroll-options','enroll-device','enroll-verify','client-runtime']);
const codes=new Set(['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE','HTTP_ERROR','SESSION_NOT_STORED','CLIENT_RUNTIME_ERROR','DEVICE_CANCELLED','DEVICE_ERROR','LIBRARY_LOAD_FAILED']);
let reports=0;
export function reportAuthFailure(stage,error){
  if(!stages.has(stage)||reports>=10)return;
  const code=codes.has(error?.code)?error.code:'CLIENT_RUNTIME_ERROR';
  const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:0;
  const requestId=/^[a-f0-9-]{36}$/.test(error?.requestId||'')?error.requestId:undefined;
  reports++;
  fetch('/api/auth/diagnostics',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage,code,status,requestId}),signal:AbortSignal.timeout(5000)}).catch(()=>{});
}
