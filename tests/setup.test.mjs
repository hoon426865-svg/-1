import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.mjs';
import { createApplication } from '../lib/application.mjs';
import { createInitialAdmin } from '../lib/setup.mjs';
import { verifyPassword } from '../lib/security.mjs';

const settings = { origin: 'https://setup-test-3000.app.github.dev', secure: true, siteId: 'test-site' };
function request(app, path, body, origin = settings.origin) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (origin !== undefined) headers.origin = origin;
  return app(new Request(settings.origin + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

test('빈 DB 최초 화면·설정·로그인, 이후 초기 설정 재진입 및 재생성 차단', async () => {
  const db = openDatabase(':memory:');
  try {
    const app = createApplication(db, settings), password = randomUUID();
    assert.deepEqual(await (await request(app, '/api/setup')).json(), { required: true, appOrigin: settings.origin });
    assert.equal((await request(app, '/setup')).status, 200);
    assert.equal((await request(app, '/api/setup', { login: 'FIRST', password, confirmation: password })).status, 201);
    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.role, 'admin');
    assert.equal(user.must_change, 0);
    assert.equal(verifyPassword(password, user.password_hash), true);
    assert.notEqual(user.password_hash, password);
    assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 3);
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all());
    assert.equal(audit.includes(password), false);
    assert.equal(audit.includes(user.password_hash), false);
    const login = await request(app, '/api/login', { login: 'FIRST', password });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /^__Host-onwork=/);
    assert.equal((await request(app, '/api/setup')).status, 200);
    assert.equal((await (await request(app, '/api/setup')).json()).required, false);
    assert.equal((await request(app, '/setup')).status, 303);
    const rejected = await request(app, '/api/setup', { login: 'SECOND', password, confirmation: password });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.text()).includes(password), false);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1);
    assert.throws(() => createInitialAdmin(db, 'CLI-SECOND', randomUUID()), { status: 409 });
  } finally { db.close(); }
});

test('잘못된 입력·타 출처·누락 출처·단순 폼 전송은 관리자 생성 없이 거부한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const app = createApplication(db, settings), password = randomUUID();
    const body = { login: 'FIRST', password, confirmation: password };
    for (const origin of ['http://localhost:3000', 'https://other-3000.app.github.dev', 'null']) assert.equal((await request(app, '/api/setup', body, origin)).status, 403);
    assert.equal((await app(new Request(settings.origin + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).status, 403);
    assert.equal((await app(new Request(settings.origin + '/api/setup', { method: 'POST', headers: { origin: settings.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'login=FIRST' }))).status, 415);
    for (const change of [{ login: 'invalid account' }, { password: 'short', confirmation: 'short' }, { confirmation: randomUUID() }]) assert.equal((await request(app, '/api/setup', { ...body, ...change })).status, 400);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM initial_setup').get().n, 0);
    assert.equal((await (await request(app, '/api/setup')).json()).required, true);
  } finally { db.close(); }
});

test('서로 다른 DB 연결의 동시 초기 설정 중 한 건만 성공하고 재시작 후에도 잠긴다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'onwork-setup-'));
  const path = join(directory, 'test.sqlite');
  let db = openDatabase(path), second = openDatabase(path);
  try {
    const firstApp = createApplication(db, settings), secondApp = createApplication(second, settings);
    assert.equal((await (await request(firstApp, '/api/setup')).json()).required, true);
    assert.equal((await (await request(secondApp, '/api/setup')).json()).required, true);
    const password = randomUUID();
    const responses = await Promise.all([
      request(firstApp, '/api/setup', { login: 'FIRST', password, confirmation: password }),
      request(secondApp, '/api/setup', { login: 'SECOND', password, confirmation: password }),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal(db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n, 1);
    db.close();second.close();second = null;
    db = openDatabase(path);
    const restarted = createApplication(db, settings);
    assert.equal((await request(restarted, '/api/setup', { login: 'RESTART', password, confirmation: password })).status, 409);
    // Even an out-of-band removal of the account must not reopen public setup.
    db.prepare("DELETE FROM users WHERE role='admin'").run();
    assert.equal((await (await request(restarted, '/api/setup')).json()).required, false);
  } finally { db.close();second?.close();rmSync(directory, { recursive: true, force: true }); }
});

test('기존 관리자 DB도 초기 설정 완료로 인식한다', async () => {
  const db = openDatabase(':memory:');
  try {
    createInitialAdmin(db, 'EXISTING', randomUUID());
    db.prepare('DELETE FROM initial_setup').run(); // Simulate a pre-feature database.
    const app = createApplication(db, settings);
    assert.equal((await (await request(app, '/api/setup')).json()).required, false);
    const password = randomUUID();
    assert.equal((await request(app, '/api/setup', { login: 'SECOND', password, confirmation: password })).status, 409);
  } finally { db.close(); }
});
