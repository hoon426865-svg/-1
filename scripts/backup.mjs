import { DatabaseSync } from 'node:sqlite';
import { createBackup } from '../lib/backup.mjs';
if(!process.env.DATABASE_PATH || !process.env.BACKUP_PATH)throw Error('DATABASE_PATH, BACKUP_PATH 환경변수가 필요합니다.');
const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});
try{console.log('백업 검증 완료:',await createBackup(db,process.env.BACKUP_PATH));}finally{db.close();}
