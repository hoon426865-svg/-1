import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function verifyDatabase(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('DB 무결성 검사 실패');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('외래키 검사 실패');
    if(db.prepare('SELECT MAX(version) v FROM schema_version').get().v!==1)throw Error('스키마 버전 불일치');
    return Object.fromEntries(['employees','tasks','attendance','production','overtime','audit'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
  }finally{db.close();}
}
export async function createBackup(db,target) {
  if(!target || existsSync(target))throw Error('백업은 존재하지 않는 새 파일 경로로 지정하세요.');
  mkdirSync(dirname(resolve(target)),{recursive:true,mode:0o700});
  await backup(db,target);chmodSync(target,0o600);return verifyDatabase(target);
}
export async function restoreBackup(source,target) {
  if(!source || !target || existsSync(target) || existsSync(target+'-wal') || existsSync(target+'-shm'))throw Error('복구 대상은 WAL/SHM을 포함하여 존재하지 않는 새 경로여야 합니다.');
  verifyDatabase(source);
  const db=new DatabaseSync(source,{readOnly:true});
  try{await createBackup(db,target);}finally{db.close();}
  const restored=new DatabaseSync(target);
  try{restored.exec('PRAGMA foreign_keys=ON; DELETE FROM sessions; DELETE FROM qr_challenges; DELETE FROM deletion_confirmations; DELETE FROM login_limits;');}finally{restored.close();}
  return verifyDatabase(target);
}
