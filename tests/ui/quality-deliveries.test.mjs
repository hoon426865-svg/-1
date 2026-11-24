import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

test('품질 전용 AS 등록·재검사·납품, 도번 입고·초안 보존과 모바일 화면',{timeout:120000},async()=>{
  const f=fixture(),errors=[],directory=resolve('private/quality-ui');await mkdir(directory,{recursive:true});
  const server=createHttpServer(createApplication(f.db,f.config,()=>new Date('2026-11-23T12:00:00+09:00')),'http://127.0.0.1');let browser;
  try{
    const admin=f.client();await admin.login('ADMIN');
    const post=async(path,body)=>{const r=await admin.call('/api/operations/'+path,{requestKey:f.key(),...body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
    for(const [userId,quality,materials] of [['ue1',true,false],['ue2',false,true]])await post('access',{userId,quality,materials,production_review:false,version:0,reason:'합성 UI 권한'});
    const items={};
    for(const [drawing,active] of [['GC9-AS-9001',true],['GC9-PR-9001',true],['GC9-SP-9002',true],['GC9_SP_9002',true],['GC9-MO-9003',false]])items[drawing]=await post('items',{drawing,name:'합성 '+drawing,model:'TEST',kind:'part',unit:'EA',supplier:'합성 공급자',criteria:'합성 외관 기준',active,version:0,reason:'합성 UI 품목'});
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    const login=async name=>{await page.goto(f.config.origin);await page.locator('[name=login]').fill(name);await page.locator('[name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('#logout').waitFor();};
    const submit=async(form,path)=>{const previous=await form.elementHandle();const response=page.waitForResponse(r=>r.url().endsWith('/api/operations/'+path)&&r.request().method()==='POST');await form.locator('button.primary').click();const result=await response;assert.equal(result.status(),200,await result.text());await page.waitForFunction(el=>!el.isConnected,previous);await previous.dispose();await page.waitForFunction(()=>document.querySelector('[data-ops-message]')?.textContent.includes('저장했습니다.'));await page.waitForFunction(()=>!document.querySelector('[data-request-slot] [aria-busy="true"]'));};
    await login('001');await page.locator('#app-navigation a[href="#quality"]').click();await page.locator('#ops-delivery').waitFor();
    assert.equal(await page.locator('#app-navigation a[href="#materials"]').count(),0);
    let form=page.locator('#ops-delivery');
    await form.locator('[name=drawing]').fill('gc9pr9001');assert.match(await form.locator('[name=drawing]').evaluate(el=>el.validationMessage),/자재 입고/);
    await form.locator('[name=drawing]').fill('gc9as9001');assert.equal(await form.locator('[name=itemId]').inputValue(),items['GC9-AS-9001'].id);
    // Declining a tab switch preserves the complete typed draft.
    page.once('dialog',d=>d.dismiss());await page.locator('[data-quality-mode="lots"]').click();assert.equal(await form.locator('[name=drawing]').inputValue(),'gc9as9001');
    await form.locator('[name=lotCode]').fill('UI-AS-01');await form.locator('[name=customer]').fill('합성 납품처');await form.locator('[name=quantity]').fill('10');await form.locator('[name=reason]').fill('합성 납품 계획');
    await submit(form,'quality/deliveries');
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_lots').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM production').get().n,0);
    for(const decision of ['fail','pass']){
      await page.locator('[data-action="inspect"]').click();form=page.locator('#ops-inspect');await form.waitFor();
      assert.equal(await form.locator('[name=stage] option').count(),1);assert.equal(await form.locator('[name=stage]').inputValue(),'shipping');
      await form.locator('[name=sample]').fill('5');await form.locator('[name=failed]').fill(decision==='fail'?'1':'0');await form.locator('[name=decision]').selectOption(decision);
      assert.equal(await form.locator('[name=criteria]').inputValue(),'합성 외관 기준');await form.locator('[name=measurements]').fill(decision==='fail'?'외관 불량 1개':'선별 후 외관 이상 없음');await form.locator('[name=reason]').fill(decision==='fail'?'출하검사':'선별 후 재검사');await form.locator('[name=criteriaConfirmed]').check();
      if(decision==='pass'){
        await page.screenshot({path:resolve(directory,'as-inspection-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(directory,'as-inspection-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewportSize({width:1440,height:1000});
      }
      await submit(form,'quality/deliveries/inspect');
      assert.equal(await page.locator('[data-action="complete"]').count(),decision==='pass'?1:0);
    }
    await page.locator('[data-action="complete"]').click();form=page.locator('#ops-delivery-complete');await form.locator('[name=reason]').fill('실제 납품 확인');assert.equal(await form.evaluate(el=>el.checkValidity()),false);await form.locator('[name=deliveryConfirmed]').check();await submit(form,'quality/deliveries/complete');
    assert.equal(f.db.prepare('SELECT status FROM ops_deliveries').get().status,'delivered');assert.equal(f.db.prepare('SELECT count(*) n FROM ops_delivery_inspections').get().n,2);
    assert.equal(await page.locator('[data-action="inspect"]').count(),0);await page.screenshot({path:resolve(directory,'as-completed.png'),fullPage:true});
    await page.locator('#logout').click();await login('002');await page.locator('#app-navigation a[href="#materials"]').click();await page.locator('#ops-receive').waitFor();form=page.locator('#ops-receive');
    assert.equal(await form.locator('select[name=itemId]').count(),0);
    for(const [drawing,error] of [['UNKNOWN',/등록된/],['gc9as9001',/AS 계열/],['gc9sp9002',/여러 개/],['GC9-MO-9003',/사용 중지/]]){await form.locator('[name=drawing]').fill(drawing);assert.match(await form.locator('[name=drawing]').evaluate(el=>el.validationMessage),error);assert.equal(await form.locator('[name=itemId]').inputValue(),'');}
    await form.locator('[name=drawing]').fill('gc9pr9001');assert.equal(await form.locator('[name=supplier]').inputValue(),'합성 공급자');await form.locator('[name=supplier]').fill('이번 입고 공급자');await form.locator('[name=lotCode]').fill('UI-PR-01');await form.locator('[name=quantity]').fill('12');await form.locator('[name=reason]').fill('실물 수량 확인');
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/operations/materials/history'));await page.locator('#refresh').click();await refreshed;
    await page.waitForFunction(()=>document.querySelector('#ops-receive [name=supplier]')?.value==='이번 입고 공급자');
    assert.equal(await form.locator('[name=drawing]').inputValue(),'gc9pr9001');assert.equal(await form.locator('[name=itemId]').inputValue(),items['GC9-PR-9001'].id);assert.equal(await form.locator('[name=quantity]').inputValue(),'12');
    assert.equal(await form.isVisible(),true);
    await page.screenshot({path:resolve(directory,'drawing-receipt.png'),fullPage:true});await submit(form,'materials/receive');assert.equal(f.db.prepare('SELECT supplier FROM ops_lots').get().supplier,'이번 입고 공급자');
    await page.locator('#logout').click();await login('001');await page.locator('#app-navigation a[href="#quality"]').click();await page.locator('#ops-delivery').waitFor();
    // An untouched AS form does not trigger an unnecessary discard dialog.
    let unexpectedDialog=false;page.once('dialog',async d=>{unexpectedDialog=true;await d.dismiss();});await page.locator('[data-quality-mode="lots"]').click();await page.locator('[data-lot]').click();assert.equal(unexpectedDialog,false);
    form=page.locator('#ops-inspect');assert.equal(await form.locator('[name=stage]').inputValue(),'incoming');await form.locator('[name=sample]').fill('3');await form.locator('[name=decision]').selectOption('pass');await form.locator('[name=measurements]').fill('수입검사 이상 없음');await form.locator('[name=reason]').fill('입고 검사');await form.locator('[name=criteriaConfirmed]').check();await submit(form,'quality/inspect');
    assert.equal(f.db.prepare('SELECT status FROM ops_lots').get().status,'released');assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
