import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { openDatabase } from '../lib/db.mjs';
import { createApplication } from '../lib/application.mjs';
import { createBackup,restoreBackup } from '../lib/backup.mjs';

const input = (changes={}) => ({type:'overtime',startDate:'2026-09-28',endDate:'2026-09-28',allDay:false,startTime:'18:00',endTime:'20:00',reason:'추가 작업 필요',...changes});
async function clients(f) {
  const employee=f.client(),other=f.client(),admin=f.client(),guest=f.client();
  await employee.login('001');await other.login('002');await admin.login('ADMIN');
  return {employee,other,admin,guest};
}
const decide = (admin,r,action='approved') => admin.call('/api/admin/work-requests/decision',{id:r.id,version:r.version,action,comment:'업무 일정 확인'});

test('직원 본인 신청·이력만 조회하고 다른 직원 ID·관리자 처리·CSRF·미인증 요청 차단',async()=>{
  const f=fixture();try {
    const {employee,other,admin,guest}=await clients(f);
    const r=(await employee.call('/api/work-requests',input())).data;
    assert.equal(r.status,'pending');assert.equal(r.employee_id,'e1');
    assert.equal((await other.call('/api/work-requests')).data.length,0);
    assert.equal((await employee.call('/api/work-requests')).data.length,1);
    assert.equal((await admin.call('/api/work-requests')).data.length,1);
    assert.equal((await guest.call('/api/work-requests')).status,401);
    assert.equal((await guest.call('/api/admin/work-requests/report?year=2026')).status,401);
    assert.equal((await other.call('/api/work-requests/history?id='+r.id)).status,404);
    assert.equal((await other.call('/api/work-requests',{...input(),id:r.id,version:1,changeReason:'타인 수정'})).status,404);
    assert.equal((await employee.call('/api/work-requests?employeeId=e2')).status,403);
    assert.equal((await employee.call('/api/work-requests',input({employee_id:'e2'}))).status,403);
    assert.equal((await decide(employee,r)).status,403);
    assert.equal((await employee.call('/api/admin/work-requests/report?year=2026')).status,403);
    assert.equal((await admin.call('/api/work-requests',input())).status,403);
    assert.equal((await employee.call('/api/work-requests',input(),'POST',{'x-csrf-token':'invalid'})).status,403);
    f.db.prepare("UPDATE users SET must_change=1 WHERE employee_id='e1'").run();
    assert.equal((await employee.call('/api/work-requests')).status,403);
  }finally{f.db.close();}
});

test('모든 유형, 유효 날짜·시간·사유 검사와 기간·시간 중복 및 인접 시간 처리',async()=>{
  const f=fixture();try {
    const {employee,other}=await clients(f);
    for(const changes of [{type:'unknown'},{startDate:'2026-02-30'},{endDate:'2026-09-27'},{endDate:'2028-01-01'},{startTime:'20:00'},{endTime:'25:00'},{reason:' '},{allDay:'true'},{allDay:true}]) {
      assert.equal((await employee.call('/api/work-requests',input(changes))).status,400);
    }
    assert.equal((await employee.call('/api/work-requests',input({startDate:'2026-09-27',endDate:'2026-09-29'}))).status,200);
    assert.equal((await employee.call('/api/work-requests',input())).status,409);
    assert.equal((await employee.call('/api/work-requests',input({type:'absence',startTime:'19:00',endTime:'21:00'}))).status,409);
    assert.equal((await other.call('/api/work-requests',input())).status,200);
    assert.equal((await employee.call('/api/work-requests',input({startTime:'20:00',endTime:'24:00'}))).status,200);
    for(const [i,type] of ['annual','monthly','early','absence'].entries()) {
      const date=`2026-10-0${i+1}`;
      assert.equal((await employee.call('/api/work-requests',input({type,startDate:date,endDate:date,allDay:type!=='early'}))).status,200);
    }
  }finally{f.db.close();}
});

test('승인·반려·재검토·수정은 버전 충돌과 중복 처리를 차단하고 불변 이력에 모두 보존',async()=>{
  const f=fixture();try {
    const {employee,admin}=await clients(f);
    let r=(await employee.call('/api/work-requests',input())).data;
    assert.equal((await admin.call('/api/admin/work-requests/decision',{id:r.id,version:1,action:'approved',comment:''})).status,400);
    r=(await decide(admin,r)).data;assert.equal(r.status,'approved');assert.equal(r.actor_login,'ADMIN');assert.ok(r.decided_at);
    assert.equal((await decide(admin,r)).status,409);
    assert.equal((await employee.call('/api/work-requests',{...input(),id:r.id,version:r.version,changeReason:'정정'})).status,409);
    r=(await decide(admin,r,'reopen')).data;
    assert.equal(r.status,'pending');
    assert.equal((await employee.call('/api/work-requests',{...input(),id:r.id,version:1,changeReason:'정정'})).status,409);
    r=(await employee.call('/api/work-requests',{...input({endTime:'21:00'}),id:r.id,version:r.version,changeReason:'시간 연장'})).data;
    r=(await decide(admin,r,'rejected')).data;
    r=(await employee.call('/api/work-requests',{...input(),id:r.id,version:r.version,changeReason:'다시 제출'})).data;
    r=(await decide(admin,r)).data;
    const events=(await employee.call('/api/work-requests/history?id='+r.id)).data;
    assert.deepEqual(events.map(e=>e.action),['created','approved','reopen','revised','rejected','revised','approved']);
    assert.equal(events[3].snapshot.end_minute,1260);
    assert.equal(events[4].snapshot.status,'rejected');
    assert.equal(events[1].snapshot.status,'approved');
    assert.equal(events[0].snapshot.reason,'추가 작업 필요');
    assert.throws(()=>f.db.prepare('DELETE FROM work_request_history WHERE request_id=?').run(r.id));
    assert.throws(()=>f.db.prepare("UPDATE work_request_history SET comment='changed' WHERE request_id=?").run(r.id));
    assert.throws(()=>f.db.prepare('DELETE FROM work_requests WHERE id=?').run(r.id));
    assert.equal((await admin.call('/api/admin/delete-preview',{id:'e1'})).status,409);
    assert.equal((await employee.call('/api/work-requests',{id:r.id},'DELETE')).status,404);
  }finally{f.db.close();}
});

test('반려 후 같은 기간 재신청 가능, 반려 건 재검토는 새 신청과 겹치면 차단',async()=>{
  const f=fixture();try {
    const {employee,admin}=await clients(f);
    const first=(await employee.call('/api/work-requests',input())).data;
    const rejected=(await decide(admin,first,'rejected')).data;
    assert.equal((await employee.call('/api/work-requests',input())).status,200);
    assert.equal((await decide(admin,rejected,'reopen')).status,409);
    assert.equal((await employee.call('/api/work-requests',{...input(),id:rejected.id,version:rejected.version,changeReason:'재신청'})).status,409);
  }finally{f.db.close();}
});

test('목록 날짜·직원·유형·상태 필터와 월/연 경계 집계, 부분 부재 중복 날짜 제거·기존 실적 조회',async()=>{
  const f=fixture();try {
    const {employee,other,admin}=await clients(f);
    async function approved(body) {const r=(await employee.call('/api/work-requests',body)).data;assert.equal((await decide(admin,r)).status,200);}
    await approved(input({startDate:'2026-12-31',endDate:'2027-01-02'}));
    // The full-day absence conflicts with overtime and must not enter totals.
    assert.equal((await employee.call('/api/work-requests',input({type:'annual',startDate:'2026-12-30',endDate:'2027-01-02',allDay:true}))).status,409);
    await approved(input({type:'annual',startDate:'2026-12-30',endDate:'2026-12-30',allDay:true}));
    await approved(input({type:'early',startDate:'2026-12-29',endDate:'2026-12-29',startTime:'15:00',endTime:'16:00'}));
    await approved(input({type:'absence',startDate:'2026-12-29',endDate:'2026-12-29',startTime:'16:00',endTime:'17:00'}));
    await other.call('/api/work-requests',input({type:'monthly'}));
    f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-12-29','2026-12-29T00:00:00Z','2026-12-29T08:00:00Z')").run();
    f.db.prepare("INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES('p1','e1','t1','조립','2026-12-29','2026-12-29T08:00:00Z',12,2,'test-key')").run();
    const filtered=await admin.call('/api/work-requests?from=2027-01-01&to=2027-01-01&employeeId=e1&type=overtime&status=approved');
    assert.equal(filtered.data.length,1);
    const monthly=(await admin.call('/api/admin/work-requests/report?year=2026&month=12&employeeId=e1')).data;
    assert.equal(monthly.summaries.length,1);
    const s=monthly.summaries[0];assert.equal(s.overtimeMinutes,120);assert.equal(s.absenceDates,2);assert.equal(s.approved,4);assert.equal(s.attendance.length,1);assert.equal(s.production[0].good,12);
    const next=(await admin.call('/api/admin/work-requests/report?year=2027')).data;
    assert.equal(next.summaries.find(s=>s.id==='e1').overtimeMinutes,240);
    assert.equal(next.summaries.find(s=>s.id==='e1').absenceDates,0);
    for(const q of ['year=x','year=2026&month=13','year=2026&month=1'])assert.equal((await admin.call('/api/admin/work-requests/report?'+q)).status,400);
    assert.equal((await admin.call('/api/work-requests?from=2026-12-31&to=2026-01-01')).status,400);
    assert.equal((await admin.call('/api/work-requests?status=unknown')).status,400);
  }finally{f.db.close();}
});

test('기존 계정·업무 기록을 보존하는 재연결과 다른 연결의 중복 신청·처리, 백업 복구 시 이력 유지',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'onwork-requests-')),path=join(dir,'test.sqlite');
  const f=fixture(path);let second;
  try {
    const {employee,admin}=await clients(f);
    const before=f.db.prepare('SELECT * FROM users ORDER BY id').all();
    second=openDatabase(path);
    assert.deepEqual(second.prepare('SELECT * FROM users ORDER BY id').all(),before);
    const app=createApplication(second,f.config,()=>new Date('2026-09-28T00:00:00Z'));
    const login=await app(new Request(f.config.origin+'/api/login',{method:'POST',headers:{origin:f.config.origin,'content-type':'application/json'},body:JSON.stringify({login:'001',password:f.password})}));
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const me=await (await app(new Request(f.config.origin+'/api/me',{headers:{cookie}}))).json();
    const send=()=>app(new Request(f.config.origin+'/api/work-requests',{method:'POST',headers:{cookie,origin:f.config.origin,'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify(input())}));
    const results=await Promise.all([employee.call('/api/work-requests',input()),send()]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const r=(await admin.call('/api/work-requests')).data[0];
    const decisions=await Promise.all([decide(admin,r),decide(admin,r)]);
    assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
    second.close();second=openDatabase(path);
    assert.equal(second.prepare('SELECT status FROM work_requests').get().status,'approved');
    assert.equal(second.prepare('SELECT count(*) n FROM work_request_history').get().n,2);
    const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');
    await createBackup(f.db,backup);await restoreBackup(backup,restored);
    const restoredDb=openDatabase(restored);
    try {for(const table of ['work_requests','work_request_history']) assert.deepEqual(restoredDb.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());} finally{restoredDb.close();}
  }finally{second?.close();f.db.close();rmSync(dir,{recursive:true,force:true});}
});
