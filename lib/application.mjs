import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transaction, audit } from './db.mjs';
import { token, digest, hashPassword, verifyPassword } from './security.mjs';
import { koreaNow, needsReview, validateQuantity } from '../public/domain.js';
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const check = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };
const text = (v, max = 40) => { check(typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max,400,`필수 입력은 1~${max}자입니다.`); return v.trim(); };
const number = v => { const value = text(v,30).toUpperCase(); check(/^[A-Z0-9-]+$/.test(value),400,'사번은 영문·숫자·하이픈만 사용하세요.'); return value; };
export const attendanceView = r => ({ id:r.id, employeeId:r.employee_id, date:r.date, in:koreaNow(new Date(r.in_at)).time, out:r.out_at ? koreaNow(new Date(r.out_at)).time : null, outDate:r.out_at ? koreaNow(new Date(r.out_at)).date : null, inAt:r.in_at, outAt:r.out_at, version:r.version });
export function createApplication(db, config, clock = () => new Date()) {
  const cookieName = config.secure ? '__Host-onwork' : 'onwork';
  const dummyHash = hashPassword(token());
  const cookie = (value, age = 28800) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  function getSession(request) {
    const raw = (request.headers.get('cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if (!raw) return null;
    return db.prepare(`SELECT u.*,s.csrf,s.hash AS session_hash FROM sessions s JOIN users u ON s.user_id=u.id LEFT JOIN employees e ON e.id=u.employee_id WHERE s.hash=? AND s.expires>? AND (u.role='admin' OR e.active=1)`).get(digest(raw),clock().getTime());
  }
  const admin = user => check(user?.role === 'admin',403,'관리자 권한이 필요합니다.');
  const employee = user => { check(user?.role === 'employee',403,'직원 계정이 필요합니다.'); return user.employee_id; };
  const row = (table,id) => { const result = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); check(result,404,'기록을 찾을 수 없습니다.'); return result; };
  const version = (r,b) => check(r.version === b.version,409,'다른 변경이 있습니다. 화면을 새로고침해 주세요.');
  function snapshot(user) {
    const employeeId = user.role === 'employee' ? user.employee_id : null;
    const employees = employeeId ? db.prepare('SELECT * FROM employees WHERE id=?').all(employeeId) : db.prepare('SELECT * FROM employees ORDER BY number').all();
    const own = table => employeeId ? db.prepare(`SELECT * FROM ${table} WHERE employee_id=? ORDER BY date,id`).all(employeeId) : db.prepare(`SELECT * FROM ${table} ORDER BY date,id`).all();
    const attendance = own('attendance').map(attendanceView);
    const production = own('production').map(r=>({ id:r.id, employeeId:r.employee_id, taskId:r.task_id, task:r.task_name, date:r.date, time:koreaNow(new Date(r.recorded_at)).time, good:r.good, bad:r.bad, version:r.version }));
    const overtime = employeeId ? db.prepare('SELECT o.* FROM overtime o JOIN attendance a ON a.id=o.attendance_id WHERE a.employee_id=?').all(employeeId) : db.prepare('SELECT * FROM overtime').all();
    return { employees:employees.map(e=>({...e, active:Boolean(e.active)})), tasks:db.prepare('SELECT * FROM tasks ORDER BY name').all(), attendance, production, overtime, today:koreaNow(clock()).date, siteId:config.siteId };
  }
  function deletionData(id) {
    const person=row('employees',id);
    const attendance=db.prepare('SELECT * FROM attendance WHERE employee_id=? ORDER BY id').all(id);
    const production=db.prepare('SELECT * FROM production WHERE employee_id=? ORDER BY id').all(id);
    const overtime=db.prepare('SELECT o.* FROM overtime o JOIN attendance a ON a.id=o.attendance_id WHERE a.employee_id=? ORDER BY o.id').all(id);
    const users=db.prepare('SELECT id,login,must_change FROM users WHERE employee_id=? ORDER BY id').all(id);
    const uses=db.prepare('SELECT * FROM qr_uses WHERE employee_id=? ORDER BY challenge_hash').all(id);
    const counts={employees:1,attendance:attendance.length,production:production.length,overtimeReviews:attendance.filter(r=>needsReview(attendanceView(r))).length,overtimeDecisions:overtime.length,accounts:users.length,qrUses:uses.length};
    return {counts,fingerprint:digest(JSON.stringify({person,attendance,production,overtime,users,uses}))};
  }
  function instant(value) {
    check(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+09:00)$/.test(value),400,'시간은 한국 시간 또는 UTC ISO 형식이어야 합니다.');
    const date=new Date(value);check(Number.isFinite(date.getTime()) && date<=clock(),400,'유효한 과거 시각을 입력하세요.');return date.toISOString();
  }
  async function route(request) {
    const path = new URL(request.url).pathname, method=request.method;
    const user = getSession(request);
    let body = {};
    if (!['GET','HEAD'].includes(method)) {
      check(request.headers.get('origin') === config.origin,403,'허용되지 않은 요청 출처입니다.');
      check(request.headers.get('content-type')?.startsWith('application/json'),415,'JSON 요청이 필요합니다.');
      const raw = await request.text(); check(Buffer.byteLength(raw) <= 16384,413,'요청이 너무 큽니다.');
      try { body=JSON.parse(raw); } catch { throw new HttpError(400,'JSON 형식이 올바르지 않습니다.'); }
      check(body && typeof body==='object' && !Array.isArray(body),400,'요청 형식이 올바르지 않습니다.');
      if (path !== '/api/login') check(user && request.headers.get('x-csrf-token') === user.csrf,403,'로그인 또는 요청 검증이 필요합니다.');
    }
    if (path === '/api/login' && method === 'POST') {
      const login = typeof body.login === 'string' ? body.login.trim().toUpperCase().slice(0,100) : '';
      const now=clock().getTime(), key=digest(login);
      const limit=db.prepare('SELECT * FROM login_limits WHERE key=?').get(key);
      check(!limit || limit.reset_at<=now || limit.attempts<10,429,'로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.');
      db.prepare('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END').run(key,now+900000,now,now,now+900000);
      const account=db.prepare('SELECT u.*,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.login=?').get(login);
      const valid=verifyPassword(body.password,account?.password_hash || dummyHash);
      check(valid && account && (account.role==='admin' || account.active===1),401,'로그인 정보가 올바르지 않습니다.');
      const raw=token(),csrf=token();
      transaction(db,()=>{
        db.prepare('DELETE FROM login_limits WHERE key=?').run(key);
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
        if (user) db.prepare('DELETE FROM sessions WHERE hash=?').run(user.session_hash);
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(raw),account.id,csrf,now+28800000);
      });
      return json({ok:true},200,{'Set-Cookie':cookie(raw)});
    }
    if (path.startsWith('/api/')) {
      check(user,401,'로그인이 필요합니다.');
      if (path.startsWith('/api/admin/')) admin(user);
      if (path==='/api/me' && method==='GET') return json({id:user.id,login:user.login,role:user.role,employeeId:user.employee_id,csrf:user.csrf,mustChange:Boolean(user.must_change)});
      if (path==='/api/logout' && method==='POST') { db.prepare('DELETE FROM sessions WHERE hash=?').run(user.session_hash); return json({ok:true},200,{'Set-Cookie':cookie('',0)}); }
      if (path==='/api/password' && method==='POST') {
        check(verifyPassword(body.currentPassword,user.password_hash),400,'현재 비밀번호가 올바르지 않습니다.');
        let hash; try {hash=hashPassword(body.password);} catch(e) {throw new HttpError(400,e.message);}
        check(body.password!==body.currentPassword,400,'다른 비밀번호를 입력하세요.');
        transaction(db,()=>{ db.prepare('UPDATE users SET password_hash=?,must_change=0 WHERE id=?').run(hash,user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); audit(db,user,'password_change',user.id,'본인 비밀번호 변경',null,null,clock()); });
        return json({ok:true},200,{'Set-Cookie':cookie('',0)});
      }
      check(!user.must_change,403,'먼저 임시 비밀번호를 변경하세요.');
      if (path==='/api/state' && method==='GET') return json(snapshot(user));
      if (path==='/api/admin/audit' && method==='GET') return json(db.prepare('SELECT * FROM audit ORDER BY occurred_at DESC,id DESC LIMIT 500').all());
      if (path==='/api/admin/employee' && method==='POST') {
        const reason=text(body.reason,500), name=text(body.name), team=text(body.team), login=number(body.number);
        return json(transaction(db,()=>{
          const before=body.id ? row('employees',body.id) : null;
          if(before) version(before,body);
          check(!db.prepare('SELECT id FROM employees WHERE number=? AND id!=?').get(login,body.id||''),409,'이미 등록된 사번입니다.');
          check(!db.prepare('SELECT id FROM users WHERE login=? AND (employee_id IS NULL OR employee_id!=?)').get(login,body.id||''),409,'이미 사용 중인 로그인입니다.');
          const id=before?.id || randomUUID();
          if(before) {
            db.prepare('UPDATE employees SET number=?,name=?,team=?,version=version+1 WHERE id=?').run(login,name,team,id);
            db.prepare('UPDATE users SET login=? WHERE employee_id=?').run(login,id);
          } else {
            let hash; try{hash=hashPassword(body.password);}catch(e){throw new HttpError(400,e.message);}
            db.prepare('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)').run(id,login,name,team,config.siteId);
            db.prepare("INSERT INTO users(id,login,password_hash,role,employee_id) VALUES(?,?,?,'employee',?)").run(randomUUID(),login,hash,id);
          }
          audit(db,user,before?'employee_update':'employee_create',id,reason,before,row('employees',id),clock());return {id};
        }));
      }
      if (path==='/api/admin/employee-status' && method==='POST') {
        const reason=text(body.reason,500); check(typeof body.active==='boolean',400,'활성 상태가 필요합니다.');
        return json(transaction(db,()=>{ const before=row('employees',body.id);version(before,body);
          db.prepare('UPDATE employees SET active=?,version=version+1 WHERE id=?').run(Number(body.active),body.id);
          db.prepare('DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE employee_id=?)').run(body.id);
          audit(db,user,body.active?'employee_reactivate':'employee_retire',body.id,reason,before,row('employees',body.id),clock());return {ok:true};
        }));
      }
      if (path==='/api/admin/reset-password' && method==='POST') {
        const reason=text(body.reason,500); let hash;try{hash=hashPassword(body.password);}catch(e){throw new HttpError(400,e.message);}
        return json(transaction(db,()=>{row('employees',body.id); db.prepare('UPDATE users SET password_hash=?,must_change=1 WHERE employee_id=?').run(hash,body.id);db.prepare('DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE employee_id=?)').run(body.id);audit(db,user,'password_reset',body.id,reason,null,null,clock());return {ok:true};}));
      }
      if (path==='/api/admin/task' && method==='POST') {
        const name=text(body.name),reason=text(body.reason,500);
        return json(transaction(db,()=>{const before=body.id?row('tasks',body.id):null;if(before)version(before,body);
          check(!db.prepare('SELECT id FROM tasks WHERE name=? COLLATE NOCASE AND id!=?').get(name,body.id||''),409,'이미 등록된 작업 이름입니다.');
          const id=before?.id||randomUUID();if(before)db.prepare('UPDATE tasks SET name=?,version=version+1 WHERE id=?').run(name,id);else db.prepare('INSERT INTO tasks(id,name) VALUES(?,?)').run(id,name);
          audit(db,user,before?'task_update':'task_create',id,reason,before,row('tasks',id),clock());return {id};}));
      }
      if (path==='/api/production' && method==='POST') {
        const id=employee(user),error=validateQuantity(body.good,body.bad);check(!error,400,error);check(typeof body.requestKey==='string' && /^[a-zA-Z0-9-]{16,80}$/.test(body.requestKey),400,'요청 식별자가 필요합니다.');
        return json(transaction(db,()=>{const task=row('tasks',body.taskId),existing=db.prepare('SELECT * FROM production WHERE employee_id=? AND request_key=?').get(id,body.requestKey);
          if(existing){check(existing.task_id===body.taskId && existing.good===Number(body.good) && existing.bad===Number(body.bad),409,'이미 사용된 요청 식별자입니다.');return {id:existing.id};}
          const recordId=randomUUID(),now=clock(); db.prepare('INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES(?,?,?,?,?,?,?,?,?)').run(recordId,id,task.id,task.name,koreaNow(now).date,now.toISOString(),Number(body.good),Number(body.bad),body.requestKey);
          audit(db,user,'production_create',recordId,'본인 생산 기록',null,row('production',recordId),now);return {id:recordId};}));
      }
      if (path==='/api/admin/qr' && method==='POST') {
        check(['in','out'].includes(body.action),400,'출근 또는 퇴근을 선택하세요.');
        const raw=token(),expires=clock().getTime()+60000;
        db.prepare('DELETE FROM qr_challenges WHERE expires<?').run(clock().getTime()-86400000);
        db.prepare('INSERT INTO qr_challenges VALUES(?,?,?,?)').run(digest(raw),config.siteId,body.action,expires);
        const payload=JSON.stringify({token:raw,siteId:config.siteId});
        return json({image:await QRCode.toDataURL(payload,{width:360,margin:4,errorCorrectionLevel:'M'}),expires,serverTime:clock().getTime(),siteId:config.siteId,action:body.action});
      }
      if (path==='/api/attendance/scan' && method==='POST') {
        const id=employee(user);check(typeof body.token==='string' && body.token.length<=100,400,'QR을 스캔하세요.');
        return json(transaction(db,()=>{
          const now=clock(),hash=digest(body.token),qr=db.prepare('SELECT * FROM qr_challenges WHERE hash=?').get(hash);
          check(qr && qr.expires>now.getTime(),400,'만료되었거나 유효하지 않은 QR입니다. 새 QR을 스캔하세요.');
          const person=row('employees',id);
          check(qr.site_id===person.site_id && qr.site_id===config.siteId && body.siteId===qr.site_id,403,'사업장이 일치하지 않습니다.');
          check(!db.prepare('SELECT 1 FROM qr_uses WHERE challenge_hash=? AND employee_id=?').get(hash,id),409,'이미 사용한 QR입니다.');
          const today=koreaNow(now).date;
          const open=db.prepare('SELECT * FROM attendance WHERE employee_id=? AND out_at IS NULL').get(id);
          let recordId;
          if(qr.action==='in') {
            check(!open,409,'진행 중인 출근 기록이 있습니다.');
            check(!db.prepare('SELECT id FROM attendance WHERE employee_id=? AND date=?').get(id,today),409,'오늘 출근 기록이 이미 있습니다.');
            recordId=randomUUID();db.prepare('INSERT INTO attendance(id,employee_id,date,in_at) VALUES(?,?,?,?)').run(recordId,id,today,now.toISOString());
          } else {
            check(open,409,'출근 기록이 없습니다.');recordId=open.id;
            check(now.toISOString()>=open.in_at,409,'서버 시각이 출근 시각보다 빠릅니다. 관리자에게 문의하세요.');
            db.prepare('UPDATE attendance SET out_at=?,version=version+1 WHERE id=?').run(now.toISOString(),recordId);
          }
          db.prepare('INSERT INTO qr_uses VALUES(?,?,?)').run(hash,id,now.toISOString());
          audit(db,user,'qr_'+qr.action,recordId,'사업장 QR 인증',open||null,row('attendance',recordId),now);
          return {action:qr.action,record:attendanceView(row('attendance',recordId))};
        }));
      }
      if(path==='/api/admin/attendance' && method==='POST') {
        const reason=text(body.reason,500),inAt=instant(body.inAt),outAt=body.outAt?instant(body.outAt):null;
        check(!outAt || outAt>=inAt,400,'퇴근은 출근 이후여야 합니다.');
        return json(transaction(db,()=>{const before=row('attendance',body.id);version(before,body);
          const date=koreaNow(new Date(inAt)).date;
          check(!db.prepare('SELECT id FROM attendance WHERE employee_id=? AND date=? AND id!=?').get(before.employee_id,date,before.id),409,'해당 날짜 출근 기록이 이미 있습니다.');
          check(outAt || !db.prepare('SELECT id FROM attendance WHERE employee_id=? AND out_at IS NULL AND id!=?').get(before.employee_id,before.id),409,'다른 미퇴근 기록이 있습니다.');
          db.prepare('UPDATE attendance SET date=?,in_at=?,out_at=?,version=version+1 WHERE id=?').run(date,inAt,outAt,before.id);
          const approval=db.prepare('SELECT * FROM overtime WHERE attendance_id=?').get(before.id);
          if(approval){db.prepare('DELETE FROM overtime WHERE attendance_id=?').run(before.id);audit(db,user,'overtime_invalidated',before.id,reason,approval,null,clock());}
          audit(db,user,'attendance_update',before.id,reason,before,row('attendance',before.id),clock());return {ok:true};}));
      }
      if(path==='/api/admin/production' && method==='POST') {
        const reason=text(body.reason,500),error=validateQuantity(body.good,body.bad);check(!error,400,error);
        return json(transaction(db,()=>{const before=row('production',body.id);version(before,body);const task=row('tasks',body.taskId);
          db.prepare('UPDATE production SET task_id=?,task_name=?,good=?,bad=?,version=version+1 WHERE id=?').run(task.id,task.name,Number(body.good),Number(body.bad),before.id);
          audit(db,user,'production_update',before.id,reason,before,row('production',before.id),clock());return {ok:true};}));
      }
      if(path==='/api/admin/overtime' && method==='POST') {
        const reason=text(body.reason,500);check(['approved','rejected'].includes(body.status),400,'승인 또는 반려를 선택하세요.');
        return json(transaction(db,()=>{const attendance=row('attendance',body.id);version(attendance,body);
          check(needsReview(attendanceView(attendance)),400,'야근 검토 대상이 아닙니다.');
          const before=db.prepare('SELECT * FROM overtime WHERE attendance_id=?').get(body.id)||null;
          db.prepare('INSERT INTO overtime VALUES(?,?,?,?,?,?) ON CONFLICT(attendance_id) DO UPDATE SET status=excluded.status,actor_id=excluded.actor_id,decided_at=excluded.decided_at,reason=excluded.reason').run(randomUUID(),body.id,body.status,user.id,clock().toISOString(),reason);
          db.prepare('UPDATE attendance SET version=version+1 WHERE id=?').run(body.id);
          audit(db,user,'overtime_decision',body.id,reason,before,db.prepare('SELECT * FROM overtime WHERE attendance_id=?').get(body.id),clock());return {ok:true};}));
      }
      if(path==='/api/admin/delete-preview' && method==='POST') {
        return json(transaction(db,()=>{const impact=deletionData(body.id),raw=token();
          db.prepare('DELETE FROM deletion_confirmations WHERE expires<=?').run(clock().getTime());
          db.prepare('INSERT INTO deletion_confirmations VALUES(?,?,?,?,?)').run(digest(raw),body.id,user.id,impact.fingerprint,clock().getTime()+300000);
          return {counts:impact.counts,confirmationToken:raw,expires:clock().getTime()+300000};}));
      }
      if(path==='/api/admin/delete-employee' && method==='POST') {
        const reason=text(body.reason,500);check(body.confirm===true && typeof body.confirmationToken==='string',400,'삭제 영향 확인과 명시적 동의가 필요합니다.');
        return json(transaction(db,()=>{
          const ticket=db.prepare('SELECT * FROM deletion_confirmations WHERE hash=? AND employee_id=? AND actor_id=?').get(digest(body.confirmationToken),body.id,user.id);
          check(ticket && ticket.expires>clock().getTime(),409,'삭제 확인이 만료되었습니다. 다시 확인하세요.');
          const impact=deletionData(body.id);check(ticket.fingerprint===impact.fingerprint,409,'대상 기록이 변경되었습니다. 삭제 건수를 다시 확인하세요.');
          const person=row('employees',body.id);check(body.number===person.number,400,'확인 사번이 일치하지 않습니다.');
          audit(db,user,'employee_delete',body.id,reason,{counts:impact.counts},null,clock());
          db.prepare('DELETE FROM employees WHERE id=?').run(body.id);
          return {ok:true,deleted:impact.counts};
        }));
      }
      throw new HttpError(404,'API를 찾을 수 없습니다.');
    }
    if (path==='/admin' || path.startsWith('/admin/')) { check(user,401,'로그인이 필요합니다.');admin(user); }
    if(path==='/vendor/zxing.js' && method==='GET') return new Response(await readFile(new URL('../node_modules/@zxing/browser/umd/zxing-browser.min.js',import.meta.url)),{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
    const files={'/':['index.html','text/html'],'/admin':['index.html','text/html'],'/admin/qr':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/domain.js':['domain.js','text/javascript'],'/style.css':['style.css','text/css']};
    check(method==='GET' || method==='HEAD',405,'허용되지 않는 요청입니다.');
    const file=files[path];check(file,404,'페이지를 찾을 수 없습니다.');
    return new Response(method==='HEAD'?null:await readFile(new URL(`../public/${file[0]}`,import.meta.url)),{headers:{'Content-Type':file[1]+'; charset=utf-8'}});
  }
  function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});}
  return async request=>{
    let response;
    try {response=await route(request);}catch(error){
      if (!error.status) console.error('요청 처리 오류:',error.code||error.name); // no passwords, cookies or tokens
      response=json({error:error.status?error.message:'서버 오류가 발생했습니다.'},error.status||500);
    }
    response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(config.secure)response.headers.set('Strict-Transport-Security','max-age=31536000');
    return response;
  };
}
