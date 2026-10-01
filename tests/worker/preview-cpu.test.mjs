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
