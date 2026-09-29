import { totals, needsReview } from './domain.js';
import { mountWorkRequests } from './work-requests.js';

const screen = document.querySelector('#screen');
const account = document.querySelector('#account');
let me = null, state = null, selectedDate = '', epoch = 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const time = value => value ? esc(value.slice(0, 5)) : '—';
const notice = message => { document.querySelector('#notice').textContent = message; };
const values = form => Object.fromEntries(new FormData(form));

function clearSession(message = '') {
  epoch++;
  me = null; state = null; selectedDate = '';
  account.replaceChildren();
  history.replaceState(null, '', '/login');
  renderLogin();
  notice(message);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf || '', 'X-Onwork-Origin': location.origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') clearSession('로그인이 필요합니다.');
    if (response.status === 403 && me && path !== '/api/password' && path !== '/api/logout') {
      // A password reset can invalidate permissions while this page is open.
      const current = await fetch('/api/me', { cache: 'no-store' });
      if (current.status === 401) clearSession('다시 로그인해 주세요.');
      else if (current.ok) { me = await current.json(); if (me.mustChange) renderPassword(); }
    }
    const error = Error(data.error || '요청에 실패했습니다.');
    error.status = response.status;
    throw error;
  }
  return data;
}
function bindForm(selector, action) {
  const form = screen.querySelector(selector);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    const error = form.querySelector('[role="alert"]');
    error.textContent = '';
    try { await action(values(form), form); }
    catch (failure) { if (form.isConnected) error.textContent = failure.message; else notice(failure.message); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
function renderLogin() {
  screen.innerHTML = `<section class="card auth-card"><h1>로그인</h1><p class="muted">발급받은 계정으로 로그인하세요. 직원은 사번을 사용합니다.</p>
    <form id="login-form"><label>계정<input name="login" autocomplete="username" maxlength="30" required></label>
    <label>비밀번호<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
    <p role="alert" class="task-error"></p><button class="primary" type="submit">로그인</button></form></section>`;
  bindForm('#login-form', async body => { await api('/api/login', body); await load(); });
}
function renderSetup() {
  me = null; state = null;
  account.replaceChildren();
  history.replaceState(null, '', '/setup');
  screen.innerHTML = `<section class="card auth-card"><h1>최초 관리자 설정</h1><p>온워크를 관리할 첫 계정을 만드세요. 최초 한 번만 생성할 수 있으며, 직원 계정은 이후 관리자 화면에서 등록합니다.</p>
    <form id="setup-form"><label>관리자 계정<input name="login" autocomplete="username" pattern="[A-Za-z0-9-]{1,30}" maxlength="30" required></label>
    <label>비밀번호 (12~128자)<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>비밀번호 확인<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <p role="alert" class="task-error"></p><button class="primary" type="submit">관리자 계정 만들기</button></form></section>`;
  bindForm('#setup-form', async (body, form) => {
    if (body.password !== body.confirmation) throw Error('비밀번호 확인이 일치하지 않습니다.');
    try {
      await api('/api/setup', body);
      form.reset();
      clearSession('관리자 계정을 만들었습니다. 설정한 계정으로 로그인하세요.');
    } catch (error) {
      if (error.status !== 409) throw error;
      const setup = await api('/api/setup');
      if (setup.required) throw error;
      form.reset();
      clearSession('초기 설정이 이미 완료되었습니다. 관리자 계정으로 로그인하세요.');
    }
  });
}
function renderAccount() {
  account.innerHTML = `<span>${esc(me.login)} · ${me.role === 'admin' ? '관리자' : '직원'}</span><button class="secondary" id="refresh">새로고침</button><button class="secondary" id="logout">로그아웃</button>`;
  document.querySelector('#refresh').onclick = () => load().catch(error => notice(error.message));
  document.querySelector('#logout').onclick = async () => {
    try { await api('/api/logout', {}); clearSession('로그아웃했습니다.'); }
    catch (error) { notice(error.message); }
  };
}
function renderPassword() {
  state = null;
  renderAccount();
  screen.innerHTML = `<section class="card auth-card"><h1>임시 비밀번호 변경</h1><p>계속하려면 본인만 아는 12~128자의 새 비밀번호를 설정하세요.</p><form id="password-form">
    <label>현재 비밀번호<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    <label>새 비밀번호<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>새 비밀번호 확인<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <p role="alert" class="task-error"></p><button class="primary">비밀번호 변경</button></form></section>`;
  bindForm('#password-form', async body => {
    if (body.password !== body.confirmation) throw Error('새 비밀번호가 일치하지 않습니다.');
    await api('/api/password', { currentPassword: body.currentPassword, password: body.password });
    clearSession('비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.');
  });
}
async function load() {
  const requestEpoch = ++epoch;
  const setup = await api('/api/setup');
  if (requestEpoch !== epoch) return;
  if (location.origin !== setup.appOrigin) {
    me = null; state = null;
    account.replaceChildren();
    screen.innerHTML = `<section class="card auth-card"><h1>앱 접속 주소 확인</h1><p>현재 미리보기 주소가 서버에 설정된 주소와 다릅니다. 아래 주소를 별도 브라우저 탭에서 열어 주세요.</p><a href="${esc(setup.appOrigin)}/login" target="_blank" rel="noopener noreferrer">${esc(setup.appOrigin)}</a></section>`;
    return;
  }
  // Diagnose the real forwarded POST before asking for any credentials.
  try { await api('/api/origin-check', {}); }
  catch (error) {
    me = null; state = null; account.replaceChildren();
    screen.innerHTML = `<section class="card auth-card"><h1>접속 확인</h1><p role="alert">${esc(error.message)}</p><button class="primary" id="retry-origin">다시 확인</button></section>`;
    document.querySelector('#retry-origin').onclick = () => load().catch(failure => notice(failure.message));
    return;
  }
  if (requestEpoch !== epoch) return;
  if (setup.required) { renderSetup(); return; }
  const user = await api('/api/me');
  if (requestEpoch !== epoch) return;
  me = user;
  renderAccount();
  if (me.mustChange) { renderPassword(); return; }
  const snapshot = await api('/api/state');
  if (requestEpoch !== epoch) return;
  state = snapshot;
  selectedDate ||= state.today;
  history.replaceState(null, '', me.role === 'admin' ? '/admin' : '/employee');
  render();
}
function render() {
  if (!me || !state) return;
  if (me.role === 'admin') renderAdmin(); else renderEmployee();
  const requests = document.createElement('div');
  screen.append(requests);
  mountWorkRequests({root:requests,api,me,employees:state.employees,today:state.today});
}
async function save(path, body, message) {
  await api(path, body);
  await load();
  notice(message);
}
function stat(label, value) { return `<div class="stat"><span>${label}</span><strong>${value.toLocaleString('ko-KR')}</strong></div>`; }
function attendanceLabel(record) { return !record ? '미출근' : !record.out ? '근무 중' : needsReview(record) ? '야근 검토' : '퇴근 완료'; }
function renderEmployee() {
  const person = state.employees.find(item => item.id === me.employeeId);
  if (!person) { clearSession('직원 정보를 확인할 수 없습니다.'); return; }
  const today = state.attendance.find(item => item.date === state.today);
  const open = state.attendance.find(item => !item.out);
  const sum = totals(state.production, state.today);
  screen.innerHTML = `<div class="page-heading"><div><h1>내 출퇴근과 생산 기록</h1><p>${esc(person.name)} · ${esc(person.number)} · ${esc(person.team)} · ${esc(state.today)}</p></div></div>
    <div class="employee-grid"><section class="card"><h2>오늘 출퇴근</h2><p>${attendanceLabel(today)}</p><div class="clock-pair"><div><span>출근</span><strong>${time(today?.in)}</strong></div><div><span>퇴근</span><strong>${time(today?.out)}</strong></div></div>
    ${open && open.date !== state.today ? `<p>${esc(open.date)}의 미퇴근 기록이 있습니다.</p>` : ''}
    <form id="attendance-form"><div class="button-pair"><button class="primary" name="action" value="in" ${today || open ? 'disabled' : ''}>출근하기</button><button class="secondary" name="action" value="out" ${open ? '' : 'disabled'}>퇴근하기</button></div><p role="alert" class="task-error"></p></form><p class="small">로그인한 본인의 기록을 서버 시각으로 저장합니다.</p></section>
    <section class="card"><h2>작업 수량 기록</h2><div class="stats">${stat('오늘 양품', sum.good)}${stat('오늘 불량', sum.bad)}</div>
    <form id="production-form"><label>작업<select name="taskId" required>${state.tasks.map(task => `<option value="${esc(task.id)}">${esc(task.name)}</option>`).join('')}</select></label>
    <div class="quantity-grid"><label>양품 수량<input name="good" type="number" min="0" max="999999" value="0" required></label><label>불량 수량<input name="bad" type="number" min="0" max="999999" value="0" required></label></div>
    <p role="alert" class="task-error"></p><button class="primary" ${state.tasks.length ? '' : 'disabled'}>수량 기록하기</button></form></section></div>
    <section class="card"><h2>내 출퇴근 기록</h2>${state.attendance.slice().reverse().map(record => `<div class="history-row"><strong>${esc(record.date)}</strong><span>출근 ${time(record.in)} · 퇴근 ${record.outDate && record.outDate !== record.date ? esc(record.outDate) : ''} ${time(record.out)}</span><span>${attendanceLabel(record)}</span></div>`).join('') || '<p class="empty">기록이 없습니다.</p>'}</section>
    <section class="card"><h2>내 생산 기록</h2>${state.production.slice().reverse().map(record => `<div class="history-row"><div><strong>${esc(record.task)}</strong><p>${esc(record.date)} · ${time(record.time)}</p></div><span>양품 ${record.good} · 불량 ${record.bad}</span></div>`).join('') || '<p class="empty">기록이 없습니다.</p>'}</section>`;
  const form = document.querySelector('#attendance-form');
  form.onsubmit = async event => {
    event.preventDefault();
    const action = event.submitter.value;
    const buttons = [...form.querySelectorAll('button')];
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try { await save('/api/attendance', { action }, action === 'in' ? '출근을 기록했습니다.' : '퇴근을 기록했습니다.'); }
    catch (error) { if (form.isConnected) form.querySelector('[role="alert"]').textContent = error.message; }
    finally { buttons.forEach((button, i) => { button.disabled = disabled[i]; }); }
  };
  let requestKey = crypto.randomUUID();
  bindForm('#production-form', async body => {
    await api('/api/production', { ...body, requestKey });
    requestKey = crypto.randomUUID();
    await load(); notice('생산량을 저장했습니다.');
  });
}
function renderAdmin() {
  const records = state.attendance.filter(record => record.date === selectedDate);
  const sum = totals(state.production, selectedDate);
  screen.innerHTML = `<div class="page-heading"><div><h1>관리자 · 전체 현황</h1><p>직원 관리와 날짜별 집계</p></div><label>조회 날짜<input id="admin-date" type="date" value="${esc(selectedDate)}"></label></div>
    <div class="admin-stats card">${stat('출근 인원', records.length)}${stat('양품 합계', sum.good)}${stat('불량 합계', sum.bad)}${stat('야근 검토', records.filter(needsReview).length)}</div>
    <section class="card"><h2>직원별 출퇴근·생산량</h2><div class="table-wrap"><table><thead><tr><th>직원</th><th>출근</th><th>퇴근</th><th>양품</th><th>불량</th></tr></thead><tbody>${state.employees.map(person => {
      const record = records.find(item => item.employeeId === person.id), total = totals(state.production, selectedDate, person.id);
      return `<tr><td>${esc(person.name)}<span class="team">${esc(person.number)} · ${esc(person.team)}${person.active ? '' : ' · 퇴사'}</span></td><td>${time(record?.in)}</td><td>${record?.outDate && record.outDate !== record.date ? esc(record.outDate) : ''} ${time(record?.out)}</td><td>${total.good}</td><td>${total.bad}</td></tr>`;
    }).join('')}</tbody></table></div></section>
    <section class="card"><h2>직원 관리</h2><p>사번이 로그인 계정이 됩니다. 임시 비밀번호는 첫 로그인 후 변경해야 합니다.</p>
    <form id="add-employee-form" class="employee-form">${employeeFields()}<label>임시 비밀번호<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>${reasonField()}<button class="primary">직원 추가</button><p role="alert" class="task-error"></p></form>
    <div class="employee-list">${state.employees.map(person => `<form class="employee-form edit-employee-form" data-id="${esc(person.id)}"><div class="employee-status"><strong>${esc(person.name)} · ${person.active ? '재직' : '퇴사'}</strong></div>${employeeFields(person)}${reasonField()}<div class="employee-actions"><button class="secondary">정보 수정</button><button class="secondary toggle-employee" type="button">${person.active ? '퇴사 처리' : '다시 활성화'}</button></div><p role="alert" class="task-error"></p></form><form class="employee-form reset-password-form" data-id="${esc(person.id)}"><label>${esc(person.number)} 새 임시 비밀번호<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>임시 비밀번호 확인<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>${reasonField()}<button class="secondary">비밀번호 재설정</button><p class="small">이 직원의 모든 로그인 세션이 종료되며, 다음 로그인 시 비밀번호를 변경해야 합니다.</p><p role="alert" class="task-error"></p></form>`).join('')}</div></section>
    <section class="card"><h2>작업 종류 관리</h2><form id="add-task-form" class="task-form"><label>새 작업 이름<input name="name" maxlength="40" required></label>${reasonField()}<button class="primary">작업 추가</button><p role="alert" class="task-error"></p></form>
    ${state.tasks.map(task => `<form class="task-form edit-task-form" data-id="${esc(task.id)}"><label>작업 이름<input name="name" value="${esc(task.name)}" maxlength="40" required></label>${reasonField()}<button class="secondary">이름 수정</button><p role="alert" class="task-error"></p></form>`).join('')}</section>`;
  document.querySelector('#admin-date').onchange = event => { if (event.target.value) { selectedDate = event.target.value; render(); } };
  bindForm('#add-employee-form', body => save('/api/admin/employee', body, '직원 계정을 추가했습니다.'));
  document.querySelectorAll('.edit-employee-form').forEach((form, i) => {
    const person = state.employees[i];
    bindForm(`.edit-employee-form[data-id="${person.id}"]`, body => save('/api/admin/employee', { ...body, id: person.id, version: person.version }, '직원 정보를 수정했습니다.'));
    form.querySelector('.toggle-employee').onclick = async event => {
      if (!form.reportValidity()) return;
      event.target.disabled = true;
      try { await save('/api/admin/employee-status', { id: person.id, version: person.version, active: !person.active, reason: values(form).reason }, '재직 상태를 변경했습니다.'); }
      catch (error) { if (form.isConnected) form.querySelector('[role="alert"]').textContent = error.message; }
      finally { event.target.disabled = false; }
    };
  });
  state.employees.forEach(person => bindForm(`.reset-password-form[data-id="${person.id}"]`, async (body, form) => {
    if (body.password !== body.confirmation) throw Error('임시 비밀번호 확인이 일치하지 않습니다.');
    await api('/api/admin/reset-password', { id: person.id, password: body.password, reason: body.reason });
    form.reset();
    await load();
    notice('임시 비밀번호를 재설정했습니다. 직원에게 안전하게 전달하세요.');
  }));
  bindForm('#add-task-form', body => save('/api/admin/task', body, '작업을 추가했습니다.'));
  state.tasks.forEach(task => bindForm(`.edit-task-form[data-id="${task.id}"]`, body => save('/api/admin/task', { ...body, id: task.id, version: task.version }, '작업 이름을 수정했습니다.')));
}
function employeeFields(person = {}) {
  return `<label>이름<input name="name" value="${esc(person.name)}" maxlength="40" required></label><label>사번<input name="number" value="${esc(person.number)}" pattern="[A-Za-z0-9-]{1,30}" maxlength="30" required></label><label>소속 팀<input name="team" value="${esc(person.team)}" maxlength="40" required></label>`;
}
function reasonField() { return '<label>변경 사유<input name="reason" maxlength="500" required></label>'; }
window.addEventListener('pageshow', event => { if (event.persisted) { state = null; screen.replaceChildren(); load().catch(error => notice(error.message)); } });
load().catch(error => {
  if (!me) renderLogin();
  notice(error.message);
});
