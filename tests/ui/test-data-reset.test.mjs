import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

test('관리자 선택 초기화 UI: 목록·확인·취소·삭제·복구 사본·직원 차단',{timeout:120000},async()=>{
  const f=fixture(),errors=[],directory=resolve('private/test-reset-ui');await mkdir(directory,{recursive:true});
  const server=createHttpServer(createApplication(f.db,f.config,()=>new Date('2026-11-03T12:00:00+09:00')),'http://127.0.0.1');let browser;
  try{
    for(const [id,e,date] of [['a1','e1','2026-11-01'],['a2','e2','2026-11-02']])f.db.prepare('INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES(?,?,?,?,?)').run(id,e,date,date+'T08:30:00+09:00',date+'T17:30:00+09:00');
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    await page.goto(f.config.origin);await page.locator('[name=login]').fill('ADMIN');await page.locator('[name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('#app-navigation a[href="#settings"]').click();
    const filter=page.locator('#test-reset-filter');await filter.locator('[name=employeeId]').selectOption('e1');await filter.locator('button').click();
    await page.locator('[data-reset-item]').waitFor();assert.equal(await page.locator('[data-reset-item]').count(),1);
    await page.locator('[data-reset-all]').check();await page.locator('[data-reset-preview]').click();await page.locator('#test-reset-execute').waitFor();
    assert.match(await page.locator('[data-reset-confirm]').innerText(),/출퇴근 원본: 1건/);await page.locator('[data-reset-cancel]').click();assert.equal(await page.locator('#test-reset-execute').count(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,2);
    await page.locator('[data-reset-preview]').click();await page.locator('#test-reset-execute').waitFor();
    await page.screenshot({path:resolve(directory,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(directory,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const form=page.locator('#test-reset-execute');await form.locator('[name=reason]').fill('선택한 테스트 기록만 정리');await form.locator('[name=confirmation]').fill('틀린 확인');await form.locator('button.danger').click();await page.waitForFunction(()=>document.querySelector('[data-reset-error]')?.textContent.includes('확인 문구'));assert.equal(f.db.prepare('SELECT count(*) n FROM attendance').get().n,2);
    await form.locator('[name=confirmation]').fill('테스트 기록 삭제');await form.locator('button.danger').click();await page.waitForFunction(()=>document.querySelector('[data-reset-status]')?.textContent.includes('삭제했습니다'));
    assert.deepEqual(f.db.prepare('SELECT id FROM attendance').all().map(r=>r.id),['a2']);assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n,3);
    await page.locator('.reset-card details > summary').click();await page.locator('[data-reset-backups]').click();const download=page.waitForEvent('download');await page.locator('[data-reset-history] a').click();const file=await download;await file.saveAs(resolve(directory,'backup.json'));const backup=JSON.parse(await readFile(resolve(directory,'backup.json'),'utf8'));assert.equal(backup.data.tables.attendance[0].id,'a1');assert.equal(backup.data.tables.users,undefined);
    await page.setViewportSize({width:1440,height:1000});await page.locator('#logout').click();await page.locator('[name=login]').fill('001');await page.locator('[name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('#app-navigation a[href="#settings"]').click();assert.equal(await page.locator('#test-reset-filter').count(),0);assert.equal(await page.evaluate(async()=>(await fetch('/api/admin/test-data/backups')).status),403);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
