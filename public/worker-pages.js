import {koreaNow} from './domain.js';

// Assemble revision-bound pages in the browser. Local Node responses remain
// unchanged. A concurrent change aborts the whole load rather than mixing rows.
export async function collectPages(path,first,fetchPage) {
  if(!first?.pageType)return first;
  const url=new URL(path,location.origin),result={...first};
  const arrays=first.pageType==='list'?['items']:first.pageType==='state'?['employees','tasks','attendance','production','overtime']:['employees','attendance','production','requests'];
  for(const key of arrays)result[key]=[...first[key]];
  let next=first.pageType==='list'?first.next:first.nextCursor;
  while(next){
    url.searchParams.set(first.pageType==='list'?'after':'cursor',next);
    url.searchParams.set('revision',String(first.revision));
    const page=await fetchPage(url.pathname+url.search);
    if(page.pageType!==first.pageType||page.revision!==first.revision)throw Error('조회 중 변경이 있습니다. 다시 조회하세요.');
    for(const key of arrays)result[key].push(...page[key]);
    next=first.pageType==='list'?page.next:page.nextCursor;
  }
  if(first.pageType==='list')return result.items.sort((a,b)=>a.start_date?b.start_date.localeCompare(a.start_date)||b.created_at.localeCompare(a.created_at):a.version&&b.version?a.version-b.version:0);
  if(first.pageType==='state'){
    result.employees=result.employees.map(e=>({...e,active:Boolean(e.active)})).sort((a,b)=>a.number.localeCompare(b.number));
    result.tasks.sort((a,b)=>a.name.localeCompare(b.name));
    result.attendance=result.attendance.map(r=>({id:r.id,employeeId:r.employee_id,date:r.date,in:koreaNow(new Date(r.in_at)).time,out:r.out_at?koreaNow(new Date(r.out_at)).time:null,outDate:r.out_at?koreaNow(new Date(r.out_at)).date:null,inAt:r.in_at,outAt:r.out_at,version:r.version})).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
    result.production=result.production.map(r=>({id:r.id,employeeId:r.employee_id,taskId:r.task_id,task:r.task_name,date:r.date,time:koreaNow(new Date(r.recorded_at)).time,good:r.good,bad:r.bad,version:r.version})).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
    return result;
  }
  result.employees.sort((a,b)=>a.number.localeCompare(b.number));
  const people=new Map(result.employees.map(e=>[e.id,e]));
  result.requests=result.requests.map(r=>({...r,employee_name:people.get(r.employee_id)?.name,employee_number:people.get(r.employee_id)?.number})).sort((a,b)=>b.start_date.localeCompare(a.start_date)||b.created_at.localeCompare(a.created_at));
  result.summaries=result.employees.map(person=>reportSummary(person,result));return result;
}
export function reportSummary(person,{requests,attendance,production,from,to}) {
  const own=requests.filter(r=>r.employee_id===person.id),absenceDates=new Set(),day=value=>Date.parse(value+'T00:00:00Z')/86400000;
  let overtimeMinutes=0,absenceMinutes=0;
  for(const r of own.filter(r=>r.status==='approved')){
    const first=Math.max(day(from),day(r.start_date)),last=Math.min(day(to),day(r.end_date));
    if(r.type==='overtime')overtimeMinutes+=(last-first+1)*(r.end_minute-r.start_minute);
    else for(let d=first;d<=last;d++){absenceDates.add(d);absenceMinutes+=r.end_minute-r.start_minute;}
  }
  return {...person,requests:own.length,pending:own.filter(r=>r.status==='pending').length,approved:own.filter(r=>r.status==='approved').length,rejected:own.filter(r=>r.status==='rejected').length,overtimeMinutes,absenceDates:absenceDates.size,absenceMinutes,attendance:attendance.filter(r=>r.employee_id===person.id).sort((a,b)=>a.date.localeCompare(b.date)),production:production.filter(r=>r.employee_id===person.id).sort((a,b)=>a.date.localeCompare(b.date))};
}
