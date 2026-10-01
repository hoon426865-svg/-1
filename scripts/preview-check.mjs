// Real HTTPS calls to the separate preview; software WebAuthn signatures.
// No authentication verifier is mocked. Browser/physical-device checks remain
// separate. Only metadata and CF Ray IDs are written to the private report.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createPrivateKey,randomUUID} from 'node:crypto';
import {ticket,authenticator} from '../tests/worker/virtual-authenticator.mjs';
import {collectPages} from '../public/worker-pages.js';
import {validateConfig,authenticationHash} from './cloudflare-config.mjs';
const directory=resolve(process.argv[2]||''),config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
if(!directory.startsWith(resolve('private')+'/'))throw Error('Private synthetic fixture required');
validateConfig(config,'preview');
if(existsSync(join(directory,'https-results.json')))throw Error('Preview report exists; preserve it and use a new synthetic fixture/DB for another run');
const fixture=JSON.parse(readFileSync(join(directory,'preview.json'),'utf8'));
assert.equal(fixture.synthetic,true);assert.equal(fixture.origin,config.env.preview.vars.APP_ORIGIN);assert.equal(fixture.siteId,config.env.preview.vars.SITE_ID);
const origin=fixture.origin,keys={privateKey:createPrivateKey(readFileSync(join(directory,'issuer.pem')))},samples=[],start=Date.now();let functionalVerified=false;globalThis.location={origin};
function client(){
  let cookie='',csrf='';
  const raw=async(path,body,expected=200)=>{
    const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json','x-csrf-token':csrf})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});
    samples.push({path,method:body===undefined?'GET':'POST',status:r.status,rayId:(r.headers.get('cf-ray')||'').split('-')[0]});
    const content=await r.text();assert.equal(r.status,expected,`Preview ${path} returned ${r.status}`);
    if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    return JSON.parse(content);
  };
  const call=async(path,body,expected)=>{const data=await raw(path,body,expected);return body===undefined?collectPages(path,data,p=>raw(p)):data;};
  return {call,async login(device){const o=await call('/api/passkeys/login/options',{});await call('/api/passkeys/login/verify',{challengeId:o.challengeId,response:device.login(o.options)});csrf=(await call('/api/me')).csrf;},async enroll(grant,device){const o=await call('/api/passkeys/enroll/options',{ticket:grant});await call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:o.challengeId,response:device.register(o.options)});},async proof(kind,details,device){const o=await call('/api/admin/passkeys/authorize/options',{operation:kind,details});return {challengeId:o.challengeId,response:device.login(o.options)};}};
}
try{
  const guest=client(),setup=await guest.call('/api/setup');assert.equal(setup.environment,'preview');assert.equal(setup.authMode,'passkey');
  const accounts=Object.fromEntries(fixture.accounts.map(a=>[a.login,a])),a=client(),e=client(),ad=authenticator(origin,accounts.ADMIN.id),ed=authenticator(origin,accounts['001'].id);
  await a.enroll(ticket(keys,accounts.ADMIN,origin),ad);await a.login(ad);await e.enroll(ticket(keys,accounts['001'],origin),ed);await e.login(ed);
  await e.call('/api/attendance',{action:'in'});await e.call('/api/attendance',{action:'out'});
  for(let i=0;i<10;i++){
    await e.login(ed);await e.call('/api/production',{taskId:'t1',good:1,bad:0,requestKey:randomUUID()});
    const r=await e.call('/api/work-requests',{type:'annual',startDate:`2026-11-${String(i+1).padStart(2,'0')}`,endDate:`2026-11-${String(i+1).padStart(2,'0')}`,allDay:true,reason:'가상 무료 CPU 검증'});
    await a.call('/api/admin/work-requests/decision',{id:r.id,version:r.version,action:'approved',comment:'가상 시험 승인'});
    for(const q of ['year=2026','year=2026&month=11'])assert.equal((await a.call('/api/admin/work-requests/report?'+q)).summaries.find(s=>s.id==='e1').absenceDates,i+1);
    await e.call('/api/state');await e.call('/api/admin/audit',undefined,403);
  }
  const details={number:'P-'+randomUUID().slice(0,8).toUpperCase(),name:'가상 신규 직원',team:'시험팀',reason:'preview 발급 시험'};
  const created=await a.call('/api/admin/employee',{...details,authorization:await a.proof('create',details,ad)});
  const own=(await a.call('/api/state')).employees.find(p=>p.id===created.id);
  const recover={id:own.id,version:own.version,reason:'가상 본인 확인 후 복구',identityConfirmed:true};
  const recovered=await a.call('/api/admin/passkeys/recover',{...recover,authorization:await a.proof('recover',recover,ad)});
  await guest.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket},401);
  // User handles are user IDs, not employee IDs. Obtain the registration
  // options' server-issued user ID rather than guessing or exposing DB rows.
  const o=await guest.call('/api/passkeys/enroll/options',{ticket:recovered.enrollmentTicket});
  const userId=Buffer.from(o.options.user.id,'base64url').toString(),newDevice=authenticator(origin,userId);
  await guest.call('/api/passkeys/enroll/verify',{ticket:recovered.enrollmentTicket,challengeId:o.challengeId,response:newDevice.register(o.options)});await guest.login(newDevice);
  await e.call('/api/logout',{});await e.call('/api/me',undefined,401);await e.login(ed);
  functionalVerified=true;
  console.log('Actual preview HTTPS login and business checks passed; CPU metrics still require the separate telemetry check.');
}finally{
  writeFileSync(join(directory,'https-results.json'),JSON.stringify({synthetic:true,origin,worker:config.env.preview.name,authHash:authenticationHash(),from:start-1000,to:Date.now()+1000,samples,functionalVerified,cloudflareFreeCpuVerified:false,physicalBrowserVerified:false},null,2)+'\n',{flag:'wx',mode:0o600});
}
