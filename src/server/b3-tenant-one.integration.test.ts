import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { brandTenantOne, TENANT_ONE_CONTACT_SQL as CONTACT, TENANT_ONE_LEASES_SQL as LEASES } from "./b3-tenant-one";
import { TENANTS_ADMISSION_SQL as ADMIT } from "./b3-tenants";
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
async function read(s:Session,id:string){
  const result=await brandTenantOne(s,id,ON);assert.equal(result.state,"ready");
  if(result.state!=="ready")assert.fail("reader unavailable");return result;
}
test("native roles, authenticated RLS and cross-org tenant lookup; never contact data for accountant",async()=>{
  const f=await fixture(),other=await fixture();
  const id=await contact(f,0,"+19995550123"),otherId=await contact(other,0,"+19995550987");
  await db.query("UPDATE contacts SET email='synthetic@example.test' WHERE id=$1",[id]);
  for(const role of ["admin","manager"] as const){
    const result=await read(f.staff[role],id);
    assert.equal(result.phone,"+19995550123");assert.equal(result.email,"synthetic@example.test");assert.equal(result.legacyPhoneNotice,true);
    assert.equal(result.leases.length,1);assert.equal(result.leases[0].endDate,"2031-01-01");
  }
  for(const s of [f.staff.accountant,{...f.staff.accountant,role:"admin" as const}]){
    const result=await read(s,id);assert.equal(result.canViewContact,false);
    for(const key of ["phone","email","legacyPhoneNotice","verified","pendingChange"])assert.equal(key in result,false);
  }
  for(const s of [f.staff.maintenance,{...f.staff.maintenance,role:"admin" as const}])
    await assert.rejects(brandTenantOne(s,id,ON),denied);
  assert.deepEqual(await brandTenantOne(f.staff.manager,otherId,ON),{state:"not_found"});
  const crossRows=await tx(f.staff.manager.userId,async c=>({
    contact:(await c.query(CONTACT,[other.org,otherId,true])).rows,
    leases:(await c.query(LEASES,[other.org,otherId,true])).rows,
  }),{orgId:f.org,environment:"live"},{isolation:"repeatable read",readOnly:true});
  assert.deepEqual(crossRows,{contact:[],leases:[]});
});
test("cross-org session, wrong environment, revoked/expired session, portals and anon denied",async()=>{
  const f=await fixture(),other=await fixture();const id=await contact(f,0);
  for(const s of [{...f.staff.manager,orgId:other.org,liveOrgId:other.org},
    {...f.staff.manager,environment:"sandbox" as const},{...f.staff.manager,sessionId:randomUUID()},
    {...f.staff.manager,kind:"tenant" as const},{...f.staff.manager,role:null}])
    await assert.rejects(brandTenantOne(s,id,ON),denied);
  await db.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[f.staff.manager.sessionId]);
  await assert.rejects(brandTenantOne(f.staff.manager,id,ON),denied);
  await db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[f.staff.admin.sessionId]);
  await assert.rejects(brandTenantOne(f.staff.admin,id,ON),denied);
  for(const [sql,args] of [[ADMIT,[f.org,f.staff.admin.sessionId,f.staff.admin.userId,"live",f.org]],
    [CONTACT,[f.org,id,true]],[LEASES,[f.org,id,true]]] as const){
    await db.query("BEGIN");try{await db.query("SET LOCAL ROLE anon");await assert.rejects(db.query(sql,[...args]),(e:unknown)=>(e as {code?:string}).code==="42501");}finally{await db.query("ROLLBACK");}
  }
});
test("detail population: zero leases; primary/co-tenant by directory gate; archived and non-tenants hidden",async()=>{
  for(const directory of [false,true]){
    const f=await fixture(directory);
    const empty=await contact(f,0,null,null),co=await contact(f,1,null,"co_tenant");
    assert.deepEqual((await read(f.staff.manager,empty)).leases,[]);
    assert.equal((await read(f.staff.manager,co)).leases.length,directory?1:0);
    for(const hidden of [await contact(f,2,null,"primary",true),await contact(f,3,null,"primary",false,false),randomUUID()])
      assert.deepEqual(await brandTenantOne(f.staff.manager,hidden,ON),{state:"not_found"});
  }
});
test("lead inputs retain null date and historical status; only actual org-scoped LINE links",async()=>{
  const f=await fixture();const id=await contact(f,0);
  await db.query("UPDATE leases SET end_date=NULL WHERE id=$1",[f.lease]);
  assert.equal((await read(f.staff.manager,id)).leases[0].endDate,null);
  await db.query("UPDATE leases SET status='ended',end_date='2031-01-01' WHERE id=$1",[f.lease]);
  assert.equal((await read(f.staff.manager,id)).leases[0].status,"ended");
  const channel=(await db.query(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,messaging_channel_secret_ref,messaging_access_token_ref)
    VALUES($1,'org_owned','Synthetic',$2,$3,'synthetic-reference','synthetic-reference') RETURNING id::text`,[f.org,randomUUID(),randomUUID()])).rows[0].id;
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status,line_user_id,linked_at)
    VALUES($1,$2,$3,'linked',$4,now())`,[f.org,id,channel,'U'+'2'.repeat(32)]);
  assert.equal((await read(f.staff.manager,id)).lineLinked,true);
  await db.query("UPDATE line_account_links SET status='unlinked',line_user_id=NULL,linked_at=NULL WHERE org_id=$1",[f.org]);
  assert.equal((await read(f.staff.manager,id)).lineLinked,false);
});
test("mobile item requires boolean platform/org admission and selected-org allowlist",async()=>{
  const f=await fixture(true,false),id=await contact(f,0,"+19995550123"),missing=await contact(f,1,null,null);
  const enabled={enabled:true,allowed_org_ids:[f.org]};
  const cases:[unknown,unknown,boolean][]=[
    [null,{},false],[null,{tenant_mobile_required:true},false],[enabled,{},false],
    [{enabled:false,allowed_org_ids:[f.org]},{tenant_mobile_required:true},false],
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
    const result=await read(f.staff.manager,id);assert.equal(result.mobileRequired,on);assert.equal(result.phone,"+19995550123");
    assert.equal("legacyPhoneNotice" in result,on);assert.equal("legacyPhoneNotice" in await read(f.staff.manager,missing),false);
    assert.deepEqual(await brandTenantOne(f.staff.manager,id,{v3:async()=>false}),{state:"off"});
  }
});
test("sandbox scope cannot inherit live phone, LINE or item admission",async()=>{
  const live=await fixture(true),sandbox=await fixture(true);
  await db.query("UPDATE organizations SET environment='sandbox',live_org_id=$2 WHERE id=$1",[sandbox.org,live.org]);
  const a=await contact(live,0,"+19995550111"),b=await contact(sandbox,1,"+19995550222");
  const session={...live.staff.manager,orgId:sandbox.org,environment:"sandbox" as const};
  assert.equal((await read(session,b)).phone,"+19995550222");
  assert.deepEqual(await brandTenantOne(session,a,ON),{state:"not_found"});
  await db.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='tenant_mobile_required'",[live.org]);
  assert.equal((await read(session,b)).mobileRequired,false);
});
test("B-017 custom props.view alone omits phone/email; contact grant allows; revocation inside snapshot denies",async()=>{
  const f=await fixture(),id=await contact(f,0,"+19995550123");
  await db.query("UPDATE contacts SET email='synthetic@example.test' WHERE id=$1",[id]);
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
    await assign();const limited=await fresh();const result=await read(limited,id);
    assert.equal(result.canViewContact,false);for(const key of ["phone","email","legacyPhoneNotice"])assert.equal(key in result,false);
    await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["props.view","tenants.contact"],requestId:randomUUID()});await assign();
    const allowed=await fresh();assert.equal((await read(allowed,id)).phone,"+19995550123");
    const revoked:typeof tx=async(...args)=>{
      await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["tenants.contact"],requestId:randomUUID()});await assign();return tx(...args);
    };
    await assert.rejects(brandTenantOne(allowed,id,{...ON,transaction:revoked}),denied);
  }finally{if(previous===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=previous;}
});
