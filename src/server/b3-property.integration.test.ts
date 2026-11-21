import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { brandProperty, PROPERTY_ADMISSION_SQL as ADMIT, PROPERTY_SQL as PROPERTY, PROPERTY_ROOMS_SQL as ROOMS } from "./b3-property";
import { staffInviteVisible, staffInviteEntries } from "./b040-staff-ui";
import { governCustomRole } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError } from "./errors";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Mac only. Fully migrated disposable clone; no migrations, seed or send adapters.
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
async function fixture(n=5) {
  const org=(await db.query(`INSERT INTO organizations(name,country_code,default_currency,timezone)
    VALUES('R2 PROP synthetic','US','USD','America/Los_Angeles') RETURNING id::text`)).rows[0].id as string;
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
    VALUES($1,'R2 property','US','USD','America/Los_Angeles') RETURNING id::text`,[org])).rows[0].id as string;
  const unit=(await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode)
    VALUES($1,$2,'U','by_room') RETURNING id::text`,[org,property])).rows[0].id as string;
  const rooms=(await db.query(`INSERT INTO rooms(org_id,unit_id,label,room_type)
    SELECT $1,$2,'Room '||lpad(n::text,3,'0'),'suite'::room_type FROM generate_series(1,$3::int) n RETURNING id::text`,[org,unit,n])).rows.map(r=>r.id as string);
  return {org,staff,property,unit,rooms};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function lease(f:Fixture,room:string|null,status:string,unit=f.unit){
  return (await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$4,CASE WHEN $4::uuid IS NULL THEN $3::uuid END,$5::lease_status,'imported','2030-01-01','2031-01-01','USD',0) RETURNING id::text`,[f.org,f.property,unit,room,status])).rows[0].id as string;
}
async function read(s:Session,id:string){
  const result=await brandProperty(s,id,ON);assert.equal(result.state,"ready");
  if(result.state!=="ready")assert.fail("reader unavailable");return result;
}
test("uncapped targets, occupancy parity, no lease fan-out, room states and inherited pending facts",async()=>{
  const f=await fixture(57);
  const active=await lease(f,f.rooms[0],"active");await lease(f,f.rooms[1],"pending_signature");await lease(f,f.rooms[2],"draft");
  await lease(f,f.rooms[3],"ended");await lease(f,f.rooms[3],"terminated");
  for(const role of ["primary","co_tenant"]){
    const contact=(await db.query("INSERT INTO contacts(org_id,display_name,is_tenant) VALUES($1,'Synthetic tenant',true) RETURNING id",[f.org])).rows[0].id;
    await db.query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,$4::lease_party_role)",[f.org,active,contact,role]);
  }
  const a=await read(f.staff.manager,f.property);
  assert.equal(a.rooms,57);assert.equal(a.rows.length,57);assert.equal(a.occupied,2);
  assert.equal(a.pending,57*3-3);assert.equal(a.unknown,57*2-1);
  assert.deepEqual(a.rows.slice(0,5).map(r=>r.status),["active","pending_signature","draft","vacant","vacant"]);
  assert.equal(a.rows[0].tenantReady,true);assert.deepEqual(a.rows[0].unknown,["money"]);
  const owner=(await db.query("INSERT INTO contacts(org_id,display_name,is_owner) VALUES($1,'Synthetic owner',true) RETURNING id",[f.org])).rows[0].id;
  await db.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)",[f.org,f.property,owner]);
  await db.query(`UPDATE properties SET address='{"city":"Synthetic city","street":"Synthetic street"}' WHERE id=$1`,[f.property]);
  const noFloor=await read(f.staff.manager,f.property);assert.ok(noFloor.rows.every(r=>r.pending.includes("address")));
  await db.query("UPDATE units SET floor='3' WHERE id=$1",[f.unit]);
  const b=await read(f.staff.manager,f.property);assert.equal(b.pending,a.pending-114);
  assert.ok(b.rows.every(r=>r.moneyReady===null)); // owner alone never proves money setup
  assert.ok(b.rows.every(r=>!r.pending.includes("owner")&&!r.pending.includes("address")));
});
test("whole-home target, archived children, zero-target empty and archived read-only property",async()=>{
  const f=await fixture(2);
  const whole=(await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode,floor) VALUES($1,$2,'','whole_unit','1') RETURNING id::text`,[f.org,f.property])).rows[0].id;
  await lease(f,null,"pending_signature",whole);
  let result=await read(f.staff.manager,f.property);assert.equal(result.rooms,3);assert.equal(result.occupied,1);
  const row=result.rows.find(r=>r.kind==="whole_unit")!;assert.equal(row.label,"");assert.equal(row.tasks.some(t=>t.key==="roomType"),false);
  await db.query("UPDATE rooms SET archived_at=now() WHERE id=$1",[f.rooms[0]]);
  result=await read(f.staff.manager,f.property);assert.equal(result.rooms,2);
  await db.query("UPDATE units SET archived_at=now() WHERE id=$1",[f.unit]);
  result=await read(f.staff.manager,f.property);assert.equal(result.rooms,1);
  await db.query("UPDATE properties SET archived_at=now() WHERE id=$1",[f.property]);
  result=await read(f.staff.manager,f.property);assert.equal(result.archived,true);assert.equal(result.canInvite,false);
  await db.query("UPDATE units SET archived_at=now() WHERE id=$1",[whole]);
  result=await read(f.staff.manager,f.property);assert.deepEqual(result.rows,[]);assert.equal(result.rooms,0);assert.equal(result.occupied,0);
});
test("native admin/manager, forged accountant/maintenance roles and existing invite flag gates",async()=>{
  const f=await fixture();
  for(const role of ["admin","manager"] as const)assert.equal((await read(f.staff[role],f.property)).canInvite,true);
  for(const s of [f.staff.accountant,{...f.staff.accountant,role:"admin" as const}])assert.equal((await read(s,f.property)).canInvite,false);
  for(const s of [f.staff.maintenance,{...f.staff.maintenance,role:"admin" as const}])await assert.rejects(brandProperty(s,f.property,ON),denied);
  assert.equal(await staffInviteVisible(f.staff.manager),false);
  assert.deepEqual(await staffInviteEntries(f.staff.manager,[{id:f.rooms[0],kind:"room"}]),[]);
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('unit_line_invite',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[f.org]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"unit_line_invite":true}'::jsonb WHERE id=$1`,[f.org]);
  assert.equal(await staffInviteVisible(f.staff.manager),true);assert.equal(await staffInviteVisible(f.staff.accountant),false);
  // Existing backend maps every split room to the same unit, not separate invitations.
  const entries=await staffInviteEntries(f.staff.manager,f.rooms.map(id=>({id,kind:"room" as const})));
  assert.equal(entries.length,5);assert.equal(new Set(entries.map(e=>e.unitId)).size,1);
});
test("cross-org lookup and SQL denial, session/environment forgery, anon and revocation",async()=>{
  const f=await fixture(),other=await fixture();
  assert.deepEqual(await brandProperty(f.staff.manager,other.property,ON),{state:"not_found"});
  const cross=await tx(f.staff.manager.userId,async c=>({
    property:(await c.query(PROPERTY,[other.org,other.property])).rows,
    rooms:(await c.query(ROOMS,[other.org,other.property])).rows,
  }),{orgId:f.org,environment:"live"},{readOnly:true});
  assert.deepEqual(cross,{property:[],rooms:[]});
  for(const s of [{...f.staff.manager,orgId:other.org,liveOrgId:other.org},{...f.staff.manager,environment:"sandbox" as const},
    {...f.staff.manager,sessionId:randomUUID()},{...f.staff.manager,kind:"tenant" as const},{...f.staff.manager,role:null}])
    await assert.rejects(brandProperty(s,f.property,ON),denied);
  await db.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[f.staff.manager.sessionId]);
  await assert.rejects(brandProperty(f.staff.manager,f.property,ON),denied);
  await db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[f.staff.admin.sessionId]);
  await assert.rejects(brandProperty(f.staff.admin,f.property,ON),denied);
  for(const [sql,args] of [[ADMIT,[f.org,f.staff.admin.sessionId,f.staff.admin.userId,"live",f.org]],[PROPERTY,[f.org,f.property]],[ROOMS,[f.org,f.property]]] as const){
    await db.query("BEGIN");try{await db.query("SET LOCAL ROLE anon");await assert.rejects(db.query(sql,[...args]),(e:unknown)=>(e as {code?:string}).code==="42501");}finally{await db.query("ROLLBACK");}
  }
});
test("B-017 props.view alone permits read-only, leases.edit restores capability, snapshot revocation denies",async()=>{
  const f=await fixture();
  await db.query("UPDATE org_members SET is_billing_owner=true WHERE org_id=$1 AND user_id=$2",[f.org,f.staff.admin.userId]);
  const previous=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  try{
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST=JSON.stringify([f.org]);
    await db.query(`INSERT INTO platform_settings(key,value) VALUES('custom_roles',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[f.org]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"custom_roles":true}'::jsonb WHERE id=$1`,[f.org]);
    const memberId=(await db.query("SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2",[f.org,f.staff.manager.userId])).rows[0].id;
    const roleId=(await governCustomRole(f.staff.admin,{operation:"create",grants:["props.view"],requestId:randomUUID()})).roleId!;
    const assign=()=>governCustomRole(f.staff.admin,{operation:"assign",roleId,memberId,requestId:randomUUID()});
    const fresh=async()=>{
      const sessionId=randomUUID();await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[sessionId,f.staff.manager.userId,randomUUID()]);
      return {...f.staff.manager,sessionId};
    };
    await assign();assert.equal((await read(await fresh(),f.property)).canInvite,false);
    await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["props.view","leases.edit"],requestId:randomUUID()});await assign();
    const allowed=await fresh();assert.equal((await read(allowed,f.property)).canInvite,true);
    const revoked:typeof tx=async(...args)=>{
      await governCustomRole(f.staff.admin,{operation:"revise",roleId,grants:["leases.edit"],requestId:randomUUID()});await assign();return tx(...args);
    };
    await assert.rejects(brandProperty(allowed,f.property,{...ON,transaction:revoked}),denied);
  }finally{if(previous===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=previous;}
});
test("selected sandbox uses its own property facts and live-org membership, never live target data",async()=>{
  const live=await fixture(2),sandbox=await fixture(3);
  await db.query("UPDATE organizations SET environment='sandbox',live_org_id=$2 WHERE id=$1",[sandbox.org,live.org]);
  const session={...live.staff.manager,orgId:sandbox.org,environment:"sandbox" as const};
  assert.equal((await read(session,sandbox.property)).rooms,3);
  assert.deepEqual(await brandProperty(session,live.property,ON),{state:"not_found"});
  assert.deepEqual(await brandProperty(live.staff.manager,sandbox.property,ON),{state:"not_found"});
});
