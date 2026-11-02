import type { Client } from "pg";
import type { Session } from "./types";

export type PaymentCenterAction = "confirm" | "reject" | "reverse" | "record" | "legacy_match" | "bank_match";
type Kind = "payment_confirmed" | "payment_rejected" | "payment_reversed";
type Context = { client:Client; session:Session; leaseId:string; paymentId:string; action:PaymentCenterAction; kind:Kind; fresh:boolean };
type Ticket = Readonly<{kind:"payment-center"}>;
const contexts = new WeakMap<Ticket,Context>();
const unavailable = () => new Error("Payment notification unavailable");
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Only these fixed private operations may temporarily return to the connection owner. */
async function enter(client:Client) {
  const state=(await client.query<{authenticated:boolean;owner:boolean;jwt:string|null}>(`SELECT current_user='authenticated' AS authenticated,current_user=session_user AS owner,current_setting('request.jwt.claim.sub',true) AS jwt`)).rows[0];
  if (!state.authenticated && !state.owner) throw unavailable();
  await client.query("RESET ROLE");
  const owner=(await client.query<{ok:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner JOIN pg_roles me ON me.rolname=current_user WHERE c.oid=to_regclass('app.b017_occurrences') AND (r.rolname=current_user OR me.rolsuper)) AS ok`)).rows[0].ok;
  if (!owner) throw unavailable();
  return state;
}
async function leave(client:Client,state:Awaited<ReturnType<typeof enter>>) {
  await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[state.jwt ?? ""]);
  if (state.authenticated) await client.query("SET LOCAL ROLE authenticated");
  else await client.query("RESET ROLE");
}
async function authorize(client:Client,session:Session,leaseId:string,action:PaymentCenterAction) {
  const roles=action === "reverse" || action === "legacy_match" || action === "bank_match" ? ["admin","accountant"] : ["admin","manager","accountant"];
  if (session.kind!=="staff" || session.needsSandbox || !roles.includes(session.role ?? "") || !uuid.test(session.sessionId)) throw unavailable();
  // The owner-side bank path does not install a JWT when payment_results is OFF.
  // This value is derived only from the canonical session, checked below, and is
  // restored before the original financial action resumes.
  await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[session.userId]);
  const enabled=(await client.query<{enabled:boolean}>(`SELECT app.b028_center_context($1,$2,$3,$4,'staff',$5) AS enabled`,[session.orgId,session.liveOrgId,session.environment,session.sessionId,session.role])).rows[0].enabled;
  if (!enabled) throw unavailable();
  const lease=await client.query(`SELECT l.id FROM public.leases l JOIN public.properties p ON p.org_id=l.org_id AND p.id=l.property_id WHERE l.org_id=$1 AND l.id=$2 FOR SHARE OF l,p NOWAIT`,[session.orgId,leaseId]);
  if (lease.rowCount!==1) throw unavailable();
}

/** Must run before any source emission or financial transition. Missing/OFF is legacy-compatible. */
export async function beginPaymentCenter(client:Client,session:Session,input:{leaseId:string;paymentId:string;action:PaymentCenterAction}):Promise<Ticket|null> {
  // The ordinary public read is deliberately before any private schema or role
  // operation. OFF/missing/malformed controls must work for a non-owner too.
  const optedIn=(await client.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='notification_center_v2' WHERE o.id=$1 AND o.environment::text=$2 AND ((o.environment='live' AND o.id=$3 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$3)) AND o.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS ok`,[session.orgId,session.environment,session.liveOrgId])).rows[0].ok;
  if (!optedIn) return null;
  const present=(await client.query<{ok:boolean}>(`SELECT to_regprocedure('app.b017_resolve_key(uuid,uuid,text,uuid,uuid,uuid,text)') IS NOT NULL AS ok`)).rows[0].ok;
  if (!present) return null;
  const state=await enter(client);
  await client.query("LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT");
  await client.query(`SELECT id FROM public.organizations WHERE id=$1 FOR SHARE NOWAIT`,[session.orgId]);
  const enabled=(await client.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='notification_center_v2' WHERE o.id=$1 AND o.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS ok`,[session.orgId])).rows[0].ok;
  if (!enabled) {await leave(client,state);return null;}
  if (!uuid.test(input.leaseId) || !uuid.test(input.paymentId) || (state.authenticated && state.jwt!==session.userId) || (state.jwt && state.jwt!==session.userId)) throw unavailable();
  await authorize(client,session,input.leaseId,input.action);
  const kind:Kind=input.action==="reject" ? "payment_rejected" : input.action==="reverse" ? "payment_reversed" : "payment_confirmed";
  if (input.action!=="record") {
    const payment=(await client.query<{lease_id:string;status:string}>(`SELECT p.lease_id::text,p.status::text FROM public.payments p JOIN public.leases l ON l.org_id=p.org_id AND l.id=p.lease_id AND l.property_id=p.property_id WHERE p.org_id=$1 AND p.id=$2 FOR UPDATE OF p NOWAIT`,[session.orgId,input.paymentId])).rows[0];
    if (!payment || payment.lease_id!==input.leaseId) throw unavailable();
    // Replaying an already completed financial action never issues history to a new payer.
    if (payment.status!==(input.action==="reverse" ? "confirmed" : "submitted")) {await leave(client,state);return null;}
  }
  const resolution=(await client.query<{outcome:string}>(`SELECT outcome FROM app.b017_resolve_key($1,$2,$3,NULL,$4,$5,$3)`,[session.orgId,input.leaseId,kind,input.paymentId,session.userId])).rows[0];
  const fresh=resolution.outcome==="new";
  const context:Context={client,session:{...session},...input,kind,fresh};
  const ticket:Ticket=Object.freeze({kind:"payment-center"});
  contexts.set(ticket,context);
  await leave(client,state);
  return ticket;
}

/** Reread committed-business inputs on this same transaction; callers supply no recipient authority. */
export async function finalizePaymentCenter(client:Client,ticket:Ticket|null,sourceId:string|null) {
  if (!ticket) return;
  const context=contexts.get(ticket);
  if (!context || context.client!==client) throw unavailable();
  contexts.delete(ticket);
  const state=await enter(client),{session,leaseId,paymentId,kind,action}=context;
  await authorize(client,session,leaseId,action);
  if (!context.fresh) {await leave(client,state);return;}
  // Locks and the DB source trigger bind the payer snapshot even when no tenant is eligible.
  const payment=(await client.query<{payer:string|null;principal:string|null;eligible:boolean}>(`SELECT p.payer_contact_id::text AS payer,c.user_id::text AS principal,
    EXISTS(SELECT 1 FROM public.contacts ct JOIN public.lease_parties lp ON lp.org_id=ct.org_id AND lp.contact_id=ct.id WHERE ct.org_id=p.org_id AND ct.id=p.payer_contact_id AND ct.user_id IS NOT NULL AND ct.is_tenant AND ct.archived_at IS NULL AND lp.lease_id=p.lease_id AND lp.role IN ('primary','co_tenant')) AS eligible
    FROM public.payments p LEFT JOIN public.contacts c ON c.org_id=p.org_id AND c.id=p.payer_contact_id WHERE p.org_id=$1 AND p.id=$2 AND p.lease_id=$3 AND p.status::text=$4 FOR SHARE OF p NOWAIT`,[session.orgId,paymentId,leaseId,kind.slice(8)])).rows[0];
  if (!payment) throw unavailable();
  if (payment.payer) await client.query(`SELECT id FROM public.contacts WHERE org_id=$1 AND id=$2 FOR SHARE NOWAIT`,[session.orgId,payment.payer]);
  const source=sourceId ? (await client.query<{at:string}>(`SELECT b.created_at::text AS at FROM app.b010_source_events b JOIN app.b017_old_source_transactions t ON t.org_id=b.org_id AND t.source_id=b.id AND t.tx_id=txid_current() WHERE b.id=$1 AND b.org_id=$2 AND b.lease_id=$3 AND b.payment_id=$4 AND b.kind=$5 AND b.occurrence_key=$5 AND b.actor_id=$6 FOR SHARE OF b NOWAIT`,[sourceId,session.orgId,leaseId,paymentId,kind,session.userId])).rows[0] : null;
  if (sourceId && !source) throw unavailable();
  const neutral=(await client.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7,coalesce($8::timestamptz,clock_timestamp())) RETURNING id::text,occurred_at::text AS at`,[session.orgId,leaseId,paymentId,kind,session.userId,payment.payer,payment.principal,source?.at ?? null])).rows[0];
  const event=(await client.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,$2,$3,$4) RETURNING id::text`,[session.orgId,kind,neutral.id,neutral.at])).rows[0];
  if (payment.eligible) await client.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) SELECT $1,$2,'tenant',c.user_id,c.id FROM public.contacts c JOIN public.lease_parties lp ON lp.org_id=c.org_id AND lp.contact_id=c.id WHERE c.org_id=$1 AND c.id=$3 AND c.user_id=$4 AND c.is_tenant AND c.archived_at IS NULL AND lp.lease_id=$5 AND lp.role IN ('primary','co_tenant') LIMIT 1`,[session.orgId,event.id,payment.payer,payment.principal,leaseId]);
  await leave(client,state);
}
