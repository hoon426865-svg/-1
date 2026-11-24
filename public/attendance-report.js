// Read-only attendance calculations shared by Node and the Workers browser.
// Source punches and request/decision history are never rewritten by a report.
export const attendancePolicy = Object.freeze({
  version: 'attendance-0830-v1', introducedOn: '2026-11-03', timeZone: 'Asia/Seoul',
  startMinute: 510, endMinute: 1050,
  breaks: [[630, 640], [750, 810], [930, 940]],
});
const DAY = 86400000, MINUTE = 60000;
const midnight = date => Date.parse(`${date}T00:00:00+09:00`);
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
export const nextDate = (date, days = 1) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const overlapsPeriod = (r, from, to) => r.start_date <= to && r.end_date >= from;

// UI clock is an explicitly labelled calculation start, not a replacement punch.
export function attendanceStartTime(record) {
  if (!record?.in) return null;
  return record.in < '08:30:00' ? '08:30:00' : record.in;
}

function union(ranges) {
  const result = [];
  for (const [start, end] of ranges.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
function intersect(left, right) {
  return union(left.flatMap(([a, b]) => right.map(([c, d]) => [Math.max(a, c), Math.min(b, d)])));
}
const seconds = ranges => ranges.reduce((sum, [a, b]) => sum + (b - a) / 1000, 0);
function withoutBreaks(start, end, date) {
  if (end <= start) return [];
  let intervals = [[start, end]];
  for (let day = midnight(date); day < end; day += DAY) {
    for (const [from, to] of attendancePolicy.breaks) {
      const a = day + from * MINUTE, b = day + to * MINUTE;
      intervals = intervals.flatMap(([x, y]) => b <= x || a >= y ? [[x, y]] : [[x, Math.min(y, a)], [Math.max(x, b), y]].filter(([s, e]) => e > s));
    }
  }
  return intervals;
}
function requestWindows(requests, date, end) {
  const windows = [];
  for (let day = midnight(date); day < end; day += DAY) {
    const localDate = new Date(day + 9 * 60 * MINUTE).toISOString().slice(0, 10);
    for (const r of requests) if (r.start_date <= localDate && r.end_date >= localDate) {
      windows.push([day + r.start_minute * MINUTE, day + r.end_minute * MINUTE]);
    }
  }
  return union(windows);
}

export function attendanceDay(record, requests = [], decisions = []) {
  const start = Date.parse(record.in_at), end = record.out_at ? Date.parse(record.out_at) : NaN;
  const scheduledStart = midnight(record.date) + attendancePolicy.startMinute * MINUTE;
  const scheduledEnd = midnight(record.date) + attendancePolicy.endMinute * MINUTE;
  const effectiveStart = Math.max(start, scheduledStart);
  const relevant = requests.filter(r => r.employee_id === record.employee_id);
  const approvals = relevant.filter(r => r.type === 'overtime' && r.status === 'approved');
  const row = {
    id: record.id, employeeId: record.employee_id, date: record.date,
    inAt: record.in_at, outAt: record.out_at, version: record.version || 1,
    calculationStartAt: iso(effectiveStart), lateSeconds: Math.max(0, (start - scheduledStart) / 1000),
    breakSeconds: null, regularSeconds: null, additionalSeconds: null,
    approvedAdditionalSeconds: null, reviewAdditionalSeconds: null,
    earlyArrivalSeconds: null, approvedEarlySeconds: null, earlyReviewSeconds: null,
    totalSeconds: null, earlyLeaveSeconds: null, recordedWorkSeconds: null,
    status: 'complete', notes: [], requests: [],
  };
  if (!Number.isFinite(start) || !Number.isFinite(scheduledStart) ||
      new Date(start + 9 * 60 * MINUTE).toISOString().slice(0, 10) !== record.date) {
    row.status = 'invalid'; row.notes.push('출근 날짜·시각 확인 필요'); return row;
  }
  if (!record.out_at) { row.status = 'open'; row.notes.push('퇴근 기록 없음 · 시간 합계 제외'); return row; }
  // Long forgotten punches are not silently treated as days of continuous work.
  if (!Number.isFinite(end) || end < start || end - start > 2 * DAY) {
    row.status = 'invalid'; row.notes.push('출퇴근 구간 확인 필요 · 시간 합계 제외'); return row;
  }
  const work = withoutBreaks(start, end, record.date);
  const regular = intersect(work, [[scheduledStart, scheduledEnd]]);
  const early = intersect(work, [[start, scheduledStart]]);
  const after = intersect(work, [[scheduledEnd, end]]);
  const approved = requestWindows(approvals, record.date, end);
  // Legacy attendance-specific approvals cover only the recorded time after 17:30.
  const legacy = decisions.find(d => d.attendance_id === record.id);
  if (legacy?.status === 'approved') approved.push([scheduledEnd, end]);
  const approvedEarly = seconds(intersect(early, approved));
  const approvedAfter = seconds(intersect(after, approved));
  Object.assign(row, {
    breakSeconds: (end - start) / 1000 - seconds(work), recordedWorkSeconds: seconds(work),
    regularSeconds: seconds(regular), additionalSeconds: seconds(after) + approvedEarly,
    approvedAdditionalSeconds: approvedAfter + approvedEarly,
    reviewAdditionalSeconds: seconds(after) - approvedAfter,
    earlyArrivalSeconds: seconds(early), approvedEarlySeconds: approvedEarly,
    earlyReviewSeconds: seconds(early) - approvedEarly,
    totalSeconds: seconds(regular) + seconds(after) + approvedEarly,
    earlyLeaveSeconds: Math.max(0, (scheduledEnd - Math.max(end, scheduledStart)) / 1000),
  });
  row.requests = relevant.filter(r => requestWindows([r], record.date, end).some(([a, b]) => a < end && b > start));
  if (row.earlyReviewSeconds && relevant.some(r => r.type === 'overtime' && r.status === 'pending' && seconds(intersect(early, requestWindows([r], record.date, end))) > 0)) row.notes.push('조기근무 신청 검토 대기');
  if (row.reviewAdditionalSeconds) row.notes.push('추가근무 승인 대조 필요');
  if (legacy?.status === 'rejected') row.notes.push(`기존 야근 검토 반려: ${legacy.reason}`);
  if (relevant.some(r => r.type !== 'overtime' && r.status === 'approved' && seconds(intersect(work, requestWindows([r], record.date, end))) > 0)) {
    row.notes.push('승인 부재와 출퇴근 기록 겹침 · 확인 필요');
  }
  return row;
}

export function buildAttendanceReport({employees, attendance, requests = [], overtime = [], from, to}) {
  const summaries = employees.map(person => {
    const ownRequests = requests.filter(r => r.employee_id === person.id);
    const records = attendance.filter(r => r.employee_id === person.id && r.date >= from && r.date <= to)
      .slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const rows = records.map(r => attendanceDay(r, ownRequests, overtime));
    const counts = new Map();
    for (const row of rows) counts.set(row.date, (counts.get(row.date) || 0) + 1);
    for (const row of rows) if (counts.get(row.date) > 1) {
      row.status = 'duplicate'; row.notes.push('동일 근무일 중복 · 시간 합계 제외');
      for (const key of ['breakSeconds','regularSeconds','additionalSeconds','approvedAdditionalSeconds','reviewAdditionalSeconds','earlyArrivalSeconds','approvedEarlySeconds','earlyReviewSeconds','totalSeconds','earlyLeaveSeconds','recordedWorkSeconds']) row[key] = null;
    }
    const complete = rows.filter(r => r.status === 'complete');
    const sum = key => complete.reduce((total, r) => total + (r[key] || 0), 0);
    const absenceDates = Object.fromEntries(['annual', 'monthly', 'early', 'absence'].map(type => [type, new Set()]));
    for (const r of ownRequests.filter(r => r.status === 'approved' && r.type !== 'overtime' && overlapsPeriod(r, from, to))) {
      for (let date = r.start_date < from ? from : r.start_date; date <= r.end_date && date <= to; date = nextDate(date)) absenceDates[r.type]?.add(date);
    }
    return {
      ...person, rows, attendanceDays: counts.size,
      workedDays: new Set(complete.filter(r => r.totalSeconds > 0).map(r => r.date)).size,
      incompleteDays: new Set(rows.filter(r => r.status !== 'complete').map(r => r.date)).size,
      reviewDays: new Set(rows.filter(r => r.notes.length).map(r => r.date)).size,
      lateDays: new Set(rows.filter(r => r.lateSeconds > 0).map(r => r.date)).size,
      earlyLeaveDays: new Set(complete.filter(r => r.earlyLeaveSeconds > 0).map(r => r.date)).size,
      regularSeconds: sum('regularSeconds'), additionalSeconds: sum('additionalSeconds'),
      approvedAdditionalSeconds: sum('approvedAdditionalSeconds'), reviewAdditionalSeconds: sum('reviewAdditionalSeconds'),
      earlyReviewSeconds: sum('earlyReviewSeconds'), breakSeconds: sum('breakSeconds'),
      totalSeconds: sum('totalSeconds'), lateSeconds: rows.reduce((n, r) => n + (r.lateSeconds || 0), 0),
      absenceDates: Object.fromEntries(Object.entries(absenceDates).map(([key, dates]) => [key, dates.size])),
    };
  });
  return {from, to, policy: attendancePolicy, summaries, payrollStatus: 'unconfirmed'};
}

export function duration(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const total = Math.round(value), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
  return `${hours}시간 ${minutes}분${secs ? ` ${secs}초` : ''}`;
}
export function localStamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed + 9 * 60 * MINUTE).toISOString().slice(0, 19).replace('T', ' ') : '';
}
function csvCell(value) {
  let text = String(value ?? '');
  // Quote fields and neutralize spreadsheet formulas in names/reasons/IDs.
  if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
const csv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function attendanceCsv(report, mode = 'daily') {
  const note = '현행 기준 참고 집계 · 급여 미확정 · 자정 넘는 근무는 출근일 귀속';
  if (mode === 'summary') return csv([
    ['조회시작', '조회종료', '사번', '성명', '소속', '출근일수', '근무일수(완료기록)', '시간미확정일수', '확인필요일수', '기본근무(초)', '추가근무기록(초)', '추가중승인대조(초)', '추가중확인필요(초)', '조기도착중미반영(초)', '집계시간(초)', '집계시간', '지각일수', '조퇴일수', '승인연차날짜수', '승인월차날짜수', '승인조퇴날짜수', '승인결근기타날짜수', '기준버전', '집계안내'],
    ...report.summaries.map(s => [report.from, report.to, s.number, s.name, s.team, s.attendanceDays, s.workedDays, s.incompleteDays, s.reviewDays, s.regularSeconds, s.additionalSeconds, s.approvedAdditionalSeconds, s.reviewAdditionalSeconds, s.earlyReviewSeconds, s.totalSeconds, duration(s.totalSeconds), s.lateDays, s.earlyLeaveDays, s.absenceDates.annual, s.absenceDates.monthly, s.absenceDates.early, s.absenceDates.absence, report.policy.version, note]),
  ]);
  return csv([
    ['사번', '성명', '소속', '근무일', '실제출근(KST)', '기본집계시작(KST)', '실제퇴근(KST)', '휴게(초)', '기본근무(초)', '추가근무기록(초)', '추가중승인대조(초)', '추가중확인필요(초)', '08:30전도착(초)', '조기중승인대조(초)', '조기중미반영(초)', '집계시간(초)', '집계시간', '지각(초)', '조퇴(초)', '상태', '확인사항', '신청및처리근거', '기록ID', '기록버전', '기준버전', '집계안내'],
    ...report.summaries.flatMap(s => s.rows.map(r => [s.number, s.name, s.team, r.date, localStamp(r.inAt), localStamp(r.calculationStartAt), localStamp(r.outAt), r.breakSeconds, r.regularSeconds, r.additionalSeconds, r.approvedAdditionalSeconds, r.reviewAdditionalSeconds, r.earlyArrivalSeconds, r.approvedEarlySeconds, r.earlyReviewSeconds, r.status === 'complete' ? r.totalSeconds : '', r.status === 'complete' ? duration(r.totalSeconds) : '', r.lateSeconds, r.earlyLeaveSeconds, ({complete:'집계 완료',open:'퇴근 미기록',invalid:'시각 확인 필요',duplicate:'중복 확인 필요'})[r.status], r.notes.join(' / '), r.requests.map(q => `${q.type} | ${q.status} | ${q.start_date}~${q.end_date} | ${q.start_minute}~${q.end_minute}분 | ${q.reason} | ${q.actor_login || ''} | ${localStamp(q.decided_at)} | ${q.comment || ''}`).join('\n'), r.id, r.version, report.policy.version, note])),
  ]);
}
