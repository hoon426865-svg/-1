// Generates ONLY synthetic test accounts, never reads the business SQLite.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fixture} from '../tests/helpers.mjs';
const [directory,origin]=process.argv.slice(2),root=resolve('private')+'/';
if(!directory||!/^https:\/\/onwork-preview[a-z0-9-]*\.[a-z0-9-]+\.workers\.dev$/.test(origin||''))throw Error('Private output directory and exact preview workers.dev origin required');
const out=resolve(directory);if(!out.startsWith(root))throw Error('Synthetic fixture must be stored in ignored private/');
mkdirSync(resolve('private'),{recursive:true,mode:0o700});mkdirSync(out,{mode:0o700});
const f=fixture(join(out,'source.sqlite'));
const accounts=f.db.prepare('SELECT id,login,password_hash FROM users ORDER BY id').all();f.db.close();
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
writeFileSync(join(out,'issuer.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
writeFileSync(join(out,'issuer.public.json'),JSON.stringify(publicKey.export({format:'jwk'})),{flag:'wx',mode:0o600});
writeFileSync(join(out,'preview.json'),JSON.stringify({synthetic:true,origin,siteId:'site-1',accounts},null,2)+'\n',{flag:'wx',mode:0o600});
execFileSync('python3',['scripts/export-sqlite-d1.py','--source',join(out,'source.sqlite'),'--out',join(out,'import')],{stdio:'pipe'});
console.log('Private synthetic preview fixture prepared; original DB was not accessed.');
