-- Add a new policy; original punches, prior policies and monthly snapshots stay unchanged.
INSERT OR IGNORE INTO attendance_policies(id,effective_from,definition_json) VALUES(
  'attendance-2026-11-03-v2','2026-11-03',
  '{"id":"attendance-2026-11-03-v2","effectiveFrom":"2026-11-03","timezone":"Asia/Seoul","startMinute":510,"endMinute":1050,"breaks":[{"name":"오전 휴게","kind":"rest","start":630,"end":640,"paid":true},{"name":"점심","kind":"lunch","start":750,"end":810,"paid":false},{"name":"오후 휴게","kind":"rest","start":930,"end":940,"paid":true}],"payroll":"basic-paid-rest","workday":"출근일 기준, 자정 이후도 같은 근무일"}'
);
