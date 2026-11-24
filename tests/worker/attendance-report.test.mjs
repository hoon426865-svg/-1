import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,applySql} from './helpers.mjs';
import {POLICY,calculateDay} from '../../lib/attendance-calculation.mjs';
const query='/api/admin/attendance-report?year=2026&month=10&employeeId=e1';
test('유급 휴게 정책 추가는 v1 확정본을 보존하고 재계산에서만 8시간을 제공한다',async()=>{
  const f=await fixture({attendanceMigration:false});try{
    await f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('paid-a1','e1','2026-12-01','2026-12-01T08:30:00+09:00','2026-12-01T17:30:00+09:00')").run();
    await applySql(f.db,'migrations/0005_attendance_reports.sql');
    const oldPolicy=await f.db.prepare('SELECT * FROM attendance_policies').first();
    const oldRow=calculateDay({person:{id:'e1',number:'001',name:'테스트 직원'},date:'2026-12-01',attendance:[await f.db.prepare('SELECT * FROM attendance').first()],policy:JSON.parse(oldPolicy.definition_json)});
    for(const k of ['payrollBasicMinutes','paidBasicBreakMinutes','lunchBreakMinutes','shortBreakMinutes'])delete oldRow[k];
    await f.db.prepare('INSERT INTO attendance_finalizations VALUES(?,?,?,?,?,?,?,?,?,?)').bind('old-final','e1','2026-12',1,oldPolicy.id,JSON.stringify([oldRow]),'기존 월말 확인','admin','ADMIN','2027-01-01T00:00:00Z').run();
    const preserved=['users','employees','passkeys','attendance','attendance_originals','attendance_finalizations'];
    const before=await Promise.all(preserved.map(t=>f.db.prepare('SELECT * FROM '+t).all()));
    await applySql(f.db,'migrations/0006_paid_break_policy.sql');await applySql(f.db,'migrations/0006_paid_break_policy.sql');
    for(let i=0;i<preserved.length;i++)assert.deepEqual((await f.db.prepare('SELECT * FROM '+preserved[i]).all()).results,before[i].results);
    assert.deepEqual(await f.db.prepare('SELECT * FROM attendance_policies WHERE id=?').bind(oldPolicy.id).first(),oldPolicy);
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT definition_json FROM attendance_policies WHERE id=?').bind(POLICY.id).first()).definition_json),POLICY);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM attendance_policies').first()).n,2);
    const a=f.client();await a.login('ADMIN');const q='/api/admin/attendance-report?year=2026&month=12&employeeId=e1';
    const saved=(await a.call(q)).data;assert.equal(saved.rows[0].finalized,true);assert.equal(saved.rows[0].payrollBasicMinutes,undefined);assert.equal(saved.summaries[0].payrollBasicMinutes,null);
    const live=(await a.call(q+'&view=live')).data;assert.equal(live.rows[0].basicMinutes,460);assert.equal(live.rows[0].payrollBasicMinutes,480);assert.equal(live.rows[0].lunchBreakMinutes,60);assert.equal(live.rows[0].shortBreakMinutes,20);
    const csv=await a.call('/api/admin/attendance-report/export?year=2026&month=12&employeeId=e1&view=live');assert.match(csv.data,/"60","20","20","480","480","0"/);
  }finally{await f.close();}
});
test('D1 근태 마이그레이션은 기존 계정·출퇴근·신청·패스키 테이블을 보존한다',async()=>{
  const f=await fixture({attendanceMigration:false});try{
    await f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-10-01','2026-09-30T23:20:00.000Z','2026-10-01T09:30:00.000Z')").run();
    const tables=['users','employees','attendance','work_requests','work_request_history','production','passkeys','passkey_account_state'];
    const before=await Promise.all(tables.map(t=>f.db.prepare('SELECT * FROM '+t).all()));
    await applySql(f.db,'migrations/0005_attendance_reports.sql');
    await applySql(f.db,'migrations/0006_paid_break_policy.sql');
    for(let i=0;i<tables.length;i++)assert.deepEqual((await f.db.prepare('SELECT * FROM '+tables[i]).all()).results,before[i].results);
    assert.equal((await f.db.prepare('SELECT * FROM attendance_originals').first()).source,'migration');
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    const a=f.client(),e=f.client();assert.equal((await a.login('ADMIN')).status,200);await e.login('001');
    const report=await a.call(query);assert.equal(report.status,200);assert.equal(report.data.rows[0].basicMinutes,460);assert.equal(report.data.rows[0].extraMinutes,60);
    assert.equal((await e.call(query)).status,403);assert.equal((await e.call('/api/admin/attendance-report/export?year=2026')).status,403);
    assert.equal((await e.call('/api/admin/attendance-report/finalize',{employeeId:'e1'})).status,403);
    assert.equal((await e.call('/api/state')).data.attendance.length,1);
  }finally{await f.close();}
});
test('D1 실제 승인 대조·원본 보존·관리자 집계 예외·CSV·revision 충돌',async()=>{
  const f=await fixture();try{
    await f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-10-01','2026-09-30T23:20:00.000Z','2026-10-01T10:30:00.000Z')").run();
    const a=f.client(),e=f.client(),g=f.client();await a.login('ADMIN');await e.login('001');
    assert.equal((await g.call(query)).status,401);
    const created=await e.call('/api/work-requests',{type:'overtime',startDate:'2026-10-01',endDate:'2026-10-01',startTime:'17:30',endTime:'18:30',allDay:false,reason:'추가 작업'});assert.equal(created.status,200);
    assert.equal((await a.call('/api/admin/work-requests/decision',{id:created.data.id,version:1,action:'approved',comment:'시간 확인'})).status,200);
    let report=(await a.call(query)).data;assert.equal(report.rows[0].approvedExtraMinutes,60);assert.equal(report.rows[0].unapprovedExtraMinutes,70);
    const raw=await f.db.prepare('SELECT * FROM attendance_originals').first();
    assert.equal((await a.call('/api/admin/attendance-report/adjust',{id:'a1',version:1,startAt:raw.in_at,reason:'지시된 조기 작업'})).status,200);
    assert.equal((await a.call(query+'&revision='+report.revision)).status,409);
    report=(await a.call(query)).data;assert.equal(report.rows[0].approvedExtraMinutes,70);assert.equal(report.rows[0].extraMinutes,130);
    assert.equal((await a.call('/api/admin/attendance',{id:'a1',version:2,inAt:raw.in_at,outAt:'2026-10-01T18:30:00+09:00',reason:'관리자 확인'})).status,200);
    assert.deepEqual(await f.db.prepare('SELECT * FROM attendance_originals').first(),raw);
    report=(await a.call(query)).data;assert.equal(report.rows[0].extraMinutes,70);
    const csv=await a.call('/api/admin/attendance-report/export?year=2026&month=10&employeeId=e1&revision='+report.revision);
    assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(csv.data,/지시된 조기 작업/);assert.match(csv.data,/관리자 확인/);assert.match(csv.data,/2026-10-01 19:30:00/);
    await assert.rejects(f.db.prepare("UPDATE attendance_adjustments SET reason='bad'").run());
    assert.equal((await a.call('/api/admin/attendance-report/adjust',{id:'a1',version:3,startAt:'2026-09-30T22:00:00Z',reason:'기록 이전 위조'})).status,400);
  }finally{await f.close();}
});
