import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {cloudflareObservabilityToken,cloudflareBillingToken} from './cloudflare-session.mjs';
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
    const ray=(meta?.rayId||'').split('-')[0].toLowerCase();
    if(ray){
      const previous=rows.get(ray);
      // Duplicate telemetry must never hide a CPU overrun or failed invocation.
      rows.set(ray,{cpuMs:Math.max(previous?.cpuMs??0,w.cpuTimeMs),outcome:previous&&previous.outcome!=='ok'?previous.outcome:w.outcome});
    }
  }
  const measured=run.samples.map(s=>{const cpu=rows.get(s.rayId?.toLowerCase());return {path:s.path.split('?')[0],method:s.method,status:s.status,...cpu};});
  const missing=measured.filter(s=>s.cpuMs===undefined).length,violations=measured.filter(s=>s.cpuMs!==undefined&&(s.cpuMs>10||s.outcome!=='ok')).length;
  const groups={};for(const s of measured){if(s.cpuMs===undefined)continue;const key=s.method+' '+s.path;(groups[key]??=[]).push(s.cpuMs);}
  const routes=Object.fromEntries(Object.entries(groups).map(([name,v])=>[name,{samples:v.length,averageMs:v.reduce((a,b)=>a+b,0)/v.length,maxMs:Math.max(...v)}]));
  const loginCount=new Set(run.samples.filter(s=>s.path==='/api/passkeys/login/verify'&&s.method==='POST'&&s.status===200&&rows.get(s.rayId?.toLowerCase())?.outcome==='ok').map(s=>s.rayId.toLowerCase())).size;
  return {source:'Cloudflare Workers Observability invocation CPU',authHash:run.authHash,from:run.from,to:run.to,expected:run.samples.length,measured:measured.length-missing,missing,violations,routes,cloudflareFreeCpuVerified:run.functionalVerified===true&&missing===0&&violations===0&&loginCount>=10,physicalBrowserVerified:run.physicalBrowserVerified===true};
}
// Cursor pagination prevents a response-size limit from becoming a false CPU gap.
// Return only allowlisted invocation metadata, never the API's raw log payloads.
export async function queryCpuEvents({account,token,run,fetcher=fetch}){
  const events=[],seen=new Set();let offset,pages=0,total=0,abrLevel=1;
  for(;pages<20;pages++){
    const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({queryId:randomUUID(),timeframe:{from:run.from,to:run.to},view:'events',limit:1000,dry:true,...(offset?{offset,offsetDirection:'next'}:{}),parameters:{filterCombination:'and',filters:[{key:'$workers.scriptName',operation:'eq',type:'string',value:run.worker}]}})});
    const data=await response.json(),batch=data.result?.events?.events;
    if(!response.ok||!data.success||!Array.isArray(batch))throw Error(`Actual CPU logs unavailable (HTTP ${response.status}); verify permissions and response schema.`);
    total=Math.max(total,data.result.events.count||0);abrLevel=Math.max(abrLevel,data.result.statistics?.abr_level||1);
    for(const event of batch){
      const w=event.$workers,ray=event.$metadata?.rayId;
      if(w?.scriptName===run.worker&&typeof ray==='string'&&/^[a-f0-9]{16}(?:-[A-Z]+)?$/i.test(ray)&&Number.isFinite(w.cpuTimeMs)&&w.cpuTimeMs>=0){
        const outcome=['ok','exceededCpu','exception','canceled','exceededMemory','scriptNotFound','responseStreamDisconnected'].includes(w.outcome)?w.outcome:'unknown';
        events.push({$metadata:{rayId:ray},$workers:{scriptName:w.scriptName,cpuTimeMs:w.cpuTimeMs,outcome}});
      }
    }
    if(batch.length<1000)return {events,retrieval:{pages:pages+1,total,abrLevel}};
    const next=batch.at(-1)?.$metadata?.id;
    if(typeof next!=='string'||seen.has(next))throw Error('CPU log pagination did not advance; completeness unverified.');
    seen.add(next);offset=next;
  }
  throw Error('CPU log page budget reached; narrow the time range.');
}
export async function measure(directory,configPath='wrangler.jsonc'){
  if(!resolve(directory).startsWith(resolve('private')+'/'))throw Error('Private preview fixture required');
  const config=JSON.parse(readFileSync(configPath,'utf8'));validateConfig(config,'preview');
  const run=JSON.parse(readFileSync(join(directory,'https-results.json'),'utf8'));
  if(!run.synthetic||run.origin!==config.env.preview.vars.APP_ORIGIN||run.worker!==config.env.preview.name||run.authHash!==authenticationHash())throw Error('Preview target or verified auth code changed');
  const output=join(directory,'cpu-results.json');if(existsSync(output))throw Error('CPU report exists; preserve it and use a new output directory for another run');
  const token=cloudflareObservabilityToken(),account=config.account_id||process.env.CLOUDFLARE_ACCOUNT_ID;
  await verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:cloudflareBillingToken()});
  const queried=await queryCpuEvents({account,token,run}),events=queried.events;
  const persisted=summarizeCpu(run,events);let liveMeasured=0;
  const livePath=join(directory,'live-cpu-events.json'),liveSummaryPath=join(directory,'live-cpu-results.json');
  if(existsSync(livePath)&&existsSync(liveSummaryPath)){
    const live=JSON.parse(readFileSync(liveSummaryPath,'utf8'));
    if(live.authHash!==run.authHash||live.from!==run.from||live.to!==run.to)throw Error('Live CPU report belongs to a different run');
    const captured=JSON.parse(readFileSync(livePath,'utf8')).events;
    if(!Array.isArray(captured))throw Error('Invalid live CPU report');
    liveMeasured=summarizeCpu(run,captured).measured;events.push(...captured);
  }
  const result={...summarizeCpu(run,events),retrieval:queried.retrieval,persistedMeasured:persisted.measured,liveMeasured};
  if(liveMeasured)result.source='Cloudflare persisted and real-time invocation CPU, joined by Ray ID';
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result,null,2));
  if(!result.cloudflareFreeCpuVerified)throw Error('Missing CPU samples, CPU limit violation, invocation error or incomplete functional checks. Do not deploy production.');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await measure(process.argv[2],process.argv[3]);
