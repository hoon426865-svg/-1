import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,applySql} from './helpers.mjs';
import {randomUUID} from 'node:crypto';
import {operationsScenario} from '../operations-scenario.mjs';
test('D1 품목·LOT 업무: 서버 권한·검토·재고·검사 원자성 및 재시도 보존',async()=>{
  const f=await fixture();try{
    await operationsScenario(f);
    await assert.rejects(f.db.prepare('DELETE FROM ops_inspections').run(),/immutable/);
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  }finally{await f.close();}
});
test('D1 업무 입고 배치가 실패하면 LOT·원장·감사·요청 식별자가 함께 롤백된다',async()=>{
  const f=await fixture();try{
    const a=f.client();await a.login('ADMIN');
    const created=await a.call('/api/operations/items',{drawing:'ATOMIC',name:'합성 품목',model:'TEST',kind:'part',unit:'EA',active:true,version:0,reason:'원자성 검증',requestKey:randomUUID()});
    assert.equal(created.status,200);
    await f.db.prepare("CREATE TRIGGER fail_movement BEFORE INSERT ON ops_movements BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    const body={itemId:created.data.id,lotCode:'ROLLBACK-01',supplier:'시험',quantity:5,reason:'원자성 검증',requestKey:randomUUID()};
    assert.equal((await a.call('/api/operations/materials/receive',body)).status,503);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM ops_lots').first()).n,0);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM ops_requests WHERE request_key=?').bind(body.requestKey).first()).n,0);
    await f.db.prepare('DROP TRIGGER fail_movement').run();
    assert.equal((await a.call('/api/operations/materials/receive',body)).status,200);
  }finally{await f.close();}
});
test('D1 운영 확장 마이그레이션은 기존 계정·생산·감사 자료를 보존한다',async()=>{
  const f=await fixture({attendanceMigration:false});try{
    for(const name of ['0005_attendance_reports.sql','0006_paid_break_policy.sql','0007_test_data_reset.sql'])await applySql(f.db,'migrations/'+name);
    const e=f.client();await e.login('001');
    assert.equal((await e.call('/api/production',{taskId:'t1',good:9,bad:1,requestKey:randomUUID()})).status,200);
    const tables=['users','employees','production','audit','sessions'];
    const before=await Promise.all(tables.map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
    await applySql(f.db,'migrations/0008_operations.sql');
    const after=await Promise.all(tables.map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
    assert.deepEqual(after.map(x=>x.results),before.map(x=>x.results));
    assert.equal((await e.call('/api/operations/context')).status,200);
  }finally{await f.close();}
});
