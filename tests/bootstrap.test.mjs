import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../lib/security.mjs';

test('초기 관리자 생성은 비밀번호를 출력하지 않고 해시 저장하며 기존 계정을 보호한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'onwork-bootstrap-'));
  try {
    const password = randomUUID(), path = join(directory, 'test.sqlite');
    const env = { ...process.env, DATABASE_PATH: path, ADMIN_LOGIN: 'TEST-ADMIN', ADMIN_PASSWORD: password };
    const run = () => spawnSync(process.execPath, ['scripts/bootstrap.mjs'], { env, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0);
    assert.equal((first.stdout + first.stderr).includes(password), false);
    const repeated = run();
    assert.notEqual(repeated.status, 0);
    assert.equal((repeated.stdout + repeated.stderr).includes(password), false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const users = db.prepare('SELECT * FROM users').all();
      assert.equal(users.length, 1);
      assert.notEqual(users[0].password_hash, password);
      assert.equal(verifyPassword(password, users[0].password_hash), true);
      assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 3);
    } finally { db.close(); }
    const nonInteractive = spawnSync('bash', ['scripts/setup-admin.sh'], { env, encoding: 'utf8', input: '' });
    assert.notEqual(nonInteractive.status, 0);
    assert.equal((nonInteractive.stdout + nonInteractive.stderr).includes(password), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
