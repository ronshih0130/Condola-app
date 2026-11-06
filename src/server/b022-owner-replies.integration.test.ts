import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { recordStatementVersion } from "./owner-net-ledger";
import { ownerFinanceRepliesEnabled, ownerReceiptTitleView, saveReceiptTitle, ownerTransferHistory, reportRepliesView, recordReportReply } from "./owner-finance-replies";
import { validateBuyer, VendorReceiptRuleError } from "./vendor-receipt-rules";
import { previewVendorDocument, type VendorDocumentContext } from "./vendor-receipt";
import { recordOwnerTransfer, reverseOwnerTransfer } from "./owner-transfers";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, staff: Session, owner: Session, outsider: Session;
test.before(async()=>{
  clone=await cloneTestDatabase(); db=new Client({connectionString:clone.url}); await db.connect();
  staff=await session(USERS.admin,"staff","admin");
  owner=await session(USERS.owner,"owner",null); outsider=await session(USERS.coastAdmin,"staff","admin",ORG2_ID);
});
test.after(async()=>{await db?.end();await clone?.cleanup();});
test.beforeEach(async()=>{await flag("owner_net_ledger",true);await flag("owner_receipt_title",true);await flag("owner_report_replies",true);});
async function session(userId:string,kind:Session["kind"],role:Session["role"],orgId=ORG_ID):Promise<Session>{
  const id=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`,[id,userId,randomUUID()]);
  return {userId,sessionId:id,orgId,liveOrgId:orgId,environment:"live",kind,role,email:"fixture@example.invalid",name:"Fixture",locale:"en",calendar:"gregorian",leaseId:null};
}
async function flag(key:string,on:boolean){
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($3::text,$4::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,on,ORG_ID,ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($1::text,$2::boolean) WHERE id=ANY($3::uuid[])`,[key,on,[ORG_ID,ORG2_ID]]);
}
async function fixture(){
  const ownerUser=randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[ownerUser,`${ownerUser}@example.invalid`]);
  owner=await session(ownerUser,"owner",null);
  const contact=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,user_id,display_name) VALUES($1,true,$2,'PRIVATE OWNER NAME') RETURNING id`,[ORG_ID,ownerUser])).rows[0].id;
  const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'US','USD','America/Los_Angeles') RETURNING id`,[ORG_ID,randomUUID()])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,'2094-01-01')`,[ORG_ID,property,contact]);
  const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'101') RETURNING id`,[ORG_ID,property])).rows[0].id;
  const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,due_day) VALUES($1,$2,$3,$3,'active','2094-01-01','USD',1000,1) RETURNING id`,[ORG_ID,property,unit])).rows[0].id;
  return {contact,property,lease};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function statement(f:Fixture,month="2095-01",opening="0",status="issued",currency="USD"){
  return (await db.query<{id:string}>(`INSERT INTO owner_statements(org_id,owner_contact_id,currency,period_start,period_end,status,opening_balance_minor,closing_balance_minor,issued_by,issued_at)
    VALUES($1,$2,$3,($4||'-01')::date,(($4||'-01')::date+interval '1 month - 1 day')::date,$5,$6::bigint,$6::bigint,$7,now()) RETURNING id`,[ORG_ID,f.contact,currency,month,status,opening,USERS.admin])).rows[0].id;
}
async function raw(s:Session,sql:string,params:unknown[]=[]){
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[s.userId,s.orgId,s.environment]);
    await db.query("SET LOCAL ROLE authenticated");const result=await db.query(sql,params);await db.query("COMMIT");return result;
  } catch(error){await db.query("ROLLBACK");throw error;}
}
const denied=(error:unknown)=>(error as {code?:string}).code==="42501";
const invalid=(error:unknown)=>(error as {code?:string}).code==="22023";
const immutable=(error:unknown)=>(error as {code?:string}).code==="55000";
async function title(value="Owner supplied title",requestId=randomUUID(),s=owner){return saveReceiptTitle(s,{requestId,title:value});}
async function reply(statementId:string,versionId:string|null=null,requestId=randomUUID(),s=owner){return recordReportReply(s,{statementId,versionId,requestId,kind:"confirm",body:null});}
async function version(statementId:string){
  const result=await recordStatementVersion(staff,{statementId,requestId:randomUUID(),reason:"Updated facts"});
  assert.equal(result.state,"recorded");if(result.state!=="recorded")throw Error("Missing version");return result.versionId;
}
async function facts(){return (await db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM contacts t) contacts,
  (SELECT count(*)::int FROM app.b022_receipt_title_revisions) titles,
  (SELECT count(*)::int FROM app.b022_report_replies) replies,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM owner_statements t) statements,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_transactions t) ledger`)).rows[0];}

test("OFF and malformed flags: no write RPC, no B-022 rows, no contact or financial changes",async()=>{
  const f=await fixture(),id=await statement(f),before=await facts();
  assert.equal(before.titles,0);assert.equal(before.replies,0);
  for(const value of [null,{enabled:false,allowed_org_ids:[ORG_ID]},{enabled:"true",allowed_org_ids:[ORG_ID]},
    {enabled:true,allowed_org_ids:ORG_ID},{enabled:true,allowed_org_ids:[]}]){
    for(const key of ["owner_receipt_title","owner_report_replies"] as const){
      await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key=$2`,[JSON.stringify(value),key]);
      assert.equal(await ownerFinanceRepliesEnabled(db,ORG_ID,key),false);
      assert.equal((await db.query(`SELECT app.b022_flag_on($1,$2) enabled`,[ORG_ID,key])).rows[0].enabled,false);
    }
    const spy=mock.method(Client.prototype,"query");
    try{
      assert.equal(await ownerReceiptTitleView(owner),null);assert.equal(await ownerTransferHistory(owner,id),null);assert.equal(await reportRepliesView(owner,id),null);
      assert.equal((await title()).state,"unavailable");assert.equal((await reply(id)).state,"unavailable");
      assert.equal(spy.mock.calls.some(c=>typeof c.arguments[0]==="string" && /app\.b022_(set|record)_/.test(c.arguments[0])),false);
    }finally{mock.restoreAll();}
    await assert.rejects(()=>raw(owner,`SELECT app.b022_set_receipt_title($1,$2,'Title')`,[ORG_ID,randomUUID()]),denied);
    await assert.rejects(()=>raw(owner,`SELECT app.b022_record_report_reply($1,NULL,$2,'confirm',NULL)`,[id,randomUUID()]),denied);
    assert.deepEqual(await facts(),before);
  }
  for(const key of ["owner_receipt_title","owner_report_replies"] as const){
    await flag(key,true);await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($1::text,'true'::text) WHERE id=$2`,[key,ORG_ID]);
    assert.equal(await ownerFinanceRepliesEnabled(db,ORG_ID,key),false);
    assert.equal((await db.query(`SELECT app.b022_flag_on($1,$2) enabled`,[ORG_ID,key])).rows[0].enabled,false);
    await db.query(`DELETE FROM platform_settings WHERE key=$1`,[key]);
    assert.equal(await ownerFinanceRepliesEnabled(db,ORG_ID,key),false);
  }
  assert.equal((await title()).state,"unavailable");assert.equal((await reply(id)).state,"unavailable");assert.deepEqual(await facts(),before);
});

test("title history, exact replay, conflicting request and validation; buyer has only the supplied title",async()=>{
  const f=await fixture(),request=randomUUID();
  const buyer=async()=>validateBuyer({kind:"owner",receipt_title:(await db.query(`SELECT receipt_title FROM contacts WHERE id=$1`,[f.contact])).rows[0].receipt_title});
  await assert.rejects(buyer,e=>e instanceof VendorReceiptRuleError && e.code==="ownerReceiptTitleMissing");
  const first=await title("First title",request);assert.equal(first.state,"recorded");assert.deepEqual(await title("First title",request),first);
  assert.equal((await title("Different title",request)).state,"unavailable");
  assert.equal((await title("Current title")).state,"recorded");
  assert.deepEqual(await title("First title",request),first); // Retry never restores an obsolete title.
  assert.deepEqual(await buyer(),{kind:"owner",receipt_title:"Current title"});
  const view=await ownerReceiptTitleView(owner);assert.ok(view);assert.equal(view.title,"Current title");
  assert.deepEqual(view.revisions.map(r=>r.title),["Current title","First title"]);
  assert.ok(view.revisions.every(r=>Number.isFinite(Date.parse(r.created_at))));
  for(const value of [""," "," leading","trailing ","\tTitle","Title\n","a\nb","x".repeat(101)]){
    await assert.rejects(()=>raw(owner,`SELECT app.b022_set_receipt_title($1,$2,$3)`,[ORG_ID,randomUUID(),value]),invalid);
    assert.equal((await title(value)).state,"unavailable");
  }
  assert.equal((await title("x".repeat(100))).state,"recorded");
  const before=await facts();
  assert.equal((await title("Staff title",randomUUID(),staff)).state,"unavailable");
  await assert.rejects(()=>raw(staff,`SELECT app.b022_set_receipt_title($1,$2,'Staff')`,[ORG_ID,randomUUID()]),denied);
  const other=await session(USERS.owner2,"owner",null);
  await assert.rejects(()=>raw(other,`SELECT app.b022_set_receipt_title($1,$2,'First title')`,[ORG_ID,request]),denied);
  for(const s of [outsider,{...owner,orgId:ORG2_ID},{...owner,environment:"sandbox" as const}]){
    assert.equal(await ownerReceiptTitleView(s),null);
    await assert.rejects(()=>raw(s,`SELECT app.b022_my_receipt_title($1)`,[ORG_ID]),denied);
  }
  assert.deepEqual(await facts(),before);
  // Existing uniqueness normally prevents ambiguity; exercise the defensive RPC
  // check inside a rolled-back local transaction with that index removed.
  await db.query("BEGIN");
  try {
    await db.query("DROP INDEX public.contacts_org_user_owner_uniq");
    await db.query(`INSERT INTO contacts(org_id,is_owner,user_id,display_name) VALUES($1,true,$2,'Duplicate owner')`,[ORG_ID,owner.userId]);
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[owner.userId,ORG_ID]);
    await db.query("SET LOCAL ROLE authenticated");
    await assert.rejects(()=>db.query(`SELECT app.b022_my_receipt_title($1)`,[ORG_ID]),denied);
  } finally { await db.query("ROLLBACK"); }
});

test("replies bind to latest version, original NULL, idempotent replay, disputes and staff read only",async()=>{
  const f=await fixture(),id=await statement(f),before=await facts();
  assert.deepEqual(await reportRepliesView(owner,id),{replies:[],latestVersionId:null,latestVersionNo:1,confirmedCurrent:false,canReply:true});
  const originalRequest=randomUUID(),original=await reply(id,null,originalRequest);assert.equal(original.state,"recorded");
  assert.equal((await reportRepliesView(owner,id))?.confirmedCurrent,true);
  const v2=await version(id);assert.equal((await reportRepliesView(owner,id))?.confirmedCurrent,false);
  assert.equal((await reply(id)).state,"unavailable");
  const request=randomUUID(),confirmation=await reply(id,v2,request);assert.equal(confirmation.state,"recorded");
  assert.deepEqual(await reply(id,v2,request),confirmation);assert.equal((await reportRepliesView(owner,id))?.confirmedCurrent,true);
  const v3=await version(id);const view=await reportRepliesView(owner,id);assert.ok(view);
  assert.equal(view.latestVersionId,v3);assert.equal(view.latestVersionNo,3);assert.equal(view.confirmedCurrent,false);
  assert.equal((await reply(id,v2)).state,"unavailable");assert.equal((await reply(id,null)).state,"unavailable");
  assert.deepEqual(await reply(id,v2,request),confirmation); // Historical retry is a no-op, not a new confirmation.
  assert.deepEqual(await reply(id,null,originalRequest),original);
  assert.equal((await reply(id,v3,request)).state,"unavailable");
  await flag("owner_net_ledger",false);
  assert.equal((await reportRepliesView(owner,id))?.latestVersionId,v3);assert.equal((await reportRepliesView(owner,id))?.confirmedCurrent,false);
  const dispute={statementId:id,versionId:v3,requestId:randomUUID(),kind:"dispute" as const,body:"Please check the expense"};
  const disputed=await recordReportReply(owner,dispute);assert.equal(disputed.state,"recorded");assert.deepEqual(await recordReportReply(owner,dispute),disputed);
  assert.equal((await recordReportReply(owner,{...dispute,body:"Changed"})).state,"unavailable");
  for(const [kind,body] of [["confirm",""],["confirm","text"],["dispute",null],["dispute",""],["dispute","  "],["dispute"," text"],["dispute","x".repeat(1001)],["other",null]]){
    await assert.rejects(()=>raw(owner,`SELECT app.b022_record_report_reply($1,$2,$3,$4,$5)`,[id,v3,randomUUID(),kind,body]),invalid);
  }
  assert.equal((await recordReportReply(owner,{...dispute,requestId:randomUUID(),body:"x".repeat(1000)})).state,"recorded");
  assert.equal((await reply(id,v3)).state,"recorded");
  const staffView=await reportRepliesView(staff,id);assert.ok(staffView);assert.equal(staffView.canReply,false);assert.equal(staffView.confirmedCurrent,true);
  assert.ok(staffView.replies.every(r=>r.actor_is_owner));assert.equal(staffView.replies.length,5);
  assert.equal((await reply(id,v3,randomUUID(),staff)).state,"unavailable");
  await assert.rejects(()=>raw(staff,`SELECT app.b022_record_report_reply($1,$2,$3,'confirm',NULL)`,[id,v3,randomUUID()]),denied);
  const after=await facts();assert.deepEqual(after.statements,before.statements);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.contacts,before.contacts);
});

test("cross-org, wrong owner, archived owner, expired session, draft and foreign version fail closed",async()=>{
  const f=await fixture(),id=await statement(f),own=owner;
  const other=await fixture(),otherOwner=owner,otherId=await statement(other),foreignVersion=await version(otherId);owner=own;
  for(const s of [outsider,otherOwner,{...own,orgId:ORG2_ID},{...own,environment:"sandbox" as const}]){
    assert.equal(await reportRepliesView(s,id),null);assert.equal(await ownerTransferHistory(s,id),null);
    assert.equal((await reply(id,null,randomUUID(),s)).state,"unavailable");
    for(const fn of ["b022_report_replies_for","b022_owner_transfers_for","b022_report_reply_context"]){
      await assert.rejects(()=>raw(s,`SELECT * FROM app.${fn}($1)`,[id]),denied);
    }
    await assert.rejects(()=>raw(s,`SELECT app.b022_record_report_reply($1,NULL,$2,'confirm',NULL)`,[id,randomUUID()]),denied);
  }
  assert.equal((await reply(id,foreignVersion)).state,"unavailable");
  const draft=await statement(f,"2095-02","0","draft");assert.equal(await reportRepliesView(owner,draft),null);assert.equal(await ownerTransferHistory(staff,draft),null);assert.equal((await reply(draft)).state,"unavailable");
  const req=randomUUID();assert.equal((await reply(id,null,req)).state,"recorded");
  const another=await statement(f,"2095-03");assert.equal((await reply(another,null,req)).state,"unavailable");
  const expired=await session(owner.userId,"owner",null);await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[expired.sessionId]);
  assert.equal((await title("Title",randomUUID(),expired)).state,"unavailable");assert.equal((await reply(id,null,randomUUID(),expired)).state,"unavailable");assert.equal((await reportRepliesView(expired,id))?.canReply,false);
  await db.query(`UPDATE contacts SET archived_at=now() WHERE id=$1`,[f.contact]);
  assert.equal(await ownerReceiptTitleView(owner),null);assert.equal((await title()).state,"unavailable");assert.equal((await reply(id)).state,"unavailable");
});

test("transfer history isolates owner, currency and period; payout and reversal remain separate string amounts",async()=>{
  const f=await fixture(),id=await statement(f),own=owner;await flag("owner_transfers",true);
  const other=await fixture();owner=own;
  const scope={userId:staff.userId,orgId:staff.orgId,liveOrgId:staff.liveOrgId,environment:staff.environment};
  const transfer={requestId:randomUUID(),propertyId:f.property,ownerId:f.contact,effectiveDate:"2095-01-15",amount:"3",reference:"B022 fixture",expectedCurrency:"USD",expectedMinorUnit:2};
  assert.equal((await recordOwnerTransfer(staff,transfer,scope)).state,"recorded");
  const reversal=randomUUID();assert.equal((await reverseOwnerTransfer(staff,{requestId:reversal,originalId:transfer.requestId,effectiveDate:"2095-01-16",reason:"Correction"},scope)).state,"reversed");
  for(const t of [{...transfer,requestId:randomUUID(),effectiveDate:"2095-02-01"},{...transfer,requestId:randomUUID(),propertyId:other.property,ownerId:other.contact}]){
    assert.equal((await recordOwnerTransfer(staff,t,scope)).state,"recorded");
  }
  const before=await facts(),history=await ownerTransferHistory(owner,id);assert.ok(history);assert.equal(history.minorUnit,2);const rows=history.rows;assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>[r.id,r.kind,r.amount_minor,r.currency]),[[reversal,"reversal","300","USD"],[transfer.requestId,"owner_payout","300","USD"]]);
  assert.equal(rows[0].reverses_transaction_id,transfer.requestId);assert.equal(rows[1].reverses_transaction_id,null);
  assert.deepEqual((await ownerTransferHistory(staff,id))?.rows,rows);
  const twd=await statement(f,"2095-01","0","issued","TWD");assert.deepEqual((await ownerTransferHistory(owner,twd))?.rows,[]);
  assert.deepEqual((await facts()).ledger,before.ledger);
  const large=randomUUID(),unrelated=randomUUID();
  await db.query("BEGIN");
  try {
    for(const [transaction,source] of [[large,"b014_owner_transfer_v1"],[unrelated,"unrelated_source"]]){
      await db.query(`INSERT INTO ledger_transactions(id,org_id,property_id,kind,currency,effective_date,source_table,created_by)
        VALUES($1,$2,$3,'owner_payout','USD','2095-01-20',$4,$5)`,[transaction,ORG_ID,f.property,source,staff.userId]);
      await db.query(`INSERT INTO ledger_entries(org_id,transaction_id,property_id,account,amount_minor,currency,contact_id)
        VALUES($1,$2,$3,'owner_payable',9007199254740993,'USD',$4),($1,$2,$3,'cash_clearing',-9007199254740993,'USD',NULL)`,[ORG_ID,transaction,f.property,f.contact]);
    }
    await db.query("COMMIT");
  } catch(error){await db.query("ROLLBACK");throw error;}
  const preciseView=await ownerTransferHistory(owner,id);assert.ok(preciseView);const precise=preciseView.rows;assert.equal(precise.length,3);
  assert.equal(precise.find(r=>r.id===large)?.amount_minor,"9007199254740993");assert.equal(precise.some(r=>r.id===unrelated),false);
});

test("private tables and helpers have no API grants; UPDATE DELETE TRUNCATE are immutable",async()=>{
  const f=await fixture(),id=await statement(f);await title();await reply(id);
  for(const table of ["b022_receipt_title_revisions","b022_report_replies"]){
    const r=await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass`,[`app.${table}`]);assert.equal(r.rows[0].relrowsecurity,true);
    for(const role of ["public","anon","authenticated","service_role"]){
      assert.equal((await db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed`,[role,`app.${table}`])).rows[0].allowed,false);
    }
    for(const sql of [`UPDATE app.${table} SET request_id=request_id`,`DELETE FROM app.${table}`,`TRUNCATE app.${table}`])await assert.rejects(()=>db.query(sql),immutable);
    await assert.rejects(()=>raw(owner,`SELECT * FROM app.${table}`),denied);
  }
  const functions=(await db.query(`SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b022_%'`)).rows;
  const api=new Set(["b022_set_receipt_title","b022_my_receipt_title","b022_owner_transfers_for","b022_record_report_reply","b022_report_replies_for","b022_report_reply_context"]);
  for(const f of functions){
    // The receipt-title guard is a trigger that runs as the invoker (to see the real API role).
    assert.equal(f.prosecdef,f.proname!=="b022_guard_receipt_title");assert.ok(f.proconfig.includes("search_path=pg_catalog, public, app"));
    for(const role of ["public","anon","authenticated","service_role"]){
      const expected=f.proname==="b022_title_token_present" ? role==="authenticated"||role==="service_role" : role==="authenticated" && api.has(f.proname);
      assert.equal((await db.query(`SELECT has_function_privilege($1,$2::oid,'EXECUTE') allowed`,[role,f.oid])).rows[0].allowed,expected);
    }
  }
});


test("existing vendor receipt loader blocks empty owner title and emits only kind plus receipt_title",async()=>{
  const f=await fixture();
  await db.query(`UPDATE property_owners SET effective_from=current_date WHERE owner_contact_id=$1`,[f.contact]);
  await db.query(`UPDATE properties SET address_display='Synthetic work address' WHERE id=$1`,[f.property]);
  await db.query(`UPDATE contacts SET phone_e164='+12025550123',email='private-owner@example.invalid' WHERE id=$1`,[f.contact]);
  const vendor=(await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'Synthetic vendor') RETURNING id`,[ORG_ID])).rows[0].id;
  const profile=(await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
    VALUES($1,$2,'B022TEST','individual','Synthetic vendor','+12025550124') RETURNING id`,[ORG_ID,vendor])).rows[0].id;
  const ticket=(await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','Synthetic repair',$3,'TWD',10000,'{"pricing":{"mode":"lump_sum"}}'::jsonb) RETURNING id`,[ORG_ID,f.property,vendor])).rows[0].id;
  const context:VendorDocumentContext={actor:staff,ticketId:ticket,vendorProfileId:profile,buyer:{kind:"owner",contactId:f.contact},
    items:[{name:"Repair",quantity:1,unit:"job",unit_price_minor:100,amount_minor:100,category:"service"}],totalMinor:100,
    documentDate:"2026-01-01",fontBytes:readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf",import.meta.url))};
  // The service boundary deliberately sanitizes the domain error. The direct
  // validateBuyer test above asserts its exact ownerReceiptTitleMissing code.
  await assert.rejects(()=>previewVendorDocument(context),{message:"errors.generic"});
  assert.equal((await title("Owner entered receipt title")).state,"recorded");
  const result=await previewVendorDocument(context);
  assert.deepEqual(result.document.buyer,{kind:"owner",receipt_title:"Owner entered receipt title"});
  assert.doesNotMatch(JSON.stringify(result.document.buyer),/PRIVATE OWNER NAME|private-owner|12025550123/);
  assert.ok(result.bytes.length>0);
});

test("BLK-MAC-15: legacy vendor profile without version rows previews from live columns; history without the current version fails closed",async()=>{
  const f=await fixture();
  await db.query(`UPDATE property_owners SET effective_from=current_date WHERE owner_contact_id=$1`,[f.contact]);
  await db.query(`UPDATE properties SET address_display='Synthetic work address' WHERE id=$1`,[f.property]);
  assert.equal((await title("Legacy receipt title")).state,"recorded");
  const vendor=(await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'Legacy vendor') RETURNING id`,[ORG_ID])).rows[0].id;
  const profile=(await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
    VALUES($1,$2,'B022LEGACY','individual','Legacy live name','+12025550126') RETURNING id`,[ORG_ID,vendor])).rows[0].id;
  assert.equal((await db.query(`SELECT count(*)::int n FROM vendor_profile_versions WHERE vendor_profile_id=$1`,[profile])).rows[0].n,0);
  const ticket=(await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','Legacy repair',$3,'TWD',10000,'{"pricing":{"mode":"lump_sum"}}'::jsonb) RETURNING id`,[ORG_ID,f.property,vendor])).rows[0].id;
  const context:VendorDocumentContext={actor:staff,ticketId:ticket,vendorProfileId:profile,buyer:{kind:"owner",contactId:f.contact},
    items:[{name:"Repair",quantity:1,unit:"job",unit_price_minor:100,amount_minor:100,category:"service"}],totalMinor:100,
    documentDate:"2026-01-01",fontBytes:readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf",import.meta.url))};
  const legacy=await previewVendorDocument(context);
  assert.deepEqual(legacy.document.buyer,{kind:"owner",receipt_title:"Legacy receipt title"});
  assert.equal(legacy.document.total_minor,100);
  assert.ok(legacy.bytes.length>0);
  // A history row exists but none for the profile's current_version: inconsistent snapshot state fails closed.
  const current=Number((await db.query(`SELECT current_version FROM vendor_profiles WHERE id=$1`,[profile])).rows[0].current_version);
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,phone_e164)
    VALUES($1,$2,$3,'individual','Stale snapshot name','+12025550126')`,[ORG_ID,profile,current+7]);
  await assert.rejects(()=>previewVendorDocument(context),{message:"errors.notFound"});
});

async function waitForBlocked(){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    await db.query("SELECT pg_stat_clear_snapshot()");
    const r=await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`);
    if(r.rowCount)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error("Expected a blocked B-022 writer");
}

test("concurrent retries append once and flag OFF during a title lock wait rejects the write",async()=>{
  const f=await fixture(),request=randomUUID();
  const results=await Promise.all([title("Concurrent title",request),title("Concurrent title",request)]);
  assert.equal(results[0].state,"recorded");assert.deepEqual(results[0],results[1]);
  assert.equal((await ownerReceiptTitleView(owner))?.revisions.length,1);
  let waiting:ReturnType<typeof title>|undefined;
  await db.query("BEGIN");
  try{
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('b022_title:'||$1::text,0))`,[f.contact]);
    waiting=title("Must not be saved");await waitForBlocked();
    await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='owner_receipt_title'`);
    await db.query("COMMIT");assert.equal((await waiting).state,"unavailable");
  } finally {await db.query("ROLLBACK");await waiting;}
  assert.equal((await db.query(`SELECT receipt_title FROM contacts WHERE id=$1`,[f.contact])).rows[0].receipt_title,"Concurrent title");
});

test("a reply waiting on B-014 version creation rejects the now-obsolete version",async()=>{
  const f=await fixture(),id=await statement(f),v2=await version(id);
  let waiting:ReturnType<typeof reply>|undefined;
  await db.query("BEGIN");
  try{
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('b014_version:'||$1::text,0))`,[id]);
    waiting=reply(id,v2);await waitForBlocked();
    await db.query(`INSERT INTO app.b014_statement_versions(org_id,statement_id,version_no,request_id,reason,actor_user_id,snapshot,closing_minor,fingerprint)
      SELECT org_id,statement_id,3,$2,'Concurrent update',actor_user_id,snapshot,closing_minor,fingerprint FROM app.b014_statement_versions WHERE id=$1`,[v2,randomUUID()]);
    await db.query("COMMIT");assert.equal((await waiting).state,"unavailable");
  } finally {await db.query("ROLLBACK");await waiting;}
  const view=await reportRepliesView(owner,id);assert.equal(view?.latestVersionNo,3);assert.equal(view?.confirmedCurrent,false);assert.deepEqual(view?.replies,[]);
});

test("QA r1: receipt_title cannot be written directly by staff or service_role, only via the owner RPC",async()=>{
  const f=await fixture();
  for(const role of ["authenticated","service_role"]){
    await db.query("BEGIN");
    try{
      await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[staff.userId,ORG_ID]);
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(()=>db.query(`UPDATE public.contacts SET receipt_title='Staff supplied' WHERE id=$1`,[f.contact]),(e:unknown)=>(e as {code?:string}).code==="42501");
    } finally { await db.query("ROLLBACK"); }
  }
  assert.equal((await db.query<{t:string|null}>(`SELECT receipt_title t FROM contacts WHERE id=$1`,[f.contact])).rows[0].t,null);
});

test("QA r2: staff rebinding an owner contact to themselves cannot set the title or reply as owner",async()=>{
  const f=await fixture();await flag("owner_receipt_title",true);await flag("owner_report_replies",true);
  const id=await statement(f);
  // Staff (active org member) points the owner contact at their own user, then tries the owner-only RPCs.
  await db.query(`UPDATE contacts SET user_id=$1 WHERE id=$2`,[staff.userId,f.contact]);
  const staffAsOwner={...staff,kind:"owner" as const,role:null};
  assert.equal((await saveReceiptTitle(staffAsOwner,{requestId:randomUUID(),title:"Staff supplied"})).state,"unavailable");
  assert.equal((await recordReportReply(staffAsOwner,{statementId:id,versionId:null,requestId:randomUUID(),kind:"confirm",body:null})).state,"unavailable");
  assert.equal((await db.query<{t:string|null}>(`SELECT receipt_title t FROM contacts WHERE id=$1`,[f.contact])).rows[0].t,null);
  assert.equal((await db.query(`SELECT 1 FROM app.b022_report_replies WHERE statement_id=$1`,[id])).rowCount,0);
});
