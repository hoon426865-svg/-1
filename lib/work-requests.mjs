import { randomUUID } from 'node:crypto';

export const requestTypes = ['overtime', 'annual', 'monthly', 'early', 'absence'];
const statuses = ['pending', 'approved', 'rejected'];
const check = (ok, status, message) => { if (!ok) throw Object.assign(new Error(message), { status }); };
const required = value => {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 500, 400, '사유·의견은 1~500자로 입력하세요.');
  return value.trim();
};
export function installWorkRequests(db) {
  // Additive migration: existing tables, accounts and records are retained.
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS work_requests (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK(type IN('overtime','annual','monthly','early','absence')),
      start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date>=start_date),
      start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
      end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 1 AND 1440 AND end_minute>start_minute),
      all_day INTEGER NOT NULL CHECK(all_day IN(0,1)), reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('pending','approved','rejected')),
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      actor_id TEXT, actor_login TEXT, decided_at TEXT, comment TEXT
    );
    CREATE INDEX IF NOT EXISTS work_requests_employee_dates ON work_requests(employee_id,start_date,end_date);
    CREATE TABLE IF NOT EXISTS work_request_history (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES work_requests(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL,
      occurred_at TEXT NOT NULL, comment TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      UNIQUE(request_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS work_requests_no_delete BEFORE DELETE ON work_requests BEGIN SELECT RAISE(ABORT,'work requests must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS work_history_no_update BEFORE UPDATE ON work_request_history BEGIN SELECT RAISE(ABORT,'work request history is append only'); END;
    CREATE TRIGGER IF NOT EXISTS work_history_no_delete BEFORE DELETE ON work_request_history BEGIN SELECT RAISE(ABORT,'work request history is append only'); END;
    COMMIT;`);
}
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9999-12-31', 400, '날짜를 정확히 입력하세요.');
  const parsed = new Date(value + 'T00:00:00Z');
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value, 400, '유효하지 않은 날짜입니다.');
  return value;
}
const dayNumber = value => Date.parse(value + 'T00:00:00Z') / 86400000;
function minute(value, end = false) {
  if (end && value === '24:00') return 1440;
  check(typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value),400,'시각은 HH:MM 형식으로 입력하세요.');
  return Number(value.slice(0,2))*60 + Number(value.slice(3));
}
function input(body) {
  check(requestTypes.includes(body.type),400,'신청 유형을 선택하세요.');
  const start = date(body.startDate), end = date(body.endDate);
  check(end >= start && dayNumber(end)-dayNumber(start) < 366,400,'신청 기간은 순서대로 최대 366일입니다.');
  check(typeof body.allDay === 'boolean',400,'종일 여부를 선택하세요.');
  check(!body.allDay || !['overtime','early'].includes(body.type),400,'추가 근무·조퇴는 필요한 시간을 입력하세요.');
  const from = body.allDay ? 0 : minute(body.startTime), to = body.allDay ? 1440 : minute(body.endTime,true);
  check(to > from,400,'종료 시각은 시작 이후여야 합니다. 자정을 넘으면 날짜별로 나누어 신청하세요.');
  return { type:body.type, start_date:start, end_date:end, start_minute:from, end_minute:to, all_day:Number(body.allDay), reason:required(body.reason) };
}
function overlap(db, employeeId, value, id = '') {
  check(!db.prepare(`SELECT 1 FROM work_requests WHERE employee_id=? AND id!=? AND status IN('pending','approved')
    AND start_date<=? AND end_date>=? AND start_minute<? AND end_minute>?`).get(employeeId,id,value.end_date,value.start_date,value.end_minute,value.start_minute),409,'같은 시간에 대기 또는 승인된 신청이 있습니다. 기존 신청을 확인하세요.');
}
function row(db, id, user) {
  check(typeof id === 'string',400,'신청 ID가 필요합니다.');
  const item = db.prepare('SELECT * FROM work_requests WHERE id=?').get(id);
  check(item && (user.role === 'admin' || item.employee_id === user.employee_id),404,'신청을 찾을 수 없습니다.');
  return item;
}
function history(db, item, action, user, comment, now) {
  db.prepare('INSERT INTO work_request_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),item.id,item.version,action,user.id,user.login,now,comment,JSON.stringify(item));
}
function atomic(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
export function saveRequest(db, user, body, clock) {
  check(user.role === 'employee',403,'직원 계정으로 신청하세요.');
  const value = input(body);
  return atomic(db, () => {
    const previous = body.id ? row(db,body.id,user) : null;
    if (previous) {
      check(previous.version === body.version,409,'다른 변경이 있습니다. 새로고침 후 다시 확인하세요.');
      check(previous.status !== 'approved',409,'승인된 신청은 관리자에게 재검토를 요청하세요.');
    }
    const changeReason = previous ? required(body.changeReason) : value.reason;
    overlap(db,user.employee_id,value,previous?.id);
    const id = previous?.id || randomUUID(), now = clock().toISOString();
    if (previous) db.prepare(`UPDATE work_requests SET type=?,start_date=?,end_date=?,start_minute=?,end_minute=?,all_day=?,reason=?,status='pending',version=version+1,updated_at=?,actor_id=NULL,actor_login=NULL,decided_at=NULL,comment=NULL WHERE id=?`).run(...Object.values(value),now,id);
    else db.prepare(`INSERT INTO work_requests(id,employee_id,type,start_date,end_date,start_minute,end_minute,all_day,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id,user.employee_id,...Object.values(value),now,now);
    const item = row(db,id,user);
    history(db,item,previous?'revised':'created',user,changeReason,now);
    return item;
  });
}
export function decideRequest(db, user, body, clock) {
  check(user.role === 'admin',403,'관리자 권한이 필요합니다.');
  check(['approved','rejected','reopen'].includes(body.action),400,'처리 방법을 선택하세요.');
  const comment = required(body.comment);
  return atomic(db, () => {
    const previous = row(db,body.id,user);
    check(previous.version === body.version,409,'다른 변경이 있습니다. 새로고침 후 다시 확인하세요.');
    check(body.action === 'reopen' ? previous.status !== 'pending' : previous.status === 'pending',409,'이미 처리되었거나 재검토 중인 신청입니다.');
    const status = body.action === 'reopen' ? 'pending' : body.action;
    if (status !== 'rejected') overlap(db,previous.employee_id,previous,previous.id);
    const now = clock().toISOString();
    db.prepare('UPDATE work_requests SET status=?,version=version+1,updated_at=?,actor_id=?,actor_login=?,decided_at=?,comment=? WHERE id=?').run(status,now,user.id,user.login,now,comment,previous.id);
    const item = row(db,previous.id,user);
    history(db,item,body.action,user,comment,now);
    return item;
  });
}
export function listRequests(db, user, params) {
  const conditions = [], args = [];
  const add = (sql, value) => { conditions.push(sql); args.push(value); };
  if (user.role === 'employee') add('r.employee_id=?',user.employee_id);
  else if (params.get('employeeId')) add('r.employee_id=?',params.get('employeeId'));
  if (params.get('from')) add('r.end_date>=?',date(params.get('from')));
  if (params.get('to')) add('r.start_date<=?',date(params.get('to')));
  check(!params.get('from') || !params.get('to') || params.get('from') <= params.get('to'),400,'조회 기간 순서를 확인하세요.');
  for (const [key, allowed] of [['type',requestTypes],['status',statuses]]) if(params.get(key)) {
    check(allowed.includes(params.get(key)),400,'조회 조건이 올바르지 않습니다.'); add(`r.${key}=?`,params.get(key));
  }
  return db.prepare(`SELECT r.*,e.name AS employee_name,e.number AS employee_number FROM work_requests r JOIN employees e ON e.id=r.employee_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY r.start_date DESC,r.created_at DESC,r.id`).all(...args);
}
export function requestHistory(db,user,id) {
  row(db,id,user);
  return db.prepare('SELECT * FROM work_request_history WHERE request_id=? ORDER BY version').all(id).map(item => ({...item,snapshot:JSON.parse(item.snapshot_json),snapshot_json:undefined}));
}
export function requestReport(db,user,params) {
  check(user.role === 'admin',403,'관리자 권한이 필요합니다.');
  const year = params.get('year'), month = params.get('month');
  check(/^\d{4}$/.test(year || '') && Number(year)>=1900 && Number(year)<=9998,400,'조회 연도를 확인하세요.');
  check(!month || /^(0[1-9]|1[0-2])$/.test(month),400,'조회 월을 확인하세요.');
  const from = month ? `${year}-${month}-01` : `${year}-01-01`;
  const to = month ? new Date(Date.UTC(Number(year),Number(month),0)).toISOString().slice(0,10) : `${year}-12-31`;
  const filters = new URLSearchParams({from,to});
  if(params.get('employeeId')) filters.set('employeeId',params.get('employeeId'));
  const requests = listRequests(db,user,filters);
  const employees = params.get('employeeId') ? db.prepare('SELECT id,name,number FROM employees WHERE id=?').all(params.get('employeeId')) : db.prepare('SELECT id,name,number FROM employees ORDER BY number').all();
  const summaries = employees.map(person => {
    const own = requests.filter(r=>r.employee_id===person.id), absenceDates = new Set();
    let overtimeMinutes=0, absenceMinutes=0;
    for (const r of own.filter(r=>r.status==='approved')) {
      const first = Math.max(dayNumber(from),dayNumber(r.start_date)), last = Math.min(dayNumber(to),dayNumber(r.end_date));
      if(r.type==='overtime') overtimeMinutes+=(last-first+1)*(r.end_minute-r.start_minute);
      else for(let day=first;day<=last;day++) { absenceDates.add(day);absenceMinutes+=r.end_minute-r.start_minute; }
    }
    const attendance = db.prepare('SELECT id,date,in_at,out_at FROM attendance WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date').all(person.id,from,to);
    const production = db.prepare('SELECT id,date,task_name,good,bad FROM production WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date').all(person.id,from,to);
    return {...person,requests:own.length,pending:own.filter(r=>r.status==='pending').length,approved:own.filter(r=>r.status==='approved').length,rejected:own.filter(r=>r.status==='rejected').length,overtimeMinutes,absenceDates:absenceDates.size,absenceMinutes,attendance,production};
  });
  return {from,to,summaries,requests};
}
