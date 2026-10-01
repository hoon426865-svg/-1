import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {cloudflareToken} from './cloudflare-session.mjs';
import {verifyFreeAccount} from './cloudflare-free-plan.mjs';
import {validateConfig,authenticationHash} from './cloudflare-config.mjs';
// Persist only bounded CPU/outcome metadata; discard raw URLs, headers,
// cookies, log payloads and authentication responses returned by the API.
export function summarizeCpu(run,events){
  const rows=new Map();
  for(const event of events){
    let source=event.source;try{if(typeof source==='string')source=JSON.parse(source);}catch{continue;}
    const w=event.$workers||source?.$workers,meta=event.$metadata||source?.$cloudflare?.$metadata;
    if(!w||w.scriptName!==run.worker||!Number.isFinite(w.cpuTimeMs)||w.cpuTimeMs<0)continue;
    const ray=(meta?.rayId||'').split('-')[0].toLowerCase();if(ray)rows.set(ray,{cpuMs:w.cpuTimeMs,outcome:w.outcome});
  }
  const measured=run.samples.map(s=>{const cpu=rows.get(s.rayId?.toLowerCase());return {path:s.path.split('?')[0],method:s.method,status:s.status,...cpu};});
  const missing=measured.filter(s=>s.cpuMs===undefined).length,violations=measured.filter(s=>s.cpuMs>10||s.outcome!=='ok').length;
  const groups={};for(const s of measured){if(s.cpuMs===undefined)continue;const key=s.method+' '+s.path;(groups[key]??=[]).push(s.cpuMs);}
  const routes=Object.fromEntries(Object.entries(groups).map(([name,v])=>[name,{samples:v.length,averageMs:v.reduce((a,b)=>a+b,0)/v.length,maxMs:Math.max(...v)}]));
  const loginCount=groups['POST /api/passkeys/login/verify']?.length||0;
  return {source:'Cloudflare Workers Observability invocation CPU',authHash:run.authHash,from:run.from,to:run.to,expected:run.samples.length,measured:measured.length-missing,missing,violations,routes,cloudflareFreeCpuVerified:run.functionalVerified===true&&missing===0&&violations===0&&loginCount>=10,physicalBrowserVerified:run.physicalBrowserVerified===true};
}
export async function measure(directory){
  if(!resolve(directory).startsWith(resolve('private')+'/'))throw Error('Private preview fixture required');
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));validateConfig(config,'preview');
  const run=JSON.parse(readFileSync(join(directory,'https-results.json'),'utf8'));
  if(!run.synthetic||run.origin!==config.env.preview.vars.APP_ORIGIN||run.worker!==config.env.preview.name||run.authHash!==authenticationHash())throw Error('Preview target or verified auth code changed');
  const output=join(directory,'cpu-results.json');if(existsSync(output))throw Error('CPU report exists; preserve it and use a new output directory for another run');
  const token=cloudflareToken(),account=config.account_id||process.env.CLOUDFLARE_ACCOUNT_ID;
  await verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token});
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({queryId:randomUUID(),timeframe:{from:run.from,to:run.to},view:'events',limit:1000,filters:[{key:'$metadata.service',operation:'eq',type:'string',value:run.worker}]})});
  const data=await response.json();if(!response.ok||!data.success||!Array.isArray(data.result?.events?.events))throw Error('Actual CPU logs unavailable; check Workers observability/read permissions. Free verification remains incomplete.');
  const result=summarizeCpu(run,data.result.events.events);writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result,null,2));
  if(!result.cloudflareFreeCpuVerified)throw Error('Missing CPU samples, CPU limit violation, invocation error or incomplete functional checks. Do not deploy production.');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await measure(process.argv[2]);
