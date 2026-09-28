import { randomUUID } from 'node:crypto';
import { transaction, audit } from './db.mjs';
import { hashPassword } from './security.mjs';

export class SetupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function needsInitialSetup(db) {
  return !db.prepare('SELECT 1 FROM initial_setup WHERE id=1').get()
    && !db.prepare("SELECT 1 FROM users WHERE role='admin'").get();
}
export function createInitialAdmin(db, login, password, now = new Date()) {
  // The check and completion marker share the same write transaction, including
  // requests arriving through other server processes or the CLI.
  return transaction(db, () => {
    if (!needsInitialSetup(db)) throw new SetupError(409, '초기 관리자 설정이 이미 완료되었습니다. 로그인해 주세요.');
    const normalized = typeof login === 'string' ? login.trim().toUpperCase() : '';
    if (!/^[A-Z0-9-]{1,30}$/.test(normalized)) throw new SetupError(400, '관리자 계정은 영문·숫자·하이픈 1~30자입니다.');
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(normalized)) throw new SetupError(409, '이미 사용 중인 계정입니다.');
    let hash;
    try { hash = hashPassword(password); } catch (error) { throw new SetupError(400, error.message); }
    const id = randomUUID();
    db.prepare("INSERT INTO users(id,login,password_hash,role,must_change) VALUES(?,?,?,'admin',0)").run(id, normalized, hash);
    for (const name of ['부품 조립', '제품 검사', '포장']) db.prepare('INSERT OR IGNORE INTO tasks(id,name) VALUES(?,?)').run(randomUUID(), name);
    db.prepare('INSERT INTO initial_setup VALUES(1,?)').run(now.toISOString());
    audit(db, { id, login: normalized }, 'bootstrap', id, '초기 관리자 생성', null, null, now);
    return { ok: true };
  });
}
