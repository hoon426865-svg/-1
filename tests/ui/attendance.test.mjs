import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from '../helpers.mjs';
import {createApplication} from '../../lib/application.mjs';
import {createHttpServer} from '../../lib/http.mjs';

test('관리자 근태 UI: 월별 조회·원본/집계 시각·CSV·모바일·직원 차단', {timeout:60000}, async()=>{
  const f=fixture(),errors=[],dir=resolve('private','attendance-ui');
  const app=createApplication(f.db,f.config,()=>new Date('2026-11-03T10:00:00Z'));
  const server=createHttpServer(app,'http://127.0.0.1');let browser;
  try {
    await mkdir(dir,{recursive:true,mode:0o700});
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    f.config.origin=`http://127.0.0.1:${server.address().port}`;
    f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-11-03','2026-11-02T23:10:00.000Z','2026-11-03T08:30:00.000Z')").run();
    f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a2','e2','2026-11-03','2026-11-02T23:42:00.000Z',NULL)").run();
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.config.origin);
    await page.locator('#login-form [name=login]').fill('ADMIN');await page.locator('#login-form [name=password]').fill(f.password);
    await page.locator('#login-form button').click();await page.locator('[data-page=home]').waitFor({state:'visible'});
    await page.locator('#app-navigation a[href="#reports"]').click();
    await page.locator('#work-report [name=month]').selectOption('11');await page.locator('#work-report button').click();
    await page.locator('[data-attendance-summary] tbody tr').first().waitFor();
    assert.equal(await page.locator('[data-attendance-summary] tbody tr').count(),2);
    assert.match(await page.locator('[data-attendance-summary] tbody tr').first().innerText(),/7시간 40분/);
    await page.locator('[data-attendance-person=e1] > summary').click();
    const details=await page.locator('[data-attendance-person=e1]').innerText();
    assert.match(details,/08:10:00/);assert.match(details,/08:30:00/);
    const download=page.waitForEvent('download');await page.locator('[data-attendance-export=daily]').click();
    const csv=await readFile(await (await download).path(),'utf8');
    assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/2026-11-03 08:10:00/);assert.match(csv,/퇴근 미기록/);
    await page.screenshot({path:resolve(dir,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:resolve(dir,'mobile.png'),fullPage:true});
    const other=await (await browser.newContext()).newPage();await other.goto(f.config.origin);
    await other.locator('#login-form [name=login]').fill('001');await other.locator('#login-form [name=password]').fill(f.password);
    await other.locator('#login-form button').click();await other.locator('[data-page=home]').waitFor({state:'visible'});
    assert.equal(await other.locator('[data-page=reports]').count(),0);
    assert.equal(await other.evaluate(async()=> (await fetch('/api/admin/work-requests/report?year=2026&month=11')).status),403);
    await other.locator('#app-navigation a[href="#attendance"]').click();
    assert.match(await other.locator('.clock-pair').innerText(),/08:30/);assert.match(await other.locator('.clock-pair').innerText(),/08:10/);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(ok=>server.close(ok));f.db.close();}
});
