import {settings,token,digest,hashPassword,verifyPassword,dummyHash} from './security.mjs';
import {check,one,all,begin,consistent,audit,boundedDatabase} from './d1.mjs';
import {koreaNow,needsReview,validateQuantity} from '../public/domain.js';
import {saveRequest,decideRequest,listRequests,requestHistory,reportPeriod} from './work-requests.mjs';
import {passkeyRoute} from './passkeys.mjs';
import {adminOptions,provision} from './passkey-admin.mjs';

const uuid=()=>crypto.randomUUID();
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
const text=(value,max=40)=>{check(typeof value==='string' && value.trim().length>0 && value.trim().length<=max,400,`필수 입력은 1~${max}자입니다.`);return value.trim();};
const loginNumber=value=>{const result=text(value,30).toUpperCase();check(/^[A-Z0-9-]+$/.test(result),400,'사번은 영문·숫자·하이픈만 사용하세요.');return result;};
const version=(before,body)=>check(before.version===body.version,409,'다른 변경이 있습니다. 새로고침해 주세요.');
const admin=user=>check(user?.role==='admin',403,'관리자 권한이 필요합니다.');
const employee=user=>{check(user?.role==='employee',403,'직원 계정이 필요합니다.');return user.employee_id;};
const attendanceView=r=>({id:r.id,employeeId:r.employee_id,date:r.date,in:koreaNow(new Date(r.in_at)).time,out:r.out_at?koreaNow(new Date(r.out_at)).time:null,outDate:r.out_at?koreaNow(new Date(r.out_at)).date:null,inAt:r.in_at,outAt:r.out_at,version:r.version});
const cookie=(value,age=28800)=>`__Host-onwork=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}; Secure`;
async function row(db,table,id){const value=await one(db,`SELECT * FROM ${table} WHERE id=?`,id??'');check(value,404,'기록을 찾을 수 없습니다.');return value;}
async function session(db,request,now){
  const raw=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-onwork='))?.slice(14);
  if(!raw)return null;
  return one(db,`SELECT u.*,s.csrf,s.hash session_hash FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN employees e ON e.id=u.employee_id WHERE s.hash=? AND s.expires>? AND (u.role='admin' OR e.active=1)`,await digest(raw),now.getTime());
}
const setupNeeded=async db=>!await one(db,'SELECT 1 FROM initial_setup WHERE id=1') && !await one(db,"SELECT 1 FROM users WHERE role='admin' LIMIT 1");
function instant(value,now){check(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+09:00)$/.test(value),400,'ISO 시각이 필요합니다.');const d=new Date(value);check(Number.isFinite(d.getTime())&&d<=now,400,'유효한 과거 시각을 입력하세요.');return d.toISOString();}
const decodeCursor=value=>{if(!value)return {};check(value.length<=2000,400,'잘못된 커서입니다.');try{const r=JSON.parse(atob(value));check(r&&typeof r==='object'&&!Array.isArray(r)&&Object.values(r).every(v=>typeof v==='string'&&v.length<=100),400,'잘못된 커서입니다.');return r;}catch{throw Object.assign(Error('잘못된 커서입니다.'),{status:400});}};
async function dataPages(db,user,params,report=false){
  const cursor=decodeCursor(params.get('cursor')),next={},result={pageType:report?'report':'state'};
  const period=report?reportPeriod(params):null;
  if(period)Object.assign(result,period);
  const definitions={employees:['id',user.role==='employee'?'id=?':params.get('employeeId')&&report?'id=?':'',user.role==='employee'?[user.employee_id]:params.get('employeeId')&&report?[params.get('employeeId')]:[]],tasks:['id','',[]],attendance:['id','',[]],production:['id','',[]],overtime:['id','',[]],work_requests:['id','',[]]};
  const tables=report?['employees','attendance','production','work_requests']:['employees','tasks','attendance','production','overtime'];
  for(const table of tables){
    if(cursor[table]==='DONE'){result[table==='work_requests'?'requests':table]=[];next[table]='DONE';continue;}
    const [,filter,filterArgs]=definitions[table],where=filter?[filter]:[],args=[...filterArgs];
    if(['attendance','production','work_requests'].includes(table)){
      const id=user.role==='employee'?user.employee_id:report?params.get('employeeId'):null;
      if(id){where.push('employee_id=?');args.push(id);}
      if(period){where.push(table==='work_requests'?'end_date>=? AND start_date<=?':'date BETWEEN ? AND ?');args.push(period.from,period.to);}
    }
    if(table==='overtime'&&user.role==='employee'){where.push('attendance_id IN(SELECT id FROM attendance WHERE employee_id=?)');args.push(user.employee_id);}
    if(cursor[table]){where.push('id>?');args.push(cursor[table]);}
    const items=await all(db,`SELECT * FROM ${table} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id LIMIT 201`,...args);
    next[table]=items.length>200?items[199].id:'DONE';
    result[table==='work_requests'?'requests':table]=items.slice(0,200);
  }
  result.nextCursor=Object.values(next).every(v=>v==='DONE')?null:btoa(JSON.stringify(next));
  return result;
}

export async function handle(request,env,clock=()=>new Date()){
  const config=settings(env,request),url=new URL(request.url),path=url.pathname,method=request.method,now=clock(),stamp=now.toISOString();
  // Primary session prevents stale reads during authorization and mutation checks.
  const db=boundedDatabase(env.DB.withSession('first-primary'));
  if(path==='/healthz'){
    check(['GET','HEAD'].includes(method),405,'허용되지 않는 요청입니다.');
    let ready=false;try{ready=(await one(db,'SELECT version FROM schema_version LIMIT 1'))?.version===1 && Boolean(await one(db,'SELECT revision FROM worker_revision WHERE id=1'));}catch{}
    return method==='HEAD'?new Response(null,{status:ready?200:503}):json({status:ready?'ok':'unavailable'},ready?200:503);
  }
  check(!config.maintenance,503,'점검 중입니다. 잠시 후 다시 접속해 주세요.');
  if(env.ENVIRONMENT==='production')check((await one(db,'SELECT verified FROM worker_import WHERE id=1'))?.verified===1,503,'DB 이전 검증이 필요합니다.');
  const passkeyMode=env.AUTH_MODE!=='legacy';
  check(passkeyMode||env.ENVIRONMENT!=='production',503,'운영 환경은 패스키 인증이 필요합니다.');
  const passkeyPaths=['/api/passkeys/enroll/options','/api/passkeys/enroll/verify','/api/passkeys/login/options','/api/passkeys/login/verify'];
  const passkeyPost=passkeyPaths.includes(path)&&method==='POST';
  const tx=passkeyPost?null:await begin(db),user=passkeyPost?null:await session(db,request,now);
  if(url.searchParams.has('revision'))check(tx&&url.searchParams.get('revision')===String(tx.revision),409,'조회 중 변경이 있습니다. 다시 조회하세요.');
  const publicApi=([...passkeyPaths,'/api/login','/api/origin-check'].includes(path)&&method==='POST')||(path==='/api/setup'&&['GET','POST'].includes(method));
  const adminPath=path==='/admin'||path.startsWith('/admin/')||path==='/api/admin'||path.startsWith('/api/admin/');
  if(adminPath){check(user,401,'로그인이 필요합니다.');admin(user);}
  if(path.startsWith('/api/')&&!publicApi)check(user,401,'로그인이 필요합니다.');
  let body={};
  if(!['GET','HEAD'].includes(method)){
    check(request.headers.get('origin')===config.origin,403,'허용되지 않은 요청 출처입니다.');
    check(request.headers.get('content-type')?.startsWith('application/json'),415,'JSON 요청이 필요합니다.');
    // Bound actual streamed bytes, including requests without Content-Length.
    const reader=request.body?.getReader();let length=0;const chunks=[];
    if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>16384){await reader.cancel();check(false,413,'요청이 너무 큽니다.');}chunks.push(chunk.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{check(false,400,'JSON 형식을 확인하세요.');}
    check(body&&typeof body==='object'&&!Array.isArray(body),400,'요청 형식을 확인하세요.');
    if(!publicApi)check(user&&request.headers.get('x-csrf-token')===user.csrf,403,'요청 검증이 필요합니다.');
  }
  const finish=async(data,status=200,headers={})=>{await tx.commit();return json(data,status,headers);};
  const read=async data=>{await consistent(db,tx.revision);return json(data);};
  if(path==='/api/origin-check'&&method==='POST')return read({ok:true,receivedOrigin:config.origin});
  if(path==='/api/setup'&&method==='GET')return read({required:passkeyMode?false:await setupNeeded(db),appOrigin:config.origin,authMode:passkeyMode?'passkey':'password',environment:env.ENVIRONMENT});
  if(passkeyPaths.includes(path)&&method==='POST'){
    check(passkeyMode,404,'패스키 인증이 활성화되지 않았습니다.');
    const result=await passkeyRoute(path,body,request,env,db,now);
    const headers=result.sessionToken?{'Set-Cookie':cookie(result.sessionToken)}:{};
    delete result.sessionToken;return json(result,200,headers);
  }
  if(path==='/api/setup'&&method==='POST'){
    check(!passkeyMode,403,'검증된 계정을 가져오고 패스키 등록권을 발급하세요.');
    check(await setupNeeded(db),409,'초기 설정이 이미 완료되었습니다.');
    check(env.ENVIRONMENT!=='production',403,'운영 DB는 기존 계정을 이전해야 합니다.');
    check(body.password===body.confirmation,400,'비밀번호 확인이 일치하지 않습니다.');
    const login=loginNumber(body.login),hash=await hashPassword(body.password),id=uuid();
    tx.add("INSERT INTO users(id,login,password_hash,role,must_change) VALUES(?,?,?,'admin',0)",id,login,hash);
    for(const name of ['부품 조립','제품 검사','포장'])tx.add('INSERT OR IGNORE INTO tasks(id,name) VALUES(?,?)',uuid(),name);
    tx.add('INSERT INTO initial_setup VALUES(1,?)',stamp);audit(tx,{id,login},'bootstrap',id,'초기 관리자 생성',null,null,stamp);
    return finish({ok:true},201);
  }
  if(path==='/api/login'&&method==='POST'){
    check(!passkeyMode,403,'패스키로 로그인하세요. 기존 비밀번호는 계정 이전 시 로컬에서 검증합니다.');
    const login=typeof body.login==='string'?body.login.trim().toUpperCase().slice(0,100):'',key=await digest(login),ms=now.getTime();
    const limit=await one(db,'SELECT * FROM login_limits WHERE key=?',key);
    check(!limit||limit.reset_at<=ms||limit.attempts<10,429,'로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.');
    tx.add('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END',key,ms+900000,ms,ms,ms+900000);
    // Reserve the attempt before KDF. Exceeding CPU limits still consumes it.
    await tx.commit();
    const loginTx=await begin(db),account=await one(db,'SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.login=?',login);
    const valid=await verifyPassword(body.password,account?.password_hash||dummyHash);
    check(valid&&account&&(account.role==='admin'||account.active===1),401,'로그인 정보가 올바르지 않습니다.');
    const raw=token(),csrf=token();
    loginTx.add('DELETE FROM login_limits WHERE key=?',key);
    if(user)loginTx.add('DELETE FROM sessions WHERE hash=?',user.session_hash);
    loginTx.add('INSERT INTO sessions VALUES(?,?,?,?)',await digest(raw),account.id,csrf,ms+28800000);
    await loginTx.commit();return json({ok:true},200,{'Set-Cookie':cookie(raw)});
  }
  if(path.startsWith('/api/')){
    if(user.role==='employee'){
      const targets=[...url.searchParams.getAll('employeeId'),...url.searchParams.getAll('employee_id')];
      for(const key of ['employeeId','employee_id'])if(Object.hasOwn(body,key))targets.push(body[key]);
      check(targets.every(id=>id===user.employee_id),403,'다른 직원의 기록에 접근할 수 없습니다.');
    }
    if(path==='/api/me'&&method==='GET')return read({id:user.id,login:user.login,role:user.role,employeeId:user.employee_id,csrf:user.csrf,mustChange:Boolean(user.must_change)});
    if(path==='/api/logout'&&method==='POST'){tx.add('DELETE FROM sessions WHERE hash=?',user.session_hash);return finish({ok:true},200,{'Set-Cookie':cookie('',0)});}
    if(path==='/api/password'&&method==='POST'){
      check(!passkeyMode,409,'패스키 계정의 기존 해시는 보존합니다.');
      check(await verifyPassword(body.currentPassword,user.password_hash),400,'현재 비밀번호가 올바르지 않습니다.');
      check(body.password!==body.currentPassword,400,'다른 비밀번호를 입력하세요.');const hash=await hashPassword(body.password);
      tx.add('UPDATE users SET password_hash=?,must_change=0 WHERE id=?',hash,user.id);tx.add('DELETE FROM sessions WHERE user_id=?',user.id);audit(tx,user,'password_change',user.id,'본인 비밀번호 변경',null,null,stamp);
      return finish({ok:true},200,{'Set-Cookie':cookie('',0)});
    }
    check(!user.must_change,403,'먼저 임시 비밀번호를 변경하세요.');
    if(path==='/api/admin/passkeys/authorize/options'&&method==='POST'){
      check(passkeyMode,404,'패스키 인증이 필요합니다.');return finish(await adminOptions(body,user,env,db,tx,now));
    }
    if(path==='/api/admin/passkeys/recover'&&method==='POST'){
      check(passkeyMode,404,'패스키 인증이 필요합니다.');return finish(await provision('recover',body,user,env,db,tx,now));
    }
    if(path==='/api/state'&&method==='GET')return read({...await dataPages(db,user,url.searchParams),today:koreaNow(now).date,siteId:config.siteId,revision:tx.revision});
    if(path==='/api/work-requests'&&method==='GET')return read({...await listRequests(db,user,url.searchParams),pageType:'list',revision:tx.revision});
    if(path==='/api/work-requests/history'&&method==='GET')return read({...await requestHistory(db,user,url.searchParams),pageType:'list',revision:tx.revision});
    if(path==='/api/work-requests'&&method==='POST')return finish(await saveRequest(db,tx,user,body,stamp));
    if(path==='/api/admin/work-requests/decision'&&method==='POST')return finish(await decideRequest(db,tx,user,body,stamp));
    if(path==='/api/admin/work-requests/report'&&method==='GET')return read({...await dataPages(db,user,url.searchParams,true),revision:tx.revision});
    if(path==='/api/admin/audit'&&method==='GET'){
      const items=await all(db,'SELECT * FROM audit WHERE id>? ORDER BY id LIMIT 201',url.searchParams.get('after')||'');
      return read({pageType:'list',items:items.slice(0,200),next:items.length>200?items[199].id:null,revision:tx.revision});
    }
    if(path==='/api/admin/employee'&&method==='POST'){
      if(passkeyMode&&!body.id)return finish(await provision('create',body,user,env,db,tx,now));
      const reason=text(body.reason,500),name=text(body.name),team=text(body.team),login=loginNumber(body.number),before=body.id?await row(db,'employees',body.id):null;
      if(before)version(before,body);
      check(!await one(db,'SELECT id FROM employees WHERE number=? AND id!=?',login,body.id||''),409,'이미 등록된 사번입니다.');
      check(!await one(db,'SELECT id FROM users WHERE login=? AND (employee_id IS NULL OR employee_id!=?)',login,body.id||''),409,'이미 사용 중인 로그인입니다.');
      const id=before?.id||uuid(),after={...before,id,number:login,name,team,site_id:before?.site_id||config.siteId,active:before?.active??1,version:(before?.version||0)+1};
      if(before){tx.add('UPDATE employees SET number=?,name=?,team=?,version=version+1 WHERE id=?',login,name,team,id);tx.add('UPDATE users SET login=? WHERE employee_id=?',login,id);}
      else{const hash=await hashPassword(body.password);tx.add('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)',id,login,name,team,config.siteId);tx.add("INSERT INTO users(id,login,password_hash,role,employee_id) VALUES(?,?,?,'employee',?)",uuid(),login,hash,id);}
      audit(tx,user,before?'employee_update':'employee_create',id,reason,before,after,stamp);return finish({id});
    }
    if(path==='/api/admin/employee-status'&&method==='POST'){
      const reason=text(body.reason,500),before=await row(db,'employees',body.id);version(before,body);check(typeof body.active==='boolean',400,'활성 상태가 필요합니다.');
      tx.add('UPDATE employees SET active=?,version=version+1 WHERE id=?',Number(body.active),body.id);tx.add('DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE employee_id=?)',body.id);
      audit(tx,user,body.active?'employee_reactivate':'employee_retire',body.id,reason,before,{...before,active:Number(body.active),version:before.version+1},stamp);return finish({ok:true});
    }
    if(path==='/api/admin/reset-password'&&method==='POST'){
      check(!passkeyMode,409,'기존 해시는 보존합니다. 로컬 비밀번호 검증 후 새 패스키 등록권을 발급하세요.');
      const reason=text(body.reason,500);await row(db,'employees',body.id);const hash=await hashPassword(body.password);
      tx.add('UPDATE users SET password_hash=?,must_change=1 WHERE employee_id=?',hash,body.id);tx.add('DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE employee_id=?)',body.id);audit(tx,user,'password_reset',body.id,reason,null,null,stamp);return finish({ok:true});
    }
    if(path==='/api/admin/task'&&method==='POST'){
      const name=text(body.name),reason=text(body.reason,500),before=body.id?await row(db,'tasks',body.id):null;if(before)version(before,body);
      check(!await one(db,'SELECT id FROM tasks WHERE name=? COLLATE NOCASE AND id!=?',name,body.id||''),409,'이미 등록된 작업입니다.');
      const id=before?.id||uuid();if(before)tx.add('UPDATE tasks SET name=?,version=version+1 WHERE id=?',name,id);else tx.add('INSERT INTO tasks(id,name) VALUES(?,?)',id,name);
      audit(tx,user,before?'task_update':'task_create',id,reason,before,{id,name,version:(before?.version||0)+1},stamp);return finish({id});
    }
    if(path==='/api/attendance'&&method==='POST'){
      const id=employee(user),today=koreaNow(now).date;check(['in','out'].includes(body.action),400,'출근 또는 퇴근을 선택하세요.');
      const open=await one(db,'SELECT * FROM attendance WHERE employee_id=? AND out_at IS NULL',id);let after;
      if(body.action==='in'){
        check(!open,409,'진행 중인 출근 기록이 있습니다.');check(!await one(db,'SELECT id FROM attendance WHERE employee_id=? AND date=?',id,today),409,'오늘 출근 기록이 이미 있습니다.');
        after={id:uuid(),employee_id:id,date:today,in_at:stamp,out_at:null,version:1};tx.add('INSERT INTO attendance(id,employee_id,date,in_at) VALUES(?,?,?,?)',after.id,id,today,stamp);
      }else{check(open,409,'출근 기록이 없습니다.');check(stamp>=open.in_at,409,'서버 시각을 확인하세요.');after={...open,out_at:stamp,version:open.version+1};tx.add('UPDATE attendance SET out_at=?,version=version+1 WHERE id=?',stamp,open.id);}
      audit(tx,user,'attendance_'+body.action,after.id,'본인 출퇴근 기록',open||null,after,stamp);return finish({record:attendanceView(after)});
    }
    if(path==='/api/production'&&method==='POST'){
      const id=employee(user),error=validateQuantity(body.good,body.bad);check(!error,400,error);check(typeof body.requestKey==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(body.requestKey),400,'요청 식별자가 필요합니다.');
      const task=await row(db,'tasks',body.taskId),existing=await one(db,'SELECT * FROM production WHERE employee_id=? AND request_key=?',id,body.requestKey);
      if(existing){check(existing.task_id===body.taskId&&existing.good===Number(body.good)&&existing.bad===Number(body.bad),409,'이미 사용된 요청 식별자입니다.');return read({id:existing.id});}
      const after={id:uuid(),employee_id:id,task_id:task.id,task_name:task.name,date:koreaNow(now).date,recorded_at:stamp,good:Number(body.good),bad:Number(body.bad),version:1,request_key:body.requestKey};
      tx.add('INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,?,?,?,?,?,?,?)',after.id,id,task.id,task.name,after.date,stamp,after.good,after.bad,body.requestKey);
      audit(tx,user,'production_create',after.id,'본인 생산 기록',null,after,stamp);return finish({id:after.id});
    }
    if(path==='/api/admin/attendance'&&method==='POST'){
      const reason=text(body.reason,500),inAt=instant(body.inAt,now),outAt=body.outAt?instant(body.outAt,now):null;check(!outAt||outAt>=inAt,400,'퇴근은 출근 이후여야 합니다.');
      const before=await row(db,'attendance',body.id);version(before,body);const date=koreaNow(new Date(inAt)).date;
      check(!await one(db,'SELECT id FROM attendance WHERE employee_id=? AND date=? AND id!=?',before.employee_id,date,before.id),409,'해당 날짜 출근 기록이 이미 있습니다.');
      check(outAt||!await one(db,'SELECT id FROM attendance WHERE employee_id=? AND out_at IS NULL AND id!=?',before.employee_id,before.id),409,'다른 미퇴근 기록이 있습니다.');
      tx.add('UPDATE attendance SET date=?,in_at=?,out_at=?,version=version+1 WHERE id=?',date,inAt,outAt,before.id);
      const approval=await one(db,'SELECT * FROM overtime WHERE attendance_id=?',before.id);
      if(approval){tx.add('DELETE FROM overtime WHERE attendance_id=?',before.id);audit(tx,user,'overtime_invalidated',before.id,reason,approval,null,stamp);}
      audit(tx,user,'attendance_update',before.id,reason,before,{...before,date,in_at:inAt,out_at:outAt,version:before.version+1},stamp);return finish({ok:true});
    }
    if(path==='/api/admin/production'&&method==='POST'){
      const reason=text(body.reason,500),error=validateQuantity(body.good,body.bad);check(!error,400,error);const before=await row(db,'production',body.id);version(before,body);const task=await row(db,'tasks',body.taskId);
      tx.add('UPDATE production SET task_id=?,task_name=?,good=?,bad=?,version=version+1 WHERE id=?',task.id,task.name,Number(body.good),Number(body.bad),before.id);
      audit(tx,user,'production_update',before.id,reason,before,{...before,task_id:task.id,task_name:task.name,good:Number(body.good),bad:Number(body.bad),version:before.version+1},stamp);return finish({ok:true});
    }
    if(path==='/api/admin/overtime'&&method==='POST'){
      const reason=text(body.reason,500);check(['approved','rejected'].includes(body.status),400,'승인 또는 반려를 선택하세요.');const attendance=await row(db,'attendance',body.id);version(attendance,body);check(needsReview(attendanceView(attendance)),400,'야근 검토 대상이 아닙니다.');
      const before=await one(db,'SELECT * FROM overtime WHERE attendance_id=?',body.id),after={id:before?.id||uuid(),attendance_id:body.id,status:body.status,actor_id:user.id,decided_at:stamp,reason};
      tx.add('INSERT INTO overtime VALUES(?,?,?,?,?,?) ON CONFLICT(attendance_id) DO UPDATE SET status=excluded.status,actor_id=excluded.actor_id,decided_at=excluded.decided_at,reason=excluded.reason',after.id,body.id,body.status,user.id,stamp,reason);tx.add('UPDATE attendance SET version=version+1 WHERE id=?',body.id);
      audit(tx,user,'overtime_decision',body.id,reason,before||null,after,stamp);return finish({ok:true});
    }
    check(false,404,'API를 찾을 수 없습니다.');
  }
  check(['GET','HEAD'].includes(method),405,'허용되지 않는 요청입니다.');
  if(['/','/employee','/attendance','/production'].includes(path)&&!user)return new Response(null,{status:303,headers:{Location:'/login'}});
  if(path==='/setup'&&!await setupNeeded(db))return new Response(null,{status:303,headers:{Location:'/login'}});
  const pages=['/','/login','/setup','/employee','/attendance','/production','/admin'];
  const assets=['/app.js','/domain.js','/style.css','/work-requests.js','/worker-pages.js','/passkeys.js','/vendor/passkeys.js','/vendor/zxing.js'];
  check(pages.includes(path)||assets.includes(path),404,'페이지를 찾을 수 없습니다.');
  await consistent(db,tx.revision);
  const assetUrl=new URL(pages.includes(path)?'/index.html':path,config.origin);
  const asset=await env.ASSETS.fetch(new Request(assetUrl,{method}));
  return new Response(asset.body,{status:asset.status,headers:asset.headers});
}
export default {async fetch(request,env){
  let response;
  try{response=await handle(request,env);}catch(error){if(!error.status)console.error('Worker request failed',error.name);response=json({error:error.status?error.message:'서버 오류가 발생했습니다.'},error.status||503,error.status===503?{'Retry-After':'60'}:{});}
  response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','same-origin');
  response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.headers.set('Strict-Transport-Security','max-age=31536000');return response;
}};
