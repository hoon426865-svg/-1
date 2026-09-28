import { randomUUID } from 'node:crypto';
import { openDatabase } from '../lib/db.mjs';
import { createApplication } from '../lib/application.mjs';
import { hashPassword } from '../lib/security.mjs';
export function fixture(path=':memory:') {
  const db=openDatabase(path); const password=randomUUID();
  const hash=hashPassword(password);
  db.prepare("INSERT INTO users(id,login,password_hash,role,must_change) VALUES('admin','ADMIN',?,'admin',0)").run(hash);
  for(const [id,login] of [['e1','001'],['e2','002']]){
    db.prepare('INSERT INTO employees(id,number,name,team,site_id) VALUES(?,?,?,?,?)').run(id,login,'동명이인','생산팀','site-1');
    db.prepare("INSERT INTO users(id,login,password_hash,role,employee_id,must_change) VALUES(?,?,?,'employee',?,0)").run('u'+id,login,hash,id);
  }
  db.prepare("INSERT INTO tasks(id,name) VALUES('t1','조립')").run();
  let current=new Date('2026-09-27T23:30:00Z');
  const config={origin:'http://localhost:3000',secure:false,siteId:'site-1'};
  let app=createApplication(db,config,()=>current);
  const client=()=>{
    let cookie='',csrf='';
    const call=async(path,body,method=body?'POST':'GET',extra={})=>{
      const headers={cookie,...(body?{origin:config.origin,'content-type':'application/json','x-csrf-token':csrf}:{}),...extra};
      const response=await app(new Request(config.origin+path,{method,headers,body:body?JSON.stringify(body):undefined}));
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
      return {status:response.status,data,headers:response.headers};
    };
    return {call,async login(login, suppliedPassword=password){const result=await call('/api/login',{login,password:suppliedPassword}); if(result.status===200)csrf=(await call('/api/me')).data.csrf;return result;}};
  };
  return {db,config,client,password,setTime:date=>current=new Date(date),restart:()=>app=createApplication(db,config,()=>current),key:()=>randomUUID()};
}
