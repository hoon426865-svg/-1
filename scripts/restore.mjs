import { restoreBackup } from '../lib/backup.mjs';
if(process.env.CONFIRM_RESTORE!=='YES')throw Error('앱을 중지하거나 점검 모드로 전환하고 CONFIRM_RESTORE=YES를 지정하세요.');
if((process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_ENVIRONMENT_ID) && process.env.MAINTENANCE_MODE!=='1')throw Error('Railway 서비스 변수에 MAINTENANCE_MODE=1을 적용한 뒤 복구하세요.');
console.log('새 DB에 복구·검증 완료:',await restoreBackup(process.env.BACKUP_PATH,process.env.RESTORE_PATH));
console.log('DATABASE_PATH를 복구 파일로 변경한 후 앱을 시작하세요. 모든 사용자는 다시 로그인해야 합니다.');
