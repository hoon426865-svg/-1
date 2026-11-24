import {input,date,requestTypes} from '../lib/work-requests.mjs';
import {check,one,all} from './d1.mjs';
const required = value => {check(typeof value==='string' && value.trim().length>0 && value.trim().length<=500,400,'사유·의견은 1~500자로 입력하세요.');return value.trim();};
const day = value => Date.parse(value+'T00:00:00Z')/86400000;
const uuid = () => crypto.randomUUID();
export async function requestRow(db,id,user) {
  check(typeof id==='string',400,'신청 ID가 필요합니다.');
  const item=await one(db,'SELECT * FROM work_requests WHERE id=?',id);
  check(item && (user.role==='admin' || item.employee_id===user.employee_id),404,'신청을 찾을 수 없습니다.');return item;
}
async function overlap(db,employee,value,id='') {
  check(!await one(db,`SELECT 1 FROM work_requests WHERE employee_id=? AND id!=? AND status IN('pending','approved') AND start_date<=? AND end_date>=? AND start_minute<? AND end_minute>? LIMIT 1`,employee,id,value.end_date,value.start_date,value.end_minute,value.start_minute),409,'같은 시간에 대기 또는 승인된 신청이 있습니다.');
}
function history(tx,item,action,user,comment,now) {
  tx.add('INSERT INTO work_request_history VALUES(?,?,?,?,?,?,?,?,?)',uuid(),item.id,item.version,action,user.id,user.login,now,comment,JSON.stringify(item));
}
export async function saveRequest(db,tx,user,body,now) {
  check(user.role==='employee',403,'직원 계정으로 신청하세요.');
  const value=input(body),previous=body.id?await requestRow(db,body.id,user):null;
  if(previous){check(previous.version===body.version,409,'다른 변경이 있습니다.');check(previous.status!=='approved',409,'승인된 신청은 재검토가 필요합니다.');}
  const reason=previous?required(body.changeReason):value.reason;
  await overlap(db,user.employee_id,value,previous?.id);
  const id=previous?.id||uuid();
  const item={...previous,id,employee_id:user.employee_id,...value,status:'pending',version:(previous?.version||0)+1,created_at:previous?.created_at||now,updated_at:now,actor_id:null,actor_login:null,decided_at:null,comment:null};
  if(previous)tx.add(`UPDATE work_requests SET type=?,start_date=?,end_date=?,start_minute=?,end_minute=?,all_day=?,reason=?,status='pending',version=version+1,updated_at=?,actor_id=NULL,actor_login=NULL,decided_at=NULL,comment=NULL WHERE id=?`,...Object.values(value),now,id);
  else tx.add(`INSERT INTO work_requests(id,employee_id,type,start_date,end_date,start_minute,end_minute,all_day,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,id,user.employee_id,...Object.values(value),now,now);
  history(tx,item,previous?'revised':'created',user,reason,now);return item;
}
export async function decideRequest(db,tx,user,body,now) {
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  check(['approved','rejected','reopen'].includes(body.action),400,'처리 방법을 선택하세요.');
  const comment=required(body.comment),previous=await requestRow(db,body.id,user);
  check(previous.version===body.version,409,'다른 변경이 있습니다.');
  check(body.action==='reopen'?previous.status!=='pending':previous.status==='pending',409,'이미 처리되었거나 재검토 중입니다.');
  const status=body.action==='reopen'?'pending':body.action;
  if(status!=='rejected')await overlap(db,previous.employee_id,previous,previous.id);
  const item={...previous,status,version:previous.version+1,updated_at:now,actor_id:user.id,actor_login:user.login,decided_at:now,comment};
  tx.add('UPDATE work_requests SET status=?,version=version+1,updated_at=?,actor_id=?,actor_login=?,decided_at=?,comment=? WHERE id=?',status,now,user.id,user.login,now,comment,previous.id);
  history(tx,item,body.action,user,comment,now);return item;
}
// Explicit bounded pages, never silent truncation. The browser follows cursors.
export function page(params) {
  const value=params.get('after')||'';
  check(value.length<=100,400,'조회 커서를 확인하세요.');return value;
}
export async function listRequests(db,user,params) {
  const conditions=[],args=[];
  const add=(sql,value)=>{conditions.push(sql);args.push(value);};
  if(user.role==='employee')add('r.employee_id=?',user.employee_id);
  else if(params.get('employeeId'))add('r.employee_id=?',params.get('employeeId'));
  if(params.get('from'))add('r.end_date>=?',date(params.get('from')));
  if(params.get('to'))add('r.start_date<=?',date(params.get('to')));
  check(!params.get('from')||!params.get('to')||params.get('from')<=params.get('to'),400,'조회 기간 순서를 확인하세요.');
  for(const [key,allowed]of[['type',requestTypes],['status',['pending','approved','rejected']]])if(params.get(key)){check(allowed.includes(params.get(key)),400,'조회 조건을 확인하세요.');add(`r.${key}=?`,params.get(key));}
  if(page(params))add('r.id>?',page(params));
  const items=await all(db,`SELECT r.*,e.name employee_name,e.number employee_number FROM work_requests r JOIN employees e ON e.id=r.employee_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY r.id LIMIT 201`,...args);
  const more=items.length>200;return {items:items.slice(0,200),next:more?items[199].id:null};
}
export async function requestHistory(db,user,params) {
  await requestRow(db,params.get('id'),user);
  const items=await all(db,'SELECT * FROM work_request_history WHERE request_id=? AND version>? ORDER BY version LIMIT 201',params.get('id'),Number(params.get('after')||0));
  const more=items.length>200;
  return {items:items.slice(0,200).map(item=>({...item,snapshot:JSON.parse(item.snapshot_json),snapshot_json:undefined})),next:more?String(items[199].version):null};
}
export function reportPeriod(params) {
  const year=params.get('year'),month=params.get('month');
  check(/^\d{4}$/.test(year||'') && Number(year)>=1900 && Number(year)<=9998,400,'조회 연도를 확인하세요.');
  check(!month||/^(0[1-9]|1[0-2])$/.test(month),400,'조회 월을 확인하세요.');
  return {from:month?`${year}-${month}-01`:`${year}-01-01`,to:month?new Date(Date.UTC(Number(year),Number(month),0)).toISOString().slice(0,10):`${year}-12-31`};
}
export function summary(person,requests,attendance,production,from,to) {
  const own=requests.filter(r=>r.employee_id===person.id),absenceDates=new Set();let overtimeMinutes=0,absenceMinutes=0;
  for(const r of own.filter(r=>r.status==='approved')){
    const first=Math.max(day(from),day(r.start_date)),last=Math.min(day(to),day(r.end_date));
    if(r.type==='overtime')overtimeMinutes+=(last-first+1)*(r.end_minute-r.start_minute);
    else for(let d=first;d<=last;d++){absenceDates.add(d);absenceMinutes+=r.end_minute-r.start_minute;}
  }
  return {...person,requests:own.length,pending:own.filter(r=>r.status==='pending').length,approved:own.filter(r=>r.status==='approved').length,rejected:own.filter(r=>r.status==='rejected').length,overtimeMinutes,absenceDates:absenceDates.size,absenceMinutes,attendance:attendance.filter(r=>r.employee_id===person.id),production:production.filter(r=>r.employee_id===person.id)};
}
