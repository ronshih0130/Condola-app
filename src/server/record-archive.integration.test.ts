import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { query } from './db';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { archiveCommand, archiveList, archiveScope, archiveView } from './record-archive';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { ensureSandbox } from './sandbox';
import { propertyDetail } from './queries';
import type { Session } from './types';
import type { ArchiveRef } from '@/lib/record-archive';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{
 clone=await cloneTestDatabase();
 const names=['DEMO_MODE','ID_DOC_ENCRYPTION_KEY','ID_DOC_HMAC_KEY','ID_DOC_SIGNING_SECRET','CRON_SECRET'] as const;
 const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 try{process.env.DEMO_MODE='true';for(const key of names.slice(1))process.env[key]=randomBytes(32).toString('hex');await resetAndSeed();}
 finally{for(const key of names){const v=saved[key];if(v===undefined)delete process.env[key];else process.env[key]=v;}}
});
test.after(async()=>{await clone?.cleanup();});
async function person(role:'admin'|'manager'|'accountant'):Promise<Session> {
 const id=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,USERS[role],randomUUID()]);
 return {userId:USERS[role],sessionId:id,email:'',name:role,kind:'staff',role,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
}
async function fixture(){
 const property=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 workflow ${randomUUID()}`])).rows[0].id;
 const unit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'one','by_room') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
 const room=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'room') RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
 return {property,unit,room};
}
async function ready(s:Session,ref:ArchiveRef){const v=await archiveView(s,ref);assert.equal(v.state,'ready');if(v.state!=='ready')throw new Error('View unavailable');return v;}
async function command(s:Session,ref:ArchiveRef,desired:'active'|'archived',version:string,requestId=randomUUID()) {return archiveCommand(s,{ref,desired,expectedVersion:version,renderedScope:archiveScope(s),reason:'Retired after operations',requestId});}

test('property detail exposes the actual empty by-room unit for normal archive navigation',async()=>{
 const s=await person('manager'),f=await fixture();
 const empty=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'empty','by_room') RETURNING id::text`,[ORG_ID,f.property])).rows[0].id;
 const hidden=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,archived_at) VALUES($1,$2,'hidden','by_room',clock_timestamp()) RETURNING id::text`,[ORG_ID,f.property])).rows[0].id;
 const detail=await propertyDetail(s,f.property);assert.ok(detail);assert.ok(detail.byRoomUnits.some(unit=>unit.id===empty&&unit.label==='empty'));assert.ok(detail.byRoomUnits.some(unit=>unit.id===f.unit));assert.ok(!detail.byRoomUnits.some(unit=>unit.id===hidden));
});

test('archive and restore preserve ancestry, audit, stale versions, and role boundaries',async()=>{
 const admin=await person('admin'),manager=await person('manager'),accountant=await person('accountant');const f=await fixture();
 const property={kind:'property' as const,id:f.property},unit={kind:'unit' as const,id:f.unit},room={kind:'room' as const,id:f.room};
 let v=await ready(admin,property);assert.equal(v.writeEnabled,false);assert.equal((await command(admin,property,'archived',v.observed.version)).state,'disabled');
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 v=await ready(admin,property);assert.equal(v.blockers.length,0);const oldVersion=v.observed.version,requestId=randomUUID();
 assert.equal((await command(accountant,property,'archived',oldVersion)).state,'forbidden');
 assert.equal((await command(admin,property,'archived',oldVersion,requestId)).state,'changed');
 const currentProperty=await ready(admin,property);assert.equal((await command(admin,property,'archived',currentProperty.observed.version)).state,'already_in_desired_state');
 const audit=await query<{actor:string;reason:string;request_id:string}>(`SELECT actor_user_id::text actor,reason,request_id FROM audit_log WHERE org_id=$1 AND table_name='properties' AND row_id=$2 AND request_id=$3`,[ORG_ID,f.property,requestId]);
 assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor,admin.userId);assert.equal(audit.rows[0].reason,'Retired after operations');
 let r=await ready(manager,room);assert.equal(r.observed.inherited.length,1);assert.equal((await command(manager,room,'archived',r.observed.version)).state,'changed');
 r=await ready(manager,room);assert.equal((await command(manager,room,'active',r.observed.version)).state,'blocked');
 v=await ready(manager,property);assert.equal((await command(manager,property,'active',v.observed.version)).state,'changed');
 assert.equal((await command(admin,property,'archived',oldVersion)).state,'stale');
 r=await ready(manager,room);assert.equal(r.observed.inherited.length,0);assert.notEqual(r.observed.archivedAtUtc,null);assert.equal((await command(manager,room,'active',r.observed.version)).state,'changed');
 const u=await ready(admin,unit);assert.equal((await command(admin,unit,'archived',u.observed.version)).state,'changed');
 const inherited=await ready(admin,room);assert.equal(inherited.observed.inherited[0]?.ref.kind,'unit');
 const archivedUnit=await ready(admin,unit);assert.equal((await command(admin,unit,'active',archivedUnit.observed.version)).state,'changed');assert.equal((await ready(admin,room)).observed.inherited.length,0);
});

test('missing or malformed controls, stale scope, and expired sessions fail closed',async()=>{
 const s=await person('admin');const f=await fixture();const ref={kind:'property' as const,id:f.property};
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 for(const value of [{enabled:true,allowed_org_ids:'all'},{enabled:'true',allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:[ORG_ID,'not-a-uuid']},{enabled:true,allowed_org_ids:[]}] ) {
  await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[JSON.stringify(value)]);
  const v=await ready(s,ref);assert.equal(v.writeEnabled,false);assert.equal((await command(s,ref,'archived',v.observed.version)).state,'disabled');
 }
 await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='record_archive'`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{record_archive}','false'::jsonb,true) WHERE id=$1`,[ORG_ID]);assert.equal((await ready(s,ref)).writeEnabled,false);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const v=await ready(s,ref);const input={ref,desired:'archived' as const,expectedVersion:v.observed.version,renderedScope:{...archiveScope(s),actorId:USERS.manager},reason:'Retired',requestId:randomUUID()};
 assert.equal((await archiveCommand(s,input)).state,'forbidden');
 await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[s.sessionId]);
 assert.equal((await command(s,ref,'archived',v.observed.version)).state,'forbidden');assert.equal((await archiveView(s,ref)).state,'unavailable');
 assert.equal((await query<{archived:boolean}>(`SELECT archived_at IS NOT NULL archived FROM properties WHERE id=$1`,[f.property])).rows[0].archived,false);
});

test('room restore requires usable current mode and cross-organization targets stay hidden',async()=>{
 const s=await person('admin');const f=await fixture();await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const room={kind:'room' as const,id:f.room};let v=await ready(s,room);assert.equal((await command(s,room,'archived',v.observed.version)).state,'changed');
 await query(`UPDATE units SET rental_mode='whole_unit' WHERE org_id=$1 AND id=$2`,[ORG_ID,f.unit]);v=await ready(s,room);assert.equal(v.canRestore,false);assert.equal((await command(s,room,'active',v.observed.version)).state,'blocked');
 await query(`UPDATE units SET rental_mode='by_room' WHERE org_id=$1 AND id=$2`,[ORG_ID,f.unit]);v=await ready(s,room);assert.equal((await command(s,room,'active',v.observed.version)).state,'changed');
 const foreign=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG2_ID,`B015 foreign ${randomUUID()}`])).rows[0].id;
 assert.equal((await archiveView(s,{kind:'property',id:foreign})).state,'unavailable');
});

test('sandbox archive is bound to the selected environment and cannot accept a live-tab scope',async()=>{
 const live=await person('admin'),sandboxOrg=await ensureSandbox(live);const sandbox:Session={...live,orgId:sandboxOrg,liveOrgId:ORG_ID,environment:'sandbox'};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[sandboxOrg]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[sandboxOrg]);
 const property=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[sandboxOrg,`B015 sandbox ${randomUUID()}`])).rows[0].id;
 const ref={kind:'property' as const,id:property};const view=await ready(sandbox,ref);
 const input={ref,desired:'archived' as const,expectedVersion:view.observed.version,renderedScope:archiveScope(live),reason:'Sandbox only',requestId:randomUUID()};
 assert.equal((await archiveCommand(sandbox,input)).state,'forbidden');
 assert.equal((await archiveCommand(sandbox,{...input,renderedScope:archiveScope(sandbox)})).state,'changed');
 assert.equal((await archiveView(live,ref)).state,'unavailable');
});

test('more than 200 archived records remain reachable exactly once by strict keyset cursors',async()=>{
 const s=await person('admin');const names=Array.from({length:230},()=>`B015 page ${randomUUID()}`);
 const inserted=await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,archived_at) SELECT $1,t.name,'TW','TWD','Asia/Taipei',now() FROM unnest($2::text[]) AS t(name) RETURNING id::text`,[ORG_ID,names]);assert.equal(inserted.rowCount,230);
 const wanted=new Set(inserted.rows.map(r=>r.id)),seen=new Set<string>();let cursor:string|undefined;let pages=0;
 do {const page=await archiveList(s,cursor);assert.equal(page.state,'ready');if(page.state!=='ready')throw new Error('Page unavailable');pages++;assert.ok(pages<=20,'cursor must terminate');
  for(const row of page.rows){const key=`${row.ref.kind}:${row.ref.id}`;assert.equal(seen.has(key),false,'record repeated between pages');seen.add(key);}
  assert.equal(page.hasMore,page.nextCursor!==null);cursor=page.nextCursor??undefined;
 } while(cursor!==undefined);
 assert.ok(pages>=2);for(const id of wanted)assert.ok(seen.has(`property:${id}`),'inserted record must be reachable');
 for(const invalid of ['','property:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',`contact:${randomUUID()}`,'property:not-a-uuid'])assert.equal((await archiveList(s,invalid)).state,'unavailable');
});
