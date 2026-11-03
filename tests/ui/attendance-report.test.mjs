import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

test('브라우저 근태 보고서: 기간·상세·예외·원본·한글 CSV·모바일·직원 권한',{timeout:120000},async()=>{
  const f=fixture(),errors=[],directory=resolve('private/attendance-20261103/ui');await mkdir(directory,{recursive:true,mode:0o700});
  const now=new Date('2026-12-03T20:00:00+09:00'),server=createHttpServer(createApplication(f.db,f.config,()=>now),'http://127.0.0.1');
  let browser;
  try{
    f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-12-01','2026-11-30T23:20:00.000Z','2026-12-01T09:30:00.000Z')").run();
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});f.config.origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    await page.goto(f.config.origin);await page.locator('[name=login]').fill('ADMIN');await page.locator('[name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('[data-page=home]').waitFor({state:'visible'});
    await page.locator('#app-navigation a[href="#reports"]').click();const filter=page.locator('#attendance-report-filter');
    await filter.locator('[name=employeeId]').selectOption('e1');await filter.locator('button').click();
    await page.locator('#attendance-report-result [data-detail]').waitFor();assert.match(await page.locator('#attendance-report-result').innerText(),/460분/);
    await page.locator('[data-detail]').click();await page.locator('[data-adjust] [name=startAt]').fill('2026-12-01T08:20');await page.locator('[data-adjust] [name=reason]').fill('회사 지시 조기 준비');await page.locator('[data-adjust] button[value=save]').click();
    await page.waitForFunction(()=>document.querySelector('#attendance-report-result')?.textContent.includes('10분'));
    await page.locator('[data-detail]').click();assert.match(await page.locator('[data-attendance-detail]').innerText(),/회사 지시 조기 준비/);assert.match(await page.locator('[data-attendance-detail]').innerText(),/08:20:00/);
    const downloadPromise=page.waitForEvent('download');await page.locator('#attendance-csv').click();const download=await downloadPromise;
    await download.saveAs(resolve(directory,'attendance.csv'));const csv=await readFile(resolve(directory,'attendance.csv'));assert.deepEqual([...csv.subarray(0,3)],[239,187,191]);assert.match(csv.toString('utf8'),/회사 지시 조기 준비/);assert.match(csv.toString('utf8'),/연간 합계/);
    await page.screenshot({path:resolve(directory,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(directory,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await filter.locator('[name=period]').selectOption('range');await filter.locator('[name=from]').fill('2026-12-02');await filter.locator('[name=to]').fill('2026-12-02');await filter.locator('button').click();await page.waitForFunction(()=>document.querySelector('#attendance-report-result')?.textContent.includes('집계 자료가 없습니다.'));
    await page.setViewportSize({width:1440,height:1000});await page.locator('#logout').click();await page.locator('[name=login]').fill('001');await page.locator('[name=password]').fill(f.password);await page.locator('#login-form button').click();await page.locator('[data-page=home]').waitFor({state:'visible'});
    assert.equal(await page.locator('#attendance-report-filter').count(),0);
    assert.equal(await page.evaluate(async()=> (await fetch('/api/admin/attendance-report/export?year=2026')).status),403);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
