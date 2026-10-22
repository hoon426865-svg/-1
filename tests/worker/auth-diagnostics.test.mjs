import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

test('인증 진단은 고정된 오류 분류만 받고 원문·다른 출처·과다 요청을 차단하며 패스키와 세션을 보존한다',async()=>{
  const f=await fixture({passkey:true});
  try{
    const c=f.client(),body={stage:'session-check',code:'SESSION_NOT_STORED',status:401,requestId:'01234567-89ab-4cde-8fab-0123456789ab'};
    const before=await f.db.prepare('SELECT (SELECT count(*) FROM passkeys) keys,(SELECT count(*) FROM sessions) sessions').first();
    assert.equal((await c.call('/api/auth/diagnostics',{...body,ticket:'must-not-log-this'})).status,400);
    assert.equal((await c.call('/api/auth/diagnostics',{...body,code:'arbitrary-private-value'})).status,400);
    assert.equal((await c.call('/api/auth/diagnostics',{...body,requestId:'secret'})).status,400);
    assert.equal((await c.call('/api/auth/diagnostics',body,'POST',{origin:'https://evil.test'})).status,403);
    const reply=await c.call('/api/auth/diagnostics',body);
    assert.equal(reply.status,200);
    assert.match(reply.headers.get('X-Onwork-Request-ID'),/^[a-f0-9-]{36}$/);
    for(let i=1;i<20;i++)assert.equal((await c.call('/api/auth/diagnostics',body)).status,200);
    assert.equal((await c.call('/api/auth/diagnostics',body)).status,429);
    assert.deepEqual(await f.db.prepare('SELECT (SELECT count(*) FROM passkeys) keys,(SELECT count(*) FROM sessions) sessions').first(),before);
    assert.equal((await c.call('/auth-diagnostics.js')).status,200);
  }finally{await f.close();}
});
