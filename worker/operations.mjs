import {all,one,check,audit} from './d1.mjs';
import {koreaNow} from '../public/domain.js';
import {isDeliveryItem,normalizeDrawing} from '../public/operations-domain.js';

const text=(value,max=200,optional=false)=>{check(typeof value==='string'&&(optional||value.trim())&&value.trim().length<=max,400,`입력값을 확인하세요. (최대 ${max}자)`);return value.trim();};
const integer=(value,min=0,max=999999)=>{check(['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=min&&Number(value)<=max,400,`${min}~${max} 범위의 정수를 입력하세요.`);return Number(value);};
const choice=(value,choices)=>{check(choices.includes(value),400,'선택값을 확인하세요.');return value;};
const version=(row,body)=>check(row&&row.version===integer(body.version,1),409,'다른 변경이 있습니다. 새로고침 후 다시 시도하세요.');
const bool=value=>{check(typeof value==='boolean',400,'권한 선택값을 확인하세요.');return Number(value);};
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const page=params=>integer(params.get('page')||0,0,100000)*50;
async function item(db,id){const row=await one(db,'SELECT * FROM ops_items WHERE id=? AND active=1',text(id));check(row,404,'활성 품목을 찾을 수 없습니다.');return row;}
async function lot(db,body){const row=await one(db,'SELECT * FROM ops_lots WHERE id=?',text(body.id));check(row,404,'LOT를 찾을 수 없습니다.');version(row,body);return row;}
async function enteredItem(db,body){const product=await item(db,body.itemId);if(body.drawing!==undefined)check(normalizeDrawing(text(body.drawing,80))===normalizeDrawing(product.drawing),400,'입력한 도면번호와 품목이 다릅니다. 다시 확인하세요.');return product;}
async function delivery(db,body){const row=await one(db,'SELECT * FROM ops_deliveries WHERE id=?',text(body.id));check(row,404,'납품 대상을 찾을 수 없습니다.');version(row,body);check(!['delivered','cancelled'].includes(row.status),409,'이미 납품 완료 또는 취소된 기록입니다.');return row;}
function dueDate(value){const date=text(value||'',10,true);check(!date||/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date,400,'납품 예정일을 확인하세요.');return date;}
async function rights(db,user){
  if(user.role==='admin')return {production_review:true,materials:true,quality:true};
  const row=await one(db,'SELECT * FROM ops_permissions WHERE user_id=?',user.id);
  return Object.fromEntries(['production_review','materials','quality'].map(k=>[k,Boolean(row?.[k])]));
}
function movement(tx,user,lotId,kind,quantity,reason,stamp){tx.add('INSERT INTO ops_movements VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),lotId,kind,quantity,reason,user.id,stamp);}
async function createLot(db,tx,user,entry,stamp){
  check(!await one(db,'SELECT id FROM ops_lots WHERE item_id=? AND code=?',entry.item_id,entry.code),409,'이미 등록된 품목·LOT입니다. 다른 LOT 번호를 입력하세요.');
  const id=crypto.randomUUID();
  tx.add("INSERT INTO ops_lots(id,item_id,code,supplier,origin,production_id,received,balance,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",id,entry.item_id,entry.code,entry.supplier,entry.origin,entry.production_id||null,entry.quantity,entry.quantity,user.id,stamp);
  movement(tx,user,id,entry.origin,entry.quantity,entry.reason,stamp);return id;
}

export async function operations(db,tx,user,url,method,body,stamp){
  const path=url.pathname.slice('/api/operations/'.length),permissions=await rights(db,user);
  const admin=['access','items'].includes(path)&&method==='POST'||path==='access';
  if(admin)check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  if(path==='production/review')check(permissions.production_review,403,'생산 검토 담당자 권한이 필요합니다.');
  if(path==='materials'||path.startsWith('materials/'))check(permissions.materials,403,'자재 담당자 권한이 필요합니다.');
  if(path==='quality'||path.startsWith('quality/'))check(permissions.quality,403,'품질 담당자 권한이 필요합니다.');
  if(method==='GET'){
    if(path==='context')return {permissions,items:await all(db,'SELECT * FROM ops_items ORDER BY model,drawing LIMIT 1001')};
    if(path==='access')return {users:await all(db,"SELECT u.id,u.login,e.name,COALESCE(p.production_review,0) production_review,COALESCE(p.materials,0) materials,COALESCE(p.quality,0) quality,COALESCE(p.version,0) version FROM users u JOIN employees e ON e.id=u.employee_id LEFT JOIN ops_permissions p ON p.user_id=u.id WHERE e.active=1 ORDER BY u.login")};
    const offset=page(url.searchParams);let rows;
    if(path==='production')rows=await all(db,`SELECT r.*,p.employee_id,p.good,p.bad,p.task_id,p.task_name,p.date,p.recorded_at,e.name employee_name,i.drawing,i.name item_name,i.model FROM ops_runs r JOIN production p ON p.id=r.production_id JOIN employees e ON e.id=p.employee_id JOIN ops_items i ON i.id=r.item_id ${permissions.production_review?'':'WHERE p.employee_id=?'} ORDER BY p.recorded_at DESC,p.id DESC LIMIT 51 OFFSET ?`,...(permissions.production_review?[]:[user.employee_id]),offset);
    else if(path==='materials'||path==='quality')rows=await all(db,'SELECT l.*,i.drawing,i.name item_name,i.model,i.criteria,i.warnings,i.source FROM ops_lots l JOIN ops_items i ON i.id=l.item_id ORDER BY l.created_at DESC,l.id DESC LIMIT 51 OFFSET ?',offset);
    else if(path==='materials/history')rows=await all(db,'SELECT m.*,l.code,i.drawing,u.login actor FROM ops_movements m JOIN ops_lots l ON l.id=m.lot_id JOIN ops_items i ON i.id=l.item_id JOIN users u ON u.id=m.actor_id ORDER BY m.created_at DESC,m.id DESC LIMIT 51 OFFSET ?',offset);
    else if(path==='quality/history')rows=await all(db,'SELECT q.*,l.code,i.drawing,u.login actor FROM ops_inspections q JOIN ops_lots l ON l.id=q.lot_id JOIN ops_items i ON i.id=l.item_id JOIN users u ON u.id=q.actor_id ORDER BY q.created_at DESC,q.id DESC LIMIT 51 OFFSET ?',offset);
    else if(path==='quality/deliveries')rows=await all(db,'SELECT d.*,i.drawing,i.name item_name,i.model,i.criteria,i.warnings,i.source FROM ops_deliveries d JOIN ops_items i ON i.id=d.item_id ORDER BY CASE WHEN d.status IN(\'delivered\',\'cancelled\') THEN 1 ELSE 0 END,d.created_at DESC,d.id DESC LIMIT 51 OFFSET ?',offset);
    else if(path==='quality/deliveries/history')rows=await all(db,"SELECT q.*,d.code,d.customer,i.drawing,u.login actor,'shipping' stage FROM ops_delivery_inspections q JOIN ops_deliveries d ON d.id=q.delivery_id JOIN ops_items i ON i.id=d.item_id JOIN users u ON u.id=q.actor_id ORDER BY q.created_at DESC,q.id DESC LIMIT 51 OFFSET ?",offset);
    else check(false,404,'업무 API를 찾을 수 없습니다.');
    return {rows:rows.slice(0,50),hasMore:rows.length>50,page:offset/50};
  }
  check(method==='POST',405,'허용되지 않는 요청입니다.');
  if(['production','production/correct'].includes(path))check(user.role==='employee',403,'직원 계정으로 생산 기록을 입력하세요.');
  const requestKey=text(body.requestKey,80);check(/^[a-zA-Z0-9-]{16,80}$/.test(requestKey),400,'요청 식별자를 확인하세요.');
  const payload=canonical({...body,path}),prior=await one(db,'SELECT * FROM ops_requests WHERE user_id=? AND request_key=?',user.id,requestKey);
  if(prior){check(prior.payload===payload,409,'이미 다른 내용으로 사용한 요청 식별자입니다.');return JSON.parse(prior.result);}
  let result={ok:true},before=null,after=null,target='',reason='';
  if(path==='items'){
    const drawing=text(body.drawing,80);before=await one(db,'SELECT * FROM ops_items WHERE drawing=? COLLATE NOCASE',drawing);
    if(before)version(before,body);else {
      check(integer(body.version,0)===0,409,'도면번호 변경은 신규 품목으로 등록하세요.');
      check((await one(db,'SELECT count(*) n FROM ops_items')).n<1000,409,'품목 1,000개 한도입니다. 관리자에게 문의하세요.');
    }
    const fields={drawing,name:text(body.name,120),model:text(body.model,40),kind:choice(body.kind,['part','assembly']),unit:text(body.unit,20),supplier:text(body.supplier||'',100,true),source:text(body.source||'',1000,true),criteria:text(body.criteria||'',5000,true),warnings:text(body.warnings||'',2000,true),active:bool(body.active)};
    target=before?.id||crypto.randomUUID();reason=text(body.reason,500);after={...fields,id:target,version:(before?.version||0)+1};
    if(before)tx.add('UPDATE ops_items SET drawing=?,name=?,model=?,kind=?,unit=?,supplier=?,source=?,criteria=?,warnings=?,active=?,version=version+1 WHERE id=?',...Object.values(fields),target);
    else tx.add('INSERT INTO ops_items(drawing,name,model,kind,unit,supplier,source,criteria,warnings,active,id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',...Object.values(fields),target);
    result={id:target,version:after.version};
  }else if(path==='access'){
    target=text(body.userId);check(await one(db,"SELECT u.id FROM users u JOIN employees e ON e.id=u.employee_id WHERE u.id=? AND e.active=1",target),404,'재직 직원 계정을 찾을 수 없습니다.');
    before=await one(db,'SELECT * FROM ops_permissions WHERE user_id=?',target);check(integer(body.version,0)===(before?.version||0),409,'권한이 변경되었습니다. 다시 조회하세요.');
    after={production_review:bool(body.production_review),materials:bool(body.materials),quality:bool(body.quality)};reason=text(body.reason,500);
    tx.add('INSERT INTO ops_permissions(user_id,production_review,materials,quality) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET production_review=excluded.production_review,materials=excluded.materials,quality=excluded.quality,version=version+1',target,...Object.values(after));
  }else if(path==='production'||path==='production/correct'){
    const product=await item(db,body.itemId),task=await one(db,'SELECT * FROM tasks WHERE id=?',text(body.taskId));check(task,404,'작업을 찾을 수 없습니다.');
    const good=integer(body.good),bad=integer(body.bad);check(good+bad>0,400,'생산 수량을 입력하세요.');
    after={item_id:product.id,lot_code:text(body.lotCode,80),process:text(body.process,80),note:text(body.note||'',500,true),good,bad,task_id:task.id};
    if(path.endsWith('/correct')){
      before=await one(db,'SELECT r.*,p.employee_id,p.good,p.bad FROM ops_runs r JOIN production p ON p.id=r.production_id WHERE r.production_id=?',text(body.id));
      check(before&&before.employee_id===user.employee_id,403,'본인의 생산 기록만 정정할 수 있습니다.');version(before,body);check(before.status!=='approved',409,'승인된 생산 기록은 정정할 수 없습니다.');
      target=before.production_id;reason=text(body.reason,500);
      tx.add('UPDATE production SET task_id=?,task_name=?,good=?,bad=?,version=version+1 WHERE id=?',task.id,task.name,good,bad,target);
      tx.add("UPDATE ops_runs SET item_id=?,lot_code=?,process=?,note=?,status='pending',reviewer_id=NULL,reviewed_at=NULL,review_reason='',version=version+1 WHERE production_id=?",product.id,after.lot_code,after.process,after.note,target);
    }else{
      target=crypto.randomUUID();reason='본인 품목·LOT 생산 기록';
      tx.add('INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,?,?,?,?,?,?,?)',target,user.employee_id,task.id,task.name,koreaNow(new Date(stamp)).date,stamp,good,bad,requestKey);
      tx.add("INSERT INTO ops_runs(production_id,item_id,lot_code,process,note,status) VALUES(?,?,?,?,?,'pending')",target,product.id,after.lot_code,after.process,after.note);
    }
    result={id:target};
  }else if(path==='production/review'){
    before=await one(db,'SELECT r.*,p.good,p.bad,p.employee_id FROM ops_runs r JOIN production p ON p.id=r.production_id WHERE r.production_id=?',text(body.id));check(before,404,'생산 기록을 찾을 수 없습니다.');version(before,body);check(before.status==='pending',409,'이미 검토된 기록입니다.');
    check(before.employee_id!==user.employee_id,403,'본인의 생산 기록은 다른 담당자가 검토해야 합니다.');
    const status=choice(body.status,['approved','rejected']);reason=text(body.reason,500);target=before.production_id;after={status,reason};
    if(status==='approved'&&before.good>0){
      const product=await item(db,before.item_id);
      if(isDeliveryItem(product))result.qualityDirect=true;
      else result.lotId=await createLot(db,tx,user,{item_id:before.item_id,code:before.lot_code,supplier:'',origin:'production',production_id:target,quantity:before.good,reason},stamp);
    }
    tx.add('UPDATE ops_runs SET status=?,reviewer_id=?,reviewed_at=?,review_reason=?,version=version+1 WHERE production_id=?',status,user.id,stamp,reason,target);
  }else if(path==='materials/receive'){
    const product=await enteredItem(db,body);check(!isDeliveryItem(product),400,'AS 계열은 품질 관리의 AS 납품 대상 등록을 사용하세요.');reason=text(body.reason,500);after={item_id:product.id,code:text(body.lotCode,80),supplier:text(body.supplier,100),origin:'receipt',quantity:integer(body.quantity,1),reason};
    target=await createLot(db,tx,user,after,stamp);result={id:target};
  }else if(path==='materials/move'){
    before=await lot(db,body);target=before.id;const kind=choice(body.kind,['issue','adjust','dispose']);reason=text(body.reason,500);
    const quantity=integer(body.quantity,kind==='adjust'?-999999:1);check(quantity!==0,400,'변경 수량을 입력하세요.');const delta=kind==='adjust'?quantity:-quantity,balance=before.balance+delta;
    check(balance>=0&&balance<=999999,409,'재고 수량을 초과하거나 잘못된 수량입니다.');
    if(kind==='issue')check(before.status==='released',409,'검사에 합격한 LOT만 출고할 수 있습니다.');
    const status=delta>0?'pending':before.status;after={balance,status,kind,quantity:delta};
    tx.add('UPDATE ops_lots SET balance=?,status=?,version=version+1 WHERE id=?',balance,status,target);movement(tx,user,target,kind,delta,reason,stamp);
  }else if(path==='quality/deliveries'){
    const product=await enteredItem(db,body);check(isDeliveryItem(product),400,'품질 직접 등록은 AS 계열만 가능합니다. 부품은 자재 입고 후 검사하세요.');
    const code=text(body.lotCode,80);
    check(!await one(db,'SELECT id FROM ops_deliveries WHERE item_id=? AND code=?',product.id,code),409,'이미 등록된 AS 품목·LOT입니다.');
    check(!await one(db,'SELECT id FROM ops_lots WHERE item_id=? AND code=?',product.id,code),409,'기존 입고·생산 LOT입니다. 입고·생산 LOT 검사에서 처리하세요.');
    target=crypto.randomUUID();reason=text(body.reason,500);after={item_id:product.id,code,customer:text(body.customer,120),due_date:dueDate(body.dueDate),quantity:integer(body.quantity,1)};
    tx.add('INSERT INTO ops_deliveries(id,item_id,code,customer,due_date,quantity,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',target,...Object.values(after),user.id,stamp);result={id:target};
  }else if(path==='quality/deliveries/inspect'){
    before=await delivery(db,body);const product=await item(db,before.item_id);check(isDeliveryItem(product),409,'AS 품목 분류를 확인하세요.');choice(body.stage,['shipping']);
    const sample=integer(body.sample,1,before.quantity),failed=integer(body.failed,0,sample),decision=choice(body.decision,['pass','fail']);
    check(body.criteriaConfirmed===true,400,'도면·검사기준의 적용 여부를 확인하세요.');check(decision!=='pass'||failed===0,400,'불합격 시료가 있는 LOT를 합격 처리할 수 없습니다.');
    const criteria=text(body.criteria,5000),measurements=text(body.measurements,3000);reason=text(body.reason,500);target=crypto.randomUUID();
    after={delivery_id:before.id,sample,failed,decision,criteria,measurements,reason,item_snapshot:canonical(product)};
    tx.add('INSERT INTO ops_delivery_inspections VALUES(?,?,?,?,?,?,?,?,?,?,?)',target,...Object.values(after),user.id,stamp);
    tx.add('UPDATE ops_deliveries SET status=?,version=version+1 WHERE id=?',decision==='pass'?'released':'held',before.id);result={id:target};
  }else if(path==='quality/deliveries/complete'||path==='quality/deliveries/cancel'){
    before=await delivery(db,body);target=before.id;reason=text(body.reason,500);
    if(path.endsWith('/complete')){
      check(before.status==='released',409,'출하검사에 합격한 LOT만 납품 완료로 기록할 수 있습니다.');
      check(body.deliveryConfirmed===true,400,'LOT 전체의 실제 납품 완료 여부를 확인하세요.');
      after={status:'delivered',delivered_by:user.id,delivered_at:stamp};
      tx.add("UPDATE ops_deliveries SET status='delivered',delivered_by=?,delivered_at=?,version=version+1 WHERE id=?",user.id,stamp,target);
    }else{after={status:'cancelled',reason};tx.add("UPDATE ops_deliveries SET status='cancelled',version=version+1 WHERE id=?",target);}
  }else if(path==='quality/inspect'){
    before=await lot(db,body);const product=await item(db,before.item_id),stage=choice(body.stage,['incoming','process','shipping']),sample=integer(body.sample,1,Math.max(before.balance,1)),failed=integer(body.failed,0,sample),decision=choice(body.decision,['pass','fail']);
    check(before.balance>0,409,'재고가 없는 LOT는 검사할 수 없습니다.');check(body.criteriaConfirmed===true,400,'도면·검사기준의 적용 여부를 확인하세요.');check(decision!=='pass'||failed===0,400,'불합격 시료가 있는 LOT를 합격 처리할 수 없습니다.');
    const criteria=text(body.criteria,5000),measurements=text(body.measurements,3000);reason=text(body.reason,500);target=crypto.randomUUID();
    after={lot_id:before.id,stage,sample,failed,decision,criteria,measurements,reason,item_snapshot:canonical(product)};
    tx.add('INSERT INTO ops_inspections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',target,...Object.values(after),user.id,stamp);
    tx.add('UPDATE ops_lots SET status=?,version=version+1 WHERE id=?',decision==='pass'?'released':'held',before.id);result={id:target};
  }else check(false,404,'업무 API를 찾을 수 없습니다.');
  audit(tx,user,'operations_'+path.replaceAll('/','_'),target,reason,before,after,stamp);
  tx.add('INSERT INTO ops_requests VALUES(?,?,?,?)',user.id,requestKey,payload,JSON.stringify(result));return result;
}
