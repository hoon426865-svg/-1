import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {check,one,all,begin,audit} from './d1.mjs';
import {digest,token} from './security.mjs';
const enc=new TextEncoder();
export function sameContext(response){
  let data;try{data=JSON.parse(new TextDecoder().decode(from64(response?.response?.clientDataJSON||'')));}catch{check(false,401,'인증 응답 형식이 다릅니다.');}
  check((data.crossOrigin===false||data.crossOrigin===undefined)&&data.topOrigin===undefined,401,'다른 사이트 문맥에서 인증할 수 없습니다.');
}
export const from64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
export const to64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function canonicalCredentialId(value){
  check(typeof value==='string'&&value.length<=2048&&/^[A-Za-z0-9+/_-]+={0,2}$/.test(value),401,'패스키 ID 형식이 올바르지 않습니다.');
  try{
    const bytes=from64(value),canonical=to64(bytes);
    check(bytes.length>0&&bytes.length<=1023&&value.replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')===canonical,401,'패스키 ID 형식이 올바르지 않습니다.');
    return canonical;
  }catch{check(false,401,'패스키 ID 형식이 올바르지 않습니다.');}
}
function normalizeCredential(response){
  const id=canonicalCredentialId(response?.id),rawId=canonicalCredentialId(response?.rawId);
  check(id===rawId,401,'패스키 ID와 원본 ID가 일치하지 않습니다.');
  return {...response,id,rawId};
}
async function credentialDiagnostic(requestId,operation,response,normalized,storedMatch){
  // Fingerprints permit byte-identity comparison without recording IDs or accounts.
  if(!requestId)return;
  const canonicalIdHash=await digest(normalized.id),receivedIdHash=response.id===normalized.id?canonicalIdHash:await digest(response.id),rawIdHash=response.rawId===response.id?receivedIdHash:response.rawId===normalized.id?canonicalIdHash:await digest(response.rawId);
  console.log(JSON.stringify({event:'passkey-credential-check',requestId,operation,receivedIdHash,rawIdHash,canonicalIdHash,idRawIdMatch:normalized.id===normalized.rawId,canonicalized:response.id!==normalized.id||response.rawId!==normalized.rawId,storedMatch}));
}
export async function enrollmentTicket(value,env,db,now){
  check(typeof value==='string'&&value.length<4096,400,'등록권을 입력하세요.');
  if(/^[A-Za-z0-9_-]{43}$/.test(value)){
    const hash=await digest(value),invite=await one(db,'SELECT * FROM passkey_invites WHERE hash=?',hash);
    check(invite&&!invite.used_at&&invite.expires>now.getTime(),401,'등록권이 만료되었거나 이미 사용되었습니다.');
    const account=await one(db,'SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.id=?',invite.user_id);
    check(account&&account.role==='employee'&&account.active===1&&invite.password_digest===await digest(account.password_hash),401,'계정 상태가 변경되었습니다.');
    return {account,hash,invite:true};
  }
  const parts=value.split('.');check(parts.length===3,401,'등록권이 올바르지 않습니다.');
  let claims,header,key;
  try{
    header=JSON.parse(new TextDecoder().decode(from64(parts[0])));claims=JSON.parse(new TextDecoder().decode(from64(parts[1])));
    check(header.alg==='ES256'&&header.typ==='onwork-enrollment',401,'등록권 형식이 다릅니다.');
    key=await crypto.subtle.importKey('jwk',JSON.parse(env.ENROLLMENT_PUBLIC_KEY),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  }catch{check(false,401,'등록권 서명 설정을 확인하세요.');}
  check(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,from64(parts[2]),enc.encode(parts[0]+'.'+parts[1])),401,'등록권 서명이 올바르지 않습니다.');
  const seconds=Math.floor(now.getTime()/1000);
  check(claims.aud===env.APP_ORIGIN&&claims.purpose==='enroll'&&Number.isInteger(claims.iat)&&Number.isInteger(claims.exp)&&claims.iat<=seconds&&claims.exp>seconds&&claims.exp-claims.iat<=900&&typeof claims.nonce==='string'&&claims.nonce.length>=32,401,'등록권이 만료되었거나 대상 주소가 다릅니다.');
  const account=await one(db,'SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.id=?',claims.sub);
  check(account&&(account.role==='admin'||account.active===1)&&claims.passwordDigest===await digest(account.password_hash),401,'계정 상태가 변경되었습니다.');
  const state=await one(db,'SELECT last_recovery FROM passkey_account_state WHERE user_id=?',account.id);
  check(!state||claims.iat*1000>=state.last_recovery,401,'복구 이전 등록권은 사용할 수 없습니다.');
  const hash=await digest(value);check(!await one(db,'SELECT 1 FROM passkey_used_tickets WHERE hash=?',hash),409,'이미 사용된 등록권입니다.');
  return {account,hash};
}
export async function passkeyRoute(path,body,request,env,db,now,diagnostics={}){
  const rpID=new URL(env.APP_ORIGIN).hostname,stamp=now.toISOString();
  // Reserve each public authentication attempt before cryptographic work.
  const rateKey=await digest('passkey:'+path+':'+(request.headers.get('cf-connecting-ip')||'local')),ms=now.getTime();
  // A single conditional write reserves the attempt atomically, including
  // concurrent requests, before doing any signature verification.
  const reserved=await one(db,'INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END WHERE reset_at<=? OR attempts<20 RETURNING attempts',rateKey,ms+900000,ms,ms,ms+900000,ms);
  check(reserved,429,'인증 요청이 너무 많습니다. 15분 후 다시 시도하세요.');
  const tx=await begin(db);
  if(path.endsWith('/options')){
    const registration=path.includes('/enroll/');let account=null,ticketHash=null,options;
    if(registration){
      const ticket=await enrollmentTicket(body.ticket,env,db,now);account=ticket.account;ticketHash=ticket.hash;
      const existing=await all(db,'SELECT id,transports FROM passkeys WHERE user_id=? LIMIT 10',account.id);
      check(existing.length<10,409,'등록된 패스키 한도에 도달했습니다.');
      options=await generateRegistrationOptions({rpName:'온워크',rpID,userID:enc.encode(account.id),userName:account.login,attestationType:'none',supportedAlgorithmIDs:[-7],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:existing.map(c=>({id:c.id,transports:JSON.parse(c.transports)}))});
    }else{
      let allowCredentials;
      if(body.login!==undefined){
        check(typeof body.login==='string'&&/^[A-Za-z0-9-]{1,30}$/.test(body.login.trim()),400,'관리자 계정 또는 직원 사번을 입력해주세요.');
        account=await one(db,"SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.login=?",body.login.trim().toUpperCase());
        const existing=account&&(account.role==='admin'||account.active===1)&&!account.must_change?await all(db,'SELECT id,transports FROM passkeys WHERE user_id=? LIMIT 10',account.id):[];
        check(existing.length>0,401,'이 계정에서 사용할 수 있는 패스키를 확인하지 못했습니다. 계정과 패스키 등록 완료 여부를 확인해주세요.');
        allowCredentials=existing.map(c=>({id:canonicalCredentialId(c.id),transports:JSON.parse(c.transports)}));
      }
      options=await generateAuthenticationOptions({rpID,userVerification:'required',...(allowCredentials?{allowCredentials}:{})});
    }
    const id=token();tx.add('DELETE FROM passkey_challenges WHERE expires<=?',ms);tx.add('INSERT INTO passkey_challenges VALUES(?,?,?,?,?,?)',id,options.challenge,registration?'register':'login',account?.id||null,ticketHash,ms+300000);await tx.commit();return {challengeId:id,options};
  }
  check(typeof body.challengeId==='string',400,'인증 요청 ID가 필요합니다.');
  const challenge=await one(db,'SELECT * FROM passkey_challenges WHERE id=?',body.challengeId);
  check(challenge&&challenge.expires>ms,401,'인증 요청이 만료되었습니다. 다시 시도하세요.');
  if(path==='/api/passkeys/enroll/verify'){
    check(challenge.kind==='register',401,'인증 요청 유형이 다릅니다.');
    const ticket=await enrollmentTicket(body.ticket,env,db,now);check(ticket.account.id===challenge.user_id&&ticket.hash===challenge.ticket_hash,401,'계정 등록 요청이 다릅니다.');
    const response=normalizeCredential(body.response);sameContext(response);
    let verified;try{verified=await verifyRegistrationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:env.APP_ORIGIN,expectedRPID:rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7]});}catch{check(false,401,'패스키 등록 검증에 실패했습니다.');}
    check(verified.verified&&verified.registrationInfo,401,'패스키 등록 검증에 실패했습니다.');
    const credential=verified.registrationInfo.credential;
    check(credential.id===response.id,401,'브라우저 패스키 ID와 등록된 키 ID가 일치하지 않습니다.');
    tx.add('INSERT INTO passkeys VALUES(?,?,?,?,?,?)',credential.id,ticket.account.id,new Uint8Array(credential.publicKey).buffer,credential.counter,JSON.stringify(credential.transports||[]),stamp);
    tx.add('INSERT INTO passkey_used_tickets VALUES(?,?,?)',ticket.hash,ticket.account.id,stamp);
    if(ticket.invite)tx.add('UPDATE passkey_invites SET used_at=? WHERE hash=? AND used_at IS NULL',stamp,ticket.hash);
    // UV enrollment replaces the temporary-password requirement, without
    // modifying the preserved hash. All old sessions are revoked.
    tx.add('UPDATE users SET must_change=0 WHERE id=?',ticket.account.id);tx.add('DELETE FROM sessions WHERE user_id=?',ticket.account.id);
    tx.add('DELETE FROM passkey_challenges WHERE id=?',challenge.id);audit(tx,ticket.account,'passkey_enroll',credential.id,'기존 비밀번호 검증 후 패스키 등록',null,{userId:ticket.account.id},stamp);await tx.commit();
    const stored=await one(db,'SELECT id FROM passkeys WHERE id=?',credential.id);
    await credentialDiagnostic(diagnostics.requestId,'register',body.response,response,Boolean(stored));
    return {ok:true,login:ticket.account.login};
  }
  check(path==='/api/passkeys/login/verify'&&challenge.kind==='login',401,'인증 요청 유형이 다릅니다.');
  const response=normalizeCredential(body.response);
  const credential=await one(db,'SELECT * FROM passkeys WHERE id=?',response.id);
  await credentialDiagnostic(diagnostics.requestId,'login',body.response,response,Boolean(credential));
  check(credential,401,'기기에 저장된 패스키가 서버 등록 목록에 없습니다. 새 등록권으로 패스키 등록을 완료한 뒤 로그인해주세요.');
  check(!challenge.user_id||challenge.user_id===credential.user_id,401,'선택한 계정의 패스키가 아닙니다.');
  const account=await one(db,'SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.id=?',credential.user_id);check(account&&(account.role==='admin'||account.active===1)&&!account.must_change,401,'계정이 비활성화되었거나 재등록이 필요합니다.');
  check(response.response?.userHandle===to64(enc.encode(account.id))||challenge.user_id===account.id&&response.response?.userHandle==null,401,'패스키 계정이 일치하지 않습니다.');
  sameContext(response);
  let result;try{result=await verifyAuthenticationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:env.APP_ORIGIN,expectedRPID:rpID,requireUserVerification:true,credential:{id:credential.id,publicKey:new Uint8Array(credential.public_key),counter:credential.counter,transports:JSON.parse(credential.transports)}});}catch{check(false,401,'패스키 인증에 실패했습니다.');}
  check(result.verified,401,'패스키 인증에 실패했습니다.');
  const raw=token(),csrf=token();tx.add('UPDATE passkeys SET counter=? WHERE id=?',result.authenticationInfo.newCounter,credential.id);tx.add('DELETE FROM passkey_challenges WHERE id=?',challenge.id);tx.add('DELETE FROM sessions WHERE expires<=?',ms);tx.add('INSERT INTO sessions VALUES(?,?,?,?)',await digest(raw),account.id,csrf,ms+28800000);await tx.commit();return {ok:true,sessionToken:raw};
}
