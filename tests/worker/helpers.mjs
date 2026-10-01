import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hashPassword} from '../../lib/security.mjs';
import {randomUUID} from 'node:crypto';
import {collectPages} from '../../public/worker-pages.js';
import {execFileSync} from 'node:child_process';
export const origin='https://onwork-preview.test.workers.dev';
globalThis.location={origin};

export async function fixture({production=false,empty=false,passkey=false,publicKey=''}={}){
  const password=randomUUID(),hash=hashPassword(password);
  const mf=new Miniflare(convertV4MiniflareOptions({name:'onwork-test',modules:true,scriptPath:resolve('dist/worker/index.js'),compatibilityDate:'2026-09-30',d1Databases:{DB:'test-only'},bindings:{APP_ORIGIN:origin,SITE_ID:'site-1',ENVIRONMENT:production?'production':'preview',AUTH_MODE:passkey?'passkey':'legacy',ENROLLMENT_PUBLIC_KEY:publicKey,MAINTENANCE_MODE:'0'},serviceBindings:{ASSETS:async request=>{
    const path=new URL(request.url).pathname;
    try{return new Response(request.method==='HEAD'?null:await readFile(resolve('worker-assets'+path)),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'text/javascript'}});}catch{return new Response('missing',{status:404});}
  }}}));
  const db=await mf.getD1Database('DB');
  try {
  for(const name of ['0001_existing_schema.sql','0002_workers.sql','0003_passkeys.sql','0004_passkey_administration.sql'])await applySql(db,'migrations/'+name);
  if(!empty){
    await db.batch([
      db.prepare("INSERT INTO users(id,login,password_hash,role,must_change) VALUES('admin','ADMIN',?,'admin',0)").bind(hash),
      ...[['e1','001'],['e2','002']].flatMap(([id,login])=>[
        db.prepare('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)').bind(id,login,'테스트 직원','생산팀','site-1'),
        db.prepare("INSERT INTO users(id,login,password_hash,role,employee_id,must_change) VALUES(?,?,?,'employee',?,0)").bind('u'+id,login,hash,id),
      ]),
      db.prepare("INSERT INTO tasks(id,name) VALUES('t1','조립')"),
    ]);
  }
  } catch(error) { await mf.dispose(); throw error; }
  const client=()=>{
    let cookie='',csrf='';
    const raw=async(path,body,method=body===undefined?'GET':'POST',extra={})=>{
      const response=await mf.dispatchFetch(origin+path,{method,headers:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json','x-csrf-token':csrf}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      const value=await response.text();let data;try{data=JSON.parse(value);}catch{data=value;}
      return {status:response.status,data,headers:response.headers};
    };
    const call=async(...args)=>{const r=await raw(...args);if(r.status===200&&args[1]===undefined)r.data=await collectPages(args[0],r.data,async path=>{const p=await raw(path);if(p.status!==200)throw Object.assign(Error(p.data.error),{status:p.status});return p.data;});return r;};
    return {raw,call,async login(login,supplied=password){const r=await call('/api/login',{login,password:supplied});if(r.status===200)csrf=(await call('/api/me')).data.csrf;return r;},get cookie(){return cookie;},get csrf(){return csrf;}};
  };
  return {mf,db,password,client,close:()=>mf.dispose()};
}
export async function applySql(db,path){
  const statements=JSON.parse(execFileSync('python3',['scripts/sql-statements.py',path],{encoding:'utf8'}));
  for(let i=0;i<statements.length;i+=40)await db.batch(statements.slice(i,i+40).map(sql=>db.prepare(sql)));
}
