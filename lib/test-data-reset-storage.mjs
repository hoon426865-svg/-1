import {readFileSync} from 'node:fs';
import {transaction} from './db.mjs';
import {check} from '../worker/d1.mjs';
import {listResetItems,prepareReset,executeReset,resetBackups,resetBackup} from '../worker/test-data-reset.mjs';

export function installTestReset(db){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_reset_backups'").get())return;
  const sql=readFileSync(new URL('../migrations/0007_test_data_reset.sql',import.meta.url),'utf8').split('-- worker_revision exists only on D1.')[0];
  transaction(db,()=>{
    db.exec(sql);
    for(const table of ['production','users','sessions','tasks','test_reset_backups'])for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER test_reset_revision_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE attendance_report_revision SET revision=revision+1 WHERE id=1; END;`);
  });
}
export async function testResetRoute(db,user,url,method,body,stamp){
  if(!url.pathname.startsWith('/api/admin/test-data'))return null;
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const wrap=(sql,args=[])=>({bind:(...args)=>wrap(sql,args),first:()=>db.prepare(sql).get(...args)||null,all:()=>({results:db.prepare(sql).all(...args)})});
  const store={prepare:wrap},revision=()=>db.prepare('SELECT revision FROM attendance_report_revision WHERE id=1').get().revision;
  const initial=revision(),writes=[],tx={revision:initial,add:(sql,...args)=>writes.push([sql,args])};
  if(url.searchParams.has('revision'))check(String(initial)===url.searchParams.get('revision'),409,'조회 중 변경되었습니다. 다시 조회하세요.');
  let result;
  if(url.pathname==='/api/admin/test-data/items'&&method==='GET')result=await listResetItems(store,user,url.searchParams,initial);
  else if(url.pathname==='/api/admin/test-data/preview'&&method==='POST')result=await prepareReset(store,tx,user,body,stamp);
  else if(url.pathname==='/api/admin/test-data/execute'&&method==='POST')result=await executeReset(store,tx,user,body,stamp);
  else if(url.pathname==='/api/admin/test-data/backups'&&method==='GET')result=await resetBackups(store,user);
  else if(url.pathname==='/api/admin/test-data/backup'&&method==='GET')result=await resetBackup(store,user,url.searchParams.get('id'));
  else check(false,404,'API를 찾을 수 없습니다.');
  check(initial===revision(),409,'조회 이후 변경되었습니다. 다시 확인하세요.');
  if(writes.length)transaction(db,()=>{check(initial===revision(),409,'삭제 대상이 변경되었습니다. 다시 확인하세요.');for(const [sql,args] of writes)db.prepare(sql).run(...args);});
  return result instanceof Response?result:new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
