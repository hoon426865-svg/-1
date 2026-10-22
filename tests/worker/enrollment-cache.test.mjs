import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {enrollmentTicket} from '../../worker/passkeys.mjs';
import {digest} from '../../worker/security.mjs';
import {issuer,ticket} from './virtual-authenticator.mjs';

test('등록권 공개키 캐시는 키 교체·손상된 설정·잘못된 서명을 우회하지 않는다',async()=>{
 const keys=issuer(),other=issuer(),origin='https://onwork-preview.test.workers.dev';
 const account={id:'synthetic-admin',role:'admin',active:1,password_hash:'synthetic-hash',last_recovery:null,used_ticket:null};
 const db={prepare(){return {bind(){return this;},async first(){return account;}};}};
 const env={APP_ORIGIN:origin,ENROLLMENT_PUBLIC_KEY:keys.publicJwk},grant=ticket(keys,account,origin);
 assert.equal((await enrollmentTicket(grant,env,db,new Date())).account.id,account.id);
 for(let i=0;i<2;i++)await assert.rejects(enrollmentTicket(grant,{...env,ENROLLMENT_PUBLIC_KEY:'invalid-json'},db,new Date()),{status:401});
 await assert.rejects(enrollmentTicket(grant,{...env,ENROLLMENT_PUBLIC_KEY:other.publicJwk},db,new Date()),{status:401});
 await assert.rejects(enrollmentTicket(ticket(other,account,origin),env,db,new Date()),{status:401});
 assert.equal((await enrollmentTicket(grant,env,db,new Date())).account.id,account.id);
 account.used_ticket='synthetic-used';await assert.rejects(enrollmentTicket(grant,env,db,new Date()),{status:409});
});

test('네이티브 SHA-256은 이전 WebCrypto 해시와 UTF-8 입력 바이트가 일치한다',async()=>{
 for(const text of ['', 'synthetic-session', '가상 계정 🔑']){
  const previous=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
  assert.equal(await digest(text),previous);
 }
});
