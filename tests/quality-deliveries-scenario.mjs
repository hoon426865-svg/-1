import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function qualityDeliveriesScenario(f){
  const admin=f.client(),quality=f.client(),materials=f.client();
  for(const [client,name] of [[admin,'ADMIN'],[quality,'001'],[materials,'002']])assert.equal((await client.login(name)).status,200);
  const post=(client,path,body)=>client.call('/api/operations/'+path,{requestKey:randomUUID(),...body});
  const ok=async promise=>{const r=await promise;assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  const get=(client,path)=>ok(client.call('/api/operations/'+path));
  const count=async table=>{const stmt=f.db.prepare('SELECT count(*) n FROM '+table);return (stmt.first?await stmt.first():stmt.get()).n;};
  const raw=async(sql,...args)=>{const stmt=f.db.prepare(sql);return stmt.bind?stmt.bind(...args).run():stmt.run(...args);};
  for(const [userId,permissions] of [['ue1',{production_review:false,materials:false,quality:true}],['ue2',{production_review:false,materials:true,quality:false}]])await ok(post(admin,'access',{userId,...permissions,version:0,reason:'합성 업무 분담'}));
  const base={name:'합성 품목',model:'TEST',kind:'part',unit:'EA',supplier:'합성 공급자',source:'합성 검사 기준',criteria:'외관 확인',warnings:'실물 기준이 아님',active:true,version:0,reason:'합성 시험'};
  const assembly=await ok(post(admin,'items',{...base,drawing:'GC9-AS-9001',kind:'part'}));
  let component;
  for(const family of ['PR','SP','MO','PG']){
    component=await ok(post(admin,'items',{...base,drawing:'GC9-'+family+'-9001',kind:'assembly'}));
    const lot=await ok(post(materials,'materials/receive',{itemId:component.id,drawing:'gc9'+family.toLowerCase()+'9001',lotCode:'RECEIPT-'+family,supplier:'합성 공급자',quantity:10,reason:'실물 입고 확인'}));
    await ok(post(quality,'quality/inspect',{id:lot.id,version:1,stage:'incoming',sample:2,failed:0,decision:'pass',criteria:'합성 외관 기준',measurements:'시험 표본 외관 이상 없음',criteriaConfirmed:true,reason:'수입검사'}));
  }
  assert.equal((await get(quality,'quality')).rows.length,4);
  const plan={itemId:assembly.id,drawing:'gc9as9001',lotCode:'DELIVERY-01',customer:'합성 납품처',dueDate:'2026-11-20',quantity:20,reason:'납품 계획',requestKey:randomUUID()};
  assert.equal((await post(materials,'quality/deliveries',plan)).status,403);
  assert.equal((await quality.call('/api/operations/materials')).status,403);
  assert.equal((await post(materials,'materials/receive',{itemId:assembly.id,lotCode:'WRONG',supplier:'합성',quantity:1,reason:'오경로'})).status,400);
  assert.equal((await post(quality,'quality/deliveries',{...plan,itemId:component.id,drawing:'GC9-PG-9001',requestKey:randomUUID()})).status,400);
  assert.equal((await post(quality,'quality/deliveries',{...plan,drawing:'GC9-AS-9999',requestKey:randomUUID()})).status,400);
  assert.equal((await post(quality,'quality/deliveries',{...plan,dueDate:'2026-02-30',requestKey:randomUUID()})).status,400);
  const created=await ok(post(quality,'quality/deliveries',plan));
  assert.deepEqual(await ok(post(quality,'quality/deliveries',plan)),created);
  assert.equal((await post(quality,'quality/deliveries',{...plan,quantity:21})).status,409);
  assert.equal((await post(quality,'quality/deliveries',{...plan,requestKey:randomUUID()})).status,409);
  assert.equal(await count('ops_lots'),4);assert.equal(await count('production'),0);
  assert.equal((await get(quality,'quality/deliveries')).rows[0].status,'pending');
  const completion={id:created.id,version:1,deliveryConfirmed:true,reason:'납품 확인'};
  assert.equal((await post(quality,'quality/deliveries/complete',completion)).status,409);
  const inspection={id:created.id,version:1,stage:'shipping',sample:5,failed:0,decision:'pass',criteria:'합성 외관 기준',measurements:'시험 표본 5개 확인',criteriaConfirmed:true,reason:'출하검사'};
  for(const change of [{sample:21},{failed:1},{criteriaConfirmed:false},{stage:'incoming'}])assert.equal((await post(quality,'quality/deliveries/inspect',{...inspection,...change})).status,400);
  await ok(post(quality,'quality/deliveries/inspect',{...inspection,failed:1,decision:'fail'}));
  assert.equal((await get(quality,'quality/deliveries')).rows[0].status,'held');
  assert.equal((await post(quality,'quality/deliveries/complete',{...completion,version:2})).status,409);
  await ok(post(quality,'quality/deliveries/inspect',{...inspection,version:2,reason:'선별 후 재검사'}));
  assert.equal((await post(quality,'quality/deliveries/complete',{...completion,version:3,deliveryConfirmed:false})).status,400);
  const finished={...completion,version:3,requestKey:randomUUID()};
  await ok(post(quality,'quality/deliveries/complete',finished));await ok(post(quality,'quality/deliveries/complete',finished));
  const row=(await get(quality,'quality/deliveries')).rows[0];assert.equal(row.status,'delivered');assert.equal(row.delivered_by,'ue1');assert.ok(row.delivered_at);
  assert.equal((await post(quality,'quality/deliveries/inspect',{...inspection,version:4})).status,409);
  assert.equal((await post(quality,'quality/deliveries/cancel',{id:created.id,version:4,reason:'완료 후 변경'})).status,409);
  const cancelled=await ok(post(quality,'quality/deliveries',{...plan,lotCode:'DELIVERY-02',requestKey:randomUUID()}));
  await ok(post(quality,'quality/deliveries/cancel',{id:cancelled.id,version:1,reason:'오등록 취소'}));
  assert.equal((await post(quality,'quality/deliveries/inspect',{...inspection,id:cancelled.id,version:2})).status,409);
  const history=(await get(quality,'quality/deliveries/history')).rows;assert.equal(history.length,2);assert.ok(history.every(r=>r.item_snapshot.includes('GC9-AS-9001')));
  // AS production counts remain, without a second inventory receipt/delivery plan.
  const production=await ok(post(materials,'production',{itemId:assembly.id,taskId:'t1',lotCode:'RUN-AS',process:'Mechanism',good:5,bad:0,note:'합성 생산'}));
  const review=await ok(post(admin,'production/review',{id:production.id,version:1,status:'approved',reason:'생산 수량 확인'}));
  assert.equal(review.qualityDirect,true);assert.equal(await count('ops_lots'),4);assert.equal(await count('ops_deliveries'),2);assert.equal(await count('production'),1);
  // Legacy AS lots remain usable, and cannot be duplicated as a new AS plan.
  await raw("INSERT INTO ops_lots(id,item_id,code,supplier,origin,received,balance,status,created_by,created_at) VALUES('legacy-as',?,'LEGACY-AS','합성','receipt',2,2,'pending','admin','2026-11-09T00:00:00Z')",assembly.id);
  assert.equal((await post(quality,'quality/deliveries',{...plan,lotCode:'LEGACY-AS',requestKey:randomUUID()})).status,409);
  await ok(post(quality,'quality/inspect',{...inspection,id:'legacy-as',sample:1}));
  assert.ok((await get(quality,'quality')).rows.some(r=>r.id==='legacy-as'&&r.status==='released'));
  await ok(post(admin,'access',{userId:'ue1',production_review:false,materials:false,quality:false,version:1,reason:'권한 해제'}));
  assert.equal((await post(quality,'quality/deliveries/complete',finished)).status,403);
}
