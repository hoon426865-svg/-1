import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

const item=overrides=>({drawing:'SYN-AS-9001',name:'합성 조립품',model:'SYN',kind:'assembly',unit:'EA',criteria:'',...overrides});

test('품목 가져오기: 미리보기 후 명시적 추가·기존 유지·부분 실패 재시도·로그아웃 중단',{timeout:120000},async()=>{
  const f=fixture(),errors=[];
  const server=createHttpServer(createApplication(f.db,f.config),'http://127.0.0.1');let browser,release;
  try{
    const admin=f.client();await admin.login('ADMIN');
    const existing=await admin.call('/api/operations/items',{...item({drawing:'SYN-AS-9000',name:'기존 유지 이름'}),active:false,version:0,reason:'합성 기존 품목',requestKey:f.key()});assert.equal(existing.status,200);
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await context.request.post(f.config.origin+'/api/login',{headers:{origin:f.config.origin},data:{login:'ADMIN',password:f.password}});
    await page.goto(f.config.origin+'/admin#settings');await page.locator('.catalog-import [data-import]').waitFor();
    const count=()=>f.db.prepare('SELECT count(*) n FROM ops_items').get().n;
    const select=async items=>{await page.locator('.catalog-import [data-import]').setInputFiles({name:'synthetic-catalog.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({items}))});await page.locator('[data-import-summary]').waitFor();};
    // A slow previous file must not overwrite a newer selection or a clear.
    await page.evaluate(()=>{
      const original=File.prototype.text;
      File.prototype.text=function(){if(this.name==='slow-catalog.json')return new Promise(resolve=>{window.releaseCatalogFile=()=>original.call(this).then(resolve);});return original.call(this);};
    });
    const slow={name:'slow-catalog.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({items:[item({drawing:'SYN-AS-9100'})]}))};
    await page.locator('.catalog-import [data-import]').setInputFiles(slow);await select([item({drawing:'SYN-AS-9101'})]);
    await page.evaluate(async()=>{await window.releaseCatalogFile();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.match(await page.locator('.catalog-import-preview').innerText(),/SYN-AS-9101/);assert.doesNotMatch(await page.locator('.catalog-import-preview').innerText(),/SYN-AS-9100/);
    await page.locator('.catalog-import [data-import]').setInputFiles(slow);await page.locator('[data-import-clear]').click();
    await page.evaluate(async()=>{await window.releaseCatalogFile();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(await page.locator('[data-import-summary]').count(),0);assert.equal(count(),1);
    await select([item({drawing:'syn_as_9000',name:'덮어쓰면 안 되는 이름'}),item(),item({drawing:'SYN-AS-9002'})]);
    assert.equal(count(),1);assert.match(await page.locator('[data-import-summary]').innerText(),/새로 추가 2개.*이미 등록 1개/);
    await page.locator('[data-import-clear]').click();assert.equal(count(),1);assert.equal(await page.locator('[data-import-summary]').count(),0);
    await select([item({drawing:'syn_as_9000'}),item(),item({drawing:'SYN-AS-9002'})]);
    const requests=[];let failed=false;
    await page.route('**/api/operations/items',async route=>{
      const body=route.request().postDataJSON();requests.push(body);
      if(body.drawing==='SYN-AS-9002'&&!failed){failed=true;await route.fulfill({status:503,json:{error:'합성 일시 실패'}});return;}
      await route.continue();
    });
    await page.locator('[data-import-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-import-error]')?.textContent.includes('합성 일시 실패'));
    assert.equal(count(),2);assert.equal(requests.length,2);assert.equal(requests[0].version,0);assert.equal(requests[0].active,true);
    await page.locator('[data-import-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-import-status]')?.textContent.includes('2개 등록 완료'));
    assert.equal(count(),3);assert.equal(requests.length,3);assert.equal(requests[1].requestKey,requests[2].requestKey);
    assert.deepEqual({...f.db.prepare("SELECT name,active,version FROM ops_items WHERE drawing='SYN-AS-9000'").get()},{name:'기존 유지 이름',active:0,version:1});
    // An already committed write whose reply was lost is discovered on retry.
    await select([item({drawing:'SYN-AS-9003'}),item({drawing:'SYN-AS-9004'})]);
    await page.unroute('**/api/operations/items');let lost=false;
    await page.route('**/api/operations/items',async route=>{
      if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({status:503,json:{error:'합성 응답 유실'}});return;}
      await route.continue();
    });
    await page.locator('[data-import-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-import-error]')?.textContent.includes('합성 응답 유실'));assert.equal(count(),4);
    await page.locator('[data-import-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-import-status]')?.textContent.includes('기존 1개 유지'));assert.equal(count(),5);
    // Logout after a sent request must prevent sending subsequent rows.
    await select([item({drawing:'SYN-AS-9005'}),item({drawing:'SYN-AS-9006'})]);
    await page.unroute('**/api/operations/items');let sent=0;
    const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/operations/items',async route=>{sent++;await gate;await route.fulfill({status:401,json:{error:'합성 로그아웃'}});});
    const pendingRequest=page.waitForRequest(request=>request.url().endsWith('/api/operations/items'));
    await page.locator('[data-import-apply]').click();await pendingRequest;
    await page.locator('#settings-logout').click();await page.locator('#login-form').waitFor();release();
    await page.waitForLoadState('networkidle');assert.equal(sent,1);assert.equal(count(),5);assert.equal(await page.locator('[data-import-summary]').count(),0);assert.deepEqual(errors,[]);
  }finally{release?.();await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
