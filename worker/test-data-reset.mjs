import {check,one,all,audit} from './d1.mjs';
import {date} from '../lib/work-requests.mjs';

const kinds={attendance:'출퇴근',production:'생산량',work_requests:'신청·승인',attendance_finalizations:'월별 확정 자료'};
const keys={attendance:'id',production:'id',work_requests:'id',work_request_history:'id',overtime:'id',attendance_originals:'attendance_id',attendance_adjustments:'id',attendance_finalizations:'id'};
const labels={...kinds,work_request_history:'신청 처리 이력',overtime:'출퇴근별 야근 승인',attendance_originals:'출퇴근 원본',attendance_adjustments:'집계 시작 예외'};
const order=['attendance_finalizations','attendance_adjustments','overtime','attendance_originals','work_request_history','work_requests','production','attendance'];
const MAX_ROWS=500,MAX_BYTES=250000;
const requestTypes={overtime:'야근·추가 근무',annual:'연차',monthly:'월차',early:'조퇴',absence:'결근·기타 부재'},statuses={pending:'대기',approved:'승인',rejected:'반려'};
const localStamp=value=>{const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms+9*3600000).toISOString().slice(0,19).replace('T',' '):'시각 확인 필요';};
const idsSql='SELECT value FROM json_each(?)';
const admin=user=>check(user?.role==='admin',403,'관리자 권한이 필요합니다.');
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const validKind=value=>{check(typeof value==='string'&&Object.hasOwn(kinds,value),400,'삭제할 자료 종류를 선택하세요.');return value;};
const short=value=>{check(typeof value==='string'&&value.length<=100,400,'조회 조건을 확인하세요.');return value;};

export async function listResetItems(db,user,params,revision){
  admin(user);const kind=validKind(params.get('kind')),where=['r.id>?'],args=[short(params.get('after')||'')];
  const employee=short(params.get('employeeId')||'');if(employee){where.push('r.employee_id=?');args.push(employee);}
  const from=params.get('from')?date(params.get('from')):null,to=params.get('to')?date(params.get('to')):null;
  check(!from||!to||from<=to,400,'조회 시작일과 종료일을 확인하세요.');
  const first=kind==='work_requests'?'start_date':kind==='attendance_finalizations'?'month':'date';
  const last=kind==='work_requests'?'end_date':first;
  if(from){where.push(`r.${last}>=?`);args.push(kind==='attendance_finalizations'?from.slice(0,7):from);}
  if(to){where.push(`r.${first}<=?`);args.push(kind==='attendance_finalizations'?to.slice(0,7):to);}
  if(kind==='attendance_finalizations')where.push('r.version=(SELECT MAX(x.version) FROM attendance_finalizations x WHERE x.employee_id=r.employee_id AND x.month=r.month)');
  const rows=await all(db,`SELECT r.*,e.number,e.name FROM ${kind} r JOIN employees e ON e.id=r.employee_id WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT 51`,...args);
  const items=rows.slice(0,50).map(r=>({id:r.id,employeeId:r.employee_id,number:r.number,name:r.name,date:r[first],
    detail:kind==='attendance'?`${localStamp(r.in_at)} ~ ${r.out_at?localStamp(r.out_at):'퇴근 누락'}`:kind==='production'?`${r.task_name} · 양품 ${r.good} / 불량 ${r.bad}`:kind==='work_requests'?`${requestTypes[r.type]||r.type} · ${r.start_date}~${r.end_date} · ${statuses[r.status]||r.status}`:`${r.month} · 최신 v${r.version} (해당 월 모든 버전)`}));
  return {kind,label:kinds[kind],items,next:rows.length>50?items.at(-1).id:null,revision};
}

async function collect(db,selection){
  const {kind,ids}=selection,tables={},encoded=JSON.stringify(ids);
  const roots=await all(db,`SELECT * FROM ${kind} WHERE id IN(${idsSql}) ORDER BY id`,encoded);
  check(roots.length===ids.length,409,'선택한 기록이 변경되었습니다. 목록을 다시 조회하세요.');
  const ranges=roots.map(r=>({employee:r.employee_id,from:r.date?.slice(0,7)||r.start_date?.slice(0,7)||r.month,to:r.date?.slice(0,7)||r.end_date?.slice(0,7)||r.month}));
  const read=async(table,column,values)=>{
    tables[table]=await all(db,`SELECT * FROM ${table} WHERE ${column} IN(${idsSql}) ORDER BY ${keys[table]} LIMIT ${MAX_ROWS+1}`,JSON.stringify(values));
    check(tables[table].length<=MAX_ROWS,413,'연결 기록이 많습니다. 더 적은 항목을 선택하세요.');
  };
  tables[kind]=roots;
  if(kind==='attendance'){
    await read('attendance_originals','attendance_id',ids);await read('attendance_adjustments','attendance_id',ids);await read('overtime','attendance_id',ids);
  }
  if(kind==='work_requests')await read('work_request_history','request_id',ids);
  if(kind!=='production'){
    tables.attendance_finalizations=await all(db,`SELECT f.* FROM attendance_finalizations f WHERE EXISTS(SELECT 1 FROM json_each(?) x WHERE f.employee_id=json_extract(x.value,'$.employee') AND f.month BETWEEN json_extract(x.value,'$.from') AND json_extract(x.value,'$.to')) ORDER BY f.id LIMIT ${MAX_ROWS+1}`,JSON.stringify(ranges));
    check(tables.attendance_finalizations.length<=MAX_ROWS,413,'연결된 확정본이 많습니다. 범위를 줄여 주세요.');
  }
  const payload=JSON.stringify({version:1,selection,tables});
  check(new TextEncoder().encode(payload).length<=MAX_BYTES,413,'복구 사본이 큽니다. 더 적은 항목을 선택하세요.');
  const counts=Object.entries(tables).filter(([,rows])=>rows.length).map(([table,rows])=>({table,label:labels[table],count:rows.length}));
  return {payload,tables,counts,fingerprint:await hash(payload)};
}

export async function prepareReset(db,tx,user,body,stamp){
  admin(user);const kind=validKind(body.kind);
  check(Array.isArray(body.ids)&&body.ids.length>0&&body.ids.length<=50&&body.ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=100),400,'1~50개의 기록을 선택하세요.');
  check(body.revision===tx.revision,409,'목록 조회 이후 변경되었습니다. 다시 조회하세요.');
  const selection={kind,ids:[...new Set(body.ids)].sort()};check(selection.ids.length===body.ids.length,400,'중복 선택입니다.');
  const data=await collect(db,selection),id=crypto.randomUUID(),expires=Date.parse(stamp)+600000;
  tx.add('DELETE FROM test_reset_previews WHERE expires<?',Date.parse(stamp));
  tx.add('INSERT INTO test_reset_previews VALUES(?,?,?,?,?,?)',id,user.id,tx.revision,JSON.stringify(selection),data.fingerprint,expires);
  return {id,expires,counts:data.counts,selected:selection.ids.length,revision:tx.revision,
    notice:'연결된 월별 확정본은 모든 버전이 함께 삭제됩니다. 복구용 사본과 기존 감사 기록은 서버에 보관합니다. 계정·직원 명부·패스키·작업 종류·근무 기준은 유지합니다.'};
}

export async function executeReset(db,tx,user,body,stamp){
  admin(user);check(body.confirmation==='테스트 기록 삭제',400,'확인 문구를 정확히 입력하세요.');
  check(typeof body.reason==='string'&&body.reason.trim().length>0&&body.reason.trim().length<=500,400,'삭제 사유를 1~500자로 입력하세요.');
  const preview=await one(db,'SELECT * FROM test_reset_previews WHERE id=?',short(body.previewId||''));
  check(preview&&preview.actor_id===user.id,409,'본인 계정으로 삭제 대상을 다시 확인하세요.');
  check(preview.expires>Date.parse(stamp),409,'확인 시간이 지났습니다. 삭제 대상을 다시 확인하세요.');
  check(preview.revision===tx.revision,409,'확인 이후 변경되었습니다. 목록과 삭제 대상을 다시 확인하세요.');
  const data=await collect(db,JSON.parse(preview.selection_json));
  check(data.fingerprint===preview.fingerprint,409,'삭제 대상이 변경되었습니다. 다시 확인하세요.');
  tx.add('INSERT INTO test_reset_backups VALUES(?,?,?,?,?,?,?)',preview.id,user.id,user.login,stamp,body.reason.trim(),JSON.stringify(data.counts),data.payload);
  for(const [table,rows] of Object.entries(data.tables))if(rows.length){
    tx.add('INSERT INTO test_reset_items(reset_id,table_name,row_id) SELECT ?,?,value FROM json_each(?)',preview.id,table,JSON.stringify(rows.map(r=>r[keys[table]])));
  }
  tx.add('INSERT INTO test_reset_guard VALUES(1,?)',preview.id);
  for(const table of order)if(data.tables[table]?.length)tx.add(`DELETE FROM ${table} WHERE ${keys[table]} IN(SELECT row_id FROM test_reset_items WHERE reset_id=? AND table_name=?)`,preview.id,table);
  tx.add('DELETE FROM test_reset_guard WHERE id=1');
  tx.add('DELETE FROM test_reset_items WHERE reset_id=?',preview.id);
  tx.add('DELETE FROM test_reset_previews WHERE id=?',preview.id);
  audit(tx,user,'test_data_reset',preview.id,body.reason.trim(),{counts:data.counts},{backupId:preview.id},stamp);
  return {ok:true,backupId:preview.id,counts:data.counts};
}

export async function resetBackups(db,user){admin(user);return all(db,'SELECT id,actor_login,created_at,reason,counts_json FROM test_reset_backups ORDER BY created_at DESC,id DESC LIMIT 20');}
export async function resetBackup(db,user,id){
  admin(user);const row=await one(db,'SELECT * FROM test_reset_backups WHERE id=?',short(id||''));check(row,404,'복구 사본을 찾을 수 없습니다.');
  return new Response(JSON.stringify({...row,counts:JSON.parse(row.counts_json),data:JSON.parse(row.payload_json),payload_json:undefined,counts_json:undefined}),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="onwork-test-reset-${row.id}.json"`,'Cache-Control':'no-store'}});
}
