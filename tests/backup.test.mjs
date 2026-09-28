import test from 'node:test';import assert from 'node:assert/strict';import { mkdtempSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';import { DatabaseSync } from 'node:sqlite';import { fixture } from './helpers.mjs';import {createBackup,restoreBackup} from '../lib/backup.mjs';import {createApplication} from '../lib/application.mjs';
test('실제 DB 백업 → 새 파일 복구 → 모든 업무 데이터·이력 비교와 재로그인',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'onwork-restore-'));const f=fixture(join(dir,'live.sqlite'));
 try{const admin=f.client(),employee=f.client();await admin.login('ADMIN');await employee.login('001');
 await employee.call('/api/production',{taskId:'t1',good:12,bad:2,requestKey:f.key()});
 f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-09-27','2026-09-26T23:30:00.000Z','2026-09-27T09:00:00.000Z')").run();
 await admin.call('/api/admin/overtime',{id:'a1',version:1,status:'approved',reason:'승인 테스트'});
 const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');
 const counts=await createBackup(f.db,backup);assert.equal(counts.production,1);assert.equal(counts.overtime,1);
 assert.deepEqual(await restoreBackup(backup,restored),counts);
 await assert.rejects(()=>restoreBackup(backup,restored));
 const db=new DatabaseSync(restored);
 try{for(const table of ['employees','tasks','users','attendance','production','overtime','audit'])assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
 assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);
 const app=createApplication(db,f.config);const result=await app(new Request(f.config.origin+'/api/login',{method:'POST',headers:{origin:f.config.origin,'content-type':'application/json'},body:JSON.stringify({login:'001',password:f.password})}));assert.equal(result.status,200);
 }finally{db.close();}
 }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
