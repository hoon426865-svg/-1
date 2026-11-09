import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {applySql} from './helpers.mjs';
import {checkPublicApp,target} from '../../scripts/deploy-operations.mjs';

test('배포 후 접속 검사를 실제 Worker 번들과 격리 DB에 실행한다',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({
    name:'onwork-deploy-check',modules:true,scriptPath:resolve('dist/worker/index.js'),compatibilityDate:'2026-09-30',
    d1Databases:{DB:'deployment-check-only'},
    bindings:{APP_ORIGIN:target.origin,SITE_ID:'site-1',ENVIRONMENT:'preview',AUTH_MODE:'passkey',MAINTENANCE_MODE:'0'},
    serviceBindings:{ASSETS:async request=>{
      try{return new Response(await readFile(resolve('worker-assets'+new URL(request.url).pathname)));}
      catch{return new Response('missing',{status:404});}
    }},
  }));
  try{
    const db=await mf.getD1Database('DB');
    for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await applySql(db,'migrations/'+name);
    const checks=await checkPublicApp((url,options)=>mf.dispatchFetch(url,options));
    assert.equal(checks.length,8);
    assert.ok(checks.some(check=>check.path==='/login'&&check.status===200));
    assert.equal((await db.prepare('SELECT count(*) n FROM users').first()).n,0);
  }finally{await mf.dispose();}
});
