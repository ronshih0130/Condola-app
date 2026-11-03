import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { saveStaffProfile,staffProfileView } from './staff-profile';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});test.after(async()=>{await clone.cleanup();});
async function actor(c:Client,userId:string,role:Session['role']):Promise<Session>{const sessionId=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,userId,randomUUID()]);return {userId,sessionId,orgId:ORG_ID,liveOrgId:ORG_ID,kind:'staff',role,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};}
async function enabled(c:Client){await c.query(`INSERT INTO platform_settings(key,value) VALUES ('company_profile_edit',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"company_profile_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function own(c:Client,id:string){return (await c.query(`SELECT display_name,email::text,phone_e164 FROM profiles WHERE id=$1`,[id])).rows[0];}
async function audit(c:Client,id:string){return (await c.query(`SELECT event_type,new_row FROM audit_log WHERE actor_user_id=$1 AND event_type='staff_display_name_changed' ORDER BY id`,[id])).rows;}

test('self name writes are gated, versioned and preserve account and contact fields',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const s=await actor(c,USERS.manager,'manager'),other=await actor(c,USERS.accountant,'accountant');
  await c.query(`DELETE FROM platform_settings WHERE key='company_profile_edit'`);await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"company_profile_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);assert.equal((await staffProfileView(s)).state,'unavailable');
  for(const flag of [{enabled:'true',allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:[ORG_ID,123]},{enabled:true,allowed_org_ids:[]}]){await c.query(`INSERT INTO platform_settings(key,value) VALUES('company_profile_edit',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(flag)]);assert.equal((await staffProfileView(s)).state,'unavailable');}
  await enabled(c);const before=await own(c,s.userId),otherBefore=await own(c,other.userId),contacts=(await c.query(`SELECT id::text,display_name,email::text FROM contacts WHERE user_id=$1 ORDER BY id`,[s.userId])).rows;const view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')return;
  const otherView=await staffProfileView(other);assert.equal(otherView.state,'ready');if(otherView.state!=='ready')return;
  assert.equal(await saveStaffProfile(s,'Synthetic Display',otherView.version),'stale');assert.deepEqual(await own(c,s.userId),before);assert.deepEqual(await own(c,other.userId),otherBefore);
  assert.equal(await saveStaffProfile(s,'Synthetic Display',view.version),'updated');const after=await own(c,s.userId);assert.equal(after.display_name,'Synthetic Display');assert.equal(after.email,before.email);assert.equal(after.phone_e164,before.phone_e164);assert.deepEqual((await c.query(`SELECT id::text,display_name,email::text FROM contacts WHERE user_id=$1 ORDER BY id`,[s.userId])).rows,contacts);assert.deepEqual(await own(c,other.userId),otherBefore);
  assert.equal(await saveStaffProfile(s,'Synthetic Display',view.version),'unchanged');assert.equal(await saveStaffProfile(s,'Stale Write',view.version),'stale');const fresh=await staffProfileView(s);assert.equal(fresh.state,'ready');if(fresh.state!=='ready')return;assert.equal(await saveStaffProfile(s,'Synthetic Display',fresh.version),'unchanged');
  const rows=await audit(c,s.userId);assert.equal(rows.length,1);assert.deepEqual(rows[0].new_row,{event:'staff_display_name_changed',scope:'account',field:'display_name',outcome:'updated',source:'account_settings',environment:'live'});
  for(const orgValue of [false,'true',null]){await c.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{company_profile_edit}',$2::jsonb,true) WHERE id=$1`,[ORG_ID,JSON.stringify(orgValue)]);assert.equal(await saveStaffProfile(s,'Denied',fresh.version),'unavailable');}assert.equal((await own(c,s.userId)).display_name,'Synthetic Display');
 }finally{await c.end();}
});

test('every current staff role can edit only its own name',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await enabled(c);for(const [id,role] of [[USERS.admin,'admin'],[USERS.manager,'manager'],[USERS.accountant,'accountant'],[USERS.maintenance,'maintenance']] as const){const s=await actor(c,id,role),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const name=`Synthetic ${role}`;assert.equal(await saveStaffProfile(s,name,view.version),'updated');assert.equal((await own(c,id)).display_name,name);}}finally{await c.end();}
});

test('sandbox, foreign, nonstaff and invalid current sessions cannot save',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await enabled(c);const s=await actor(c,USERS.manager,'manager');const view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')return;const before=await own(c,s.userId);
 for(const forged of [{...s,kind:'tenant' as const,role:null},{...s,environment:'sandbox' as const},{...s,needsSandbox:true},{...s,orgId:ORG2_ID,liveOrgId:ORG2_ID},{...s,role:'admin' as const},{...s,sessionId:randomUUID()}])assert.equal(await saveStaffProfile(forged,'Denied',view.version),'unavailable');
 await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[s.sessionId]);assert.equal(await saveStaffProfile(s,'Denied',view.version),'unavailable');assert.deepEqual(await own(c,s.userId),before);
 }finally{await c.end();}
});

test('role and session changes while the profile row is locked prevent the waiting write',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL}),observer=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await observer.connect();try{await enabled(c);
  for(const change of ['role','revoke'] as const){const s=await actor(c,USERS.manager,'manager'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')return;const before=await own(c,s.userId),auditBefore=(await audit(c,s.userId)).length;await c.query('BEGIN');let pending:Promise<Awaited<ReturnType<typeof saveStaffProfile>>>|undefined;try{await c.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[s.userId]);const pid=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;pending=saveStaffProfile(s,`Waiting ${change}`,view.version);let blocked=false;for(let i=0;i<80;i++){const q=await observer.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM public.profiles%' AND query LIKE '%FOR UPDATE%') AS waiting`,[pid]);if(q.rows[0].waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(blocked,true);if(change==='role')await observer.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);else await observer.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[s.sessionId]);await c.query('COMMIT');assert.equal(await pending,'unavailable');pending=undefined;assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,auditBefore);if(change==='role')await observer.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);}finally{await c.query('ROLLBACK').catch(()=>{});if(pending)await pending;}}
 }finally{await observer.end();await c.end();}
});

test('missing current table consent blocks a valid staff session',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await enabled(c);const s=await actor(c,USERS.maintenance,'maintenance');const before=await own(c,s.userId);await c.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source,recorded_at) VALUES($1,clock_timestamp(),'2000-01-01','2000-01-01','reconsent',clock_timestamp()+interval '1 second')`,[s.userId]);assert.equal((await staffProfileView(s)).state,'unavailable');assert.equal(await saveStaffProfile(s,'Denied','0'.repeat(64)),'unavailable');assert.deepEqual(await own(c,s.userId),before);}finally{await c.end();}
});

test('real audit insert failure rolls back the profile write',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const original=Client.prototype.query;const changed=new WeakSet<Client>();let injected=false;
 try{await enabled(c);const s=await actor(c,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(c,s.userId),audits=(await audit(c,s.userId)).length;
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:'';if(sql.startsWith('UPDATE public.profiles SET display_name='))changed.add(this);if(changed.has(this)&&sql.includes('INSERT INTO audit_log')){injected=true;return Reflect.apply(original,this,['SELECT 1/0']);}return Reflect.apply(original,this,args);}});
  assert.equal(await saveStaffProfile(s,'Audit failure name',view.version),'unavailable');assert.equal(injected,true);
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,audits);
 }finally{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});await c.end();}
});

test('a swallowed partner SQL failure cannot confirm a profile update',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const original=Client.prototype.query;const locked=new WeakSet<Client>();let injected=false;
 try{await enabled(c);const s=await actor(c,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(c,s.userId),audits=(await audit(c,s.userId)).length;
  await c.query(`INSERT INTO platform_settings(key,value) VALUES('design_partner_consent_gate','"on"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"design_partner_consent_gate":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:'';if(sql.includes('FROM public.profiles')&&sql.includes('FOR UPDATE'))locked.add(this);if(locked.has(this)&&sql.includes("SELECT o.feature_flags -> 'design_partner_consent_gate'")){injected=true;return Reflect.apply(original,this,['SELECT 1/0']);}return Reflect.apply(original,this,args);}});
  assert.equal(await saveStaffProfile(s,'Partner failure name',view.version),'unavailable');assert.equal(injected,true);
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,audits);
 }finally{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});await c.end();}
});

test('late expiry, revocation and flag loss after the profile lock prevent a write',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const original=Client.prototype.query;
 try{for(const change of ['expiry','revocation','flag','role'] as const){await enabled(c);const s=change==='role'?await actor(c,USERS.manager,'manager'):await actor(c,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(c,s.userId),audits=(await audit(c,s.userId)).length;const locked=new WeakSet<Client>();let release!:()=>void,observed!:()=>void,paused=false;const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{observed=resolve;});let pending:Promise<Awaited<ReturnType<typeof saveStaffProfile>>>|undefined;
  try{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:'';if(sql.includes('FROM public.profiles')&&sql.includes('FOR UPDATE'))locked.add(this);if(locked.has(this)&&!paused&&sql.includes("SELECT value FROM public.platform_settings WHERE key='design_partner_consent_gate'")){paused=true;observed();return gate.then(()=>Reflect.apply(original,this,args));}return Reflect.apply(original,this,args);}});
   pending=saveStaffProfile(s,`Late ${change}`,view.version);await Promise.race([seen,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Late check not observed')),3000))]);
   if(change==='expiry')await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[s.sessionId]);else if(change==='revocation')await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[s.sessionId]);else if(change==='flag')await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"company_profile_edit":false}'::jsonb WHERE id=$1`,[ORG_ID]);else await c.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);
   release();assert.equal(await pending,'unavailable');pending=undefined;Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,audits);if(change==='role')await c.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);
  }finally{release();if(pending)await pending;Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});}
 }}finally{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});await c.end();}
});

test('an actual final authorization SQL failure after audit rolls back both writes',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const original=Client.prototype.query;const changed=new WeakSet<Client>();let injected=false;
 try{await enabled(c);const s=await actor(c,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(c,s.userId),audits=(await audit(c,s.userId)).length;
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:'';if(sql.startsWith('UPDATE public.profiles SET display_name='))changed.add(this);if(changed.has(this)&&sql.includes('FROM public.organizations o JOIN public.org_members')){injected=true;return Reflect.apply(original,this,['SELECT 1/0']);}return Reflect.apply(original,this,args);}});
  assert.equal(await saveStaffProfile(s,'Final failure name',view.version),'unavailable');assert.equal(injected,true);Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,audits);
 }finally{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});await c.end();}
});

test('an aborted transaction returning a ROLLBACK command cannot report success',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const original=Client.prototype.query;const changed=new WeakSet<Client>();let injected=false;
 try{await enabled(c);const s=await actor(c,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(c,s.userId),audits=(await audit(c,s.userId)).length;
  Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:'';if(sql.startsWith('UPDATE public.profiles SET display_name='))changed.add(this);if(changed.has(this)&&sql==='COMMIT'){injected=true;return Promise.resolve(Reflect.apply(original,this,['SELECT 1/0'])).catch(()=>Reflect.apply(original,this,['COMMIT']));}return Reflect.apply(original,this,args);}});
  assert.equal(await saveStaffProfile(s,'Aborted commit name',view.version),'unavailable');assert.equal(injected,true);Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});assert.deepEqual(await own(c,s.userId),before);assert.equal((await audit(c,s.userId)).length,audits);
 }finally{Object.defineProperty(Client.prototype,'query',{configurable:true,writable:true,value:original});await c.end();}
});

test('partner activation and newer invalid consent committed during profile wait are observed',async()=>{
 const blocker=new Client({connectionString:process.env.DATABASE_URL}),observer=new Client({connectionString:process.env.DATABASE_URL});await blocker.connect();await observer.connect();try{
  for(const change of ['partner','consent'] as const){await enabled(blocker);await blocker.query(`DELETE FROM platform_settings WHERE key='design_partner_consent_gate'`);await blocker.query(`UPDATE organizations SET feature_flags=feature_flags-'design_partner_consent_gate' WHERE id=$1`,[ORG_ID]);const s=await actor(blocker,USERS.admin,'admin'),view=await staffProfileView(s);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Expected own profile');const before=await own(blocker,s.userId),audits=(await audit(blocker,s.userId)).length;await blocker.query('BEGIN');let pending:Promise<Awaited<ReturnType<typeof saveStaffProfile>>>|undefined;
   try{await blocker.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[s.userId]);const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;pending=saveStaffProfile(s,`Fresh ${change}`,view.version);let observed=false;for(let i=0;i<80;i++){const q=await observer.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM public.profiles%' AND query LIKE '%FOR UPDATE%') AS waiting`,[pid]);if(q.rows[0].waiting){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(observed,true);
    if(change==='partner')await observer.query(`INSERT INTO platform_settings(key,value) VALUES('design_partner_consent_gate','"on"'::jsonb)`);else await observer.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source,recorded_at) VALUES($1,clock_timestamp(),'2000-01-01','2000-01-01','reconsent',clock_timestamp()+interval '1 second')`,[s.userId]);
    await blocker.query('COMMIT');assert.equal(await pending,'unavailable');pending=undefined;assert.deepEqual(await own(blocker,s.userId),before);assert.equal((await audit(blocker,s.userId)).length,audits);
   }finally{await blocker.query('ROLLBACK').catch(()=>{});if(pending)await pending;}
  }
 }finally{await observer.end();await blocker.end();}
});
