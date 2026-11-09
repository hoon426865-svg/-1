import {captureDrafts,restoreDrafts,acceptForm,hasDrafts} from './drafts.js';
import {isDeliveryItem,normalizeDrawing,resolveDrawing} from './operations-domain.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={pending:'검토·검사 대기',approved:'생산 승인',rejected:'반려',released:'사용 가능',held:'부적합 보류',delivered:'납품 완료',cancelled:'등록 취소',receipt:'입고',production:'생산 완료',issue:'출고',adjust:'재고 조정',dispose:'폐기',pass:'합격',fail:'불합격',incoming:'수입검사',process:'공정검사',shipping:'출하검사'};
const stamp=v=>new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
const input=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} required></label>`;
const area=(name,label,value='',max=500,required=true)=>`<label class="wide">${label}<textarea name="${name}" maxlength="${max}" ${required?'required':''}>${esc(value)}</textarea></label>`;
const select=(name,label,entries,value='')=>`<label>${label}<select name="${name}" required>${entries.map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
const end=(label='저장')=>`<button class="primary">${label}</button><p role="alert" class="task-error wide"></p></form>`;
const form=(id,version='')=>`<form id="${id}" class="request-form" data-version="${version}">`;
const badge=status=>`<span class="ops-status ops-${status}">${labels[status]||esc(status)}</span>`;
const details=(title,content)=>`<details class="ops-detail"><summary>${title}</summary>${content}</details>`;

export function mountOperations({root,api,me,tasks=[],mode,onChange=()=>{}}){
  const section=mode.replace('ops-','');
  let context={items:[],permissions:{}},rows=[],history=[],users=[],page=0,more=false,serial=0,editing=null,selectedItem=null,selectedLot=null,message='';
  let qualityMode='deliveries',deliveryAction='inspect';
  const direct=()=>section==='quality'&&qualityMode==='deliveries';
  const keys=new Map(),call=(path,body)=>api('/api/operations/'+path,body);
  const items=()=>context.items.filter(i=>i.active);
  const itemSelect=(value='')=>select('itemId','품목 · 도면번호',[['','품목 선택'],...items().map(i=>[i.id,`${i.model} · ${i.drawing} · ${i.name}`])],value);
  const drawingInput=kind=>`<label class="wide">도면번호<input name="drawing" data-drawing="${kind}" list="ops-drawings-${kind}" maxlength="80" autocomplete="off" placeholder="도면번호 입력 · 하이픈 생략 가능" required><datalist id="ops-drawings-${kind}"></datalist></label><input type="hidden" name="itemId"><p class="wide small" data-item-match role="status">도면번호를 입력하면 품명과 모델이 표시됩니다.</p>`;
  const quantity=(name,label,value=0,min=0)=>input(name,label,value,'number',`min="${min}" max="999999" step="1"`);
  const reason=(value='')=>area('reason','사유 / 작업·거래 참조',value);
  function productionForm(){
    if(me.role!=='employee')return '';
    const r=editing||{};
    return `<h3>${editing?'생산 정정·재신청':'품목·LOT 생산 입력'}</h3>${form('ops-production',r.version)}${itemSelect(r.item_id)}${select('taskId','작업',tasks.map(t=>[t.id,t.name]),r.task_id)}${select('process','공정',[['Frame','Frame 조립'],['Latch','Latch 조립'],['Lever','Lever 조립'],['Mechanism','Mechanism 조립'],['검사','검사'],['포장','포장']],r.process)}${input('lotCode','생산 LOT',r.lot_code||'','text','maxlength="80"')}${quantity('good','양품',r.good||0)}${quantity('bad','불량',r.bad||0)}${area('note','작업 메모',r.note||'',500,false)}${editing?reason():''}${end(editing?'수정 후 재검토 요청':'생산 기록 제출')}${editing?'<button type="button" class="secondary" data-cancel>정정 취소</button>':''}<p class="small">부품 양품은 담당자 승인 후 검사 대기 재고에 반영됩니다. AS 생산 실적은 수량 집계에 남으며, 납품 대상 등록과 출하검사는 품질에서 직접 진행합니다.</p>`;
  }
  function productionRows(){return rows.map(r=>`<article class="ops-row"><div><strong>${esc(r.drawing)} · ${esc(r.item_name)}</strong><p>${esc(r.employee_name)} · ${esc(r.date)} · ${esc(r.process)} · LOT ${esc(r.lot_code)}</p><p>양품 ${r.good} / 불량 ${r.bad} · ${badge(r.status)}</p>${r.note?`<p class="request-text">${esc(r.note)}</p>`:''}${r.review_reason?`<p>검토 사유: ${esc(r.review_reason)}</p>`:''}</div>${context.permissions.production_review&&r.status==='pending'&&r.employee_id!==me.employeeId?`${form('ops-review-'+r.production_id,r.version)}${select('status','검토 결과',[['approved','승인'],['rejected','반려']])}${reason()}${end('검토 저장')}`:''}${r.employee_id===me.employeeId&&r.status!=='approved'?`<button class="secondary" data-edit="${esc(r.production_id)}">정정·재신청</button>`:''}</article>`).join('');}
  function receiptForm(){return details('자재 입고 등록',`<p class="small">PR·SP·MO·PG는 도면번호로 입고한 뒤 품질에서 검사합니다. AS는 품질 관리에서 직접 등록합니다.</p>${form('ops-receive')}${drawingInput('materials')}${input('lotCode','입고 LOT','','text','maxlength="80"')}${input('supplier','공급업체','','text','maxlength="100"')}${quantity('quantity','입고 수량',1,1)}${reason()}${end('입고 등록')}`);}
  function deliveryForm(){return `<h3>AS 납품 대상 등록</h3><p class="small">품질 담당자가 납품 대상과 LOT를 등록하고 출하검사를 진행합니다. 입고 등록은 필요하지 않습니다.</p>${form('ops-delivery')}${drawingInput('deliveries')}${input('lotCode','납품 LOT','','text','maxlength="80"')}${input('customer','납품처','','text','maxlength="120"')}<label>납품 예정일 (선택)<input type="date" name="dueDate"></label>${quantity('quantity','납품 예정 수량',1,1)}${reason()}${end('납품 대상 등록')}`;}
  const deliveryBadge=r=>r.status==='released'?'<span class="ops-status ops-released">출하검사 합격 · 납품 가능</span>':badge(r.status);
  function deliveryRows(){return rows.map(r=>`<article class="ops-row"><div><strong>${esc(r.drawing)} · ${esc(r.item_name)}</strong><p>${esc(r.model)} · LOT ${esc(r.code)} · 납품처 ${esc(r.customer)}</p><p>예정 수량 <b>${r.quantity}</b> · 예정일 ${esc(r.due_date)||'미정'}</p><p>${deliveryBadge(r)}${r.delivered_at?' · '+stamp(r.delivered_at):''}</p></div>${!['delivered','cancelled'].includes(r.status)?`<div class="ops-row-actions"><button type="button" class="secondary" data-delivery="${esc(r.id)}" data-action="inspect">출하검사 기록</button>${r.status==='released'?`<button type="button" class="primary" data-delivery="${esc(r.id)}" data-action="complete">납품 완료 기록</button>`:''}<button type="button" class="secondary" data-delivery="${esc(r.id)}" data-action="cancel">등록 취소</button></div>`:''}</article>`).join('');}
  function lotRows(){return rows.map(r=>`<article class="ops-row"><div><strong>${esc(r.drawing)} · ${esc(r.item_name)}</strong><p>${esc(r.model)} · LOT ${esc(r.code)} · ${esc(r.supplier)||'자체 생산'}</p><p>현재 재고 <b>${r.balance}</b> / 최초 입고 ${r.received} · ${badge(r.status)}</p><p class="small">${stamp(r.created_at)} · ${labels[r.origin]}</p></div><button class="secondary" data-lot="${esc(r.id)}">${section==='quality'?'검사 기록':'출고·조정·폐기'}</button></article>`).join('');}
  function lotForm(){
    const r=selectedLot;if(!r)return '';
    if(direct()){
      const heading=`<h3>${esc(r.drawing)} · LOT ${esc(r.code)}</h3><p>납품처 ${esc(r.customer)} · 예정 수량 ${r.quantity} · ${deliveryBadge(r)}</p>`;
      if(deliveryAction==='complete')return heading+form('ops-delivery-complete',r.version)+reason()+`<label class="wide ops-check"><input type="checkbox" name="deliveryConfirmed" required> 이 LOT 전체 ${r.quantity}개의 실제 납품 완료를 확인했습니다.</label>`+end('납품 완료 저장');
      if(deliveryAction==='cancel')return heading+'<p>등록 취소 후에는 검사를 추가할 수 없습니다. 기존 검사와 처리 이력은 보존됩니다.</p>'+form('ops-delivery-cancel',r.version)+reason()+end('등록 취소 저장');
      return inspectionForm(r,heading,true);
    }
    const heading=`<h3>${esc(r.drawing)} · LOT ${esc(r.code)}</h3><p>현재 재고 ${r.balance} · ${badge(r.status)}</p>`;
    if(section==='materials')return heading+form('ops-move',r.version)+select('kind','처리 구분',[['issue','출고 (합격 LOT)'],['adjust','재고 조정 (+/−)'],['dispose','폐기']])+input('quantity','수량 (조정은 증감량)',1,'number','min="-999999" max="999999" step="1"')+reason()+end('재고 처리')+'<p class="small">재고 증가 조정은 다시 검사 대기 상태가 됩니다. 출고·폐기는 양수로 입력하세요.</p>';
    return inspectionForm(r,heading,false);
  }
  function inspectionForm(r,heading,asDelivery){
    return heading+`<p class="small request-text">기준 출처: ${esc(r.source)||'미등록'}</p>${r.warnings?`<p class="ops-warning request-text">확인 필요: ${esc(r.warnings)}</p>`:''}`+form('ops-inspect',r.version)+select('stage','검사 구분',asDelivery?[['shipping','출하검사']]:[['incoming','수입검사'],['process','공정검사'],['shipping','출하검사']],asDelivery?'shipping':r.origin==='receipt'?'incoming':'process')+quantity('sample','검사 수량',1,1)+quantity('failed','불합격 수량',0)+select('decision','LOT 판정',[['','판정 선택'],['pass',asDelivery?'합격 · 납품 가능':'합격 · 사용 가능'],['fail','불합격 · 보류']])+area('criteria','이번 검사에 적용한 기준',r.criteria,5000)+area('measurements','실측값·외관 등 검사 결과','',3000)+reason()+`<label class="wide ops-check"><input type="checkbox" name="criteriaConfirmed" required> 품목·도면·개정·샘플링 기준의 적용 여부를 확인했습니다.</label>`+end('검사 결과 저장')+'<p class="small">부적합은 LOT 전체를 보류합니다. 선별·재검사 결과는 새 검사 기록으로 추가하며 이전 기록은 보존합니다.</p>';
  }
  function catalogForm(){
    const r=selectedItem||{};
    return `<h3>${selectedItem?'품목·기준 수정':'품목 추가'}</h3>${form('ops-item',r.version||0)}${input('drawing','도면번호',r.drawing||'','text','maxlength="80"')}${input('name','품명',r.name||'','text','maxlength="120"')}${input('model','모델',r.model||'','text','maxlength="40"')}${select('kind','구분',[['part','부품'],['assembly','조립품']],r.kind)}${input('unit','단위',r.unit||'EA','text','maxlength="20"')}${area('supplier','기본 공급업체',r.supplier||'',100,false)}${area('source','기준 출처·문서번호',r.source||'',1000,false)}${area('criteria','검사 기준 원문',r.criteria||'',5000,false)}${area('warnings','적용 전 확인 사항',r.warnings||'',2000,false)}${select('active','사용 여부',[['true','사용'],['false','사용 중지']],String(r.active!==0))}${reason()}${end('품목 저장')}`;
  }
  function settings(){return `<h2>품목·검사기준 및 담당자</h2><p>업무별 담당자를 지정하면 해당 메뉴와 서버 권한이 함께 적용됩니다.</p>${users.map(u=>`${form('ops-access-'+u.id,u.version)}<strong class="wide">${esc(u.login)} · ${esc(u.name)}</strong>${['production_review','materials','quality'].map((k,i)=>`<label class="ops-check"><input type="checkbox" name="${k}" ${u[k]?'checked':''}>${['생산 검토','자재 관리','품질 관리'][i]}</label>`).join('')}${reason()}${end('담당 권한 저장')}`).join('')}<h3>품목 찾기</h3>${select('catalogItem','편집할 품목',[['','신규 품목'],...context.items.map(i=>[i.id,`${i.drawing} · ${i.name}`])],selectedItem?.id)}${catalogForm()}${details('준비된 품목 목록 가져오기','<p>품목 정보와 검사기준을 추가합니다. 기존 도면번호는 건너뛰며 변경은 위 편집 화면에서 처리합니다.</p><label>품목 JSON<input type="file" accept=".json,application/json" data-import></label><p role="status" data-import-status></p>')}<p class="small">등록된 품목 ${context.items.length}개. 원본 파일 자체를 게시하지 않으며, 기준과 출처를 관리합니다.</p>`;}
  function draw(){
    if(!root.isConnected)return;const drafts=captureDrafts(root);
    const tabs=section==='quality'?`<div class="ops-quality-tabs" aria-label="검사 업무 선택"><button type="button" class="${direct()?'primary':'secondary'}" data-quality-mode="deliveries" aria-pressed="${direct()}">AS 납품 검사</button><button type="button" class="${!direct()?'primary':'secondary'}" data-quality-mode="lots" aria-pressed="${!direct()}">입고·생산 LOT 검사</button></div>`:'';
    const empty=direct()?'납품 대상이 없습니다. 위에서 AS 도면번호로 등록하세요.':section==='quality'?'검사할 LOT가 없습니다. 자재 입고 또는 부품 생산 승인 후 여기에서 검사합니다.':'등록된 기록이 없습니다.';
    const historyHtml=history.map(h=>`<article class="ops-row"><p><strong>${esc(h.drawing)} · LOT ${esc(h.code)}</strong> · ${stamp(h.created_at)} · ${esc(h.actor)}</p><p>${section==='quality'?`${labels[h.stage]} · ${badge(h.decision)} · 검사 ${h.sample} / 불합격 ${h.failed}`:`${labels[h.kind]} ${h.quantity>0?'+':''}${h.quantity}`}</p>${section==='quality'?`<p class="request-text">적용 기준: ${esc(h.criteria)}</p><p class="request-text">결과: ${esc(h.measurements)}</p>`:''}<p class="request-text">${esc(h.reason)}</p></article>`).join('')||'<p>이력이 없습니다.</p>';
    root.innerHTML=`<section class="card ops-panel">${section==='settings'?settings():`<h2>${{production:'품목·LOT 생산',materials:'자재·재고 관리',quality:'품질·부적합 관리'}[section]}</h2>${tabs}${section==='production'?productionForm():section==='materials'?receiptForm():direct()&&!selectedLot?deliveryForm():''}${selectedLot?`<div class="ops-selected">${lotForm()}<button type="button" class="secondary" data-cancel>선택 닫기</button></div>`:''}<div class="ops-toolbar"><button type="button" class="secondary" data-reload>최신 내역</button><span>목록 ${page+1}페이지 · 최대 50건</span></div>${section==='production'?productionRows():direct()?deliveryRows():lotRows()}${rows.length?'':`<p class="empty">${empty}</p>`}<div class="button-pair"><button type="button" class="secondary" data-prev ${page===0?'disabled':''}>이전</button><button type="button" class="secondary" data-next ${more?'':'disabled'}>다음</button></div>${section==='production'?'':details('최근 처리 이력 (최대 50건)',historyHtml)}`}<p data-ops-message role="status">${esc(message)}</p><p data-ops-error role="alert" class="task-error"></p></section>`;
    restoreDrafts(root,drafts);bind();
  }
  async function submit(f,path,body){
    const error=f.querySelector('[role="alert"]');error.textContent='';const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    const signature=JSON.stringify(body);let entry=keys.get(f.id);if(!entry||entry.signature!==signature){entry={signature,key:crypto.randomUUID()};keys.set(f.id,entry);}
    try{
      await call(path,{...body,requestKey:entry.key});keys.delete(f.id);f.reset();acceptForm(f);editing=null;selectedLot=null;selectedItem=null;message='저장했습니다.';
      await reload();await onChange();
    }catch(e){if(f.isConnected)error.textContent=e.message;else root.querySelector('[data-ops-error]').textContent=e.message;}
    finally{buttons.forEach(b=>b.disabled=false);}
  }
  function bind(){
    root.querySelectorAll('form').forEach(f=>f.onsubmit=e=>{
      e.preventDefault();const body=Object.fromEntries(new FormData(f));
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
    const discard=()=>!hasDrafts(root)||confirm('작성 중인 내용을 버리고 선택을 바꿀까요?');
    const forget=()=>{root.querySelectorAll('form').forEach(acceptForm);};
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();editing=rows.find(r=>r.production_id===b.dataset.edit);draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelectorAll('[data-quality-mode]').forEach(b=>b.onclick=()=>{if(b.dataset.qualityMode===qualityMode||!discard())return;forget();qualityMode=b.dataset.qualityMode;page=0;more=false;rows=[];history=[];selectedLot=null;message='';draw();reload();});
    root.querySelectorAll('[data-delivery]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();selectedLot=rows.find(r=>r.id===b.dataset.delivery);deliveryAction=b.dataset.action;draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelectorAll('[data-lot]').forEach(b=>b.onclick=()=>{if(!discard())return;forget();selectedLot=rows.find(r=>r.id===b.dataset.lot);draw();root.scrollIntoView({behavior:'smooth'});});
    root.querySelector('[data-cancel]')?.addEventListener('click',()=>{if(!discard())return;forget();editing=null;selectedLot=null;draw();});
    root.querySelector('[data-reload]')?.addEventListener('click',()=>reload());
    for(const [selector,delta] of [['[data-prev]',-1],['[data-next]',1]])root.querySelector(selector)?.addEventListener('click',()=>{if(!discard())return;forget();editing=null;selectedLot=null;page+=delta;reload();});
    root.querySelector('[name="catalogItem"]')?.addEventListener('change',e=>{if(!discard()){e.target.value=selectedItem?.id||'';return;}forget();selectedItem=context.items.find(i=>i.id===e.target.value)||null;draw();});
    root.querySelectorAll('[data-drawing]').forEach(field=>{
      const f=field.form,hidden=f.querySelector('[name="itemId"]'),status=f.querySelector('[data-item-match]'),suggestions=f.querySelector('datalist');
      const sync=changed=>{
        const key=normalizeDrawing(field.value),resolved=resolveDrawing(context.items,field.value);let product=resolved.item,error=resolved.error;
        if(product&&isDeliveryItem(product)!==(field.dataset.drawing==='deliveries')){error=isDeliveryItem(product)?'AS 계열은 품질 관리 → AS 납품 검사에서 등록하세요.':'PR·SP·MO·PG 등 부품은 자재 입고 후 검사하세요.';product=null;}
        const oldId=hidden.value;hidden.value=product?.id||'';field.setCustomValidity(error);
        status.textContent=product?`${product.drawing} · ${product.model} · ${product.name}${product.supplier?' · 공급업체 '+product.supplier:''}`:error;
        status.classList.toggle('task-error',Boolean(key&&!product));
        if(changed&&oldId!==hidden.value&&f.elements.supplier)f.elements.supplier.value=product?.supplier||'';
        suggestions.replaceChildren();
        if(key.length>=2&&!product)for(const candidate of items().filter(i=>isDeliveryItem(i)===(field.dataset.drawing==='deliveries')&&normalizeDrawing(i.drawing).includes(key)).slice(0,10)){
          const option=document.createElement('option');option.value=candidate.drawing;option.label=candidate.model+' · '+candidate.name;suggestions.append(option);
        }
      };
      field.addEventListener('input',()=>sync(true));sync(false);
    });
    root.querySelector('[data-import]')?.addEventListener('change',async e=>{
      const file=e.target.files[0],status=root.querySelector('[data-import-status]');if(!file)return;e.target.disabled=true;
      try{
        if(file.size>2000000)throw Error('2MB 이하의 품목 JSON을 선택하세요.');
        const data=JSON.parse(await file.text());if(!Array.isArray(data.items)||data.items.length>200)throw Error('최대 200개 품목의 items 목록이 필요합니다.');
        let count=0,skipped=0;const drawings=new Set(context.items.map(i=>i.drawing.toUpperCase()));
        for(const r of data.items){if(drawings.has(String(r.drawing).toUpperCase())){skipped++;continue;}await call('items',{drawing:r.drawing,name:r.name,model:r.model,kind:r.kind,unit:r.unit,supplier:r.supplier||'',source:r.source||'',criteria:r.criteria||'',warnings:r.warnings||'',active:true,version:0,reason:'참고자료 기반 품목 초기 등록',requestKey:crypto.randomUUID()});drawings.add(String(r.drawing).toUpperCase());status.textContent=`${++count}개 등록 중`;}
        message=`${count}개 등록, 기존 ${skipped}개 유지`;await reload();
      }catch(error){status.textContent=error.message+' 이미 등록된 품목은 유지됩니다. 재시도 시 기존 품목은 건너뜁니다.';}finally{e.target.disabled=false;}
    });
  }
  async function reload(){
    const current=++serial;
    try{
      const next=await call('context');if(next.items.length>1000)throw Error('품목 목록이 1,000개를 초과했습니다. 관리자에게 문의하세요.');
      const route=direct()?'quality/deliveries':section;
      const data=await call(section==='settings'?'access':route+'?page='+page);
      const log=['materials','quality'].includes(section)?await call(route+'/history'):null;
      if(current!==serial||!root.isConnected)return;
      context=next;users=data.users||[];rows=data.rows||[];more=Boolean(data.hasMore);history=log?.rows||[];
      // Keep an open edit's original version so a stale form fails safely.
      draw();
    }catch(e){if(current!==serial||!root.isConnected)return;if(!root.querySelector('[data-ops-error]'))root.innerHTML='<section class="card"><p data-ops-error role="alert"></p></section>';root.querySelector('[data-ops-error]').textContent=e.message;}
  }
  root.innerHTML='<section class="card"><p>업무 자료를 불러오는 중입니다.</p></section>';reload();
  return {refresh(options={}){if(options.tasks)tasks=options.tasks;return reload();}};
}
