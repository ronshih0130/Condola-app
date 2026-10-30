import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { tenantDirectory, tenantDirectoryHistory } from "./tenant-directory";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
let db:Client;
const sessions=new Map<string,string>();
const contactIds={zero:randomUUID(),co:randomUUID(),archived:randomUUID(),notTenant:randomUUID()};
async function session(user:string,role:Session["role"]):Promise<Session> {
  let sid=sessions.get(user);
  if(!sid) {sid=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,user,randomUUID()]);sessions.set(user,sid);}
  return {userId:user,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"staff",role,locale:"en",calendar:"gregorian",leaseId:null,email:"local@example.test",name:"Synthetic"};
}
async function enabled(value:unknown={enabled:true,allowed_org_ids:[ORG_ID]}) {
  await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_directory_edit'`,[JSON.stringify(value)]);
}

test.before(async()=>{
  clone=await cloneTestDatabase();
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE="true";process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");await resetAndSeed();
    db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
    await db.query(`INSERT INTO platform_settings(key,value,description) VALUES('tenant_directory_edit','{}','isolated directory acceptance')`);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_directory_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    for(const [key,name,email,phone,tenant,archived] of [
      ["zero","Directory Zero","directory-zero@example.test","+19995550101",true,false],
      ["co","Directory Co","directory-co@example.test","+19995550102",true,false],
      ["archived","Directory Archived","directory-archived@example.test","+19995550103",true,true],
      ["notTenant","Directory Guarantor","directory-guarantor@example.test","+19995550104",false,false],
    ] as const) await db.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name,email,phone_e164,archived_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() ELSE NULL END)`,[contactIds[key],ORG_ID,tenant,name,email,phone,archived]);
    const leases=(await db.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 ORDER BY id LIMIT 2`,[ORG_ID])).rows;assert.equal(leases.length,2);
    await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant'),($1,$4,$3,'guarantor'),($1,$2,$5,'guarantor')`,[ORG_ID,leases[0].id,contactIds.co,leases[1].id,contactIds.notTenant]);
  } catch(e) {await db?.end();await clone.cleanup();throw e;}
  finally {if(demo===undefined) delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await db?.end();await clone?.cleanup();});

test("strict global/org admission remains OFF for missing, malformed or wrong organization controls",async()=>{
  const manager=await session(USERS.manager,"manager");
  assert.equal((await tenantDirectory(manager)).state,"disabled");
  for(const value of [{enabled:"true",allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:ORG_ID},{enabled:true,allowed_org_ids:[ORG2_ID]}]) {await enabled(value);assert.equal((await tenantDirectory(manager)).state,"disabled");}
  await enabled();
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_directory_edit":"true"}'::jsonb WHERE id=$1`,[ORG_ID]);
  assert.equal((await tenantDirectory(manager)).state,"disabled");
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_directory_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);
});

test("directory retains original contacts with zero leases and co-tenant history, excluding guarantor-only and archived rows",async()=>{
  await enabled();const manager=await session(USERS.manager,"manager");
  const result=await tenantDirectory(manager,{q:"Directory "});assert.equal(result.state,"enabled");if(result.state!=="enabled") assert.fail();
  assert.equal(result.total,2);assert.equal(result.rows.length,2);assert.equal(new Set(result.rows.map(r=>r.contact_id)).size,2);
  const zero=result.rows.find(r=>r.contact_id===contactIds.zero)!;assert.ok(zero);assert.equal(zero.lease_count,0);assert.equal(zero.latest_lease_id,null);assert.equal(zero.latest_place,null);assert.equal(zero.phone,"+19995550101");
  const co=result.rows.find(r=>r.contact_id===contactIds.co)!;assert.ok(co);assert.equal(co.lease_count,1);assert.ok(co.latest_lease_id);assert.equal(co.email,"directory-co@example.test");
  const first=await tenantDirectory(manager,{q:"Directory ",limit:1});const second=await tenantDirectory(manager,{q:"Directory ",limit:1,page:2});
  assert.equal(first.state,"enabled");assert.equal(second.state,"enabled");if(first.state!=="enabled"||second.state!=="enabled") assert.fail();
  assert.equal(first.total,2);assert.equal(first.hasNext,true);assert.equal(second.hasNext,false);assert.notEqual(first.rows[0].contact_id,second.rows[0].contact_id);
  const literal=await tenantDirectory(manager,{q:"Directory %"});assert.equal(literal.state,"enabled");if(literal.state!=="enabled") assert.fail();assert.equal(literal.total,0);
});

test("actual accountant role cannot receive or search contact fields even with a forged admin Session role",async()=>{
  await enabled();const accountant={...await session(USERS.accountant,"accountant"),role:"admin" as const};
  for(const q of ["directory-zero@example.test","+19995550101"]) {
    const result=await tenantDirectory(accountant,{q});assert.equal(result.state,"enabled");if(result.state!=="enabled") assert.fail();assert.equal(result.total,0);assert.deepEqual(result.rows,[]);
  }
  const names=await tenantDirectory(accountant,{q:"Directory Zero"});assert.equal(names.state,"enabled");if(names.state!=="enabled") assert.fail();assert.equal(names.total,1);assert.equal(names.rows[0].email,null);assert.equal(names.rows[0].phone,null);
  const allowed=await tenantDirectory(await session(USERS.manager,"manager"),{q:"directory-zero@example.test"});assert.equal(allowed.state,"enabled");if(allowed.state!=="enabled") assert.fail();assert.equal(allowed.total,1);
});

test("scope, current member, session and environment are checked independently of submitted Session claims",async()=>{
  await enabled();const manager=await session(USERS.manager,"manager");
  for(const forged of [
    {...manager,orgId:ORG2_ID,liveOrgId:ORG2_ID}, {...manager,environment:"sandbox" as const},
    {...manager,sessionId:randomUUID()}, {...manager,orgId:"invalid"},
    {...await session(USERS.tenant,null),role:"admin" as const},
    {...await session(USERS.maintenance,"maintenance"),role:"admin" as const},
  ]) assert.equal((await tenantDirectory(forged)).state,"unavailable");
  await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[manager.sessionId]);assert.equal((await tenantDirectory(manager)).state,"unavailable");
  await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour',revoked_at=clock_timestamp() WHERE id=$1`,[manager.sessionId]);assert.equal((await tenantDirectory(manager)).state,"unavailable");
  await db.query(`UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1`,[manager.sessionId]);
  await db.query(`UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId]);assert.equal((await tenantDirectory(manager)).state,"unavailable");
  await db.query(`UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId]);
  assert.equal((await tenantDirectory(manager)).state,"enabled");
});


test("detail uses the same current scope and preserves co-tenant and zero-lease contact identity without login/profile changes",async()=>{
  await enabled();const manager=await session(USERS.manager,"manager");
  const before=(await db.query(`SELECT (SELECT count(*) FROM auth.users)::text AS users,(SELECT count(*) FROM profiles)::text AS profiles,(SELECT user_id::text FROM contacts WHERE id=$1) AS portal`,[contactIds.co])).rows[0];
  const co=await tenantDirectoryHistory(manager,contactIds.co);assert.equal(co.state,"enabled");if(co.state!=="enabled") assert.fail();assert.equal(co.contact?.contact_id,contactIds.co);assert.equal(co.rows.length,1);assert.equal(co.total,1);
  const zero=await tenantDirectoryHistory(manager,contactIds.zero);assert.equal(zero.state,"enabled");if(zero.state!=="enabled") assert.fail();assert.equal(zero.contact?.contact_id,contactIds.zero);assert.equal(zero.total,0);assert.deepEqual(zero.rows,[]);
  const accountant=await tenantDirectoryHistory(await session(USERS.accountant,"admin"),contactIds.co);assert.equal(accountant.state,"enabled");if(accountant.state!=="enabled") assert.fail();assert.equal(accountant.canViewContact,false);assert.equal(accountant.contact?.phone,null);assert.equal(accountant.contact?.email,null);
  const other=(await db.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 LIMIT 1`,[ORG2_ID])).rows[0];assert.ok(other);
  for(const id of [other.id,contactIds.archived,contactIds.notTenant,randomUUID()]) {const hidden=await tenantDirectoryHistory(manager,id);assert.equal(hidden.state,"enabled");if(hidden.state!=="enabled") assert.fail();assert.equal(hidden.contact,null);assert.equal(hidden.total,0);assert.deepEqual(hidden.rows,[]);}
  const after=(await db.query(`SELECT (SELECT count(*) FROM auth.users)::text AS users,(SELECT count(*) FROM profiles)::text AS profiles,(SELECT user_id::text FROM contacts WHERE id=$1) AS portal`,[contactIds.co])).rows[0];assert.deepEqual(after,before);
});

test("sandbox contact search uses the same canonical live member role as masked fields",async()=>{
  const {insertSandboxOrg}=await import('./sandbox');
  const sandbox=await insertSandboxOrg(db,ORG_ID,USERS.admin);
  await db.query(`UPDATE org_members SET role='admin',is_billing_owner=false WHERE org_id=$1 AND user_id=$2`,[sandbox,USERS.accountant]);
  const id=randomUUID();await db.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name,email,phone_e164) VALUES($1,$2,true,'Sandbox Directory','sandbox-directory@example.test','+19995550999')`,[id,sandbox]);
  await enabled({enabled:true,allowed_org_ids:[ORG_ID,sandbox]});
  const accountant={...await session(USERS.accountant,'accountant'),orgId:sandbox,environment:'sandbox' as const,role:'admin' as const};
  const visible=await tenantDirectory(accountant,{q:'Sandbox Directory'});assert.equal(visible.state,'enabled');if(visible.state!=='enabled') assert.fail();assert.equal(visible.total,1);assert.equal(visible.canViewContact,false);assert.equal(visible.rows[0].phone,null);assert.equal(visible.rows[0].email,null);
  for(const q of ['sandbox-directory@example.test','+19995550999']) {const hidden=await tenantDirectory(accountant,{q});assert.equal(hidden.state,'enabled');if(hidden.state!=='enabled') assert.fail();assert.equal(hidden.total,0);assert.deepEqual(hidden.rows,[]);}
  const manager={...await session(USERS.manager,'manager'),orgId:sandbox,environment:'sandbox' as const};
  const found=await tenantDirectory(manager,{q:'sandbox-directory@example.test'});assert.equal(found.state,'enabled');if(found.state!=='enabled') assert.fail();assert.equal(found.total,1);assert.equal(found.canViewContact,true);assert.equal(found.rows[0].contact_id,id);assert.equal(found.rows[0].phone,'+19995550999');
});
