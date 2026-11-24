import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {fixture,origin} from './helpers.mjs';
import {issuer,ticket,authenticator} from './virtual-authenticator.mjs';

const CREATE='/api/admin/accounts',REISSUE=CREATE+'/reissue';
const details=(login='MGR02')=>({login,reason:'다른 관리자 본인 확인 후 별도 계정 발급',adminRightsConfirmed:true});
const ok=async promise=>{const result=await promise;assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const rows=async(f,sql,...args)=>(await f.db.prepare(sql).bind(...args).all()).results;
const one=async(f,sql,...args)=>f.db.prepare(sql).bind(...args).first();
const count=async(f,table)=>(await one(f,'SELECT count(*) n FROM '+table)).n;
const fingerprint=value=>createHash('sha256').update(value).digest('hex');

async function enroll(client,grant,device){
  const options=await ok(client.call('/api/passkeys/enroll/options',{ticket:grant}));
  return client.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:options.challengeId,response:device.register(options.options)});
}
async function login(client,device,name){
  const options=await ok(client.call('/api/passkeys/login/options',name?{login:name}:{}));
  await ok(client.call('/api/passkeys/login/verify',{challengeId:options.challengeId,response:device.login(options.options)}));
  const me=await ok(client.call('/api/me'));
  return {me,headers:{'x-csrf-token':me.csrf}};
}
async function proof(client,device,headers,operation,body,changes={}){
  const options=await ok(client.call('/api/admin/passkeys/authorize/options',{operation,details:body},'POST',headers));
  return {challengeId:options.challengeId,response:device.login(options.options,changes)};
}
async function setup(){
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});
  try{
    const admin=await one(f,"SELECT * FROM users WHERE id='admin'"),client=f.client(),device=authenticator(origin,admin.id);
    await ok(enroll(client,ticket(keys,admin,origin),device));
    const {headers}=await login(client,device,'ADMIN');
    return {f,keys,admin,client,device,headers};
  }catch(error){await f.close();throw error;}
}
async function create(s,body=details()){
  const authorization=await proof(s.client,s.device,s.headers,'create-admin',body);
  const result=await ok(s.client.call(CREATE,{...body,authorization},'POST',s.headers));
  return {...result,authorization};
}

test('다른 관리자 계정: 기존 패스키 재인증으로 발급·새 기기 등록·독립 로그인 및 행위자 이력 보존',async()=>{
  const s=await setup(),{f,client,device,headers,admin}=s;
  try{
    const originalCredentials=await rows(f,"SELECT id,user_id,public_key,transports,created_at FROM passkeys WHERE user_id='admin'");
    const employees=await rows(f,'SELECT * FROM employees ORDER BY id');
    const body=details(' mgr02 '),created=await create(s,body);
    assert.equal(created.login,'MGR02');assert.equal(created.role,'admin');
    assert.match(created.enrollmentTicket,/^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(created.expiresAt)>Date.now()+890000);
    assert.ok(Date.parse(created.expiresAt)<=Date.now()+900000);
    const account=await one(f,'SELECT * FROM users WHERE id=?',created.id);
    assert.equal(account.role,'admin');assert.equal(account.employee_id,null);assert.equal(account.must_change,1);
    assert.match(account.password_hash,/^passkey-only-admin:/);
    assert.deepEqual(await rows(f,'SELECT * FROM employees ORDER BY id'),employees);
    const storedInvite=await one(f,'SELECT * FROM passkey_invites WHERE user_id=?',account.id);
    assert.equal(storedInvite.hash,fingerprint(created.enrollmentTicket));assert.equal(storedInvite.issued_by,admin.id);
    assert.ok(!JSON.stringify(storedInvite).includes(created.enrollmentTicket));
    assert.equal((await client.call(CREATE,{...body,authorization:created.authorization},'POST',headers)).status,403);

    const guest=f.client();
    assert.equal((await guest.call('/api/state')).status,401);
    assert.equal((await guest.call('/api/passkeys/login/options',{login:'MGR02'})).status,401);
    const pending=(await ok(client.call(CREATE))).accounts.find(a=>a.id===account.id);
    assert.equal(pending.mustChange,true);assert.equal(pending.passkeyCount,0);assert.equal(pending.canReissue,true);
    assert.equal('password_hash' in pending,false);assert.equal('enrollmentTicket' in pending,false);

    const newDevice=authenticator(origin,account.id);
    await ok(enroll(guest,created.enrollmentTicket,newDevice));
    const second=await login(guest,newDevice,'mgr02');
    assert.equal(second.me.id,account.id);assert.equal(second.me.login,'MGR02');assert.equal(second.me.role,'admin');assert.equal(second.me.employeeId,null);
    assert.equal((await guest.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket})).status,401);
    const active=(await ok(guest.call(CREATE))).accounts.find(a=>a.id===account.id);
    assert.equal(active.mustChange,false);assert.equal(active.passkeyCount,1);assert.equal(active.canReissue,false);
    assert.equal((await client.call('/api/me')).status,200,'New account registration must not revoke the existing admin session');
    assert.equal((await one(f,"SELECT password_hash FROM users WHERE id='admin'")).password_hash,admin.password_hash);
    assert.deepEqual(await rows(f,"SELECT id,user_id,public_key,transports,created_at FROM passkeys WHERE user_id='admin'"),originalCredentials);
    assert.equal(await count(f,'production'),0);

    const firstTask=await ok(client.call('/api/admin/task',{name:'첫 관리자 합성 작업',reason:'첫 관리자 기록'},'POST',headers));
    const secondTask=await ok(guest.call('/api/admin/task',{name:'다른 관리자 합성 작업',reason:'다른 관리자 기록'},'POST',second.headers));
    assert.equal((await one(f,"SELECT actor_login FROM audit WHERE action='task_create' AND target_id=?",firstTask.id)).actor_login,'ADMIN');
    assert.equal((await one(f,"SELECT actor_login FROM audit WHERE action='task_create' AND target_id=?",secondTask.id)).actor_login,'MGR02');
    const issuance=await one(f,"SELECT * FROM audit WHERE action='admin_create' AND target_id=?",account.id);
    assert.equal(issuance.actor_id,admin.id);assert.ok(!JSON.stringify(issuance).includes(created.enrollmentTicket));
    const crossAccount=await proof(client,device,headers,'create-admin',details('MGR03'));
    assert.equal((await guest.call(CREATE,{...details('MGR03'),authorization:crossAccount},'POST',second.headers)).status,403);
    const loginOptions=await ok(guest.call('/api/passkeys/login/options',{login:'MGR02'}));
    assert.equal((await guest.call('/api/passkeys/login/verify',{challengeId:loginOptions.challengeId,response:device.login(loginOptions.options)})).status,401);
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  }finally{await f.close();}
});

test('관리자 등록권 재발급: 미등록 계정만 허용, 이전 등록권·진행 중 등록 요청 폐기, 기존 키는 유지',async()=>{
  const s=await setup(),{f,client,headers,device}=s;
  try{
    const created=await create(s),guest=f.client(),replacementDevice=authenticator(origin,created.id);
    const originalOptions=await ok(guest.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket}));
    const body={id:created.id,reason:'만료된 전달 건을 본인에게 재발급',adminRightsConfirmed:true};
    const authorization=await proof(client,device,headers,'reinvite-admin',body);
    assert.equal((await client.call(REISSUE,{...body,id:'admin',authorization},'POST',headers)).status,403);
    const renewed=await ok(client.call(REISSUE,{...body,authorization},'POST',headers));
    assert.notEqual(renewed.enrollmentTicket,created.enrollmentTicket);assert.equal(renewed.id,created.id);
    assert.equal((await guest.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket})).status,401);
    assert.equal((await guest.call('/api/passkeys/enroll/verify',{ticket:created.enrollmentTicket,challengeId:originalOptions.challengeId,response:replacementDevice.register(originalOptions.options)})).status,401);
    assert.equal((await one(f,'SELECT count(*) n FROM passkey_challenges WHERE id=?',originalOptions.challengeId)).n,0);
    assert.equal((await client.call(REISSUE,{...body,authorization},'POST',headers)).status,403);
    await f.db.prepare('UPDATE passkey_invites SET expires=1 WHERE user_id=?').bind(created.id).run();
    assert.equal((await guest.call('/api/passkeys/enroll/options',{ticket:renewed.enrollmentTicket})).status,401);
    const finalInvite=await ok(client.call(REISSUE,{...body,authorization:await proof(client,device,headers,'reinvite-admin',body)},'POST',headers));
    await ok(enroll(guest,finalInvite.enrollmentTicket,replacementDevice));await login(guest,replacementDevice,'MGR02');
    const credentials=await rows(f,'SELECT * FROM passkeys ORDER BY id');
    const activeProof=await proof(client,device,headers,'reinvite-admin',body);
    assert.equal((await client.call(REISSUE,{...body,authorization:activeProof},'POST',headers)).status,409);
    assert.deepEqual(await rows(f,'SELECT * FROM passkeys ORDER BY id'),credentials);
    assert.equal((await guest.call('/api/me')).status,200);
    const audit=await rows(f,"SELECT * FROM audit WHERE action='admin_invite_reissue' AND target_id=?",created.id);
    assert.equal(audit.length,2);assert.ok(audit.every(row=>row.actor_login==='ADMIN'));
    assert.ok(!JSON.stringify(audit).includes(finalInvite.enrollmentTicket));

    // A historical admin without a key is recovery, not a new-account invite.
    await f.db.prepare("INSERT INTO users(id,login,password_hash,role,must_change) VALUES('legacy-admin','LEGACYADMIN',?,'admin',1)").bind(s.admin.password_hash).run();
    const legacy={...body,id:'legacy-admin'},legacyProof=await proof(client,device,headers,'reinvite-admin',legacy);
    assert.equal((await client.call(REISSUE,{...legacy,authorization:legacyProof},'POST',headers)).status,409);
    assert.equal((await one(f,"SELECT count(*) n FROM passkey_invites WHERE user_id='legacy-admin'")).n,0);
    assert.equal((await one(f,"SELECT password_hash FROM users WHERE id='legacy-admin'")).password_hash,s.admin.password_hash);
  }finally{await f.close();}
});

test('관리자 추가 권한 보호: 직원·CSRF·동의 누락·UV·작업 변경·만료·중복 계정 및 직원 API 권한 승격 거부',async()=>{
  const s=await setup(),{f,client,headers,device,keys}=s;
  try{
    const e=f.client(),person=await one(f,"SELECT * FROM users WHERE id='ue1'"),ed=authenticator(origin,person.id);
    await ok(enroll(e,ticket(keys,person,origin),ed));const employee=await login(e,ed,'001');
    const body=details();
    assert.equal((await e.call(CREATE)).status,403);
    assert.equal((await e.call(CREATE,body,'POST',employee.headers)).status,403);
    assert.equal((await e.call(REISSUE,{id:'admin',reason:'차단',adminRightsConfirmed:true},'POST',employee.headers)).status,403);
    assert.equal((await e.call('/api/admin/passkeys/authorize/options',{operation:'create-admin',details:body},'POST',employee.headers)).status,403);
    assert.equal((await client.call('/api/admin/passkeys/authorize/options',{operation:'create-admin',details:body},'POST',{'x-csrf-token':'incorrect'})).status,403);
    for(const invalid of [{...body,adminRightsConfirmed:false},{...body,adminRightsConfirmed:'true'},{...body,reason:''},{...body,login:'이름'},{...body,login:'BAD LOGIN'}])assert.equal((await client.call('/api/admin/passkeys/authorize/options',{operation:'create-admin',details:invalid},'POST',headers)).status,400);
    assert.equal((await client.call(CREATE,body,'POST',headers)).status,403);
    const noUv=await proof(client,device,headers,'create-admin',body,{uv:false});
    assert.equal((await client.call(CREATE,{...body,authorization:noUv},'POST',headers)).status,403);
    const wrongSignature=await proof(client,device,headers,'create-admin',body,{badSignature:true});
    assert.equal((await client.call(CREATE,{...body,authorization:wrongSignature},'POST',headers)).status,403);
    const mismatchedAccount=await proof(client,device,headers,'create-admin',body,{userHandle:'ue1'});
    assert.equal((await client.call(CREATE,{...body,authorization:mismatchedAccount},'POST',headers)).status,403);
    const changed=await proof(client,device,headers,'create-admin',body);
    assert.equal((await client.call(CREATE,{...body,login:'MGR03',authorization:changed},'POST',headers)).status,403);
    assert.equal((await client.call(CREATE,{...body,reason:'다른 사유',authorization:changed},'POST',headers)).status,403);
    await f.db.prepare('UPDATE passkey_admin_challenges SET expires=1 WHERE id=?').bind(changed.challengeId).run();
    assert.equal((await client.call(CREATE,{...body,authorization:changed},'POST',headers)).status,403);
    for(const loginName of ['admin','001']){
      const duplicate=details(loginName),authorization=await proof(client,device,headers,'create-admin',duplicate);
      assert.equal((await client.call(CREATE,{...duplicate,authorization},'POST',headers)).status,409);
    }
    assert.equal(await count(f,'users'),3);assert.equal(await count(f,'employees'),2);assert.equal(await count(f,'passkey_invites'),0);
    // Supplying an admin role to the existing employee endpoint cannot promote it.
    const employeeBody={number:'003',name:'합성 신규 직원',team:'시험',reason:'직원 생성 경로',role:'admin',adminRightsConfirmed:true};
    const authorization=await proof(client,device,headers,'create',employeeBody);
    const created=await ok(client.call('/api/admin/employee',{...employeeBody,authorization},'POST',headers));
    const account=await one(f,'SELECT * FROM users WHERE employee_id=?',created.id);
    assert.equal(account.role,'employee');assert.match(account.password_hash,/^passkey-only:/);
    assert.equal((await one(f,"SELECT count(*) n FROM users WHERE role='admin'")).n,1);
  }finally{await f.close();}
});

test('관리자 발급·재발급의 감사 저장 실패는 계정·등록권·재인증 소비를 함께 롤백한다',async()=>{
  const s=await setup(),{f,client,device,headers}=s;
  try{
    const body=details(),authorization=await proof(client,device,headers,'create-admin',body);
    const credentials=await rows(f,'SELECT * FROM passkeys ORDER BY id');
    await f.db.prepare("CREATE TRIGGER fail_admin_create BEFORE INSERT ON audit WHEN NEW.action='admin_create' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
    assert.equal((await client.call(CREATE,{...body,authorization},'POST',headers)).status,503);
    assert.equal(await count(f,'users'),3);assert.equal(await count(f,'passkey_invites'),0);
    assert.deepEqual(await rows(f,'SELECT * FROM passkeys ORDER BY id'),credentials);
    assert.equal((await one(f,'SELECT count(*) n FROM passkey_admin_challenges WHERE id=?',authorization.challengeId)).n,1);
    await f.db.prepare('DROP TRIGGER fail_admin_create').run();
    const created=await ok(client.call(CREATE,{...body,authorization},'POST',headers));
    const pending={id:created.id,reason:'시험 재발급',adminRightsConfirmed:true};
    const reauthorization=await proof(client,device,headers,'reinvite-admin',pending);
    const beforeInvites=await rows(f,'SELECT * FROM passkey_invites ORDER BY hash'),beforeCredentials=await rows(f,'SELECT * FROM passkeys ORDER BY id');
    await f.db.prepare("CREATE TRIGGER fail_admin_reissue BEFORE INSERT ON audit WHEN NEW.action='admin_invite_reissue' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
    assert.equal((await client.call(REISSUE,{...pending,authorization:reauthorization},'POST',headers)).status,503);
    assert.deepEqual(await rows(f,'SELECT * FROM passkey_invites ORDER BY hash'),beforeInvites);
    assert.deepEqual(await rows(f,'SELECT * FROM passkeys ORDER BY id'),beforeCredentials);
    assert.equal((await one(f,'SELECT count(*) n FROM passkey_admin_challenges WHERE id=?',reauthorization.challengeId)).n,1);
    await f.db.prepare('DROP TRIGGER fail_admin_reissue').run();
    const renewed=await ok(client.call(REISSUE,{...pending,authorization:reauthorization},'POST',headers));
    assert.notEqual(renewed.enrollmentTicket,created.enrollmentTicket);
    assert.equal((await client.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket})).status,401);
    assert.equal((await one(f,"SELECT count(*) n FROM audit WHERE action='admin_create'")).n,1);
    assert.equal((await one(f,"SELECT count(*) n FROM audit WHERE action='admin_invite_reissue'")).n,1);
  }finally{await f.close();}
});

test('관리자 재인증 ID 바이트 일치와 온라인 등록권의 신규·미등록 관리자 제한',async()=>{
  const s=await setup(),{f,client,device,headers,admin}=s;
  try{
    const body=details(),authorization=await proof(client,device,headers,'create-admin',body);
    const mismatched={...authorization,response:{...authorization.response,rawId:randomBytes(32).toString('base64url')}};
    assert.equal((await client.call(CREATE,{...body,authorization:mismatched},'POST',headers)).status,403);
    assert.equal(await count(f,'users'),3);
    const padded=Buffer.from(authorization.response.id,'base64url').toString('base64');
    const normalized={...authorization,response:{...authorization.response,id:padded,rawId:padded}};
    const created=await ok(client.call(CREATE,{...body,authorization:normalized},'POST',headers));
    assert.equal(created.login,'MGR02');

    // Even an otherwise valid hashed invite cannot enroll another key into an active admin.
    const unexpectedInvite=randomBytes(32).toString('base64url');
    await f.db.prepare('INSERT INTO passkey_invites VALUES(?,?,?,?,?,?,NULL)').bind(fingerprint(unexpectedInvite),admin.id,fingerprint(admin.password_hash),Date.now()+900000,admin.id,new Date().toISOString()).run();
    assert.equal((await client.call('/api/passkeys/enroll/options',{ticket:unexpectedInvite})).status,401);
    assert.equal((await one(f,"SELECT count(*) n FROM passkeys WHERE user_id='admin'")).n,1);
    // An employee may not become the issuer authority for a pending admin grant.
    await f.db.prepare('UPDATE passkey_invites SET issued_by=? WHERE user_id=?').bind('ue1',created.id).run();
    assert.equal((await client.call('/api/passkeys/enroll/options',{ticket:created.enrollmentTicket})).status,401);
    assert.equal((await one(f,'SELECT must_change FROM users WHERE id=?',created.id)).must_change,1);
    assert.equal((await one(f,'SELECT count(*) n FROM passkeys WHERE user_id=?',created.id)).n,0);
  }finally{await f.close();}
});
