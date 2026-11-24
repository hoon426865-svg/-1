import test from 'node:test';
import assert from 'node:assert/strict';
import {POLICY,calculateDay,buildRows,summarize,csvRows} from '../lib/attendance-calculation.mjs';
const person={id:'e1',number:'001',name:'한글 직원'},date='2026-11-03';
const shift=(start='08:30:00',end='17:30:00',extra={})=>({id:'a1',employee_id:'e1',date,in_at:`${date}T${start}+09:00`,out_at:end?`${date}T${end}+09:00`:null,version:1,...extra});
const request=(type,status='approved',extra={})=>({id:'r1',employee_id:'e1',type,status,start_date:date,end_date:date,start_minute:1050,end_minute:1140,reason:'신청 사유',actor_login:'ADMIN',decided_at:date+'T10:00:00Z',...extra});
const calculate=(attendance,extra={})=>calculateDay({person,date,attendance,requests:[],...extra});

test('08:30 경계와 초 단위 지각, 원본 보존 및 급여 미확정',()=>{
  for(const start of ['08:00:00','08:29:59','08:30:00']){
    const a=shift(start),r=calculate([a]);assert.equal(r.basicMinutes,460);assert.equal(r.breakMinutes,80);assert.equal(r.accountingStart,'2026-11-02T23:30:00.000Z');assert.equal(r.raw[0].inAt,a.in_at);assert.equal(r.lateMinutes,0);assert.equal(r.payrollMinutes,null);
  }
  const late=calculate([shift('08:30:01')]);assert.equal(late.basicMinutes,460-1/60);assert.equal(late.lateMinutes,1/60);
  assert.equal(calculate([shift('09:00:00')]).basicMinutes,430);
});
test('유급 휴게 20분과 무급 점심을 구분하고 기본 인정시간에만 반영한다',()=>{
  const cases=[['08:00:00','17:30:00',60,20,480],['08:30:01','17:30:00',60,20,480-1/60],['10:35:00','17:30:00',60,15,355],['12:45:00','17:30:00',45,10,240],['10:35:00','10:38:00',0,3,3],['08:30:00','12:45:00',15,10,240],['08:30:00','16:00:00',60,20,390],['12:45:00','13:00:00',15,0,0]];
  for(const [start,end,lunch,rest,paid] of cases){
    const r=calculate([shift(start,end)]);assert.equal(r.lunchBreakMinutes,lunch);assert.equal(r.shortBreakMinutes,rest);assert.equal(r.paidBasicBreakMinutes,rest);assert.ok(Math.abs(r.payrollBasicMinutes-paid)<1e-9,`${start}~${end}`);assert.equal(r.payrollMinutes,null);
  }
  const duplicated=calculate([shift(),shift('09:00:00','17:30:00',{id:'a2'})]);assert.equal(duplicated.payrollBasicMinutes,480);
  const extra=calculate([shift('08:30:00','19:30:00')]);assert.equal(extra.payrollBasicMinutes,480);assert.equal(extra.extraMinutes,120);
  const overnight=calculate([shift('17:00:00','13:00:00',{out_at:'2026-11-04T13:00:00+09:00'})]);assert.equal(overnight.shortBreakMinutes,10);assert.equal(overnight.paidBasicBreakMinutes,0);assert.equal(overnight.payrollBasicMinutes,30);
  const leave=request('annual','approved',{start_minute:510,end_minute:1050});assert.equal(calculate([],{requests:[leave]}).payrollBasicMinutes,0);
});
test('퇴근 누락·잘못된 구간·옛 기준·과거 확정본은 급여 인정시간을 자동 채우지 않는다',()=>{
  const open=calculate([shift('08:30:00',null)]),invalid=calculate([shift('17:30:00','08:30:00')]);
  assert.equal(open.payrollBasicMinutes,null);assert.equal(invalid.payrollBasicMinutes,null);
  const old=calculate([shift()],{policy:{...POLICY,id:'attendance-2026-11-03-v1',payroll:'unconfirmed',breaks:POLICY.breaks.map(b=>({...b,paid:null}))}});assert.equal(old.payrollBasicMinutes,null);
  assert.equal(calculate([shift()],{policy:{...POLICY,effectiveFrom:'2026-12-01'}}).payrollBasicMinutes,null);
  const good=calculate([shift()]);const mixed=summarize([good,{...open,date:'2026-11-04'}]);
  for(const s of mixed){assert.equal(s.payrollBasicMinutes,null);assert.equal(s.payrollBasicKnownMinutes,480);assert.equal(s.payrollBasicUnconfirmedDays,1);}
  const legacy={...good,finalized:true};for(const k of ['payrollBasicMinutes','paidBasicBreakMinutes','lunchBreakMinutes','shortBreakMinutes'])delete legacy[k];
  const serialized=JSON.stringify(legacy);assert.equal(summarize([legacy])[0].payrollBasicMinutes,null);assert.equal(JSON.stringify(legacy),serialized);
  assert.match(csvRows([legacy]),/미분리/);assert.match(csvRows([good]),/급여 인정 기본시간\(분\)/);
  assert.match(csvRows([good]),/"60","20","20","480","480","0"/);
});
test('겹치는 휴게만 공제: 휴게 중 출근·퇴근, 조퇴, 중복 구간 합집합',()=>{
  const cases=[['10:35:00','17:30:00',340,75],['12:45:00','17:30:00',230,55],['10:35:00','10:38:00',0,3],['08:30:00','12:45:00',230,25],['08:30:00','16:00:00',370,80]];
  for(const [start,end,net,rest] of cases){const r=calculate([shift(start,end)]);assert.equal(r.basicMinutes,net,`${start}~${end}`);assert.equal(r.breakMinutes,rest);}
  const r=calculate([shift(),shift('09:00:00','17:30:00',{id:'a2'})]);assert.equal(r.basicMinutes,460);assert.equal(r.breakMinutes,80);assert.equal(r.attendanceDays,1);
  const summary=summarize([r]);assert.equal(summary[0].attendanceDays,1);
});
test('퇴근 누락은 0시간·확인 필요, 자정 이후는 출근일 추가시간으로 귀속',()=>{
  const open=calculate([shift('08:30:00',null)]);assert.equal(open.basicMinutes,0);assert.equal(open.extraMinutes,0);assert.equal(open.earlyMinutes,null);assert.equal(open.missingOut,true);assert.match(open.flags.join(),/퇴근 누락/);
  const overnight=calculate([shift('17:00:00','02:00:00',{out_at:'2026-11-04T02:00:00+09:00'})]);assert.equal(overnight.basicMinutes,30);assert.equal(overnight.extraMinutes,510);assert.equal(overnight.date,date);assert.equal(overnight.attendanceDays,1);
  const long=calculate([shift('22:00:00','13:00:00',{out_at:'2026-11-04T13:00:00+09:00'})]);assert.equal(long.extraMinutes,860);assert.equal(long.breakMinutes,40);
});
test('승인만으로 실근무를 만들지 않고 실제 추가 구간과 교집합만 승인 집계',()=>{
  const r=request('overtime');assert.equal(calculate([],{requests:[r]}).extraMinutes,0);
  const approved=calculate([shift('08:30:00','19:30:00')],{requests:[r]});assert.equal(approved.extraMinutes,120);assert.equal(approved.approvedExtraMinutes,90);assert.equal(approved.unapprovedExtraMinutes,30);
  for(const status of ['pending','rejected']){const result=calculate([shift('08:30:00','19:30:00')],{requests:[{...r,status}]});assert.equal(result.extraMinutes,120);assert.equal(result.approvedExtraMinutes,0);assert.equal(result.unapprovedExtraMinutes,120);}
  const next=request('overtime','approved',{start_date:'2026-11-04',end_date:'2026-11-04',start_minute:0,end_minute:120});
  const over=calculate([shift('22:00:00',null,{out_at:'2026-11-04T03:00:00+09:00'})],{requests:[next]});assert.equal(over.approvedExtraMinutes,120);assert.equal(over.extraMinutes,300);
});
test('사유 있는 조기근무 예외만 집계하고 승인·예외 중복 공제/합산 방지',()=>{
  const a=shift('08:00:00'),adjustment={attendance_id:a.id,version:1,start_at:a.in_at,reason:'회사 지시',actor_login:'ADMIN',created_at:a.in_at};
  const r=calculate([a],{adjustments:[adjustment],requests:[request('overtime','approved',{start_minute:480,end_minute:510})]});
  assert.equal(r.basicMinutes,460);assert.equal(r.extraMinutes,30);assert.equal(r.approvedExtraMinutes,30);assert.equal(r.unapprovedExtraMinutes,0);assert.equal(r.raw[0].inAt,a.in_at);
  const reset=calculate([a],{adjustments:[adjustment,{...adjustment,version:2,start_at:null}]});assert.equal(reset.extraMinutes,0);assert.equal(reset.basicMinutes,460);
});
test('출근·휴가·결근 날짜를 분리하고 부분 휴가의 날짜 수와 시간 구분',()=>{
  const leave=request('annual','approved',{start_minute:510,end_minute:750});
  const monthly=request('monthly','approved',{id:'r2',start_minute:810,end_minute:1050});
  const rows=buildRows({person,attendance:[],requests:[leave,monthly],adjustments:[],legacy:[],from:date,to:date});
  assert.equal(rows.length,1);assert.equal(rows[0].leaveDays,1);assert.equal(rows[0].leaveMinutes,460);assert.equal(rows[0].attendanceDays,0);assert.equal(rows[0].absenceDays,0);assert.equal(rows[0].basicMinutes,0);
  const absence=calculate([],{requests:[request('absence','approved',{start_minute:0,end_minute:1440})]});assert.equal(absence.absenceDays,1);assert.equal(absence.leaveDays,0);
  assert.equal(calculate([],{requests:[{...leave,status:'pending'}]}).leaveDays,0);
});
test('CSV 한글·줄바꿈·따옴표·수식 주입 방어, 기준·합계 포함',()=>{
  const row=calculate([shift()],{person:{...person,name:'=1+1'},requests:[request('overtime','pending',{reason:'한글, "인용"\n다음 줄'})]});
  const csv=csvRows([row]);assert.match(csv,/'=1\+1/);assert.match(csv,/한글, ""인용""\n다음 줄/);assert.match(csv,/월간 합계/);assert.match(csv,/연간 합계/);assert.match(csv,new RegExp(POLICY.id));assert.match(csv,/미확정/);
});
