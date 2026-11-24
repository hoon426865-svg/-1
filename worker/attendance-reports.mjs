import {check,one,statement,audit} from './d1.mjs';
import {date} from '../lib/work-requests.mjs';
import {POLICY,buildRows,summarize,csvRows,dateAdd,at} from '../lib/attendance-calculation.mjs';

export function attendancePeriod(params){
  let from,to;
  if(params.get('from')||params.get('to')){from=date(params.get('from'));to=date(params.get('to'));}
  else{
    const year=params.get('year'),month=params.get('month');
    check(/^\d{4}$/.test(year||'')&&Number(year)>=1900&&Number(year)<=9998,400,'조회 연도를 확인하세요.');
    check(!month||/^(0[1-9]|1[0-2])$/.test(month),400,'조회 월을 확인하세요.');
    from=month?`${year}-${month}-01`:`${year}-01-01`;
    to=month?new Date(Date.UTC(Number(year),Number(month),0)).toISOString().slice(0,10):`${year}-12-31`;
  }
  check(to>=from&&at(to)-at(from)<366*86400000,400,'조회 기간은 순서대로 최대 366일입니다.');
  check(!params.get('view')||['saved','live'].includes(params.get('view')),400,'조회 방식을 확인하세요.');
  return {from,to};
}
const reason=value=>{check(typeof value==='string'&&value.trim().length>0&&value.trim().length<=500,400,'사유는 1~500자로 입력하세요.');return value.trim();};

// One employee per revision-bound page. Queries are batched and bounded; a
// large request history fails explicitly instead of silently dropping records.
export async function attendanceReport(db,user,params){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const {from,to}=attendancePeriod(params),employeeId=params.get('employeeId')||'',after=params.get('after')||'';
  check(employeeId.length<=100&&after.length<=100,400,'직원 조회 조건을 확인하세요.');
  const people=(await statement(db,`SELECT id,number,name FROM employees WHERE id>? ${employeeId?'AND id=?':''} ORDER BY id LIMIT 2`,employeeId?[after,employeeId]:[after]).all()).results;
  const person=people[0];
  if(!person)return {from,to,rows:[],summaries:[],next:null,policy:POLICY,finalizations:[]};
  const limit=2001;
  const queries=[
    statement(db,`SELECT a.*,o.in_at raw_in_at,o.out_at raw_out_at,o.source raw_source,
      (SELECT reason FROM audit WHERE target_id=a.id AND action='attendance_update' ORDER BY occurred_at DESC,id DESC LIMIT 1) correction_reason
      FROM attendance a LEFT JOIN attendance_originals o ON o.attendance_id=a.id WHERE a.employee_id=? AND a.date BETWEEN ? AND ? ORDER BY a.date LIMIT ${limit}`,[person.id,from,to]),
    statement(db,`SELECT * FROM work_requests WHERE employee_id=? AND end_date>=? AND start_date<=? ORDER BY start_date,id LIMIT ${limit}`,[person.id,from,dateAdd(to,7)]),
    statement(db,`SELECT c.* FROM attendance_adjustments c JOIN attendance a ON a.id=c.attendance_id WHERE a.employee_id=? AND a.date BETWEEN ? AND ? ORDER BY c.version LIMIT ${limit}`,[person.id,from,to]),
    statement(db,`SELECT o.*,u.login actor_login FROM overtime o JOIN attendance a ON a.id=o.attendance_id LEFT JOIN users u ON u.id=o.actor_id WHERE a.employee_id=? AND a.date BETWEEN ? AND ? LIMIT ${limit}`,[person.id,from,to]),
    statement(db,`SELECT f.* FROM attendance_finalizations f WHERE employee_id=? AND month BETWEEN ? AND ? AND version=(SELECT MAX(version) FROM attendance_finalizations x WHERE x.employee_id=f.employee_id AND x.month=f.month) ORDER BY month`,[person.id,from.slice(0,7),to.slice(0,7)]),
    statement(db,'SELECT * FROM attendance_policies WHERE id=?',[POLICY.id]),
  ];
  const [att,req,adj,old,snap,rules]=await db.batch(queries);
  check([att,req,adj,old].every(r=>r.results.length<limit),413,'기록이 많습니다. 직원·기간을 줄여 다시 조회하세요.');
  check(rules.results.length===1,503,'근태 기준 마이그레이션이 필요합니다.');
  const policy=JSON.parse(rules.results[0].definition_json);
  let rows=buildRows({person,attendance:att.results,requests:req.results,adjustments:adj.results,legacy:old.results,from,to,policy});
  if(params.get('view')!=='live')for(const saved of snap.results){
    rows=rows.filter(r=>r.date.slice(0,7)!==saved.month);
    rows.push(...JSON.parse(saved.rows_json).filter(r=>r.date>=from&&r.date<=to).map(r=>({...r,finalized:true,finalizedVersion:saved.version,finalizedAt:saved.created_at,finalizedBy:saved.actor_login,finalizedReason:saved.reason})));
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date));
  return {from,to,person,rows,summaries:summarize(rows),next:people.length>1?person.id:null,policy,
    finalizations:snap.results.map(({rows_json,...meta})=>meta)};
}
export async function adjustAttendance(db,tx,user,body,stamp){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const comment=reason(body.reason),record=await one(db,'SELECT * FROM attendance WHERE id=?',body.id??'');
  check(record,404,'출퇴근 기록을 찾을 수 없습니다.');
  check(record.version===body.version,409,'다른 변경이 있습니다. 다시 조회하세요.');
  const start=body.startAt===null?null:Date.parse(body.startAt);
  check(start===null||typeof body.startAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+09:00)$/.test(body.startAt)&&Number.isFinite(start)&&start>=Date.parse(record.in_at)&&start<=Date.parse(stamp)&&(!record.out_at||start<=Date.parse(record.out_at)),400,'집계 시작은 실제 출근 이후의 유효한 시각이어야 합니다.');
  const previous=await one(db,'SELECT * FROM attendance_adjustments WHERE attendance_id=? ORDER BY version DESC LIMIT 1',record.id);
  const item={id:crypto.randomUUID(),attendance_id:record.id,version:(previous?.version||0)+1,start_at:start===null?null:new Date(start).toISOString(),reason:comment,actor_id:user.id,actor_login:user.login,created_at:stamp};
  tx.add('INSERT INTO attendance_adjustments VALUES(?,?,?,?,?,?,?,?)',...Object.values(item));
  tx.add('UPDATE attendance SET version=version+1 WHERE id=?',record.id);
  audit(tx,user,'attendance_accounting_adjustment',record.id,comment,previous||null,item,stamp);
  return {ok:true};
}
export async function finalizeAttendance(db,tx,user,body,stamp){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const comment=reason(body.reason);
  check(typeof body.employeeId==='string'&&body.employeeId&&/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month||''),400,'확정할 직원과 월을 선택하세요.');
  check(body.revision===tx.revision,409,'조회 이후 변경이 있습니다. 다시 조회하고 확정하세요.');
  const params=new URLSearchParams({employeeId:body.employeeId,year:body.month.slice(0,4),month:body.month.slice(5),view:'live'});
  const report=await attendanceReport(db,user,params);
  check(report.person,404,'직원을 찾을 수 없습니다.');
  check(report.to<new Date(Date.parse(stamp)+9*3600000).toISOString().slice(0,10),409,'종료된 월만 확정할 수 있습니다.');
  check(report.rows.length>0,409,'확정할 근태 자료가 없습니다.');
  check(report.rows.every(r=>!r.missingOut&&r.date>=report.policy.effectiveFrom),409,'퇴근 누락 또는 기준 적용일 이전 자료는 확정할 수 없습니다.');
  const previous=report.finalizations[0];
  check((previous?.version||0)===(body.version||0),409,'확정본이 변경되었습니다. 다시 조회하세요.');
  const rows=JSON.stringify(report.rows);check(new TextEncoder().encode(rows).length<=1000000,413,'확정 자료가 너무 큽니다. 신청 이력을 확인하세요.');
  const item={id:crypto.randomUUID(),employee_id:body.employeeId,month:body.month,version:(previous?.version||0)+1,policy_id:report.policy.id,rows_json:rows,reason:comment,actor_id:user.id,actor_login:user.login,created_at:stamp};
  tx.add('INSERT INTO attendance_finalizations VALUES(?,?,?,?,?,?,?,?,?,?)',...Object.values(item));
  audit(tx,user,'attendance_finalize',item.id,comment,previous||null,{employeeId:body.employeeId,month:body.month,version:item.version},stamp);
  return {ok:true,version:item.version};
}
export function reportCsvResponse(report,revision,first=true){
  return new Response((first?'\uFEFF':'')+csvRows(report.rows,first),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="onwork-attendance-${report.from}-${report.to}.csv"`,'X-Report-Next':report.next||'','X-Report-Revision':String(revision)}});
}
