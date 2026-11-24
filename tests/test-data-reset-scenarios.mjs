import assert from 'node:assert/strict';
export async function runResetScenario(f,worker=false){
  const run=(sql,...args)=>worker?f.db.prepare(sql).bind(...args).run():f.db.prepare(sql).run(...args);
  const rows=async(sql,...args)=>worker?(await f.db.prepare(sql).bind(...args).all()).results:f.db.prepare(sql).all(...args);
  const count=async table=>(await rows('SELECT count(*) n FROM '+table))[0].n;
  const a=f.client(),e=f.client(),guest=f.client();await a.login('ADMIN');await e.login('001');
  const base='/api/admin/test-data';
  for(const path of ['/items?kind=attendance','/backups','/backup?id=missing']){assert.equal((await guest.call(base+path)).status,401);assert.equal((await e.call(base+path)).status,403);}
  for(const path of ['/preview','/execute'])assert.equal((await e.call(base+path,{})).status,403);
  assert.equal((await a.call(base+'/preview',{},'POST',{'x-csrf-token':'wrong'})).status,403);
  for(const [id,employee,day] of [['a1','e1','01'],['a2','e1','02'],['a3','e2','01']])await run('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)',id,employee,'2026-11-'+day,'2026-11-'+day+'T08:30:00+09:00','2026-11-'+day+'T17:30:00+09:00');
  for(const [id,employee] of [['p1','e1'],['p2','e2']])await run("INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,'t1','조립','2026-11-01','2026-11-01T09:00:00Z',7,1,?)",id,employee,id);
  await run("INSERT INTO overtime VALUES('o1','a1','approved','admin','2026-11-01T10:00:00Z','검토')");
  await run("INSERT INTO attendance_adjustments VALUES('adj1','a1',1,NULL,'확인','admin','ADMIN','2026-11-01T10:00:00Z')");
  for(const version of [1,2])await run("INSERT INTO attendance_finalizations VALUES(?,?,'2026-11',?,'attendance-2026-11-03-v2','[]','월말','admin','ADMIN','2026-12-01T00:00:00Z')",'s'+version,'e1',version);
  const created=await e.call('/api/work-requests',{type:'overtime',startDate:'2026-11-01',endDate:'2026-11-01',allDay:false,startTime:'17:30',endTime:'18:30',reason:'테스트 추가근무'});assert.equal(created.status,200);
  assert.equal((await a.call('/api/admin/work-requests/decision',{id:created.data.id,version:1,action:'approved',comment:'테스트 승인'})).status,200);
  if(worker){await run("INSERT INTO passkeys VALUES('preserved-test-key','admin',X'010203',5,'[]','2026-11-01T00:00:00Z')");await run("INSERT INTO passkey_account_state VALUES('admin',0)");}
  const protectedTables=['users','employees','tasks','attendance_policies',...(worker?['passkeys','passkey_account_state']:[])];
  const original=await Promise.all(protectedTables.map(t=>rows('SELECT * FROM '+t+' ORDER BY 1')));
  const preview=async(kind,ids)=>{const listed=await a.call(base+'/items?kind='+kind);assert.equal(listed.status,200);return a.call(base+'/preview',{kind,ids,revision:listed.data.revision});};
  let listed=await a.call(base+'/items?kind=attendance&employeeId=e1&from=2026-11-01&to=2026-11-01');assert.deepEqual(listed.data.items.map(r=>r.id),['a1']);
  assert.equal((await a.call(base+'/items?kind=users')).status,400);
  assert.equal((await a.call(base+'/preview',{kind:'attendance',ids:[],revision:listed.data.revision})).status,400);
  let p=await preview('attendance',['a1']);assert.equal(p.status,200);
  assert.equal(p.data.counts.find(c=>c.table==='attendance_finalizations').count,2);
  const before=await rows('SELECT * FROM attendance_originals WHERE attendance_id=?','a1');
  const commit={previewId:p.data.id,reason:'시험 기록 정리',confirmation:'테스트 기록 삭제'};
  assert.equal((await a.call(base+'/execute',{...commit,confirmation:'삭제'})).status,400);
  const result=await a.call(base+'/execute',commit);assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual((await rows('SELECT id FROM attendance ORDER BY id')).map(r=>r.id),['a2','a3']);
  assert.equal(await count('overtime'),0);assert.equal(await count('attendance_adjustments'),0);assert.equal(await count('attendance_finalizations'),0);
  assert.equal(await count('production'),2);assert.equal(await count('work_requests'),1);
  const backup=await a.call(base+'/backup?id='+result.data.backupId);assert.equal(backup.status,200);assert.deepEqual(backup.data.data.tables.attendance_originals,JSON.parse(JSON.stringify(before)));assert.equal(backup.data.data.tables.attendance.length,1);
  assert.equal(Object.hasOwn(backup.data.data.tables,'users'),false);assert.match(backup.headers.get('content-disposition'),/attachment/);
  assert.equal((await e.call(base+'/backup?id='+result.data.backupId)).status,403);
  assert.equal((await a.call(base+'/execute',commit)).status,409);
  for(const [kind,ids] of [['production',['p1']],['work_requests',[created.data.id]]]){p=await preview(kind,ids);assert.equal(p.status,200);assert.equal((await a.call(base+'/execute',{...commit,previewId:p.data.id})).status,200);}
  assert.deepEqual((await rows('SELECT id FROM production')).map(r=>r.id),['p2']);assert.equal(await count('work_requests'),0);assert.equal(await count('work_request_history'),0);
  for(let i=0;i<protectedTables.length;i++)assert.deepEqual(await rows('SELECT * FROM '+protectedTables[i]+' ORDER BY 1'),original[i],protectedTables[i]);
  assert.equal(await count('test_reset_backups'),3);assert.equal(await count('test_reset_guard'),0);assert.equal(await count('test_reset_items'),0);
  assert.equal((await rows("SELECT * FROM audit WHERE action='test_data_reset'")).length,3);
  assert.equal((await a.call('/api/me')).status,200);assert.equal((await e.call('/api/state')).status,200);
  await assert.rejects(async()=>run("DELETE FROM attendance_originals WHERE attendance_id='a2'"));
  await assert.rejects(async()=>run('DELETE FROM test_reset_backups'));
  await assert.rejects(async()=>run('DELETE FROM audit'));
  assert.equal((await rows('PRAGMA foreign_key_check')).length,0);
  for(const version of [1,2])await run("INSERT INTO attendance_finalizations VALUES(?,'e1','2026-11',?,'attendance-2026-11-03-v2','[]','다시 확정','admin','ADMIN','2026-12-02T00:00:00Z')",'f'+version,version);
  listed=await a.call(base+'/items?kind=attendance_finalizations&employeeId=e1&from=2026-11-15&to=2026-11-30');assert.deepEqual(listed.data.items.map(r=>r.id),['f2']);
  p=await preview('attendance_finalizations',['f2']);assert.equal(p.data.counts[0].count,2);assert.equal((await a.call(base+'/execute',{...commit,previewId:p.data.id})).status,200);
  assert.equal(await count('attendance_finalizations'),0);assert.equal(await count('attendance'),2);assert.equal(await count('attendance_originals'),2);
  const finalBackup=await a.call(base+'/backup?id='+p.data.id);assert.equal(finalBackup.data.data.tables.attendance_finalizations.length,2);assert.equal(finalBackup.data.data.tables.attendance,undefined);
  for(let i=0;i<51;i++)await run("INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,'e1','t1','목록 검사','2026-11-02','2026-11-02T09:00:00Z',1,0,?)",'page-'+String(i).padStart(3,'0'),'page-'+i);
  const page1=await a.call(base+'/items?kind=production&employeeId=e1');assert.equal(page1.data.items.length,50);assert.ok(page1.data.next);
  const page2=await a.call(base+'/items?kind=production&employeeId=e1&after='+page1.data.next+'&revision='+page1.data.revision);assert.equal(page2.data.items.length,1);assert.equal(page2.data.next,null);
  assert.equal((await a.call(base+'/preview',{kind:'production',ids:[...page1.data.items,...page2.data.items].map(r=>r.id),revision:page1.data.revision})).status,400);
}

export async function runResetConflictScenario(f,worker=false){
  const run=(sql,...args)=>worker?f.db.prepare(sql).bind(...args).run():f.db.prepare(sql).run(...args);
  const count=async table=>worker?(await f.db.prepare('SELECT count(*) n FROM '+table).first()).n:f.db.prepare('SELECT count(*) n FROM '+table).get().n;
  const a=f.client(),base='/api/admin/test-data';await a.login('ADMIN');
  await run("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('x','e1','2026-11-01','2026-11-01T08:30:00Z','2026-11-01T17:30:00Z')");
  const prepare=async()=>{const list=await a.call(base+'/items?kind=attendance');const p=await a.call(base+'/preview',{kind:'attendance',ids:['x'],revision:list.data.revision});assert.equal(p.status,200);return {previewId:p.data.id,reason:'테스트',confirmation:'테스트 기록 삭제'};};
  let body=await prepare();await run("UPDATE attendance SET version=version+1 WHERE id='x'");assert.equal((await a.call(base+'/execute',body)).status,409);
  body=await prepare();await run("UPDATE test_reset_previews SET actor_id='another-admin' WHERE id=?",body.previewId);const denied=await a.call(base+'/execute',body);assert.equal(denied.status,409);assert.match(denied.data.error,/본인 계정/);
  body=await prepare();await run('UPDATE test_reset_previews SET expires=0');assert.equal((await a.call(base+'/execute',body)).status,409);
  body=await prepare();
  await run("CREATE TRIGGER test_fail_reset BEFORE DELETE ON attendance BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.equal((await a.call(base+'/execute',body)).status,worker?503:500);
  assert.equal(await count('attendance'),1);assert.equal(await count('attendance_originals'),1);assert.equal(await count('test_reset_backups'),0);assert.equal(await count('test_reset_items'),0);assert.equal(await count('test_reset_guard'),0);
  await run('DROP TRIGGER test_fail_reset');
  assert.equal((await a.call(base+'/execute',body)).status,200);
  assert.equal(await count('attendance'),0);assert.equal(await count('attendance_originals'),0);assert.equal(await count('test_reset_backups'),1);
}
