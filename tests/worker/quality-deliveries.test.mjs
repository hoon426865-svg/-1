import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,applySql} from './helpers.mjs';
import {qualityDeliveriesScenario} from '../quality-deliveries-scenario.mjs';

test('D1 AS 직접 출하검사·납품 완료와 PR/SP/MO/PG 입고검사 권한·이력 보존',async()=>{
  const f=await fixture();try{await qualityDeliveriesScenario(f);assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);}finally{await f.close();}
});
test('D1 AS 납품 등록의 감사 저장 실패는 납품 행과 요청 식별자를 함께 취소한다',async()=>{
  const f=await fixture();try{
    const a=f.client();await a.login('ADMIN');
    const item=await a.call('/api/operations/items',{drawing:'GC9-AS-9999',name:'합성',model:'TEST',kind:'assembly',unit:'EA',active:true,version:0,reason:'시험',requestKey:randomUUID()});assert.equal(item.status,200);
    await f.db.prepare("CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit WHEN NEW.action='operations_quality_deliveries' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    const body={itemId:item.data.id,lotCode:'ATOMIC',customer:'합성',dueDate:'',quantity:1,reason:'시험',requestKey:randomUUID()};
    assert.equal((await a.call('/api/operations/quality/deliveries',body)).status,503);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM ops_deliveries').first()).n,0);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM ops_requests WHERE request_key=?').bind(body.requestKey).first()).n,0);
    await f.db.prepare('DROP TRIGGER fail_delivery_audit').run();
    assert.equal((await a.call('/api/operations/quality/deliveries',body)).status,200);
  }finally{await f.close();}
});
test('D1 0009는 기존 품목·재고·생산·계정 내용을 바꾸지 않고 재시작 후에도 유지한다',async()=>{
  const f=await fixture({attendanceMigration:false});try{
    for(const name of ['0005_attendance_reports.sql','0006_paid_break_policy.sql','0007_test_data_reset.sql','0008_operations.sql'])await applySql(f.db,'migrations/'+name);
    const tables=['users','employees','production','audit','ops_items','ops_lots','ops_inspections','ops_requests'];
    const before=await Promise.all(tables.map(table=>f.db.prepare('SELECT * FROM '+table).all()));
    await applySql(f.db,'migrations/0009_quality_deliveries.sql');
    const after=await Promise.all(tables.map(table=>f.db.prepare('SELECT * FROM '+table).all()));
    assert.deepEqual(after.map(r=>r.results),before.map(r=>r.results));
  }finally{await f.close();}
});
