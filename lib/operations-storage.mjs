import {readFileSync} from 'node:fs';
import {operations} from '../worker/operations.mjs';
import {check} from '../worker/d1.mjs';
import {transaction} from './db.mjs';

export const operationsTables=['ops_permissions','ops_items','ops_runs','ops_lots','ops_movements','ops_inspections','ops_requests'];
export function installOperations(db){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ops_items'").get())return;
  transaction(db,()=>{
    db.exec(readFileSync(new URL('../migrations/0008_operations.sql',import.meta.url),'utf8').split('-- worker_revision exists only on D1.')[0]);
    for(const table of operationsTables)for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER operations_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE attendance_report_revision SET revision=revision+1 WHERE id=1; END;`);
  });
}
export async function operationsRoute(db,user,url,method,body,stamp){
  if(!url.pathname.startsWith('/api/operations/'))return null;
  const wrap=(sql,args=[])=>({bind:(...args)=>wrap(sql,args),first:()=>db.prepare(sql).get(...args)||null,all:()=>({results:db.prepare(sql).all(...args)})});
  const revision=()=>db.prepare('SELECT revision FROM attendance_report_revision WHERE id=1').get().revision;
  const initial=revision(),writes=[],tx={add:(sql,...args)=>writes.push([sql,args])};
  const result=await operations({prepare:wrap},tx,user,url,method,body,stamp);
  check(initial===revision(),409,'다른 변경이 있습니다. 다시 조회하세요.');
  if(writes.length)transaction(db,()=>{for(const [sql,args] of writes)db.prepare(sql).run(...args);});
  return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8'}});
}
