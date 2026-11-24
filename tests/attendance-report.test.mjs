import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
const insert=(f,id,date,start,end)=>f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run(id,'e1',date,date+'T'+start+'+09:00',end?date+'T'+end+'+09:00':null);
const url='/api/admin/attendance-report?year=2026&month=12&employeeId=e1';

test('근태 조회·CSV·정정 서버 권한, 서버 출퇴근 원본과 중복 출근 차단',async()=>{
  const f=fixture();try{
    f.setTime('2026-12-03T08:20:00+09:00');const a=f.client(),e=f.client(),guest=f.client();await a.login('ADMIN');await e.login('001');
    for(const p of [url,'/api/admin/attendance-report/export?year=2026']){assert.equal((await e.call(p)).status,403);assert.equal((await guest.call(p)).status,401);}
    assert.equal((await e.call('/api/admin/attendance-report/adjust',{id:'x',startAt:null,reason:'조작'})).status,403);
    const punch=await e.call('/api/attendance',{action:'in',inAt:'1900-01-01T00:00:00Z'});assert.equal(punch.status,200);assert.equal(punch.data.record.inAt,'2026-12-02T23:20:00.000Z');
    assert.equal((await e.call('/api/attendance',{action:'in'})).status,409);
    let row=(await a.call(url)).data.rows[0];assert.equal(row.missingOut,true);assert.equal(row.basicMinutes,0);
    f.setTime('2026-12-03T17:30:00+09:00');await e.login('001');await a.login('ADMIN');
    assert.equal((await e.call('/api/attendance',{action:'out',outAt:'1900-01-01T00:00:00Z'})).status,200);
    row=(await a.call(url)).data.rows[0];assert.equal(row.basicMinutes,460);assert.equal(row.payrollBasicMinutes,480);assert.equal(row.lunchBreakMinutes,60);assert.equal(row.shortBreakMinutes,20);assert.equal(row.raw[0].outAt,'2026-12-03T08:30:00.000Z');
    assert.equal((await e.call('/api/state')).data.attendance.length,1);
    const before=f.db.prepare('SELECT * FROM attendance_originals').get();
    const adjust={id:row.raw[0].id,version:row.raw[0].version,startAt:row.raw[0].inAt,reason:'회사 지시 조기 작업'};
    assert.equal((await a.call('/api/admin/attendance-report/adjust',{...adjust,reason:''})).status,400);
    assert.equal((await a.call('/api/admin/attendance-report/adjust',adjust)).status,200);
    assert.equal((await a.call('/api/admin/attendance-report/adjust',adjust)).status,409);
    row=(await a.call(url)).data.rows[0];assert.equal(row.approvedExtraMinutes,10);assert.equal(row.adjustments[0].actor_login,'ADMIN');
    assert.deepEqual(f.db.prepare('SELECT * FROM attendance_originals').get(),before);
    const csv=await a.call('/api/admin/attendance-report/export?year=2026&month=12&employeeId=e1');assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(csv.data,/회사 지시 조기 작업/);assert.match(csv.data,/월간 합계/);
  }finally{f.db.close();}
});
test('모든 신청 유형의 승인·반려·처리자·이력과 실제 기록 대조',async()=>{
  const f=fixture();try{
    f.setTime('2026-12-10T20:00:00+09:00');const a=f.client(),e=f.client();await a.login('ADMIN');await e.login('001');
    let i=0;
    for(const type of ['overtime','annual','monthly','early','absence']){
      const date='2026-12-'+String(++i).padStart(2,'0'),body={type,startDate:date,endDate:date,allDay:false,startTime:'17:30',endTime:'19:00',reason:type+' 신청'};
      const created=await e.call('/api/work-requests',body);assert.equal(created.status,200);
      const action=i%2?'approved':'rejected';const decision=await a.call('/api/admin/work-requests/decision',{id:created.data.id,version:1,action,comment:'처리 근거'});assert.equal(decision.status,200);
      const hist=(await e.call('/api/work-requests/history?id='+created.data.id)).data;assert.equal(hist.length,2);assert.equal(hist[0].actor_login,'001');assert.equal(hist[1].actor_login,'ADMIN');assert.equal(hist[1].snapshot.reason,body.reason);assert.ok(hist[1].occurred_at);
    }
    let report=(await a.call(url)).data;assert.equal(report.rows.reduce((n,r)=>n+r.extraMinutes,0),0);assert.equal(report.rows.length,5);
    insert(f,'a1','2026-12-01','08:30:00','20:00:00');report=(await a.call(url)).data;assert.equal(report.rows[0].approvedExtraMinutes,90);assert.equal(report.rows[0].unapprovedExtraMinutes,60);
    assert.equal(report.rows.find(r=>r.date==='2026-12-03').leaveDays,1);assert.equal(report.rows.find(r=>r.date==='2026-12-05').absenceDays,1);
  }finally{f.db.close();}
});
test('확정본은 후속 승인·정정으로 자동 변경되지 않고 재확정은 사유·버전으로 보존',async()=>{
  const f=fixture();try{
    f.setTime('2027-01-02T12:00:00+09:00');const a=f.client();await a.login('ADMIN');insert(f,'a1','2026-12-01','08:30:00','17:30:00');
    let report=(await a.call(url+'&view=live')).data;
    const body={employeeId:'e1',month:'2026-12',revision:report.revision,version:0,reason:'월말 원본 확인'};
    assert.equal((await a.call('/api/admin/attendance-report/finalize',body)).status,200);
    assert.equal((await a.call('/api/admin/attendance-report/finalize',body)).status,409);
    assert.equal((await a.call('/api/admin/attendance',{id:'a1',version:1,inAt:'2026-12-01T09:30:00+09:00',outAt:'2026-12-01T17:30:00+09:00',reason:'실제 작업 시작 확인'})).status,200);
    const saved=(await a.call(url)).data.rows[0];assert.equal(saved.basicMinutes,460);assert.equal(saved.payrollBasicMinutes,480);assert.equal(saved.finalized,true);
    report=(await a.call(url+'&view=live')).data;assert.equal(report.rows[0].basicMinutes,400);assert.equal(report.rows[0].raw[0].inAt,'2026-12-01T08:30:00+09:00');assert.deepEqual(report.rows[0].correctionReasons,['실제 작업 시작 확인']);
    assert.equal((await a.call('/api/admin/attendance-report/finalize',{...body,revision:report.revision,version:1,reason:'확인된 정정 반영'})).status,200);
    assert.equal((await a.call(url)).data.rows[0].basicMinutes,400);assert.equal((await a.call(url)).data.rows[0].payrollBasicMinutes,420);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attendance_finalizations').get().n,2);
    assert.throws(()=>f.db.exec("UPDATE attendance_finalizations SET reason='변조'"));assert.throws(()=>f.db.exec("UPDATE attendance_originals SET in_at='변조'"));assert.throws(()=>f.db.exec('DELETE FROM attendance_policies'));
    insert(f,'open','2026-12-02','08:30:00',null);report=(await a.call(url+'&view=live')).data;
    assert.equal((await a.call('/api/admin/attendance-report/finalize',{...body,revision:report.revision,version:2})).status,409);
  }finally{f.db.close();}
});
test('기간·직원 필터·CSV 조회 버전, 과거 기준 적용일 안내와 잘못된 기간 거부',async()=>{
  const f=fixture();try{
    const a=f.client();await a.login('ADMIN');insert(f,'a1','2026-09-01','08:30:00','17:30:00');
    const report=(await a.call('/api/admin/attendance-report?from=2026-09-01&to=2026-09-01')).data;assert.equal(report.next,'e1');assert.match(report.rows[0].flags.join(),/기준 적용일 이전/);
    assert.equal((await a.call('/api/admin/attendance-report?from=2026-09-01&to=2026-09-01&after=e1&revision='+report.revision)).data.rows.length,0);
    f.db.prepare("UPDATE employees SET name='변경' WHERE id='e1'").run();
    assert.equal((await a.call('/api/admin/attendance-report/export?year=2026&revision='+report.revision)).status,409);
    for(const params of ['from=2026-01-02&to=2026-01-01','from=2026-02-30&to=2026-03-01','from=2025-01-01&to=2026-12-31','year=2026&month=13'])assert.equal((await a.call('/api/admin/attendance-report?'+params)).status,400);
    assert.equal((await a.call('/api/admin/attendance-report?year=2026&employeeId=e2')).data.rows.length,0);
  }finally{f.db.close();}
});
