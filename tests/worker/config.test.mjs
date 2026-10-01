import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateConfig,authenticationHash} from '../../scripts/cloudflare-config.mjs';
import {assertFreeSubscriptions,verifyFreeAccount} from '../../scripts/cloudflare-free-plan.mjs';
import {boundedDatabase} from '../../worker/d1.mjs';
const sample=()=>({env:Object.fromEntries(['preview','production'].map((e,i)=>[e,{name:'onwork-'+e,workers_dev:true,vars:{APP_ORIGIN:`https://onwork-${e}.test.workers.dev`,SITE_ID:'site-1',ENVIRONMENT:e,AUTH_MODE:'passkey',MAINTENANCE_MODE:'0'},d1_databases:[{binding:'DB',database_id:`11111111-1111-1111-1111-11111111111${i}`}]}]))});
test('배포 설정은 별도 DB·HTTPS workers.dev·현재 인증 코드 무료 CPU 검증을 요구한다',()=>{
  const hash=authenticationHash(),c=sample();
  assert.equal(validateConfig(c,'preview'),true);assert.equal(validateConfig(c,'production',hash),true);
  assert.throws(()=>validateConfig(c,'production',''));assert.throws(()=>validateConfig(c,'unknown',hash));
  c.env.production.d1_databases=c.env.preview.d1_databases;assert.throws(()=>validateConfig(c,'preview'));
  assert.throws(()=>validateConfig(JSON.parse(readFileSync('wrangler.jsonc','utf8')),'preview'));
});
test('무료 D1 요청 예산은 배치의 각 SQL을 합산하고 초과 요청을 실행 전에 차단한다',async()=>{
  let actual=0;const prepare=()=>({bind(){return this;},async first(){actual++;return {};}});
  const d=boundedDatabase({prepare,async batch(statements){actual+=statements.length;return [];}});
  const statements=Array.from({length:49},()=>d.prepare('SELECT 1').bind());
  await d.batch(statements);await d.prepare('SELECT 1').first();
  assert.equal(actual,50);assert.equal(d.queryCount,50);
  assert.throws(()=>d.prepare('SELECT 1').first(),{status:503});assert.equal(actual,50);
});
test('무료 플랜 검사는 조회 API만 사용하며 유료 구독·확인 불가·권한 부족은 배포 차단',async()=>{
  assertFreeSubscriptions([]);assertFreeSubscriptions([{rate_plan:{id:'workers_free'}}]);
  assert.throws(()=>assertFreeSubscriptions([{rate_plan:{id:'workers_paid'}}]));assert.throws(()=>assertFreeSubscriptions([{}]));
  await verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:'1'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-only'},async(url,options)=>{
    assert.match(url,/\/subscriptions$/);assert.equal(options.method,undefined);return Response.json({success:true,result:[]});
  });
  await assert.rejects(verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:'1'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-only'},async()=>Response.json({success:false},{status:403})));
});
