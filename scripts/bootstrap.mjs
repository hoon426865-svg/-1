import { randomUUID } from 'node:crypto';
import { openDatabase, transaction, audit } from '../lib/db.mjs';
import { hashPassword } from '../lib/security.mjs';
if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) throw Error('ADMIN_LOGIN, ADMIN_PASSWORD 환경변수가 필요합니다.');
const passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
const db = openDatabase(process.env.DATABASE_PATH);
try {
  transaction(db, () => {
    if (db.prepare("SELECT id FROM users WHERE role='admin'").get()) throw Error('관리자가 이미 있습니다. 초기화를 중단합니다.');
    const id = randomUUID(), login = process.env.ADMIN_LOGIN.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,30}$/.test(login)) throw Error('관리자 로그인은 영문·숫자·하이픈 1~30자입니다.');
    db.prepare("INSERT INTO users(id,login,password_hash,role,must_change) VALUES(?,?,?,'admin',0)").run(id,login,passwordHash);
    for (const name of ['부품 조립','제품 검사','포장']) db.prepare('INSERT INTO tasks(id,name) VALUES(?,?)').run(randomUUID(),name);
    audit(db,{id,login},'bootstrap',id,'초기 관리자 생성');
  });
  console.log('초기 관리자와 기본 작업을 생성했습니다. ADMIN_PASSWORD 환경변수를 제거하세요.');
} finally { db.close(); }
