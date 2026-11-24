import {normalizeDrawing,isDeliveryItem} from './operations-domain.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const required={drawing:80,name:120,model:40,unit:20};
const optional={supplier:100,source:1000,criteria:5000,warnings:2000};
const fieldLabels={drawing:'도면번호',name:'품명',model:'모델',unit:'단위',supplier:'공급업체',source:'기준 출처',criteria:'검사 기준',warnings:'확인 사항'};

// Validate every row before any write; a preview never changes existing items.
export function prepareCatalogImport(document,existing=[]){
  if(!document||typeof document!=='object'||Array.isArray(document)||!Array.isArray(document.items)||document.items.length<1||document.items.length>200)throw Error('items 목록에 품목 1~200개가 있는 JSON 파일을 선택하세요.');
  const known=new Set(existing.map(item=>normalizeDrawing(item.drawing))),seen=new Map(),rows=[],errors=[];
  for(const [index,source] of document.items.entries()){
    const row={line:index+1,item:{},status:'new',errors:[]};
    if(!source||typeof source!=='object'||Array.isArray(source))row.errors.push('품목 정보가 올바른 형식이 아닙니다.');
    else{
      for(const [key,max] of Object.entries({...required,...optional})){
        const raw=source[key]===undefined&&Object.hasOwn(optional,key)?'':source[key];
        if(typeof raw!=='string'||raw.trim().length>max||Object.hasOwn(required,key)&&!raw.trim())row.errors.push(`${fieldLabels[key]}: ${Object.hasOwn(required,key)?'필수, ':''}최대 ${max}자 문자열을 입력하세요.`);
        row.item[key]=typeof raw==='string'?raw.trim():'';
      }
      if(!['part','assembly'].includes(source.kind))row.errors.push('구분은 part(부품) 또는 assembly(조립품)여야 합니다.');
      row.item.kind=source.kind;
      const drawing=normalizeDrawing(row.item.drawing);
      if(!drawing)row.errors.push('도면번호에 문자 또는 숫자를 입력하세요.');
      if(drawing&&seen.has(drawing)){
        const first=seen.get(drawing),message=`파일 안에 같은 도면번호가 있습니다. (${first.line}행·${row.line}행)`;
        first.errors.push(message);row.errors.push(message);
      }else if(drawing)seen.set(drawing,row);
      if(known.has(drawing))row.status='existing';
    }
    rows.push(row);
  }
  for(const row of rows){if(row.errors.length){row.status='error';errors.push(...row.errors.map(message=>`${row.line}행: ${message}`));}}
  return {rows,errors,ready:errors.length===0,added:rows.filter(row=>row.status==='new').length,skipped:rows.filter(row=>row.status==='existing').length};
}

export function mountCatalogImport({root,items=[],api,onComplete=()=>{},isCurrent=()=>root.isConnected}){
  let known=items,document=null,plan=null,fileName='',busy=false,destroyed=false,stop=false,error='',message='',selection=0;
  const keys=new Map(),confirmed=new Set();
  const alive=()=>!destroyed&&root.isConnected&&isCurrent();
  const counts=()=>({created:confirmed.size,skipped:plan?.rows.filter(row=>row.status==='existing'&&!confirmed.has(normalizeDrawing(row.item.drawing))).length||0,remaining:plan?.added||0});
  function recalculate(){if(document)plan=prepareCatalogImport(document,known);}
  function clear(){selection++;document=null;plan=null;fileName='';error='';message='';keys.clear();confirmed.clear();}
  function render(){
    if(!alive())return;
    const result=counts();
    root.classList.add('catalog-import');
    root.innerHTML=`<h3>품목 파일로 한 번에 추가</h3><p class="small">파일 선택 후 내용을 확인하고 추가합니다. 기존 품목의 이름·검사 기준·사용 상태는 유지합니다.</p>
      <label>품목 JSON 파일 선택<input type="file" data-import accept=".json,application/json" ${busy?'disabled':''}></label>
      ${fileName?`<p class="small">선택한 파일: ${escape(fileName)}</p>`:''}
      ${plan?`<p class="catalog-import-summary" data-import-summary>새로 추가 ${plan.added}개 · 이미 등록 ${result.skipped}개 · 등록 완료 ${result.created}개 · 오류 ${plan.rows.filter(row=>row.status==='error').length}행</p>
      <div class="table-wrap catalog-import-preview"><table><caption class="sr-only">추가할 품목 미리보기</caption><thead><tr><th scope="col">도면번호</th><th scope="col">품명</th><th scope="col">모델</th><th scope="col">업무 구분</th><th scope="col">검사 기준</th><th scope="col">처리</th></tr></thead><tbody>${plan.rows.map(row=>`<tr><td>${escape(row.item.drawing)||'—'}</td><td>${escape(row.item.name)||'—'}</td><td>${escape(row.item.model)||'—'}</td><td>${row.item.drawing?(isDeliveryItem(row.item)?'AS 납품':'부품·일반'):'—'}</td><td>${row.item.criteria?'등록됨':'미등록'}</td><td>${row.status==='error'?escape(row.errors.join(' ')):confirmed.has(normalizeDrawing(row.item.drawing))?'등록 완료':row.status==='existing'?'기존 유지':'새로 추가'}</td></tr>`).join('')}</tbody></table></div>
      ${plan.rows.some(row=>row.status==='new'&&!row.item.criteria)?'<p class="small">검사 기준이 없는 품목은 등록 후 실제 도면과 기준을 확인해 보완하세요.</p>':''}
      <div class="catalog-import-actions"><button type="button" class="primary" data-import-apply ${busy||!plan.ready||!plan.added?'disabled':''}>${plan.added}개 품목 추가</button><button type="button" class="secondary" data-import-clear ${busy?'disabled':''}>선택 지우기</button>${busy?'<button type="button" class="secondary" data-import-stop>나머지 등록 중단</button>':''}</div>`:''}
      ${fileName&&!plan?'<div class="catalog-import-actions"><button type="button" class="secondary" data-import-clear>선택 지우기</button></div>':''}
      <p class="catalog-import-progress" data-import-status role="status">${escape(message)}</p><p data-import-error role="alert" class="task-error">${escape(error||plan?.errors.join('\n')||'')}</p>`;
    root.querySelector('[data-import]').onchange=selectFile;
    root.querySelector('[data-import-apply]')?.addEventListener('click',apply);
    root.querySelector('[data-import-clear]')?.addEventListener('click',()=>{if(busy)return;clear();render();});
    root.querySelector('[data-import-stop]')?.addEventListener('click',()=>{stop=true;message='진행 중인 요청을 확인한 뒤 나머지 등록을 중단합니다.';render();});
  }
  async function selectFile(event){
    const file=event.target.files?.[0];if(!file||busy)return;
    clear();fileName=file.name;const current=selection;message='품목 파일을 읽고 있습니다.';render();
    try{
      if(file.size>2000000)throw Error('2MB 이하의 품목 JSON 파일을 선택하세요.');
      const raw=await file.text();if(!alive()||selection!==current)return;
      try{document=JSON.parse(raw);}catch{throw Error('JSON 파일을 읽을 수 없습니다. 파일 내용을 확인하세요.');}
      recalculate();message=plan.ready?'아직 등록하지 않았습니다. 미리보기를 확인한 뒤 품목 추가를 누르세요.':'오류를 수정한 파일을 다시 선택하세요.';
    }catch(failure){if(!alive()||selection!==current)return;document=null;plan=null;message='';error=failure.message;}
    render();
  }
  async function apply(){
    if(busy||!alive()||!plan?.ready||!plan.added)return;
    busy=true;stop=false;error='';message='기존 품목을 다시 확인하고 있습니다.';render();
    try{
      // Refresh before retry so an earlier request with an uncertain response is
      // recognized as existing. Any retry of a still-missing row keeps its key.
      const context=await api('/api/operations/context');if(!alive())return;
      if(!Array.isArray(context.items)||context.items.length>1000)throw Error('전체 품목 목록을 확인할 수 없습니다. 새로고침 후 다시 시도하세요.');
      known=context.items;recalculate();if(!plan.ready)throw Error('품목 파일의 오류를 먼저 수정하세요.');
      for(const row of plan.rows.filter(row=>row.status==='new')){
        if(stop||!alive())break;
        const normalized=normalizeDrawing(row.item.drawing);
        if(!keys.has(normalized))keys.set(normalized,crypto.randomUUID());
        const result=await api('/api/operations/items',{...row.item,active:true,version:0,reason:'품목 파일 미리보기 확인 후 신규 등록',requestKey:keys.get(normalized)});
        if(!alive())return;
        confirmed.add(normalized);known=[...known,{...row.item,...result,active:true}];recalculate();
        message=`${confirmed.size}개 등록 완료 · 남은 ${plan.added}개`;render();
      }
      if(!alive())return;
      const result=counts();message=stop?`${result.created}개 등록 완료. 나머지 ${result.remaining}개는 등록하지 않았습니다.`:`${result.created}개 등록 완료 · 기존 ${result.skipped}개 유지`;
      busy=false;render();
      if(!stop){
        try{await onComplete(result);}
        catch(failure){if(alive())error=`품목 등록은 완료했습니다. 목록 새로고침에 실패했습니다: ${failure.message}`;}
      }
    }catch(failure){
      if(!alive())return;
      error=`${failure.message} 이미 등록된 품목은 유지됩니다. 다시 품목 추가를 누르면 최신 목록을 확인하고 남은 품목만 진행합니다.`;
    }finally{busy=false;if(alive())render();}
  }
  function destroy(){if(destroyed)return;destroyed=true;stop=true;clear();observer.disconnect();root.replaceChildren();}
  const observer=new MutationObserver(()=>{if(!root.isConnected||!isCurrent())destroy();});
  observer.observe(root.ownerDocument.documentElement,{childList:true,subtree:true});
  render();
  return {refresh({items:next}={}){if(!alive()||busy)return;if(Array.isArray(next)){known=next;recalculate();render();}},destroy};
}
