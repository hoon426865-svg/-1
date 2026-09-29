const types = {overtime:'야근·추가 근무',annual:'연차',monthly:'월차',early:'조퇴',absence:'결근·기타 부재'};
const statuses = {pending:'대기',approved:'승인',rejected:'반려'};
const actions = {created:'최초 신청',revised:'수정·재신청',approved:'승인',rejected:'반려',reopen:'재검토'};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = minute => `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const stamp = value => value ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}) : '—';
const options = (items,value) => Object.entries(items).map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('');
const period = r => `${esc(r.start_date)} ~ ${esc(r.end_date)} · ${r.all_day?'종일':`${clock(r.start_minute)} ~ ${clock(r.end_minute)} (매일)`}`;
export function mountWorkRequests({root,api,me,employees,today}) {
  const admin = me.role === 'admin';
  let items=[], filters={}, editing=null, history=null, report=null, serial=0;
  let reportFilters={year:today.slice(0,4),month:'',employeeId:''};
  const employeeOptions = () => '<option value="">전체 직원</option>'+employees.map(e=>`<option value="${esc(e.id)}">${esc(e.number)} · ${esc(e.name)}</option>`).join('');
  function form(r={}) {
    return `<form id="work-form" class="request-form"><label>유형<select name="type">${options(types,r.type)}</select></label>
      <label>시작일<input type="date" name="startDate" value="${esc(r.start_date||today)}" required></label><label>종료일<input type="date" name="endDate" value="${esc(r.end_date||today)}" required></label>
      <label>시간 구분<select name="allDay"><option value="false" ${!r.all_day?'selected':''}>시간 지정</option><option value="true" ${r.all_day?'selected':''}>종일 부재</option></select></label>
      <label>매일 시작 시각<input type="time" name="startTime" value="${clock(r.start_minute??18*60)}"></label><label>매일 종료 시각<input name="endTime" placeholder="20:00 또는 24:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" value="${clock(r.end_minute??20*60)}"></label>
      <label class="wide">신청 사유<textarea name="reason" maxlength="500" required>${esc(r.reason)}</textarea></label>
      ${r.id?'<label class="wide">변경 사유<textarea name="changeReason" maxlength="500" required></textarea></label>':''}
      <p class="small wide">기간 내 모든 날짜에 같은 시간이 적용됩니다. 주말·공휴일도 포함되므로 제외할 날짜는 나누어 신청하세요. 자정을 넘는 근무는 날짜별로 나누어 입력하세요. 종일 부재는 00:00~24:00로 기록하며 휴가 차감량을 의미하지 않습니다.</p>
      <button class="primary">${r.id?'수정 후 재신청':'신청하기'}</button>${r.id?'<button type="button" class="secondary" id="cancel-edit">수정 취소</button>':''}<p role="alert" class="task-error wide"></p></form>`;
  }
  function draw() {
    if(!root.isConnected) return;
    root.innerHTML = `<section class="card" id="work-requests"><h2>${admin?'근무 변경 신청 관리':'내 근무 변경 신청'}</h2>
      <p>신청·승인 기록을 보존합니다. 연차·월차 부여, 잔여 일수, 자동 차감은 계산하지 않습니다.</p>
      ${admin?'':form(editing||{})}
      <form id="work-filter" class="request-form"><label>기간 시작<input name="from" type="date" value="${esc(filters.from)}"></label><label>기간 종료<input name="to" type="date" value="${esc(filters.to)}"></label>
      ${admin?`<label>직원<select name="employeeId">${employeeOptions()}</select></label>`:''}<label>유형<select name="type"><option value="">전체 유형</option>${options(types,filters.type)}</select></label><label>상태<select name="status"><option value="">전체 상태</option>${options(statuses,filters.status)}</select></label><button class="secondary">조회</button><p role="alert" class="task-error wide"></p></form>
      <p class="small">조회 기간과 겹치는 신청을 표시합니다. 대기·승인 신청은 유형에 관계없이 같은 시간에 중복할 수 없습니다.</p>
      <div class="request-list">${items.map(r=>`<article class="request-item"><h3>${esc(types[r.type])} · ${esc(statuses[r.status])} ${admin?`· ${esc(r.employee_number)} ${esc(r.employee_name)}`:''}</h3><p>${period(r)}</p><p class="request-text">${esc(r.reason)}</p>
        <p class="small">신청 ${stamp(r.created_at)} · 버전 ${r.version}</p><p class="request-text">최근 관리자 처리: ${esc(r.actor_login||'—')} · ${stamp(r.decided_at)} · ${esc(r.comment||'—')}</p>
        <div class="employee-actions"><button class="secondary" data-history="${esc(r.id)}">변경·처리 이력</button>${!admin&&r.status!=='approved'?`<button class="secondary" data-edit="${esc(r.id)}">수정·재신청</button>`:''}</div>
        ${admin?`<form data-decision="${esc(r.id)}" class="request-form"><label>처리<select name="action">${r.status==='pending'?'<option value="approved">승인</option><option value="rejected">반려</option>':'<option value="reopen">재검토로 되돌리기</option>'}</select></label><label class="wide">관리자 의견·정정 사유<textarea name="comment" maxlength="500" required></textarea></label><button class="primary">처리 저장</button><p role="alert" class="task-error wide"></p></form>`:''}</article>`).join('')||'<p class="empty">신청이 없습니다.</p>'}</div>
      <div id="work-history">${history?`<h3>변경·처리 이력</h3>${history.map(h=>`<article class="request-item"><strong>버전 ${h.version} · ${esc(actions[h.action])} · ${esc(h.actor_login)} · ${stamp(h.occurred_at)}</strong><p class="request-text">${esc(h.comment)}</p><p>${esc(types[h.snapshot.type])} · ${esc(statuses[h.snapshot.status])} · ${period(h.snapshot)}</p><p class="request-text">신청 사유: ${esc(h.snapshot.reason)}</p></article>`).join('')}`:''}</div>
      <p class="small">승인된 신청을 정정하려면 관리자가 의견을 남겨 재검토로 돌린 후 직원이 수정합니다. 재검토 중에는 승인 집계에서 제외되며 이전 승인·반려 기록은 이력에 남습니다.</p><p id="work-error" role="alert" class="task-error"></p></section>
      ${admin?`<section class="card"><h2>직원별 월간·연간 내역</h2><form id="work-report" class="request-form"><label>연도<input name="year" type="number" min="1900" max="9998" value="${today.slice(0,4)}" required></label><label>월<select name="month"><option value="">연간 전체</option>${Array.from({length:12},(_,i)=>`<option value="${String(i+1).padStart(2,'0')}">${i+1}월</option>`).join('')}</select></label><label>직원<select name="employeeId">${employeeOptions()}</select></label><button class="secondary">집계 조회</button><p role="alert" class="task-error wide"></p></form><div id="report-result">${report?reportView(report):'<p>연도와 월을 선택해 조회하세요.</p>'}</div></section>`:''}`;
    if(admin) {
      root.querySelector('#work-filter [name="employeeId"]').value=filters.employeeId||'';
      for(const [key,value] of Object.entries(reportFilters)) root.querySelector(`#work-report [name="${key}"]`).value=value;
    }
    const requestForm=root.querySelector('#work-form');
    if(requestForm) {
      const timeMode=requestForm.elements.allDay;
      const syncTimes=()=>{for(const key of ['startTime','endTime']) {requestForm.elements[key].disabled=timeMode.value==='true';requestForm.elements[key].required=timeMode.value!=='true';}};
      timeMode.onchange=syncTimes;syncTimes();
    }
    const bind = (selector,fn) => root.querySelectorAll(selector).forEach(f=>{ f.onsubmit=async e=>{
      e.preventDefault();const error=f.querySelector('[role="alert"]');error.textContent='';const button=f.querySelector('button');button.disabled=true;
      try { await fn(Object.fromEntries(new FormData(f)),f); } catch(err) { if(f.isConnected) error.textContent=err.message; }
      finally { button.disabled=false; }
    }; });
    bind('#work-filter',async body=>{filters=body;await reload();});
    bind('#work-form',async body=>{
      await api('/api/work-requests',{...body,allDay:body.allDay==='true',...(editing?{id:editing.id,version:editing.version}:{})});
      editing=null;history=null;await reload();
    });
    bind('[data-decision]',async(body,f)=>{const r=items.find(r=>r.id===f.dataset.decision);await api('/api/admin/work-requests/decision',{...body,id:r.id,version:r.version});history=null;report=null;await reload();});
    bind('#work-report',async(body,f)=>{const result=await api('/api/admin/work-requests/report?'+new URLSearchParams(body));if(f.isConnected){reportFilters=body;report=result;root.querySelector('#report-result').innerHTML=reportView(report);bindReportHistory();}});
    root.querySelector('#cancel-edit')?.addEventListener('click',()=>{editing=null;draw();});
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{editing=items.find(r=>r.id===b.dataset.edit);draw();root.querySelector('#work-form').scrollIntoView({behavior:'smooth',block:'start'});});
    bindReportHistory();
  }
  function bindReportHistory() {
    root.querySelectorAll('[data-history]').forEach(b=>b.onclick=async()=>{
      try {const result=await api('/api/work-requests/history?id='+encodeURIComponent(b.dataset.history));if(!root.isConnected)return;history=result;draw();root.querySelector('#work-history').scrollIntoView({behavior:'smooth',block:'start'});}
      catch(error){if(root.isConnected)root.querySelector('#work-error').textContent=error.message;}
    });
  }
  async function reload() {
    const current=++serial, result=await api('/api/work-requests?'+new URLSearchParams(filters));
    if(current!==serial||!root.isConnected)return;items=result;draw();
  }
  draw();
  reload().catch(error=>{if(root.isConnected)root.querySelector('#work-error').textContent=error.message;});
}
function reportView(report) {
  return `<p>${esc(report.from)} ~ ${esc(report.to)} · 신청 대상 날짜 기준, 최신 처리 상태 집계</p><p class="small">부재 일수는 승인된 부재가 있는 날짜의 중복 없는 수입니다. 부분 시간 부재도 해당 날짜 1일로 표시하며 휴가 차감 일수가 아닙니다. 추가 근무는 승인된 신청 시간으로, 실제 출퇴근 시간과 별개입니다.</p>
    <div class="table-wrap"><table><thead><tr><th>직원</th><th>신청</th><th>대기 / 승인 / 반려</th><th>승인 추가 근무</th><th>승인 부재 날짜 수</th><th>출근 기록</th><th>양품 / 불량</th></tr></thead><tbody>${report.summaries.map(s=>`<tr><td>${esc(s.number)} ${esc(s.name)}</td><td>${s.requests}</td><td>${s.pending} / ${s.approved} / ${s.rejected}</td><td>${(s.overtimeMinutes/60).toLocaleString('ko-KR',{maximumFractionDigits:2})}시간</td><td>${s.absenceDates}일</td><td>${s.attendance.length}건</td><td>${s.production.reduce((n,r)=>n+r.good,0)} / ${s.production.reduce((n,r)=>n+r.bad,0)}</td></tr>`).join('')}</tbody></table></div>
    ${report.summaries.map(s=>`<details class="request-item"><summary>${esc(s.number)} ${esc(s.name)} 상세 내역</summary><h3>신청·처리</h3>${report.requests.filter(r=>r.employee_id===s.id).map(r=>`<p>${esc(types[r.type])} · ${period(r)} · ${esc(statuses[r.status])} · ${esc(r.actor_login||'—')} · ${stamp(r.decided_at)} · ${esc(r.comment||'—')} <button class="secondary" data-history="${esc(r.id)}">이력</button></p>`).join('')||'<p>신청 없음</p>'}<h3>출퇴근</h3>${s.attendance.map(r=>`<p>${esc(r.date)} · ${stamp(r.in_at)} ~ ${stamp(r.out_at)}</p>`).join('')||'<p>기록 없음</p>'}<h3>생산량</h3>${s.production.map(r=>`<p>${esc(r.date)} · ${esc(r.task_name)} · 양품 ${r.good} / 불량 ${r.bad}</p>`).join('')||'<p>기록 없음</p>'}</details>`).join('')}`;
}
