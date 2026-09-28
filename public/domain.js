const defaultEmployees = [{ id: 'e1', name: '김민수', team: '생산 1팀' }, { id: 'e2', name: '이서연', team: '생산 1팀' }, { id: 'e3', name: '박준호', team: '생산 2팀' }];
export function activeEmployees(state) { return state.employees.filter(e => e.active); }
export function saveEmployee(state, values, id = null) {
  const name = String(values.name ?? '').trim();
  const number = String(values.number ?? '').trim().toUpperCase();
  const team = String(values.team ?? '').trim();
  if (!name || name.length > 40 || !team || team.length > 40) return '이름과 소속 팀을 각각 1~40자로 입력해 주세요.';
  if (!/^[A-Z0-9-]{1,30}$/.test(number)) return '사번은 영문, 숫자, 하이픈으로 1~30자 입력해 주세요.';
  if (state.employees.some(e => e.id !== id && e.number === number)) return '이미 등록된 사번입니다. 비활성 직원의 사번도 사용할 수 없습니다.';
  if (id !== null) {
    const employee = state.employees.find(e => e.id === id);
    if (!employee) return '직원을 찾을 수 없습니다.';
    Object.assign(employee, { name, number, team });
  } else state.employees.push({ id: `e${state.nextEmployeeId++}`, name, number, team, active: true });
  return '';
}
export function setEmployeeActive(state, id, active) {
  const employee = state.employees.find(e => e.id === id);
  if (!employee) return '직원을 찾을 수 없습니다.';
  employee.active = Boolean(active);
  return '';
}
export function employeeDeletionImpact(state, id) {
  if (!state.employees.some(e => e.id === id)) return null;
  const attendance = state.attendance.filter(r => r.employeeId === id);
  return {
    attendance: attendance.length,
    production: state.production.filter(r => r.employeeId === id).length,
    overtime: attendance.filter(needsReview).length
  };
}
// Confirmation is synchronous: the displayed counts and deletion use the same state.
// Overtime is derived from attendance, not a separate stored record collection.
export function confirmEmployeeDeletion(state, id, confirm) {
  const employee = state.employees.find(e => e.id === id);
  const impact = employeeDeletionImpact(state, id);
  if (!employee || !impact) return 'missing';
  const message = `시제품 데이터 완전 삭제\n\n${employee.name} · 사번 ${employee.number} · 직원 ID ${employee.id}\n\n전체 날짜 기준\n직원 정보: 1건\n출퇴근 기록: ${impact.attendance}건\n생산량 기록: ${impact.production}건\n야근 검토 기록: ${impact.overtime}건 (출퇴근 기록에 포함)\n\n해당 직원의 위 기록을 모두 삭제하고 관리자 집계를 다시 계산합니다. 다른 직원 기록은 유지됩니다.\n현재 열린 페이지의 메모리 데이터만 삭제합니다. 운영용 영구 삭제가 아니며 새로고침하면 예시 데이터로 초기화됩니다.\n\n삭제할까요?`;
  if (confirm(message) !== true) return 'cancelled';
  state.attendance = state.attendance.filter(r => r.employeeId !== id);
  state.production = state.production.filter(r => r.employeeId !== id);
  state.employees = state.employees.filter(e => e.id !== id);
  return 'deleted';
}
function employeeError(state, id) {
  return state.employees.some(e => e.id === id && e.active) ? '' : '활성 직원을 선택해 주세요.';
}
const defaultTasks = ['부품 조립', '제품 검사', '포장'];
export function saveTask(state, rawName, id = null) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) return '작업 이름을 1~40자로 입력해 주세요.';
  if (state.tasks.some(t => t.id !== id && t.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return '이미 등록된 작업 이름입니다.';
  if (id !== null) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return '수정할 작업을 찾을 수 없습니다.';
    task.name = name;
  } else {
    state.tasks.push({ id: `t${state.nextTaskId++}`, name });
  }
  return '';
}
export function recordProduction(state, employeeId, now, taskId, good, bad) {
  const invalidEmployee = employeeError(state, employeeId);
  if (invalidEmployee) return invalidEmployee;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return '등록된 작업을 선택해 주세요.';
  const error = validateQuantity(good, bad);
  if (error) return error;
  state.production.push({ employeeId, ...now, taskId, task: task.name, good: Number(good), bad: Number(bad) });
  return '';
}
export function koreaNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}
export function overtime(time) { return Boolean(time && time > '17:30:00'); }
export function validateQuantity(good, bad) {
  if (![good, bad].every(v => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) <= 999999)) return '수량은 0~999,999 사이의 정수로 입력해 주세요.';
  if (Number(good) + Number(bad) === 0) return '양품 또는 불량 수량을 1개 이상 입력해 주세요.';
  return '';
}
export function totals(records, date, employeeId) {
  return records.filter(r => r.date === date && (!employeeId || r.employeeId === employeeId)).reduce((sum, r) => ({ good: sum.good + r.good, bad: sum.bad + r.bad }), { good: 0, bad: 0 });
}
export function clockIn(state, employeeId, now) {
  const invalidEmployee = employeeError(state, employeeId);
  if (invalidEmployee) return invalidEmployee;
  if (state.attendance.some(r => r.employeeId === employeeId && !r.out)) return '이전 출근의 퇴근 기록을 먼저 완료해 주세요.';
  if (state.attendance.some(r => r.employeeId === employeeId && r.date === now.date)) return '오늘 출퇴근 기록이 이미 있습니다.';
  state.attendance.push({ employeeId, date: now.date, in: now.time, out: null, outDate: null });
  return '';
}
export function clockOut(state, employeeId, now) {
  const invalidEmployee = employeeError(state, employeeId);
  if (invalidEmployee) return invalidEmployee;
  const record = state.attendance.find(r => r.employeeId === employeeId && !r.out);
  if (!record) return '먼저 출근을 기록해 주세요.';
  record.out = now.time; record.outDate = now.date;
  return '';
}
export function needsReview(record) { return Boolean(record.out && (record.outDate > record.date || overtime(record.out))); }
export function makeDemo(today) {
  const prior = new Date(`${today}T00:00:00Z`); prior.setUTCDate(prior.getUTCDate() - 1);
  const yesterday = prior.toISOString().slice(0, 10);
  return {
    employees: defaultEmployees.map((e, i) => ({ ...e, number: `EMP00${i + 1}`, active: true })),
    nextEmployeeId: 4,
    tasks: defaultTasks.map((name, i) => ({ id: `t${i + 1}`, name })),
    nextTaskId: 4,
    attendance: [
      { employeeId: 'e1', date: yesterday, in: '08:25:00', out: '18:10:00', outDate: yesterday },
      { employeeId: 'e2', date: yesterday, in: '08:28:00', out: '17:30:00', outDate: yesterday },
      { employeeId: 'e2', date: today, in: '08:28:00', out: null, outDate: null }
    ],
    production: [
      { employeeId: 'e1', date: yesterday, time: '16:50:00', taskId: 't1', task: '부품 조립', good: 120, bad: 3 },
      { employeeId: 'e1', date: yesterday, time: '17:05:00', taskId: 't3', task: '포장', good: 80, bad: 1 },
      { employeeId: 'e2', date: today, time: '09:30:00', taskId: 't2', task: '제품 검사', good: 96, bad: 2 }
    ]
  };
}
