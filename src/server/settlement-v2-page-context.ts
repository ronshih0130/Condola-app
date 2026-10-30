import { svc } from "./db";
import { settlementDeadline } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import type { Session } from "./types";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Malformed or missing rollout policy is unavailable, not evidence of OFF. */
export function settlementV2Rollout(policy:unknown,flags:unknown,orgId:string):"on"|"off"|"unavailable" {
 if(!policy||typeof policy!=="object"||Array.isArray(policy)||!flags||typeof flags!=="object"||Array.isArray(flags)||!UUID.test(orgId))return "unavailable";
 const p=policy as Record<string,unknown>,f=flags as Record<string,unknown>,flag=f.deposit_settlements;
 if(typeof p.enabled!=="boolean"||!Array.isArray(p.allowed_org_ids)||p.allowed_org_ids.some(id=>typeof id!=="string"||!UUID.test(id))||!(flag===undefined||typeof flag==="boolean"))return "unavailable";
 return p.enabled&&flag===true&&p.allowed_org_ids.includes(orgId)?"on":"off";
}
/** Current staff authorization comes before exposing even the OFF shell. */
export async function settlementV2PageContext(session:Session,leaseId:string) {
 return svc(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,leaseId);
  const row=(await client.query<{policy:unknown;flags:unknown}>(`SELECT p.value AS policy,o.feature_flags AS flags FROM public.organizations o LEFT JOIN public.platform_settings p ON p.key='deposit_settlements' WHERE o.id=$1`,[session.orgId])).rows[0];
  await settlementDeadline(client,session,leaseId);return settlementV2Rollout(row?.policy,row?.flags,session.orgId);
 });
}
