import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../lib/security.mjs';
import { createApplication } from '../lib/application.mjs';
import { fixture } from './helpers.mjs';

const codespace = { CODESPACE_NAME: 'sample-workspace', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', PORT: '3000' };
test('Codespaces HTTPS 출처 자동 설정, 수동 주소 우선 및 운영 설정 검증', () => {
  assert.equal(config(codespace).origin, 'https://sample-workspace-3000.app.github.dev');
  assert.equal(config(codespace).secure, true);
  assert.equal(config({ ...codespace, PORT: '3001' }).origin, 'https://sample-workspace-3001.app.github.dev');
  assert.equal(config({ ...codespace, APP_ORIGIN: 'https://custom.example' }).origin, 'https://custom.example');
  assert.equal(config({ PORT: '3001' }).origin, 'http://localhost:3001');
  assert.throws(() => config({ APP_ORIGIN: 'https://example.com/path' }));
  assert.throws(() => config({ APP_ORIGIN: 'ftp://example.com' }));
  assert.throws(() => config({ ...codespace, NODE_ENV: 'production', SITE_ID: 'site' }));
  assert.equal(config({ NODE_ENV: 'production', SITE_ID: 'site', APP_ORIGIN: 'https://example.com' }).secure, true);
});

test('정확한 미리보기 출처만 허용하고 localhost·다른 Codespace·위조 전달 헤더를 거부한다', async () => {
  const f = fixture();
  try {
    const settings = config(codespace), app = createApplication(f.db, settings);
    async function login(origin, extra = {}) {
      const headers = { 'content-type': 'application/json', ...extra };
      if (origin !== undefined) headers.origin = origin;
      return app(new Request(settings.origin + '/api/login', { method: 'POST', headers, body: JSON.stringify({ login: 'ADMIN', password: f.password }) }));
    }
    for (const origin of ['http://localhost:3000', 'https://another-3000.app.github.dev', 'null', undefined]) {
      const rejected = await login(origin, { host: new URL(settings.origin).host, 'x-forwarded-host': new URL(settings.origin).host, 'x-forwarded-proto': 'https' });
      assert.equal(rejected.status, 403);
      assert.ok((await rejected.json()).error.includes(settings.origin));
    }
    const allowed = await login(settings.origin);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('set-cookie'), /^__Host-onwork=.*; Secure$/);
    const oldSettings = config({ APP_ORIGIN: 'http://localhost:3000' });
    const oldApp = createApplication(f.db, oldSettings);
    assert.equal((await oldApp(new Request(settings.origin + '/api/login', { method: 'POST', headers: { origin: settings.origin, 'content-type': 'application/json' }, body: '{}' }))).status, 403);
  } finally { f.db.close(); }
});

test('Codespaces의 localhost Origin 변환은 브라우저 출처 증거가 모두 일치할 때만 허용한다', async () => {
  const { requestOriginAllowed } = await import('../lib/security.mjs');
  const settings = config(codespace);
  const valid = { origin: 'http://localhost:3000', referer: settings.origin + '/setup', 'sec-fetch-site': 'same-origin', 'x-onwork-origin': settings.origin };
  const req = headers => new Request(settings.origin + '/api/setup', { method: 'POST', headers });
  assert.equal(requestOriginAllowed(req(valid), settings), true);
  assert.equal(requestOriginAllowed(req({ ...valid, origin: 'https://localhost:3000' }), settings), true);
  for (const patch of [
    { origin: 'http://localhost:3001' }, { origin: 'http://127.0.0.1:3000' },
    { origin: 'https://other-3000.app.github.dev' }, { origin: 'null' },
    { referer: 'https://evil.example/setup' }, { referer: '' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': '' },
    { 'x-onwork-origin': 'https://evil.example' }, { 'x-onwork-origin': '' },
  ]) assert.equal(requestOriginAllowed(req({ ...valid, ...patch }), settings), false);
  assert.equal(requestOriginAllowed(req(valid), config({ APP_ORIGIN: settings.origin })), false);
  assert.equal(requestOriginAllowed(req(valid), config({ ...codespace, APP_ORIGIN: 'https://custom.example' })), false);
});

test('실제 프록시 형태의 헤더로 사전 진단·로그인 성공, 진단은 비밀번호 없이 동작한다', async () => {
  const f = fixture();
  try {
    const settings = config(codespace), app = createApplication(f.db, settings);
    const headers = { origin: 'http://localhost:3000', referer: settings.origin + '/login', 'sec-fetch-site': 'same-origin', 'x-onwork-origin': settings.origin, 'content-type': 'application/json' };
    const check = await app(new Request(settings.origin + '/api/origin-check', { method: 'POST', headers, body: '{}' }));
    assert.equal(check.status, 200);
    assert.equal((await check.json()).receivedOrigin, 'http://localhost:3000');
    assert.equal(check.headers.get('referrer-policy'), 'same-origin');
    const login = await app(new Request(settings.origin + '/api/login', { method: 'POST', headers, body: JSON.stringify({ login: 'ADMIN', password: f.password }) }));
    assert.equal(login.status, 200);
    const preflight = await app(new Request(settings.origin + '/api/setup', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-headers': 'x-onwork-origin' } }));
    assert.equal(preflight.headers.has('access-control-allow-origin'), false);
    const missing = await app(new Request(settings.origin + '/api/origin-check', { method: 'POST', headers: { ...headers, referer: '' }, body: '{}' }));
    assert.equal(missing.status, 403);
    assert.match((await missing.json()).error, /받은 Origin: http:\/\/localhost:3000/);
  } finally { f.db.close(); }
});
