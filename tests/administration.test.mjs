import test from 'node:test';import assert from 'node:assert/strict';import { fixture } from './helpers.mjs';
function records(f){f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run('a1','e1','2026-09-27','2026-09-26T23:30:00.000Z','2026-09-27T09:00:00.000Z');}
test('수정·야근 승인에 담당자 시각 사유를 남기고 변경 충돌과 누락 사유 차단',async()=>{
 const f=fixture();try{records(f);const a=f.client();await a.login('ADMIN');
 assert.equal((await a.call('/api/admin/overtime',{id:'a1',version:1,status:'approved',reason:''})).status,400);
 assert.equal((await a.call('/api/admin/overtime',{id:'a1',version:1,status:'approved',reason:'작업 확인'})).status,200);
 assert.equal(f.db.prepare('SELECT status FROM overtime').get().status,'approved');
 assert.equal((await a.call('/api/admin/attendance',{id:'a1',version:1,inAt:'2026-09-27T08:30:00+09:00',outAt:'2026-09-27T17:30:00+09:00',reason:'정정'})).status,409);
 assert.equal((await a.call('/api/admin/attendance',{id:'a1',version:2,inAt:'2026-09-27T08:30:00+09:00',outAt:'2026-09-27T17:30:00+09:00',reason:'정정'})).status,200);
 assert.equal(f.db.prepare('SELECT count(*) n FROM overtime').get().n,0);
 assert.equal((await a.call('/api/admin/overtime',{id:'a1',version:3,status:'approved',reason:'검토'})).status,400);
 const logs=(await a.call('/api/admin/audit')).data;assert.equal(logs.length,3);assert.ok(logs.every(l=>l.actor_id==='admin' && l.reason && l.occurred_at));
 }finally{f.db.close();}
});
test('삭제 영향 건수·확인·변경 감지·원자적 연쇄 삭제와 다른 직원 보존',async()=>{
 const f=fixture();try{records(f);const a=f.client(),e=f.client(),other=f.client();await a.login('ADMIN');await e.login('001');await other.login('002');
 await e.call('/api/production',{taskId:'t1',good:7,bad:2,requestKey:f.key()});await other.call('/api/production',{taskId:'t1',good:10,bad:1,requestKey:f.key()});
 await a.call('/api/admin/overtime',{id:'a1',version:1,status:'approved',reason:'확인'});
 const preview=(await a.call('/api/admin/delete-preview',{id:'e1'})).data;
 assert.equal(preview.counts.attendance,1);assert.equal(preview.counts.production,1);assert.equal(preview.counts.overtimeDecisions,1);
 const payload={id:'e1',number:'001',confirmationToken:preview.confirmationToken,confirm:true,reason:'삭제 요청'};
 assert.equal((await a.call('/api/admin/delete-employee',{...payload,confirm:false})).status,400);
 await e.call('/api/production',{taskId:'t1',good:2,bad:0,requestKey:f.key()});
 assert.equal((await a.call('/api/admin/delete-employee',payload)).status,409);
 payload.confirmationToken=(await a.call('/api/admin/delete-preview',{id:'e1'})).data.confirmationToken;
 const otherBefore=f.db.prepare("SELECT * FROM production WHERE employee_id='e2'").all();
 assert.equal((await a.call('/api/admin/delete-employee',payload)).status,200);
 assert.deepEqual(f.db.prepare("SELECT * FROM production WHERE employee_id='e2'").all(),otherBefore);
 assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM overtime').get().n,0);
 assert.equal((await e.call('/api/state')).status,401);
 assert.equal((await a.call('/api/state')).data.production.reduce((n,r)=>n+r.good,0),10);
 assert.ok(f.db.prepare("SELECT id FROM audit WHERE action='employee_delete'").get());
 assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{f.db.close();}
});
