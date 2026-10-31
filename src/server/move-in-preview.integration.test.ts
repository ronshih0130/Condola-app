import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { buildStoredConsent } from "./consent";
import { tx } from "./db";
import { billingPreviewAuthorityOn } from "./billing-preview-authority";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { issueMoveInInvoice } from "./move-in-invoice";
import { moveInPreview } from "./move-in-preview";
import { resetAndSeed } from "./seed";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import type { Session } from "./types";

const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE), previous=process.env.DATABASE_URL;
let admin:Client, db:Client, name:string, owned=false;
let session:Session;
test.before(async()=>{
  const template=decodeURIComponent(source.pathname.slice(1));
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(template)) throw new Error("Invalid template");
  name=`condola_b008_${randomUUID().replaceAll("-","")}`;
  admin=new Client({connectionString:withDatabase(source,"postgres")}); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`); owned=true;
  db=new Client({connectionString:withDatabase(source,name)}); await db.connect(); process.env.DATABASE_URL=withDatabase(source,name);
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try { process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex"); await resetAndSeed(); }
  finally { if(demo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=demo; if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=key; }
  const sid=(await db.query<{id:string}>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id::text`,[USERS.admin,randomUUID()])).rows[0].id;
  const consent=buildStoredConsent("signup");
  await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[USERS.admin,consent.accepted_at,consent.terms_version,consent.privacy_version,consent.source]);
  session={userId:USERS.admin,sessionId:sid,email:"fixture@example.invalid",name:"fixture",kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null,consent};
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
});
test.after(async()=>{ if(previous===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=previous; await db?.end(); if(owned) await admin.query(`DROP DATABASE "${name}"`); await admin?.end(); });
async function fixture(currency:string,rent:number,deposit:number,capture:boolean, orgId=ORG_ID) {
  const label=randomUUID();
  const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW',$3,'Asia/Taipei') RETURNING id`,[orgId,label,currency])).rows[0].id;
  const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,$3) RETURNING id`,[orgId,property,label])).rows[0].id;
  const contact=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,$2) RETURNING id`,[orgId,label])).rows[0].id;
  const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,deposit_amount_minor) VALUES($1,$2,$3,$3,'draft','2028-01-16',$4,$5,$6) RETURNING id`,[orgId,property,unit,currency,rent,deposit])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[orgId,lease,contact]);
  if(capture) { await db.query("BEGIN"); try { await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,orgId]); await db.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]); await db.query("COMMIT"); } catch(e) { await db.query("ROLLBACK"); throw e; } }
  return {lease,property,unit,contact};
}
async function counts() { return (await db.query(`SELECT (SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM invoice_lines)::int lines,(SELECT count(*) FROM ledger_transactions)::int ledger,(SELECT count(*) FROM ledger_entries)::int entries,(SELECT count(*) FROM audit_log)::int audit,(SELECT count(*) FROM notifications)::int notices,(SELECT count(*) FROM deliveries)::int deliveries,(SELECT count(*) FROM message_threads)::int threads,(SELECT coalesce(jsonb_agg(invoice_number ORDER BY invoice_number),'[]'::jsonb) FROM invoices) numbers`)).rows[0]; }
async function issue(lease:string) { await db.query("BEGIN"); try { await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]); await db.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[lease]); const id=await issueMoveInInvoice(db,lease,USERS.admin); await db.query("COMMIT"); return id; } catch(e) { await db.query("ROLLBACK"); throw e; } }
for(const currency of ["TWD","USD"]) for(const capture of [true,false]) for(const positive of [true,false]) test(`${currency} ${capture?"captured":"legacy"} ${positive?"positive":"zero"} preview matches issue and recorded replay`,async()=>{
  const f=await fixture(currency,positive?100000:0,positive?200000:0,capture), before=await counts();
  const estimate=await moveInPreview(session,f.lease); assert.ok(estimate); assert.equal(estimate.kind,"estimate"); if (estimate.kind !== "estimate") throw new Error("expected estimate"); assert.deepEqual(await counts(),before);
  assert.equal(estimate.lines[0].period_start,capture?"2028-01-16":null);
  const invoice=await issue(f.lease), issued=await moveInPreview(session,f.lease); assert.ok(issued); assert.equal(issued.kind,"issued"); if (issued.kind !== "issued") throw new Error("expected issued");
  assert.equal(issued.totalMinor,estimate.totalMinor); assert.deepEqual(issued.lines.map(({type,amount,allocation_id,period_start,period_end})=>({type,amount,allocation_id,period_start,period_end})),estimate.lines.map(({type,amount,allocation_id,period_start,period_end})=>({type,amount,allocation_id,period_start,period_end})));
  const posting=(await db.query<{n:number}>(`SELECT count(*)::int n FROM ledger_transactions WHERE source_table='invoices' AND source_id=$1`,[invoice])).rows[0].n; assert.equal(posting,positive?1:0);
  await db.query(`UPDATE leases SET rent_amount_minor=0,deposit_amount_minor=0 WHERE id=$1`,[f.lease]);
  assert.deepEqual(await moveInPreview(session,f.lease),issued);
});
test("controls, current session, membership, consent, organization and environment fail closed; accountant can view",async()=>{
  const f=await fixture("TWD",100000,0,false);
  const sid=(await db.query<{id:string}>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id::text`,[USERS.accountant,randomUUID()])).rows[0].id;
  const accountantConsent=buildStoredConsent("signup");
  await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[USERS.accountant,accountantConsent.accepted_at,accountantConsent.terms_version,accountantConsent.privacy_version,accountantConsent.source]);
  const accountant={...session,userId:USERS.accountant,sessionId:sid,role:"accountant" as const,consent:accountantConsent}; assert.ok(await moveInPreview(accountant,f.lease));
  assert.equal(await moveInPreview({...session,role:"maintenance"},f.lease),null);
  assert.equal(await moveInPreview({...session,sessionId:randomUUID()},f.lease),null);
  assert.equal(await moveInPreview({...session,consent:null},f.lease),null);
  assert.equal(await moveInPreview({...session,orgId:ORG2_ID},f.lease),null);
  assert.equal(await moveInPreview({...session,environment:"sandbox"},f.lease),null);
  await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[sid]); assert.equal(await moveInPreview(accountant,f.lease),null);
  await db.query(`UPDATE auth_sessions SET expires_at=now()+interval '1 day' WHERE id=$1`,[sid]);
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`,[sid]); assert.equal(await moveInPreview(accountant,f.lease),null);
  await db.query(`UPDATE org_members SET status='suspended' WHERE user_id=$1 AND org_id=$2`,[USERS.accountant,ORG_ID]);
  await db.query(`UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1`,[sid]); assert.equal(await moveInPreview(accountant,f.lease),null);
  await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='billing_previews'`); assert.equal(await moveInPreview(session,f.lease),null);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":"true"}'::jsonb WHERE id=$1`,[ORG_ID]); assert.equal(await moveInPreview(session,f.lease),null);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
});
test("posted and already-linked utilities are excluded; the largest eligible utility matches issuance",async()=>{
  const f=await fixture("TWD",100000,0,false);
  const meter=(await db.query<{id:string}>(`INSERT INTO meters(org_id,property_id,unit_id,utility,rate_minor_per_unit) VALUES($1,$2,$3,'electricity',100) RETURNING id`,[ORG_ID,f.property,f.unit])).rows[0].id;
  const run=(await db.query<{id:string}>(`INSERT INTO utility_allocation_runs(org_id,meter_id,unit_id,period_start,period_end,split_method,rate_source,currency,total_usage,rate_minor_per_unit,total_amount_minor) VALUES($1,$2,$3,'2027-01-01','2027-02-01','none','fixed_rate','TWD',26,100,2600) RETURNING id`,[ORG_ID,meter,f.unit])).rows[0].id;
  const lines=[] as string[];
  for(const [amount,usage,ratio] of [[1000,10,"0.3846153846"],[800,8,"0.3076923077"],[500,5,"0.1923076923"],[300,3,"0.1153846154"]] as const) lines.push((await db.query<{id:string}>(`INSERT INTO utility_allocation_lines(org_id,run_id,lease_id,share_ratio,allocated_usage,amount_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[ORG_ID,run,f.lease,ratio,usage,amount])).rows[0].id);
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,due_date,source) VALUES($1,$2,$3,$4,$5,'TWD',current_date,'utility') RETURNING id`,[ORG_ID,f.property,f.lease,f.contact,randomUUID()])).rows[0].id;
  const postedLine=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'utility','posted',1,1000,1000) RETURNING id`,[ORG_ID,invoice])).rows[0].id;
  await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,allocation_line_id) VALUES($1,$2,2,'utility','linked',1,800,800,$3)`,[ORG_ID,invoice,lines[1]]);
  await db.query("BEGIN");
  try {
    const ledger=(await db.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by) VALUES($1,$2,$3,'invoice','TWD',current_date,'fixture','invoices',$4,$5) RETURNING id`,[ORG_ID,f.property,f.lease,invoice,USERS.admin])).rows[0].id;
    await db.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id,memo) VALUES($1,$2,'tenant_receivable',1800,'TWD',$3,$4,$5,$6,'fixture'),($1,$2,'other_income',-1800,'TWD',$3,$4,$5,$6,'fixture')`,[ORG_ID,ledger,f.contact,f.property,f.lease,invoice]);
    await db.query(`UPDATE invoices SET ledger_transaction_id=$2 WHERE id=$1`,[invoice,ledger]);
    await db.query(`UPDATE utility_allocation_lines SET posted_invoice_id=$2,posted_invoice_line_id=$3,posted_ledger_transaction_id=$4,posted_amount_minor=1000,posted_description='posted' WHERE id=$1`,[lines[0],invoice,postedLine,ledger]);
    await db.query("COMMIT");
  } catch(error) { await db.query("ROLLBACK"); throw error; }
  const before=await counts(), estimate=await moveInPreview(session,f.lease); assert.ok(estimate); assert.equal(estimate.kind,"estimate"); if (estimate.kind !== "estimate") throw new Error("expected estimate"); assert.deepEqual(await counts(),before);
  assert.deepEqual(estimate.lines.filter(l=>l.type==='utility').map(l=>[l.allocation_id,l.amount]),[[lines[2],500]]);
  await issue(f.lease); const issued=await moveInPreview(session,f.lease); assert.ok(issued); assert.equal(issued.kind,"issued"); if (issued.kind !== "issued") throw new Error("expected issued"); assert.equal(issued.totalMinor,estimate.totalMinor); assert.deepEqual(issued.lines.filter(l=>l.type==='utility').map(l=>[l.allocation_id,l.amount]),[[lines[2],500]]);
});
test("actual linked sandbox follows current live membership even without copied membership",async()=>{
  const sandbox=(await db.query<{id:string}>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags,environment,live_org_id) VALUES($1,'TW','TWD','{"billing_previews":true}','sandbox',$2) RETURNING id::text`,[randomUUID(),ORG_ID])).rows[0].id;
  const f=await fixture("TWD",100000,0,false,sandbox);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='billing_previews'`,[ORG_ID,sandbox]);
  const sid=(await db.query<{id:string}>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id::text`,[USERS.coastAdmin,randomUUID()])).rows[0].id;
  const consent=buildStoredConsent("signup"); await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[USERS.coastAdmin,consent.accepted_at,consent.terms_version,consent.privacy_version,consent.source]);
  const person={...session,userId:USERS.coastAdmin,sessionId:sid,role:"accountant" as const,orgId:sandbox,liveOrgId:ORG_ID,environment:"sandbox" as const,consent};
  // Add a new live member after sandbox creation; no sandbox membership is copied.
  await db.query(`INSERT INTO org_members(user_id,org_id,role,status) VALUES($1,$2,'accountant','active')`,[USERS.coastAdmin,ORG_ID]);
  assert.equal((await db.query<{n:number}>(`SELECT count(*)::int n FROM org_members WHERE user_id=$1 AND org_id=$2`,[USERS.coastAdmin,sandbox])).rows[0].n,0);
  assert.ok(await moveInPreview(person,f.lease));
  const pin = await tx(person.userId, async client => {
    const allowed = await billingPreviewAuthorityOn(client,person);
    const state = (await client.query<{pin:string;env:string;role:string}>(`SELECT current_setting('app.active_org_id') AS pin,current_setting('app.env') AS env,current_user AS role`)).rows[0];
    return {allowed,...state};
  }, {orgId:sandbox,environment:"sandbox"}, {isolation:"repeatable read",readOnly:true});
  assert.deepEqual(pin,{allowed:true,pin:sandbox,env:"sandbox",role:"authenticated"});
  // Parent can later be converted to a sandbox linked to another live firm; the child link is unchanged.
  await db.query(`UPDATE organizations SET environment='sandbox',live_org_id=$2 WHERE id=$1`,[ORG_ID,ORG2_ID]);
  try { assert.equal(await moveInPreview(person,f.lease),null); }
  finally { await db.query(`UPDATE organizations SET environment='live',live_org_id=NULL WHERE id=$1`,[ORG_ID]); }
  assert.ok(await moveInPreview(person,f.lease));
  assert.equal(await moveInPreview({...person,environment:"live"},f.lease),null);
  assert.equal(await moveInPreview({...person,liveOrgId:ORG2_ID},f.lease),null);
  await db.query(`UPDATE org_members SET role='maintenance' WHERE user_id=$1 AND org_id=$2`,[USERS.coastAdmin,ORG_ID]);
  assert.equal(await moveInPreview(person,f.lease),null);
});
test("only prospective non-imported activation is estimated; recorded invoice survives lifecycle changes",async()=>{
  const f=await fixture("TWD",100000,0,false);
  for(const status of ["active","ended","terminated","cancelled"]) { await db.query(`UPDATE leases SET status=$2::lease_status WHERE id=$1`,[f.lease,status]); assert.equal(await moveInPreview(session,f.lease),null); }
  await db.query(`UPDATE leases SET status='draft',esign_status='imported' WHERE id=$1`,[f.lease]); assert.equal(await moveInPreview(session,f.lease),null);
  await db.query(`UPDATE leases SET status='pending_signature',esign_status='partially_signed' WHERE id=$1`,[f.lease]); assert.equal((await moveInPreview(session,f.lease))?.kind,"estimate");
  await issue(f.lease); await db.query(`UPDATE leases SET status='ended',esign_status='imported' WHERE id=$1`,[f.lease]); assert.equal((await moveInPreview(session,f.lease))?.kind,"issued");
});
test("invalid captured source shows unavailable while issuance remains strict",async()=>{
  const f=await fixture("TWD",100000,0,true);
  await db.query(`UPDATE leases SET first_period_basis=jsonb_set(first_period_basis,'{version}','"invalid"') WHERE id=$1`,[f.lease]);
  assert.deepEqual(await moveInPreview(session,f.lease),{kind:"unavailable"});
  await assert.rejects(()=>issue(f.lease));
});
