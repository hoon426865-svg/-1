const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountTestDataReset({root,api,employees,onChange}){
  let items=[],selection=new Set(),revision=null,next=null,query=null,preview=null,generation=0,busy=false;
  root.innerHTML=`<section class="card reset-card"><h2>테스트 데이터 초기화</h2>
    <p>테스트 기록만 골라 삭제합니다. 직원 명부·계정·패스키·작업 종류·근무 기준은 유지합니다.</p>
    <p class="small">삭제 전 복구용 사본을 서버에 보관하며 내려받을 수 있습니다. 기존 감사 기록과 삭제 이력은 보존합니다. 실제 운영 기록이 포함되지 않았는지 확인하세요.</p>
    <form id="test-reset-filter" class="request-form"><label>자료 종류<select name="kind"><option value="attendance">출퇴근</option><option value="production">생산량</option><option value="work_requests">신청·승인</option><option value="attendance_finalizations">월별 확정 자료</option></select></label>
    <label>직원<select name="employeeId"><option value="">전체 직원</option>${employees.map(e=>`<option value="${esc(e.id)}">${esc(e.number)} · ${esc(e.name)}</option>`).join('')}</select></label>
    <label>시작일<input name="from" type="date"></label><label>종료일<input name="to" type="date"></label><button class="secondary">삭제할 기록 조회</button></form>
    <p data-reset-status role="status"></p><p data-reset-error role="alert" class="task-error"></p>
    <div data-reset-list></div><div class="employee-actions"><button type="button" data-reset-next class="secondary" hidden>다음 50건</button><button type="button" data-reset-preview class="secondary" disabled>선택한 기록 삭제 대상 확인</button></div>
    <div data-reset-confirm></div><details class="request-item"><summary>최근 삭제 이력 · 복구 사본</summary><button type="button" class="secondary" data-reset-backups>삭제 이력 조회</button><div data-reset-history></div></details></section>`;
  const filter=root.querySelector('form'),list=root.querySelector('[data-reset-list]'),status=root.querySelector('[data-reset-status]'),error=root.querySelector('[data-reset-error]'),confirm=root.querySelector('[data-reset-confirm]'),prepare=root.querySelector('[data-reset-preview]'),nextButton=root.querySelector('[data-reset-next]');
  const invalidate=()=>{preview=null;confirm.innerHTML='';};
  const lock=value=>{busy=value;for(const node of root.querySelectorAll('button,input,select,textarea'))node.disabled=value;if(!value)prepare.disabled=selection.size===0;};
  const selectedStatus=()=>{prepare.disabled=selection.size===0;status.textContent=`현재 목록 ${items.length}건 · 선택 ${selection.size}건 (한 번에 최대 50건)`;};
  function draw(){
    list.innerHTML=items.length?`<div class="table-wrap" tabindex="0" aria-label="삭제할 테스트 기록"><table><thead><tr><th><label><input type="checkbox" data-reset-all aria-label="현재 목록 전체 선택">전체 선택</label></th><th>직원</th><th>날짜 / 월</th><th>내역</th></tr></thead><tbody>${items.map((r,i)=>`<tr><td><input type="checkbox" data-reset-item="${i}" aria-label="${esc(r.number)} ${esc(r.date)} 기록 선택"></td><td>${esc(r.number)} ${esc(r.name)}</td><td>${esc(r.date)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>`:'<p>해당 조건의 기록이 없습니다.</p>';
    for(const box of list.querySelectorAll('[data-reset-item]'))box.onchange=()=>{const id=items[Number(box.dataset.resetItem)].id;box.checked?selection.add(id):selection.delete(id);invalidate();const all=list.querySelector('[data-reset-all]');all.checked=selection.size===items.length;all.indeterminate=selection.size>0&&selection.size<items.length;selectedStatus();};
    const all=list.querySelector('[data-reset-all]');if(all)all.onchange=()=>{selection=new Set(all.checked?items.map(r=>r.id):[]);for(const box of list.querySelectorAll('[data-reset-item]'))box.checked=all.checked;invalidate();selectedStatus();};
    nextButton.hidden=!next;selectedStatus();
  }
  async function load(continuing=false){
    if(!continuing)query=new URLSearchParams(new FormData(filter));
    const current=++generation;invalidate();selection.clear();error.textContent='';lock(true);status.textContent='기록을 조회하고 있습니다.';
    const params=new URLSearchParams(query);if(continuing){params.set('after',next);params.set('revision',revision);}
    try{const data=await api('/api/admin/test-data/items?'+params);if(current!==generation||!root.isConnected)return;items=data.items;revision=data.revision;next=data.next;draw();}
    catch(e){items=[];next=null;list.innerHTML='';nextButton.hidden=true;error.textContent=e.message;status.textContent='조회 미완료';}
    finally{if(current===generation)lock(false);}
  }
  filter.onsubmit=e=>{e.preventDefault();if(!busy)load();};
  filter.onchange=()=>{generation++;invalidate();selection.clear();items=[];next=null;list.innerHTML='';prepare.disabled=true;nextButton.hidden=true;status.textContent='변경한 조건으로 다시 조회하세요.';};
  nextButton.onclick=()=>{if(!busy)load(true);};
  prepare.onclick=async()=>{
    if(busy)return;lock(true);error.textContent='';invalidate();
    try{
      const data=await api('/api/admin/test-data/preview',{kind:query.get('kind'),ids:[...selection],revision});if(!root.isConnected)return;preview=data;
      confirm.innerHTML=`<section class="reset-confirm"><h3>삭제 대상 최종 확인</h3><p>선택한 기록 ${data.selected}건과 아래 연결 기록을 삭제합니다.</p><ul>${data.counts.map(c=>`<li>${esc(c.label)}: <strong>${c.count}건</strong></li>`).join('')}</ul><p>${esc(data.notice)}</p>
      <p class="small">이 확인은 10분간 유효합니다. 기록이 바뀌면 다시 조회해야 합니다.</p><form id="test-reset-execute"><label>삭제 사유<textarea name="reason" required maxlength="500" placeholder="예: 시범 운영 전 테스트 기록 정리"></textarea></label><label>아래에 ‘테스트 기록 삭제’를 직접 입력하세요<input name="confirmation" required autocomplete="off"></label><button class="danger">복구 사본 보관 후 선택 기록 삭제</button><button type="button" class="secondary" data-reset-cancel>취소</button></form></section>`;
      confirm.querySelector('[data-reset-cancel]').onclick=invalidate;
      confirm.querySelector('form').onsubmit=async event=>{
        event.preventDefault();if(busy||!preview)return;const body=Object.fromEntries(new FormData(event.currentTarget));lock(true);error.textContent='';
        try{const done=await api('/api/admin/test-data/execute',{...body,previewId:preview.id});invalidate();selection.clear();items=[];list.innerHTML='';nextButton.hidden=true;status.textContent='선택한 테스트 기록을 삭제했습니다. 복구 사본은 삭제 이력에서 내려받을 수 있습니다.';await history();await onChange?.();return done;}
        catch(e){error.textContent=e.message;}
        finally{lock(false);}
      };
    }catch(e){error.textContent=e.message;}
    finally{lock(false);}
  };
  async function history(){
    const area=root.querySelector('[data-reset-history]');
    try{const rows=await api('/api/admin/test-data/backups');if(!root.isConnected)return;area.innerHTML=rows.map(r=>`<article class="request-item"><p>${esc(r.created_at)} · ${esc(r.actor_login)}</p><p class="request-text">${esc(r.reason)}</p><p>${JSON.parse(r.counts_json).map(c=>`${esc(c.label)} ${c.count}건`).join(' · ')}</p><a href="/api/admin/test-data/backup?id=${encodeURIComponent(r.id)}" download>복구 사본 내려받기</a></article>`).join('')||'<p>삭제 이력이 없습니다.</p>';}
    catch(e){area.textContent=e.message;}
  }
  root.querySelector('[data-reset-backups]').onclick=history;
  return {refresh({employees:updated}={}){invalidate();if(updated){const select=filter.elements.employeeId,value=select.value;select.innerHTML='<option value="">전체 직원</option>'+updated.map(e=>`<option value="${esc(e.id)}">${esc(e.number)} · ${esc(e.name)}</option>`).join('');select.value=updated.some(e=>e.id===value)?value:'';}}};
}
