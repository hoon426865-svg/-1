// A protocol-level test authenticator. Not a mock verifier: responses are real
// ES256 signatures validated by SimpleWebAuthn inside workerd.
import {generateKeyPairSync,createHash,sign,randomBytes} from 'node:crypto';
import {encodeCBOR} from '@levischuck/tiny-cbor';
export const b64=value=>Buffer.from(value).toString('base64url');
export const hash=value=>createHash('sha256').update(value).digest();
export function issuer(){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {...keys,publicJwk:JSON.stringify(keys.publicKey.export({format:'jwk'}))};}
export function ticket(keys,account,origin,changes={}){
  const now=Math.floor(Date.now()/1000),message=b64(JSON.stringify({alg:'ES256',typ:'onwork-enrollment'}))+'.'+b64(JSON.stringify({sub:account.id,passwordDigest:hash(account.password_hash).toString('hex'),aud:origin,purpose:'enroll',iat:now,exp:now+900,nonce:b64(randomBytes(32)),...changes}));
  return message+'.'+sign('sha256',Buffer.from(message),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
export function authenticator(origin,userId){
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pub=keys.publicKey.export({format:'jwk'}),id=randomBytes(32);let counter=0;
  const rp=hash(new URL(origin).hostname);
  const clientData=(challenge,type,overrides={})=>Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false,...overrides}));
  return {
    register(options,{uv=true,clientOverrides={}}={}){
      const length=Buffer.alloc(2);length.writeUInt16BE(id.length);
      const cose=encodeCBOR(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(pub.x,'base64url'))],[-3,new Uint8Array(Buffer.from(pub.y,'base64url'))]]));
      const auth=Buffer.concat([rp,Buffer.from([uv?0x45:0x41]),Buffer.alloc(4),Buffer.alloc(16),length,id,Buffer.from(cose)]);
      const attestation=encodeCBOR(new Map([['fmt','none'],['authData',new Uint8Array(auth)],['attStmt',new Map()]]));
      return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{credProps:{rk:true}},response:{clientDataJSON:b64(clientData(options.challenge,'webauthn.create',clientOverrides)),attestationObject:b64(attestation),transports:['internal']}};
    },
    login(options,{uv=true,clientOverrides={},badSignature=false,userHandle=userId}={}){
      const count=Buffer.alloc(4);count.writeUInt32BE(++counter);
      const auth=Buffer.concat([rp,Buffer.from([uv?5:1]),count]),client=clientData(options.challenge,'webauthn.get',clientOverrides),signature=sign('sha256',Buffer.concat([auth,hash(client)]),keys.privateKey);
      if(badSignature)signature[signature.length-1]^=1;
      return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(client),authenticatorData:b64(auth),signature:b64(signature),userHandle:b64(Buffer.from(userHandle))}};
    },
  };
}
