import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, USERS } from "./ids";
import type { Session } from "./types";
import { compareRenewal,renewalComparisonView } from "./renewal-comparison";
import { renewalMajor } from "@/lib/renewal-comparison";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});test.after(async()=>{await clone.cleanup();});
test("renewal preview uses current authenticated context, strict flags and fresh lease data",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
  const s:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 AND status='active' ORDER BY id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(lease);
  await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"lease_renewal":true}'::jsonb WHERE id=$1`,[ORG_ID]);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`INSERT INTO platform_settings(key,value) VALUES ('lease_renewal','{"enabled":"true","allowed_org_ids":[]}'::jsonb)`);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,123)) WHERE key='lease_renewal'`,[ORG_ID]);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='lease_renewal'`,[ORG_ID]);
  const view=await renewalComparisonView(s,lease.id);assert.ok(view);assert.equal(await renewalComparisonView({...s,role:'accountant'},lease.id),null);assert.equal(await renewalComparisonView({...s,needsSandbox:true},lease.id),null);assert.equal(await renewalComparisonView({...s,sessionId:randomUUID()},lease.id),null);assert.equal(await renewalComparisonView({...s,orgId:randomUUID()},lease.id),null);
  const accountantSid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[accountantSid,USERS.accountant,randomUUID()]);assert.equal(await renewalComparisonView({...s,userId:USERS.accountant,sessionId:accountantSid,role:'accountant'},lease.id),null);assert.equal(await renewalComparisonView({...s,kind:'tenant',role:null,userId:USERS.tenant},lease.id),null);assert.equal(await renewalComparisonView(s,randomUUID()),null);
  const i={startDate:view.terms.startDate,endMode:"date",endDate:view.terms.startDate,rent:renewalMajor(view.terms.rentMinor,view.terms.minorUnit),frequency:view.terms.frequency,dueDay:String(view.terms.dueDay),deposit:renewalMajor(view.terms.depositMinor,view.terms.minorUnit)};
  const before=(await c.query(`SELECT (SELECT count(*) FROM leases)::text leases,(SELECT count(*) FROM payments)::text payments,(SELECT count(*) FROM invoices)::text invoices,(SELECT count(*) FROM ledger_transactions)::text ledger`)).rows[0];
  const result=await compareRenewal(s,lease.id,view.fingerprint,i);assert.equal(result.state,'ready');if(result.state==='ready'){assert.equal(result.overlap,true);assert.equal(result.current.rentMinor,view.terms.rentMinor);assert.equal(result.proposed.depositMinor,view.terms.depositMinor);}
  assert.equal((await compareRenewal(s,lease.id,view.fingerprint,{...i,rent:'1e5'})).state,'invalid');assert.deepEqual((await c.query(`SELECT (SELECT count(*) FROM leases)::text leases,(SELECT count(*) FROM payments)::text payments,(SELECT count(*) FROM invoices)::text invoices,(SELECT count(*) FROM ledger_transactions)::text ledger`)).rows[0],before);
  await c.query(`UPDATE leases SET notes=coalesce(notes,'') || ' synthetic' WHERE id=$1`,[lease.id]);assert.equal((await compareRenewal(s,lease.id,view.fingerprint,i)).state,'stale');
  await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);assert.equal(await renewalComparisonView(s,lease.id),null);
 }finally{await c.end();}
});

test("inclusive unbounded conflicts respect whole-unit and separate-room scope",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
  await c.query(`INSERT INTO platform_settings(key,value) VALUES('lease_renewal',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"lease_renewal":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  const property=(await c.query<{id:string;currency:string}>(`SELECT id::text,currency::text FROM properties WHERE org_id=$1 AND archived_at IS NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(property);
  const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,'whole_unit') RETURNING id::text`,[ORG_ID,property.id,randomUUID()])).rows[0].id;
  const whole=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'ended','2029-01-01','2029-12-31',$4,10000) RETURNING id::text`,[ORG_ID,property.id,unit,property.currency])).rows[0].id;
  await c.query(`UPDATE units SET rental_mode='by_room' WHERE id=$1`,[unit]);
  const a=(await c.query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'synthetic-a') RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
  const b=(await c.query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'synthetic-b') RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
  const room=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'ended','2029-01-01','2029-12-31',$5,10000) RETURNING id::text`,[ORG_ID,property.id,unit,a,property.currency])).rows[0].id;
  const pending=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'pending_signature','2031-01-01',NULL,$5,10000) RETURNING id::text`,[ORG_ID,property.id,unit,b,property.currency])).rows[0].id;
  const s:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  for(const [id,expected] of [[whole,true],[room,false]] as const){const view=await renewalComparisonView(s,id);assert.ok(view);const i={startDate:'2031-01-01',endMode:'date',endDate:'2031-01-01',rent:renewalMajor(view.terms.rentMinor,view.terms.minorUnit),frequency:view.terms.frequency,dueDay:String(view.terms.dueDay),deposit:renewalMajor(view.terms.depositMinor,view.terms.minorUnit)};const r=await compareRenewal(s,id,view.fingerprint,i);assert.equal(r.state,'ready');if(r.state==='ready')assert.equal(r.overlap,expected); if(id===whole){const finite=await compareRenewal(s,id,view.fingerprint,{...i,startDate:'2030-01-01',endDate:'2030-12-31'});assert.equal(finite.state,'ready');if(finite.state==='ready')assert.equal(finite.overlap,false);const open=await compareRenewal(s,id,view.fingerprint,{...i,startDate:'2030-01-01',endMode:'open_ended',endDate:''});assert.equal(open.state,'ready');if(open.state==='ready'){assert.equal(open.proposed.endDate,null);assert.equal(open.overlap,true);}}}
  const ongoing=await renewalComparisonView(s,pending);assert.ok(ongoing);assert.equal(ongoing.terms.endDate,null);const unbounded=await compareRenewal(s,pending,ongoing.fingerprint,{startDate:'2050-01-01',endMode:'open_ended',endDate:'',rent:renewalMajor(ongoing.terms.rentMinor,ongoing.terms.minorUnit),frequency:ongoing.terms.frequency,dueDay:String(ongoing.terms.dueDay),deposit:renewalMajor(ongoing.terms.depositMinor,ongoing.terms.minorUnit)});assert.equal(unbounded.state,'ready');if(unbounded.state==='ready')assert.equal(unbounded.overlap,true);
 }finally{await c.end();}
});
