import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {qualityDeliveriesScenario} from './quality-deliveries-scenario.mjs';
import {drawingFamily,isDeliveryItem,resolveDrawing} from '../public/operations-domain.js';

test('AS 품질 직접 납품 흐름과 부품 자재 입고 흐름의 권한·이력·수량을 분리한다',async()=>{
  const f=fixture();try{
    await qualityDeliveriesScenario(f);
    assert.throws(()=>f.db.exec('DELETE FROM ops_delivery_inspections'),/immutable/);
    assert.throws(()=>f.db.exec('DELETE FROM ops_deliveries'),/retained/);
    assert.throws(()=>f.db.exec("UPDATE ops_deliveries SET quantity=999 WHERE status='delivered'"),/immutable/);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{f.db.close();}
});
test('도면번호 입력은 구분기호·대소문자를 허용하고 미등록·모호·사용중지 품목을 차단한다',()=>{
  for(const family of ['AS','PR','SP','MO','PG'])for(const drawing of ['GC9-'+family+'-9001','gc9'+family.toLowerCase()+'9001','GC9_'+family+'_9001'])assert.equal(drawingFamily(drawing),family);
  assert.equal(isDeliveryItem({drawing:'GC9-PR-9001',kind:'assembly'}),false);
  assert.equal(isDeliveryItem({drawing:'GC9-AS-9001',kind:'part'}),true);
  assert.equal(drawingFamily('BASIC-001'),'');
  const first={id:'a',drawing:'GC9-PR-9001',active:1},other={id:'b',drawing:'GC9_PR_9001',active:1};
  assert.equal(resolveDrawing([first],'gc9pr9001').item.id,'a');
  assert.match(resolveDrawing([first],'unknown').error,/등록된/);
  assert.match(resolveDrawing([first,other],'gc9pr9001').error,/여러 개/);
  assert.equal(resolveDrawing([first,other],first.drawing).item.id,'a');
  assert.match(resolveDrawing([{...first,active:0}],first.drawing).error,/사용 중지/);
});
