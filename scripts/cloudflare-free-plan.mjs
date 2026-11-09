// Read-only billing lookup. No create/update/cancel subscription API is used.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function assertFreeSubscriptions(subscriptions){
  if(!Array.isArray(subscriptions))throw Error('Cannot verify Workers Free account');
  for(const subscription of subscriptions){
    const plan=subscription.rate_plan;
    if(!plan||typeof plan.id!=='string')throw Error('Unknown subscription: verify account plan before deployment');
    const identifier=[plan.id,plan.public_name,plan.name].filter(Boolean).join(' ');
    if(/workers|d1/i.test(identifier)&&!['workers_free','d1_free'].includes(plan.id))throw Error('Paid or unknown Workers/D1 subscription detected; refusing deployment');
  }
}
export async function verifyFreeAccount(env=process.env,fetcher=fetch){
  if(!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID||'')||!env.CLOUDFLARE_API_TOKEN)throw Error('Cloudflare account ID and scoped API token required');
  const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/subscriptions`,{headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`}});
  const data=await response.json();
  if(!response.ok||!data.success)throw Error('Free plan lookup failed. Grant Billing Read only; never grant Billing Write.');
  if(data.result_info?.total_pages>1)throw Error('Subscription response is paginated; Free status is unverified');
  assertFreeSubscriptions(data.result);
  console.log('Read-only account check found no paid Workers/D1 subscription.');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await verifyFreeAccount();
