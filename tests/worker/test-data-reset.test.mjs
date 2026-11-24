import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,applySql} from './helpers.mjs';
import {runResetScenario,runResetConflictScenario} from '../test-data-reset-scenarios.mjs';
test('D1 선택 초기화: 권한·연결 자료·복구 사본·계정 보존',async()=>{const f=await fixture();try{await runResetScenario(f,true);}finally{await f.close();}});
test('D1 초기화 충돌·만료·원자적 실패·재시도',async()=>{const f=await fixture();try{await runResetConflictScenario(f,true);}finally{await f.close();}});
test('D1 초기화 마이그레이션은 기존 모든 자료를 보존하고 일반 삭제를 차단한다',async()=>{
  const f=await fixture({attendanceMigration:false});try{
    await applySql(f.db,'migrations/0005_attendance_reports.sql');await applySql(f.db,'migrations/0006_paid_break_policy.sql');
    await f.db.batch([
      f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('old-a','e1','2026-11-01','2026-11-01T08:30:00+09:00','2026-11-01T17:30:00+09:00')"),
      f.db.prepare("INSERT INTO attendance_adjustments VALUES('old-adj','old-a',1,NULL,'기존 예외','admin','ADMIN','2026-11-01T10:00:00Z')"),
      f.db.prepare("INSERT INTO attendance_finalizations VALUES('old-final','e1','2026-11',1,'attendance-2026-11-03-v2','[]','기존 확정','admin','ADMIN','2026-12-01T00:00:00Z')"),
      f.db.prepare("INSERT INTO passkeys VALUES('old-passkey','admin',X'010203',5,'[]','2026-11-01T00:00:00Z')"),
      f.db.prepare("INSERT INTO audit VALUES('old-audit','admin','ADMIN','2026-11-01T00:00:00Z','test_fixture','old-a','기존 감사 이력',NULL,NULL)"),
    ]);
    const a=f.client(),e=f.client();await a.login('ADMIN');await e.login('001');
    assert.equal((await e.call('/api/work-requests',{type:'annual',startDate:'2026-11-10',endDate:'2026-11-10',allDay:true,reason:'기존 신청'})).status,200);
    const tables=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name!='worker_revision' ORDER BY name").all()).results.map(r=>r.name);
    const before=await Promise.all(tables.map(t=>f.db.prepare('SELECT * FROM "'+t+'" ORDER BY 1').all()));
    await applySql(f.db,'migrations/0007_test_data_reset.sql');
    for(let i=0;i<tables.length;i++)assert.deepEqual((await f.db.prepare('SELECT * FROM "'+tables[i]+'" ORDER BY 1').all()).results,before[i].results,tables[i]);
    for(const table of ['attendance_originals','attendance_adjustments','attendance_finalizations','work_requests','work_request_history','audit']){
      assert.ok((await f.db.prepare('SELECT count(*) n FROM '+table).first()).n>0,table+' fixture');
      await assert.rejects(()=>f.db.prepare('DELETE FROM '+table).run(),undefined,table);
    }
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM test_reset_backups').first()).n,0);
    assert.equal((await a.call('/api/admin/test-data/items?kind=attendance')).data.items.length,1);
  }finally{await f.close();}
});
