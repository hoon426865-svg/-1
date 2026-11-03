import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {buildAttendanceReport} from '../../public/attendance-report.js';

test('D1 근태: 월말 근무와 다음 달 승인, 원본 보존·관리자 권한·페이지 집계',async()=>{
  const f=await fixture();try{
    const admin=f.client(),e=f.client(),guest=f.client();await admin.login('ADMIN');await e.login('001');
    const raw={id:'a1',employee_id:'e1',date:'2026-11-30',in_at:'2026-11-30T11:00:00.000Z',out_at:'2026-11-30T17:00:00.000Z',version:1};
    await f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').bind(raw.id,raw.employee_id,raw.date,raw.in_at,raw.out_at).run();
    const req=(await e.call('/api/work-requests',{type:'overtime',startDate:'2026-12-01',endDate:'2026-12-01',allDay:false,startTime:'00:00',endTime:'02:00',reason:'자정 이후 근무 시험'})).data;
    const decision=(await admin.call('/api/admin/work-requests/decision',{id:req.id,version:req.version,action:'approved',comment:'실제 근무 대조 시험'})).data;
    const path='/api/admin/work-requests/report?year=2026&month=11&employeeId=e1';
    assert.equal((await e.call(path)).status,403);assert.equal((await guest.call(path)).status,401);
    const data=(await admin.call(path)).data;
    assert.equal(data.requests.length,0); // December request must not change November request totals.
    const r=data.attendanceReport.summaries[0];
    assert.equal(r.attendanceDays,1);assert.equal(r.totalSeconds,6*3600);assert.equal(r.approvedAdditionalSeconds,2*3600);
    assert.equal(r.reviewAdditionalSeconds,4*3600);
    assert.deepEqual(await f.db.prepare('SELECT * FROM attendance WHERE id=?').bind('a1').first(),raw);
    const person=await f.db.prepare("SELECT * FROM employees WHERE id='e1'").first();
    const expected=buildAttendanceReport({employees:[person],attendance:[raw],requests:[{...decision,employee_name:person.name,employee_number:person.number}],from:'2026-11-01',to:'2026-11-30'});
    assert.deepEqual(data.attendanceReport,expected);
    for(let start=0;start<205;start+=40)await f.db.batch(Array.from({length:Math.min(40,205-start)},(_,j)=>{
      const id=`extra-${start+j}`;
      return f.db.prepare('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)').bind(id,id,'가상 직원','검증팀','site-1');
    }));
    const whole=(await admin.call('/api/admin/work-requests/report?year=2026&month=11')).data;
    assert.equal(whole.attendanceReport.summaries.length,207);
    assert.equal(whole.attendanceReport.summaries.find(s=>s.id==='e1').totalSeconds,6*3600);
    // A reopened request remains in history, but no longer confirms work time.
    await admin.call('/api/admin/work-requests/decision',{id:decision.id,version:decision.version,action:'reopen',comment:'재검토 시험'});
    assert.equal((await admin.call(path)).data.attendanceReport.summaries[0].approvedAdditionalSeconds,0);
  }finally{await f.close();}
});
