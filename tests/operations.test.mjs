import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {operationsScenario} from './operations-scenario.mjs';
test('품목·LOT: 권한, 생산 검토·정정, 입출고, 부적합 보류·재검사 및 중복 저장 방지',async()=>{
  const f=fixture();try{
    await operationsScenario(f);
    assert.throws(()=>f.db.exec('DELETE FROM ops_inspections'),/immutable/);
    assert.throws(()=>f.db.exec('UPDATE ops_movements SET quantity=999'),/immutable/);
    assert.throws(()=>f.db.exec('DELETE FROM production'),/retained/);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.ok(f.db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'operations_%'").get().n>10);
  }finally{f.db.close();}
});
