import {readFileSync} from 'node:fs';
import {attendanceReport,adjustAttendance,finalizeAttendance,reportCsvResponse} from '../worker/attendance-reports.mjs';
import {check} from '../worker/d1.mjs';
import {transaction} from './db.mjs';

export function installAttendance(db){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attendance_policies'").get()){
  const sql=readFileSync(new URL('../migrations/0005_attendance_reports.sql',import.meta.url),'utf8').split('-- worker_revision exists only on D1.')[0];
  transaction(db,()=>{
    db.exec(sql);
    db.exec('CREATE TABLE attendance_report_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT INTO attendance_report_revision VALUES(1,0);');
    for(const table of ['attendance','employees','work_requests','audit','overtime','attendance_originals','attendance_adjustments','attendance_finalizations','attendance_policies'])for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER attendance_report_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE attendance_report_revision SET revision=revision+1 WHERE id=1; END;`);
  });
  }
  if(!db.prepare('SELECT 1 FROM attendance_policies WHERE id=?').get('attendance-2026-11-03-v2')){
    transaction(db,()=>db.exec(readFileSync(new URL('../migrations/0006_paid_break_policy.sql',import.meta.url),'utf8')));
  }
}
function adapter(db){
  const wrap=(sql,args=[])=>({bind:(...args)=>wrap(sql,args),first:()=>db.prepare(sql).get(...args)||null,all:()=>({results:db.prepare(sql).all(...args)})});
  return {prepare:wrap,batch:statements=>statements.map(s=>s.all())};
}
export async function attendanceRoute(db,user,url,method,body,stamp){
  const path=url.pathname;if(!path.startsWith('/api/admin/attendance-report'))return null;
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const revision=()=>db.prepare('SELECT revision FROM attendance_report_revision WHERE id=1').get().revision;
  const initial=revision(),writes=[],tx={revision:initial,add:(sql,...args)=>writes.push([sql,args])},store=adapter(db);
  if(url.searchParams.has('revision'))check(String(initial)===url.searchParams.get('revision'),409,'조회 중 변경이 있습니다. 다시 조회하세요.');
  let result;
  if(['/api/admin/attendance-report','/api/admin/attendance-report/export'].includes(path)&&method==='GET'){
    result=await attendanceReport(store,user,url.searchParams);
    check(initial===revision(),409,'조회 중 변경이 있습니다. 다시 조회하세요.');
    if(path.endsWith('/export'))return reportCsvResponse(result,initial,!url.searchParams.get('after'));
    result={...result,revision:initial};
  }else if(path==='/api/admin/attendance-report/adjust'&&method==='POST')result=await adjustAttendance(store,tx,user,body,stamp);
  else if(path==='/api/admin/attendance-report/finalize'&&method==='POST')result=await finalizeAttendance(store,tx,user,body,stamp);
  else check(false,404,'API를 찾을 수 없습니다.');
  if(writes.length)transaction(db,()=>{check(initial===revision(),409,'다른 변경이 있습니다. 다시 조회하세요.');for(const [sql,args] of writes)db.prepare(sql).run(...args);});
  return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8'}});
}
