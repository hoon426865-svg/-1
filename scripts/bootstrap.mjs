import { openDatabase } from '../lib/db.mjs';
import { createInitialAdmin } from '../lib/setup.mjs';
if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) throw Error('ADMIN_LOGIN, ADMIN_PASSWORD 환경변수가 필요합니다.');
const db = openDatabase(process.env.DATABASE_PATH);
try {
  createInitialAdmin(db, process.env.ADMIN_LOGIN, process.env.ADMIN_PASSWORD);
  console.log('초기 관리자와 기본 작업을 생성했습니다. ADMIN_PASSWORD 환경변수를 제거하세요.');
} finally { db.close(); }
