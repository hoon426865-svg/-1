import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

test('패스키 로그인 전에 화면 모듈을 제공하고 보호된 API 권한은 유지한다',async()=>{
  const f=await fixture({passkey:true});
  try {
    const guest=f.client();
    for(const path of ['/navigation.js','/drafts.js','/attendance-report.js','/attendance-view.js']) {
      const response=await guest.call(path);
      assert.equal(response.status,200);
      assert.match(response.headers.get('content-type'),/javascript/);
      assert.match(response.data,/export function/);
    }
    assert.equal((await guest.call('/api/state')).status,401);
    assert.equal((await guest.call('/api/admin/work-requests/report?year=2026')).status,401);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM passkeys').first()).n,0);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first()).n,1);
  } finally {await f.close();}
});
