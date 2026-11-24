export const normalizeDrawing=value=>String(value??'').trim().toUpperCase().replace(/[\s_-]+/g,'');
export function drawingFamily(value){
  const drawing=String(value??'').trim().toUpperCase();
  return drawing.match(/(?:^|[-_\s])(AS|PR|SP|MO|PG)(?=[-_\s]|\d|$)/)?.[1]
    ||normalizeDrawing(drawing).match(/^(?:[A-Z]+\d+)?(AS|PR|SP|MO|PG)\d+$/)?.[1]||'';
}
export const isDeliveryItem=item=>drawingFamily(item?.drawing)==='AS';
export function resolveDrawing(items,value){
  const raw=String(value??'').trim().toUpperCase(),key=normalizeDrawing(raw);
  if(!key)return {item:null,error:'도면번호를 입력하세요.'};
  const exact=items.filter(item=>item.drawing.trim().toUpperCase()===raw);
  const matches=exact.length?exact:items.filter(item=>normalizeDrawing(item.drawing)===key);
  if(matches.length>1)return {item:null,error:'비슷한 도면번호가 여러 개입니다. 등록된 도면번호를 구분기호까지 입력하세요.'};
  if(!matches.length)return {item:null,error:'등록된 도면번호가 없습니다. 설정에서 품목을 먼저 등록하세요.'};
  if(!matches[0].active)return {item:null,error:'사용 중지된 품목입니다. 관리자에게 확인하세요.'};
  return {item:matches[0],error:''};
}
