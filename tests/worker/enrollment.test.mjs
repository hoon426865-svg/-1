import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,verify,createPublicKey} from 'node:crypto';
import {fixture} from '../helpers.mjs';
import {origin} from './helpers.mjs';

test('등록권 발급: 원본 scrypt 비밀번호 검증·읽기 전용 DB·비밀 출력 금지·15분 서명·덮어쓰기 거부',()=>{
  const dir=mkdtempSync(join(tmpdir(),'onwork-enrollment-')),source=join(dir,'source.sqlite'),key=join(dir,'issuer.pem'),out=join(dir,'ticket.txt'),old=fixture(source);
  const fingerprint=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  try{
    const before=[fingerprint(source),fingerprint(source+'-wal')],account=old.db.prepare("SELECT * FROM users WHERE login='001'").get();
    execFileSync('node',['scripts/sign-enrollment.mjs','--generate',key]);
    const code="import importlib.util,json,sys; s=importlib.util.spec_from_file_location('issuer','scripts/passkey-enrollment.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); a=json.load(sys.stdin); m.getpass.getpass=lambda _:a['password']; m.issue(a['source'],'001',a['origin'],a['key'],a['out'])";
    const issue=password=>execFileSync('python3',['-c',code],{input:JSON.stringify({password,source,key,out,origin}),encoding:'utf8',stdio:['pipe','pipe','pipe']});
    assert.throws(()=>issue('incorrect password'));
    const log=issue(old.password);assert.ok(!log.includes(old.password));assert.ok(!log.includes(account.password_hash));
    assert.equal(statSync(out).mode&0o777,0o600);assert.equal(statSync(key).mode&0o777,0o600);
    const [header,payload,signature]=readFileSync(out,'utf8').split('.'),claims=JSON.parse(Buffer.from(payload,'base64url'));
    assert.equal(claims.sub,account.id);assert.equal(claims.aud,origin);assert.equal(claims.exp-claims.iat,900);
    assert.equal(claims.passwordDigest,createHash('sha256').update(account.password_hash).digest('hex'));
    assert.ok(verify('sha256',Buffer.from(header+'.'+payload),{key:createPublicKey({key:JSON.parse(readFileSync(key+'.public.json','utf8')),format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
    assert.throws(()=>issue(old.password));assert.deepEqual([fingerprint(source),fingerprint(source+'-wal')],before);
  }finally{old.db.close();rmSync(dir,{recursive:true,force:true});}
});
