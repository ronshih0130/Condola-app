import type { Client } from "pg";
import { tx } from "./db";
import { can } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { parseReversal, parseTransfer, type ReverseInput, type TransferInput } from "./owner-transfer-input";
import { currentOwnerTransferStaff, lockOwnerTransferPeriod } from "./owner-transfer-period-lock";

const marker = "b014_owner_transfer_v1";
type Header = { id:string; property_id:string; kind:string; currency:string; effective_date:string; description:string|null; source_table:string|null; source_id:string|null; reverses_transaction_id:string|null; reason:string|null; created_by:string; lease_id:string|null; created_at:string; minor_unit:number };
type Entry = { account:string; amount_minor:string; currency:string; contact_id:string|null; property_id:string|null; lease_id:string|null; invoice_id:string|null; memo:string|null };
type Snapshot = { header:Header; entries:Entry[]; ownerId:string; amountMinor:string };
function permitted(s:Session) { return s.kind === "staff" && !s.needsSandbox && can(s.role,"month.close") && [s.userId,s.orgId,s.liveOrgId,s.sessionId].every(isUuid) && ["live","sandbox"].includes(s.environment); }
async function authorized(c:Client,s:Session) {
 if(!await currentOwnerTransferStaff(c,s))return false;
 const q=await c.query(`SELECT 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=$2 AND m.user_id=$3 AND m.status='active' AND m.role::text=$4 JOIN public.auth_sessions a ON a.id=$5 AND a.user_id=$3 JOIN public.platform_settings f ON f.key='owner_transfers'
 WHERE o.id=$1 AND o.environment::text=$6 AND ((o.environment='live' AND o.id=$2 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$2)) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND o.feature_flags->'owner_transfers'='true'::jsonb AND f.value->'enabled'='true'::jsonb
 AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') AS item(value) WHERE jsonb_typeof(item.value)<>'string' OR (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') ELSE false END AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)`,[s.orgId,s.liveOrgId,s.userId,s.role,s.sessionId,s.environment]); return q.rowCount===1;
}
async function snapshot(c:Client,s:Session,id:string):Promise<Snapshot|null> {
 const h=(await c.query<Header>(`SELECT t.id::text,t.property_id::text,t.kind::text,t.currency::text,t.effective_date::text,t.description,t.source_table,t.source_id::text,t.reverses_transaction_id::text,t.reason,t.created_by::text,t.lease_id::text,t.created_at::text FROM public.ledger_transactions t WHERE t.org_id=$1 AND t.id=$2`,[s.orgId,id])).rows[0];
 if(!h || (h.description!==null && (h.description.length>500 || h.description.trim()!==h.description || !h.description)) || (h.reason!==null && (h.reason.length>500 || h.reason.trim()!==h.reason || !h.reason)) || h.source_table!==marker || h.source_id!==null || h.lease_id!==null || !h.property_id || !h.created_by || !["owner_payout","reversal"].includes(h.kind) || (h.kind==="owner_payout" ? h.reverses_transaction_id!==null || h.reason!==null : !h.reverses_transaction_id || !h.reason || h.description!==null)) return null;
 const e=(await c.query<Entry>(`SELECT account::text,amount_minor::text,currency::text,contact_id::text,property_id::text,lease_id::text,invoice_id::text,memo FROM public.ledger_entries WHERE org_id=$1 AND transaction_id=$2 ORDER BY id`,[s.orgId,id])).rows;
 if(e.length!==2 || e.some(x=>x.currency!==h.currency || x.lease_id!==null || x.invoice_id!==null))return null;
 const memo=e[0].memo;if(typeof memo!=='string'||!/^b014:v1:scale=[0-4]$/.test(memo)||e[1].memo!==memo)return null;
 h.minor_unit=Number(memo.slice(-1));
 const payable=e.find(x=>x.account==="owner_payable"),cash=e.find(x=>x.account==="cash_clearing");
 if(!payable || !cash || !payable.contact_id || payable.property_id!==h.property_id || cash.contact_id!==null || cash.property_id!==h.property_id) return null;
 const amount=BigInt(payable.amount_minor); if((h.kind==="owner_payout"?amount<=0n:amount>=0n) || BigInt(cash.amount_minor)!==-amount) return null;
 return {header:h,entries:e,ownerId:payable.contact_id,amountMinor:(amount<0n?-amount:amount).toString()};
}
async function openPeriod(c:Client,s:Session,day:string) { const r=await c.query(`SELECT 1 FROM public.month_closes WHERE org_id=$1 AND period_month >= date_trunc('month',$2::date)::date LIMIT 1`,[s.orgId,day]);return r.rowCount===0; }
async function ownerContext(c:Client,s:Session,propertyId:string,ownerId:string,day:string) {
 return (await c.query<{currency:string;minor_unit:number}>(`SELECT p.currency::text,c.minor_unit FROM public.properties p JOIN public.currencies c ON c.code=p.currency JOIN public.property_owners po ON po.org_id=p.org_id AND po.property_id=p.id JOIN public.contacts owner ON owner.org_id=po.org_id AND owner.id=po.owner_contact_id WHERE p.org_id=$1 AND p.id=$2 AND owner.id=$3 AND owner.is_owner AND owner.archived_at IS NULL AND p.archived_at IS NULL AND po.effective_from<=$4::date AND (po.effective_to IS NULL OR po.effective_to >= $4::date) LIMIT 1`,[s.orgId,propertyId,ownerId,day])).rows[0] ?? null;
}
function matches(a:Snapshot,b:{requestId:string;propertyId:string;ownerId:string;effectiveDate:string;amountMinor:string;reference:string;expectedCurrency:string;expectedMinorUnit:number},s:Session,currency:string) { const h=a.header;return h.kind==='owner_payout' && h.id===b.requestId && h.property_id===b.propertyId && a.ownerId===b.ownerId && h.effective_date===b.effectiveDate && a.amountMinor===b.amountMinor && h.description===(b.reference||null) && h.currency===currency && h.currency===b.expectedCurrency && h.minor_unit===b.expectedMinorUnit && h.created_by===s.userId; }
async function insertEntries(c:Client,s:Session,id:string,property:string,owner:string,currency:string,amount:string,scale:number,reverse:boolean) {
 const n=BigInt(amount)*(reverse?-1n:1n);await c.query(`INSERT INTO public.ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,memo) VALUES ($1,$2,'owner_payable',$5::bigint,$6,$4,$3,$8),($1,$2,'cash_clearing',$7::bigint,$6,NULL,$3,$8)`,[s.orgId,id,property,owner,n.toString(),currency,(-n).toString(),`b014:v1:scale=${scale}`]);
}
const unavailable={state:"unavailable" as const};
export async function ownerTransferView(s:Session) {
 if(!permitted(s))return null;
 try{return await tx(s.userId,async c=>{await lockOwnerTransferPeriod(c,s.orgId);if(!await authorized(c,s))return null;
 const options=(await c.query<{propertyId:string;ownerId:string;property:string;owner:string;currency:string;minorUnit:number}>(`SELECT DISTINCT p.id::text AS "propertyId",co.id::text AS "ownerId",p.name AS property,co.display_name AS owner,p.currency::text AS currency,cu.minor_unit AS "minorUnit" FROM public.properties p JOIN public.property_owners po ON po.org_id=p.org_id AND po.property_id=p.id JOIN public.contacts co ON co.org_id=po.org_id AND co.id=po.owner_contact_id JOIN public.currencies cu ON cu.code=p.currency WHERE p.org_id=$1 AND p.archived_at IS NULL AND co.archived_at IS NULL AND co.is_owner ORDER BY property,owner`,[s.orgId])).rows;
 const ids=(await c.query<{id:string}>(`SELECT id::text FROM public.ledger_transactions WHERE org_id=$1 AND source_table=$2 ORDER BY created_at DESC,id DESC`,[s.orgId,marker])).rows;
 const records:Snapshot[]=[];for(const {id} of ids){const item=await snapshot(c,s,id);if(!item)return null; records.push(item);}
 const allReversals=(await c.query<{original:string;id:string}>(`SELECT reverses_transaction_id::text AS original,id::text FROM public.ledger_transactions WHERE org_id=$1 AND reverses_transaction_id=ANY($2::uuid[])`,[s.orgId,records.filter(x=>x.header.kind==='owner_payout').map(x=>x.header.id)])).rows;
 if(allReversals.some(r=>!records.some(x=>x.header.id===r.id && x.header.reverses_transaction_id===r.original)))return null;
 for(const item of records.filter(x=>x.header.kind==='reversal')){const original=records.find(x=>x.header.id===item.header.reverses_transaction_id);if(!original || original.header.kind!=='owner_payout' || original.ownerId!==item.ownerId || original.amountMinor!==item.amountMinor || original.header.property_id!==item.header.property_id || original.header.currency!==item.header.currency || original.header.minor_unit!==item.header.minor_unit)return null;}
 if(!await authorized(c,s))return null;return {options,records};},{orgId:s.orgId,environment:s.environment});}catch{return null;}
}
export async function recordOwnerTransfer(s:Session,input:TransferInput) {
 if(!permitted(s))return unavailable;const parsed=input && parseTransfer(input,input.expectedMinorUnit);if(!parsed)return {state:'invalid' as const};
 try{return await tx(s.userId,async c=>{await lockOwnerTransferPeriod(c,s.orgId);if(!await authorized(c,s))return unavailable;
 const prior=await snapshot(c,s,parsed.requestId);if(prior)return matches(prior,parsed,s,prior.header.currency)&&await authorized(c,s)?{state:'recorded' as const,id:prior.header.id}:unavailable;
 if((await c.query(`SELECT 1 FROM public.ledger_transactions WHERE org_id=$1 AND id=$2`,[s.orgId,parsed.requestId])).rowCount)return unavailable;
 const context=await ownerContext(c,s,parsed.propertyId,parsed.ownerId,parsed.effectiveDate);if(!context)return unavailable;if(context.currency!==parsed.expectedCurrency||context.minor_unit!==parsed.expectedMinorUnit)return {state:'stale' as const};
 if(!await openPeriod(c,s,parsed.effectiveDate))return {state:'closed' as const};
 const inserted=await c.query(`INSERT INTO public.ledger_transactions(id,org_id,property_id,kind,currency,effective_date,description,source_table,created_by) VALUES($1,$2,$3,'owner_payout',$4,$5::date,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id`,[parsed.requestId,s.orgId,parsed.propertyId,context.currency,parsed.effectiveDate,parsed.reference||null,marker,s.userId]);
 if(!inserted.rowCount)return unavailable;await insertEntries(c,s,parsed.requestId,parsed.propertyId,parsed.ownerId,context.currency,parsed.amountMinor,parsed.expectedMinorUnit,false);
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');const fresh=await snapshot(c,s,parsed.requestId),freshContext=await ownerContext(c,s,parsed.propertyId,parsed.ownerId,parsed.effectiveDate);if(!fresh||!freshContext||freshContext.currency!==context.currency||freshContext.minor_unit!==parsed.expectedMinorUnit||!matches(fresh,parsed,s,context.currency)||!await authorized(c,s))throw new Error('Transfer unavailable');return {state:'recorded' as const,id:parsed.requestId};
 },{orgId:s.orgId,environment:s.environment});}catch{return unavailable;}
}
export async function reverseOwnerTransfer(s:Session,input:ReverseInput) {
 const parsed=parseReversal(input);if(!permitted(s))return unavailable;if(!parsed)return {state:'invalid' as const};
 try{return await tx(s.userId,async c=>{await lockOwnerTransferPeriod(c,s.orgId);if(!await authorized(c,s))return unavailable;
 const original=await snapshot(c,s,parsed.originalId);if(!original||original.header.kind!=='owner_payout')return unavailable;
 const expected=(x:Snapshot)=>x.header.kind==='reversal'&&x.header.id===parsed.requestId&&x.header.reverses_transaction_id===parsed.originalId&&x.header.created_by===s.userId&&x.header.effective_date===parsed.effectiveDate&&x.header.reason===parsed.reason&&x.header.property_id===original.header.property_id&&x.header.currency===original.header.currency&&x.header.minor_unit===original.header.minor_unit&&x.ownerId===original.ownerId&&x.amountMinor===original.amountMinor;
 const prior=await snapshot(c,s,parsed.requestId);if(prior)return expected(prior)&&await authorized(c,s)?{state:'reversed' as const,id:prior.header.id}:unavailable;
 if(!await openPeriod(c,s,parsed.effectiveDate))return {state:'closed' as const};
 const inserted=await c.query(`INSERT INTO public.ledger_transactions(id,org_id,property_id,kind,currency,effective_date,source_table,reverses_transaction_id,reason,created_by) VALUES($1,$2,$3,'reversal',$4,$5::date,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[parsed.requestId,s.orgId,original.header.property_id,original.header.currency,parsed.effectiveDate,marker,parsed.originalId,parsed.reason,s.userId]);if(!inserted.rowCount)return unavailable;
 await insertEntries(c,s,parsed.requestId,original.header.property_id,original.ownerId,original.header.currency,original.amountMinor,original.header.minor_unit,true);await c.query('SET CONSTRAINTS ALL IMMEDIATE');
 const oldAgain=await snapshot(c,s,parsed.originalId),created=await snapshot(c,s,parsed.requestId);if(!oldAgain||JSON.stringify(oldAgain)!==JSON.stringify(original)||!created||!expected(created)||!await authorized(c,s))throw new Error('Reversal unavailable');return {state:'reversed' as const,id:parsed.requestId};
 },{orgId:s.orgId,environment:s.environment});}catch{return unavailable;}
}
