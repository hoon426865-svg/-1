import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

test('도번 생산·중복 제출 방지·연속 입고와 납품 입력·현재 페이지 검색',{timeout:120000},async()=>{
  const f=fixture(),errors=[];
  const server=createHttpServer(createApplication(f.db,f.config),'http://127.0.0.1');let browser,releasePost;
  try{
    const admin=f.client();await admin.login('ADMIN');
    const post=async(path,body)=>{const r=await admin.call('/api/operations/'+path,{requestKey:f.key(),...body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
    await post('access',{userId:'ue1',quality:true,materials:true,production_review:false,version:0,reason:'합성 작업자 권한'});
    const items={};
    for(const drawing of ['GC9-AS-9100','GC9-AS-91001','GC9-PR-9100'])items[drawing]=await post('items',{drawing,name:'합성 입력 검증 '+drawing,model:'TEST',kind:drawing.includes('-AS-')?'assembly':'part',unit:'EA',supplier:'합성 공급자',criteria:'합성 검사 기준',active:true,version:0,reason:'합성 품목'});
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
    await page.goto(f.config.origin);await page.locator('#login-form [name=login]').fill('001');await page.locator('#login-form [name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('#logout').waitFor();
    const nav=async name=>{await page.locator(`#app-navigation a[href="#${name}"]`).click();await page.locator(`[data-page="${name}"]`).waitFor();};
    const submit=async(form,path)=>{
      const previous=await form.elementHandle(),response=page.waitForResponse(r=>r.url().endsWith('/api/operations/'+path)&&r.request().method()==='POST');
      await form.locator('button[type=submit]').click();const result=await response;assert.equal(result.status(),200,await result.text());
      await page.waitForFunction(el=>!el.isConnected,previous);await previous.dispose();
      await page.waitForFunction(()=>!document.querySelector('[data-request-slot] [aria-busy="true"]'));
    };

    // Production uses a drawing lookup, not a long item dropdown, and one in-flight save.
    await nav('production');let form=page.locator('#ops-production');await form.waitFor();
    assert.equal(await form.locator('select[name=itemId]').count(),0);
    await form.locator('[name=drawing]').fill('gc9pr9100');assert.equal(await form.locator('[name=itemId]').inputValue(),items['GC9-PR-9100'].id);
    await form.locator('[name=lotCode]').fill('ENTRY-RUN-01');await form.locator('[name=good]').fill('7');
    let posts=0,requestBody,gotPost;const firstPost=new Promise(resolve=>gotPost=resolve),gate=new Promise(resolve=>releasePost=resolve);
    await page.route('**/api/operations/production',async route=>{
      if(route.request().method()!=='POST')return route.continue();posts++;requestBody=route.request().postDataJSON();gotPost();await gate;await route.continue();
    });
    const productionResponse=page.waitForResponse(r=>r.url().endsWith('/api/operations/production')&&r.request().method()==='POST');
    await form.locator('button[type=submit]').click();await firstPost;
    const original=await form.elementHandle(),heading=await page.locator('[data-page="production"] h1').elementHandle(),refresh=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');
    await page.locator('#refresh').click();await refresh;await page.waitForFunction(el=>!el.isConnected,heading);await heading.dispose();
    await page.waitForFunction(el=>el.isConnected&&el.getAttribute('aria-busy')==='true',original);
    assert.equal(await form.locator('[name=lotCode]').inputValue(),'ENTRY-RUN-01');
    await form.evaluate(el=>el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(await form.getAttribute('aria-busy'),'true');releasePost();assert.equal((await productionResponse).status(),200);
    await page.waitForFunction(()=>document.querySelector('#ops-production [name=lotCode]')?.value==='');
    await page.waitForFunction(()=>!document.querySelector('[data-request-slot] [aria-busy="true"]'));
    assert.equal(await form.locator('[name=good]').inputValue(),'');await original.dispose();
    assert.equal(posts,1);assert.equal(requestBody.itemId,items['GC9-PR-9100'].id);assert.equal(requestBody.good,'7');assert.equal(f.db.prepare('SELECT count(*) n FROM ops_runs').get().n,1);
    await page.unroute('**/api/operations/production');

    // A committed correction cannot turn into a second production entry when refresh fails.
    await page.locator('[data-page="production"] [data-edit]').click();form=page.locator('#ops-production');
    await form.locator('[name=good]').fill('9');await form.locator('[name=reason]').fill('합성 수량 정정');
    await page.route('**/api/operations/context',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'합성 목록 조회 실패'})}));
    await submit(form,'production/correct');
    await page.waitForFunction(()=>document.querySelector('[data-page="production"] [data-ops-error]')?.textContent.includes('저장은 완료'));
    assert.equal(await form.locator('[name=lotCode]').inputValue(),'');assert.equal(await form.locator('[name=good]').inputValue(),'');assert.equal(await form.locator('[name=reason]').count(),0);assert.equal(await form.evaluate(el=>el.checkValidity()),false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_runs').get().n,1);assert.equal(f.db.prepare('SELECT good FROM production').get().good,9);
    await page.unroute('**/api/operations/context');
    const recovery=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/operations/context');await page.locator('[data-page="production"] [data-reload]').click();await recovery;

    // Continuing keeps stable context only. The next LOT, quantity and reason are required afresh.
    await nav('materials');form=page.locator('#ops-receive');await form.waitFor();assert.equal(await form.isVisible(),true);
    await form.locator('[name=drawing]').fill('gc9pr9100');await form.locator('[name=supplier]').fill('이번 공급업체');await form.locator('[name=lotCode]').fill('ENTRY-RCV-01');await form.locator('[name=quantity]').fill('12');
    await form.locator('[data-reason-preset="입고 확인"]').click();await form.locator('[name=keepContext]').check();await submit(form,'materials/receive');
    await page.waitForFunction(()=>document.querySelector('#ops-receive [name=drawing]')?.value==='gc9pr9100'&&document.querySelector('#ops-receive [name=lotCode]')?.value==='');
    assert.equal(await form.locator('[name=supplier]').inputValue(),'이번 공급업체');assert.equal(await form.locator('[name=quantity]').inputValue(),'');assert.equal(await form.locator('[name=reason]').inputValue(),'');assert.equal(await form.evaluate(el=>el.checkValidity()),false);assert.equal(await form.locator('[name=keepContext]').isChecked(),true);
    await form.locator('[name=lotCode]').fill('ENTRY-RCV-02');await form.locator('[name=quantity]').fill('3');await form.locator('[name=reason]').fill('두 번째 거래 확인');await form.locator('[name=keepContext]').uncheck();await submit(form,'materials/receive');
    await page.waitForFunction(()=>document.querySelector('#ops-receive [name=drawing]')?.value==='');
    assert.deepEqual(f.db.prepare("SELECT received FROM ops_lots WHERE code LIKE 'ENTRY-RCV-%' ORDER BY code").all().map(row=>row.received),[12,3]);

    await nav('quality');const quality=page.locator('[data-page="quality"]');form=page.locator('#ops-delivery');await form.waitFor();await form.locator('[name=drawing]').fill('gc9as9100');await form.locator('[name=customer]').fill('합성 납품처');await form.locator('[name=dueDate]').fill('2026-12-01');await form.locator('[name=lotCode]').fill('ENTRY-AS-01');await form.locator('[name=quantity]').fill('8');await form.locator('[data-reason-preset="정기 납품"]').click();await form.locator('[name=keepContext]').check();await submit(form,'quality/deliveries');
    await page.waitForFunction(()=>document.querySelector('#ops-delivery [name=drawing]')?.value==='gc9as9100'&&document.querySelector('#ops-delivery [name=lotCode]')?.value==='');
    assert.equal(await form.locator('[name=customer]').inputValue(),'합성 납품처');assert.equal(await form.locator('[name=dueDate]').inputValue(),'2026-12-01');assert.equal(await form.locator('[name=quantity]').inputValue(),'');assert.equal(await form.locator('[name=reason]').inputValue(),'');
    await form.locator('[name=drawing]').fill('gc9as91001');await form.locator('[name=lotCode]').fill('ENTRY-AS-02');await form.locator('[name=quantity]').fill('4');await form.locator('[name=reason]').fill('다른 도번 추가');await form.locator('[name=keepContext]').uncheck();await submit(form,'quality/deliveries');
    await page.waitForFunction(()=>document.querySelectorAll('[data-page="quality"] [data-ops-list] [data-action="inspect"]').length===2);
    await form.locator('[name=customer]').fill('검색 중 보존할 초안');
    await quality.locator('[data-list-search]').fill('gc9as9100');
    assert.equal(await quality.locator('[data-ops-list] .ops-row').count(),1);assert.match(await quality.locator('[data-ops-list]').innerText(),/ENTRY-AS-01/);assert.doesNotMatch(await quality.locator('[data-ops-list]').innerText(),/ENTRY-AS-02/);
    assert.equal(await form.locator('[name=customer]').inputValue(),'검색 중 보존할 초안');assert.match(await quality.locator('[data-list-summary]').innerText(),/현재 페이지에만/);
    await quality.locator('[data-list-status]').selectOption('held');assert.equal(await quality.locator('[data-ops-list] .ops-row').count(),0);
    await quality.locator('[data-clear-filters]').click();assert.equal(await quality.locator('[data-ops-list] .ops-row').count(),2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_deliveries').get().n,2);

    // Review opens one focused form and requires an explicit approve/reject choice.
    // The preserved search draft must be explicitly discarded before logging out.
    const logoutResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/logout'&&r.request().method()==='POST');
    const confirmLogout=page.waitForEvent('dialog'),clickedLogout=page.locator('#logout').click();
    const dialog=await confirmLogout;assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/작성 중인 내용.*로그아웃/);await dialog.accept();await clickedLogout;
    assert.equal((await logoutResponse).status(),200);
    await page.locator('#login-form [name=login]').fill('ADMIN');await page.locator('#login-form [name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('#logout').waitFor();
    await nav('production');await page.locator('[data-page="production"] [data-review]').waitFor();
    assert.equal(await page.locator('form[id^="ops-review-"]').count(),0);await page.locator('[data-page="production"] [data-review]').click();form=page.locator('form[id^="ops-review-"]');
    assert.equal(await form.locator('[name=status]').inputValue(),'');await form.locator('[name=reason]').fill('수량과 LOT 확인');assert.equal(await form.evaluate(el=>el.checkValidity()),false);
    await form.locator('[name=status]').selectOption('approved');await submit(form,'production/review');
    assert.equal(f.db.prepare('SELECT status FROM ops_runs').get().status,'approved');assert.equal(f.db.prepare("SELECT balance FROM ops_lots WHERE code='ENTRY-RUN-01'").get().balance,9);assert.deepEqual(errors,[]);
  }finally{releasePost?.();await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
