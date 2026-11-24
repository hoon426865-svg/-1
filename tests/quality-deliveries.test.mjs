import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {qualityDeliveriesScenario} from './quality-deliveries-scenario.mjs';
import {drawingFamily,isDeliveryItem,resolveDrawing} from '../public/operations-domain.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../lib/db.mjs';
import {installOperations} from '../lib/operations-storage.mjs';
import {createBackup,restoreBackup} from '../lib/backup.mjs';

test('AS 품질 직접 납품 흐름과 부품 자재 입고 흐름의 권한·이력·수량을 분리한다',async()=>{
  const f=fixture();try{
    await qualityDeliveriesScenario(f);
    assert.throws(()=>f.db.exec('DELETE FROM ops_delivery_inspections'),/immutable/);
    assert.throws(()=>f.db.exec('DELETE FROM ops_deliveries'),/retained/);
    assert.throws(()=>f.db.exec("UPDATE ops_deliveries SET quantity=999 WHERE status='delivered'"),/immutable/);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{f.db.close();}
});
test('Node 0008 자료 보존 업그레이드·재시작과 AS 납품/검사 백업 복원',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'onwork-quality-storage-')),path=join(dir,'live.sqlite'),f=fixture(path);let reopened;
  try{
    // Reconstruct an old installation in an isolated fixture, with existing accounts/production.
    const employee=f.client();await employee.login('001');
    assert.equal((await employee.call('/api/production',{taskId:'t1',good:3,bad:0,requestKey:f.key()})).status,200);
    f.db.exec('DROP TABLE ops_delivery_inspections; DROP TABLE ops_deliveries;');
    const tables=['users','employees','production','audit','sessions','ops_items','ops_lots','ops_inspections'];
    const snapshot=db=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
    const before=snapshot(f.db);installOperations(f.db);installOperations(f.db);assert.deepEqual(snapshot(f.db),before);
    assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'operations_ops_deliver%'").get().n,6);
    // A complete workflow supplies real related rows for both backup and a new database connection.
    f.db.close();reopened=openDatabase(path);assert.deepEqual(snapshot(reopened),before);reopened.close();reopened=null;
    // Use another isolated fixture for the scenario's expected counts.
    const full=fixture();try{
      await qualityDeliveriesScenario(full);
      const backup=join(dir,'backup.sqlite'),restored=join(dir,'restored.sqlite');
      const counts=await createBackup(full.db,backup);assert.equal(counts.ops_deliveries,2);assert.equal(counts.ops_delivery_inspections,2);
      assert.deepEqual(await restoreBackup(backup,restored),counts);
      reopened=openDatabase(restored);
      for(const table of ['ops_deliveries','ops_delivery_inspections','ops_lots','ops_movements','audit'])assert.deepEqual(reopened.prepare('SELECT * FROM '+table+' ORDER BY id').all(),full.db.prepare('SELECT * FROM '+table+' ORDER BY id').all());
      assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{full.db.close();}
  }finally{reopened?.close();if(f.db.isOpen)f.db.close();rmSync(dir,{recursive:true,force:true});}
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
