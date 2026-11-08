import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { ownerNetLedgerEnabled, ownerNetLedgerView, recordReportDelivery, recordStatementVersion } from "./owner-net-ledger";
import { buildSnapshot, reconcileSnapshot } from "./owner-net-ledger-rules";
import { recordOwnerTransfer, reverseOwnerTransfer } from "./owner-transfers";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, staff: Session, accountant: Session, owner: Session, outsider: Session;
test.before(async()=>{
  clone=await cloneTestDatabase(); db=new Client({connectionString:clone.url}); await db.connect();
  staff=await session(USERS.admin,"staff","admin"); accountant=await session(USERS.accountant,"staff","accountant");
  owner=await session(USERS.owner,"owner",null); outsider=await session(USERS.coastAdmin,"staff","admin",ORG2_ID);
});
test.after(async()=>{await db?.end();await clone?.cleanup();});
test.beforeEach(async()=>{await flag("owner_net_ledger",true);await flag("monthly_report_delivery",false);});
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
  const contact=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,user_id,display_name) VALUES($1,true,$2,'B014 owner') RETURNING id`,[ORG_ID,ownerUser])).rows[0].id;
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
async function payment(f:Fixture,rent="1000",other="50",deposit="500",isDeposit=false){
  const total=(BigInt(rent)+BigInt(other)+BigInt(deposit)).toString();
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source,created_by)
    VALUES($1,$2,$3,$4,'USD','2095-01-01','2095-01-05','2095-01-01','2095-01-31','open','recurring',$5) RETURNING id`,[ORG_ID,f.property,f.lease,randomUUID(),USERS.admin])).rows[0].id;
  for (const [line,kind,amount] of [[1,"rent",rent],[2,"utility",other],[3,"deposit",deposit]] as const) {
    if (amount!=="0") await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,$3,$4,'B014 fixture',1,LEAST($5::numeric,999999999999),$5::bigint)`,[ORG_ID,invoice,line,kind,amount]);
  }
  const id=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at,is_deposit)
    VALUES($1,$2,$3,'USD',$4::bigint,'2095-01-10','bank_transfer','confirmed','manager_entry',$5,$5,now(),$6) RETURNING id`,[ORG_ID,f.property,f.lease,total,USERS.admin,isDeposit])).rows[0].id;
  await db.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) VALUES($1,$2,$3,$4::bigint,$5)`,[ORG_ID,id,invoice,total,USERS.admin]);
  return id;
}
async function expense(f:Fixture,amount:string){await db.query(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES($1,$2,'other','USD',$3::bigint,'2095-01-12','owner','owner','approved')`,[ORG_ID,f.property,amount]);}
async function raw(s:Session,sql:string,params:unknown[]=[]){
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[s.userId,s.orgId,s.environment]);
    await db.query("SET LOCAL ROLE authenticated");const result=await db.query(sql,params);await db.query("COMMIT");return result;
  } catch(error){await db.query("ROLLBACK");throw error;}
}
async function record(id:string,reason="Updated facts",requestId=randomUUID(),s=staff){return recordStatementVersion(s,{statementId:id,reason,requestId});}
async function latest(id:string){const view=await ownerNetLedgerView(staff,id);assert.ok(view?.latest);assert.equal(reconcileSnapshot(view.latest.snapshot),true);return view.latest;}
async function financialFacts(){
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments t) payments,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payment_allocations t) allocations,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM owner_statements t) statements,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM owner_statement_lines t) lines,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_transactions t) ledger,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_entries t) entries,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM expenses t) expenses,
    (SELECT count(*)::int FROM app.b014_statement_versions) versions,
    (SELECT count(*)::int FROM app.b014_report_delivery_events) deliveries`)).rows[0];
}
const denied=(error:unknown)=>(error as {code?:string}).code==="42501";

test("OFF and malformed flags: null view, unavailable actions, no write RPCs or changed facts",async()=>{
  const f=await fixture(),id=await statement(f);await payment(f);const before=await financialFacts();
  const values=[{enabled:false,allowed_org_ids:[ORG_ID]},{enabled:"true",allowed_org_ids:[ORG_ID]},
    {enabled:true,allowed_org_ids:ORG_ID},{enabled:true,allowed_org_ids:[]},null];
  for (const value of values){
    await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='owner_net_ledger'`,[JSON.stringify(value)]);
    assert.equal(await ownerNetLedgerEnabled(db,ORG_ID),false);
    assert.equal((await db.query(`SELECT app.b014_flag_on($1,'owner_net_ledger') AS enabled`,[ORG_ID])).rows[0].enabled,false);
    const spy=mock.method(Client.prototype,"query");
    try {
      assert.equal(await ownerNetLedgerView(staff,id),null);
      assert.equal((await record(id)).state,"unavailable");
      assert.equal((await recordReportDelivery(staff,{statementId:id,versionId:null,requestId:randomUUID()})).state,"unavailable");
      assert.equal(spy.mock.calls.some(call=>typeof call.arguments[0]==="string" && /app\.b014_record_/.test(call.arguments[0])),false);
    } finally {mock.restoreAll();}
    await assert.rejects(()=>raw(staff,`SELECT app.b014_record_statement_version($1,$2,'Reason','{}')`,[id,randomUUID()]),denied);
    assert.deepEqual(await financialFacts(),before);
  }
  await flag("owner_net_ledger",true);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"owner_net_ledger":"true"}'::jsonb WHERE id=$1`,[ORG_ID]);
  assert.equal(await ownerNetLedgerView(staff,id),null);
  await db.query(`DELETE FROM platform_settings WHERE key='owner_net_ledger'`);
  assert.equal((await record(id)).state,"unavailable");
  assert.deepEqual(await financialFacts(),before);
});

test("positive/zero/negative, utilities and deposit exclusion; original financial facts unchanged",async()=>{
  for (const [cost,closing] of [["0","1050"],["1050","0"],["1051","-1"]]){
    const f=await fixture();await payment(f);await payment(f,"0","0","800",true);await payment(f,"2000","200","0",true);if(cost!=="0")await expense(f,cost);
    const id=await statement(f),before=await financialFacts();assert.equal((await record(id)).state,"recorded");
    const v=await latest(id);assert.equal(v.snapshot.closing_minor,closing);assert.equal(v.snapshot.company_rent_minor,"1000");
    assert.equal(v.snapshot.other_income_minor,"50");assert.equal(v.snapshot.prepay_draws_minor,"0");
    const after=await financialFacts();assert.deepEqual({...after,versions:before.versions},before);
  }
});

test("v2/v3 retained with reason, actor, time; exact replay and conflicting replay",async()=>{
  const f=await fixture();await payment(f);const id=await statement(f),requestId=randomUUID();
  const first=await record(id,"First reason",requestId);assert.equal(first.state,"recorded");
  assert.deepEqual(await record(id,"First reason",requestId),first);
  assert.equal((await record(id,"Different reason",requestId)).state,"unavailable");
  assert.equal((await record(id,"First reason",requestId,accountant)).state,"unavailable");
  assert.equal((await record(id,"Second reason")).state,"recorded");
  const view=await ownerNetLedgerView(staff,id);assert.ok(view);assert.equal(view.canRecord,true);
  assert.deepEqual(view.versions.map(v=>v.version_no),[3,2]);assert.deepEqual(view.versions.map(v=>v.reason),["Second reason","First reason"]);
  for (const v of view.versions){assert.equal(v.actor_user_id,USERS.admin);assert.ok(!isNaN(Date.parse(v.created_at)));}
  assert.deepEqual((await ownerNetLedgerView(owner,id))?.latest,view.latest);
  assert.equal((await ownerNetLedgerView(owner,id))?.canRecord,false);
  const next=await statement(f,"2095-02");assert.equal((await record(next,"First reason",requestId)).state,"unavailable");
});

test("opening uses previous issued closing, then its latest version; excludes draft and other currency",async()=>{
  const f=await fixture(),january=await statement(f,"2095-01","125");
  const february=await statement(f,"2095-02");await statement(f,"2095-01","900","issued","TWD");
  assert.equal((await record(february)).state,"recorded");assert.equal((await latest(february)).snapshot.opening_minor,"125");
  await payment(f);assert.equal((await record(january)).state,"recorded");
  assert.equal((await record(february)).state,"recorded");assert.equal((await latest(february)).snapshot.opening_minor,"1050");
  await expense(f,"100");assert.equal((await record(january)).state,"recorded");
  assert.equal((await record(february)).state,"recorded");assert.equal((await latest(february)).snapshot.opening_minor,"950");
  await statement(f,"2095-03","999","draft");const april=await statement(f,"2095-04");
  assert.equal((await record(april)).state,"recorded");assert.equal((await latest(april)).snapshot.opening_minor,"950");
});

test("transfer plus reversal counted once by owner and statement period, history retained",async()=>{
  const f=await fixture();await payment(f);const id=await statement(f);
  await flag("owner_transfers",true);const scope={userId:staff.userId,orgId:staff.orgId,liveOrgId:staff.liveOrgId,environment:staff.environment};
  const transfer={requestId:randomUUID(),propertyId:f.property,ownerId:f.contact,effectiveDate:"2095-01-15",amount:"3",reference:"B014 fixture",expectedCurrency:"USD",expectedMinorUnit:2};
  assert.equal((await recordOwnerTransfer(staff,transfer,scope)).state,"recorded");
  assert.equal((await record(id)).state,"recorded");assert.equal((await latest(id)).snapshot.payouts_minor,"300");
  assert.equal((await latest(id)).snapshot.closing_minor,"750");
  assert.equal((await reverseOwnerTransfer(staff,{requestId:randomUUID(),originalId:transfer.requestId,effectiveDate:"2095-01-16",reason:"Correction"},scope)).state,"reversed");
  assert.equal((await recordOwnerTransfer(staff,{...transfer,requestId:randomUUID(),effectiveDate:"2095-02-01"},scope)).state,"recorded");
  assert.equal((await record(id)).state,"recorded");assert.equal((await latest(id)).snapshot.payouts_minor,"0");
  assert.equal((await latest(id)).snapshot.closing_minor,"1050");
  assert.equal((await db.query(`SELECT id FROM ledger_transactions WHERE property_id=$1 AND source_table='b014_owner_transfer_v1'`,[f.property])).rowCount,3);
});

test("owner-direct lease, confirmation precedence and management fee keep direct rent informational",async()=>{
  const f=await fixture();const p1=await payment(f,"1000","0","0"),p2=await payment(f,"2000","0","0");
  await db.query(`INSERT INTO app.b010_lease_collectors(org_id,lease_id,collector,owner_contact_id) VALUES($1,$2,'owner',$3)`,[ORG_ID,f.lease,f.contact]);
  await db.query(`INSERT INTO app.b010_payment_confirmations(org_id,payment_id,actor_user_id,confirmed_via,source,from_status,to_status) VALUES($1,$2,$3,'management','fixture','submitted','confirmed')`,[ORG_ID,p2,USERS.admin]);
  const rule=(await db.query<{id:string}>(`INSERT INTO fee_rules(org_id,name,purpose,kind,currency,percent_bp) VALUES($1,'B014 fee','management_fee','percent','USD',1000) RETURNING id`,[ORG_ID])).rows[0].id;
  await db.query(`INSERT INTO management_agreements(org_id,owner_contact_id,fee_rule_id,effective_from) VALUES($1,$2,$3,'2094-01-01')`,[ORG_ID,f.contact,rule]);
  const id=await statement(f);assert.equal((await record(id)).state,"recorded");
  const snap=(await latest(id)).snapshot;assert.equal(snap.direct_rent_minor,"1000");assert.equal(snap.company_rent_minor,"2000");assert.equal(snap.management_fee_minor,"300");assert.equal(snap.closing_minor,"1700");
  await db.query(`UPDATE app.b010_lease_collectors SET collector='management' WHERE lease_id=$1`,[f.lease]);
  await db.query(`INSERT INTO app.b010_payment_confirmations(org_id,payment_id,actor_user_id,confirmed_via,on_behalf_of_owner_contact_id,source,from_status,to_status) VALUES($1,$2,$3,'staff_proxy',$4,'fixture','submitted','confirmed')`,[ORG_ID,p1,USERS.admin,f.contact]);
  assert.equal((await record(id)).state,"recorded");assert.equal((await latest(id)).snapshot.direct_rent_minor,"1000");
  const p3=await payment(f,"400","0","0");
  await db.query(`INSERT INTO app.b010_payment_confirmations(org_id,payment_id,actor_user_id,confirmed_via,source,from_status,to_status) VALUES($1,$2,$3,'owner_direct','fixture','submitted','confirmed')`,[ORG_ID,p3,USERS.admin]);
  assert.equal((await record(id)).state,"recorded");assert.equal((await latest(id)).snapshot.direct_rent_minor,"1400");
});

test("cross-org, wrong owner, draft, manager and expired session access fails closed",async()=>{
  const f=await fixture(),id=await statement(f);assert.equal((await record(id)).state,"recorded");
  const otherOwner=await session(USERS.owner2,"owner",null),manager=await session(USERS.manager,"staff","manager");
  for (const s of [outsider,otherOwner]){
    assert.equal(await ownerNetLedgerView(s,id),null);
    assert.equal((await raw(s,`SELECT * FROM app.b014_statement_versions_for($1)`,[id])).rowCount,0);
    assert.equal((await record(id,"Denied",randomUUID(),s)).state,"unavailable");
    await assert.rejects(()=>raw(s,`SELECT app.b014_record_statement_version($1,$2,'Reason','{}')`,[id,randomUUID()]),denied);
  }
  assert.equal((await ownerNetLedgerView(manager,id))?.canRecord,false);
  assert.equal((await record(id,"Denied",randomUUID(),manager)).state,"unavailable");
  assert.equal((await record(id,"Denied",randomUUID(),owner)).state,"unavailable");
  assert.equal((await record(id,"Accountant",randomUUID(),accountant)).state,"recorded");
  const expired=await session(USERS.admin,"staff","admin");await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[expired.sessionId]);
  assert.equal((await record(id,"Denied",randomUUID(),expired)).state,"unavailable");
  const draft=await statement(f,"2095-02","0","draft");assert.equal((await record(draft)).state,"unavailable");assert.equal(await ownerNetLedgerView(owner,draft),null);
  await assert.rejects(()=>raw(outsider,`SELECT * FROM app.b014_payment_collectors($1,ARRAY[]::uuid[])`,[ORG_ID]),denied);
});

test("mock delivery needs both flags, retains replay and hides staff events from owner",async()=>{
  const f=await fixture(),id=await statement(f);await record(id);const version=(await latest(id)).id;
  const input={statementId:id,versionId:version,requestId:randomUUID()};
  assert.equal((await recordReportDelivery(staff,input)).state,"unavailable");
  await assert.rejects(()=>raw(staff,`SELECT app.b014_record_delivery_event($1,$2,$3,'accepted')`,[id,version,input.requestId]),denied);
  assert.equal((await ownerNetLedgerView(staff,id))?.deliveries,null);
  await flag("monthly_report_delivery",true);const first=await recordReportDelivery(staff,input);assert.equal(first.state,"recorded");
  if(first.state!=="recorded")throw Error("Missing event");assert.equal(first.result,"accepted");
  assert.deepEqual(await recordReportDelivery(staff,input),first);
  assert.equal((await recordReportDelivery(staff,{...input,versionId:null})).state,"unavailable");
  assert.equal((await recordReportDelivery(accountant,input)).state,"unavailable");
  assert.equal((await recordReportDelivery(staff,{...input,versionId:null,requestId:randomUUID()})).state,"recorded");
  assert.equal((await ownerNetLedgerView(staff,id))?.deliveries?.length,2);
  assert.equal((await ownerNetLedgerView(owner,id))?.deliveries,null);
  assert.equal((await raw(owner,`SELECT * FROM app.b014_delivery_events_for($1)`,[id])).rowCount,0);
  assert.equal((await raw(outsider,`SELECT * FROM app.b014_delivery_events_for($1)`,[id])).rowCount,0);
  const otherId=await statement(f,"2095-02");assert.equal((await recordReportDelivery(staff,{...input,statementId:otherId,requestId:randomUUID()})).state,"unavailable");
  await assert.rejects(()=>raw(staff,`SELECT app.b014_record_delivery_event($1,$2,$3,'accepted')`,[otherId,version,randomUUID()]),denied);
  for(const result of ["delivered","failed","bounced"])assert.ok((await raw(staff,`SELECT app.b014_record_delivery_event($1,NULL,$2,$3) AS id`,[id,randomUUID(),result])).rows[0].id);
  await assert.rejects(()=>raw(staff,`SELECT app.b014_record_delivery_event($1,NULL,$2,'sent')`,[id,randomUUID()]),denied);
  await flag("owner_net_ledger",false);assert.equal((await recordReportDelivery(staff,{...input,requestId:randomUUID()})).state,"unavailable");
  assert.equal((await raw(staff,`SELECT * FROM app.b014_delivery_events_for($1)`,[id])).rowCount,0);
});

test("SQL validates snapshot types, identity, currency, fingerprint, reason and reserved draws",async()=>{
  const f=await fixture(),id=await statement(f);
  const snapshot=buildSnapshot({opening:BigInt("9007199254740993"),companyRent:BigInt(0),directRent:BigInt(0),otherIncome:BigInt(0),managementFee:BigInt(0),expenses:BigInt(0),payouts:BigInt(0),prepayDraws:BigInt(0)},
    {currency:"USD",periodStart:"2095-01-01",periodEnd:"2095-01-31",statementId:id,calculationFingerprint:"fixture"});
  for (const patch of [{closing_minor:"1"},{prepay_draws_minor:"1"},{prepay_draws_minor:"-0"},{opening_minor:5},{opening_minor:null},{direct_rent_minor:"1.5"},{currency:"TWD"},{currency:null},{fingerprint:""},{fingerprint:"x".repeat(129)},{fingerprint:null}]){
    await assert.rejects(()=>raw(staff,`SELECT app.b014_record_statement_version($1,$2,'Reason',$3::jsonb)`,[id,randomUUID(),JSON.stringify({...snapshot,...patch})]),(error:unknown)=>(error as {code?:string}).code==="22023");
  }
  for(const reason of [""," Reason","Reason ","\t","Reason\n","\tReason","x".repeat(501)]) await assert.rejects(()=>raw(staff,`SELECT app.b014_record_statement_version($1,$2,$3,$4::jsonb)`,[id,randomUUID(),reason,JSON.stringify(snapshot)]));
  const request=randomUUID(),args=[id,request,"Reason",JSON.stringify(snapshot)];
  const first=await raw(staff,`SELECT app.b014_record_statement_version($1,$2,$3,$4::jsonb) AS id`,args);
  assert.deepEqual((await raw(staff,`SELECT app.b014_record_statement_version($1,$2,$3,$4::jsonb) AS id`,args)).rows,first.rows);
  await assert.rejects(()=>raw(staff,`SELECT app.b014_record_statement_version($1,$2,$3,$4::jsonb)`,[id,request,"Reason",JSON.stringify({...snapshot,fingerprint:"changed"})]),denied);
  assert.equal((await latest(id)).snapshot.closing_minor,"9007199254740993");
});

test("concurrent regeneration and same-request replay retain contiguous versions",async()=>{
  const f=await fixture(),id=await statement(f);const request=randomUUID();
  const [a,b]=await Promise.all([record(id,"Concurrent",request),record(id,"Concurrent",request)]);
  assert.equal(a.state,"recorded");assert.deepEqual(b,a);
  const [c,d]=await Promise.all([record(id,"Next A"),record(id,"Next B")]);
  assert.equal(c.state,"recorded");assert.equal(d.state,"recorded");
  assert.deepEqual((await ownerNetLedgerView(staff,id))?.versions.map(v=>v.version_no),[4,3,2]);
});

test("private tables deny all API roles; update, delete and truncate reject even table owner",async()=>{
  const f=await fixture(),id=await statement(f);await record(id);await flag("monthly_report_delivery",true);
  await recordReportDelivery(staff,{statementId:id,versionId:null,requestId:randomUUID()});
  for(const table of ["b014_statement_versions","b014_report_delivery_events"]){
    for(const role of ["anon","authenticated","service_role"]){
      const grants=(await db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed`,[role,`app.${table}`])).rows[0];assert.equal(grants.allowed,false);
    }
    for(const sql of [`UPDATE app.${table} SET request_id=request_id WHERE statement_id='${id}'`,`DELETE FROM app.${table} WHERE statement_id='${id}'`,`TRUNCATE app.${table} CASCADE`]){
      await assert.rejects(()=>db.query(sql),(error:unknown)=>(error as {code?:string}).code==="55000");
    }
  }
  const functions=(await db.query(`SELECT p.oid::regprocedure::text AS signature,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b014_%'`)).rows;
  assert.equal(functions.length,9);
  for(const f of functions){
    assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes("search_path=pg_catalog, public, app"));
    for(const role of ["anon","service_role"])assert.equal((await db.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed`,[role,f.signature])).rows[0].allowed,false);
  }
  await assert.rejects(()=>raw(staff,`SELECT app.b014_flag_on($1,'owner_net_ledger')`,[ORG_ID]),denied);
});

test("QA r1: BigInt beyond 2^53, deposit excluded from fee basis, late reversal counted, retry before recalculation",async()=>{
  // (1) exact amounts above Number.MAX_SAFE_INTEGER
  const big=await fixture();await payment(big,"9007199254740993","0","0");const bigId=await statement(big);
  assert.equal((await record(bigId)).state,"recorded");assert.equal((await latest(bigId)).snapshot.company_rent_minor,"9007199254740993");
  // (2) a deposit-tagged payment's rent never enters the management-fee basis
  const f=await fixture();await payment(f,"1000","0","0");await payment(f,"2000","0","0",true);
  const rule=(await db.query<{id:string}>(`INSERT INTO fee_rules(org_id,name,purpose,kind,currency,percent_bp) VALUES($1,'B014 qa fee','management_fee','percent','USD',1000) RETURNING id`,[ORG_ID])).rows[0].id;
  await db.query(`INSERT INTO management_agreements(org_id,owner_contact_id,fee_rule_id,effective_from) VALUES($1,$2,$3,'2094-01-01')`,[ORG_ID,f.contact,rule]);
  const jan=await statement(f);assert.equal((await record(jan)).state,"recorded");
  const snap=(await latest(jan)).snapshot;assert.equal(snap.company_rent_minor,"1000");assert.equal(snap.management_fee_minor,"100");assert.equal(snap.closing_minor,"900");
  // (3) a February reversal of a January transfer still counts after ownership ended on Jan 31
  await flag("owner_transfers",true);const scope={userId:staff.userId,orgId:staff.orgId,liveOrgId:staff.liveOrgId,environment:staff.environment};
  const transfer={requestId:randomUUID(),propertyId:f.property,ownerId:f.contact,effectiveDate:"2095-01-15",amount:"2",reference:"B014 qa",expectedCurrency:"USD",expectedMinorUnit:2};
  assert.equal((await recordOwnerTransfer(staff,transfer,scope)).state,"recorded");
  assert.equal((await reverseOwnerTransfer(staff,{requestId:randomUUID(),originalId:transfer.requestId,effectiveDate:"2095-02-03",reason:"Late correction"},scope)).state,"reversed");
  const other=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'US','USD','America/Los_Angeles') RETURNING id`,[ORG_ID,randomUUID()])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,'2094-01-01')`,[ORG_ID,other,f.contact]);
  await db.query(`UPDATE property_owners SET effective_to='2095-01-31' WHERE property_id=$1 AND owner_contact_id=$2`,[f.property,f.contact]);
  const feb=await statement(f,"2095-02");assert.equal((await record(feb)).state,"recorded");assert.equal((await latest(feb)).snapshot.payouts_minor,"-200");
  // (4) an identical retry after facts changed returns the committed version
  const g=await fixture();await payment(g);const id=await statement(g),requestId=randomUUID();
  const first=await record(id,"Retry reason",requestId);assert.equal(first.state,"recorded");
  await expense(g,"10");
  assert.deepEqual(await record(id,"Retry reason",requestId),first);
});
