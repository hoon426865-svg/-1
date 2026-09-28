import test from 'node:test';import assert from 'node:assert/strict';import { fixture } from './helpers.mjs';
const qrToken=(f,action='in',site='site-1',expiry=Date.parse('2026-09-27T23:31:00Z'))=>{const raw=f.key();return import('../lib/security.mjs').then(({digest})=>{f.db.prepare('INSERT INTO qr_challenges VALUES(?,?,?,?)').run(digest(raw),site,action,expiry);return {token:raw,siteId:site};});};
test('QR 발급·유효기간·사업장·직원별 중복 사용 및 서버 시각',async()=>{
 const f=fixture();try{const a=f.client(),e=f.client(),other=f.client();await a.login('ADMIN');await e.login('001');await other.login('002');
 const issued=await a.call('/api/admin/qr',{action:'in'});assert.equal(issued.status,200);assert.ok(issued.data.image.startsWith('data:image/png;base64,'));
 assert.equal((await e.call('/api/attendance/scan',{})).status,400);
 assert.equal((await e.call('/api/attendance/scan',await qrToken(f,'in','other-site'))).status,403);
 assert.equal((await e.call('/api/attendance/scan',await qrToken(f,'in','site-1',0))).status,400);
 const qr=await qrToken(f);const result=await e.call('/api/attendance/scan',{...qr,time:'01:00:00',employeeId:'e2'});
 assert.equal(result.status,200);assert.equal(result.data.record.in,'08:30:00');assert.equal(result.data.record.employeeId,'e1');
 assert.equal((await e.call('/api/attendance/scan',qr)).status,409);
 assert.equal((await other.call('/api/attendance/scan',qr)).status,200);
 assert.equal((await e.call('/api/attendance/scan',await qrToken(f))).status,409);
 f.setTime('2026-09-28T08:30:01Z');await e.login('001');
 const out=await qrToken(f,'out','site-1',Date.parse('2026-09-28T08:31:00Z'));
 assert.equal((await e.call('/api/attendance/scan',out)).data.record.out,'17:30:01');
 assert.equal((await e.call('/api/attendance/scan',out)).status,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM attendance WHERE employee_id=?').get('e1').n,1);
 }finally{f.db.close();}
});
test('다음 날 퇴근은 최초 출근 날짜에 연결되고 재시작 후 QR 재사용 차단',async()=>{
 const f=fixture();try{const e=f.client();await e.login('001');const qr=await qrToken(f);await e.call('/api/attendance/scan',qr);f.restart();assert.equal((await e.call('/api/attendance/scan',qr)).status,409);
 f.setTime('2026-09-28T16:00:00Z');await e.login('001');const result=await e.call('/api/attendance/scan',await qrToken(f,'out','site-1',Date.parse('2026-09-28T16:01:00Z')));
 assert.equal(result.data.record.date,'2026-09-28');assert.equal(result.data.record.outDate,'2026-09-29');
 }finally{f.db.close();}
});
