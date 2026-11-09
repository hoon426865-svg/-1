import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {target,checkTarget,checkRemoteVersion,activeDeployment,checkPublicApp} from '../scripts/deploy-operations.mjs';

const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const version=()=>({resources:{bindings:[{name:'DB',type:'d1',id:target.database},{name:'ASSETS',type:'assets'},...Object.entries(config.env.preview.vars).map(([name,text])=>({name,type:'plain_text',text}))],script_runtime:{compatibility_date:config.compatibility_date}}});

test('배포 도구는 다른 DB·인증키·원격 연결을 덮어쓰지 않는다',()=>{
  checkTarget(config);checkRemoteVersion(version(),config);
  const otherConfig=structuredClone(config);otherConfig.env.preview.d1_databases[0].database_id='11111111-1111-1111-1111-111111111111';
  assert.throws(()=>checkTarget(otherConfig),/D1/);
  const otherDB=version();otherDB.resources.bindings[0].id=otherConfig.env.preview.d1_databases[0].database_id;
  assert.throws(()=>checkRemoteVersion(otherDB,config),/다른 DB/);
  const rotated=version();rotated.resources.bindings.find(b=>b.name==='ENROLLMENT_PUBLIC_KEY').text='rotated-public-key';
  assert.throws(()=>checkRemoteVersion(rotated,config),/ENROLLMENT_PUBLIC_KEY/);
  const extra=version();extra.resources.bindings.push({name:'ARCHIVE',type:'r2_bucket',bucket_name:'synthetic'});
  assert.throws(()=>checkRemoteVersion(extra,config),/원격 연결/);
});

test('배포 도구는 최신 활성 버전을 찾고 분할 배포를 거부한다',()=>{
  const previous={id:'older',created_on:'2026-11-01T00:00:00Z',versions:[{version_id:'11111111-1111-1111-1111-111111111111',percentage:100}]};
  const latest={id:'latest',created_on:'2026-11-09T00:00:00Z',versions:[{version_id:'22222222-2222-2222-2222-222222222222',percentage:100}]};
  assert.equal(activeDeployment([previous,latest]).deploymentId,'latest');
  assert.equal(activeDeployment([latest,previous]).deploymentId,'latest');
  assert.throws(()=>activeDeployment([{...latest,versions:[{...latest.versions[0],percentage:50},previous.versions[0]]}]),/분할/);
  assert.throws(()=>activeDeployment([]),/이력/);
  assert.throws(()=>activeDeployment([{...latest,id:undefined}]),/식별자/);
});

test('배포 후 검사는 기존 인증·접근 제한·배포 파일의 실제 내용을 확인한다',async()=>{
  const root=mkdtempSync(join(tmpdir(),'onwork-deploy-check-'));
  const files=['index.html','app.js','operations.js','operations-domain.js','style.css'];
  for(const file of files)writeFileSync(join(root,file),'synthetic '+file);
  let mode='valid';
  const mock=async url=>{
    const path=new URL(url).pathname;
    if(path==='/healthz')return Response.json({status:'ok'});
    if(path==='/api/setup')return Response.json({authMode:mode==='password'?'password':'passkey',appOrigin:target.origin,required:false});
    if(path.startsWith('/api/'))return Response.json({}, {status:mode==='public-data'?200:401});
    return new Response(mode==='stale'?'stale asset':readFileSync(join(root,path==='/login'?'index.html':path.slice(1))));
  };
  try{
    assert.equal((await checkPublicApp(mock,root)).length,9);
    mode='password';await assert.rejects(checkPublicApp(mock,root),/패스키/);
    mode='public-data';await assert.rejects(checkPublicApp(mock,root),/접속 검사/);
    mode='stale';await assert.rejects(checkPublicApp(mock,root),/파일 불일치/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
