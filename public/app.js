import { confirmEmployeeDeletion, activeEmployees, saveEmployee, setEmployeeActive, saveTask, recordProduction, koreaNow, totals, makeDemo, clockIn, clockOut, needsReview } from './domain.js';
let day = koreaNow().date;
const state = makeDemo(day);
let employeeId = 'e1', view = 'employee', selectedDate = day, historyView = 'production';
const screen = document.querySelector('#screen');
const shortTime = time => time ? time.slice(0, 5) : '—';
const prettyDate = date => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Seoul' }).format(new Date(`${date}T12:00:00+09:00`));
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = value => value.toLocaleString('ko-KR');
function notify(message) { document.querySelector('#notice').textContent = message; }
function badge(record) { return !record ? '<span class="badge neutral">미출근</span>' : !record.out ? '<span class="badge green">근무 중</span>' : needsReview(record) ? '<span class="badge amber">야근 검토</span>' : '<span class="badge neutral">퇴근 완료</span>'; }
function stat(label, value, unit, color = '') { return `<div class="stat ${color}"><span>${label}</span><strong>${num(value)}<small>${unit}</small></strong></div>`; }
function render() {
  document.querySelector('#employee-tab').setAttribute('aria-pressed', String(view === 'employee'));
  document.querySelector('#admin-tab').setAttribute('aria-pressed', String(view === 'admin'));
  if (view === 'employee') renderEmployee(); else renderAdmin();
}
function renderEmployee() {
  const available = activeEmployees(state);
  if (!available.some(e => e.id === employeeId)) employeeId = available[0]?.id ?? null;
  if (!employeeId) {
    screen.innerHTML = '<section class="card empty"><h1>활성 직원이 없습니다</h1><p>관리자 화면에서 직원을 추가하거나 다시 활성화해 주세요.</p></section>';
    return;
  }
  const person = available.find(e => e.id === employeeId);
  const record = state.attendance.find(r => r.date === day && r.employeeId === employeeId);
  const open = state.attendance.find(r => r.employeeId === employeeId && !r.out);
  const sum = totals(state.production, day, employeeId);
  screen.innerHTML = `<div class="page-heading"><div><p class="eyebrow">MY WORKDAY</p><h1>오늘도 안전한 하루</h1><p>${prettyDate(day)}</p></div><label class="person-select">체험 직원<select id="employee-select">${available.map(e => `<option value="${e.id}" ${e.id === employeeId ? 'selected' : ''}>${escapeHtml(e.name)} · ${escapeHtml(e.number)} · ${escapeHtml(e.team)}</option>`).join('')}</select></label></div>
  <div class="employee-grid"><section class="card attendance"><div class="section-heading"><h2>오늘 출퇴근</h2>${badge(record)}</div><p class="muted">${escapeHtml(person.name)} 님의 근무 기록</p><div class="clock-pair"><div><span>출근</span><strong>${shortTime(record?.in)}</strong></div><span class="clock-divider"></span><div><span>퇴근</span><strong>${shortTime(record?.out)}</strong></div></div>
  ${open && open.date !== day ? `<p class="inline-note">${open.date} 출근 기록이 진행 중입니다. 퇴근하면 해당 날짜에 반영됩니다.</p>` : ''}
  <div class="button-pair"><button class="primary" id="clock-in" ${record || open ? 'disabled' : ''}>출근하기</button><button class="secondary" id="clock-out" ${!open ? 'disabled' : ''}>퇴근하기</button></div><p class="small">17:30 이후 퇴근 시 야근 검토 대상으로 표시됩니다.</p>
  <div class="schedule"><h3>기본 근무 일정</h3><div><span>근무</span><b>08:30 — 17:30</b></div><div><span>점심</span><b>12:30 — 13:30</b></div><div><span>오전 휴게</span><b>10:30 — 10:40</b></div><div><span>오후 휴게</span><b>15:30 — 15:40</b></div></div></section>
  <section class="card production"><div class="section-heading"><h2>작업 수량 기록</h2><span class="small">오늘 기준</span></div><div class="stats">${stat('오늘 양품', sum.good, '개', 'green-text')}${stat('오늘 불량', sum.bad, '개')}</div><form id="production-form" novalidate><label>작업<select id="task" name="task">${state.tasks.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select></label><div class="quantity-grid"><label>양품 수량<input id="good" name="good" type="number" inputmode="numeric" min="0" max="999999" step="1" placeholder="0" required></label><label>불량 수량<input id="bad" name="bad" type="number" inputmode="numeric" min="0" max="999999" step="1" value="0" required></label></div><p class="small">이번 작업 수량을 입력하세요. 기록할 때마다 합산됩니다.</p><p id="form-error" role="alert"></p><button class="primary full" type="submit">수량 기록하기 <span aria-hidden="true">＋</span></button></form></section></div>
  <section class="card history"><div class="section-heading"><h2>내 기록</h2><span class="small">예시 기록 포함</span></div><div class="history-switch" role="group" aria-label="기록 종류"><button id="production-history" aria-pressed="${historyView === 'production'}">생산 기록</button><button id="attendance-history" aria-pressed="${historyView === 'attendance'}">출퇴근 기록</button></div>${renderHistory()}</section>`;
  document.querySelector('#employee-select').onchange = e => { employeeId = e.target.value; render(); };
  document.querySelector('#clock-in').onclick = () => { const now = koreaNow(); const error = clockIn(state, employeeId, now); day = now.date; render(); notify(error || `${shortTime(now.time)} 출근을 기록했습니다.`); };
  document.querySelector('#clock-out').onclick = () => { const now = koreaNow(); const error = clockOut(state, employeeId, now); day = now.date; render(); notify(error || `${shortTime(now.time)} 퇴근을 기록했습니다.`); };
  document.querySelector('#production-form').onsubmit = e => {
    e.preventDefault(); const form = new FormData(e.target); const now = koreaNow();
    const error = recordProduction(state, employeeId, now, form.get('task'), form.get('good'), form.get('bad'));
    if (error) { document.querySelector('#form-error').textContent = error; return; }
    day = now.date;
    render(); notify('작업 수량을 기록했습니다. 관리자 합계에도 반영되었습니다.');
  };
  document.querySelector('#production-history').onclick = () => { historyView = 'production'; render(); };
  document.querySelector('#attendance-history').onclick = () => { historyView = 'attendance'; render(); };
}
function renderHistory() {
  const rows = state[historyView === 'production' ? 'production' : 'attendance'].filter(r => r.employeeId === employeeId).slice().reverse();
  if (!rows.length) return '<div class="empty">아직 기록이 없습니다. 오늘의 첫 기록을 남겨 보세요.</div>';
  return `<div class="history-list">${rows.map(r => historyView === 'production' ? `<div class="history-row"><div><strong>${escapeHtml(r.task)}</strong><p>${r.date} · ${shortTime(r.time)}</p></div><div class="record-quantities"><span>양품 <b>${num(r.good)}</b></span><span class="muted">불량 <b>${num(r.bad)}</b></span></div></div>` : `<div class="history-row"><div><strong>${r.date}</strong><p>출근 ${shortTime(r.in)} · 퇴근 ${r.outDate && r.outDate !== r.date ? r.outDate + ' ' : ''}${shortTime(r.out)}</p></div>${badge(r)}</div>`).join('')}</div>`;
}
function renderAdmin() {
  const records = state.attendance.filter(r => r.date === selectedDate);
  const sum = totals(state.production, selectedDate);
  screen.innerHTML = `<div class="page-heading"><div><p class="eyebrow">TEAM OVERVIEW</p><h1>우리 팀 현황</h1><p>날짜별 출근과 생산량을 한눈에 확인하세요.</p></div><label class="person-select">조회 날짜<input id="admin-date" type="date" value="${selectedDate}"></label></div><div class="admin-stats card">${stat('출근 인원', records.length, `/ ${state.employees.length}명`, 'green-text')}${stat('양품 합계', sum.good, '개')}${stat('불량 합계', sum.bad, '개')}${stat('야근 검토', records.filter(needsReview).length, '명', 'amber-text')}</div>
  <section class="card"><div class="section-heading"><h2>직원별 출근 현황</h2><span class="small">${selectedDate}</span></div><div class="table-wrap"><table><caption class="sr-only">선택 날짜의 직원별 출퇴근 현황</caption><thead><tr><th>직원</th><th>출근</th><th>퇴근</th><th>상태</th></tr></thead><tbody>${state.employees.map(e => { const r = records.find(r => r.employeeId === e.id); return `<tr><td><strong>${escapeHtml(e.name)}</strong><span class="team">${escapeHtml(e.number)}${e.active ? '' : ' · 퇴사'}</span><span class="team">${escapeHtml(e.team)}</span></td><td>${shortTime(r?.in)}</td><td>${r?.outDate && r.outDate !== r.date ? `<span class="team">${r.outDate}</span>` : ''}${shortTime(r?.out)}</td><td>${badge(r)}</td></tr>`; }).join('')}</tbody></table></div></section>
  <section class="card"><div class="section-heading"><h2>직원별 생산량 합계</h2><span class="small">비활성 직원 포함 · 개</span></div><div class="table-wrap"><table><caption class="sr-only">선택 날짜의 직원별 생산량</caption><thead><tr><th>직원</th><th class="numeric">양품</th><th class="numeric">불량</th><th class="numeric">전체</th></tr></thead><tbody>${state.employees.map(e => { const s = totals(state.production, selectedDate, e.id); return `<tr><td><strong>${escapeHtml(e.name)}</strong><span class="team">${escapeHtml(e.number)}${e.active ? '' : ' · 퇴사'}</span></td><td class="numeric green-text">${num(s.good)}</td><td class="numeric">${num(s.bad)}</td><td class="numeric"><strong>${num(s.good + s.bad)}</strong></td></tr>`; }).join('')}</tbody><tfoot><tr><th>합계</th><td class="numeric">${num(sum.good)}</td><td class="numeric">${num(sum.bad)}</td><td class="numeric">${num(sum.good + sum.bad)}</td></tr></tfoot></table></div>${!sum.good && !sum.bad ? '<p class="empty">이 날짜에 등록된 생산 기록이 없습니다.</p>' : ''}</section>`;
  screen.insertAdjacentHTML('beforeend', `<section class="card" aria-labelledby="task-heading"><div class="section-heading"><h2 id="task-heading">작업 종류 관리</h2><span class="small">${state.tasks.length}개 등록</span></div><p class="small">추가·수정한 이름은 직원 화면의 작업 목록에 바로 반영됩니다. 기존 생산 기록은 기록 당시 이름을 유지합니다.</p>
  <form id="add-task-form" class="task-form" novalidate><label for="new-task-name">새 작업 이름<input id="new-task-name" name="name" maxlength="40" placeholder="예: 최종 검수" aria-describedby="add-task-error" required></label><button class="primary" type="submit">작업 추가</button><p id="add-task-error" class="task-error" role="alert"></p></form>
  <div class="task-list">${state.tasks.map(t => `<form class="task-form edit-task-form" data-task-id="${t.id}" novalidate><label for="name-${t.id}">작업 이름<input id="name-${t.id}" name="name" value="${escapeHtml(t.name)}" maxlength="40" aria-describedby="error-${t.id}" required></label><button class="secondary" type="submit">이름 수정</button><p id="error-${t.id}" class="task-error" role="alert"></p></form>`).join('')}</div><p class="small">시제품: 작업 목록도 새로고침하면 초기화됩니다.</p></section>`);
  document.querySelector('#add-task-form').onsubmit = e => {
    e.preventDefault();
    const error = saveTask(state, new FormData(e.target).get('name'));
    document.querySelector('#add-task-error').textContent = error;
    if (error) return;
    render(); document.querySelector('#new-task-name').focus(); notify('작업을 추가했습니다. 직원 화면에서 선택할 수 있습니다.');
  };
  document.querySelectorAll('.edit-task-form').forEach(form => { form.onsubmit = e => {
    e.preventDefault();
    const id = form.dataset.taskId;
    const error = saveTask(state, new FormData(form).get('name'), id);
    document.querySelector(`#error-${id}`).textContent = error;
    if (error) return;
    render(); document.querySelector(`#name-${id}`).focus(); notify('작업 이름을 수정했습니다. 기존 생산 기록은 유지됩니다.');
  }; });
  renderEmployeeManagement();
  document.querySelector('#admin-date').onchange = e => { if (e.target.value) { selectedDate = e.target.value; render(); } };
}
document.querySelector('#employee-tab').onclick = () => { view = 'employee'; render(); };
document.querySelector('#admin-tab').onclick = () => { view = 'admin'; render(); };
setInterval(() => { const next = koreaNow().date; if (next !== day) { day = next; render(); notify('날짜가 바뀌어 오늘 화면을 갱신했습니다.'); } }, 10000);
render();

function renderEmployeeManagement() {
  const fields = (e = {}) => `<label>이름<input name="name" maxlength="40" value="${escapeHtml(e.name || '')}" required></label><label>사번<input name="number" maxlength="30" value="${escapeHtml(e.number || '')}" placeholder="예: EMP004" required></label><label>소속 팀<input name="team" maxlength="40" value="${escapeHtml(e.team || '')}" required></label>`;
  screen.insertAdjacentHTML('beforeend', `<section class="card" aria-labelledby="employee-heading"><div class="section-heading"><h2 id="employee-heading">직원 관리</h2><span class="small">활성 ${activeEmployees(state).length}명 / 전체 ${state.employees.length}명</span></div><p class="small">퇴사 직원의 과거 기록은 관리자 조회와 합계에 유지됩니다. 이름·사번·팀을 수정해도 같은 직원의 기록으로 연결됩니다.</p><form id="add-employee-form" class="employee-form" novalidate>${fields()}<button class="primary" type="submit">직원 추가</button><p class="task-error" role="alert"></p></form><div class="employee-list">${state.employees.map(e => `<form class="employee-form edit-employee-form" data-employee-id="${e.id}" novalidate><div class="employee-status"><strong>${escapeHtml(e.name)}</strong> <span class="badge ${e.active ? 'green' : 'neutral'}">${e.active ? '재직' : '퇴사'}</span>${state.attendance.some(r => r.employeeId === e.id && !r.out) ? '<p class="small">미퇴근 기록이 있습니다. 퇴사 처리해도 기록은 유지되며, 퇴근 입력은 다시 활성화한 뒤 가능합니다.</p>' : ''}</div>${fields(e)}<div class="employee-actions"><button class="secondary" type="submit">정보 수정</button><button class="secondary toggle-employee" type="button" data-employee-id="${e.id}">${e.active ? '퇴사 처리' : '다시 활성화'}</button><button class="danger delete-employee" type="button" data-employee-id="${e.id}">완전 삭제 (시제품)</button></div><p class="task-error" role="alert"></p></form>`).join('')}</div><p class="small">시제품: 실제 로그인과 영구 저장이 없습니다. 완전 삭제는 현재 페이지의 메모리 데이터에만 적용되며, 운영용 영구 삭제가 아닙니다. 새로고침하면 예시 데이터로 초기화됩니다.</p></section>`);
  const bindSave = (form, id = null) => { form.onsubmit = event => {
    event.preventDefault();
    const error = saveEmployee(state, Object.fromEntries(new FormData(form)), id);
    form.querySelector('.task-error').textContent = error;
    if (error) return;
    render(); notify(id ? '직원 정보를 수정했습니다. 기존 기록은 유지됩니다.' : '직원을 추가했습니다. 체험 직원 목록에서 선택하세요.');
  }; };
  bindSave(document.querySelector('#add-employee-form'));
  document.querySelectorAll('.edit-employee-form').forEach(form => bindSave(form, form.dataset.employeeId));
  document.querySelectorAll('.delete-employee').forEach(button => { button.onclick = () => {
    const result = confirmEmployeeDeletion(state, button.dataset.employeeId, message => window.confirm(message));
    if (result === 'deleted') {
      render(); notify('시제품에서 해당 직원과 기록을 삭제하고 집계를 갱신했습니다.');
    } else notify(result === 'cancelled' ? '삭제를 취소했습니다. 기록은 변경되지 않았습니다.' : '삭제할 직원을 찾을 수 없습니다.');
  }; });
  document.querySelectorAll('.toggle-employee').forEach(button => { button.onclick = () => {
    const employee = state.employees.find(e => e.id === button.dataset.employeeId);
    const next = !employee.active;
    setEmployeeActive(state, employee.id, next);
    render(); notify(next ? '직원을 다시 활성화했습니다.' : '퇴사 처리했습니다. 과거 기록과 집계는 유지됩니다.');
  }; });
}
