import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,origin} from './helpers.mjs';
import {randomUUID} from 'node:crypto';
const request=(changes={})=>({type:'annual',startDate:'2026-10-03',endDate:'2026-10-03',allDay:true,reason:'시험 신청',...changes});
const decision=(c,r,action='approved')=>c.call('/api/admin/work-requests/decision',{id:r.id,version:r.version,action,comment:'업무 확인'});

test('workerd/D1: 기존 scrypt 계정 로그인, 권한·Origin·CSRF·타인 ID 차단, 출퇴근·생산량 보존',async()=>{
  const f=await fixture();try{
    const guest=f.client(),admin=f.client(),e=f.client(),other=f.client();
    assert.equal((await guest.call('/api/state')).status,401);
    assert.equal((await admin.login('ADMIN')).status,200);assert.equal((await e.login('001')).status,200);assert.equal((await other.login('002')).status,200);
    assert.equal((await e.call('/api/admin/audit')).status,403);
    assert.equal((await e.call('/api/state?employeeId=e2')).status,403);
    assert.equal((await e.call('/api/attendance',{action:'in'},'POST',{origin:'https://evil.test'})).status,403);
    assert.equal((await e.call('/api/attendance',{action:'in'},'POST',{'x-csrf-token':'wrong'})).status,403);
    const punch=await e.call('/api/attendance',{action:'in'});assert.equal(punch.status,200);assert.equal(punch.data.record.employeeId,'e1');
    assert.equal((await e.call('/api/attendance',{action:'in'})).status,409);
    assert.equal((await e.call('/api/attendance',{action:'out'})).status,200);
    const body={taskId:'t1',good:4,bad:1,requestKey:randomUUID()};
    const first=await e.call('/api/production',body);assert.equal(first.status,200);
    assert.deepEqual((await e.call('/api/production',body)).data,first.data);
    assert.equal((await e.call('/api/production',{...body,good:9})).status,409);
    const own=(await e.call('/api/state')).data,others=(await other.call('/api/state')).data,whole=(await admin.call('/api/state')).data;
    assert.equal(own.attendance.length,1);assert.equal(others.attendance.length,0);assert.equal(whole.production.length,1);
    assert.ok(punch.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(e.cookie.startsWith('__Host-onwork='));
    const current=(await admin.call('/api/state')).data.employees.find(p=>p.id==='e1');
    assert.equal((await admin.call('/api/admin/employee-status',{id:'e1',version:current.version,active:false,reason:'퇴사 시험'})).status,200);
    assert.equal((await e.call('/api/me')).status,401);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM attendance').first()).n,1);
    assert.equal((await e.login('001')).status,401);
  }finally{await f.close();}
});

test('workerd/D1: 신청·승인·반려·재검토·수정 이력, 월/연 경계 조회와 중복·버전 충돌',async()=>{
  const f=await fixture();try{
    const a=f.client(),e=f.client(),o=f.client();await a.login('ADMIN');await e.login('001');await o.login('002');
    let r=(await e.call('/api/work-requests',request({startDate:'2026-09-30',endDate:'2026-10-02'}))).data;
    assert.equal(r.status,'pending');assert.equal((await o.call('/api/work-requests/history?id='+r.id)).status,404);
    assert.equal((await e.call('/api/work-requests',request({startDate:'2026-10-01',endDate:'2026-10-01'}))).status,409);
    assert.equal((await decision(e,r)).status,403);
    r=(await decision(a,r)).data;assert.equal(r.status,'approved');
    assert.equal((await decision(a,r)).status,409);
    assert.equal((await e.call('/api/work-requests',{...request(),id:r.id,version:r.version,changeReason:'수정'})).status,409);
    const annual=(await a.call('/api/admin/work-requests/report?year=2026')).data;
    const monthly=(await a.call('/api/admin/work-requests/report?year=2026&month=10')).data;
    assert.equal(annual.summaries.find(s=>s.id==='e1').absenceDates,3);assert.equal(monthly.summaries.find(s=>s.id==='e1').absenceDates,2);
    r=(await decision(a,r,'reopen')).data;
    r=(await e.call('/api/work-requests',{...request(),id:r.id,version:r.version,changeReason:'일정 수정'})).data;
    r=(await decision(a,r,'rejected')).data;assert.equal(r.status,'rejected');
    assert.deepEqual((await e.call('/api/work-requests/history?id='+r.id)).data.map(h=>h.action),['created','approved','reopen','revised','rejected']);
    await assert.rejects(f.db.prepare('DELETE FROM work_requests WHERE id=?').bind(r.id).run());
    await assert.rejects(f.db.prepare("UPDATE work_request_history SET comment='changed' WHERE request_id=?").bind(r.id).run());
    for(const changes of [{type:'unknown'},{startDate:'2026-02-30'},{endDate:'2028-01-01'},{reason:' '}])assert.equal((await e.call('/api/work-requests',request(changes))).status,400);
  }finally{await f.close();}
});

test('workerd/D1: 초기 설정 일회성·임시 비밀번호 변경·리셋·세션 종료·계정 보존',async()=>{
  const f=await fixture({empty:true});try{
    const g=f.client(),a=f.client(),e=f.client();
    assert.equal((await g.call('/api/setup')).data.required,true);
    assert.equal((await g.call('/api/setup',{login:'ADMIN',password:f.password,confirmation:f.password})).status,201);
    assert.equal((await g.call('/api/setup',{login:'ADMIN2',password:f.password,confirmation:f.password})).status,409);
    assert.equal((await a.login('ADMIN')).status,200);
    const created=await a.call('/api/admin/employee',{number:'001',name:'시험 직원',team:'생산팀',password:f.password,reason:'시범 계정'});assert.equal(created.status,200);
    assert.equal((await e.login('001')).status,200);assert.equal((await e.call('/api/state')).status,403);
    const changed=randomUUID();assert.equal((await e.call('/api/password',{currentPassword:f.password,password:changed})).status,200);
    assert.equal((await e.call('/api/me')).status,401);assert.equal((await e.login('001',changed)).status,200);
    assert.equal((await a.call('/api/admin/reset-password',{id:created.data.id,password:f.password,reason:'재설정 시험'})).status,200);
    assert.equal((await e.call('/api/me')).status,401);assert.equal((await e.login('001')).status,200);assert.equal((await e.call('/api/me')).data.mustChange,true);
    const loggedOut=await a.call('/api/logout',{});assert.equal(loggedOut.status,200);assert.match(loggedOut.headers.get('set-cookie'),/Secure/);assert.equal((await a.call('/api/me')).status,401);
  }finally{await f.close();}
});

test('workerd/D1: 동시 승인 중 한 건만 성공하고 실패 배치에 이력·업무 변경이 남지 않는다',async()=>{
  const f=await fixture();try{
    const a=f.client(),e=f.client();await a.login('ADMIN');await e.login('001');
    const r=(await e.call('/api/work-requests',request())).data;
    const results=await Promise.all([decision(a,r),decision(a,r)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM work_request_history WHERE request_id=?').bind(r.id).first()).n,2);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM worker_guard').first()).n,0);
  }finally{await f.close();}
});

test('workerd/D1: 200건 넘는 조회·연간 보고는 누락 없이 페이지를 합치며 조회 중 변경은 409',async()=>{
  const f=await fixture();try{
    const a=f.client(),e=f.client();await a.login('ADMIN');await e.login('001');
    for(let start=0;start<405;start+=40)await f.db.batch(Array.from({length:Math.min(40,405-start)},(_,j)=>f.db.prepare('INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,?,?,?,?,?,?,?)').bind(String(start+j).padStart(5,'0'),'e1','t1','조립','2026-10-01','2026-10-01T00:00:00Z',1,0,'migration-'+(start+j))));
    assert.equal((await e.call('/api/state')).data.production.length,405);
    assert.equal((await a.call('/api/admin/work-requests/report?year=2026')).data.summaries.find(s=>s.id==='e1').production.length,405);
    const p=(await e.raw('/api/state')).data;assert.ok(p.nextCursor);
    await f.db.prepare("UPDATE tasks SET name='새 조립' WHERE id='t1'").run();
    assert.equal((await e.raw('/api/state?cursor='+encodeURIComponent(p.nextCursor)+'&revision='+p.revision)).status,409);
  }finally{await f.close();}
});

test('workerd/D1: 운영은 이전 검증 표시 없이 업무·새 관리자 생성을 허용하지 않는다',async()=>{
  const f=await fixture({production:true});try{
    assert.equal((await f.client().call('/healthz')).status,200);
    assert.equal((await f.client().call('/api/login',{login:'ADMIN',password:f.password})).status,503);
    assert.equal((await f.client().call('/api/setup',{login:'NEW',password:f.password,confirmation:f.password})).status,503);
  }finally{await f.close();}
});
