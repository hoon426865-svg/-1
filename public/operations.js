import {mountCatalogImport} from './catalog-import.js';
import {captureDrafts,restoreDrafts,acceptForm,hasDrafts} from './drafts.js';
import {isDeliveryItem,normalizeDrawing,resolveDrawing} from './operations-domain.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={pending:'검토·검사 대기',approved:'생산 승인',rejected:'반려',released:'사용 가능',held:'부적합 보류',delivered:'납품 완료',cancelled:'등록 취소',receipt:'입고',production:'생산 완료',issue:'출고',adjust:'재고 조정',dispose:'폐기',pass:'합격',fail:'불합격',incoming:'수입검사',process:'공정검사',shipping:'출하검사'};
const stamp=v=>new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
const input=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} required></label>`;
const area=(name,label,value='',max=500,required=true)=>`<label class="wide">${label}<textarea name="${name}" maxlength="${max}" ${required?'required':''}>${esc(value)}</textarea></label>`;
const select=(name,label,entries,value='')=>`<label>${label}<select name="${name}" required>${entries.map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
const end=(label='저장',extra='')=>`<div class="ops-form-actions wide">${extra}<button class="primary" type="submit">${label}</button></div><p role="alert" class="task-error wide"></p></form>`;
const form=(id,version='')=>`<form id="${id}" class="request-form" data-version="${version}">`;
const badge=status=>`<span class="ops-status ops-${status}">${labels[status]||esc(status)}</span>`;
const details=(title,content)=>`<details class="ops-detail"><summary>${title}</summary>${content}</details>`;

export function mountOperations({root,api,me,tasks=[],mode,onChange=()=>{}}){
  const section=mode.replace('ops-','');
  let context={items:[],permissions:{}},rows=[],history=[],users=[],page=0,more=false,serial=0,editing=null,selectedItem=null,selectedLot=null,message='';
  let qualityMode='deliveries',deliveryAction='inspect',selectedReview=null;
  let filters={text:'',status:''},catalogRoot=null,catalogImporter=null,pendingRefresh=false;
  const entryDefaults={materials:{},deliveries:{}},inFlight=new Set();
  const direct=()=>section==='quality'&&qualityMode==='deliveries';
  const keys=new Map(),call=(path,body)=>api('/api/operations/'+path,body);
  const items=()=>context.items.filter(i=>i.active);
  const drawingInput=(kind,value='')=>`<label class="wide">도면번호<input name="drawing" data-drawing="${kind}" list="ops-drawings-${kind}" value="${esc(value)}" maxlength="80" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="도번 입력 · 하이픈 생략 가능" required><datalist id="ops-drawings-${kind}"></datalist></label><input type="hidden" name="itemId" value="${esc(resolveDrawing(context.items,value).item?.id||'')}"><div class="wide ops-item-match" data-item-match role="status">도면번호를 입력하면 품명과 모델을 확인할 수 있습니다.</div>`;
  const quantity=(name,label,value='',min=0)=>input(name,label,value,'number',`min="${min}" max="999999" step="1" inputmode="numeric" placeholder="수량 입력"`);
  const reason=(value='',label='처리 사유 / 참조번호')=>`<label class="wide">${label}<input name="reason" value="${esc(value)}" maxlength="500" placeholder="작업 사유 또는 거래명세서 번호" required></label>`;
  const entryReason=(label,presets)=>reason('',label)+`<div class="ops-reason-presets wide" aria-label="${label} 빠른 입력">${presets.map(value=>`<button type="button" class="secondary" data-reason-preset="${esc(value)}">${esc(value)}</button>`).join('')}<span class="small">선택 후 내용을 수정할 수 있습니다.</span></div>`;
  const continueEntry=checked=>`<label class="ops-check ops-continue"><input type="checkbox" name="keepContext" ${checked?'checked':''}> 같은 품목 계속 입력 <span class="small">도번·거래처 유지</span></label>`;
  const itemDrawing=id=>context.items.find(item=>item.id===id)?.drawing||'';
  function productionForm(){
    if(me.role!=='employee'||selectedReview)return '';
    const r=editing||{};
    return `<div class="ops-entry"><div class="ops-entry-head"><h3>${editing?'생산 정정·재신청':'생산 실적 입력'}</h3><p class="ops-entry-help">도번을 입력하고 작업·LOT·수량을 기록하세요.</p></div>${form('ops-production',r.version)}${drawingInput('production',r.drawing||itemDrawing(r.item_id))}${select('taskId','작업',tasks.map(t=>[t.id,t.name]),r.task_id)}${select('process','공정',[['Frame','Frame 조립'],['Latch','Latch 조립'],['Lever','Lever 조립'],['Mechanism','Mechanism 조립'],['검사','검사'],['포장','포장']],r.process)}${input('lotCode','생산 LOT',r.lot_code||'','text','maxlength="80"')}${quantity('good','양품 수량',r.good??'')}${quantity('bad','불량 수량',r.bad??0)}<div class="wide">${details('작업 메모 (선택)',area('note','작업 메모',r.note||'',500,false))}</div>${editing?reason():''}${end(editing?'수정 후 재검토 요청':'생산 기록 제출')}${editing?'<button type="button" class="secondary" data-cancel>정정 취소</button>':''}<p class="small">부품 양품은 승인 후 검사 대기로 넘어갑니다. AS 실적은 생산량으로 집계되며, 납품 대상은 품질에서 별도로 등록합니다.</p></div>`;
  }
  const canReview=r=>context.permissions.production_review&&r.status==='pending'&&r.employee_id!==me.employeeId;
  function productionRows(list){return list.map(r=>`<article class="ops-row"><div><strong class="ops-row-title">${esc(r.drawing)} <span>${esc(r.item_name)}</span></strong><p class="ops-row-meta">${esc(r.employee_name)} · ${esc(r.date)} · ${esc(r.process)} · LOT ${esc(r.lot_code)}</p><p>양품 <b>${r.good}</b> / 불량 <b>${r.bad}</b> · ${badge(r.status)}</p>${r.note?`<p class="request-text">${esc(r.note)}</p>`:''}${r.review_reason?`<p>검토 사유: ${esc(r.review_reason)}</p>`:''}</div>${canReview(r)?`<button type="button" class="secondary" data-review="${esc(r.production_id)}">생산 검토</button>`:''}${r.employee_id===me.employeeId&&r.status!=='approved'?`<button type="button" class="secondary" data-edit="${esc(r.production_id)}">정정·재신청</button>`:''}</article>`).join('');}
  function reviewForm(){const r=selectedReview;return r?`<div class="ops-selected"><h3>${esc(r.drawing)} · LOT ${esc(r.lot_code)}</h3><p>${esc(r.employee_name)} · 양품 ${r.good} / 불량 ${r.bad}</p>${form('ops-review-'+r.production_id,r.version)}${select('status','검토 결과',[['','검토 결과 선택'],['approved','승인'],['rejected','반려']])}${reason()}${end('검토 저장')}<button type="button" class="secondary" data-cancel>선택 닫기</button></div>`:'';}
  function receiptForm(){const r=entryDefaults.materials;return `<div class="ops-entry"><div class="ops-entry-head"><h3>자재 입고 등록</h3><p class="ops-entry-help">PR·SP·MO·PG 부품을 등록하면 품질 검사 대기로 넘어갑니다.</p></div>${form('ops-receive')}${drawingInput('materials',r.drawing)}${input('supplier','공급업체',r.supplier||'','text','maxlength="100"')}${input('lotCode','입고 LOT','','text','maxlength="80" placeholder="거래명세서 또는 제품의 LOT"')}${quantity('quantity','입고 수량','',1)}${entryReason('입고 메모 / 거래명세서 번호',['입고 확인','추가 입고'])}${end('입고 등록',continueEntry(r.keepContext))}</div>`;}
  function deliveryForm(){const r=entryDefaults.deliveries;return `<div class="ops-entry"><div class="ops-entry-head"><h3>AS 납품 대상 등록</h3><p class="ops-entry-help">AS 도번과 납품 정보를 입력하세요. 품질에서 직접 등록하고 출하검사합니다.</p></div>${form('ops-delivery')}${drawingInput('deliveries',r.drawing)}${input('customer','납품처',r.customer||'','text','maxlength="120"')}${input('lotCode','납품 LOT','','text','maxlength="80" placeholder="이번 납품 대상의 LOT"')}${quantity('quantity','납품 예정 수량','',1)}<label>납품 예정일 (선택)<input type="date" name="dueDate" value="${esc(r.dueDate||'')}"></label>${entryReason('납품 메모 / 주문번호',['정기 납품','추가 납품'])}${end('납품 대상 등록',continueEntry(r.keepContext))}</div>`;}
  const deliveryBadge=r=>r.status==='released'?'<span class="ops-status ops-released">출하검사 합격 · 납품 가능</span>':badge(r.status);
  function deliveryRows(list){return list.map(r=>`<article class="ops-row"><div><strong class="ops-row-title">${esc(r.drawing)} <span>${esc(r.item_name)}</span></strong><p>${esc(r.model)} · LOT ${esc(r.code)} · 납품처 ${esc(r.customer)}</p><p>예정 수량 <b>${r.quantity}</b> · 예정일 ${esc(r.due_date)||'미정'}</p><p>${deliveryBadge(r)}${r.delivered_at?' · '+stamp(r.delivered_at):''}</p></div>${!['delivered','cancelled'].includes(r.status)?`<div class="ops-row-actions"><button type="button" class="secondary" data-delivery="${esc(r.id)}" data-action="inspect">출하검사 기록</button>${r.status==='released'?`<button type="button" class="primary" data-delivery="${esc(r.id)}" data-action="complete">납품 완료 기록</button>`:''}<button type="button" class="secondary" data-delivery="${esc(r.id)}" data-action="cancel">등록 취소</button></div>`:''}</article>`).join('');}
  function lotRows(list){return list.map(r=>`<article class="ops-row"><div><strong class="ops-row-title">${esc(r.drawing)} <span>${esc(r.item_name)}</span></strong><p>${esc(r.model)} · LOT ${esc(r.code)} · ${esc(r.supplier)||'자체 생산'}</p><p>현재 재고 <b>${r.balance}</b> / 최초 입고 ${r.received} · ${badge(r.status)}</p><p class="small">${stamp(r.created_at)} · ${labels[r.origin]}</p></div><button class="secondary" data-lot="${esc(r.id)}">${section==='quality'?'검사 기록':'출고·조정·폐기'}</button></article>`).join('');}
  function lotForm(){
    const r=selectedLot;if(!r)return '';
    if(direct()){
      const heading=`<h3>${esc(r.drawing)} · LOT ${esc(r.code)}</h3><p>납품처 ${esc(r.customer)} · 예정 수량 ${r.quantity} · ${deliveryBadge(r)}</p>`;
      if(deliveryAction==='complete')return heading+form('ops-delivery-complete',r.version)+reason()+`<label class="wide ops-check"><input type="checkbox" name="deliveryConfirmed" required> 이 LOT 전체 ${r.quantity}개의 실제 납품 완료를 확인했습니다.</label>`+end('납품 완료 저장');
      if(deliveryAction==='cancel')return heading+'<p>등록 취소 후에는 검사를 추가할 수 없습니다. 기존 검사와 처리 이력은 보존됩니다.</p>'+form('ops-delivery-cancel',r.version)+reason()+end('등록 취소 저장');
      return inspectionForm(r,heading,true);
    }
    const heading=`<h3>${esc(r.drawing)} · LOT ${esc(r.code)}</h3><p>현재 재고 ${r.balance} · ${badge(r.status)}</p>`;
    if(section==='materials')return heading+form('ops-move',r.version)+select('kind','처리 구분',[['issue','출고 (합격 LOT)'],['adjust','재고 조정 (+/−)'],['dispose','폐기']])+input('quantity','수량 (조정은 증감량)','','number','min="1" max="999999" step="1" inputmode="numeric" placeholder="수량 입력"')+reason()+end('재고 처리')+'<p class="small">재고 증가 조정은 다시 검사 대기 상태가 됩니다. 출고·폐기는 양수로 입력하세요.</p>';
    return inspectionForm(r,heading,false);
  }
  function inspectionForm(r,heading,asDelivery){
    return heading+`<p class="small request-text">기준 출처: ${esc(r.source)||'미등록'}</p>${r.warnings?`<p class="ops-warning request-text">확인 필요: ${esc(r.warnings)}</p>`:''}`+form('ops-inspect',r.version)+select('stage','검사 구분',asDelivery?[['shipping','출하검사']]:[['incoming','수입검사'],['process','공정검사'],['shipping','출하검사']],asDelivery?'shipping':r.origin==='receipt'?'incoming':'process')+quantity('sample','검사 수량',1,1)+quantity('failed','불합격 수량',0)+select('decision','LOT 판정',[['','판정 선택'],['pass',asDelivery?'합격 · 납품 가능':'합격 · 사용 가능'],['fail','불합격 · 보류']])+area('criteria','이번 검사에 적용한 기준',r.criteria,5000)+area('measurements','실측값·외관 등 검사 결과','',3000)+reason()+`<label class="wide ops-check"><input type="checkbox" name="criteriaConfirmed" required> 품목·도면·개정·샘플링 기준의 적용 여부를 확인했습니다.</label>`+end('검사 결과 저장')+'<p class="small">부적합은 LOT 전체를 보류합니다. 선별·재검사 결과는 새 검사 기록으로 추가하며 이전 기록은 보존합니다.</p>';
  }
  function catalogForm(){
    const r=selectedItem||{};
    return `<h3>${selectedItem?'품목·기준 수정':'품목 추가'}</h3>${form('ops-item',r.version||0)}${input('drawing','도면번호',r.drawing||'','text','maxlength="80"')}${input('name','품명',r.name||'','text','maxlength="120"')}${input('model','모델',r.model||'','text','maxlength="40"')}${select('kind','구분',[['part','부품'],['assembly','조립품']],r.kind)}${input('unit','단위',r.unit||'EA','text','maxlength="20"')}${area('supplier','기본 공급업체',r.supplier||'',100,false)}${area('source','기준 출처·문서번호',r.source||'',1000,false)}${area('criteria','검사 기준 원문',r.criteria||'',5000,false)}${area('warnings','적용 전 확인 사항',r.warnings||'',2000,false)}${select('active','사용 여부',[['true','사용'],['false','사용 중지']],String(r.active!==0))}${reason()}${end('품목 저장')}`;
  }
  function settings(){return `<h2>품목·검사기준 및 담당자</h2><p>업무별 담당자를 지정하면 해당 메뉴와 서버 권한이 함께 적용됩니다.</p>${users.map(u=>`${form('ops-access-'+u.id,u.version)}<strong class="wide">${esc(u.login)} · ${esc(u.name)}</strong>${['production_review','materials','quality'].map((k,i)=>`<label class="ops-check"><input type="checkbox" name="${k}" ${u[k]?'checked':''}>${['생산 검토','자재 관리','품질 관리'][i]}</label>`).join('')}${reason()}${end('담당 권한 저장')}`).join('')}<h3>품목 찾기</h3>${select('catalogItem','편집할 품목',[['','신규 품목'],...context.items.map(i=>[i.id,`${i.drawing} · ${i.name}`])],selectedItem?.id)}${catalogForm()}<div data-catalog-import-slot></div><p class="small">등록된 품목 ${context.items.length}개. 원본 파일 자체를 게시하지 않으며, 기준과 출처를 관리합니다.</p>`;}
  function filteredRows(){
    const query=filters.text.trim().toLocaleLowerCase(),drawing=normalizeDrawing(query),exact=resolveDrawing(context.items,query).item;
    return rows.filter(r=>{
      if(filters.status&&r.status!==filters.status)return false;
      if(!query)return true;
      if(exact)return normalizeDrawing(r.drawing)===normalizeDrawing(exact.drawing);
      return normalizeDrawing(r.drawing).includes(drawing)||[r.item_name,r.model,r.code,r.lot_code,r.customer,r.supplier,r.employee_name].some(value=>String(value||'').toLocaleLowerCase().includes(query));
    });
  }
  function filterBar(){
    const states=section==='production'?['pending','approved','rejected']:direct()?['pending','released','held','delivered','cancelled']:['pending','released','held'];
    return `<div class="ops-filter-bar"><label>현재 페이지에서 찾기<input type="search" data-list-search value="${esc(filters.text)}" placeholder="도번 · 품명 · LOT · 거래처" autocomplete="off"></label><label>상태<select data-list-status><option value="">전체 상태</option>${states.map(status=>`<option value="${status}" ${filters.status===status?'selected':''}>${status==='released'&&direct()?'출하검사 합격':labels[status]}</option>`).join('')}</select></label><button type="button" class="secondary" data-clear-filters>검색 초기화</button></div>`;
  }
  function flow(){
    if(!['materials','quality'].includes(section))return '';
    const steps=direct()?['납품 대상 등록','출하검사','납품 완료']:['자재 입고 / 생산 승인','품질 검사','출고'];
    const current=direct()?(selectedLot?deliveryAction==='complete'?2:1:0):section==='quality'?1:selectedLot?2:0;
    return `<ol class="ops-flow" aria-label="${direct()?'AS 납품':'부품 처리'} 순서">${steps.map((label,i)=>`<li class="${i===current?'ops-flow-current':''}" ${i===current?'aria-current="step"':''}>${label}</li>`).join('')}</ol>`;
  }
  function listContent(){const list=filteredRows();return (section==='production'?productionRows(list):direct()?deliveryRows(list):lotRows(list))||`<p class="empty">${rows.length?'현재 페이지에서 검색 조건에 맞는 기록이 없습니다.':direct()?'납품 대상이 없습니다. 위에서 AS 도번으로 등록하세요.':section==='quality'?'검사할 LOT가 없습니다. 자재 입고 또는 부품 생산 승인 후 검사할 수 있습니다.':'등록된 기록이 없습니다.'}</p>`;}
  const listSummary=()=>`현재 ${page+1}페이지 ${rows.length}건 중 ${filteredRows().length}건 표시 · 검색은 현재 페이지에만 적용됩니다.`;
  function draw(){
    if(!root.isConnected)return;const drafts=captureDrafts(root);
    const tabs=section==='quality'?`<div class="ops-quality-tabs" aria-label="검사 업무 선택"><button type="button" class="${direct()?'primary':'secondary'}" data-quality-mode="deliveries" aria-pressed="${direct()}">AS 납품 검사</button><button type="button" class="${!direct()?'primary':'secondary'}" data-quality-mode="lots" aria-pressed="${!direct()}">입고·생산 LOT 검사</button></div>`:'';
    const historyHtml=history.map(h=>`<article class="ops-row"><p><strong>${esc(h.drawing)} · LOT ${esc(h.code)}</strong> · ${stamp(h.created_at)} · ${esc(h.actor)}</p><p>${section==='quality'?`${labels[h.stage]} · ${badge(h.decision)} · 검사 ${h.sample} / 불합격 ${h.failed}`:`${labels[h.kind]} ${h.quantity>0?'+':''}${h.quantity}`}</p>${section==='quality'?`<p class="request-text">적용 기준: ${esc(h.criteria)}</p><p class="request-text">결과: ${esc(h.measurements)}</p>`:''}<p class="request-text">${esc(h.reason)}</p></article>`).join('')||'<p>이력이 없습니다.</p>';
    root.innerHTML=`<section class="card ops-panel"><p data-ops-message role="status" class="ops-result-message" ${message?'':'hidden'}>${esc(message)}</p>${section==='settings'?settings():`<h2>${{production:'품목·LOT 생산',materials:'자재·재고 관리',quality:'품질·부적합 관리'}[section]}</h2>${tabs}${flow()}${section==='production'?productionForm():section==='materials'&&!selectedLot?receiptForm():direct()&&!selectedLot?deliveryForm():''}${reviewForm()}${selectedLot?`<div class="ops-selected">${lotForm()}<button type="button" class="secondary" data-cancel>선택 닫기</button></div>`:''}<div class="ops-toolbar"><h3>${section==='production'?'생산 기록':direct()?'AS 납품 목록':'LOT 목록'}</h3><button type="button" class="secondary" data-reload>최신 내역</button><span>페이지당 최대 50건</span></div>${filterBar()}<p class="ops-list-summary" data-list-summary role="status">${listSummary()}</p><div class="ops-list" data-ops-list>${listContent()}</div><div class="button-pair"><button type="button" class="secondary" data-prev ${page===0?'disabled':''}>이전</button><button type="button" class="secondary" data-next ${more?'':'disabled'}>다음</button></div>${section==='production'?'':details('최근 처리 이력 (최대 50건)',historyHtml)}`}<p data-ops-error role="alert" class="task-error"></p></section>`;
    restoreDrafts(root,drafts);bind();
    if(section==='settings'){
      const slot=root.querySelector('[data-catalog-import-slot]');
      if(!catalogRoot){catalogRoot=document.createElement('div');slot.append(catalogRoot);catalogImporter=mountCatalogImport({root:catalogRoot,items:context.items,api,isCurrent:()=>root.isConnected,onComplete:async result=>{message=`${result.created}개 등록, 기존 ${result.skipped}개 유지`;await reload();}});}
      else {slot.append(catalogRoot);catalogImporter.refresh({items:context.items});}
    }
  }
  function updateList(){root.querySelector('[data-ops-list]').innerHTML=listContent();root.querySelector('[data-list-summary]').textContent=listSummary();bindRows();}
  const discard=()=>!inFlight.size&&(!hasDrafts(root)||confirm('작성 중인 내용을 버리고 선택을 바꿀까요?'));
  const forget=()=>{root.querySelectorAll('form').forEach(acceptForm);};
  function bindRows(){
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();editing=rows.find(r=>r.production_id===b.dataset.edit);selectedReview=null;draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();selectedReview=rows.find(r=>r.production_id===b.dataset.review);editing=null;draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelectorAll('[data-delivery]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();selectedLot=rows.find(r=>r.id===b.dataset.delivery);deliveryAction=b.dataset.action;draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelectorAll('[data-lot]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();selectedLot=rows.find(r=>r.id===b.dataset.lot);draw();root.scrollIntoView({behavior:'smooth'});});
  }
  async function submit(f,path,body){
    if(inFlight.size)return;
    const error=f.querySelector('[role="alert"]');error.textContent='';
    const keepContext=Boolean(f.elements.keepContext?.checked),controls=[...f.elements],disabled=controls.map(field=>field.disabled);
    inFlight.add(f.id);root.setAttribute('aria-busy','true');f.setAttribute('aria-busy','true');controls.forEach(field=>field.disabled=true);
    const signature=JSON.stringify(body);let entry=keys.get(f.id);if(!entry||entry.signature!==signature){entry={signature,key:crypto.randomUUID()};keys.set(f.id,entry);}
    let saved=false,failure='';
    try{
      await call(path,{...body,requestKey:entry.key});saved=true;keys.delete(f.id);
      if(path==='materials/receive'||path==='quality/deliveries'){
        const kind=path==='materials/receive'?'materials':'deliveries';
        entryDefaults[kind]=keepContext?{drawing:body.drawing,supplier:body.supplier,customer:body.customer,dueDate:body.dueDate,keepContext:true}:{};
        message=`${body.drawing} · LOT ${body.lotCode} · ${Number(body.quantity).toLocaleString('ko-KR')}개 ${kind==='materials'?'입고':'납품 대상'}를 저장했습니다.${keepContext?' 다음 LOT와 수량을 입력하세요.':''}`;
        page=0;filters={text:'',status:''};
      }else if(path==='quality/inspect'||path==='quality/deliveries/inspect')message=`LOT ${selectedLot.code} · ${labels[body.decision]} 검사 결과를 저장했습니다.`;
      else if(path==='quality/deliveries/complete')message=`LOT ${selectedLot.code} · ${selectedLot.quantity}개 납품 완료를 저장했습니다.`;
      else message='저장했습니다.';
      f.reset();acceptForm(f);editing=null;selectedLot=null;selectedItem=null;selectedReview=null;
      const updated=await reload({afterMutation:true});
      if(!updated&&root.isConnected){draw();const status=root.querySelector('[data-ops-message]');if(status){status.textContent=message;status.hidden=false;}const target=root.querySelector('[data-ops-error]');if(target)target.textContent='저장은 완료됐지만 목록을 새로 불러오지 못했습니다. 최신 내역을 눌러 확인하세요.';}
      await onChange();
    }catch(e){failure=saved?'저장은 완료됐지만 목록을 새로 불러오지 못했습니다. 최신 내역을 눌러 확인하세요.':e.message;const target=f.isConnected?error:root.querySelector('[data-ops-error]');if(target)target.textContent=failure;}
    finally{
      inFlight.delete(f.id);f.removeAttribute('aria-busy');controls.forEach((field,i)=>field.disabled=disabled[i]);
      if(pendingRefresh&&root.isConnected){pendingRefresh=false;await reload();}
      if(failure&&root.isConnected){const target=(!saved&&root.querySelector(`#${CSS.escape(f.id)} [role="alert"]`))||root.querySelector('[data-ops-error]');if(target)target.textContent=failure;}
      root.removeAttribute('aria-busy');
      if(saved&&keepContext&&root.isConnected)root.querySelector(`#${f.id} [name="lotCode"]`)?.focus();
    }
  }
  function bind(){
    root.querySelectorAll('form').forEach(f=>f.onsubmit=e=>{
      e.preventDefault();if(inFlight.size)return;const body=Object.fromEntries(new FormData(f));delete body.keepContext;
      if(f.id==='ops-production')return submit(f,editing?'production/correct':'production',{...body,...(editing?{id:editing.production_id,version:Number(f.dataset.version)}:{})});
      if(f.id.startsWith('ops-review-'))return submit(f,'production/review',{...body,id:f.id.slice(11),version:Number(f.dataset.version)});
      if(f.id==='ops-delivery')return submit(f,'quality/deliveries',body);
      if(f.id==='ops-delivery-complete')return submit(f,'quality/deliveries/complete',{...body,id:selectedLot.id,version:Number(f.dataset.version),deliveryConfirmed:body.deliveryConfirmed==='on'});
      if(f.id==='ops-delivery-cancel')return submit(f,'quality/deliveries/cancel',{...body,id:selectedLot.id,version:Number(f.dataset.version)});
      if(f.id==='ops-receive')return submit(f,'materials/receive',body);
      if(f.id==='ops-move')return submit(f,'materials/move',{...body,id:selectedLot.id,version:Number(f.dataset.version)});
      if(f.id==='ops-inspect')return submit(f,direct()?'quality/deliveries/inspect':'quality/inspect',{...body,id:selectedLot.id,version:Number(f.dataset.version),criteriaConfirmed:body.criteriaConfirmed==='on'});
      if(f.id==='ops-item')return submit(f,'items',{...body,active:body.active==='true',version:Number(f.dataset.version)});
      if(f.id.startsWith('ops-access-'))return submit(f,'access',{...body,userId:f.id.slice(11),version:Number(f.dataset.version),production_review:body.production_review==='on',materials:body.materials==='on',quality:body.quality==='on'});
    });
    bindRows();
    root.querySelectorAll('[data-quality-mode]').forEach(b=>b.onclick=()=>{if(b.dataset.qualityMode===qualityMode||!discard())return;forget();qualityMode=b.dataset.qualityMode;page=0;more=false;rows=[];history=[];selectedLot=null;message='';filters={text:'',status:''};draw();reload();});
    root.querySelector('[data-cancel]')?.addEventListener('click',()=>{if(!discard())return;forget();editing=null;selectedLot=null;selectedReview=null;draw();});
    root.querySelector('[data-reload]')?.addEventListener('click',()=>{if(!inFlight.size)reload();});
    for(const [selector,delta] of [['[data-prev]',-1],['[data-next]',1]])root.querySelector(selector)?.addEventListener('click',()=>{if(!discard())return;forget();editing=null;selectedLot=null;selectedReview=null;page+=delta;reload();});
    root.querySelector('[data-list-search]')?.addEventListener('input',event=>{filters.text=event.target.value;updateList();});
    root.querySelector('[data-list-status]')?.addEventListener('change',event=>{filters.status=event.target.value;updateList();});
    root.querySelector('[data-clear-filters]')?.addEventListener('click',()=>{filters={text:'',status:''};root.querySelector('[data-list-search]').value='';root.querySelector('[data-list-status]').value='';updateList();});
    const movement=root.querySelector('#ops-move');
    if(movement){const update=()=>{const adjustment=movement.elements.kind.value==='adjust',field=movement.elements.quantity;field.min=adjustment?'-999999':'1';field.inputMode=adjustment?'text':'numeric';field.placeholder=adjustment?'증가 5 / 감소 -5':'수량 입력';};movement.elements.kind.addEventListener('change',update);update();}
    root.querySelectorAll('[data-reason-preset]').forEach(button=>button.addEventListener('click',()=>{const field=button.form.elements.reason;field.value=button.dataset.reasonPreset;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();}));
    root.querySelectorAll('input[type="number"]').forEach(field=>field.addEventListener('focus',()=>{if(field.value==='0')field.select();}));
    root.querySelector('[name="catalogItem"]')?.addEventListener('change',e=>{if(!discard()){e.target.value=selectedItem?.id||'';return;}forget();selectedItem=context.items.find(i=>i.id===e.target.value)||null;draw();});
    root.querySelectorAll('[data-drawing]').forEach(field=>{
      const f=field.form,hidden=f.querySelector('[name="itemId"]'),status=f.querySelector('[data-item-match]'),suggestions=f.querySelector('datalist');
      const sync=changed=>{
        const key=normalizeDrawing(field.value),resolved=resolveDrawing(context.items,field.value);let product=resolved.item,error=resolved.error;
        if(product&&field.dataset.drawing!=='production'&&isDeliveryItem(product)!==(field.dataset.drawing==='deliveries')){error=isDeliveryItem(product)?'AS 계열은 품질 관리 → AS 납품 검사에서 등록하세요.':'PR·SP·MO·PG 등 부품은 자재 입고 후 검사하세요.';product=null;}
        const oldId=hidden.value;hidden.value=product?.id||'';field.setCustomValidity(error);
        status.innerHTML=product?`<strong>${esc(product.drawing)} · ${esc(product.name)}</strong><span>${esc(product.model)} · 단위 ${esc(product.unit||'EA')}${product.supplier?' · 기본 공급업체 '+esc(product.supplier):''}</span>`:esc(error);
        status.classList.toggle('is-resolved',Boolean(product));
        status.classList.toggle('task-error',Boolean(key&&!product));
        if(changed&&oldId!==hidden.value&&f.elements.supplier)f.elements.supplier.value=product?.supplier||'';
        suggestions.replaceChildren();
        if(key.length>=2&&!product)for(const candidate of items().filter(i=>(field.dataset.drawing==='production'||isDeliveryItem(i)===(field.dataset.drawing==='deliveries'))&&normalizeDrawing(i.drawing).includes(key)).slice(0,10)){
          const option=document.createElement('option');option.value=candidate.drawing;option.label=candidate.model+' · '+candidate.name;suggestions.append(option);
        }
      };
      field.addEventListener('input',()=>sync(true));sync(false);
    });

  }
  async function reload({afterMutation=false}={}){
    if(inFlight.size&&!afterMutation){pendingRefresh=true;return false;}
    const current=++serial;
    try{
      const next=await call('context');if(next.items.length>1000)throw Error('품목 목록이 1,000개를 초과했습니다. 관리자에게 문의하세요.');
      const route=direct()?'quality/deliveries':section;
      const data=await call(section==='settings'?'access':route+'?page='+page);
      const log=['materials','quality'].includes(section)?await call(route+'/history'):null;
      if(current!==serial||!root.isConnected)return false;
      if(inFlight.size&&!afterMutation){pendingRefresh=true;return false;}
      context=next;users=data.users||[];rows=data.rows||[];more=Boolean(data.hasMore);history=log?.rows||[];
      // Keep an open edit's original version so a stale form fails safely.
      draw();return true;
    }catch(e){if(current!==serial||!root.isConnected)return false;if(inFlight.size&&!afterMutation){pendingRefresh=true;return false;}if(!root.querySelector('[data-ops-error]'))root.innerHTML='<section class="card"><p data-ops-error role="alert"></p></section>';root.querySelector('[data-ops-error]').textContent=e.message;return false;}
  }
  root.innerHTML='<section class="card"><p>업무 자료를 불러오는 중입니다.</p></section>';reload();
  return {refresh(options={}){if(options.tasks)tasks=options.tasks;return reload();}};
}
