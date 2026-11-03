import {localStamp} from './attendance-report.js';
import {captureDrafts,restoreDrafts,acceptForm,rememberForms,hasDrafts} from './drafts.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>localStamp(value)||'—';
const localInput=value=>value?stamp(value).replace(' ','T'):'';
const isoInput=value=>(value.length===16?value+':00':value)+'+09:00';
const minutes=value=>!Number.isFinite(value)?'미확정':Number(value.toFixed(2)).toLocaleString('ko-KR')+'분';
const paidTime=value=>!Number.isFinite(value)?'미확정':`${Math.floor(value/60)}시간 ${Number((value%60).toFixed(2)).toLocaleString('ko-KR')}분`;
const paidCell=r=>`${paidTime(r.payrollBasicMinutes)}${r.payrollBasicUnconfirmedDays?`<p class="small">미확정 ${r.payrollBasicUnconfirmedDays}일 · 확인된 소계 ${paidTime(r.payrollBasicKnownMinutes)}</p>`:''}`;
const types={overtime:'야근·추가근무',annual:'연차',monthly:'월차',early:'조퇴',absence:'결근'};
const statuses={pending:'대기',approved:'승인',rejected:'반려'};
const time=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;

export function mountAttendanceReports({root,api,employees,today}){
  let report=null,loadedParams=null,serial=0,selectedDetail=null;
  root.innerHTML=`<section class="card"><h2>직원별 근태 보고서</h2>
    <p>한국 시간 · 기본 08:30~17:30 · 오전 휴게 10:30~10:40 · 점심 12:30~13:30 · 오후 휴게 15:30~15:40</p>
    <p class="small">점심 60분은 무급, 오전·오후 휴게 각 10분은 유급입니다. 정상 하루는 기본 실근무 7시간 40분, 급여 인정 기본시간 8시간입니다. 출퇴근 구간과 겹치는 시간만 반영합니다. 급여 인정 기본시간은 08:30~17:30의 출근 기록 기준이며, 추가근무·유급휴가·수당·최종 급여는 별도입니다. 휴가·결근 날짜 수는 부분 부재도 1일이며 휴가 차감량이 아닙니다.</p>
    <form id="attendance-report-filter" class="request-form">
      <label>직원<select name="employeeId"><option value="">전체 직원</option>${employees.map(e=>`<option value="${esc(e.id)}">${esc(e.number)} · ${esc(e.name)}</option>`).join('')}</select></label>
      <label>기간 구분<select name="period"><option value="month">월간</option><option value="year">연간</option><option value="range">기간 지정</option></select></label>
      <label data-period-year>연도<input name="year" type="number" min="1900" max="9998" value="${today.slice(0,4)}" required></label>
      <label data-period-month>월<select name="month">${Array.from({length:12},(_,i)=>{const m=String(i+1).padStart(2,'0');return `<option value="${m}" ${m===today.slice(5,7)?'selected':''}>${i+1}월</option>`;}).join('')}</select></label>
      <label data-period-range hidden>시작일<input name="from" type="date" value="${today.slice(0,7)}-01"></label><label data-period-range hidden>종료일<input name="to" type="date" value="${today}"></label>
      <label>확정 자료<select name="view"><option value="saved">저장된 확정본 우선</option><option value="live">현재 기록으로 재계산 미리보기</option></select></label>
      <button class="primary">근태 조회</button><p role="alert" class="task-error wide"></p>
    </form><div class="employee-actions"><button id="attendance-csv" class="secondary" disabled>조회 결과 CSV 내려받기</button></div>
    <p data-attendance-status role="status"></p><p data-attendance-error role="alert" class="task-error"></p><div id="attendance-report-result"><p>직원과 기간을 선택해 조회하세요.</p></div></section>`;
  const form=root.querySelector('#attendance-report-filter'),result=root.querySelector('#attendance-report-result'),error=root.querySelector('[data-attendance-error]'),status=root.querySelector('[data-attendance-status]'),download=root.querySelector('#attendance-csv');
  function sync(){const mode=form.elements.period.value;for(const node of form.querySelectorAll('[data-period-year]'))node.hidden=mode==='range';for(const node of form.querySelectorAll('[data-period-month]'))node.hidden=mode!=='month';for(const node of form.querySelectorAll('[data-period-range]'))node.hidden=mode!=='range';form.elements.year.required=mode!=='range';form.elements.from.required=form.elements.to.required=mode==='range';}
  form.elements.period.onchange=sync;sync();
  const paramsFromForm=()=>{const values=Object.fromEntries(new FormData(form));return new URLSearchParams({employeeId:values.employeeId,view:values.view,...(values.period==='range'?{from:values.from,to:values.to}:{year:values.year,...(values.period==='month'?{month:values.month}:{})})});};
  async function load(params){
    const current=++serial;error.textContent='';status.textContent='근태를 조회하고 있습니다.';download.disabled=true;
    const query=new URLSearchParams(params),pages=[];let next=null,revision;
    do{
      if(next)query.set('after',next);if(revision!==undefined)query.set('revision',revision);
      const page=await api('/api/admin/attendance-report?'+query,undefined,true);
      if(current!==serial||!root.isConnected)return;
      if(revision!==undefined&&revision!==page.revision)throw Error('조회 중 변경이 있습니다. 다시 조회하세요.');
      revision=page.revision;pages.push(page);next=page.next;
    }while(next);
    report={...pages[0],rows:pages.flatMap(p=>p.rows),summaries:pages.flatMap(p=>p.summaries),finalizations:pages.flatMap(p=>p.finalizations)};
    loadedParams=new URLSearchParams(params);download.disabled=false;status.textContent=`${report.from} ~ ${report.to} · ${report.rows.length}개 일별 내역 · ${params.get('view')==='live'?'재계산 미리보기':'확정본 우선 조회'}`;
    drawResult();
  }
  form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;form.querySelector('[role=alert]').textContent='';try{await load(paramsFromForm());acceptForm(form);}catch(e){form.querySelector('[role=alert]').textContent=e.message;status.textContent='조회 미완료';}finally{button.disabled=false;}};
  function drawResult(){
    const drafts=captureDrafts(result);
    result.innerHTML=`<p class="small">기준 ${esc(report.policy.id)} · 적용일 ${esc(report.policy.effectiveFrom)}. 적용일 이전은 참고 계산입니다. 자정 이후 근무는 출근일에 합산합니다. 퇴근 누락은 시간을 보충하지 않으며 합계는 확인된 구간만 포함합니다. 조기 출근 구간은 기본 집계에서 제외하고 별도 확인 대상으로 남깁니다. 이전 확정본은 당시 기준을 유지하므로 급여 인정 기본시간이 미확정일 수 있습니다.</p>
      <h3>월간·연간 합계</h3><p class="small">기간 지정 시 해당 조회 범위의 월별·연도별 합계입니다.</p><div class="table-wrap"><table><thead><tr><th>사번 · 이름</th><th>월 / 연도</th><th>출근</th><th>휴가</th><th>결근</th><th>점심 / 휴게</th><th>기본 실근무</th><th>급여 인정 기본</th><th>추가 집계</th><th>승인 대조 추가</th><th>확인 대상 추가</th><th>지각 / 조퇴</th><th>확인 필요 / 퇴근 누락</th></tr></thead><tbody>${report.summaries.map(s=>`<tr><td>${esc(s.number)} ${esc(s.name)}</td><td>${esc(s.period)}</td><td>${s.attendanceDays}일</td><td>${s.leaveDays}일</td><td>${s.absenceDays}일</td><td>${minutes(s.lunchBreakMinutes)} / ${minutes(s.shortBreakMinutes)}</td><td>${minutes(s.basicMinutes)}</td><td data-paid-basic>${paidCell(s)}</td><td>${minutes(s.extraMinutes)}</td><td>${minutes(s.approvedExtraMinutes)}</td><td>${minutes(s.unapprovedExtraMinutes)}</td><td>${s.lateDays}일 / ${s.earlyDays}일</td><td>${s.reviewDays}일 / ${s.missingOutDays}일</td></tr>`).join('')||'<tr><td colspan="13">집계 자료가 없습니다.</td></tr>'}</tbody></table></div>
      <h3>일별 상세</h3><div class="table-wrap"><table><thead><tr><th>사번 · 이름</th><th>근무일</th><th>실제 출근</th><th>실제 퇴근</th><th>집계 시작</th><th>점심 / 휴게</th><th>기본 실근무 / 추가</th><th>급여 인정 기본</th><th>승인 대조 / 확인 대상 추가</th><th>출근 / 휴가 / 결근</th><th>지각 / 조퇴</th><th>승인·수정·확인</th></tr></thead><tbody>${report.rows.map((r,i)=>`<tr><td>${esc(r.number)} ${esc(r.name)}</td><td>${esc(r.date)}<p class="small">${r.finalized?`확정 v${r.finalizedVersion}`:'미확정'}</p></td><td>${r.raw.map(a=>stamp(a.inAt)).join('<br>')||'—'}</td><td>${r.raw.map(a=>stamp(a.outAt)).join('<br>')||'—'}</td><td>${stamp(r.accountingStart)}</td><td>${r.lunchBreakMinutes==null?`미분리 · 합계 ${minutes(r.breakMinutes)}`:`${minutes(r.lunchBreakMinutes)} / ${minutes(r.shortBreakMinutes)}`}</td><td>${minutes(r.basicMinutes)} / ${minutes(r.extraMinutes)}</td><td data-paid-basic>${paidCell(r)}</td><td>${minutes(r.approvedExtraMinutes)} / ${minutes(r.unapprovedExtraMinutes)}</td><td>${r.attendanceDays} / ${r.leaveDays} / ${r.absenceDays}</td><td>${minutes(r.lateMinutes)} / ${minutes(r.earlyMinutes)}${r.approvedEarly?' (조퇴 승인)':''}</td><td><button class="secondary" data-detail="${i}">상세·정정</button><p class="small">${esc(r.flags.join(' / '))}</p></td></tr>`).join('')||'<tr><td colspan="12">기록이 없습니다. 기록이 없는 날을 자동 결근으로 처리하지 않습니다.</td></tr>'}</tbody></table></div>
      <div data-attendance-detail></div>
      ${loadedParams.get('employeeId')&&loadedParams.get('month')&&loadedParams.get('view')==='live'?`<details class="request-item"><summary>이 직원의 월간 자료 확정·재확정</summary><p>종료된 월의 현재 조회 결과를 보존합니다. 미승인·충돌 표시는 함께 보존되며 승인이나 급여 확정을 대신하지 않습니다. 이후 신청·원본 정정으로 확정본이 자동 변경되지 않습니다. 재확정 시 이전 버전도 보존합니다.</p><form id="attendance-finalize"><label>확정·재확정 사유<textarea name="reason" maxlength="500" required></textarea></label><button class="primary">월간 확정본 저장</button><p role="alert" class="task-error"></p></form></details>`:'<p class="small">월간 확정본 저장은 직원 한 명·월간·재계산 미리보기를 선택한 뒤 사용할 수 있습니다.</p>'}`;
    if(selectedDetail){const selected=report.rows.find(r=>r.employeeId+':'+r.date===selectedDetail);if(selected)showDetail(selected,false);}
    restoreDrafts(result,drafts);
    result.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>showDetail(report.rows[Number(b.dataset.detail)]));
    bindMutation('#attendance-finalize',async body=>{
      const month=loadedParams.get('year')+'-'+loadedParams.get('month'),employeeId=loadedParams.get('employeeId');
      const previous=report.finalizations.find(f=>f.employee_id===employeeId&&f.month===month);
      await api('/api/admin/attendance-report/finalize',{...body,employeeId,month,revision:report.revision,version:previous?.version||0});
    });
  }
  function showDetail(r,interactive=true){
    const detail=result.querySelector('[data-attendance-detail]');
    if(interactive&&hasDrafts(detail)&&!confirm('입력 중인 사유를 버리고 다른 상세를 열까요?'))return;
    selectedDetail=r.employeeId+':'+r.date;
    detail.innerHTML=`<article class="request-item"><h3>${esc(r.number)} ${esc(r.name)} · ${r.date}</h3>
      ${r.finalized?`<p>확정 v${r.finalizedVersion} · ${esc(r.finalizedBy)} · ${stamp(r.finalizedAt)} · ${esc(r.finalizedReason)}</p>`:''}
      <h4>신청과 승인</h4>${r.requests.map(q=>`<p class="request-text">${esc(types[q.type])} · ${esc(statuses[q.status])} · ${q.start_date}~${q.end_date} ${time(q.start_minute)}~${time(q.end_minute)}<br>신청자: ${esc(r.number)} ${esc(r.name)} · 신청 ${stamp(q.created_at)}<br>신청 사유: ${esc(q.reason)}<br>처리자: ${esc(q.actor_login||'—')} · ${stamp(q.decided_at)} · ${esc(q.comment||'—')}</p>`).join('')||'<p>신청 없음</p>'}
      ${r.legacyApprovals.map(o=>`<p>기존 야근 검토: ${esc(statuses[o.status])} · ${esc(o.actor_login||o.actor_id)} · ${stamp(o.decided_at)} · ${esc(o.reason)}</p>`).join('')}
      <h4>정정·예외 이력</h4><p class="request-text">${esc(r.correctionReasons.join(' / ')||'출퇴근 정정 없음')}</p>${r.adjustments.map(a=>`<p class="request-text">v${a.version} · ${a.start_at?stamp(a.start_at):'기본 시작으로 복귀'} · ${esc(a.reason)} · ${esc(a.actor_login)} · ${stamp(a.created_at)}</p>`).join('')}
      ${r.raw.map(a=>`<p>실제 원본 ${stamp(a.inAt)} ~ ${stamp(a.outAt)}<br>정정 반영 시각 ${stamp(a.effectiveInAt)} ~ ${stamp(a.effectiveOutAt)}${a.source==='migration'?'<br>도입 시 보존된 원본입니다. 도입 이전 정정 내역은 감사 기록에 남아 있습니다.':''}</p>`).join('')}
      ${!r.finalized?r.raw.map(a=>`<form data-adjust="${esc(a.id)}" id="adjust-${esc(a.id)}" data-version="${a.version}" class="request-form"><h4 class="wide">집계 시작 예외 · 원본 유지</h4><label>집계 시작(한국 시간)<input name="startAt" type="datetime-local" step="1" value="${localInput(a.accountingStart)}" required></label><label class="wide">회사 지시·예외 사유<textarea name="reason" maxlength="500" required></textarea></label><button class="primary" value="save">예외 반영</button><button class="secondary" value="reset">기본 시작으로 복귀</button><p role="alert" class="task-error wide"></p></form>
        <details><summary>출퇴근 정정 · 퇴근 누락 보완</summary><form data-correct="${esc(a.id)}" id="correct-${esc(a.id)}" data-version="${a.version}" class="request-form"><label>확인된 출근(한국 시간)<input name="inAt" type="datetime-local" step="1" value="${localInput(a.effectiveInAt)}" required></label><label>확인된 퇴근(한국 시간)<input name="outAt" type="datetime-local" step="1" value="${localInput(a.effectiveOutAt)}"></label><label class="wide">확인 근거·정정 사유<textarea name="reason" maxlength="500" required></textarea></label><button class="primary">정정 반영</button><p class="small wide">서버가 기록한 원본은 보존하고 정정 시각을 별도로 반영합니다. 퇴근을 비우면 확인 필요로 남습니다.</p><p role="alert" class="task-error wide"></p></form></details>`).join(''):'<p>확정본을 정정하려면 재계산 미리보기에서 수정한 뒤 사유를 남겨 재확정하세요.</p>'}</article>`;
    bindMutation('[data-adjust]',async(body,f,button)=>{const a=r.raw.find(a=>a.id===f.dataset.adjust);await api('/api/admin/attendance-report/adjust',{...body,id:a.id,version:Number(f.dataset.version),startAt:button?.value==='reset'?null:isoInput(body.startAt)});});
    bindMutation('[data-correct]',async(body,f)=>{const a=r.raw.find(a=>a.id===f.dataset.correct);await api('/api/admin/attendance',{...body,id:a.id,version:Number(f.dataset.version),inAt:isoInput(body.inAt),outAt:body.outAt?isoInput(body.outAt):null});});
    rememberForms(detail);
    if(interactive)detail.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function bindMutation(selector,action){result.querySelectorAll(selector).forEach(f=>f.onsubmit=async event=>{event.preventDefault();const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);const message=f.querySelector('[role=alert]');message.textContent='';try{await action(Object.fromEntries(new FormData(f)),f,event.submitter);acceptForm(f);await load(loadedParams);}catch(e){if(f.isConnected)message.textContent=e.message;else error.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}});}
  download.onclick=async()=>{
    download.disabled=true;error.textContent='';status.textContent='CSV를 준비하고 있습니다.';
    try{
      const query=new URLSearchParams(loadedParams);query.set('revision',report.revision);let next=null;const chunks=[];
      do{if(next)query.set('after',next);const response=await fetch('/api/admin/attendance-report/export?'+query,{credentials:'same-origin',cache:'no-store'});
        if(!response.ok){const data=await response.json();throw Error(data.error||'CSV 내려받기에 실패했습니다.');}
        if(response.headers.get('X-Report-Revision')!==String(report.revision))throw Error('조회 이후 변경되었습니다. 다시 조회하세요.');
        chunks.push(await response.text());next=response.headers.get('X-Report-Next');
      }while(next);
      // Fetch's UTF-8 decoder removes a BOM, so put it back for Excel.
      const blob=new Blob(['\uFEFF',...chunks.map(s=>s.replace(/^\uFEFF/,''))],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`온워크_근태_${report.from}_${report.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='현재 조회 조건의 CSV를 내려받았습니다.';
    }catch(e){error.textContent=e.message;status.textContent='CSV 미완료';}finally{download.disabled=false;}
  };
  rememberForms(root);
  return {refresh(next={}){employees=next.employees||employees;if(loadedParams)load(loadedParams).catch(e=>{error.textContent=e.message;status.textContent='조회 미완료';});}};
}
