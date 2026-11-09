import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,origin} from './helpers.mjs';
import {issuer,ticket,authenticator} from './virtual-authenticator.mjs';
import {randomUUID} from 'node:crypto';
test('workerd 패스키: 기존 계정·해시 보존, UV 등록·로그인·세션·권한·업무 연결',async()=>{
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});try{
    const c=f.client(),account=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first(),originalHash=account.password_hash,grant=ticket(keys,account,origin),device=authenticator(origin,account.id);
    assert.equal((await c.call('/api/setup')).data.authMode,'passkey');
    assert.equal((await c.call('/api/login',{login:'001',password:f.password})).status,403);
    const opts=(await c.call('/api/passkeys/enroll/options',{ticket:grant})).data;
    assert.equal(opts.options.authenticatorSelection.userVerification,'required');
    assert.equal((await c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:opts.challengeId,response:device.register(opts.options)})).status,200);
    assert.equal((await f.db.prepare("SELECT password_hash FROM users WHERE id='ue1'").first()).password_hash,originalHash);
    assert.equal((await c.call('/api/passkeys/enroll/options',{ticket:grant})).status,409);
    const login=(await c.call('/api/passkeys/login/options',{})).data;
    const assertion=device.login(login.options),reply=await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response:assertion});assert.equal(reply.status,200);
    const me=await c.call('/api/me');assert.equal(me.data.employeeId,'e1');assert.equal(me.data.role,'employee');
    assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response:assertion})).status,401);
    assert.equal((await c.call('/api/admin/audit')).status,403);
    const headers={'x-csrf-token':me.data.csrf};
    assert.equal((await c.call('/api/attendance',{action:'in'},'POST',headers)).status,200);
    assert.equal((await c.call('/api/production',{taskId:'t1',good:3,bad:0,requestKey:randomUUID()},'POST',headers)).status,200);
    const submitted=await c.call('/api/work-requests',{type:'annual',startDate:'2026-11-03',endDate:'2026-11-03',allDay:true,reason:'패스키 시험'},'POST',headers);
    assert.equal(submitted.status,200);
    assert.equal((await c.call('/api/state')).data.production.length,1);
    assert.equal((await c.call('/api/attendance',{action:'out'},'POST',headers)).status,200);
    const a=f.client(),admin=await f.db.prepare("SELECT * FROM users WHERE id='admin'").first(),adminGrant=ticket(keys,admin,origin),adminDevice=authenticator(origin,admin.id);
    const enroll=(await a.call('/api/passkeys/enroll/options',{ticket:adminGrant})).data;
    assert.equal((await a.call('/api/passkeys/enroll/verify',{ticket:adminGrant,challengeId:enroll.challengeId,response:adminDevice.register(enroll.options)})).status,200);
    const adminLogin=(await a.call('/api/passkeys/login/options',{})).data;
    assert.equal((await a.call('/api/passkeys/login/verify',{challengeId:adminLogin.challengeId,response:adminDevice.login(adminLogin.options)})).status,200);
    const adminHeaders={'x-csrf-token':(await a.call('/api/me')).data.csrf};
    const approved=await a.call('/api/admin/work-requests/decision',{id:submitted.data.id,version:submitted.data.version,action:'approved',comment:'패스키 승인'},'POST',adminHeaders);
    assert.equal(approved.status,200);assert.equal(approved.data.status,'approved');
    for(const query of ['year=2026','year=2026&month=11']){
      const report=await a.call('/api/admin/work-requests/report?'+query);assert.equal(report.status,200);
      assert.equal(report.data.summaries.find(s=>s.id==='e1').absenceDates,1);
    }
    assert.equal((await c.call('/api/logout',{},'POST',headers)).status,200);
    assert.equal((await c.call('/api/me')).status,401);
  }finally{await f.close();}
});
test('workerd 패스키: 인증 횟수를 원자적으로 제한하고 거부된 요청은 예약하지 않는다',async()=>{
  const f=await fixture({passkey:true});try{
    const c=f.client();for(let i=0;i<20;i++)assert.equal((await c.call('/api/passkeys/login/options',{})).status,200);
    assert.equal((await c.call('/api/passkeys/login/options',{})).status,429);
    assert.equal((await f.db.prepare('SELECT attempts FROM login_limits').first()).attempts,20);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM passkey_challenges').first()).n,20);
  }finally{await f.close();}
});
test('workerd 패스키: 잘못된 등록권·Origin·서명·UV·계정 연결 및 퇴사 차단',async()=>{
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});try{
    const c=f.client(),account=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first(),device=authenticator(origin,account.id);
    for(const changes of [{exp:1},{aud:'https://other.test.workers.dev'},{passwordDigest:'0'.repeat(64)}])assert.equal((await c.call('/api/passkeys/enroll/options',{ticket:ticket(keys,account,origin,changes)})).status,401);
    const grant=ticket(keys,account,origin),opts=(await c.call('/api/passkeys/enroll/options',{ticket:grant})).data;
    assert.equal((await c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:opts.challengeId,response:device.register(opts.options,{uv:false})})).status,401);
    assert.equal((await c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:opts.challengeId,response:device.register(opts.options)})).status,200);
    for(const changes of [{uv:false},{badSignature:true},{userHandle:'ue2'},{clientOverrides:{origin:'https://evil.test'}},{clientOverrides:{crossOrigin:true}}]){
      const options=(await c.call('/api/passkeys/login/options',{})).data;
      assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:options.challengeId,response:device.login(options.options,changes)})).status,401);
    }
    await f.db.prepare("UPDATE employees SET active=0 WHERE id='e1'").run();
    const options=(await c.call('/api/passkeys/login/options',{})).data;
    assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:options.challengeId,response:device.login(options.options)})).status,401);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM sessions').first()).n,0);
  }finally{await f.close();}
});
