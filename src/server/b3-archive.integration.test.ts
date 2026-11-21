import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Client} from 'pg';
import {archiveCommand,archiveList,archiveScope,archiveView} from './record-archive';
import {cloneTestDatabase} from './test-database-clone';
import {disposableDbUrl} from './test-disposable-db';
import {tx} from './db';
import type {Session} from './types';
import type {ArchiveRef,ArchiveTab} from '../lib/record-archive';

// Mac execution only: already-migrated disposable clone, no migration/seed/send.
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>,db:Client;
const saved=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(async()=>{clone=await cloneTestDatabase();process.env.CUSTOM_ROLES_ORG_ALLOWLIST='';db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();});
test.after(async()=>{await db?.end();await clone?.cleanup();if(saved===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=saved;});
type Role='admin'|'manager'|'accountant'|'maintenance';
async function fixture(rooms=2){
 const org=(await db.query(`INSERT INTO organizations(name,country_code,default_currency,timezone,feature_flags) VALUES('Archive synthetic','US','USD','America/Los_Angeles','{"brand_v2":true,"brand_v3":true,"record_archive":true}') RETURNING id::text`)).rows[0].id as string;
 const staff={} as Record<Role,Session>;
 for(const role of ['admin','manager','accountant','maintenance'] as const){
  const user=randomUUID(),sid=randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at,role,aud) VALUES($1,$2,'{}',now(),'authenticated','authenticated')`,[user,`${user}@example.test`]);
  await db.query(`INSERT INTO profiles(id,display_name) VALUES($1,'Archive member') ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name`,[user]);
  await db.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,$3::org_role,'active')`,[org,user,role]);
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,user,randomUUID()]);
  staff[role]={userId:user,sessionId:sid,orgId:org,liveOrgId:org,environment:'live',kind:'staff',role,locale:'en',calendar:'gregorian',leaseId:null,name:'Synthetic',email:''};
 }
 await db.query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[org]);
 const property=(await db.query(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'Archive property','US','USD','America/Los_Angeles') RETURNING id::text`,[org])).rows[0].id as string;
 const unit=(await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'U','by_room') RETURNING id::text`,[org,property])).rows[0].id as string;
 const roomIds=(await db.query(`INSERT INTO rooms(org_id,unit_id,label) SELECT $1,$2,'R'||n::text FROM generate_series(1,$3::int) n RETURNING id::text`,[org,unit,rooms])).rows.map(r=>r.id as string);
 return {org,staff,property,unit,rooms:roomIds};
}
async function view(s:Session,ref:ArchiveRef){const v=await archiveView(s,ref,true);assert.equal(v.state,'ready');if(v.state!=='ready')assert.fail('Unavailable view');return v;}
async function page(s:Session,tab:ArchiveTab,after?:string){const v=await archiveList(s,after,tab);assert.equal(v.state,'ready');if(v.state!=='ready')assert.fail('Unavailable list');return v;}
async function command(s:Session,ref:ArchiveRef,desired:'archived'|'active'){
 const v=await view(s,ref),requestId=randomUUID();const result=await archiveCommand(s,{ref,desired,expectedVersion:v.observed.version,renderedScope:archiveScope(s),reason:'Archive integration',requestId});return {result,requestId};
}
test('real inherited archive rows, uncapped totals and filtered keyset pages use the existing reader',async()=>{
 const f=await fixture(205),s=f.staff.admin,ref={kind:'property' as const,id:f.property};
 assert.equal((await command(s,ref,'archived')).result.state,'changed');
 const first=await page(s,'all');assert.deepEqual(first.counts,{property:1,unit:206,owner:0,total:207});assert.equal(first.rows.length,200);assert.ok(first.nextCursor);
 const second=await page(s,'all',first.nextCursor!);assert.equal(second.rows.length,7);assert.deepEqual(second.counts,first.counts);assert.equal(new Set([...first.rows,...second.rows].map(r=>`${r.ref.kind}:${r.ref.id}`)).size,207);
 const properties=await page(s,'property');assert.equal(properties.rows.length,1);assert.equal(properties.rows[0].ref.id,f.property);assert.equal(properties.rows[0].archivedBy,'Archive member');
 const units=await page(s,'unit');assert.equal(units.rows.length,200);assert.ok(units.rows.every(r=>r.ref.kind==='unit'||r.ref.kind==='room'));assert.ok(units.rows.every(r=>r.inherited.length===1&&r.archivedAtUtc===null&&!r.restoreEligible));
 const rest=await page(s,'unit',units.nextCursor!);assert.equal(rest.rows.length,6);assert.deepEqual(units.counts,first.counts);
 const owners=await page(s,'owner');assert.deepEqual(owners.rows,[]);assert.deepEqual(owners.counts,first.counts);
 assert.equal((await archiveList(s,'bad','unit')).state,'unavailable');
});
test('restoration uses the existing audit trigger; metadata identifies the archiver rather than a later editor',async()=>{
 const f=await fixture(),s=f.staff.admin,ref={kind:'property' as const,id:f.property};
 const old=await view(s,ref);assert.equal((await archiveView(s,ref)).state,'ready');
 assert.equal((await command(s,ref,'archived')).result.state,'changed');
 const a=await view(s,ref);assert.equal(a.observed.archivedBy,'Archive member');assert.notEqual(a.observed.version,old.observed.version);
 // A later name change has archived_at in its row snapshot but is not an archive event.
 await db.query(`UPDATE properties SET name='Renamed archived record' WHERE id=$1`,[f.property]);
 assert.equal((await view(s,ref)).observed.archivedBy,'Archive member');
 const restore=await command(s,ref,'active');assert.equal(restore.result.state,'changed');
 const audit=await db.query(`SELECT actor_user_id::text actor,reason,new_row->>'archived_at' archived FROM audit_log WHERE org_id=$1 AND table_name='properties' AND row_id=$2 AND request_id=$3`,[f.org,f.property,restore.requestId]);
 assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor,s.userId);assert.equal(audit.rows[0].reason,'Archive integration');assert.equal(audit.rows[0].archived,null);
 assert.deepEqual((await page(s,'all')).counts,{property:0,unit:0,owner:0,total:0});
 assert.equal((await view(s,{kind:'room',id:f.rooms[0]})).observed.inherited.length,0);
});
test('same role admission, scoped metadata, cross-org and anonymous denial; no read widens authority',async()=>{
 const f=await fixture(),ref={kind:'property' as const,id:f.property};
 assert.equal((await command(f.staff.manager,ref,'archived')).result.state,'changed');
 assert.equal((await page(f.staff.manager,'all')).rows[0].restoreEligible,false);
 // The existing audit RLS is admin-only. Never bypass it to populate a name.
 assert.equal((await view(f.staff.manager,ref)).observed.archivedBy,null);
 assert.equal((await page(f.staff.accountant,'all')).rows[0].restoreEligible,false);
 const v=await view(f.staff.accountant,ref);assert.equal(v.writeEnabled,false);
 assert.equal((await archiveList(f.staff.maintenance,undefined,'all')).state,'unavailable');
 const input={ref,desired:'active' as const,expectedVersion:v.observed.version,renderedScope:archiveScope(f.staff.accountant),reason:'Read only',requestId:randomUUID()};
 assert.equal((await archiveCommand(f.staff.accountant,input)).state,'forbidden');
 const foreign=await fixture();assert.equal((await archiveView(foreign.staff.admin,ref,true)).state,'unavailable');assert.equal((await page(foreign.staff.admin,'all')).counts?.total,0);
 // The existing (unchanged) command maps a cross-org ref to its fail-closed 'unknown' outcome; what matters is no write.
 const before=(await db.query(`SELECT archived_at FROM properties WHERE id=$1`,[f.property])).rows[0].archived_at;
 const crossOrg=(await archiveCommand(foreign.staff.admin,{...input,renderedScope:archiveScope(foreign.staff.admin)})).state;
 assert.ok(['forbidden','unknown','unavailable'].includes(crossOrg),crossOrg); assert.notEqual(crossOrg,'changed');
 assert.deepEqual((await db.query(`SELECT archived_at FROM properties WHERE id=$1`,[f.property])).rows[0].archived_at,before);
 const anonymous={...f.staff.admin,userId:'',sessionId:'',role:null};
 assert.equal((await archiveList(anonymous,undefined,'all')).state,'unavailable');assert.equal((await archiveView(anonymous,ref,true)).state,'unavailable');assert.equal((await archiveCommand(anonymous,{...input,renderedScope:archiveScope(anonymous)})).state,'forbidden');
 const raw=await tx('',c=>c.query(`SELECT id FROM properties WHERE id=$1`,[f.property]),{pin:false});assert.equal(raw.rowCount,0);
});
test('real active and pending leases are counted using the same blocker scope',async()=>{
 const f=await fixture(),s=f.staff.admin,ref={kind:'property' as const,id:f.property};
 for(const [index,status] of ['active','pending_signature'].entries())await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,$5::lease_status,'imported','2030-01-01','2031-01-01','USD',0)`,[f.org,f.property,f.unit,f.rooms[index],status]);
 const v=await view(s,ref);assert.equal(v.blockers.find(b=>b.label==='lease_active')?.count,2);assert.equal(v.canArchive,false);
 assert.equal((await command(s,ref,'archived')).result.state,'blocked');
});
