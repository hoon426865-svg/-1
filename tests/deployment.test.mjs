import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { config } from '../lib/security.mjs';
import { checkStorage } from '../storage.mjs';
import { createApplication } from '../lib/application.mjs';
import { openDatabase } from '../lib/db.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

test('일반 운영 서버도 누락·빈 파일·잘못된 DB를 거부하며 기존 DB만 허용한다',()=>{
  const root=mkdtempSync(join(tmpdir(),'onwork-existing-'));
  try {
    const settings={production:true,databasePath:join(root,'missing.sqlite')};
    assert.throws(()=>checkStorage(settings));assert.equal(existsSync(settings.databasePath),false);
    writeFileSync(settings.databasePath,'');assert.throws(()=>checkStorage(settings));
    writeFileSync(settings.databasePath,'not sqlite');assert.throws(()=>checkStorage(settings));
    const f=fixture(join(root,'existing.sqlite'));f.db.close();
    checkStorage({...settings,databasePath:join(root,'existing.sqlite')});
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('일반 운영 설정은 영구 루트와 내부 DB 경로를 요구한다',()=>{
  const env={NODE_ENV:'production',APP_ORIGIN:'https://onwork.test',SITE_ID:'site-1',DATABASE_PATH:'/data/existing.sqlite',STORAGE_ROOT:'/data'};
  assert.equal(config(env).volumeMountPath,'/data');
  for(const change of [{STORAGE_ROOT:''},{STORAGE_ROOT:'/'},{STORAGE_ROOT:'relative'},{DATABASE_PATH:'/elsewhere/existing.sqlite'}])assert.throws(()=>config({...env,...change}));
});

const env = {NODE_ENV:'production',SITE_ID:'pilot-site',APP_ORIGIN:'https://pilot.example',DATABASE_PATH:'/data/onwork.sqlite',RAILWAY_SERVICE_ID:'test-service',RAILWAY_VOLUME_MOUNT_PATH:'/data'};
test('Railway 운영 설정은 HTTPS·영구 볼륨 내부 절대 DB 경로·외부 수신 주소를 요구한다',()=>{
  const settings=config({...env,PORT:'8123'});
  assert.equal(settings.port,8123);assert.equal(settings.host,'0.0.0.0');assert.equal(settings.secure,true);
  assert.equal(settings.volumeMountPath,'/data');
  for(const change of [
    {NODE_ENV:'test'}, {APP_ORIGIN:''}, {APP_ORIGIN:'http://pilot.example'}, {APP_ORIGIN:'https://pilot.example/'},
    {SITE_ID:''}, {DATABASE_PATH:''}, {DATABASE_PATH:':memory:'}, {DATABASE_PATH:'data/app.sqlite'},
    {DATABASE_PATH:'/tmp/app.sqlite'}, {DATABASE_PATH:'/data-other/app.sqlite'}, {DATABASE_PATH:'/data/../app.sqlite'},
    {DATABASE_PATH:'/data'}, {RAILWAY_VOLUME_MOUNT_PATH:''}, {RAILWAY_VOLUME_MOUNT_PATH:'/'},
    {HOST:'127.0.0.1'}, {PORT:'invalid'}, {PORT:'0'}, {MAINTENANCE_MODE:'yes'},
  ]) assert.throws(()=>config({...env,...change}));
});

test('볼륨 미연결·볼륨 밖 심볼릭 링크는 DB를 생성하기 전에 차단한다',()=>{
  const dir=mkdtempSync(join(tmpdir(),'onwork-storage-'));
  try {
    const root=join(dir,'volume');mkdirSync(root);
    const settings=config({...env,RAILWAY_VOLUME_MOUNT_PATH:root,DATABASE_PATH:join(root,'db','onwork.sqlite')});
    assert.throws(()=>checkStorage(settings));assert.equal(existsSync(join(root,'db')),false);
    assert.throws(()=>checkStorage({...settings,volumeMountPath:join(dir,'missing')}));
    symlinkSync(tmpdir(),join(root,'outside'));
    assert.throws(()=>checkStorage({...settings,databasePath:join(root,'outside','new.sqlite')}));
    symlinkSync(join(dir,'missing.sqlite'),join(root,'dangling.sqlite'));
    assert.throws(()=>checkStorage({...settings,databasePath:join(root,'dangling.sqlite')}));
    assert.throws(()=>checkStorage({...settings,databasePath:root}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('상태 확인은 무인증 GET/HEAD, DB 실패 시 503이며 데이터·경로를 노출하지 않는다',async()=>{
  const f=fixture();
  const app=createApplication(f.db,f.config);
  try {
    for(const method of ['GET','HEAD']) {
      const r=await app(new Request('http://healthcheck.railway.app/healthz',{method}));
      assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
      assert.equal(await r.text(),method==='HEAD'?'':'{"status":"ok"}');
    }
    const denied=await app(new Request(f.config.origin+'/healthz',{method:'POST'}));
    assert.equal(denied.status,405);
  }finally{f.db.close();}
  const failed=await app(new Request(f.config.origin+'/healthz'));
  assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{status:'unavailable'});
});

test('복구 점검 모드는 기존 세션을 포함한 모든 업무 요청을 차단하고 DB 내용은 보존한다',async()=>{
  const f=fixture();try {
    const c=f.client();await c.login('001');
    const before=f.db.prepare('SELECT * FROM sessions').all();
    const app=createApplication(f.db,{...f.config,maintenance:true});
    for(const path of ['/login','/api/setup','/api/work-requests','/api/admin/work-requests/report']) {
      const r=await app(new Request(f.config.origin+path));assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'60');
    }
    for(const path of ['/api/login','/api/setup','/api/attendance','/api/work-requests','/api/admin/work-requests/decision']) {
      assert.equal((await app(new Request(f.config.origin+path,{method:'POST',body:'{}'}))).status,503);
    }
    assert.equal((await app(new Request(f.config.origin+'/healthz'))).status,200);
    assert.deepEqual(f.db.prepare('SELECT * FROM sessions').all(),before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,0);
  } finally {f.db.close();}
});

test('운영 서버는 주어진 PORT에 바인딩하고 기존 볼륨 DB·계정·신청을 재시작 후 보존한다',{timeout:20000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'onwork-production-')),path=join(root,'onwork.sqlite');
  const f=fixture(path);
  let child;
  async function stop() {
    if(child && child.exitCode===null && child.signalCode===null) {const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    child=null;
  }
  try {
    const c=f.client();await c.login('001');
    assert.equal((await c.call('/api/work-requests',{type:'annual',startDate:'2026-10-01',endDate:'2026-10-01',allDay:true,reason:'시험'})).status,200);
    const tables=['users','employees','attendance','production','work_requests','work_request_history'];
    const before=Object.fromEntries(tables.map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
    f.db.close();
    const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    for(let cycle=0;cycle<2;cycle++) {
      child=spawn(process.execPath,['server.mjs'],{env:{...process.env,...env,PORT:String(port),HOST:'0.0.0.0',DATABASE_PATH:path,RAILWAY_VOLUME_MOUNT_PATH:root,MAINTENANCE_MODE:'0'},stdio:['ignore','pipe','pipe']});
      // Do not emit environment variables or application records in test output.
      child.stdout.resume();child.stderr.resume();
      let ready=false;
      for(let attempt=0;attempt<100;attempt++) {
        if(child.exitCode!==null) break;
        try {const r=await fetch(`http://127.0.0.1:${port}/healthz`);if(r.status===200){assert.deepEqual(await r.json(),{status:'ok'});ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(ready,true,'Production server did not become ready');
      await stop();
      const db=openDatabase(path);
      try {for(const t of tables)assert.deepEqual(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),before[t]);}finally{db.close();}
    }
  }finally{await stop();if(f.db.isOpen)f.db.close();rmSync(root,{recursive:true,force:true});}
});
