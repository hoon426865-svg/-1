import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceDay, buildAttendanceReport, attendanceCsv, attendanceStartTime} from '../public/attendance-report.js';
import {fixture} from './helpers.mjs';
const stamp = (time, date='2026-11-03') => new Date(`${date}T${time}+09:00`).toISOString();
const record = (start, end, more={}) => ({id:'a1',employee_id:'e1',date:'2026-11-03',in_at:stamp(start),out_at:end?stamp(end):null,version:1,...more});
const request = (from, to, more={}) => ({id:'r1',employee_id:'e1',type:'overtime',start_date:'2026-11-03',end_date:'2026-11-03',start_minute:from,end_minute:to,status:'approved',reason:'검사 사유',...more});
const employee = {id:'e1',number:'001',name:'시험 직원',team:'생산팀',active:1};
const report = (attendance, more={}) => buildAttendanceReport({employees:[employee],attendance,from:'2026-11-01',to:'2026-11-30',...more});

test('08:30 전·정각·이후 집계: 초 단위 보존, 실제 시각 불변, 정상일 7시간40분',()=>{
  for(const [start,expected,late] of [['08:10:00',460*60,0],['08:29:59',460*60,0],['08:30:00',460*60,0],['08:30:01',460*60-1,1],['08:42:00',448*60,720]]){
    const source=record(start,'17:30:00'),before=JSON.stringify(source),r=attendanceDay(source);
    assert.equal(r.totalSeconds,expected);assert.equal(r.lateSeconds,late);assert.equal(r.breakSeconds,4800);
    assert.equal(JSON.stringify(source),before);
    assert.equal(r.calculationStartAt,stamp(start<'08:30:00'?'08:30:00':start));
  }
  assert.equal(attendanceStartTime({in:'08:10:00'}),'08:30:00');
  assert.equal(attendanceStartTime({in:'08:42:00'}),'08:42:00');
});

test('휴게와 겹치는 부분만 공제, 조퇴·정규 시작 전 퇴근의 음수 시간 방지',()=>{
  const lunch=attendanceDay(record('12:45:00','13:45:00'));
  assert.equal(lunch.breakSeconds,45*60);assert.equal(lunch.regularSeconds,15*60);
  const partial=attendanceDay(record('10:35:00','10:45:00'));
  assert.equal(partial.breakSeconds,5*60);assert.equal(partial.totalSeconds,5*60);
  const early=attendanceDay(record('08:10:00','08:20:00'));
  assert.equal(early.totalSeconds,0);assert.equal(early.earlyReviewSeconds,600);
  assert.equal(early.additionalSeconds,0);
});

test('추가근무는 실제 구간만 대조하며 조기근무·중복 승인·반려 기록을 구분',()=>{
  const requests=[request(490,510),request(1080,1140),request(1080,1140),request(1140,1170,{status:'rejected'})];
  const r=attendanceDay(record('08:10:00','19:30:00'),requests);
  assert.equal(r.regularSeconds,460*60);assert.equal(r.approvedEarlySeconds,20*60);
  assert.equal(r.additionalSeconds,140*60);assert.equal(r.approvedAdditionalSeconds,80*60);
  assert.equal(r.reviewAdditionalSeconds,60*60);assert.equal(r.totalSeconds,600*60);
  const legacy=attendanceDay(record('08:10:00','19:30:00'),[],[{attendance_id:'a1',status:'approved'}]);
  assert.equal(legacy.approvedAdditionalSeconds,120*60);assert.equal(legacy.earlyReviewSeconds,20*60);
  const none=report([], {requests});assert.equal(none.summaries[0].totalSeconds,0);
});

test('월말·자정 넘는 근무는 출근일 귀속, 다음 달 승인 구간과 대조',()=>{
  const r=attendanceDay(record('20:00:00',null,{date:'2026-11-30',in_at:stamp('20:00:00','2026-11-30'),out_at:stamp('02:00:00','2026-12-01')}),[request(0,120,{start_date:'2026-12-01',end_date:'2026-12-01'})]);
  assert.equal(r.regularSeconds,0);assert.equal(r.totalSeconds,6*3600);
  assert.equal(r.approvedAdditionalSeconds,2*3600);assert.equal(r.reviewAdditionalSeconds,4*3600);
});

test('퇴근 누락·중복·비정상 구간은 합계 제외, 휴가 날짜와 출근일수 분리',()=>{
  const open=record('08:10:00',null),duplicate=record('09:00:00','17:30:00',{id:'a2'});
  const r=report([open]);assert.equal(r.summaries[0].attendanceDays,1);assert.equal(r.summaries[0].workedDays,0);
  assert.equal(r.summaries[0].incompleteDays,1);assert.equal(r.summaries[0].rows[0].totalSeconds,null);
  const dupe=report([open,duplicate]).summaries[0];
  assert.equal(dupe.attendanceDays,1);assert.equal(dupe.totalSeconds,0);assert.equal(dupe.incompleteDays,1);
  assert.ok(dupe.rows.every(r=>r.status==='duplicate'));
  assert.equal(attendanceDay(record('08:30:00',null,{out_at:stamp('08:30:01','2026-11-05')})).status,'invalid');
  const malformed=report([record('08:30:00',null,{in_at:'invalid'})]);
  assert.equal(malformed.summaries[0].rows[0].status,'invalid');
  assert.doesNotThrow(()=>attendanceCsv(malformed));
  const leave=report([], {requests:[request(0,1440,{type:'annual',start_date:'2026-10-31',end_date:'2026-11-02'})]}).summaries[0];
  assert.equal(leave.absenceDates.annual,2);assert.equal(leave.attendanceDays,0);assert.equal(leave.totalSeconds,0);
});

test('CSV는 실제·집계 시각, 사번 문자열, 한글·줄바꿈·수식 공격 및 미확정 상태 보존',()=>{
  const r=report([record('08:10:00','17:30:00')],{employees:[{...employee,name:'=1+1',team:'가,"나"\n다'}]});
  const daily=attendanceCsv(r),summary=attendanceCsv(r,'summary');
  assert.ok(daily.startsWith('\uFEFF'));assert.match(daily,/"001","'=1\+1"/);
  assert.match(daily,/"가,""나""\n다"/);assert.match(daily,/2026-11-03 08:10:00/);assert.match(daily,/2026-11-03 08:30:00/);
  assert.match(summary,/7시간 40분/);assert.match(summary,/급여 미확정/);
  assert.match(attendanceCsv(report([record('08:10:00',null)])),/퇴근 미기록/);
});

test('Node 관리자 근태 보고서 권한·직원 필터·승인 대조·원본 기록 보존',async()=>{
  const f=fixture();try{
    const admin=f.client(),e=f.client(),guest=f.client();await admin.login('ADMIN');await e.login('001');
    f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run('a1','e1','2026-11-03',stamp('08:10:00'),stamp('17:30:00'));
    f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run('a2','e2','2026-11-03',stamp('08:42:00'),stamp('17:30:00'));
    const before=f.db.prepare('SELECT * FROM attendance ORDER BY id').all();
    const path='/api/admin/work-requests/report?year=2026&month=11&employeeId=e1';
    assert.equal((await guest.call(path)).status,401);assert.equal((await e.call(path)).status,403);
    const data=(await admin.call(path)).data;
    assert.equal(data.attendanceReport.summaries.length,1);
    assert.equal(data.attendanceReport.summaries[0].totalSeconds,460*60);
    assert.deepEqual(f.db.prepare('SELECT * FROM attendance ORDER BY id').all(),before);
    assert.equal(data.attendanceReport.summaries[0].rows[0].inAt,stamp('08:10:00'));
  }finally{f.db.close();}
});
