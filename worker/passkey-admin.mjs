import {generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {check,one,all,audit} from './d1.mjs';
import {digest,token} from './security.mjs';
import {sameContext,to64,normalizeCredential} from './passkeys.mjs';
const enc=new TextEncoder();
const text=(v,max)=>{check(typeof v==='string'&&v.trim().length>0&&v.trim().length<=max,400,'필수 입력을 확인하세요.');return v.trim();};
const pendingAdministrator=account=>account?.role==='admin'&&account.employee_id===null&&account.must_change===1&&account.password_hash.startsWith('passkey-only-admin:');
export function operation(kind,body){
  check(['create','recover','create-admin','reinvite-admin'].includes(kind),400,'계정 작업 유형이 다릅니다.');
  const reason=text(body.reason,500);
  if(kind==='create-admin'||kind==='reinvite-admin'){
    check(body.adminRightsConfirmed===true,400,'이 계정에 전체 관리자 권한을 부여하는지 확인하세요.');
    if(kind==='create-admin'){
      const login=text(body.login,30).toUpperCase();check(/^[A-Z0-9-]+$/.test(login),400,'관리자 계정은 영문·숫자·하이픈만 사용하세요.');
      return {kind,login,reason,adminRightsConfirmed:true};
    }
    return {kind,id:text(body.id,100),reason,adminRightsConfirmed:true};
  }
  if(kind==='create'){
    const number=text(body.number,30).toUpperCase();check(/^[A-Z0-9-]+$/.test(number),400,'사번은 영문·숫자·하이픈만 사용하세요.');
    return {kind,number,name:text(body.name,40),team:text(body.team,40),reason};
  }
  check(body.identityConfirmed===true,400,'직원 본인 확인을 완료하세요.');
  check(Number.isInteger(body.version)&&body.version>0,400,'직원 버전이 필요합니다.');
  return {kind,id:text(body.id,100),version:body.version,reason,identityConfirmed:true};
}
export async function adminOptions(body,user,env,db,tx,now){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const intent=operation(body.operation,body.details||{}),existing=await all(db,'SELECT id,transports FROM passkeys WHERE user_id=? LIMIT 10',user.id);
  check(existing.length>0,403,'관리자 패스키를 먼저 등록하세요.');
  const options=await generateAuthenticationOptions({rpID:new URL(env.APP_ORIGIN).hostname,userVerification:'required',allowCredentials:existing.map(c=>({id:c.id,transports:JSON.parse(c.transports)}))});
  const id=token();tx.add('DELETE FROM passkey_admin_challenges WHERE expires<=?',now.getTime());
  tx.add('INSERT INTO passkey_admin_challenges VALUES(?,?,?,?,?)',id,options.challenge,user.id,await digest(JSON.stringify(intent)),now.getTime()+90000);
  return {challengeId:id,options};
}
async function authorize(intent,proof,user,env,db,tx,now){
  check(proof&&typeof proof.challengeId==='string',403,'관리자 패스키 재인증이 필요합니다.');
  const challenge=await one(db,'SELECT * FROM passkey_admin_challenges WHERE id=?',proof.challengeId);
  check(challenge&&challenge.user_id===user.id&&challenge.expires>now.getTime()&&challenge.operation_hash===await digest(JSON.stringify(intent)),403,'관리자 인증이 만료되었거나 작업 내용이 다릅니다.');
  let response;try{response=normalizeCredential(proof.response);}catch{check(false,403,'관리자 패스키 응답 형식이 다릅니다.');}
  const credential=await one(db,'SELECT * FROM passkeys WHERE id=? AND user_id=?',response.id,user.id);
  check(credential,403,'이 관리자의 패스키가 필요합니다.');
  // allowCredentials requests may omit userHandle; if supplied it must match.
  check(response.response?.userHandle==null||response.response.userHandle===to64(enc.encode(user.id)),403,'관리자 계정이 다릅니다.');
  sameContext(response);
  let result;try{result=await verifyAuthenticationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:env.APP_ORIGIN,expectedRPID:new URL(env.APP_ORIGIN).hostname,requireUserVerification:true,credential:{id:credential.id,publicKey:new Uint8Array(credential.public_key),counter:credential.counter,transports:JSON.parse(credential.transports)}});}catch{check(false,403,'관리자 패스키 재인증에 실패했습니다.');}
  check(result.verified,403,'관리자 패스키 재인증에 실패했습니다.');
  tx.add('UPDATE passkeys SET counter=? WHERE id=?',result.authenticationInfo.newCounter,credential.id);
  tx.add('DELETE FROM passkey_admin_challenges WHERE id=?',challenge.id);
}
export async function administrators(db,user){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const rows=await all(db,"SELECT u.id,u.login,u.must_change,count(p.id) passkey_count,CASE WHEN u.must_change=1 AND u.employee_id IS NULL AND u.password_hash LIKE 'passkey-only-admin:%' AND count(p.id)=0 THEN 1 ELSE 0 END can_reissue FROM users u LEFT JOIN passkeys p ON p.user_id=u.id WHERE u.role='admin' GROUP BY u.id ORDER BY u.login LIMIT 101");
  return {accounts:rows.slice(0,100).map(row=>({id:row.id,login:row.login,mustChange:Boolean(row.must_change),passkeyCount:row.passkey_count,canReissue:Boolean(row.can_reissue)})),hasMore:rows.length>100};
}
export async function provisionAdministrator(kind,body,user,env,db,tx,now){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  check(['create-admin','reinvite-admin'].includes(kind),400,'관리자 계정 작업 유형이 다릅니다.');
  const intent=operation(kind,body),stamp=now.toISOString();
  await authorize(intent,body.authorization,user,env,db,tx,now);
  let account;
  if(kind==='create-admin'){
    check(!await one(db,'SELECT id FROM users WHERE login=?',intent.login)&&!await one(db,'SELECT id FROM employees WHERE number=?',intent.login),409,'이미 사용 중인 로그인 계정입니다.');
    check((await one(db,"SELECT count(*) n FROM users WHERE role='admin'")).n<100,409,'관리자 계정은 최대 100개까지 등록할 수 있습니다.');
    account={id:crypto.randomUUID(),login:intent.login,password_hash:'passkey-only-admin:'+token()};
    // Administrator identities are separate users, never employee promotions.
    tx.add("INSERT INTO users(id,login,password_hash,role,employee_id,must_change) VALUES(?,?,?,'admin',NULL,1)",account.id,account.login,account.password_hash);
  }else{
    account=await one(db,'SELECT * FROM users WHERE id=?',intent.id);
    check(pendingAdministrator(account)&&!await one(db,'SELECT id FROM passkeys WHERE user_id=? LIMIT 1',account.id),409,'아직 패스키를 등록하지 않은 신규 관리자만 등록권을 다시 발급할 수 있습니다.');
    // Pending invitations may be replaced; active administrator keys are never recovered here.
    tx.add('DELETE FROM passkey_invites WHERE user_id=?',account.id);
    tx.add("DELETE FROM passkey_challenges WHERE user_id=? AND kind='register'",account.id);
  }
  const invite=token(),expires=now.getTime()+900000;
  tx.add('DELETE FROM passkey_invites WHERE expires<=?',now.getTime());
  tx.add('INSERT INTO passkey_invites VALUES(?,?,?,?,?,?,NULL)',await digest(invite),account.id,await digest(account.password_hash),expires,user.id,stamp);
  audit(tx,user,kind==='create-admin'?'admin_create':'admin_invite_reissue',account.id,intent.reason,null,{userId:account.id,login:account.login,role:'admin',adminRightsConfirmed:true},stamp);
  return {id:account.id,login:account.login,role:'admin',enrollmentTicket:invite,expiresAt:new Date(expires).toISOString()};
}
export async function provision(kind,body,user,env,db,tx,now){
  check(user.role==='admin',403,'관리자 권한이 필요합니다.');
  const intent=operation(kind,body),stamp=now.toISOString();
  await authorize(intent,body.authorization,user,env,db,tx,now);
  let account,employeeId;
  if(kind==='create'){
    check(!await one(db,'SELECT id FROM employees WHERE number=?',intent.number)&&!await one(db,'SELECT id FROM users WHERE login=?',intent.number),409,'이미 등록된 사번입니다.');
    employeeId=crypto.randomUUID();account={id:crypto.randomUUID(),login:intent.number,password_hash:'passkey-only:'+token()};
    tx.add('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)',employeeId,intent.number,intent.name,intent.team,env.SITE_ID);
    // There is deliberately no password credential for newly created users.
    tx.add("INSERT INTO users(id,login,password_hash,role,employee_id,must_change) VALUES(?,?,?,'employee',?,1)",account.id,account.login,account.password_hash,employeeId);
  }else{
    const employee=await one(db,'SELECT * FROM employees WHERE id=?',intent.id);
    check(employee&&employee.active===1,409,'재직 중인 직원만 복구할 수 있습니다.');check(employee.version===intent.version,409,'직원 정보가 변경되었습니다. 새로고침하세요.');
    account=await one(db,"SELECT * FROM users WHERE employee_id=? AND role='employee'",employee.id);check(account,404,'계정이 없습니다.');employeeId=employee.id;
    tx.add('DELETE FROM passkeys WHERE user_id=?',account.id);tx.add('DELETE FROM sessions WHERE user_id=?',account.id);
    tx.add('DELETE FROM passkey_challenges WHERE user_id=?',account.id);tx.add('DELETE FROM passkey_invites WHERE user_id=?',account.id);
    tx.add('UPDATE users SET must_change=1 WHERE id=?',account.id);
    tx.add('UPDATE employees SET version=version+1 WHERE id=?',employeeId);
    tx.add('INSERT INTO passkey_account_state VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_recovery=excluded.last_recovery',account.id,now.getTime());
  }
  const invite=token(),expires=now.getTime()+900000;
  tx.add('DELETE FROM passkey_invites WHERE expires<=?',now.getTime());
  tx.add('INSERT INTO passkey_invites VALUES(?,?,?,?,?,?,NULL)',await digest(invite),account.id,await digest(account.password_hash),expires,user.id,stamp);
  audit(tx,user,kind==='create'?'employee_create':'passkey_recovery',employeeId,intent.reason,null,{userId:account.id,identityConfirmed:intent.identityConfirmed||false},stamp);
  return {id:employeeId,login:account.login,enrollmentTicket:invite,expiresAt:new Date(expires).toISOString()};
}
