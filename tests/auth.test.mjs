import test from 'node:test';import assert from 'node:assert/strict';import { fixture } from './helpers.mjs';
test('직원은 본인 데이터만 받고 관리자 주소·모든 관리자 API를 거부한다',async()=>{
 const f=fixture();try{
 const guest=f.client(),admin=f.client(),staff=f.client();
 assert.equal((await guest.call('/api/state')).status,401);
 assert.equal((await staff.login('001')).status,200);assert.equal((await admin.login('ADMIN')).status,200);
 const state=(await staff.call('/api/state')).data;assert.deepEqual(state.employees.map(e=>e.id),['e1']);
 for(const path of ['/admin','/admin/qr','/api/admin/audit'])assert.equal((await staff.call(path)).status,403);
 for(const path of ['employee','employee-status','reset-password','task','qr','attendance','production','overtime','delete-preview','delete-employee'])assert.equal((await staff.call('/api/admin/'+path,{reason:'우회'})).status,403);
 assert.equal((await staff.call('/api/production',{employeeId:'e2',taskId:'t1',good:3,bad:1,requestKey:f.key()})).status,200);
 assert.equal(f.db.prepare('SELECT employee_id FROM production').get().employee_id,'e1');
 assert.equal((await admin.call('/api/state')).data.employees.length,2);
 assert.equal((await staff.call('/api/production',{taskId:'t1',good:1,bad:0,requestKey:f.key()},'POST',{origin:'https://evil.example'})).status,403);
 assert.equal((await staff.call('/api/logout',{},'POST',{'x-csrf-token':'wrong'})).status,403);
 }finally{f.db.close();}
});
test('퇴사 즉시 기존 세션 무효화, 새 직원 임시 비밀번호 강제 변경 및 서버 재생성 후 로그인 유지',async()=>{
 const f=fixture();try{
 const admin=f.client(),staff=f.client();await admin.login('ADMIN');await staff.login('001');
 f.restart();assert.equal((await staff.call('/api/state')).status,200);
 assert.equal((await admin.call('/api/admin/employee-status',{id:'e1',version:1,active:false,reason:'퇴사'})).status,200);
 assert.equal((await staff.call('/api/state')).status,401);assert.equal((await staff.login('001')).status,401);
 const created=await admin.call('/api/admin/employee',{name:'신입',number:'003',team:'팀',password:f.password,reason:'입사'});assert.equal(created.status,200);
 const newbie=f.client();await newbie.login('003');assert.equal((await newbie.call('/api/state')).status,403);
 assert.equal((await newbie.call('/api/password',{currentPassword:f.password,password:'Changed-password-123!'})).status,200);
 assert.equal((await newbie.call('/api/me')).status,401);
 }finally{f.db.close();}
});
