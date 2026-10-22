import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCpu} from '../../scripts/preview-cpu.mjs';
const run={functionalVerified:true,worker:'onwork-preview',samples:Array.from({length:10},(_,i)=>({path:'/api/passkeys/login/verify',method:'POST',status:200,rayId:String(i)}))};
const events=()=>run.samples.map(s=>({$metadata:{rayId:s.rayId},source:{$workers:{scriptName:run.worker,cpuTimeMs:3,outcome:'ok'},headers:{cookie:'do-not-persist'}}}));
test('실제 CPU 판정은 모든 Ray ID의 CPU·정상 outcome·반복 로그인·기능 성공을 요구하며 비밀정보를 제거한다',()=>{
  const valid=summarizeCpu(run,events());assert.equal(valid.cloudflareFreeCpuVerified,true);assert.ok(!JSON.stringify(valid).includes('do-not-persist'));
  assert.equal(summarizeCpu(run,events().slice(1)).cloudflareFreeCpuVerified,false);
  const over=events();over[0].source.$workers.cpuTimeMs=11;assert.equal(summarizeCpu(run,over).cloudflareFreeCpuVerified,false);
  const failed=events();failed[0].source.$workers.outcome='exceededCpu';assert.equal(summarizeCpu(run,failed).cloudflareFreeCpuVerified,false);
  const other=events();other[0].source.$workers.scriptName='onwork';assert.equal(summarizeCpu(run,other).cloudflareFreeCpuVerified,false);
  assert.equal(summarizeCpu({...run,functionalVerified:false},events()).cloudflareFreeCpuVerified,false);
});

test('누락 표본은 CPU 초과로 중복 집계하지 않고 실제 top-level invocation 필드를 읽는다',()=>{
 const rows=events().slice(1).map(e=>({$metadata:e.$metadata,$workers:e.source.$workers}));
 rows[0].$workers.cpuTimeMs=12;
 const result=summarizeCpu(run,rows);
 assert.equal(result.missing,1);assert.equal(result.violations,1);assert.equal(result.measured,9);assert.equal(result.cloudflareFreeCpuVerified,false);
});

test('중복 CPU 이벤트에서 초과/오류를 숨기지 않고 성공 로그인 Ray ID를 중복 집계하지 않는다',()=>{
 const data=events(),first=data[0];
 const over={...first,source:{$workers:{...first.source.$workers,cpuTimeMs:14,outcome:'exceededCpu'}}};
 for(const list of [[over,...data],[...data,over]]){
  const r=summarizeCpu(run,list);assert.equal(r.violations,1);assert.equal(r.routes['POST /api/passkeys/login/verify'].maxMs,14);assert.equal(r.cloudflareFreeCpuVerified,false);
 }
 assert.equal(summarizeCpu({...run,samples:run.samples.map(()=>run.samples[0])},data).cloudflareFreeCpuVerified,false);
 assert.equal(summarizeCpu({...run,samples:run.samples.map(s=>({...s,status:401}))},data).cloudflareFreeCpuVerified,false);
});

test('실시간 CPU 수집은 토큰·본문·쿠키·원시 로그를 제거하고 다른 Worker를 거부한다',async()=>{
 const {safeTailCpu}=await import('../../scripts/preview-live-cpu.mjs');
 const event={scriptName:run.worker,cpuTime:3,outcome:'ok',logs:['do-not-persist'],event:{request:{headers:{'cf-ray':'0123456789abcdef-ICN',cookie:'do-not-persist'},body:'do-not-persist'}}};
 const safe=safeTailCpu(event,run.worker);assert.equal(safe.$workers.cpuTimeMs,3);assert.ok(!JSON.stringify(safe).includes('do-not-persist'));
 assert.equal(safeTailCpu(event,'another-worker'),null);assert.equal(safeTailCpu({...event,cpuTime:NaN},run.worker),null);
});

test('관측 쿼리는 커서를 따라 다음 페이지를 수집하고 원시 로그를 보관하지 않는다',async()=>{
 const {queryCpuEvents}=await import('../../scripts/preview-cpu.mjs');let calls=0;
 const event=(i)=>({$metadata:{id:'event-'+i,rayId:i.toString(16).padStart(16,'0')},$workers:{scriptName:run.worker,cpuTimeMs:3,outcome:'ok'},source:{cookie:'do-not-persist'}});
 const r=await queryCpuEvents({account:'synthetic',token:'synthetic',run:{...run,from:1,to:2},fetcher:async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.dry,true);assert.equal(body.parameters.filters[0].value,run.worker);
  if(calls++)assert.equal(body.offset,'event-999');
  return Response.json({success:true,result:{events:{count:1001,events:calls===1?Array.from({length:1000},(_,i)=>event(i)):[event(1000)]},statistics:{abr_level:1}}});
 }});
 assert.equal(calls,2);assert.equal(r.events.length,1001);assert.ok(!JSON.stringify(r).includes('do-not-persist'));
});
