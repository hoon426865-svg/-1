// Short-lived real-time log subscription, not a deployed/paid Tail Worker.
// Raw request headers, URLs, cookies, logs and exceptions never leave memory.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cloudflareToken,cloudflareBillingToken} from './cloudflare-session.mjs';
import {verifyFreeAccount} from './cloudflare-free-plan.mjs';
import {validateConfig,authenticationHash} from './cloudflare-config.mjs';
import {summarizeCpu} from './preview-cpu.mjs';
export function safeTailCpu(event,worker){
  const ray=event.event?.request?.headers?.['cf-ray']?.split('-')[0]?.toLowerCase();
  if(event.scriptName!==worker||!/^[a-f0-9]{16}$/.test(ray||'')||!Number.isFinite(event.cpuTime)||event.cpuTime<0)return null;
  const outcome=['ok','exceededCpu','exception','canceled','unknown','exceededMemory','scriptNotFound','responseStreamDisconnected'].includes(event.outcome)?event.outcome:'unknown';
  return {$metadata:{rayId:ray},$workers:{scriptName:worker,cpuTimeMs:event.cpuTime,outcome}};
}
export async function liveCheck(directory,configPath,sourceRoot){
  const root=resolve(directory);if(!root.startsWith(resolve('private')+'/'))throw Error('Private fixture required');
  const output=join(root,'live-cpu-results.json'),rawOutput=join(root,'live-cpu-events.json');
  if([output,rawOutput,join(root,'https-results.json')].some(existsSync))throw Error('Reports exist; preserve them and use a fresh fixture/DB');
  const c=JSON.parse(readFileSync(configPath||'wrangler.jsonc','utf8'));validateConfig(c,'preview');
  const worker=c.env.preview.name,hash=authenticationHash(sourceRoot);
  if(!worker.startsWith('onwork-preview-cpu-'))throw Error('Use an isolated synthetic CPU Worker, not the existing Windows passkey app');
  await verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:c.account_id,CLOUDFLARE_API_TOKEN:cloudflareBillingToken()});
  const base=`https://api.cloudflare.com/client/v4/accounts/${c.account_id}/workers/scripts/${worker}/tails`,headers={Authorization:'Bearer '+cloudflareToken(),'content-type':'application/json'};
  const response=await fetch(base,{method:'POST',headers,body:JSON.stringify({filters:[]}),signal:AbortSignal.timeout(20000)}),data=await response.json();
  if(!response.ok||!data.success)throw Error('Real-time CPU subscription failed (HTTP '+response.status+')');
  const events=[],pending=new Set();let received=0,dropped=0,streamInterrupted=false,ws,deleted=false;
  try{
    ws=new WebSocket(data.result.url,'trace-v1');
    ws.addEventListener('message',event=>{
      const task=(async()=>{try{const text=typeof event.data==='string'?event.data:await event.data.text();const safe=safeTailCpu(JSON.parse(text),worker);received++;if(safe)events.push(safe);else dropped++;}catch{dropped++;}})();pending.add(task);task.finally(()=>pending.delete(task));
    });
    await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('CPU stream connection timeout')),15000);ws.addEventListener('open',()=>{clearTimeout(timer);ok();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);fail(Error('CPU stream connection failed'));},{once:true});});
    ws.addEventListener('error',()=>{streamInterrupted=true;});ws.addEventListener('close',()=>{streamInterrupted=true;});
    ws.send(JSON.stringify({debug:false}));
    const args=process.argv;process.argv=[args[0],resolve('scripts/preview-check.mjs'),root,resolve(configPath||'wrangler.jsonc'),resolve(sourceRoot||'.')];
    try{await import('./preview-check.mjs?live='+Date.now());}finally{process.argv=args;}
    const run=JSON.parse(readFileSync(join(root,'https-results.json'),'utf8'));
    if(run.authHash!==hash||authenticationHash(sourceRoot)!==hash)throw Error('Authentication code changed during capture');
    // Await queued frames, bounded; missing metrics still fail closed.
    for(let attempt=0;attempt<10;attempt++){
      await new Promise(ok=>setTimeout(ok,1000));await Promise.all([...pending]);
      if(summarizeCpu(run,events).missing===0)break;
    }
    const result=summarizeCpu(run,events);result.source='Cloudflare real-time tail invocation CPU';result.streamInterrupted=streamInterrupted;
    if(streamInterrupted)result.cloudflareFreeCpuVerified=false;
    writeFileSync(rawOutput,JSON.stringify({received,dropped,events},null,2)+'\n',{flag:'wx',mode:0o600});
    writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result,null,2));
    return result;
  }finally{
    ws?.close();
    try{const r=await fetch(base+'/'+data.result.id,{method:'DELETE',headers,signal:AbortSignal.timeout(10000)});deleted=r.ok;}catch{}
    // Only subscription lifecycle metadata, never its URL or access credential.
    writeFileSync(join(root,'tail-cleanup.json'),JSON.stringify({deleted,expiresAt:data.result.expires_at})+'\n',{flag:'wx',mode:0o600});
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{const r=await liveCheck(process.argv[2],process.argv[3],process.argv[4]);process.exit(r.cloudflareFreeCpuVerified?0:1);}catch(error){console.error(error.message);process.exit(1);}
}
