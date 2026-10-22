import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fixture as nodeFixture} from '../helpers.mjs';
import {fixture,applySql} from './helpers.mjs';
const fingerprint=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('SQLite → D1: 원본 보존·WAL 최신 기록·모든 계정/업무/이력 내용 일치·세션 제외·덮어쓰기 거부',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'onwork-d1-migration-')),source=join(directory,'source.sqlite'),bundle=join(directory,'bundle');
  const old=nodeFixture(source),f=await fixture({empty:true});
  try{
    const e=old.client(),a=old.client();await e.login('001');await a.login('ADMIN');
    assert.equal((await e.call('/api/attendance',{action:'in'})).status,200);
    assert.equal((await e.call('/api/production',{taskId:'t1',good:7,bad:1,requestKey:old.key()})).status,200);
    const request=(await e.call('/api/work-requests',{type:'annual',startDate:'2026-10-01',endDate:'2026-10-01',allDay:true,reason:"자료 보존 '; 테스트"})).data;
    await a.call('/api/admin/work-requests/decision',{id:request.id,version:request.version,action:'approved',comment:'확인'});
    assert.ok(statSync(source+'-wal').size>0,'Source must have committed WAL rows');
    const before=[fingerprint(source),fingerprint(source+'-wal')];
    execFileSync('python3',['scripts/export-sqlite-d1.py','--source',source,'--out',bundle]);
    assert.deepEqual([fingerprint(source),fingerprint(source+'-wal')],before);
    assert.throws(()=>execFileSync('python3',['scripts/export-sqlite-d1.py','--source',source,'--out',bundle],{stdio:'pipe'}));
    await applySql(f.db,join(bundle,'import.sql'));
    const client=f.client();assert.equal((await client.login('001',old.password)).status,200);
    assert.equal((await client.call('/api/state')).data.production[0].good,7);
    assert.equal((await client.call('/api/work-requests')).data[0].status,'approved');
    assert.equal((await client.call('/api/work-requests/history?id='+request.id)).data.length,2);
    // Verification runs before serving traffic: remove test-created sessions only.
    await f.db.prepare('DELETE FROM sessions').run();
    await f.db.prepare('DELETE FROM login_limits').run();
    const schema=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all()).results;
    const sql=schema.map(r=>r.sql+';');
    for(const table of schema.filter(r=>r.type==='table')){
      for(const row of (await f.db.prepare(`SELECT * FROM "${table.name}"`).all()).results){
        const quote=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+value.replaceAll("'","''")+"'";
        sql.push(`INSERT INTO "${table.name}" (${Object.keys(row).map(c=>'"'+c+'"').join(',')}) VALUES(${Object.values(row).map(quote).join(',')});`);
      }
    }
    const dump=join(directory,'d1-export.sql'),verified=join(directory,'verified.sql');writeFileSync(dump,sql.join('\n')+'\n');
    execFileSync('python3',['scripts/verify-d1-import.py','--manifest',join(bundle,'manifest.json'),'--d1-export',dump,'--out',verified]);
    assert.match(readFileSync(verified,'utf8'),/verified=1/);
    assert.equal((await f.db.prepare('SELECT verified FROM worker_import WHERE id=1').first()).verified,0);
    await applySql(f.db,verified);assert.equal((await f.db.prepare('SELECT verified FROM worker_import WHERE id=1').first()).verified,1);
    await assert.rejects(applySql(f.db,join(bundle,'import.sql')));
    // A damaged content hash, even with identical row counts, must fail.
    writeFileSync(dump,readFileSync(dump,'utf8').replace("'조립'","'변조된 이름'"));
    assert.throws(()=>execFileSync('python3',['scripts/verify-d1-import.py','--manifest',join(bundle,'manifest.json'),'--d1-export',dump,'--out',join(directory,'bad.sql')],{stdio:'pipe'}));
    assert.equal(old.db.prepare('SELECT good FROM production').get().good,7);
  }finally{await f.close();old.db.close();rmSync(directory,{recursive:true,force:true});}
});
