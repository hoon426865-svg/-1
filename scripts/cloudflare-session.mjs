import {readFileSync} from 'node:fs';
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
