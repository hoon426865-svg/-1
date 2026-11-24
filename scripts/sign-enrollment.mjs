import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {generateKeyPairSync,sign,randomBytes,createPrivateKey} from 'node:crypto';
import {dirname} from 'node:path';
const [keyPath,out]=process.argv.slice(2);
if(keyPath==='--generate'){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  mkdirSync(dirname(out),{recursive:true,mode:0o700});
  writeFileSync(out,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  writeFileSync(out+'.public.json',JSON.stringify(publicKey.export({format:'jwk'})),{flag:'wx',mode:0o600});
  console.log('Enrollment issuer keys generated; keep the private key offline.');
}else{
  if(statSync(keyPath).mode&0o077)throw Error('Issuer private key permissions must be 0600');
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
  const claims=JSON.parse(Buffer.concat(chunks).toString());
  if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(claims.aud)||claims.purpose!=='enroll'||typeof claims.sub!=='string'||!/^[a-f0-9]{64}$/.test(claims.passwordDigest))throw Error('Invalid enrollment claims');
  const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const message=encode({alg:'ES256',typ:'onwork-enrollment'})+'.'+encode({...claims,iat:now,exp:now+900,nonce:randomBytes(32).toString('base64url')});
  const signature=sign('sha256',Buffer.from(message),{key:createPrivateKey(readFileSync(keyPath)),dsaEncoding:'ieee-p1363'}).toString('base64url');
  mkdirSync(dirname(out),{recursive:true,mode:0o700});writeFileSync(out,message+'.'+signature,{flag:'wx',mode:0o600});
  console.log('One-time enrollment ticket written privately; expires in 15 minutes.');
}
