import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, USERS } from "./ids";
import { CenterBusyError, centerSessionAdmission, centerSessionItems, centerVendorAdmission, centerVendorItems } from "./notification-center";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";
import type { Session } from "./types";
import { POST as vendorMarkPost } from "../app/api/notification-center/vendor-mark/route";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>|undefined;
test.before(async()=>{
  clone=await cloneTestDatabase(); const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try {process.env.DEMO_MODE="true";process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");await resetAndSeed();}
  catch(error){await clone.cleanup();throw error;}
  finally {if(demo===undefined) delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await clone?.cleanup();});

test("session touch contention returns busy, preserves unread, and reauthorizes after release",async t=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}),blocker=new Client({connectionString:process.env.DATABASE_URL});
  await c.connect();await blocker.connect();
  try {
    const item=(await c.query<{lease:string;invoice:string;member:string}>(`SELECT l.id::text lease,i.id::text invoice,m.id::text member FROM leases l JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id
      JOIN org_members m ON m.org_id=l.org_id AND m.user_id=$2 AND m.status='active' AND m.role='manager' WHERE l.org_id=$1 LIMIT 1`,[ORG_ID,USERS.manager])).rows[0];assert.ok(item);
    const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
    const session:Session={userId:USERS.manager,sessionId:sid,kind:"staff",role:"manager",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"synthetic@example.test",name:"Synthetic"};
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query("BEGIN");
    const old=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
      VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[ORG_ID,item.lease,item.invoice,randomUUID()])).rows[0];
    const event=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,old.id,old.at])).rows[0];
    const recipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id)
      VALUES($1,$2,'staff',$3,$4) RETURNING id::text`,[ORG_ID,event.id,USERS.manager,item.member])).rows[0];await c.query("COMMIT");
    assert.equal(await centerSessionAdmission(session),"enabled");
    await blocker.query("BEGIN");await blocker.query(`UPDATE auth_sessions SET last_active_at=now(),expires_at=greatest(expires_at,now()+interval '12 hours') WHERE id=$1`,[sid]);
    assert.equal(await centerSessionAdmission(session),"busy");
    await assert.rejects(centerSessionItems(session,recipient.id),CenterBusyError);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rowCount,0);
    await blocker.query("ROLLBACK");
    assert.ok((await centerSessionItems(session,recipient.id)).items[0].read_at);
    assert.equal((await c.query(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n,1);
    await c.query("BEGIN");await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);await c.query("SET LOCAL ROLE service_role");
    await c.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',NULL,NULL)`,[ORG_ID,sid]);
    await blocker.query("BEGIN");
    const blockedTouch=blocker.query(`UPDATE auth_sessions SET last_active_at=now() WHERE id=$1`,[sid]);
    let observed=false;
    for(let n=0;n<50 && !observed;n++) {
      observed=(await c.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[(blocker as Client & {processID:number}).processID])).rows[0].blocked;
      if(!observed) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(observed,true);await c.query("COMMIT");await blockedTouch;await blocker.query("ROLLBACK");
    await blocker.query("BEGIN");await blocker.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);
    assert.equal(await centerSessionAdmission(session),"busy");await blocker.query("COMMIT");
    assert.equal(await centerSessionAdmission(session),"denied");
    await assert.rejects(centerSessionItems(session,recipient.id));
    const sidRev=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sidRev,USERS.manager,randomUUID()]);
    const revoking:Session={...session,sessionId:sidRev};
    await blocker.query("BEGIN");await blocker.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sidRev]);
    const originalRevoke=Client.prototype.query;let revoked=false;
    t.mock.method(Client.prototype,"query",(async function(this:Client,sql:string,params?:unknown[]){
      const result=await (originalRevoke as (this:Client,s:string,p?:unknown[])=>Promise<unknown>).call(this,sql,params);
      if(sql==="ROLLBACK" && this!==blocker && !revoked) {revoked=true;await (originalRevoke as (this:Client,s:string)=>Promise<unknown>).call(blocker,"COMMIT");}
      return result;
    }) as Client["query"]);
    assert.equal(await centerSessionAdmission(revoking),"denied");assert.equal(revoked,true);t.mock.restoreAll();
    const sidExp=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sidExp,USERS.manager,randomUUID()]);
    const expiring:Session={...session,sessionId:sidExp};
    await blocker.query("BEGIN");await blocker.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[sidExp]);
    const originalExpiry=Client.prototype.query;let expired=false;
    t.mock.method(Client.prototype,"query",(async function(this:Client,sql:string,params?:unknown[]){
      const result=await (originalExpiry as (this:Client,s:string,p?:unknown[])=>Promise<unknown>).call(this,sql,params);
      if(sql==="ROLLBACK" && this!==blocker && !expired) {expired=true;await (originalExpiry as (this:Client,s:string)=>Promise<unknown>).call(blocker,"COMMIT");}
      return result;
    }) as Client["query"]);
    assert.equal(await centerSessionAdmission(expiring),"denied");assert.equal(expired,true);t.mock.restoreAll();
    const sid2=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid2,USERS.manager,randomUUID()]);
    const renewed:Session={...session,sessionId:sid2};
    await blocker.query("BEGIN"); await blocker.query(`UPDATE org_members SET role='maintenance' WHERE id=$1`,[item.member]);
    const original=Client.prototype.query;let released=false;
    t.mock.method(Client.prototype,"query",(async function(this:Client,sql:string,params?:unknown[]){
      const result=await (original as (this:Client,s:string,p?:unknown[])=>Promise<unknown>).call(this,sql,params);
      if(sql==="ROLLBACK" && this!==blocker && !released) {released=true;await (original as (this:Client,s:string)=>Promise<unknown>).call(blocker,"COMMIT");}
      return result;
    }) as Client["query"]);
    assert.equal(await centerSessionAdmission(renewed),"denied");assert.equal(released,true);
    t.mock.restoreAll();
    const property=(await c.query<{id:string}>(`SELECT property_id::text id FROM leases WHERE id=$1`,[item.lease])).rows[0].id;
    const vendor=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'Synthetic vendor','+886900111222') RETURNING id::text`,[ORG_ID])).rows[0].id;
    const ticket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,assigned_vendor_contact_id)
      VALUES($1,998877,$2,$3,'Synthetic','open',$4) RETURNING id::text`,[ORG_ID,property,item.lease,vendor])).rows[0].id;
    const token=newVendorToken();
    const job=(await c.query<{id:string;at:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id)
      VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4) RETURNING id::text,created_at::text at`,[ORG_ID,ticket,hashVendorToken(token),vendor])).rows[0];
    const vendorEvent=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at)
      VALUES($1,'vendor_job_assigned',$2,$3,$4) RETURNING id::text`,[ORG_ID,ticket,job.id,job.at])).rows[0];
    const vendorRecipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,ticket_id,job_id)
      VALUES($1,$2,'vendor_job',$3,$4) RETURNING id::text`,[ORG_ID,vendorEvent.id,ticket,job.id])).rows[0];
    const vendorRequest=(id:string,rawToken:string,origin="http://127.0.0.1:43123")=>new Request("http://127.0.0.1:43123/api/notification-center/vendor-mark",{
      method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({recipientId:id,token:rawToken}),
    });
    assert.equal((await vendorMarkPost(vendorRequest(vendorRecipient.id,token,"http://other.example.test"))).status,403);
    assert.equal((await vendorMarkPost(vendorRequest(vendorRecipient.id,newVendorToken()))).status,404);
    const otherTicket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,assigned_vendor_contact_id)
      VALUES($1,998878,$2,$3,'Synthetic other','open',$4) RETURNING id::text`,[ORG_ID,property,item.lease,vendor])).rows[0].id;
    const otherToken=newVendorToken();
    await c.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id)
      VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4)`,[ORG_ID,otherTicket,hashVendorToken(otherToken),vendor]);
    assert.equal((await vendorMarkPost(vendorRequest(vendorRecipient.id,otherToken))).status,404);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,vendorRecipient.id])).rowCount,0);
    assert.equal(await centerVendorAdmission(token),"enabled");
    await blocker.query("BEGIN");await blocker.query(`SELECT 1 FROM repair_vendor_jobs WHERE id=$1 FOR UPDATE`,[job.id]);
    assert.equal(await centerVendorAdmission(token),"busy");await assert.rejects(centerVendorItems(token,vendorRecipient.id),CenterBusyError);
    const busyResponse=await vendorMarkPost(vendorRequest(vendorRecipient.id,token));assert.equal(busyResponse.status,200);assert.deepEqual(await busyResponse.json(),{status:"busy"});
    assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,vendorRecipient.id])).rowCount,0);
    await blocker.query("ROLLBACK");
    const marked=await vendorMarkPost(vendorRequest(vendorRecipient.id,token));assert.equal(marked.status,200);assert.deepEqual(await marked.json(),{status:"marked"});
    assert.ok((await centerVendorItems(token,vendorRecipient.id)).items[0].read_at);
    await c.query(`UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1`,[job.id]);
    assert.equal(await centerVendorAdmission(token),"denied");await assert.rejects(centerVendorItems(token,vendorRecipient.id));
    assert.equal((await vendorMarkPost(vendorRequest(vendorRecipient.id,token))).status,404);

  } finally {await blocker.end();await c.end();}
});
