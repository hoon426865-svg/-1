import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

// Only an in-memory synthetic database is used. No live account or passkey.
test('카테고리 화면: 실제 브라우저·권한·입력 보존·반응형 이동', {timeout:120000}, async t=>{
  const f=fixture(),errors=[],screenshots=resolve('private',`ui-navigation-${Date.now()}`);
  await mkdir(screenshots,{recursive:true,mode:0o700});
  const app=createApplication(f.db,f.config,()=>new Date('2026-09-27T23:30:00Z'));
  const server=createHttpServer(app,'http://127.0.0.1');
  let browser;
  try {
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const admin=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
    const employee=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
    for(const page of [admin,employee]) {page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);}
    const nav=async(page,id)=>{
      if(await page.locator('#menu-toggle').isVisible())await page.locator('#menu-toggle').click();
      await page.locator(`#app-navigation a[href="#${id}"]`).click();
      await page.locator(`[data-page="${id}"]`).waitFor({state:'visible'});
      assert.equal(await page.locator('[data-page]:visible').count(),1);
      assert.equal(await page.locator('#app-navigation [aria-current="page"]').getAttribute('href'),'#'+id);
    };
    const login=async(page,login)=>{
      await page.goto(f.config.origin);
      await page.locator('#login-form [name=login]').fill(login);
      await page.locator('#login-form [name=password]').fill(f.password);
      await page.locator('#login-form button').click();
      await page.locator('[data-page=home]').waitFor({state:'visible'});
    };
    const request=async(page,path,body)=>page.evaluate(async({path,body})=>{
      const me=await (await fetch('/api/me')).json();
      const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':me.csrf}:{},body:body?JSON.stringify(body):undefined});
      return {status:response.status,data:await response.json()};
    },{path,body});
    const second=f.client();await second.login('002');
    await second.call('/api/attendance',{action:'in'});
    await second.call('/api/production',{taskId:'t1',good:314,bad:2,requestKey:f.key()});
    await second.call('/api/work-requests',{type:'absence',startDate:'2026-09-29',endDate:'2026-09-29',allDay:true,reason:'다른 직원 비공개 신청'});
    await login(admin,'ADMIN');await login(employee,'001');

    await t.test('관리자 9개·직원 5개 메뉴와 서버 권한·본인 기록',async()=>{
      assert.equal(await admin.locator('#app-navigation a').count(),9);
      assert.equal(await employee.locator('#app-navigation a').count(),5);
      assert.equal(await employee.locator('[data-page=employees],[data-page=reports]').count(),0);
      assert.equal((await request(employee,'/api/admin/work-requests/report?year=2026')).status,403);
      assert.equal((await request(employee,'/api/admin/employee',{number:'BAD',name:'차단',team:'차단',reason:'검사'})).status,403);
      const own=(await request(employee,'/api/state')).data;
      assert.deepEqual(own.employees.map(e=>e.id),['e1']);
      assert.equal(own.production.length,0);
      await employee.evaluate(()=>{location.hash='employees';});
      await employee.waitForURL('**/employee#home');
      for(const page of [admin,employee]){
        await nav(page,'attendance');await nav(page,'production');
        await page.goBack();await page.locator('[data-page=attendance]').waitFor({state:'visible'});
        await page.goForward();await page.locator('[data-page=production]').waitFor({state:'visible'});
      }
      await nav(admin,'home');await admin.screenshot({path:resolve(screenshots,'admin-desktop.png'),fullPage:true});
    });

    await t.test('메뉴·조회·앱 새로고침에서 직원 입력과 관리자 입력 유지',async()=>{
      await employee.locator('#production-form [name=good]').fill('7');
      await nav(employee,'requests');
      await employee.locator('#work-form [name=reason]').fill('작성 중인 휴가 사유');
      await employee.locator('#work-filter button').click();
      await nav(employee,'settings');
      const refreshed=employee.waitForResponse(response=>new URL(response.url()).pathname==='/api/work-requests');
      await employee.locator('#settings-refresh').click();await refreshed;
      await nav(employee,'production');assert.equal(await employee.locator('#production-form [name=good]').inputValue(),'7');
      await nav(employee,'requests');assert.equal(await employee.locator('#work-form [name=reason]').inputValue(),'작성 중인 휴가 사유');
      assert.ok(!(await employee.locator('.request-list').textContent()).includes('다른 직원 비공개 신청'));
      await nav(admin,'employees');
      await admin.locator('#add-employee-form [name=name]').fill('작성 중 직원');
      await nav(admin,'production');
      await admin.locator('#add-task-form [name=name]').fill('검사 작업');
      await admin.locator('#add-task-form [name=reason]').fill('화면 검증');
      await admin.locator('#add-task-form button').click();
      await admin.locator('.edit-task-form [name=name]').filter({visible:true}).first().waitFor();
      await nav(admin,'employees');assert.equal(await admin.locator('#add-employee-form [name=name]').inputValue(),'작성 중 직원');
    });

    await t.test('출퇴근·생산·신청 저장과 관리자 승인·보고서',async()=>{
      await nav(employee,'production');
      await employee.locator('#production-form button').click();
      await employee.waitForFunction(()=>document.querySelector('#production-form [name=good]')?.value==='0');
      await nav(employee,'attendance');await employee.locator('button[value=in]').click();
      await employee.waitForFunction(()=>document.querySelector('button[value=in]')?.disabled===true&&document.querySelector('button[value=out]')?.disabled===false);
      await nav(employee,'requests');
      await employee.locator('#work-form [name=type]').selectOption('annual');
      await employee.locator('#work-form [name=allDay]').selectOption('true');
      await employee.locator('#work-form button.primary').click();
      await employee.waitForFunction(()=>document.querySelector('#work-form [name=reason]')?.value==='');
      const submitted=f.db.prepare("SELECT * FROM work_requests WHERE employee_id='e1'").get();assert.ok(submitted);
      await nav(admin,'requests');
      const decision=admin.locator(`[data-decision="${submitted.id}"]`);
      await decision.locator('[name=comment]').fill('승인 검증');
      await nav(admin,'home');await nav(admin,'requests');
      assert.equal(await decision.locator('[name=comment]').inputValue(),'승인 검증');
      await decision.locator('button').click();
      await decision.locator('[name=action] option[value=reopen]').waitFor({state:'attached'});
      assert.equal(f.db.prepare('SELECT status FROM work_requests WHERE id=?').get(submitted.id).status,'approved');
      await nav(admin,'reports');
      await admin.locator('#work-report [name=employeeId]').selectOption('e1');
      await admin.locator('#work-report button').click();
      await admin.locator('[data-request-report] > summary').click();
      await admin.locator('#report-result [data-request-summary] tbody tr').waitFor();
      const row=await admin.locator('#report-result [data-request-summary] tbody tr').innerText();assert.match(row,/7\s*\/\s*0/);assert.match(row,/1일/);
      await admin.locator('#report-result [data-request-report] details summary').click();
      await admin.locator('#report-result [data-history]').click();
      await admin.locator('[data-page=reports] [data-work-history] h3').waitFor();
      assert.equal(await admin.locator('[data-page=requests]').isVisible(),false);
      await admin.screenshot({path:resolve(screenshots,'admin-report.png'),fullPage:true});
      // A report already opened in another category must follow later decisions.
      await nav(admin,'requests');
      await decision.locator('[name=comment]').fill('재검토 검증');await decision.locator('button').click();
      await decision.locator('[name=action] option[value=approved]').waitFor({state:'attached'});
      await nav(admin,'reports');
      await admin.waitForFunction(()=>document.querySelector('#report-result [data-request-summary] tbody tr')?.textContent.includes('0일'));
      await nav(admin,'requests');
      await decision.locator('[name=comment]').fill('재승인 검증');await decision.locator('button').click();
      await decision.locator('[name=action] option[value=reopen]').waitFor({state:'attached'});
      await nav(admin,'reports');
      await admin.waitForFunction(()=>document.querySelector('#report-result [data-request-summary] tbody tr')?.textContent.includes('1일'));
    });

    await t.test('새로고침 후 오래된 편집 버전의 덮어쓰기 거부',async()=>{
      await nav(admin,'employees');const edit=admin.locator('.edit-employee-form[data-id=e1]');
      await edit.locator('[name=name]').fill('작성 중 이름');await edit.locator('[name=reason]').fill('입력 보존 확인');
      const original=Number(await edit.getAttribute('data-version'));
      const client=f.client();await client.login('ADMIN');
      const person=f.db.prepare("SELECT * FROM employees WHERE id='e1'").get();
      assert.equal((await client.call('/api/admin/employee',{id:person.id,version:person.version,name:'서버의 최신 이름',number:person.number,team:person.team,reason:'동시 수정 검증'})).status,200);
      await admin.locator('#refresh').click();
      await admin.waitForFunction(()=>document.querySelector('.edit-employee-form[data-id=e1] [role=alert]')?.textContent.includes('작성 중인 기록'));
      assert.equal(await edit.locator('[name=name]').inputValue(),'작성 중 이름');assert.equal(Number(await edit.getAttribute('data-version')),original);
      await edit.locator('button[type=submit],button:not([type])').click();
      await admin.waitForFunction(()=>document.querySelector('.edit-employee-form[data-id=e1] [role=alert]')?.textContent.includes('다른 변경'));
      assert.equal(f.db.prepare("SELECT name FROM employees WHERE id='e1'").get().name,'서버의 최신 이름');
    });

    await t.test('휴대폰 메뉴·강조·닫기·가로 넘침 및 입력 보존',async()=>{
      for(const [page,role] of [[admin,'admin'],[employee,'employee']]){
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.locator('#app-navigation a').first().isVisible(),false);
        const ids=role==='admin'?['home','attendance','production','requests','employees','reports','settings']:['home','attendance','production','requests','settings'];
        for(const id of ids){await nav(page,id);assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,role+':'+id);}
        await nav(page,'home');await page.screenshot({path:resolve(screenshots,role+'-mobile.png'),fullPage:true});
        await page.locator('#menu-toggle').click();await page.keyboard.press('Escape');
        assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
        await page.setViewportSize({width:320,height:740});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.setViewportSize({width:1440,height:1000});
      }
      await nav(admin,'employees');assert.equal(await admin.locator('.edit-employee-form[data-id=e1] [name=name]').inputValue(),'작성 중 이름');
    });

    await t.test('브라우저 새로고침 경고·메뉴 복원·로그아웃 후 다른 사용자 분리',async()=>{
      await nav(employee,'production');await employee.locator('#production-form [name=good]').fill('9');
      let dialogSeen=false;
      employee.once('dialog',async dialog=>{dialogSeen=true;assert.equal(dialog.type(),'beforeunload');await dialog.dismiss();});
      await employee.evaluate(()=>location.reload());
      await employee.waitForTimeout(150);
      assert.equal(dialogSeen,true);assert.equal(await employee.locator('#production-form [name=good]').inputValue(),'9');
      employee.once('dialog',dialog=>dialog.accept());
      await employee.reload();await employee.locator('[data-page=production]').waitFor({state:'visible'});
      assert.equal(await employee.locator('#production-form [name=good]').inputValue(),'0');
      assert.equal(await employee.locator('#app-navigation [aria-current=page]').getAttribute('href'),'#production');
      assert.equal(await employee.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).length),0);
      admin.once('dialog',dialog=>dialog.accept());await admin.locator('#logout').click();
      await admin.locator('#login-form').waitFor();assert.equal(await admin.locator('#app-navigation').isVisible(),false);
      await login(admin,'001');assert.equal(await admin.locator('#app-navigation a').count(),5);
      assert.ok(!(await admin.locator('#screen').textContent()).includes('작성 중 직원'));
      assert.deepEqual(errors,[]);
    });
    await t.test('다른 탭의 계정 변경 후 이전 관리자 화면·입력 분리',async()=>{
      await request(admin,'/api/logout',{});await login(admin,'ADMIN');
      await nav(admin,'employees');await admin.locator('#add-employee-form [name=name]').fill('이전 관리자의 미저장 입력');
      await nav(admin,'requests');await admin.locator('[data-decision]').first().waitFor();
      // Change only the shared cookie in another tab; the old UI is still mounted.
      await request(admin,'/api/logout',{});
      const otherTab=await admin.context().newPage();await login(otherTab,'001');
      const obsoleteDecision=admin.locator('[data-decision]').first();
      await obsoleteDecision.locator('[name=comment]').fill('계정 전환 후 차단 검사');
      const denied=admin.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/work-requests/decision');
      await obsoleteDecision.locator('button').click();assert.equal((await denied).status(),403);
      await admin.waitForFunction(()=>document.querySelectorAll('#app-navigation a').length===5);
      await nav(admin,'requests');
      assert.equal(await admin.locator('[data-decision],#add-employee-form,#work-report').count(),0);
      assert.ok(!(await admin.locator('#screen').textContent()).includes('이전 관리자의 미저장 입력'));
      await admin.locator('#work-form').waitFor();await otherTab.close();
      assert.deepEqual(errors,[]);
    });
    console.log('Synthetic browser screenshots: '+screenshots);
  } finally {
    await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();
  }
});
