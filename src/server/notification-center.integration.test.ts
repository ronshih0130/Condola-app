import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, USERS } from "./ids";
import { centerSessionEnabled, centerSessionItems, centerVendorEnabled, centerVendorItems } from "./notification-center";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";
import type { Session } from "./types";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async()=>{
 clone=await cloneTestDatabase();
 const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try {process.env.DEMO_MODE="true";process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");await resetAndSeed();}
 catch(error) {await clone?.cleanup(); throw error;}
 finally {if(demo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=demo; if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await clone?.cleanup();});

test("synthetic events isolate four personas, first-read markers, gates and exact job grant",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
 try {
  const lease=(await c.query<{lease_id:string;tenant_id:string;tenant_user:string;owner_id:string;owner_user:string;property_id:string;invoice_id:string}>(`SELECT l.id::text lease_id,ct.id::text tenant_id,ct.user_id::text tenant_user,oc.id::text owner_id,oc.user_id::text owner_user,l.property_id::text property_id,i.id::text invoice_id
   FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id
   JOIN property_owners po ON po.property_id=l.property_id JOIN contacts oc ON oc.id=po.owner_contact_id
   JOIN invoices i ON i.lease_id=l.id WHERE l.org_id=$1 AND ct.user_id IS NOT NULL AND oc.user_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
  const session=async(userId:string,kind:Session['kind'],role:Session['role']):Promise<Session>=>{
   const sessionId=randomUUID(); await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,userId,randomUUID()]);
   return {userId,sessionId,kind,role,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  };
  const staff=await session(USERS.manager,'staff','manager'), tenant=await session(lease.tenant_user,'tenant',null), owner=await session(lease.owner_user,'owner',null);
  assert.equal(await centerSessionEnabled(staff),false);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  assert.equal(await centerSessionEnabled(staff),false);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true,"vendor_link":false}'::jsonb,plan_tier='beta' WHERE id=$1`,[ORG_ID]);
  assert.equal(await centerSessionEnabled(staff),true);
  const expiredCursor=(await c.query<{id:string}>(`INSERT INTO app.b028_center_cursors(org_id,actor_id,session_id,persona,after_time,after_id,expires_at) VALUES($1,$2,$3,'staff',clock_timestamp(),$4,clock_timestamp()-interval '1 minute') RETURNING id::text`,[ORG_ID,USERS.admin,randomUUID(),randomUUID()])).rows[0].id;
  await centerSessionItems(staff);
  assert.equal((await c.query(`SELECT 1 FROM app.b028_center_cursors WHERE id=$1`,[expiredCursor])).rowCount,0);
  await c.query(`UPDATE platform_settings SET value='{"enabled":true,"allowed_org_ids":"invalid"}'::jsonb WHERE key='notification_center_v2'`);
  assert.equal(await centerSessionEnabled(staff),false);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key IN ('rent_reminders_v2','payment_results_v2')`);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags-'rent_reminders_v2'-'payment_results_v2' WHERE id=$1`,[ORG_ID]);
  assert.equal(await centerSessionEnabled(staff),true);
  const member=(await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,[ORG_ID,USERS.manager])).rows[0].id;
  const vendorContact=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'Synthetic vendor','+886900111222') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const ticket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,reported_by_user,reported_by_contact_id,assigned_vendor_contact_id) VALUES($1,987654,$2,$3,'Synthetic','open',$4,$5,$6) RETURNING id::text`,[ORG_ID,lease.property_id,lease.lease_id,lease.tenant_user,lease.tenant_id,vendorContact])).rows[0].id;
  const token=newVendorToken();
  const job=(await c.query<{id:string;created_at:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id) VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4) RETURNING id::text,created_at::text`,[ORG_ID,ticket,hashVendorToken(token),vendorContact])).rows[0];
  const b010=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[ORG_ID,lease.lease_id,lease.invoice_id,randomUUID()])).rows[0];
  const bill=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,b010.id,b010.created_at])).rows[0].id;
  const event=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at) VALUES($1,'vendor_job_assigned',$2,$3,$4) RETURNING id::text`,[ORG_ID,ticket,job.id,job.created_at])).rows[0].id;
  await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id,contact_id,ticket_id,job_id) VALUES
   ($1,$2,'staff',$3,$4,NULL,NULL,NULL),($1,$2,'tenant',$5,NULL,$6,NULL,NULL),
   ($1,$7,'staff',$3,$4,NULL,NULL,NULL),($1,$7,'tenant',$5,NULL,$6,NULL,NULL),
   ($1,$7,'owner',$8,NULL,$9,NULL,NULL),($1,$7,'vendor_job',NULL,NULL,NULL,$10,$11)`,[ORG_ID,bill,USERS.manager,member,lease.tenant_user,lease.tenant_id,event,lease.owner_user,lease.owner_id,ticket,job.id]);
  const acl=(await c.query<{denied:boolean;trusted:boolean}>(`SELECT bool_and(NOT has_table_privilege(r.rolname,cl.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS denied,
    bool_and(owner.rolname NOT IN ('anon','authenticated','service_role')) AS trusted FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
    JOIN pg_roles owner ON owner.oid=cl.relowner CROSS JOIN pg_roles r WHERE n.nspname='app' AND cl.relname IN ('b028_center_events','b028_center_recipients','b028_center_reads','b028_center_mark_contexts','b028_center_cursors') AND r.rolname IN ('anon','authenticated','service_role')`)).rows[0];
  assert.deepEqual(acl,{denied:true,trusted:true});
  const functions=(await c.query<{denied:boolean;trusted:boolean}>(`SELECT bool_and(NOT has_function_privilege(r.rolname,p.oid,'EXECUTE')) AS denied,
    bool_and(owner.rolname NOT IN ('anon','authenticated','service_role')) AS trusted FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles owner ON owner.oid=p.proowner CROSS JOIN pg_roles r WHERE n.nspname='app' AND p.proname LIKE 'b028_center_%' AND r.rolname IN ('anon','authenticated')`)).rows[0];
  assert.deepEqual(functions,{denied:true,trusted:true});
  await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'payment_confirmed',$2,$3)`,[ORG_ID,b010.id,b010.created_at]));
  const staffItems=(await centerSessionItems(staff)).items, tenantItems=(await centerSessionItems(tenant)).items, ownerItems=(await centerSessionItems(owner)).items, vendorItems=(await centerVendorItems(token)).items;
  assert.equal(staffItems.length,2); assert.equal(tenantItems.length,2); assert.equal(ownerItems.length,1); assert.equal(vendorItems.length,1);
  const zone=(await c.query<{name:string}>(`SELECT name FROM pg_timezone_names WHERE (clock_timestamp() AT TIME ZONE name)::date<>current_date ORDER BY name LIMIT 1`)).rows[0];
  assert.ok(zone);
  await c.query(`UPDATE organizations SET timezone=$2 WHERE id=$1`,[ORG_ID,zone.name]);
  await c.query(`UPDATE property_owners SET effective_from=((clock_timestamp() AT TIME ZONE $3)::date-1),effective_to=((clock_timestamp() AT TIME ZONE $3)::date+1) WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id,zone.name]);
  assert.equal((await centerSessionItems(owner)).items.length,1);
  await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[owner.userId]); await c.query('SET LOCAL ROLE service_role');
  await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'owner',NULL,$3,NULL)`,[ORG_ID,owner.sessionId,ownerItems[0].recipient_id]);
  await c.query('RESET ROLE'); await c.query(`UPDATE property_owners SET effective_to=(clock_timestamp() AT TIME ZONE $3)::date WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id,zone.name]);
  await assert.rejects(c.query('SET CONSTRAINTS app.b028_center_mark_commit IMMEDIATE'),(e:unknown)=>(e as {code?:string}).code==='42501');
  await c.query('ROLLBACK');
  assert.equal((await centerSessionItems(owner)).items[0].read_at,null);
  await c.query(`UPDATE organizations SET timezone='Asia/Taipei' WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE property_owners SET effective_from=current_date,effective_to=NULL WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id]);
  assert.equal(await centerVendorEnabled(token),true);
  const tenantId=tenantItems[0].recipient_id; const first=(await centerSessionItems(tenant,tenantId)).items[0].read_at; assert.ok(first);
  assert.equal((await centerSessionItems(tenant,tenantId)).items[0].read_at,first);
  assert.ok((await centerSessionItems(staff)).items.every(x=>x.read_at===null));
  assert.deepEqual((await centerSessionItems(owner,tenantId)).items,[]);
  const simultaneous=await Promise.all([centerSessionItems(tenant,tenantItems[1].recipient_id),centerSessionItems(tenant,tenantItems[1].recipient_id)]);
  assert.equal(simultaneous[0].items[0].read_at,simultaneous[1].items[0].read_at);
  await c.query('BEGIN');
  for (let n=0;n<105;n++) {
    const b=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[ORG_ID,lease.lease_id,lease.invoice_id,randomUUID()])).rows[0];
    const e=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,b.id,b.created_at])).rows[0].id;
    await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4)`,[ORG_ID,e,lease.tenant_user,lease.tenant_id]);
  }
  await c.query('COMMIT');
  const page1=await centerSessionItems(tenant); assert.equal(page1.items.length,100); assert.ok(page1.continuation);
  const page2=await centerSessionItems(tenant,null,page1.continuation); assert.equal(page2.items.length,7);
  assert.equal(new Set([...page1.items,...page2.items].map(x=>x.recipient_id)).size,107);
  const other=new Client({connectionString:process.env.DATABASE_URL}); await other.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[tenant.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'tenant',NULL,NULL,NULL)`,[ORG_ID,tenant.sessionId]);
    await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
    await assert.rejects(other.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.tenant_id,USERS.admin]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await other.query('ROLLBACK'); await c.query('ROLLBACK');
    await other.query('BEGIN'); await other.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.tenant_id,USERS.admin]);
    await assert.rejects(centerSessionItems(tenant)); await other.query('ROLLBACK');
    const ticketEntitlement=tenantItems.find(item=>item.kind==='vendor_job_assigned')!;
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[tenant.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'tenant',NULL,$3,NULL)`,[ORG_ID,tenant.sessionId,ticketEntitlement.recipient_id]);
    await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
    await assert.rejects(other.query(`UPDATE maintenance_tickets SET reported_by_user=$2 WHERE id=$1`,[ticket,USERS.tenant2]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await other.query('ROLLBACK'); await c.query('ROLLBACK');
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[tenant.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'tenant',NULL,$3,NULL)`,[ORG_ID,tenant.sessionId,ticketEntitlement.recipient_id]);
    await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
    await assert.rejects(other.query(`UPDATE contacts SET display_name=display_name WHERE id=$1`,[vendorContact]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await other.query('ROLLBACK'); await c.query('ROLLBACK');
    const anotherTenant=lease.tenant_user===USERS.tenant ? USERS.tenant2 : USERS.tenant;
    await other.query('BEGIN'); await other.query(`UPDATE maintenance_tickets SET reported_by_user=$2,reported_by_contact_id=NULL WHERE id=$1`,[ticket,anotherTenant]);
    await assert.rejects(centerSessionItems(tenant,ticketEntitlement.recipient_id)); await other.query('ROLLBACK');
    await c.query(`UPDATE maintenance_tickets SET reported_by_user=$2,reported_by_contact_id=NULL WHERE id=$1`,[ticket,anotherTenant]);
    assert.deepEqual((await centerSessionItems(tenant,ticketEntitlement.recipient_id)).items,[]);
    await c.query(`UPDATE maintenance_tickets SET reported_by_user=$2,reported_by_contact_id=$3 WHERE id=$1`,[ticket,lease.tenant_user,lease.tenant_id]);
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[owner.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'owner',NULL,NULL,NULL)`,[ORG_ID,owner.sessionId]);
    await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
    await assert.rejects(other.query(`UPDATE property_owners SET effective_to=current_date WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await other.query('ROLLBACK'); await c.query('ROLLBACK');
    await other.query('BEGIN'); await other.query(`UPDATE property_owners SET effective_to=current_date WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id]);
    await assert.rejects(centerSessionItems(owner)); await other.query('ROLLBACK');
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[staff.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',NULL,NULL)`,[ORG_ID,staff.sessionId]);
    await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
    await assert.rejects(other.query(`UPDATE org_members SET role='maintenance' WHERE id=$1`,[member]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await other.query('ROLLBACK'); await c.query('ROLLBACK');
    await other.query('BEGIN'); await other.query(`UPDATE org_members SET role='maintenance' WHERE id=$1`,[member]);
    await assert.rejects(centerSessionItems(staff)); await other.query('ROLLBACK');
    await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[tenant.sessionId]);
    const pending=page2.items[0].recipient_id;
    await other.query('BEGIN'); await other.query(`INSERT INTO app.b028_center_reads(org_id,recipient_id) VALUES($1,$2)`,[ORG_ID,pending]);
    const pid=(await other.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const blocked=centerSessionItems(tenant,pending).then(()=>false,()=>true);
    const until=Date.now()+1500; let observed=false;
    while(Date.now()<until) {observed=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[pid])).rows[0].ok; if(observed) break; await new Promise(r=>setTimeout(r,20));}
    assert.equal(observed,true); await new Promise(r=>setTimeout(r,2200)); await other.query('ROLLBACK');
    assert.equal(await blocked,true);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,pending])).rowCount,0);
    await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[tenant.sessionId]);
    await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[tenant.sessionId]);
    await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[tenant.userId]); await c.query('SET LOCAL ROLE service_role');
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'tenant',NULL,$3,NULL)`,[ORG_ID,tenant.sessionId,pending]);
    await new Promise(r=>setTimeout(r,2200));
    await assert.rejects(c.query('COMMIT'),(e:unknown)=>(e as {code?:string}).code==='42501');
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,pending])).rowCount,0);
    await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[tenant.sessionId]);
  } finally {await other.end();}
  await c.query(`UPDATE maintenance_tickets SET status='closed' WHERE id=$1`,[ticket]);
  const vendorFirst=(await centerVendorItems(token,vendorItems[0].recipient_id)).items[0].read_at; assert.ok(vendorFirst);
  assert.equal((await centerVendorItems(token,vendorItems[0].recipient_id)).items[0].read_at,vendorFirst);
  const otherTicket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,assigned_vendor_contact_id) VALUES($1,987655,$2,$3,'Other synthetic','open',$4) RETURNING id::text`,[ORG_ID,lease.property_id,lease.lease_id,vendorContact])).rows[0].id;
  const otherToken=newVendorToken();
  await c.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id) VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4)`,[ORG_ID,otherTicket,hashVendorToken(otherToken),vendorContact]);
  assert.equal(await centerVendorEnabled(otherToken),true);
  assert.deepEqual((await centerVendorItems(otherToken,vendorItems[0].recipient_id)).items,[]);
  await c.query(`DELETE FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,vendorItems[0].recipient_id]);
  await c.query(`UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[job.id]);
  const blocker=new Client({connectionString:process.env.DATABASE_URL}); await blocker.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query(`INSERT INTO app.b028_center_reads(org_id,recipient_id) VALUES($1,$2)`,[ORG_ID,vendorItems[0].recipient_id]);
    const pid=(await blocker.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const blocked=centerVendorItems(token,vendorItems[0].recipient_id).then(()=>false,()=>true);
    const until=Date.now()+1500; let observed=false;
    while(Date.now()<until) {observed=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[pid])).rows[0].ok; if(observed) break; await new Promise(r=>setTimeout(r,20));}
    assert.equal(observed,true); await new Promise(r=>setTimeout(r,2200)); await blocker.query('ROLLBACK');
    assert.equal(await blocked,true);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,vendorItems[0].recipient_id])).rowCount,0);
  } finally {await blocker.end();}
  await c.query(`UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[job.id]);
  assert.equal(await centerVendorEnabled(newVendorToken()),false);
  await c.query('BEGIN');
  await c.query(`WITH made AS (INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
    SELECT $1,$2,$3,'rent_due',gen_random_uuid()::text,current_date FROM generate_series(1,400) RETURNING id,created_at)
    INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) SELECT $1,'rent_due',id,created_at FROM made`,[ORG_ID,lease.lease_id,lease.invoice_id]);
  await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id)
    SELECT $1,e.id,'tenant',$2,$3 FROM app.b028_center_events e LEFT JOIN app.b028_center_recipients r ON r.event_id=e.id AND r.persona='tenant'
    WHERE e.org_id=$1 AND e.kind='rent_due' AND r.id IS NULL`,[ORG_ID,lease.tenant_user,lease.tenant_id]);
  await c.query('COMMIT');
  await c.query(`UPDATE contacts SET user_id=NULL WHERE id=$1`,[lease.tenant_id]);
  const replacement=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic replacement') RETURNING id::text`,[ORG_ID,lease.tenant_user])).rows[0].id;
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`,[ORG_ID,lease.lease_id,replacement]);
  const replacementSource=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[ORG_ID,lease.lease_id,lease.invoice_id,randomUUID()])).rows[0];
  const replacementEvent=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,replacementSource.id,replacementSource.created_at])).rows[0].id;
  await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4)`,[ORG_ID,replacementEvent,lease.tenant_user,replacement]);
  const skipped=await centerSessionItems(tenant); assert.equal(skipped.items.length,0); assert.ok(skipped.continuation);
  const afterSkipped=await centerSessionItems(tenant,null,skipped.continuation); assert.equal(afterSkipped.items.length,1);
  await assert.rejects(centerSessionItems(owner,null,skipped.continuation));
  await c.query(`UPDATE contacts SET user_id=NULL WHERE id=$1`,[replacement]);
  await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.tenant_id,lease.tenant_user]);
  await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.tenant_id,USERS.admin]);
  await assert.rejects(centerSessionItems(tenant));
  await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.tenant_id,lease.tenant_user]);
  await c.query(`UPDATE property_owners SET effective_to=current_date WHERE property_id=$1 AND owner_contact_id=$2`,[lease.property_id,lease.owner_id]);
  assert.equal((await centerSessionItems(owner)).items.length,0);
  await c.query(`UPDATE org_members SET role='maintenance' WHERE id=$1`,[member]);
  assert.equal(await centerSessionEnabled(staff),false);
  await c.query(`UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1`,[job.id]);
  assert.equal(await centerVendorEnabled(token),false);
  await assert.rejects(centerVendorItems(token));
  await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[tenant.sessionId]);
  assert.equal(await centerSessionEnabled(tenant),false); await assert.rejects(centerSessionItems(tenant));
  await c.query(`UPDATE platform_settings SET value='{"enabled":"true","allowed_org_ids":[]}'::jsonb WHERE key='notification_center_v2'`);
  assert.equal(await centerSessionEnabled(staff),false);
  await c.query(`DROP FUNCTION app.b028_center_session_enabled(uuid,uuid,text,uuid,text,text)`);
  assert.equal(await centerSessionEnabled(staff),false);
 } finally {await c.end();}
});
