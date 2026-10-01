// scrypt parameters and the legacy salt:hash format are retained byte for byte.
// This is Cloudflare's native node:crypto compatibility API, not a JS polyfill.
import { scrypt, timingSafeEqual } from 'node:crypto';
const encoder = new TextEncoder();
export const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
};
export const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))), b=>b.toString(16).padStart(2,'0')).join('');
const derive = (password,salt) => new Promise((resolve,reject)=>scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024},(error,result)=>error?reject(error):resolve(result)));
export async function hashPassword(password) {
  if(typeof password!=='string' || password.length<12 || password.length>128) throw Object.assign(Error('비밀번호는 12~128자로 입력하세요.'),{status:400});
  const salt=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  return `${salt}:${(await derive(password,salt)).toString('hex')}`;
}
// Fixed, non-account hash avoids doing an additional KDF on every Worker start.
export const dummyHash = '00000000000000000000000000000000:'+ '00'.repeat(64);
export async function verifyPassword(password,stored) {
  if(typeof password!=='string' || password.length>128) return false;
  if(!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored||'')) throw Error('Unsupported password hash; migration must not silently reset accounts');
  const [salt,hash]=stored.split(':');
  return timingSafeEqual(await derive(password,salt),Buffer.from(hash,'hex'));
}
export function settings(env,request) {
  const origin=new URL(env.APP_ORIGIN||'');
  if(origin.origin!==env.APP_ORIGIN || origin.protocol!=='https:' || !origin.hostname.endsWith('.workers.dev') || !env.SITE_ID || !env.DB) throw Error('Configure the exact HTTPS workers.dev origin, SITE_ID and D1 binding');
  if(new URL(request.url).origin!==origin.origin) throw Object.assign(Error('허용되지 않은 주소입니다.'),{status:403});
  return {origin:origin.origin,siteId:env.SITE_ID,maintenance:env.MAINTENANCE_MODE==='1'};
}
