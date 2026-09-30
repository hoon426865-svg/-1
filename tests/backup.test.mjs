import test from 'node:test';import assert from 'node:assert/strict';import { mkdtempSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';import { DatabaseSync } from 'node:sqlite';import { fixture } from './helpers.mjs';import {createBackup,restoreBackup} from '../lib/backup.mjs';import {createApplication} from '../lib/application.mjs';
test('실제 DB 백업 → 새 파일 복구 → 모든 업무 데이터·이력 비교와 재로그인',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'onwork-restore-'));const f=fixture(join(dir,'live.sqlite'));
 try{const admin=f.client(),employee=f.client();await admin.login('ADMIN');await employee.login('001');
 await employee.call('/api/production',{taskId:'t1',good:12,bad:2,requestKey:f.key()});
 f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-09-27','2026-09-26T23:30:00.000Z','2026-09-27T09:00:00.000Z')").run();
 await admin.call('/api/admin/overtime',{id:'a1',version:1,status:'approved',reason:'승인 테스트'});
 f.db.prepare("INSERT INTO qr_challenges VALUES('test-challenge','site-1','in',9999999999999)").run();
 f.db.prepare("INSERT INTO qr_uses VALUES('test-challenge','e1','2026-09-27T23:30:00Z')").run();
 const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');
 const counts=await createBackup(f.db,backup);assert.equal(counts.production,1);assert.equal(counts.overtime,1);
 assert.deepEqual(await restoreBackup(backup,restored),counts);
 await assert.rejects(()=>restoreBackup(backup,restored));
 const db=new DatabaseSync(restored);
 try{for(const table of ['employees','tasks','users','attendance','production','overtime','audit'])assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
 assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM qr_uses').get().n,0);
 const app=createApplication(db,f.config);const result=await app(new Request(f.config.origin+'/api/login',{method:'POST',headers:{origin:f.config.origin,'content-type':'application/json'},body:JSON.stringify({login:'001',password:f.password})}));assert.equal(result.status,200);
 }finally{db.close();}
 }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('백업은 기존 파일·저널·깨진 링크를 덮어쓰지 않고 동시 같은 대상 중 하나만 생성한다',async()=>{
 const {writeFileSync,readFileSync,symlinkSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'onwork-backup-safe-'));const f=fixture();
 try {
  for(const suffix of ['', '-wal', '-shm']) {
   const target=join(dir,'occupied'+suffix+'.sqlite');
   writeFileSync(target+suffix,'preserve');
   await assert.rejects(()=>createBackup(f.db,target));
   assert.equal(readFileSync(target+suffix,'utf8'),'preserve');
  }
  const linked=join(dir,'link.sqlite');symlinkSync(join(dir,'absent.sqlite'),linked);
  await assert.rejects(()=>createBackup(f.db,linked));
  const target=join(dir,'concurrent.sqlite');
  const results=await Promise.allSettled([createBackup(f.db,target),createBackup(f.db,target)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
 } finally {f.db.close();rmSync(dir,{recursive:true,force:true});}
});
