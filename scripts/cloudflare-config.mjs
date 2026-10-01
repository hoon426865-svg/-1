import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function validateConfig(config,environment,attestation){
  const preview=config.env?.preview,production=config.env?.production,selected=config.env?.[environment];
  if(!['preview','production'].includes(environment)||!selected)throw Error('Explicit preview or production environment required');
  const id=e=>e?.d1_databases?.find(d=>d.binding==='DB')?.database_id;
  // A preview does not require provisioning or modifying production first.
  for(const e of environment==='preview'?[preview]:[preview,production]){
    if(e.vars?.AUTH_MODE!=='passkey')throw Error('Free deployment requires passkey authentication');
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id(e)||'')||/^0{8}-/.test(id(e)))throw Error('Configure two real D1 database IDs first');
    if(e.vars?.ENVIRONMENT!== (e===preview?'preview':'production'))throw Error('Environment binding mismatch');
    if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(e.vars?.APP_ORIGIN||'')||/replace/i.test(e.vars.APP_ORIGIN))throw Error('Configure the exact workers.dev HTTPS address');
    if(!e.vars.SITE_ID||/replace/i.test(e.vars.SITE_ID))throw Error('Preserve the existing site ID in production');
    if(e.workers_dev!==true)throw Error('workers.dev must be enabled');
  }
  if(id(preview)===id(production)||preview.vars.APP_ORIGIN===production?.vars?.APP_ORIGIN||preview.name===production?.name)throw Error('Test and production resources must be distinct');
  if(!['0','1'].includes(selected.vars.MAINTENANCE_MODE))throw Error('Maintenance mode must be explicit');
  if(environment==='production'){
    const hash=authenticationHash();
    if(attestation!==hash)throw Error('Free CPU verification is missing or auth code changed. Do not weaken scrypt or enable paid fallback.');
  }
  return true;
}
export function authenticationHash(){const h=createHash('sha256');for(const file of ['worker/security.mjs','worker/passkeys.mjs','worker/passkey-admin.mjs','worker/index.mjs','package-lock.json'])h.update(readFileSync(file));return h.digest('hex');}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv[2]==='--auth-hash')console.log(authenticationHash());
  else {validateConfig(JSON.parse(readFileSync('wrangler.jsonc','utf8')),process.argv[2],process.env.FREE_AUTH_CODE_SHA256);console.log('Cloudflare environment isolation and authentication attestation verified.');}
}
