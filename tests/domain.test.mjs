import test from 'node:test';
import assert from 'node:assert/strict';
import { koreaNow, overtime, needsReview, clockIn, clockOut, totals, validateQuantity, makeDemo, saveTask, recordProduction } from '../public/domain.js';
test('한국 날짜는 UTC와 구분된다', () => assert.deepEqual(koreaNow(new Date('2026-09-28T15:01:00Z')), { date: '2026-09-29', time: '00:01:00' }));
test('17:30 정각은 제외하고 그 이후 퇴근만 야근 검토한다', () => { assert.equal(overtime('17:30:00'), false); assert.equal(overtime('17:30:01'), true); assert.equal(overtime(null), false); });
test('중복 출퇴근을 막고 자정 이후 퇴근은 출근 날짜에 귀속한다', () => {
  const state = makeDemo('2026-09-28');
  state.attendance = [];
  assert.ok(clockOut(state, 'e1', { date: '2026-09-28', time: '08:00:00' }));
  assert.equal(clockIn(state, 'e1', { date: '2026-09-28', time: '08:30:00' }), '');
  assert.ok(clockIn(state, 'e1', { date: '2026-09-28', time: '08:31:00' }));
  assert.equal(clockOut(state, 'e1', { date: '2026-09-29', time: '01:00:00' }), '');
  assert.equal(state.attendance[0].date, '2026-09-28'); assert.equal(needsReview(state.attendance[0]), true);
  assert.ok(clockIn(state, 'e1', { date: '2026-09-28', time: '09:00:00' }));
  assert.ok(clockOut(state, 'e1', { date: '2026-09-29', time: '01:01:00' }));
});
test('수량의 빈칸, 음수, 소수, 과대 입력과 0 합계를 거부한다', () => { for (const value of ['', '-1', '1.2', 'NaN', '1000000', '1e2']) assert.ok(validateQuantity(value, '0')); assert.ok(validateQuantity('0', '0')); assert.equal(validateQuantity('10', '2'), ''); });
test('직원, 날짜, 작업 합계를 정확히 분리한다', () => {
  const state = makeDemo('2026-09-28');
  assert.deepEqual(totals(state.production, '2026-09-27', 'e1'), { good: 200, bad: 4 });
  assert.deepEqual(totals(state.production, '2026-09-28', 'e1'), { good: 0, bad: 0 });
  state.production.push({ date: '2026-09-28', employeeId: 'e1', good: 10, bad: 1 });
  assert.deepEqual(totals(state.production, '2026-09-28'), { good: 106, bad: 3 });
});
test('추가한 작업으로 생산 기록을 남기고 이름 변경 후에도 기록과 합계를 유지한다', () => {
  const state = makeDemo('2026-09-28');
  assert.equal(saveTask(state, '  최종   검수  '), '');
  const task = state.tasks.at(-1);
  assert.equal(task.name, '최종 검수');
  assert.equal(recordProduction(state, 'e1', { date: '2026-09-28', time: '10:00:00' }, task.id, '12', '2'), '');
  assert.equal(saveTask(state, '출하 검수', task.id), '');
  assert.equal(state.tasks.at(-1).id, task.id);
  assert.equal(state.production.at(-1).task, '최종 검수');
  assert.equal(recordProduction(state, 'e1', { date: '2026-09-28', time: '11:00:00' }, task.id, '8', '1'), '');
  assert.equal(state.production.at(-1).task, '출하 검수');
  assert.deepEqual(totals(state.production, '2026-09-28', 'e1'), { good: 20, bad: 3 });
  assert.equal(clockIn(state, 'e1', { date: '2026-09-28', time: '08:30:00' }), '');
  assert.equal(clockOut(state, 'e1', { date: '2026-09-28', time: '18:00:00' }), '');
  assert.equal(needsReview(state.attendance.at(-1)), true);
});
test('빈 이름, 중복 이름, 너무 긴 이름 및 없는 작업을 거부한다', () => {
  const state = makeDemo('2026-09-28');
  const before = structuredClone(state);
  for (const name of ['', '   ', '부품 조립', '가'.repeat(41)]) assert.ok(saveTask(state, name));
  assert.ok(saveTask(state, '포장', 't1'));
  assert.ok(saveTask(state, '새 이름', 'missing'));
  assert.ok(recordProduction(state, 'e1', { date: '2026-09-28' }, 'missing', '1', '0'));
  assert.ok(recordProduction(state, 'e1', { date: '2026-09-28' }, 't1', '-1', '0'));
  assert.deepEqual(state, before);
  assert.equal(saveTask(state, '부품 조립', 't1'), '');
});
test('작업 관리 상태는 새 체험 세션에 유출되지 않는다', () => {
  const first = makeDemo('2026-09-28');
  saveTask(first, '변경된 작업', 't1');
  saveTask(first, '추가 작업');
  const second = makeDemo('2026-09-28');
  assert.equal(second.tasks.length, 3);
  assert.equal(second.tasks[0].name, '부품 조립');
});
