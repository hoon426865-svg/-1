import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

// This browser test exercises presentation and form handling using synthetic
// account responses. Real WebAuthn signatures/UV/authorization are covered by
// tests/worker/admin-accounts.test.mjs; this stub is not an authentication test.
test('관리자 추가 UI: 권한 확인·재인증 취소·등록권 표시·초안 보존·직원 화면 분리',{timeout:120000},async()=>{
  const f=fixture(),errors=[],screenshots=resolve('private/admin-accounts-ui');
  const server=createHttpServer(createApplication(f.db,f.config,()=>new Date('2026-11-24T10:00:00+09:00')),'http://127.0.0.1');
  let browser,releaseUnauthorizedList;
  try{
    await mkdir(screenshots,{recursive:true});
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const passkeyMode=async ctx=>ctx.route('**/api/setup',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,json:{...await response.json(),authMode:'passkey'}});
    });
    const session=async(ctx,login)=>{
      const response=await ctx.request.post(f.config.origin+'/api/login',{headers:{origin:f.config.origin},data:{login,password:f.password}});
      assert.equal(response.status(),200);
    };
    await session(context,'ADMIN');await passkeyMode(context);
    await context.addInitScript(()=>{
      window.__cancelAdminProof=false;
      window.__adminProofCalls=0;
      window.SimpleWebAuthnBrowser={startAuthentication:async()=>{
        window.__adminProofCalls++;
        if(window.__cancelAdminProof)throw new DOMException('합성 본인 확인 취소','NotAllowedError');
        return {id:'synthetic-admin-credential',response:{}};
      }};
    });
    const accounts=[{id:'admin',login:'ADMIN',mustChange:false,passkeyCount:1,canReissue:false}],intents=[],mutations=[];
    let failNextList=false,listReads=0,unauthorizedList=null;
    const firstTicket='synthetic-admin-invite-one-00000000000000000',secondTicket='synthetic-admin-invite-two-00000000000000000';
    await context.route('**/api/admin/passkeys/authorize/options',async route=>{
      const body=route.request().postDataJSON();intents.push(body);
      await route.fulfill({json:{challengeId:'synthetic-proof-'+intents.length,options:{challenge:'synthetic-challenge'}}});
    });
    await context.route('**/api/admin/accounts',async route=>{
      if(route.request().method()==='GET'){
        listReads++;
        if(unauthorizedList){const gate=unauthorizedList;unauthorizedList=null;await gate;await route.fulfill({status:401,json:{error:'합성 세션 만료'}});return;}
        if(failNextList){failNextList=false;await route.fulfill({status:503,json:{error:'합성 목록 새로고침 실패'}});return;}
        await route.fulfill({json:{accounts}});return;
      }
      const body=route.request().postDataJSON();mutations.push({path:'create',body});
      const account={id:'new-admin',login:body.login.toUpperCase(),mustChange:true,passkeyCount:0,canReissue:true};accounts.push(account);
      // A successful grant must remain visible even if its follow-up list read fails.
      failNextList=true;
      await route.fulfill({json:{id:account.id,login:account.login,role:'admin',enrollmentTicket:firstTicket,expiresAt:'2026-11-24T10:15:00+09:00'}});
    });
    await context.route('**/api/admin/accounts/reissue',async route=>{
      mutations.push({path:'reissue',body:route.request().postDataJSON()});
      await route.fulfill({json:{id:'new-admin',login:'MGR02',role:'admin',enrollmentTicket:secondTicket,expiresAt:'2026-11-24T10:20:00+09:00'}});
    });
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.config.origin);await page.locator('#app-navigation a[href="#settings"]').click();
    const form=page.locator('#admin-account-create');await form.waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-admin-accounts]')?.textContent.includes('ADMIN'));
    assert.equal(await page.locator('.admin-invite-reissue').count(),0);
    assert.match(await page.locator('[data-admin-accounts]').innerText(),/ADMIN/);
    assert.equal(await form.evaluate(el=>el.checkValidity()),false);
    await form.locator('[name=login]').fill('MGR02');await form.locator('[name=reason]').fill('합성 담당 관리자 계정 발급');
    await form.locator('button').click();assert.equal(mutations.length,0);assert.equal(intents.length,0);
    await form.locator('[name=adminRightsConfirmed]').check();
    await page.evaluate(()=>{window.__cancelAdminProof=true;});await form.locator('button').click();
    await page.waitForFunction(()=>document.querySelector('#admin-account-create [role="alert"]')?.textContent.length>0);
    assert.equal(mutations.length,0);assert.equal(await form.locator('[name=login]').inputValue(),'MGR02');assert.equal(await form.locator('[name=adminRightsConfirmed]').isChecked(),true);
    assert.equal(intents[0].operation,'create-admin');assert.equal(intents[0].details.adminRightsConfirmed,true);
    await page.evaluate(()=>{window.__cancelAdminProof=false;});await form.locator('button').click();
    const dialog=page.locator('dialog[open]'),ticket=dialog.locator('[aria-label="일회용 등록권"]');await dialog.waitFor();
    assert.equal(await ticket.inputValue(),firstTicket);assert.match(await dialog.innerText(),/MGR02/);assert.match(await dialog.innerText(),/15분/);
    assert.equal(mutations.length,1);assert.equal(mutations[0].body.adminRightsConfirmed,true);assert.ok(mutations[0].body.authorization?.challengeId);
    assert.ok(!page.url().includes(firstTicket));
    assert.equal(await page.evaluate(value=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(value),firstTicket),false);
    const ticketNode=await ticket.elementHandle();await dialog.locator('button').click();await dialog.waitFor({state:'detached'});
    assert.equal(await ticketNode.evaluate(el=>el.value),'');await ticketNode.dispose();
    // Retry a harmless read after the injected failure; no extra administrator is created.
    const beforeReads=listReads;await page.locator('#refresh').click();await page.locator('.admin-invite-reissue[data-id="new-admin"]').waitFor();assert.ok(listReads>beforeReads);assert.equal(mutations.length,1);
    assert.equal(await page.locator('.admin-invite-reissue[data-id="admin"]').count(),0);
    await form.locator('[name=login]').fill('MGR03');await form.locator('[name=reason]').fill('작성 중인 관리자 추가 사유');await form.locator('[name=adminRightsConfirmed]').check();
    const reloaded=page.waitForResponse(r=>r.url().endsWith('/api/admin/accounts')&&r.request().method()==='GET');await page.locator('#refresh').click();await reloaded;
    await page.waitForFunction(()=>document.querySelector('#admin-account-create [name=reason]')?.value==='작성 중인 관리자 추가 사유');
    assert.equal(await form.locator('[name=login]').inputValue(),'MGR03');assert.equal(await form.locator('[name=adminRightsConfirmed]').isChecked(),true);
    const reissue=page.locator('.admin-invite-reissue[data-id="new-admin"]');await reissue.locator('[name=reason]').fill('합성 등록권 만료로 재발급');
    await reissue.locator('button').click();assert.equal(mutations.length,1);
    await reissue.locator('[name=adminRightsConfirmed]').check();await reissue.locator('button').click();await dialog.waitFor();
    assert.equal(await ticket.inputValue(),secondTicket);assert.equal(mutations.length,2);assert.equal(mutations[1].path,'reissue');assert.equal(mutations[1].body.id,'new-admin');assert.equal(intents.at(-1).operation,'reinvite-admin');
    await dialog.locator('button').click();await dialog.waitFor({state:'detached'});
    await page.screenshot({path:resolve(screenshots,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(screenshots,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);

    const employee=await browser.newContext();await session(employee,'001');await passkeyMode(employee);
    const employeePage=await employee.newPage();let employeeAdminReads=0;
    employeePage.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/admin/accounts'))employeeAdminReads++;});
    await employeePage.goto(f.config.origin);await employeePage.locator('#app-navigation a[href="#settings"]').click();
    assert.equal(await employeePage.locator('#admin-account-create').count(),0);assert.equal(employeeAdminReads,0);
    const guest=await browser.newContext();await passkeyMode(guest);const guestPage=await guest.newPage();await guestPage.goto(f.config.origin+'/login');
    await guestPage.getByText('패스키 등록 · 등록권 입력',{exact:true}).click();await guestPage.locator('#passkey-enroll').waitFor();
    assert.match(await guestPage.locator('#passkey-login [name=login]').getAttribute('placeholder'),/발급받은 계정/);

    // An ordinary refresh error preserves the grant above, but an expired
    // authenticated session must clear it even though the dialog lives on body.
    await page.setViewportSize({width:1440,height:1000});
    await reissue.locator('[name=reason]').fill('합성 세션 만료 중 등록권 처리');await reissue.locator('[name=adminRightsConfirmed]').check();
    unauthorizedList=new Promise(resolve=>{releaseUnauthorizedList=resolve;});
    await reissue.locator('button').click();await dialog.waitFor();
    const expiringTicket=await ticket.elementHandle();assert.equal(await ticket.inputValue(),secondTicket);
    releaseUnauthorizedList();releaseUnauthorizedList=null;
    await page.locator('#passkey-login').waitFor();await dialog.waitFor({state:'detached'});
    assert.equal(await expiringTicket.evaluate(el=>el.value),'');await expiringTicket.dispose();
    assert.equal(await page.locator('[aria-label="일회용 등록권"]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{releaseUnauthorizedList?.();await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
