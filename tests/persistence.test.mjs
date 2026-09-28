import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, audit } from '../lib/db.mjs';
test('DB 재연결 후 직원·작업·출퇴근·생산·승인·이력 유지 및 트랜잭션 롤백', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onwork-db-')); const file = join(dir, 'db.sqlite');
  let db = openDatabase(file);
  try {
    transaction(db, () => {
      db.prepare('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)').run('e1','001','직원','팀','site');
      db.prepare('INSERT INTO tasks(id,name) VALUES(?,?)').run('t1','조립');
      db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run('a1','e1','2026-09-28','2026-09-27T23:30:00.000Z','2026-09-28T09:00:00.000Z');
      db.prepare('INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,?,?,?,?,?,?,?)').run('p1','e1','t1','조립','2026-09-28','2026-09-28T08:00:00.000Z',10,1,'req');
      db.prepare('INSERT INTO overtime VALUES(?,?,?,?,?,?)').run('o1','a1','approved','admin','2026-09-28T10:00:00.000Z','확인');
      audit(db, { id:'admin', login:'admin' }, 'approve','a1','확인');
    });
    assert.throws(() => transaction(db, () => { db.prepare('UPDATE employees SET name=?').run('변경'); throw Error('rollback'); }));
    db.close(); db = openDatabase(file);
    for (const table of ['employees','tasks','attendance','production','overtime','audit']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);
    assert.equal(db.prepare('SELECT name FROM employees').get().name, '직원');
    assert.throws(() => db.exec('DELETE FROM audit'));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); rmSync(dir, {recursive:true,force:true}); }
});
