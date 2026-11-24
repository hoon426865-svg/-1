import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,origin} from './helpers.mjs';
import {issuer,ticket,authenticator} from './virtual-authenticator.mjs';
const enroll=async(c,grant,device)=>{const o=(await c.call('/api/passkeys/enroll/options',{ticket:grant})).data;return c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:o.challengeId,response:device.register(o.options)});};
const login=async(c,device)=>{const o=(await c.call('/api/passkeys/login/options',{})).data;assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:o.challengeId,response:device.login(o.options)})).status,200);return {'x-csrf-token':(await c.call('/api/me')).data.csrf};};
const proof=async(c,device,headers,kind,details,changes={})=>{const o=await c.call('/api/admin/passkeys/authorize/options',{operation:kind,details},'POST',headers);assert.equal(o.status,200);return {challengeId:o.data.challengeId,response:device.login(o.data.options,changes)};};

test('패스키 계정 발급·복구: 관리자 UV 재확인, 일회용 등록, 분실 키·세션·등록권 폐기, 원본 해시와 업무 보존',async()=>{
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});try{
    const a=f.client(),e=f.client(),admin=await f.db.prepare("SELECT * FROM users WHERE id='admin'").first(),old=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first();
    const ad=authenticator(origin,admin.id),lost=authenticator(origin,old.id),stale=ticket(keys,old,origin);
    assert.equal((await enroll(a,ticket(keys,admin,origin),ad)).status,200);const ah=await login(a,ad);
    const details={number:'003',name:'새 시험 직원',team:'생산팀',reason:'신규 입사 확인'};
    assert.equal((await a.call('/api/admin/employee',details,'POST',ah)).status,403);
    const authorization=await proof(a,ad,ah,'create',details);
    const created=await a.call('/api/admin/employee',{...details,authorization},'POST',ah);assert.equal(created.status,200);assert.match(created.data.enrollmentTicket,/^[A-Za-z0-9_-]{43}$/);
    assert.equal((await a.call('/api/admin/employee',{...details,authorization},'POST',ah)).status,403);
    const fresh=await f.db.prepare('SELECT * FROM users WHERE employee_id=?').bind(created.data.id).first();assert.equal(fresh.role,'employee');assert.equal(fresh.must_change,1);assert.match(fresh.password_hash,/^passkey-only:/);
    const n=f.client(),nd=authenticator(origin,fresh.id);assert.equal((await enroll(n,created.data.enrollmentTicket,nd)).status,200);await login(n,nd);
    assert.equal((await n.call('/api/passkeys/enroll/options',{ticket:created.data.enrollmentTicket})).status,401);
    assert.equal((await enroll(e,ticket(keys,old,origin),lost)).status,200);const eh=await login(e,lost);
    assert.equal((await e.call('/api/production',{taskId:'t1',good:6,bad:0,requestKey:crypto.randomUUID()},'POST',eh)).status,200);
    const employee=await f.db.prepare("SELECT * FROM employees WHERE id='e1'").first(),recover={id:employee.id,version:employee.version,reason:'본인 대면 확인, 기기 분실',identityConfirmed:true};
    const p=await proof(a,ad,ah,'recover',recover);
    const recovered=await a.call('/api/admin/passkeys/recover',{...recover,authorization:p},'POST',ah);assert.equal(recovered.status,200);
    assert.equal((await e.call('/api/me')).status,401);assert.equal((await f.db.prepare("SELECT count(*) n FROM passkeys WHERE user_id='ue1'").first()).n,0);
    assert.equal((await f.db.prepare("SELECT password_hash FROM users WHERE id='ue1'").first()).password_hash,old.password_hash);
    assert.equal((await f.db.prepare("SELECT good FROM production WHERE employee_id='e1'").first()).good,6);
    assert.equal((await e.call('/api/passkeys/enroll/options',{ticket:stale})).status,401);
    const o=(await e.call('/api/passkeys/login/options',{})).data;assert.equal((await e.call('/api/passkeys/login/verify',{challengeId:o.challengeId,response:lost.login(o.options)})).status,401);
    const replacement=authenticator(origin,old.id);assert.equal((await enroll(e,recovered.data.enrollmentTicket,replacement)).status,200);await login(e,replacement);
    assert.equal((await e.call('/api/state')).data.production[0].good,6);
    const audit=(await f.db.prepare("SELECT * FROM audit WHERE action='passkey_recovery'").all()).results;assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes(recovered.data.enrollmentTicket));
  }finally{await f.close();}
});

test('패스키 관리자 재인증: 직원·CSRF·UV 누락·변경된 대상·만료·퇴사 계정 복구를 거부하고 부분 변경 없음',async()=>{
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});try{
    const a=f.client(),e=f.client(),admin=await f.db.prepare("SELECT * FROM users WHERE id='admin'").first(),person=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first(),ad=authenticator(origin,admin.id),ed=authenticator(origin,person.id);
    await enroll(a,ticket(keys,admin,origin),ad);const ah=await login(a,ad);await enroll(e,ticket(keys,person,origin),ed);const eh=await login(e,ed);
    const details={number:'004',name:'시험',team:'팀',reason:'발급'};
    assert.equal((await e.call('/api/admin/passkeys/authorize/options',{operation:'create',details},'POST',eh)).status,403);
    assert.equal((await a.call('/api/admin/passkeys/authorize/options',{operation:'create',details},'POST',{'x-csrf-token':'invalid'})).status,403);
    const bad=await proof(a,ad,ah,'create',details,{uv:false});assert.equal((await a.call('/api/admin/employee',{...details,authorization:bad},'POST',ah)).status,403);
    const authorization=await proof(a,ad,ah,'create',details);
    assert.equal((await a.call('/api/admin/employee',{...details,number:'005',authorization},'POST',ah)).status,403);
    await f.db.prepare('UPDATE passkey_admin_challenges SET expires=1 WHERE id=?').bind(authorization.challengeId).run();
    assert.equal((await a.call('/api/admin/employee',{...details,authorization},'POST',ah)).status,403);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM employees').first()).n,2);assert.equal((await f.db.prepare('SELECT count(*) n FROM passkey_invites').first()).n,0);
    const recover={id:'e1',version:1,reason:'본인 확인',identityConfirmed:true},p=await proof(a,ad,ah,'recover',recover);
    await f.db.prepare("UPDATE employees SET active=0 WHERE id='e1'").run();assert.equal((await a.call('/api/admin/passkeys/recover',{...recover,authorization:p},'POST',ah)).status,409);
    assert.equal((await f.db.prepare("SELECT count(*) n FROM passkeys WHERE user_id='ue1'").first()).n,1);
    assert.equal((await f.db.prepare("SELECT count(*) n FROM passkey_admin_challenges WHERE id=?").bind(p.challengeId).first()).n,1);
  }finally{await f.close();}
});
