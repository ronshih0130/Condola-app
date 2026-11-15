import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { brandTenants, TENANTS_ADMISSION_SQL as ADMIT, TENANTS_SUMMARY_SQL as SUMMARY, TENANTS_LIST_SQL as LIST, type TenantsInput } from "./b3-tenants";
import { searchTenants } from "./queries";
import { tenantDirectory } from "./tenant-directory";
import { governCustomRole } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError } from "./errors";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Mac only: clone the fully migrated local disposable DB. No migration, seed,
// transport or provider runs. Fixture flags exist solely in the disposable clone.
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
let db:Client;
const saved=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
const ON={v3:async()=>true};
const denied=(e:unknown)=>e instanceof FlowError && e.key==="errors.forbidden";
test.before(async()=>{
  clone=await cloneTestDatabase();process.env.CUSTOM_ROLES_ORG_ALLOWLIST="";
  db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
});
test.after(async()=>{
  await db?.end();await clone?.cleanup();
  if(saved===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=saved;
});
type Role="admin"|"manager"|"accountant"|"maintenance";
async function fixture(directory=false,mobile=true) {
  const org=(await db.query(`INSERT INTO organizations(name,country_code,default_currency,timezone,feature_flags)
    VALUES('R2 TEN synthetic','US','USD','America/Los_Angeles',$1::jsonb) RETURNING id::text`,[JSON.stringify({tenant_directory_edit:directory,tenant_mobile_required:mobile})])).rows[0].id as string;
  if(directory) await db.query(`INSERT INTO platform_settings(key,value) VALUES('tenant_directory_edit',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
    ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('enabled',true,'allowed_org_ids',coalesce(platform_settings.value->'allowed_org_ids','[]'::jsonb)||jsonb_build_array($1::text))`,[org]);
  if(mobile) await db.query(`INSERT INTO platform_settings(key,value) VALUES('tenant_mobile_required',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
    ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('enabled',true,'allowed_org_ids',coalesce(platform_settings.value->'allowed_org_ids','[]'::jsonb)||jsonb_build_array($1::text))`,[org]);
  const staff={} as Record<Role,Session>;
  for(const role of ["admin","manager","accountant","maintenance"] as const){
    const user=randomUUID(),sid=randomUUID();
    await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at,role,aud)
      VALUES($1,$2,'{}',now(),'authenticated','authenticated')`,[user,`${user}@example.test`]);
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,$3::org_role,'active')",[org,user,role]);
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[sid,user,randomUUID()]);
    staff[role]={userId:user,sessionId:sid,orgId:org,liveOrgId:org,environment:"live",kind:"staff",role,locale:"en",calendar:"gregorian",leaseId:null,name:"Synthetic",email:""};
  }
  const property=(await db.query(`INSERT INTO properties(org_id,name,country_code,currency,timezone)
    VALUES($1,'R2 property','US','USD','America/Los_Angeles') RETURNING id::text`,[org])).rows[0].id;
  const unit=(await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode)
    VALUES($1,$2,'Searchable unit','whole_unit') RETURNING id::text`,[org,property])).rows[0].id;
  const lease=(await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$3,'active','imported','2030-01-01','2031-01-01','USD',0) RETURNING id::text`,[org,property,unit])).rows[0].id;
  return {org,staff,property,unit,lease};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function contact(f:Fixture,n:number,phone:string|null=null,role:"primary"|"co_tenant"|null="primary",archived=false,tenant=true){
  const id=(await db.query(`INSERT INTO contacts(org_id,display_name,is_tenant,phone_e164,archived_at)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END) RETURNING id::text`,[f.org,`Person ${String(n).padStart(3,"0")}`,tenant,phone,archived])).rows[0].id as string;
  if(role)await db.query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,$4::lease_party_role)",[f.org,f.lease,id,role]);
  return id;
}
async function read(s:Session,input:TenantsInput={}){
  const result=await brandTenants(s,input,ON);assert.equal(result.state,"ready");if(result.state!=="ready")assert.fail("reader unavailable");return result;
}
test("legacy population parity, uncapped counts, 50+1 keyset, missing filter, unit and literal search",async()=>{
  const f=await fixture();const expected=[];
  for(let n=0;n<53;n++)expected.push(await contact(f,n,n<3?null:`+1999555${String(n).padStart(4,"0")}`));
  await contact(f,90,null,null);await contact(f,91,null,"co_tenant");await contact(f,92,null,"primary",true);await contact(f,93,null,"primary",false,false);
  const a=await read(f.staff.manager);assert.equal(a.total,53);assert.equal(a.missing,3);assert.equal(a.filteredCount,53);assert.equal(a.rows.length,50);assert.ok(a.nextCursor);
  const b=await read(f.staff.manager,{cursor:a.nextCursor});assert.equal(b.rows.length,3);assert.equal(b.total,53);assert.equal(b.nextCursor,null);
  assert.deepEqual([...a.rows,...b.rows].map(r=>r.id),expected);
  const legacy=await searchTenants(f.staff.manager,{limit:100});assert.equal(legacy.total,a.total);assert.deepEqual(legacy.rows.map(r=>r.contact_id),expected);
  const missing=await read(f.staff.manager,{filter:"missing"});assert.equal(missing.total,53);assert.equal(missing.filteredCount,3);assert.equal(missing.rows.length,3);
  const unit=await read(f.staff.manager,{q:"Searchable unit"});assert.equal(unit.filteredCount,53);
  const literal=await read(f.staff.manager,{q:"%_"});assert.equal(literal.filteredCount,0);assert.equal(literal.total,53);
  assert.equal((await brandTenants(f.staff.manager,{q:"changed",cursor:a.nextCursor},ON)).state,"unavailable");
});
test("directory ON preserves zero-lease and co-tenant contacts, matches existing population",async()=>{
  const f=await fixture(true);
  await contact(f,0,null,null);await contact(f,1,"+19995550111","co_tenant");await contact(f,2,"+19995550112");
  await contact(f,3,null,null,true);await contact(f,4,null,null,false,false);
  const directory=await tenantDirectory(f.staff.manager);assert.equal(directory.state,"enabled");if(directory.state!=="enabled")assert.fail();
  const result=await read(f.staff.manager);assert.equal(result.total,3);assert.equal(result.missing,1);
  assert.deepEqual(result.rows.map(r=>r.id),directory.rows.map(r=>r.contact_id));assert.equal(result.rows[0].place,null);
});
test("admin/manager phones and accountant omission/search privacy, forged native role and maintenance boundary",async()=>{
  const f=await fixture();await contact(f,0,"+19995550987");
  for(const role of ["admin","manager"] as const){
    const r=await read(f.staff[role],{q:"+19995550987"});assert.equal(r.filteredCount,1);assert.equal(r.rows[0].phone,"+19995550987");assert.equal(r.rows[0].verified,false);
  }
  for(const s of [f.staff.accountant,{...f.staff.accountant,role:"admin" as const}]){
    const a=await read(s);assert.equal(a.rows.length,1);assert.equal(a.canViewPhone,false);assert.equal(a.missing,null);
    for(const key of ["phone","verified","staffUpdated","duplicateName"])assert.equal(key in a.rows[0],false);
    const b=await read(s,{q:"+19995550987"});assert.equal(b.filteredCount,0);assert.deepEqual(b.rows,[]);
    await assert.rejects(brandTenants(s,{filter:"missing"},ON),denied);
  }
  await assert.rejects(brandTenants(f.staff.maintenance,{},ON),denied);
  await assert.rejects(brandTenants({...f.staff.maintenance,role:"admin"},{},ON),denied);
});
test("cross-org, wrong environment, expired session, portal and anon denial",async()=>{
  const f=await fixture(),other=await fixture();await contact(f,0,"+19995550987");await contact(other,0,"+19995550988");
  for(const s of [{...f.staff.manager,orgId:other.org,liveOrgId:other.org},{...f.staff.manager,environment:"sandbox" as const},
    {...f.staff.manager,sessionId:randomUUID()},{...f.staff.manager,kind:"tenant" as const},{...f.staff.manager,role:null}])
    await assert.rejects(brandTenants(s,{},ON),denied);
  await db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[f.staff.manager.sessionId]);
  await assert.rejects(brandTenants(f.staff.manager,{},ON),denied);
  const args=[f.org,null,false,true,false,true];
  for(const [sql,params] of [[ADMIT,[f.org,f.staff.admin.sessionId,f.staff.admin.userId,"live",f.org]],[SUMMARY,args],[LIST,[...args,null,null,51]]] as const){
    await db.query("BEGIN");try{await db.query("SET LOCAL ROLE anon");await assert.rejects(db.query(sql,[...params]),(e:unknown)=>(e as {code?:string}).code==="42501");}finally{await db.query("ROLLBACK");}
  }
});

test("LINE uses current org-scoped linked records, never legacy ids or pending/unlinked rows",async()=>{
  const f=await fixture();const a=await contact(f,0),b=await contact(f,1),c=await contact(f,2);
  const channel=(await db.query(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,
    messaging_channel_secret_ref,messaging_access_token_ref)
    VALUES($1,'org_owned','Synthetic',$2,$3,'synthetic-reference','synthetic-reference') RETURNING id::text`,
    [f.org,randomUUID(),randomUUID()])).rows[0].id;
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status,line_user_id,linked_at)
    VALUES($1,$2,$3,'linked',$4,now()),($1,$5,$3,'pending',NULL,NULL),($1,$6,$3,'unlinked',NULL,NULL)`,
    [f.org,a,channel,'U'+'1'.repeat(32),b,c]);
  for(const role of ["manager","accountant"] as const){
    const result=await read(f.staff[role]);assert.deepEqual(result.rows.map(r=>r.lineLinked),[true,false,false]);
    for(const row of result.rows)assert.equal("line_user_id" in row,false);
  }
});

test("B-017 props.view without tenants.contact masks before search/counts; revoked entry denied in snapshot",async()=>{
  const f=await fixture();await contact(f,0,"+19995550987");await contact(f,1,"+19995550987");
  await db.query("UPDATE org_members SET is_billing_owner=true WHERE org_id=$1 AND user_id=$2",[f.org,f.staff.admin.userId]);
  const previous=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  try{
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST=JSON.stringify([f.org]);
    await db.query(`INSERT INTO platform_settings(key,value) VALUES('custom_roles',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[f.org]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"custom_roles":true}'::jsonb WHERE id=$1`,[f.org]);
    const memberId=(await db.query("SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2",[f.org,f.staff.manager.userId])).rows[0].id;
    const roleId=(await governCustomRole(f.staff.admin,{operation:"create",grants:["props.view"],requestId:randomUUID()})).roleId!;
    const assign=()=>governCustomRole(f.staff.admin,{operation:"assign",roleId,memberId,requestId:randomUUID()});
    const fresh=async()=>{
      const sessionId=randomUUID();await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[sessionId,f.staff.manager.userId,randomUUID()]);
      return {...f.staff.manager,sessionId};
    };
    await assign();const limited=await fresh();
    const names=await read(limited);assert.equal(names.total,2);assert.equal(names.missing,null);assert.equal(names.canViewPhone,false);assert.equal("phone" in names.rows[0],false);assert.equal("duplicateName" in names.rows[0],false);
    assert.equal((await read(limited,{q:"+19995550987"})).filteredCount,0);
    await assert.rejects(brandTenants(limited,{filter:"missing"},ON),denied);
    await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["props.view","tenants.contact"],requestId:randomUUID()});await assign();
    const allowed=await fresh();assert.equal((await read(allowed,{q:"+19995550987"})).rows[0].phone,"+19995550987");
    const revoked:typeof tx=async(...args)=>{
      await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["tenants.contact"],requestId:randomUUID()});await assign();return tx(...args);
    };
    await assert.rejects(brandTenants(allowed,{}, {...ON,transaction:revoked}),denied);
  }finally{if(previous===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=previous;}
});

test("item gate requires platform enabled, selected-org allowlist and org opt-in; OFF/absent ignores missing URL",async()=>{
  const f=await fixture(true,false);
  await contact(f,0,null,null);await contact(f,1,"+19995550123",null);
  const enabled={enabled:true,allowed_org_ids:[f.org]};
  const cases:[unknown,unknown,boolean][]=[
    [null,{},false], [null,{tenant_mobile_required:true},false],
    [{enabled:false,allowed_org_ids:[f.org]},{tenant_mobile_required:true},false],
    [enabled,{},false], [enabled,{tenant_mobile_required:false},false],
    [enabled,{tenant_mobile_required:"true"},false],
    [{enabled:"true",allowed_org_ids:[f.org]},{tenant_mobile_required:true},false],
    [{enabled:true,allowed_org_ids:[]},{tenant_mobile_required:true},false],
    [{enabled:true,allowed_org_ids:[randomUUID()]},{tenant_mobile_required:true},false],
    [{enabled:true,allowed_org_ids:f.org},{tenant_mobile_required:true},false],
    [enabled,{tenant_mobile_required:true},true],
  ];
  for(const [platform,flags,on] of cases){
    await db.query("DELETE FROM platform_settings WHERE key='tenant_mobile_required'");
    if(platform!==null)await db.query("INSERT INTO platform_settings(key,value) VALUES('tenant_mobile_required',$1::jsonb)",[JSON.stringify(platform)]);
    await db.query("UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1",[f.org,JSON.stringify({tenant_directory_edit:true,...flags as object})]);
    const result=await read(f.staff.manager,{filter:"missing"});
    assert.equal(result.mobileRequired,on);assert.equal(result.filter,on?"missing":"all");
    assert.equal(result.missing,on?1:null);assert.equal(result.filteredCount,on?1:2);
    const all=await read(f.staff.manager);assert.equal(all.rows[1].phone,"+19995550123");
    assert.equal("verified" in all.rows[1],on);assert.equal("staffUpdated" in all.rows[1],on);
    assert.deepEqual(await brandTenants(f.staff.manager,{filter:"missing"},{v3:async()=>false}),{state:"off"});
    if(!on){const accountant=await read(f.staff.accountant,{filter:"missing"});assert.equal(accountant.filter,"all");assert.equal(accountant.rows.length,2);}
  }
});
test("same-org E.164 duplicates on each row, stable first other, before search/pagination; cross-org excluded",async()=>{
  const f=await fixture(true),other=await fixture(true);
  const phone="+19995550123",unique="+19995550999";
  // Same normalized stored number, distinct tenants; third duplicate is beyond page one.
  const a=await contact(f,0,phone,null),b=await contact(f,1,phone,null);
  for(let n=2;n<52;n++)await contact(f,n,null,null);
  const c=await contact(f,52,phone,null);await contact(f,53,unique,null);
  await contact(other,0,unique,null);await contact(other,1,phone,null);
  await contact(f,90,unique,null,true);await contact(f,91,unique,null,false,false);
  const first=await read(f.staff.manager);assert.ok(first.nextCursor);
  const second=await read(f.staff.manager,{cursor:first.nextCursor});
  const rows=[...first.rows,...second.rows];
  assert.equal(rows.find(r=>r.id===a)?.duplicateName,"Person 001");
  assert.equal(rows.find(r=>r.id===b)?.duplicateName,"Person 000");
  assert.equal(rows.find(r=>r.id===c)?.duplicateName,"Person 000");
  assert.equal(rows.find(r=>r.name==="Person 053")?.duplicateName,null);
  const searched=await read(f.staff.manager,{q:"Person 052"});assert.equal(searched.rows[0].duplicateName,"Person 000");
  const isolated=await read(other.staff.manager);for(const row of isolated.rows)assert.equal(row.duplicateName,null);
  const accountant=await read(f.staff.accountant);
  for(const row of accountant.rows)for(const key of ["phone","duplicateName","verified","staffUpdated"])assert.equal(key in row,false);
});

test("sandbox uses selected-org gate and duplicate population, never live-parent phone matches",async()=>{
  const live=await fixture(true),sandbox=await fixture(true);
  await db.query("UPDATE organizations SET environment='sandbox',live_org_id=$2 WHERE id=$1",[sandbox.org,live.org]);
  const phone="+19995550123";
  await contact(live,0,phone,null);await contact(sandbox,1,phone,null);
  const session={...live.staff.manager,orgId:sandbox.org,environment:"sandbox" as const};
  let result=await read(session);assert.equal(result.mobileRequired,true);assert.equal(result.rows.length,1);assert.equal(result.rows[0].duplicateName,null);
  await contact(sandbox,2,phone,null);
  result=await read(session);assert.deepEqual(result.rows.map(r=>r.duplicateName),["Person 002","Person 001"]);
  assert.equal((await read(live.staff.manager)).rows[0].duplicateName,null);
  // Only live parent admitted: sandbox must not inherit the item gate.
  await db.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='tenant_mobile_required'",[live.org]);
  result=await read(session,{filter:"missing"});assert.equal(result.mobileRequired,false);assert.equal(result.filter,"all");assert.equal(result.rows.length,2);
  for(const row of result.rows){assert.equal(row.phone,phone);assert.equal("duplicateName" in row,false);}
});

test("MGT-75-AC3 with the directory gate OFF: a listed tenant still sees a same-org co-tenant's identical number (Codex r2)",async()=>{
  const f=await fixture(false,true),phone="+19995550456";
  const primary=await contact(f,0,phone,"primary");const co=await contact(f,1,phone,"co_tenant");
  const zeroLease=await contact(f,2,"+19995550457",null);await contact(f,3,"+19995550457",null,true);
  const result=await read(f.staff.manager);
  assert.ok(!result.rows.some(r=>r.id===co),"co-tenant is not listed while the directory gate is OFF");
  assert.ok(!result.rows.some(r=>r.id===zeroLease),"zero-lease contact is not listed while the directory gate is OFF");
  assert.equal(result.rows.find(r=>r.id===primary)?.duplicateName,"Person 001","duplicate found outside the listed population, same org");
  const off=await fixture(false,false);await contact(off,0,phone,"primary");await contact(off,1,phone,"co_tenant");
  for(const row of (await read(off.staff.manager)).rows)assert.equal("duplicateName" in row,false,"no hint while the mobile item is OFF");
});
