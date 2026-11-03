// Versioned attendance accounting. Durations are elapsed milliseconds until
// presentation; no rounding at punch/break boundaries and no payroll inference.
export const POLICY = Object.freeze({
  id:'attendance-2026-11-03-v1', effectiveFrom:'2026-11-03', timezone:'Asia/Seoul',
  startMinute:510, endMinute:1050,
  breaks:[{name:'오전 휴게',start:630,end:640,paid:null},{name:'점심',start:750,end:810,paid:null},{name:'오후 휴게',start:930,end:940,paid:null}],
  payroll:'unconfirmed', workday:'출근일 기준, 자정 이후도 같은 근무일',
});
export const labels={overtime:'야근·추가근무',annual:'연차',monthly:'월차',early:'조퇴',absence:'결근'};
export const statusLabels={pending:'대기',approved:'승인',rejected:'반려'};
const DAY=86400000, MINUTE=60000;
export const at=(date,minute=0)=>Date.parse(date+'T00:00:00+09:00')+minute*MINUTE;
export const localDate=value=>new Date(Number(value)+9*3600000).toISOString().slice(0,10);
export const dateAdd=(date,n)=>localDate(at(date)+n*DAY);
const iso=value=>Number.isFinite(value)?new Date(value).toISOString():null;
export function mergeIntervals(intervals){
  const result=[];
  for(const [start,end] of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0])){
    const last=result.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
  }
  return result;
}
const duration=intervals=>mergeIntervals(intervals).reduce((n,[a,b])=>n+b-a,0);
function intersections(left,right){return mergeIntervals(left.flatMap(([a,b])=>right.map(([c,d])=>[Math.max(a,c),Math.min(b,d)])));}
function subtract(left,right){
  let result=mergeIntervals(left);
  for(const [c,d] of mergeIntervals(right))result=result.flatMap(([a,b])=>d<=a||c>=b?[[a,b]]:[[a,Math.min(c,b)],[Math.max(d,a),b]]).filter(([a,b])=>b>a);
  return result;
}
function requestedIntervals(requests,from,to){
  const result=[];
  for(const r of requests)for(let d=r.start_date>from?r.start_date:from;d<=r.end_date&&d<=to;d=dateAdd(d,1))result.push([at(d,r.start_minute),at(d,r.end_minute)]);
  return mergeIntervals(result);
}
export function calculateDay({person,date,attendance=[],requests=[],adjustments=[],legacy=[],policy=POLICY}){
  const own=attendance.filter(a=>a.date===date), active=adjustments.filter(a=>own.some(r=>r.id===a.attendance_id));
  const flags=[],actual=[],counted=[],raw=[],corrections=[];
  let lateMs=0,earlyMs=0,missingOut=false;
  const basicWindow=[[at(date,policy.startMinute),at(date,policy.endMinute)]];
  const latest=new Map();for(const a of active)if(!latest.has(a.attendance_id)||a.version>latest.get(a.attendance_id).version)latest.set(a.attendance_id,a);
  for(const r of own){
    const start=Date.parse(r.in_at),end=r.out_at?Date.parse(r.out_at):null,adjustment=latest.get(r.id);
    const normalized=Math.max(start,at(date,policy.startMinute));
    const accountingStart=adjustment?.start_at?Date.parse(adjustment.start_at):normalized;
    raw.push({id:r.id,inAt:r.raw_in_at??r.in_at,outAt:Object.hasOwn(r,'raw_out_at')?r.raw_out_at:r.out_at,
      effectiveInAt:r.in_at,effectiveOutAt:r.out_at,accountingStart:iso(accountingStart),version:r.version,source:r.raw_source||'recorded'});
    if(end===null){missingOut=true;continue;}
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>DAY*7){flags.push('출퇴근 구간 확인 필요');continue;}
    actual.push([start,end]);counted.push([accountingStart,end]);
    if(adjustment)corrections.push(adjustment);
  }
  if(own.length){
    lateMs=Math.min(Math.max(0,Math.min(...own.map(r=>Date.parse(r.in_at)))-basicWindow[0][0]),basicWindow[0][1]-basicWindow[0][0]);
    if(!missingOut)earlyMs=Math.min(Math.max(0,basicWindow[0][1]-Math.max(...own.map(r=>Date.parse(r.out_at)))),basicWindow[0][1]-basicWindow[0][0]);
  }
  if(missingOut)flags.push('퇴근 누락 · 확인 필요');
  if(own.length>1)flags.push('중복 기록 · 구간 합집합 집계');
  const endDate=localDate(Math.max(at(date),...actual.map(x=>x[1]-1)));
  const breaks=[];
  for(let d=date;d<=endDate;d=dateAdd(d,1))for(const b of policy.breaks)breaks.push([at(d,b.start),at(d,b.end)]);
  const breakMs=duration(intersections(counted,breaks));
  const net=subtract(counted,breaks), actualNet=subtract(actual,breaks);
  const basic=intersections(net,basicWindow),extra=subtract(net,basicWindow);
  // The excluded pre-shift presence is still an observed extra interval and
  // remains a review item until an administrator explicitly accounts for it.
  const observedExtra=subtract(actualNet,basicWindow);
  const relevant=requests.filter(r=>r.end_date>=date&&r.start_date<=endDate);
  const approved=relevant.filter(r=>r.status==='approved');
  let authorized=requestedIntervals(approved.filter(r=>r.type==='overtime'),date,endDate);
  for(const r of own)if(legacy.some(o=>o.attendance_id===r.id&&o.status==='approved'))authorized.push(...extra);
  // An explicit early-start instruction is also an approval for that interval.
  for(const a of corrections)if(a.start_at)authorized.push([Date.parse(a.start_at),at(date,policy.startMinute)]);
  authorized=mergeIntervals(authorized);
  const approvedExtra=intersections(extra,authorized),unapproved=subtract(observedExtra,approvedExtra);
  if(duration(unapproved)>0)flags.push('미승인·집계 제외 추가기록 확인 필요');
  const dayRequests=relevant.filter(r=>r.start_date<=date&&r.end_date>=date);
  const leave=dayRequests.filter(r=>r.status==='approved'&&['annual','monthly'].includes(r.type));
  const absence=dayRequests.filter(r=>r.status==='approved'&&r.type==='absence');
  const leaveIntervals=requestedIntervals(leave,date,date), absenceIntervals=requestedIntervals(absence,date,date);
  if(duration(intersections(actual,[...leaveIntervals,...absenceIntervals]))>0)flags.push('승인 부재와 실제 출근 중복 확인 필요');
  if(date<policy.effectiveFrom)flags.push('기준 적용일 이전 · 참고 재계산');
  if(dayRequests.some(r=>r.status==='pending'))flags.push('신청 처리 대기');
  const approvedEarly=dayRequests.some(r=>r.type==='early'&&r.status==='approved');
  return {employeeId:person.id,number:person.number,name:person.name,date,raw,
    accountingStart:raw[0]?.accountingStart||null,breakMinutes:breakMs/MINUTE,
    basicMinutes:duration(basic)/MINUTE,extraMinutes:duration(extra)/MINUTE,
    observedExtraMinutes:duration(observedExtra)/MINUTE,approvedExtraMinutes:duration(approvedExtra)/MINUTE,
    unapprovedExtraMinutes:duration(unapproved)/MINUTE,attendanceDays:own.length?1:0,
    lateMinutes:lateMs/MINUTE,earlyMinutes:missingOut?null:earlyMs/MINUTE,approvedEarly,
    leaveDays:leave.length?1:0,leaveMinutes:duration(subtract(intersections(leaveIntervals,basicWindow),breaks))/MINUTE,
    absenceDays:absence.length?1:0,absenceMinutes:duration(subtract(intersections(absenceIntervals,basicWindow),breaks))/MINUTE,
    requests:relevant,legacyApprovals:legacy.filter(o=>own.some(a=>a.id===o.attendance_id)),
    adjustments:active,correctionReasons:own.map(r=>r.correction_reason).filter(Boolean),
    missingOut,flags:[...new Set(flags)],policyId:policy.id,policyEffectiveFrom:policy.effectiveFrom,
    payrollMinutes:null,finalized:false};
}
export function buildRows({person,attendance,requests,adjustments,legacy,from,to,policy=POLICY}){
  const dates=new Set(attendance.filter(r=>r.date>=from&&r.date<=to).map(r=>r.date));
  for(const r of requests)for(let d=r.start_date>from?r.start_date:from;d<=r.end_date&&d<=to;d=dateAdd(d,1))dates.add(d);
  return [...dates].sort().map(date=>calculateDay({person,date,attendance,requests,adjustments,legacy,policy}));
}
export function summarize(rows){
  const groups=new Map();
  for(const r of rows)for(const period of [r.date.slice(0,7),r.date.slice(0,4)]){
    const key=r.employeeId+':'+period;
    if(!groups.has(key))groups.set(key,{employeeId:r.employeeId,number:r.number,name:r.name,period,attendanceDays:0,leaveDays:0,absenceDays:0,basicMinutes:0,extraMinutes:0,approvedExtraMinutes:0,unapprovedExtraMinutes:0,breakMinutes:0,lateDays:0,earlyDays:0,reviewDays:0,missingOutDays:0,payrollMinutes:null});
    const s=groups.get(key);
    for(const k of ['attendanceDays','leaveDays','absenceDays','basicMinutes','extraMinutes','approvedExtraMinutes','unapprovedExtraMinutes','breakMinutes'])s[k]+=r[k];
    s.lateDays+=Number(r.lateMinutes>0);s.earlyDays+=Number(r.earlyMinutes>0);s.reviewDays+=Number(r.flags.length>0);s.missingOutDays+=Number(r.missingOut);
  }
  return [...groups.values()].sort((a,b)=>a.number.localeCompare(b.number)||a.period.localeCompare(b.period));
}
export const koreanStamp=value=>value?new Date(Date.parse(value)+9*3600000).toISOString().slice(0,19).replace('T',' '):'';
export const requestText=r=>`${labels[r.type]} ${r.start_date}~${r.end_date} ${String(Math.floor(r.start_minute/60)).padStart(2,'0')}:${String(r.start_minute%60).padStart(2,'0')}~${String(Math.floor(r.end_minute/60)).padStart(2,'0')}:${String(r.end_minute%60).padStart(2,'0')} ${statusLabels[r.status]} / 신청: ${r.reason} / 처리: ${r.actor_login||''} ${koreanStamp(r.decided_at)} ${r.comment||''}`;
// Quote all fields, protect spreadsheet formula prefixes, and retain UTF-8 BOM.
const csvCell=value=>'"'+String(value??'').replace(/^[\s]*[=+@-]/,x=>"'"+x).replaceAll('"','""')+'"';
export function csvRows(rows,header=true){
  const columns=['구분','사번','이름','근무일/기간','실제 출근(KST)','실제 퇴근(KST)','정정 출근(KST)','정정 퇴근(KST)','집계 시작(KST)','휴게(분)','기본근무(분)','추가 집계(분)','승인 대조 추가(분)','확인 대상 추가(분)','출근일수','지각(분/일)','조퇴(분/일)','휴가 날짜수','결근 날짜수','신청·처리 이력','수정·예외 사유','확인 사항','계산 기준','기준 적용일','확정','급여시간'];
  const values=rows.map(r=>['일별',r.number,r.name,r.date,r.raw.map(a=>koreanStamp(a.inAt)).join(' / '),r.raw.map(a=>koreanStamp(a.outAt)).join(' / '),r.raw.map(a=>a.inAt!==a.effectiveInAt?koreanStamp(a.effectiveInAt):'').join(' / '),r.raw.map(a=>a.outAt!==a.effectiveOutAt?koreanStamp(a.effectiveOutAt):'').join(' / '),koreanStamp(r.accountingStart),r.breakMinutes,r.basicMinutes,r.extraMinutes,r.approvedExtraMinutes,r.unapprovedExtraMinutes,r.attendanceDays,r.lateMinutes,r.earlyMinutes,r.leaveDays,r.absenceDays,r.requests.map(requestText).join(' | '),[...r.correctionReasons,...r.adjustments.map(a=>`${a.reason} (${a.actor_login} ${koreanStamp(a.created_at)})`)].join(' | '),r.flags.join(' / '),r.policyId,r.policyEffectiveFrom,r.finalized?`확정 v${r.finalizedVersion}`:'미확정','미확정']);
  for(const s of summarize(rows))values.push([s.period.length===4?'연간 합계':'월간 합계',s.number,s.name,s.period,'','','','','',s.breakMinutes,s.basicMinutes,s.extraMinutes,s.approvedExtraMinutes,s.unapprovedExtraMinutes,s.attendanceDays,s.lateDays,s.earlyDays,s.leaveDays,s.absenceDays,'','',`확인 ${s.reviewDays}일 / 퇴근 누락 ${s.missingOutDays}일`,'','','','미확정']);
  return (header?[columns]:[]).concat(values).map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
