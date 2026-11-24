import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCatalogImport} from '../public/catalog-import.js';

const item=overrides=>({drawing:'TEST-AS-9001',name:'합성 조립품',model:'TEST',kind:'assembly',unit:'EA',...overrides});

test('품목 가져오기는 전체 형식·필수값·길이 오류를 등록 전에 검출한다',()=>{
  for(const document of [null,[],{}, {items:[]},{items:Array.from({length:201},()=>item())}])assert.throws(()=>prepareCatalogImport(document),/1~200/);
  const plan=prepareCatalogImport({items:[item(),item({drawing:'TEST-PR-9002',name:' ',model:17,criteria:'x'.repeat(5001),supplier:null})]});
  assert.equal(plan.ready,false);assert.equal(plan.rows[0].status,'new');assert.equal(plan.rows[1].status,'error');
  assert.match(plan.errors.join(' '),/품명/);assert.match(plan.errors.join(' '),/모델/);assert.match(plan.errors.join(' '),/검사 기준/);assert.match(plan.errors.join(' '),/공급업체/);
  const valid=prepareCatalogImport({items:[item({criteria:'',source:'',warnings:''})]});
  assert.equal(valid.ready,true);assert.equal(valid.added,1);assert.equal(valid.rows[0].item.criteria,'');
});

test('품목 가져오기는 사용중지 품목·구분기호가 다른 기존 도번을 덮어쓰지 않는다',()=>{
  const plan=prepareCatalogImport({items:[item(),item({drawing:'TEST-PR-9002',kind:'part'})]},[{drawing:'test_as_9001',active:false,name:'기존 이름'}]);
  assert.equal(plan.ready,true);assert.equal(plan.skipped,1);assert.equal(plan.added,1);assert.equal(plan.rows[0].status,'existing');
});

test('품목 파일 안의 정규화 중복은 모든 관련 행을 오류로 표시한다',()=>{
  const plan=prepareCatalogImport({items:[item(),item({drawing:'test as 9001',name:'다른 이름'})]});
  assert.equal(plan.ready,false);assert.equal(plan.rows.every(row=>row.status==='error'),true);assert.equal(plan.added,0);assert.match(plan.errors.join(' '),/같은 도면번호/);
});
