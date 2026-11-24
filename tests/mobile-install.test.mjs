import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {createApplication} from '../lib/application.mjs';
import {createHttpServer} from '../lib/http.mjs';

test('모바일 설치 자료는 공개 HTTP로 올바른 MIME을 제공하고 업무 API는 보호한다',async()=>{
  const f=fixture(),server=createHttpServer(createApplication(f.db,f.config),'http://127.0.0.1');
  try{
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const get=path=>fetch(origin+path,{redirect:'manual'});
    const manifest=await get('/manifest.webmanifest');assert.equal(manifest.status,200);assert.match(manifest.headers.get('content-type'),/^application\/manifest\+json/);assert.equal(manifest.headers.get('cache-control'),'no-store');
    const definition=await manifest.json();assert.equal(definition.display,'standalone');assert.ok(definition.name);assert.ok(definition.icons.some(icon=>icon.src==='/icons/onwork-192.png'));assert.ok(definition.icons.some(icon=>icon.src==='/icons/onwork-512.png'));
    for(const [name,size] of [['onwork-192.png',192],['onwork-512.png',512],['onwork-maskable-512.png',512],['apple-touch-icon.png',180]]){
      const path='/icons/'+name,response=await get(path);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');
      const png=Buffer.from(await response.arrayBuffer());assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
      const head=await fetch(origin+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
    }
    for(const path of ['/api/state','/api/admin/accounts','/api/operations/context'])assert.equal((await get(path)).status,401);
    for(const path of ['/icons/missing.png','/icons/users.sqlite','/sw.js'])assert.equal((await get(path)).status,404);
  }finally{const closed=new Promise(ok=>server.close(ok));server.closeAllConnections();await closed;f.db.close();}
});
