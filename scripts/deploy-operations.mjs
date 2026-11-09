// Called by codespaces-deploy.sh, after isolated installation and regression tests.
import {readFileSync,writeFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateConfig} from './cloudflare-config.mjs';
import {cloudflareBillingToken} from './cloudflare-session.mjs';
import {verifyFreeAccount} from './cloudflare-free-plan.mjs';

export const target={account:'e4ff9b8a159d8def553c7eda4c09cdb3',worker:'onwork-preview-20261007-01',database:'6cf3c747-3708-4f6a-8961-ab4ad9c41686',origin:'https://onwork-preview-20261007-01.hoon426865.workers.dev'};
const requireCheck=(condition,message)=>{if(!condition)throw Error(message);};
const sha256=value=>createHash('sha256').update(value).digest('hex');

export function checkTarget(config){
  validateConfig(config,'preview');
  const preview=config.env.preview;
  requireCheck(config.account_id===target.account&&preview.name===target.worker&&preview.vars.APP_ORIGIN===target.origin,'배포 대상이 기존 온워크와 다릅니다.');
  requireCheck(preview.d1_databases.length===1&&preview.d1_databases[0].binding==='DB'&&preview.d1_databases[0].database_id===target.database,'기존 D1 연결을 확인할 수 없습니다.');
  requireCheck(preview.vars.MAINTENANCE_MODE==='0'&&preview.vars.SITE_ID==='site-1','기존 사이트 설정과 다릅니다.');
  return preview;
}

export function activeDeployment(deployments){
  requireCheck(Array.isArray(deployments)&&deployments.length>0,'기존 Worker 배포 이력을 확인할 수 없습니다.');
  requireCheck(deployments.every(d=>typeof d.created_on==='string'&&Number.isFinite(Date.parse(d.created_on))),'배포 이력 날짜를 확인할 수 없습니다.');
  const latest=[...deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  requireCheck(typeof latest.id==='string'&&latest.id.length>0,'현재 배포 식별자를 확인할 수 없습니다.');
  requireCheck(latest.versions?.length===1&&latest.versions[0].percentage===100&&/^[a-f0-9-]{36}$/i.test(latest.versions[0].version_id),'분할 배포 상태입니다. 기존 버전을 먼저 검토해야 합니다.');
  return {deploymentId:latest.id,versionId:latest.versions[0].version_id};
}

export function checkRemoteVersion(version,config){
  const preview=checkTarget(config),bindings=version.resources?.bindings;
  requireCheck(Array.isArray(bindings),'원격 Worker 연결 정보를 확인할 수 없습니다.');
  requireCheck(bindings.filter(b=>b.type==='d1').length===1&&bindings.some(b=>b.name==='DB'&&b.type==='d1'&&b.id===target.database),'원격 Worker가 다른 DB에 연결되어 있습니다.');
  for(const [name,value] of Object.entries(preview.vars)){
    const binding=bindings.find(b=>b.name===name&&b.type==='plain_text');
    requireCheck(binding?.text===value,`원격 설정 ${name}이 소스와 다릅니다. 기존 설정을 보존하기 위해 중단합니다.`);
  }
  const names=new Set(['DB','ASSETS',...Object.keys(preview.vars)]);
  requireCheck(bindings.every(b=>names.has(b.name)||b.type==='secret_text'),'소스에 없는 원격 연결이 있습니다. 배포를 중단합니다.');
  requireCheck(version.resources.script_runtime?.compatibility_date===config.compatibility_date,'Worker 호환 날짜가 다릅니다.');
  requireCheck((version.resources.script_runtime?.compatibility_flags||[]).length===0,'소스에 없는 Worker 호환 옵션이 있습니다.');
}

export async function checkPublicApp(fetcher=fetch,assetRoot='worker-assets'){
  const result=[];
  async function get(path,status){
    const response=await fetcher(target.origin+path,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
    requireCheck(response.status===status,`배포 후 접속 검사 실패: ${path} (${response.status})`);
    result.push({path,status});return response;
  }
  requireCheck((await (await get('/healthz',200)).json()).status==='ok','DB 상태 검사 실패');
  const setup=await (await get('/api/setup',200)).json();
  requireCheck(setup.authMode==='passkey'&&setup.appOrigin===target.origin&&setup.required===false,'패스키 설정 검사 실패');
  await get('/api/operations/context',401);
  await get('/api/status',401);
  for(const name of ['index.html','app.js','operations.js','operations-domain.js','style.css']){
    const body=Buffer.from(await (await get(name==='index.html'?'/login':'/'+name,200)).arrayBuffer());
    requireCheck(sha256(body)===sha256(readFileSync(join(assetRoot,name))),`배포 파일 불일치: ${name}`);
  }
  return result;
}

export async function deploy(){
  requireCheck(process.env.CODESPACES==='true','Codespaces에서 전용 실행 스크립트를 사용하세요.');
  const run=resolve(process.env.ONWORK_DEPLOY_DIR||'');
  const commit=process.env.ONWORK_DEPLOY_COMMIT;
  requireCheck(/^[a-f0-9]{40}$/.test(commit||'')&&process.cwd()===join(run,'source')&&existsSync(join(run,'logs','verify.log')),'검증한 분리 소스 폴더가 아닙니다.');
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  checkTarget(config);
  requireCheck(!process.env.CLOUDFLARE_API_BASE_URL&&!process.env.CLOUDFLARE_API_ENVIRONMENT,'기본 Cloudflare API 연결을 사용해야 합니다.');
  const env={...process.env,CLOUDFLARE_ACCOUNT_ID:target.account,WRANGLER_SEND_METRICS:'false',CI:'true'};
  let step=0,phase='원격 설정 확인';
  function command(executable,args,{json=false,label='command'}={}){
    const base=join(run,'logs',`${String(++step).padStart(2,'0')}-${label}`);
    const errorFd=openSync(base+'.stderr.log','w',0o600);
    const outputFd=json?null:openSync(base+'.stdout.log','w',0o600);
    let result;
    try{result=spawnSync(executable,args,{env,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore',json?'pipe':outputFd,errorFd]});}
    finally{closeSync(errorFd);if(outputFd!==null)closeSync(outputFd);}
    requireCheck(!result.error&&result.status===0,`${phase} 실패. 진단 파일: ${base}.*.log`);
    if(json){writeFileSync(base+'.json',result.stdout,{mode:0o600});try{return JSON.parse(result.stdout);}catch{throw Error(`${phase}: 응답 형식을 확인할 수 없습니다.`);}}
  }
  const wrangler=(args,options)=>command('./node_modules/.bin/wrangler',[...args,'--env','preview'],options);
  const deployments=label=>activeDeployment(wrangler(['deployments','list','--json'],{json:true,label}));
  const version=(id,label)=>wrangler(['versions','view',id,'--json'],{json:true,label});
  const manifest={source_commit:commit,target,started_at:new Date().toISOString(),status:'started'};
  const save=()=>writeFileSync(join(run,'release.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  save();
  try{
    const before=deployments('deployments-before');
    checkRemoteVersion(version(before.versionId,'version-before'),config);
    manifest.before=before;save();
    phase='무료 요금제 확인';
    await verifyFreeAccount({CLOUDFLARE_ACCOUNT_ID:target.account,CLOUDFLARE_API_TOKEN:cloudflareBillingToken()},(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(30000)}));
    manifest.free_plan_checked_at=new Date().toISOString();save();
    console.log('4/6 기존 DB 전체를 백업하고 복원 사본에서 변경을 검사합니다.');
    phase='DB 백업';
    wrangler(['d1','export','DB','--remote','--output',join(run,'before.sql'),'--skip-confirmation'],{label:'backup-before'});
    phase='DB 복원 및 변경 사전 검사';
    command('python3',['scripts/prepare-operations-upgrade.py','--backup',join(run,'before.sql'),'--out',join(run,'before')],{label:'rehearsal'});
    const plan=JSON.parse(readFileSync(join(run,'before','report.json'),'utf8'));
    manifest.migrations=plan.pending_migrations;save();
    requireCheck(deployments('deployment-recheck').deploymentId===before.deploymentId,'검사 중 다른 배포가 발생했습니다. 변경을 중단합니다.');
    if(plan.pending_migrations.length){
      console.log('5/6 필요한 DB 변경만 적용합니다: '+plan.pending_migrations.join(', '));
      phase='DB 변경 적용';
      const migrationFile=join(run,'before','migration.sql');
      requireCheck(sha256(readFileSync(migrationFile))===plan.migration_sha256,'검증 이후 SQL 파일이 변경됐습니다.');
      // File imports can mix progress text with JSON on stdout. Keep that output
      // as a private log; require exit success and the fresh export/schema check
      // below before deploying code. Never infer the DB state from stdout alone.
      wrangler(['d1','execute','DB','--remote','--file',migrationFile,'--yes'],{label:'migration'});
    }else console.log('5/6 DB 변경이 이미 적용되어 있어 건너뜁니다.');
    phase='DB 변경 후 검사';
    wrangler(['d1','export','DB','--remote','--output',join(run,'after.sql'),'--skip-confirmation'],{label:'backup-after'});
    command('python3',['scripts/prepare-operations-upgrade.py','--backup',join(run,'after.sql'),'--out',join(run,'after'),'--expect-current','--before-report',join(run,'before','report.json')],{label:'post-migration-check'});
    const afterReport=JSON.parse(readFileSync(join(run,'after','report.json'),'utf8'));
    manifest.live_snapshot_changed_tables=afterReport.live_snapshot_changed_tables;
    manifest.database_checked_at=new Date().toISOString();save();
    if(afterReport.live_snapshot_changed_tables.length)console.log('백업 사이에 변경된 테이블이 있어 기록했습니다. 실제 사용자 입력을 덮어쓰지 않습니다.');
    requireCheck(deployments('deployment-pre-publish').deploymentId===before.deploymentId,'DB 검사 중 다른 Worker 배포가 발생했습니다. 코드 배포를 중단합니다.');
    console.log('6/6 기존 온워크 주소에 배포하고 접속·파일·접근 제한을 검사합니다.');
    phase='Worker 배포';
    wrangler(['deploy','--keep-vars','--strict','--no-autoconfig'],{label:'deploy'});
    manifest.status='deployed_checks_pending';save();
    phase='배포 후 검사';
    manifest.after=deployments('deployments-after');
    checkRemoteVersion(version(manifest.after.versionId,'version-after'),config);
    let checks,lastError;
    for(let attempt=0;attempt<5;attempt++){
      try{checks=await checkPublicApp();break;}catch(error){lastError=error;if(attempt<4)await new Promise(r=>setTimeout(r,3000));}
    }
    if(!checks)throw lastError;
    manifest.public_checks=checks;manifest.status='deployed_public_checks_passed';
    manifest.finished_at=new Date().toISOString();save();
    console.log('ONWORK_DEPLOY_OK '+commit.slice(0,12)+' '+manifest.after.versionId);
    console.log(target.origin);
  }catch(error){
    manifest.failed_phase=phase;manifest.error=error.message;save();
    console.error('ONWORK_DEPLOY_STOPPED: '+phase+' — '+error.message);
    console.error('자동 DB 복원·초기화는 하지 않았습니다. 위 상태 줄만 전달해 주세요.');
    throw Error('배포 절차가 중단되었습니다. '+join(run,'release.json'));
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{await deploy();}catch(error){console.error(error.message);process.exitCode=1;}
}
