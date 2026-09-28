import test from 'node:test';import assert from 'node:assert/strict';import { fixture } from './helpers.mjs';
test('직원은 본인 데이터만 받고 관리자 주소·모든 관리자 API를 거부한다',async()=>{
 const f=fixture();try{
 const guest=f.client(),admin=f.client(),staff=f.client();
 assert.equal((await guest.call('/api/state')).status,401);
 assert.equal((await staff.login('001')).status,200);assert.equal((await admin.login('ADMIN')).status,200);
 const state=(await staff.call('/api/state')).data;assert.deepEqual(state.employees.map(e=>e.id),['e1']);
 for(const path of ['/admin','/admin/qr','/api/admin/audit'])assert.equal((await staff.call(path)).status,403);
 for(const path of ['employee','employee-status','reset-password','task','qr','attendance','production','overtime','delete-preview','delete-employee'])assert.equal((await staff.call('/api/admin/'+path,{reason:'우회'})).status,403);
 assert.equal((await staff.call('/api/production',{employeeId:'e2',taskId:'t1',good:3,bad:1,requestKey:f.key()})).status,403);
 assert.equal(f.db.prepare('SELECT count(*) n FROM production').get().n,0);
 assert.equal((await staff.call('/api/production',{taskId:'t1',good:3,bad:1,requestKey:f.key()})).status,200);
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
 const changedPassword=f.key();
 assert.equal((await newbie.call('/api/production',{taskId:'t1',good:1,bad:0,requestKey:f.key()})).status,403);
 assert.equal((await newbie.call('/api/password',{currentPassword:f.password,password:changedPassword})).status,200);
 assert.equal((await newbie.call('/api/me')).status,401);
 assert.equal((await newbie.login('003')).status,401);
 assert.equal((await newbie.login('003',changedPassword)).status,200);
 assert.equal((await newbie.call('/api/state')).data.employees[0].id,created.data.id);
 }finally{f.db.close();}
});

test('타인 ID 조회·출퇴근·생산 요청은 거부하고 본인 기록과 관리자 집계를 유지한다', async () => {
 const f=fixture();try {
  const a=f.client(),one=f.client(),two=f.client();
  await a.login('ADMIN');await one.login('001');await two.login('002');
  for (const path of ['/api/state?employeeId=e2','/api/state?employee_id=e2','/api/state?employeeId=e1&employeeId=e2','/api/me?employeeId=e2']) assert.equal((await one.call(path)).status,403);
  for (const body of [{employeeId:'e2'}, {employee_id:'e2'}, {employeeId:null}]) {
   assert.equal((await one.call('/api/attendance',{...body,action:'in'})).status,403);
   assert.equal((await one.call('/api/production',{...body,taskId:'t1',good:1,bad:0,requestKey:f.key()})).status,403);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM production').get().n,0);
  assert.equal((await one.call('/api/attendance',{action:'in',time:'01:00:00'})).data.record.in,'08:30:00');
  assert.equal((await one.call('/api/attendance',{action:'in'})).status,409);
  assert.equal((await two.call('/api/attendance',{action:'in'})).status,200);
  for(const [client,good] of [[one,2],[two,7]]) assert.equal((await client.call('/api/production',{taskId:'t1',good,bad:0,requestKey:f.key()})).status,200);
  const own=(await one.call('/api/state?employeeId=e1')).data;
  assert.deepEqual(own.attendance.map(r=>r.employeeId),['e1']);
  assert.deepEqual(own.production.map(r=>r.employeeId),['e1']);
  assert.equal(own.production[0].good,2);
  assert.equal((await a.call('/api/state')).data.production.reduce((n,r)=>n+r.good,0),9);
  for(const path of ['/admin','/admin/qr','/api/admin/audit']) assert.equal((await a.call(path)).status,200);
  assert.equal((await a.call('/api/admin/task',{name:'검수',reason:'테스트'})).status,200);
  assert.equal((await a.call('/api/admin/employee',{name:'테스트 직원',number:'TEST-3',team:'테스트',password:f.key(),reason:'테스트'})).status,200);
  assert.equal((await a.call('/api/admin/employee',{id:'e1',version:1,name:'테스트 수정',number:'001',team:'테스트',reason:'수정'})).status,200);
  f.setTime('2026-09-28T00:30:00Z');
  assert.equal((await one.call('/api/attendance',{action:'out'})).data.record.out,'09:30:00');
  assert.equal((await one.call('/api/attendance',{action:'out'})).status,409);
  await one.call('/api/logout',{});
  assert.equal((await one.call('/api/state')).status,401);
 } finally { f.db.close(); }
});

test('미로그인 화면·API 차단 및 관리자 경로의 메서드별 권한 검사', async () => {
 const f=fixture();try {
  const guest=f.client(),staff=f.client();
  for(const path of ['/','/employee','/attendance','/production']) {
   const response=await guest.call(path);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/login');
  }
  assert.equal((await guest.call('/login')).status,200);
  for(const path of ['/api/attendance','/api/production','/api/admin/employee']) assert.equal((await guest.call(path,{})).status,401);
  await staff.login('001');
  for(const path of ['/admin','/admin/','/admin/unknown','/api/admin','/api/admin/unknown','/api/admin/audit']) {
   for(const method of ['GET','HEAD','POST','PUT','DELETE']) {
    assert.equal((await guest.call(path,undefined,method)).status,401);
    assert.equal((await staff.call(path,undefined,method)).status,403);
   }
  }
 } finally { f.db.close(); }
});

test('잘못된 비밀번호·만료된 세션은 로그인 또는 업무 접근을 허용하지 않는다', async () => {
 const f=fixture();try {
  const staff=f.client();
  assert.equal((await staff.login('001',f.key())).status,401);
  assert.equal((await staff.call('/api/state')).status,401);
  assert.equal((await staff.login('001')).status,200);
  f.setTime('2026-09-28T07:30:01Z');
  assert.equal((await staff.call('/api/state')).status,401);
  assert.equal((await staff.call('/api/attendance',{action:'in'})).status,401);
  assert.equal((await staff.call('/api/production',{taskId:'t1',good:1,bad:0,requestKey:f.key()})).status,401);
  assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM production').get().n,0);
 } finally { f.db.close(); }
});

test('직원 생성·비밀번호 재설정은 관리자만 허용하고 재설정 후 기존 세션·비밀번호를 무효화한다', async () => {
 const f=fixture();try {
  const guest=f.client(),staff=f.client(),other=f.client(),admin=f.client();
  await staff.login('001');await other.login('002');await admin.login('ADMIN');
  const newPassword=f.key();
  const reset={id:'e1',password:newPassword,reason:'본인 요청'};
  const employee={name:'시험 직원',number:'TEST-NEW',team:'시험',password:f.key(),reason:'시험 계정'};
  for(const [path,body] of [['/api/admin/employee',employee],['/api/admin/reset-password',reset]]) {
   assert.equal((await guest.call(path,body)).status,401);
   assert.equal((await staff.call(path,body)).status,403);
  }
  assert.equal((await admin.call('/api/admin/employee',employee)).status,200);
  assert.equal((await admin.call('/api/admin/reset-password',reset)).status,200);
  assert.equal((await staff.call('/api/state')).status,401);
  assert.equal((await staff.login('001')).status,401);
  assert.equal((await staff.login('001',newPassword)).status,200);
  assert.equal((await staff.call('/api/me')).data.mustChange,true);
  assert.equal((await staff.call('/api/state')).status,403);
  assert.equal((await other.call('/api/state')).status,200);
  const finalPassword=f.key();
  assert.equal((await staff.call('/api/password',{currentPassword:newPassword,password:finalPassword})).status,200);
  assert.equal((await staff.login('001',finalPassword)).status,200);
  assert.equal((await staff.call('/api/state')).status,200);
  const audit=JSON.stringify((await admin.call('/api/admin/audit')).data);
  for(const secret of [newPassword,finalPassword,employee.password]) assert.equal(audit.includes(secret),false);
 } finally { f.db.close(); }
});
