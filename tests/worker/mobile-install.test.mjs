import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,origin} from './helpers.mjs';

test('Worker 모바일 설치 자료 공개 MIME·HEAD·캐시 제한과 비로그인 업무 보호',async()=>{
  const f=await fixture({passkey:true});
  try{
    const request=(path,options)=>f.mf.dispatchFetch(origin+path,options);
    const manifest=await request('/manifest.webmanifest');assert.equal(manifest.status,200);assert.match(manifest.headers.get('content-type'),/^application\/manifest\+json/);assert.equal(manifest.headers.get('cache-control'),'no-store');
    const definition=await manifest.json();assert.equal(definition.display,'standalone');assert.ok(definition.icons.some(icon=>icon.purpose==='maskable'));
    for(const [name,size] of [['onwork-192.png',192],['onwork-512.png',512],['onwork-maskable-512.png',512],['apple-touch-icon.png',180]]){
      const path='/icons/'+name,response=await request(path);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');
      const png=Buffer.from(await response.arrayBuffer());assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
      const head=await request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
    }
    for(const path of ['/api/state','/api/admin/accounts','/api/operations/context'])assert.equal((await request(path)).status,401);
    for(const path of ['/icons/missing.png','/icons/users.sqlite','/sw.js'])assert.equal((await request(path)).status,404);
  }finally{await f.close();}
});
