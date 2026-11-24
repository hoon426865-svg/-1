import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,origin} from './helpers.mjs';
import {issuer,ticket,authenticator,b64} from './virtual-authenticator.mjs';
import {randomBytes} from 'node:crypto';

test('패스키 ID는 바이트 기준으로 정규화하고 id/rawId 불일치·다른 계정·서명 오류를 거부한다',async()=>{
  const keys=issuer(),f=await fixture({passkey:true,publicKey:keys.publicJwk});
  try{
    const c=f.client(),account=await f.db.prepare("SELECT * FROM users WHERE id='admin'").first(),device=authenticator(origin,account.id);
    const grant=ticket(keys,account,origin),options=(await c.call('/api/passkeys/enroll/options',{ticket:grant})).data;
    const registration=device.register(options.options),canonical=registration.id;
    const standard=value=>Buffer.from(value,'base64url').toString('base64');
    registration.id=standard(registration.id);registration.rawId=standard(registration.rawId);
    const registered=await c.call('/api/passkeys/enroll/verify',{ticket:grant,challengeId:options.challengeId,response:registration});
    assert.equal(registered.status,200);assert.equal(registered.data.login,'ADMIN');
    const stored=await f.db.prepare('SELECT id FROM passkeys').first();assert.equal(stored.id,canonical);
    assert.equal((await c.call('/api/passkeys/login/options',{login:'missing'})).status,401);
    const loginOptions=async(login='ADMIN')=>(await c.call('/api/passkeys/login/options',{login})).data;
    let login=await loginOptions();assert.deepEqual(login.options.allowCredentials.map(c=>c.id),[canonical]);
    assert.equal((await f.db.prepare('SELECT user_id FROM passkey_challenges WHERE id=?').bind(login.challengeId).first()).user_id,'admin');
    let response=device.login(login.options);response.id=standard(response.id);response.rawId=standard(response.rawId);delete response.response.userHandle;
    assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response})).status,200);
    assert.equal((await c.call('/api/me')).status,200);
    for(const kind of ['id-mismatch','unknown','bad-signature','wrong-handle']){
      login=await loginOptions();response=device.login(login.options,kind==='bad-signature'?{badSignature:true}:kind==='wrong-handle'?{userHandle:'wrong-user'}:{});
      if(kind==='id-mismatch')response.rawId=b64(randomBytes(32));
      if(kind==='unknown')response.id=response.rawId=b64(randomBytes(32));
      assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response})).status,401);
    }
    const e=f.client(),employee=await f.db.prepare("SELECT * FROM users WHERE id='ue1'").first(),employeeDevice=authenticator(origin,employee.id),employeeGrant=ticket(keys,employee,origin);
    const eo=(await e.call('/api/passkeys/enroll/options',{ticket:employeeGrant})).data;
    assert.equal((await e.call('/api/passkeys/enroll/verify',{ticket:employeeGrant,challengeId:eo.challengeId,response:employeeDevice.register(eo.options)})).status,200);
    login=await loginOptions();response=employeeDevice.login(login.options);delete response.response.userHandle;
    assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response})).status,401);
    login=(await c.call('/api/passkeys/login/options',{})).data;response=device.login(login.options);delete response.response.userHandle;
    assert.equal((await c.call('/api/passkeys/login/verify',{challengeId:login.challengeId,response})).status,401);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM passkeys').first()).n,2);
  }finally{await f.close();}
});
