// Integration test: only freshly generated temporary DBs and isolated Compose projects.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../tests/helpers.mjs';
const image=process.argv[2];
assert.ok(image,'Pass a locally built image');
const root=mkdtempSync(join(tmpdir(),'onwork-docker-'));
const data=join(root,'data'),backups=join(root,'backups'),state=join(root,'state'),bundle=join(root,'bundle');
for(const dir of [data,backups,state,bundle])mkdirSync(dir,{mode:0o700});
const project='onwork-test-'+randomUUID().slice(0,8);
const runtime=join(root,'runtime.env');
const uid=process.getuid(),gid=process.getgid();
const env={...process.env,ONWORK_DEPLOY_STATE:state,ONWORK_RUNTIME_ENV:runtime,ONWORK_PROJECT:project};
const tables=['users','employees','tasks','attendance','production','overtime','audit','work_requests','work_request_history','initial_setup'];
function fingerprint(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {return createHash('sha256').update(JSON.stringify(tables.map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))).digest('hex');}
  finally {db.close();}
}
function run(command,args,ok=true) {
  const r=spawnSync(command,args,{env,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
  // Never dump DB contents, passwords, environment, or request/response payloads.
  if(ok && r.status!==0)throw Error(`${command} failed (${r.status}): ${r.stderr?.slice(-3000) || r.error?.code || 'no error details'}`);
  return r;
}
let f;
try {
  f=fixture(join(data,'existing.sqlite'));
  const c=f.client(),a=f.client();await c.login('001');await a.login('ADMIN');
  assert.equal((await c.call('/api/production',{taskId:'t1',good:7,bad:1,requestKey:f.key()})).status,200);
  f.db.prepare("INSERT INTO attendance(id,employee_id,date,in_at,out_at) VALUES('a1','e1','2026-09-27','2026-09-26T23:30:00Z','2026-09-27T09:00:00Z')").run();
  const request=await c.call('/api/work-requests',{type:'annual',startDate:'2026-10-01',endDate:'2026-10-01',allDay:true,reason:'isolated test'});
  assert.equal(request.status,200);
  const item=f.db.prepare('SELECT id,version FROM work_requests').get();
  assert.equal((await a.call('/api/admin/work-requests/decision',{id:item.id,version:item.version,action:'approved',comment:'isolated test'})).status,200);
  f.db.close();
  // Complete the same additive setup marker as a normal restart before comparing data.
  const {openDatabase}=await import('../lib/db.mjs');const db=openDatabase(join(data,'existing.sqlite'));db.close();
  const before=fingerprint(join(data,'existing.sqlite'));
  writeFileSync(runtime,`APP_ORIGIN=https://onwork.test\nSITE_ID=site-1\nDATA_DIR=${data}\nBACKUP_DIR=${backups}\nDB_FILENAME=existing.sqlite\n`,{mode:0o600});
  // The reserved .test domain is used only inside this temporary test, never for deployment.
  const original=readFileSync('deploy/compose.yaml','utf8').replace("'127.0.0.1:3000:3000'","'127.0.0.1::3000'").replace('    init: true',`    init: true\n    user: '${uid}:${gid}'`);
  writeFileSync(join(bundle,'compose.yaml'),original);
  const sha=createHash('sha1').update(project).digest('hex');
  run('docker',['tag',image,`onwork:${sha}`]);
  run('docker',['save','--output',join(bundle,'image.tar'),`onwork:${sha}`]);
  copyFileSync('deploy/release.sh',join(bundle,'release.sh'));
  writeFileSync(join(bundle,'commit.txt'),sha+'\n');
  function checksums(){writeFileSync(join(bundle,'checksums.txt'),['image.tar','compose.yaml','release.sh','commit.txt'].map(n=>`${createHash('sha256').update(readFileSync(join(bundle,n))).digest('hex')}  ${n}`).join('\n')+'\n');}
  checksums();
  run('bash',['deploy/release.sh',bundle]);
  const compose=['compose','--project-name',project,'--env-file',runtime,'-f',join(state,'current','compose.yaml')];
  env.ONWORK_IMAGE=`onwork:${sha}`;
  const cid=run('docker',[...compose,'ps','-q','app']).stdout.trim();
  assert.equal(run('docker',['inspect','--format','{{.State.Health.Status}}',cid]).stdout.trim(),'healthy');
  run('docker',[...compose,'restart','app']);
  run('docker',[...compose,'up','-d','--wait','--wait-timeout','90']);
  assert.equal(fingerprint(join(data,'existing.sqlite')),before,'Restart changed business data');
  run('docker',[...compose,'exec','-T','-e','BACKUP_PATH=/backups/online.sqlite','app','node','scripts/backup.mjs']);
  run('docker',[...compose,'run','--rm','--no-deps','-T','-e','CONFIRM_RESTORE=YES','-e','BACKUP_PATH=/backups/online.sqlite','-e','RESTORE_PATH=/data/restored.sqlite','app','node','scripts/restore.mjs']);
  assert.equal(fingerprint(join(data,'restored.sqlite')),before,'Restore changed business data');
  const restored=new DatabaseSync(join(data,'restored.sqlite'),{readOnly:true});
  assert.equal(restored.prepare('SELECT count(*) n FROM sessions').get().n,0);restored.close();
  const refused=run('docker',[...compose,'run','--rm','--no-deps','-T','-e','CONFIRM_RESTORE=YES','-e','BACKUP_PATH=/backups/online.sqlite','-e','RESTORE_PATH=/data/existing.sqlite','app','node','scripts/restore.mjs'],false);
  assert.notEqual(refused.status,0);assert.equal(fingerprint(join(data,'existing.sqlite')),before);
  run('bash',['deploy/backup.sh']);
  assert.ok(readdirSync(backups).some(n=>n.startsWith('scheduled-')));
  run('bash',['deploy/release.sh',bundle]);
  assert.equal(fingerprint(join(data,'existing.sqlite')),before,'Successful update changed business data');
  // A failed release must restart the previous image, never create the mistyped DB.
  writeFileSync(join(bundle,'compose.yaml'),original.replace('/data/${DB_FILENAME:?Set the existing database filename}','/data/missing.sqlite'));
  checksums();
  const failed=run('bash',['deploy/release.sh',bundle],false);assert.notEqual(failed.status,0);
  assert.ok(failed.stderr.includes('previous image restarted'),'Rollback did not recover previous image');
  assert.ok(!readdirSync(data).includes('missing.sqlite'));
  assert.equal(fingerprint(join(data,'existing.sqlite')),before,'Failed deployment changed business data');
  console.log('Docker verification passed: startup, restart, online backup, restore, overwrite refusal, failed release rollback, account and record preservation.');
} finally {
  if(f?.db.isOpen)f.db.close();
  // Only containers belonging to this random test project are removed; no volumes pruned.
  const current=join(state,'current','compose.yaml');
  run('docker',['compose','--project-name',project,'--env-file',runtime,'-f',current,'down','--remove-orphans'],false);
  rmSync(root,{recursive:true,force:true});
}
