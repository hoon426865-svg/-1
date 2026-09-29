import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installWorkRequests } from './work-requests.mjs';
export function openDatabase(path) {
  if (!path) throw new Error('DATABASE_PATH 환경변수가 필요합니다.');
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES(1);
    CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, team TEXT NOT NULL, site_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','employee')), employee_id TEXT UNIQUE REFERENCES employees(id) ON DELETE CASCADE, must_change INTEGER NOT NULL DEFAULT 1, CHECK((role='admin' AND employee_id IS NULL) OR (role='employee' AND employee_id IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attendance(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL, in_at TEXT NOT NULL, out_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(employee_id,date), CHECK(out_at IS NULL OR out_at>=in_at));
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON attendance(employee_id) WHERE out_at IS NULL;
    CREATE TABLE IF NOT EXISTS production(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id), task_name TEXT NOT NULL, date TEXT NOT NULL, recorded_at TEXT NOT NULL, good INTEGER NOT NULL CHECK(good BETWEEN 0 AND 999999), bad INTEGER NOT NULL CHECK(bad BETWEEN 0 AND 999999), version INTEGER NOT NULL DEFAULT 1, request_key TEXT NOT NULL, CHECK(good+bad>0), UNIQUE(employee_id,request_key));
    CREATE TABLE IF NOT EXISTS overtime(id TEXT PRIMARY KEY, attendance_id TEXT NOT NULL UNIQUE REFERENCES attendance(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN('approved','rejected')), actor_id TEXT NOT NULL, decided_at TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL, occurred_at TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT, after_json TEXT);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
    CREATE TABLE IF NOT EXISTS qr_challenges(hash TEXT PRIMARY KEY, site_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('in','out')), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS qr_uses(challenge_hash TEXT NOT NULL REFERENCES qr_challenges(hash) ON DELETE CASCADE, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, used_at TEXT NOT NULL, PRIMARY KEY(challenge_hash,employee_id));
    CREATE TABLE IF NOT EXISTS deletion_confirmations(hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_limits(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS initial_setup(id INTEGER PRIMARY KEY CHECK(id=1), completed_at TEXT NOT NULL);
    INSERT OR IGNORE INTO initial_setup(id,completed_at) SELECT 1,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS(SELECT 1 FROM users WHERE role='admin');
  `);
  if (path !== ':memory:') chmodSync(path, 0o600);
  if (db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v !== 1) throw new Error('지원하지 않는 데이터베이스 버전입니다.');
  installWorkRequests(db);
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function audit(db, actor, action, target, reason, before = null, after = null, now = new Date()) {
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), actor.id, actor.login, now.toISOString(), action, target, reason, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
}
