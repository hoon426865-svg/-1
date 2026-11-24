import {duration, localStamp} from './attendance-report.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status = {complete:'집계 완료', open:'퇴근 미기록', invalid:'시각 확인 필요', duplicate:'중복 확인 필요'};
const type = {overtime:'야근·추가근무', annual:'연차', monthly:'월차', early:'조퇴', absence:'결근·기타 부재'};
const decision = {pending:'대기', approved:'승인', rejected:'반려'};
const time = value => value ? esc(localStamp(value)) : '—';

export function attendanceReportView(report) {
  if (!report) return '<p role="alert">근태 자료를 새로 조회해 주세요.</p>';
  return `<section data-attendance-report><h3>직원별 근태 집계</h3>
    <p>${esc(report.from)} ~ ${esc(report.to)} · 한국 시간 · 출근일 기준</p>
    <details class="attendance-rules"><summary>집계 기준 · 휴게시간 확인</summary><p class="small">08:30 이전 출근은 기본근무를 08:30부터 계산합니다. 실제 시각은 그대로 보관하며, 승인된 조기근무는 추가근무로 별도 반영합니다. 기본근무 종료는 17:30입니다.</p>
    <p class="small">휴게 10:30~10:40 · 점심 12:30~13:30 · 휴게 15:30~15:40 중 기록 구간과 겹치는 시간만 공제합니다. 정상 하루는 7시간 40분입니다. 휴게시간의 유급 여부와 급여·수당은 미확정입니다.</p>
    <p class="small">출근일수는 기록이 있는 날짜 수, 근무일수는 완료 기록의 집계시간이 있는 날짜 수입니다. 퇴근 누락·중복·48시간 초과 기록은 시간 합계에서 제외합니다. 자정을 넘는 근무는 출근일에 귀속합니다. 휴가·부재 날짜 수는 근무일수나 휴가 차감량에 합산하지 않습니다.</p></details>
    <div class="employee-actions"><button type="button" class="secondary" data-attendance-export="summary">직원별 합계 CSV</button><button type="button" class="secondary" data-attendance-export="daily">일별 출퇴근 CSV</button></div>
    <p data-export-error role="alert" class="task-error"></p>
    <p class="small attendance-scroll-hint">표를 좌우로 움직이면 나머지 항목을 볼 수 있습니다.</p><div class="table-wrap" tabindex="0" role="region" aria-label="직원별 근태 합계"><table data-attendance-summary><thead><tr><th>직원</th><th>출근 / 근무일수</th><th>기본근무</th><th>추가근무 기록</th><th>집계시간</th><th>시간 미확정</th><th>확인 필요</th><th>지각 / 조퇴</th><th>승인 연차 / 월차 / 결근·기타</th></tr></thead><tbody>
    ${report.summaries.map(s => `<tr><td>${esc(s.number)} ${esc(s.name)}<span class="team">${esc(s.team)}${s.active === 0 || s.active === false ? ' · 퇴사' : ''}</span></td><td>${s.attendanceDays}일 / ${s.workedDays}일</td><td>${duration(s.regularSeconds)}</td><td>${duration(s.additionalSeconds)}<span class="team">승인 대조 ${duration(s.approvedAdditionalSeconds)}<br>승인 확인 필요 ${duration(s.reviewAdditionalSeconds)}</span></td><td>${duration(s.totalSeconds)}</td><td>${s.incompleteDays}일</td><td>${s.reviewDays}일</td><td>${s.lateDays}일 / ${s.earlyLeaveDays}일</td><td>${s.absenceDates.annual}일 / ${s.absenceDates.monthly}일 / ${s.absenceDates.absence}일</td></tr>`).join('') || '<tr><td colspan="9">조회할 직원이 없습니다.</td></tr>'}
    </tbody></table></div>
    ${report.summaries.map(s => `<details class="request-item" data-attendance-person="${esc(s.id)}"><summary>${esc(s.number)} ${esc(s.name)} · 일별 출퇴근 ${s.rows.length}건</summary>
      <div class="table-wrap" tabindex="0" role="region" aria-label="일별 출퇴근 상세"><table><thead><tr><th>근무일</th><th>실제 출근 / 기본집계 시작</th><th>실제 퇴근</th><th>휴게</th><th>기본근무</th><th>추가근무</th><th>집계시간</th><th>상태·확인 사항</th></tr></thead><tbody>
      ${s.rows.map(r => `<tr><td>${esc(r.date)}</td><td>${time(r.inAt)}<span class="team">집계 ${time(r.calculationStartAt)}</span></td><td>${time(r.outAt)}</td><td>${duration(r.breakSeconds)}</td><td>${duration(r.regularSeconds)}</td><td>${duration(r.additionalSeconds)}<span class="team">승인 대조 ${duration(r.approvedAdditionalSeconds)}<br>조기도착 미반영 ${duration(r.earlyReviewSeconds)}</span></td><td>${r.status === 'complete' ? duration(r.totalSeconds) : '미확정'}</td><td>${status[r.status]}${r.lateSeconds > 0 ? `<br>지각 ${duration(r.lateSeconds)}` : ''}${r.earlyLeaveSeconds > 0 ? `<br>조퇴 ${duration(r.earlyLeaveSeconds)}` : ''}${r.notes.map(n => `<p>${esc(n)}</p>`).join('')}${r.requests.map(q => `<p>${esc(type[q.type])} · ${esc(decision[q.status])}<br>${esc(q.actor_login || '—')} · ${time(q.decided_at)}<br>${esc(q.comment || q.reason)}</p>`).join('')}</td></tr>`).join('') || '<tr><td colspan="8">출퇴근 기록이 없습니다.</td></tr>'}
      </tbody></table></div></details>`).join('')}
    <p class="small">현행 기준의 참고 집계입니다. 기존 기록·과거 확정 자료를 변경하지 않습니다. 급여·수당 확정 자료는 아닙니다.</p></section>`;
}
