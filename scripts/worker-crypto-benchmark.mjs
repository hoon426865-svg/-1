import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
// Synthetic credentials only. This never connects to Cloudflare or any app DB.
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:resolve('worker/benchmark-entry.mjs'),compatibilityDate:'2026-09-30',script:`import {scrypt,timingSafeEqual} from 'node:crypto';
export default {async fetch(){const start=performance.now();const actual=await new Promise((ok,no)=>scrypt('synthetic benchmark password','0'.repeat(32),64,{N:16384,r:8,p:1,maxmem:33554432},(e,r)=>e?no(e):ok(r)));timingSafeEqual(actual,Buffer.alloc(64));return Response.json({localElapsedMs:performance.now()-start});}};`}));
try{
  await mf.dispatchFetch('http://localhost/');
  const pid=execFileSync('ps',['-C','workerd','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number)).find(([,parent])=>parent===process.pid)?.[0];
  const ticks=()=>{const values=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');return Number(values[11])+Number(values[12]);};
  const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
  const before=pid?ticks():null,elapsed=[];
  for(let i=0;i<20;i++)elapsed.push((await (await mf.dispatchFetch('http://localhost/')).json()).localElapsedMs);
  const after=pid?ticks():null;
  const report={runtime:'workerd',compatibilityDate:'2026-09-30',samples:elapsed.length,scrypt:{N:16384,r:8,p:1,keyBytes:64},freeCpuLimitMs:10,localElapsedMedianMs:elapsed.sort((a,b)=>a-b)[10],localRuntimeCpuMsPerVerification:pid?(after-before)*1000/hz/elapsed.length:null,cloudflareFreeCpuVerified:false,note:'Local process CPU and elapsed time are diagnostic evidence. Cloudflare per-invocation CPU enforcement must be checked on a FREE preview account; no weaker KDF or paid fallback is permitted.'};
  mkdirSync('dist',{recursive:true});writeFileSync('dist/worker-crypto-benchmark.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await mf.dispose();}
