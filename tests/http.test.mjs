import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture } from './helpers.mjs';
import { createHttpServer } from '../lib/http.mjs';
import { createApplication } from '../lib/application.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

test('실제 HTTP 서버에서 로그인 쿠키·권한·정적 화면·로그아웃 연결', { timeout: 15000 }, async () => {
  const f = fixture();
  let application;
  const server = createHttpServer(request => application(request), 'http://127.0.0.1');
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    application = createApplication(f.db, { ...f.config, origin });
    const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
    assert.equal((await request('/')).status, 303);
    assert.equal((await request('/admin')).status, 401);
    assert.equal((await request('/login')).status, 200);
    assert.equal((await request('/app.js')).status, 200);
    const credentials = { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ login: '001', password: f.password }) };
    const invalid = await request('/api/login', { ...credentials, body: JSON.stringify({ login: '001', password: f.key() }) });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.has('set-cookie'), false);
    const login = await request('/api/login', credentials);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const me = await (await request('/api/me', { headers: { cookie } })).json();
    const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': me.csrf };
    const page = await request('/employee', { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="screen"/);
    assert.equal((await request('/admin', { headers })).status, 403);
    assert.equal((await request('/api/state?employeeId=e2', { headers })).status, 403);
    const post = (path, body) => request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('/api/admin/employee', { name: '권한 우회 시도' })).status, 403);
    assert.equal((await post('/api/attendance', { action: 'in', employeeId: 'e2' })).status, 403);
    assert.equal((await post('/api/production', { employeeId: 'e2', taskId: 't1', good: 10, bad: 0, requestKey: f.key() })).status, 403);
    assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM production').get().n, 0);
    assert.equal((await request('/api/attendance', { method: 'POST', headers, body: JSON.stringify({ action: 'in' }) })).status, 200);
    assert.equal((await post('/api/production', { taskId: 't1', good: 3, bad: 1, requestKey: f.key() })).status, 200);
    const own = await (await request('/api/state', { headers })).json();
    assert.deepEqual(own.employees.map(item => item.id), ['e1']);
    assert.deepEqual(own.attendance.map(item => item.employeeId), ['e1']);
    assert.deepEqual(own.production.map(item => item.employeeId), ['e1']);
    assert.equal((await request('/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await request('/api/state', { headers })).status, 401);
    const admin = await request('/api/login', { ...credentials, body: JSON.stringify({ login: 'ADMIN', password: f.password }) });
    const adminCookie = admin.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/admin', { headers: { cookie: adminCookie } })).status, 200);
    const all = await (await request('/api/state', { headers: { cookie: adminCookie } })).json();
    assert.equal(all.employees.length, 2);
    assert.equal(all.production.reduce((sum, record) => sum + record.good, 0), 3);
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    f.db.close();
  }
});

test('server.mjs 실행 진입점에서 로그인하고 저장된 본인 기록을 재시작 후 조회한다', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'onwork-http-'));
  const databasePath = join(directory, 'test.sqlite');
  const f = fixture(databasePath);
  const password = f.password;
  f.db.close();
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  try {
    // Reserve a free local port before launching the real entry point.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    async function start() {
      child = spawn(process.execPath, ['server.mjs'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin, DATABASE_PATH: databasePath, SITE_ID: 'site-1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(Error('서버 시작 시간 초과')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(Error(`서버 조기 종료: ${code}`)); });
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('온워크 실행:')) { clearTimeout(timer); resolve(); } });
        child.stderr.resume();
      });
    }
    await start();
    const login = await fetch(origin + '/api/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ login: '001', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(origin + '/api/me', { headers: { cookie } })).json();
    const saved = await fetch(origin + '/api/production', {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ taskId: 't1', good: 4, bad: 0, requestKey: f.key() }),
    });
    assert.equal(saved.status, 200);
    await stop();
    await start();
    const result = await fetch(origin + '/api/state', { headers: { cookie } });
    assert.equal(result.status, 200);
    const state = await result.json();
    assert.deepEqual(state.employees.map(item => item.id), ['e1']);
    assert.equal(state.production[0].good, 4);
    assert.equal((await fetch(origin + '/employee', { headers: { cookie } })).status, 200);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codespaces 출처를 사용하는 실제 HTTP 최초 설정→로그인→관리자 직원 생성·재설정', { timeout: 15000 }, async () => {
  const { openDatabase } = await import('../lib/db.mjs');
  const { config } = await import('../lib/security.mjs');
  const { randomUUID } = await import('node:crypto');
  const db = openDatabase(':memory:');
  const settings = config({ CODESPACE_NAME: 'http-test', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', PORT: '3000' });
  const server = createHttpServer(createApplication(db, settings), settings.origin);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const local = `http://127.0.0.1:${server.address().port}`;
    const headers = { origin: 'http://localhost:3000', referer: settings.origin + '/setup', 'sec-fetch-site': 'same-origin', 'x-onwork-origin': settings.origin, 'content-type': 'application/json' };
    const post = (path, body, extra = {}) => fetch(local + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), redirect: 'manual' });
    assert.equal((await (await fetch(local + '/api/setup')).json()).required, true);
    assert.equal((await fetch(local + '/setup')).status, 200);
    const password = randomUUID(), body = { login: 'FIRST', password, confirmation: password };
    assert.equal((await post('/api/setup', body, { origin: 'http://localhost:3000', referer: '' })).status, 403);
    assert.equal((await post('/api/setup', body)).status, 201);
    assert.equal((await post('/api/setup', body)).status, 409);
    assert.equal((await fetch(local + '/setup', { redirect: 'manual' })).status, 303);
    const login = await post('/api/login', { login: 'FIRST', password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(local + '/api/me', { headers: { cookie } })).json();
    const adminHeaders = { cookie, 'x-csrf-token': me.csrf };
    assert.equal((await fetch(local + '/admin', { headers: { cookie } })).status, 200);
    const employee = await post('/api/admin/employee', { name: '시험', number: 'TEST-1', team: '시험팀', password: randomUUID(), reason: '시험 계정', role: 'admin' }, adminHeaders);
    assert.equal(employee.status, 200);
    const id = (await employee.json()).id;
    assert.equal(db.prepare('SELECT role FROM users WHERE employee_id=?').get(id).role, 'employee');
    const reset = { id, password: randomUUID(), reason: '시험 재설정' };
    assert.equal((await post('/api/admin/reset-password', reset)).status, 401);
    assert.equal((await post('/api/admin/reset-password', reset, adminHeaders)).status, 200);
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();await closed;db.close();
  }
});
