import {readFileSync,lstatSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
// Never print or persist the OAuth/API token. Wrangler login owns its file.
export function cloudflareToken(){
  if(process.env.CLOUDFLARE_API_TOKEN)return process.env.CLOUDFLARE_API_TOKEN;
  for(const file of [join(homedir(),'.config/.wrangler/config/default.toml'),join(homedir(),'.wrangler/config/default.toml')]){
    try{const match=readFileSync(file,'utf8').match(/^oauth_token\s*=\s*("[^"\n]+")/m);if(match)return JSON.parse(match[1]);}catch{}
  }
  throw Error('Cloudflare login or a scoped API token is required; do not paste tokens into chat.');
}
// Billing-only credentials remain separate from deployment/telemetry OAuth.
export function cloudflareBillingToken(){
  const file=process.env.CLOUDFLARE_BILLING_TOKEN_FILE||'private/cloudflare-billing-token.txt';
  if(!existsSync(file))return cloudflareToken();
  const stat=lstatSync(file);
  if(!stat.isFile()||(stat.mode&0o777)!==0o600)throw Error('Billing token file must be a regular file with permissions 600.');
  const token=readFileSync(file,'utf8').trim();
  if(!token||/[^\x21-\x7e]/.test(token))throw Error('Invalid Billing token format; value not displayed.');
  return token;
}
export function cloudflareObservabilityToken(){
  const file=process.env.CLOUDFLARE_OBSERVABILITY_TOKEN_FILE||'private/cloudflare-observability-token.txt';
  if(!existsSync(file))return cloudflareToken();
  const stat=lstatSync(file);
  if(!stat.isFile()||(stat.mode&0o777)!==0o600)throw Error('Observability token file must be a regular file with permissions 600.');
  const token=readFileSync(file,'utf8').trim();
  if(!token||/[^\x21-\x7e]/.test(token))throw Error('Invalid observability token format; value not displayed.');
  return token;
}
