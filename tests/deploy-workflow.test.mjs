import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,cpSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const repo=resolve('.');
const fakeWrangler=String.raw`
import {readFileSync,writeFileSync,copyFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.ONWORK_DEPLOY_DIR,mode=process.env.ONWORK_TEST_MODE,args=process.argv.slice(2);
const event=args.slice(0,2).join(' ');appendFileSync(join(root,'events.txt'),event+'\n');
const applied=()=>mode==='already-applied'||existsSync(join(root,'applied'));
const deployed=()=>existsSync(join(root,'deployed'));
const versionId=()=>deployed()?'22222222-2222-2222-2222-222222222222':'11111111-1111-1111-1111-111111111111';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
if(event==='deployments list'){
  console.log(JSON.stringify([{id:deployed()?'new-deployment':'old-deployment',created_on:'2026-11-09T01:00:00Z',versions:[{version_id:versionId(),percentage:100}]}]));
}else if(event==='versions view'){
  console.log(JSON.stringify({id:versionId(),resources:{bindings:[{name:'DB',type:'d1',id:config.env.preview.d1_databases[0].database_id},{name:'ASSETS',type:'assets'},...Object.entries(config.env.preview.vars).map(([name,text])=>({name,type:'plain_text',text}))],script_runtime:{compatibility_date:config.compatibility_date}}}));
}else if(event==='d1 export'){
  const output=args[args.indexOf('--output')+1];
  copyFileSync(join(root,applied()&&mode!=='incomplete-schema'?'stage9.sql':'stage8.sql'),output);
  console.log('Synthetic export complete');
}else if(event==='d1 execute'){
  if(mode==='migration-failed'){console.error('Synthetic import failure');process.exit(1);}
  if(applied()){console.error('Migration was already applied');process.exit(2);}
  const sql=readFileSync(args[args.indexOf('--file')+1],'utf8');
  if(!sql.includes('CREATE TABLE ops_deliveries'))process.exit(3);
  writeFileSync(join(root,'applied'),'yes');
  // Reproduce Wrangler's successful import with non-JSON progress output.
  console.log('Uploading file...\nProcessing import...\n[{"success":true}]');
}else if(args[0]==='deploy'){
  if(!applied())process.exit(4);
  writeFileSync(join(root,'deployed'),'yes');console.log('Synthetic deployment complete');
}else {console.error('Unexpected synthetic CLI command');process.exit(5);}
`;

// All network calls are intercepted in a child process; an unknown URL fails.
const fakeNetwork=String.raw`
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
globalThis.fetch=async(input)=>{
  const url=new URL(input);
  if(url.href==='https://api.cloudflare.com/client/v4/accounts/'+config.account_id+'/subscriptions')return Response.json({success:true,result:[]});
  if(url.origin!==config.env.preview.vars.APP_ORIGIN)throw Error('Unexpected network target in offline test');
  if(url.pathname==='/healthz')return Response.json({status:'ok'});
  if(url.pathname==='/api/setup')return Response.json({authMode:'passkey',required:false,appOrigin:config.env.preview.vars.APP_ORIGIN});
  if(['/api/operations/context','/api/status'].includes(url.pathname))return Response.json({}, {status:401});
  const file=url.pathname==='/login'?'index.html':url.pathname.slice(1);
  if(!['index.html','app.js','operations.js','operations-domain.js','style.css'].includes(file))throw Error('Unexpected asset in offline test');
  return new Response(readFileSync(join('worker-assets',file)));
};
`;

function workflow(mode){
  const run=mkdtempSync(join(tmpdir(),'onwork-deploy-workflow-')),source=join(run,'source');
  try{
    for(const dir of ['logs','source/scripts','source/node_modules/.bin','source/worker-assets'])mkdirSync(join(run,dir),{recursive:true});
    copyFileSync(join(repo,'wrangler.jsonc'),join(source,'wrangler.jsonc'));
    copyFileSync(join(repo,'scripts/prepare-operations-upgrade.py'),join(source,'scripts/prepare-operations-upgrade.py'));
    cpSync(join(repo,'migrations'),join(source,'migrations'),{recursive:true});
    writeFileSync(join(run,'logs/verify.log'),'Synthetic regression prerequisite');
    writeFileSync(join(source,'package.json'),' {"type":"module"}');
    for(const file of ['index.html','app.js','operations.js','operations-domain.js','style.css'])writeFileSync(join(source,'worker-assets',file),'synthetic '+file);
    writeFileSync(join(source,'node_modules/.bin/wrangler'),'#!'+process.execPath+'\n'+fakeWrangler,{mode:0o700});
    writeFileSync(join(source,'offline-network.mjs'),fakeNetwork);
    execFileSync('python3',['-c',String.raw`
import pathlib, sqlite3, sys
root=pathlib.Path(sys.argv[1]); db=sqlite3.connect(':memory:')
files=sorted((root/'source/migrations').glob('*.sql'))
for file in files[:8]: db.executescript(file.read_text())
db.execute("INSERT INTO users(id,login,password_hash,role,must_change) VALUES('synthetic-admin','ADMIN','synthetic','admin',0)")
(root/'stage8.sql').write_text('\n'.join(db.iterdump()))
db.executescript(files[8].read_text())
(root/'stage9.sql').write_text('\n'.join(db.iterdump()))
db.close()
`,run]);
    const result=spawnSync(process.execPath,['--import',join(source,'offline-network.mjs'),join(repo,'scripts/deploy-operations.mjs')],{
      cwd:source,encoding:'utf8',timeout:30000,
      env:{...process.env,CODESPACES:'true',ONWORK_DEPLOY_DIR:run,ONWORK_DEPLOY_COMMIT:'a'.repeat(40),ONWORK_TEST_MODE:mode,CLOUDFLARE_API_TOKEN:'synthetic-test-only',CLOUDFLARE_BILLING_TOKEN_FILE:join(run,'absent-billing-token'),CLOUDFLARE_API_BASE_URL:'',CLOUDFLARE_API_ENVIRONMENT:''},
    });
    assert.ifError(result.error);
    return {result,events:readFileSync(join(run,'events.txt'),'utf8').trim().split('\n'),manifest:JSON.parse(readFileSync(join(run,'release.json'),'utf8')),deployed:existsSync(join(run,'deployed'))};
  }finally{rmSync(run,{recursive:true,force:true});}
}

test('배포 절차: DB 가져오기 진행 문구가 섞여도 재검사 후 코드 배포까지 완료한다',()=>{
  const {result,events,manifest,deployed}=workflow('mixed-output');
  assert.equal(result.status,0,result.stderr);assert.equal(deployed,true);
  assert.match(result.stdout,/ONWORK_DEPLOY_OK/);
  assert.equal(events.filter(e=>e==='d1 execute').length,1);
  assert.equal(events.filter(e=>e==='d1 export').length,2);
  assert.ok(events.lastIndexOf('d1 export')<events.findIndex(e=>e.startsWith('deploy --')));
  assert.equal(manifest.status,'deployed_public_checks_passed');
});

test('배포 절차: DB 변경 후 중단된 작업의 재실행은 완료된 마이그레이션을 건너뛴다',()=>{
  const {result,events,manifest,deployed}=workflow('already-applied');
  assert.equal(result.status,0,result.stderr);assert.equal(deployed,true);
  assert.equal(events.includes('d1 execute'),false);assert.deepEqual(manifest.migrations,[]);
});

test('배포 절차: 가져오기 성공 응답만으로 배포하지 않고 실제 사후 스키마를 검사한다',()=>{
  const {result,manifest,deployed}=workflow('incomplete-schema');
  assert.equal(result.status,1);assert.equal(deployed,false);
  assert.equal(manifest.failed_phase,'DB 변경 후 검사');
});

test('배포 절차: DB 명령 실패를 무시하지 않고 코드 배포 전에 중단한다',()=>{
  const {result,manifest,deployed}=workflow('migration-failed');
  assert.equal(result.status,1);assert.equal(deployed,false);
  assert.equal(manifest.failed_phase,'DB 변경 적용');
});
