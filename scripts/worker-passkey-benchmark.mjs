import {fixture,origin} from '../tests/worker/helpers.mjs';
import {issuer,ticket,authenticator} from '../tests/worker/virtual-authenticator.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk}),samples={};
try{
  const pid=execFileSync('ps',['-C','workerd','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number)).find(([,parent])=>parent===process.pid)?.[0];
  if(!pid)throw Error('Local workerd process CPU counter unavailable');
  const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
  const ticks=()=>{const v=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');return Number(v[11])+Number(v[12]);};
  const measure=async(name,fn)=>{const start=ticks(),r=await fn(),elapsed=(ticks()-start)*1000/hz;(samples[name]??=[]).push(elapsed);if(r.status!==200)throw Error(name+' failed with '+r.status);return r;};
  const c=f.client(),account=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first(),device=authenticator(origin,account.id),grant=ticket(keys,account,origin);
  const registration=(await measure('enrollment_options',()=>c.call('/api/passkeys/enroll/options',{ticket:grant}))).data;
  await measure('enrollment_verify',()=>c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:registration.challengeId,response:device.register(registration.options)}));
  for(let i=0;i<10;i++){
    const options=(await measure('login_options',()=>c.call('/api/passkeys/login/options',{}))).data;
    await measure('login_verify',()=>c.call('/api/passkeys/login/verify',{challengeId:options.challengeId,response:device.login(options.options)}));
    const me=(await measure('me',()=>c.call('/api/me'))).data,headers={'x-csrf-token':me.csrf};
    await measure('state',()=>c.call('/api/state'));
    await measure('production',()=>c.call('/api/production',{taskId:'t1',good:1,bad:0,requestKey:randomUUID()},'POST',headers));
    await measure('work_request',()=>c.call('/api/work-requests',{type:'annual',startDate:`2026-11-${String(i+1).padStart(2,'0')}`,endDate:`2026-11-${String(i+1).padStart(2,'0')}`,allDay:true,reason:'CPU test'},'POST',headers));
  }
  const report={runtime:'workerd',syntheticAuthenticator:true,freeCpuLimitMs:10,clockResolutionMs:1000/hz,localProcessCpu:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,{samples:values.length,averageMs:values.reduce((a,b)=>a+b,0)/values.length,maxMs:Math.max(...values)}])),cloudflareFreeCpuVerified:false,note:'Local workerd process CPU includes local D1 work and uses coarse process counters. These are not Cloudflare per-invocation CPU metrics. Physical browser passkey and Free preview verification are separate checks.'};
  mkdirSync('dist',{recursive:true});writeFileSync('dist/passkey-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await f.close();}
