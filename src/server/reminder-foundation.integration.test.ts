import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { captureManualReminders, type LocalReminder } from "./local-reminder-capture";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async () => { clone=await cloneTestDatabase(); });
test.after(async () => { await clone.cleanup(); });

test("private event storage and legacy claim fence are scoped and fail closed", async () => {
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    await c.query("BEGIN");
    const boundary=await c.query<{ok:boolean}>(`SELECT bool_and(pg_get_userbyid(c.relowner) NOT IN ('anon','authenticated','service_role') AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE has_table_privilege(r,c.oid,p))) AS ok FROM pg_class c
      WHERE c.oid=ANY(ARRAY['app.b010_source_events'::regclass,'app.b028_recipient_claims'::regclass,'app.b028_read_markers'::regclass,'app.b010_payment_commands'::regclass])`);
    assert.equal(boundary.rows[0].ok,true);
    const target=randomUUID();
    const claim=()=>c.query(`INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES ($1,'rent_overdue_tenant',$2,1)`,[ORG_ID,target]);
    await claim();
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query("SAVEPOINT denied");
    await assert.rejects(c.query(`DELETE FROM email_log WHERE org_id=$1 AND target_id=$2`,[ORG_ID,target]),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT denied");
    await assert.rejects(c.query(`INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES ($1,'rent_overdue_admin',$2,1)`,[ORG_ID,target]),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT denied");
    await c.query(`INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES ($1,'lease_expiry_admin',$2,7)`,[ORG_ID,target]);
    await assert.rejects(c.query(`UPDATE email_log SET target_id=$3 WHERE org_id=$1 AND target_id=$2 AND kind='rent_overdue_tenant'`,[ORG_ID,target,randomUUID()]),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT denied");
    await c.query(`UPDATE email_log SET message_id='synthetic-accepted' WHERE org_id=$1 AND target_id=$2 AND kind='rent_overdue_tenant'`,[ORG_ID,target]);
    await c.query(`UPDATE platform_settings SET value='{"enabled":true,"allowed_org_ids":"bad"}' WHERE key='rent_reminders_v2'`);
    await c.query(`INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES ($1,'rent_overdue_admin',$2,1)`,[ORG_ID,target]);
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

test("control changes cannot wait behind a legacy row-lock holder", async () => {
  const held=new Client({connectionString:process.env.DATABASE_URL});
  const other=new Client({connectionString:process.env.DATABASE_URL});
  await held.connect(); await other.connect();
  try {
    await held.query("BEGIN"); await other.query("BEGIN");
    await held.query(`UPDATE platform_settings SET value=value WHERE key='rent_reminders_v2'`);
    await assert.rejects(other.query(`INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES ($1,'rent_overdue_tenant',$2,1)`,[ORG_ID,randomUUID()]),(e:unknown)=>(e as {code?:string}).code==="55P03");
    await other.query("ROLLBACK"); await held.query("ROLLBACK");
  } finally { await other.end(); await held.end(); }
});


test("manual action binds actor, organization, invoice and request and creates recipient snapshots once", async () => {
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    await c.query("BEGIN");
    const session=randomUUID(),request=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[session,USERS.admin,randomUUID()]);
    const invoice=(await c.query<{id:string;lease_id:string}>(`SELECT i.id::text,i.lease_id::text FROM invoices i JOIN leases l ON l.id=i.lease_id AND l.org_id=i.org_id
      WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0
        AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
        AND EXISTS (SELECT 1 FROM lease_parties lp JOIN contacts ct ON ct.id=lp.contact_id WHERE lp.lease_id=l.id AND ct.user_id IS NOT NULL AND ct.email IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.org_id=i.org_id AND e.target_id=i.id AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant')) LIMIT 1`,[ORG_ID])).rows[0];
    assert.ok(invoice);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
    await c.query("SET LOCAL ROLE service_role");
    const invoke=(org=ORG_ID,env="live",sid=session,key=request) => c.query<{id:string}>(`SELECT app.b010_manual_reminder($1,$2,$3,$4,$5,$6,$7)::text AS id`,[org,ORG_ID,env,sid,invoice.lease_id,invoice.id,key]);
    await c.query("SAVEPOINT denied");
    await assert.rejects(invoke(),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT denied");
    await c.query("RESET ROLE");
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query("SET LOCAL ROLE service_role");
    const first=(await invoke()).rows[0].id;
    assert.equal((await invoke()).rows[0].id,first);
    const visible=await c.query<{queued:string}>(`SELECT * FROM app.b010_manual_status($1,$1,'live',$2,$3,$4)`,[ORG_ID,session,invoice.lease_id,first]);
    assert.ok(Number(visible.rows[0].queued)>0);
    assert.equal((await c.query(`SELECT * FROM app.b010_manual_status($1,$1,'live',$2,$3,$4)`,[ORG_ID,session,randomUUID(),first])).rowCount,0);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);
    assert.equal((await c.query(`SELECT * FROM app.b010_manual_status($1,$1,'live',$2,$3,$4)`,[ORG_ID,session,invoice.lease_id,first])).rowCount,0);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
    await c.query("SAVEPOINT mismatch");
    await assert.rejects(c.query(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)`,[ORG_ID,session,randomUUID(),invoice.id,randomUUID()]),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT mismatch");
    await assert.rejects(invoke(ORG2_ID),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT denied");
    // Recreate the successful action after the denial savepoint rollback.
    await c.query("RESET ROLE");
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query("SET LOCAL ROLE service_role");
    const again=(await invoke()).rows[0].id;
    await c.query("RESET ROLE");
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE id=$1 AND org_id=$2 AND actor_id=$3`,[again,ORG_ID,USERS.admin])).rowCount,1);
    assert.ok((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id IS NOT NULL AND state='queued'`,[again])).rowCount);
    await c.query("SAVEPOINT paid_case");
    await c.query(`UPDATE invoices SET status='paid' WHERE id=$1`,[invoice.id]);
    await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(invoke(ORG_ID,"live",session,randomUUID()),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT paid_case");
    await c.query("RESET ROLE");
    await c.query("SAVEPOINT terminated_case");
    await c.query(`UPDATE leases SET status='terminated' WHERE id=$1`,[invoice.lease_id]);
    await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(invoke(ORG_ID,"live",session,randomUUID()),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT terminated_case");
    await c.query("RESET ROLE");
    const contact=(await c.query<{id:string}>(`SELECT c.id::text FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id WHERE lp.lease_id=$1 AND lp.role IN ('primary','co_tenant') AND c.user_id IS NOT NULL AND c.email IS NOT NULL LIMIT 1`,[invoice.lease_id])).rows[0];
    assert.ok(contact);
    await c.query(`UPDATE contacts SET user_id=NULL WHERE id=$1`,[contact.id]);
    await c.query("SET LOCAL ROLE service_role");
    const emailOnly=(await invoke(ORG_ID,"live",session,randomUUID())).rows[0].id;
    await c.query("RESET ROLE");
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND contact_id=$2 AND principal_user_id IS NULL`,[emailOnly,contact.id])).rowCount,1);
    await c.query(`UPDATE organizations SET settings=settings || '{"email_tenant_rent_overdue":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query("SET LOCAL ROLE service_role");
    await c.query("SAVEPOINT opted_out");
    await assert.rejects(invoke(ORG_ID,"live",session,randomUUID()),(e:unknown)=>(e as {code?:string}).code==="42501");
    await c.query("ROLLBACK TO SAVEPOINT opted_out");
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});


test("a session expiring while blocked on the lease cannot create an event", async () => {
  const setup=new Client({connectionString:process.env.DATABASE_URL}), waiting=new Client({connectionString:process.env.DATABASE_URL}), holder=new Client({connectionString:process.env.DATABASE_URL});
  await setup.connect(); await waiting.connect(); await holder.connect();
  try {
    const sid=randomUUID(),key=randomUUID();
    const invoice=(await setup.query<{id:string;lease_id:string}>(`SELECT i.id::text,i.lease_id::text FROM invoices i JOIN leases l ON l.id=i.lease_id WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0) LIMIT 1`,[ORG_ID])).rows[0];
    assert.ok(invoice);
    await setup.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await setup.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await setup.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '2 seconds')`,[sid,USERS.admin,randomUUID()]);
    await holder.query("BEGIN"); await holder.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[invoice.lease_id]);
    await waiting.query("BEGIN"); await waiting.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]); await waiting.query("SET LOCAL ROLE service_role");
    const pid=(await waiting.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const holderPid=(await holder.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const call=waiting.query(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)`,[ORG_ID,sid,invoice.lease_id,invoice.id,key]);
    const result=call.then(()=>"resolved",(e:{code?:string})=>e.code);
    const deadline=Date.now()+3000;
    while (Date.now()<deadline && !(await setup.query<{blocked:boolean}>(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked`,[pid,holderPid])).rows[0].blocked) await new Promise(r=>setTimeout(r,10));
    assert.equal((await setup.query<{blocked:boolean}>(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked`,[pid,holderPid])).rows[0].blocked,true);
    await new Promise(r=>setTimeout(r,2200));
    await holder.query("COMMIT");
    assert.equal(await result,"42501");
    await waiting.query("ROLLBACK");
    assert.equal((await setup.query(`SELECT 1 FROM app.b010_source_events WHERE occurrence_key=$1`,[`manual:${key}`])).rowCount,0);
  } finally { await waiting.end(); await holder.end(); await setup.end(); }
});


test("local capture owns each recipient once, records failure and retries without a provider",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const sid=randomUUID(), key=randomUUID();
    const invoice=(await c.query<{id:string;lease_id:string}>(`SELECT i.id::text,i.lease_id::text FROM invoices i JOIN leases l ON l.id=i.lease_id WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0) AND NOT EXISTS (SELECT 1 FROM email_log x WHERE x.org_id=i.org_id AND x.target_id=i.id AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) LIMIT 1`,[ORG_ID])).rows[0];
    assert.ok(invoice);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb,settings=settings-'email_tenant_rent_overdue' WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
    const extra=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name,email) VALUES ($1,true,'Synthetic second','second@example.test') RETURNING id::text`,[ORG_ID])).rows[0].id;
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'co_tenant')`,[ORG_ID,invoice.lease_id,extra]);
    const extra2=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name,email) VALUES ($1,true,'Synthetic third','third@example.test') RETURNING id::text`,[ORG_ID])).rows[0].id;
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'co_tenant')`,[ORG_ID,invoice.lease_id,extra2]);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`,[USERS.admin]);
    const event=(await c.query<{id:string}>(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)::text AS id`,[ORG_ID,sid,invoice.lease_id,invoice.id,key])).rows[0].id;
    const session:Session={userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'admin',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.com',name:'Synthetic'};
    const selected=(await c.query<{id:string}>(`SELECT lp.id::text FROM app.b028_recipient_claims rc JOIN lease_parties lp ON lp.contact_id=rc.contact_id AND lp.org_id=rc.org_id WHERE rc.event_id=$1 AND lp.lease_id=$2 ORDER BY rc.id LIMIT 1`,[event,invoice.lease_id])).rows[0];
    const unlink=new Client({connectionString:process.env.DATABASE_URL}); await unlink.connect();
    try {
      await unlink.query("BEGIN"); await unlink.query(`UPDATE lease_parties SET role=role WHERE id=$1`,[selected.id]);
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
      await assert.rejects(c.query(`SELECT * FROM app.b028_claim_manual($1,$1,'live',$2,$3,$4,'{}'::uuid[])`,[ORG_ID,sid,invoice.lease_id,event]),(e:unknown)=>(e as {code?:string}).code==='55P03');
      await c.query("ROLLBACK"); await unlink.query("ROLLBACK");
    } finally { await unlink.end(); }
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    const old=(await c.query<{claim_id:string;claim_token:string}>(`SELECT * FROM app.b028_claim_manual($1,$1,'live',$2,$3,$4,'{}'::uuid[])`,[ORG_ID,sid,invoice.lease_id,event])).rows[0];
    assert.ok(old); await c.query("COMMIT");
    await c.query("BEGIN");
    await c.query(`UPDATE invoices SET status='paid' WHERE id=$1`,[invoice.id]);
    await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,old.claim_id,old.claim_token,"a".repeat(64)]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await c.query(`UPDATE contacts SET user_id=CASE WHEN user_id IS NULL THEN $2::uuid ELSE NULL END WHERE id=(SELECT contact_id FROM app.b028_recipient_claims WHERE id=$1)`,[old.claim_id,USERS.coastAdmin]);
    await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,old.claim_id,old.claim_token,"a".repeat(64)]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await c.query(`UPDATE contacts SET email=NULL WHERE id=(SELECT contact_id FROM app.b028_recipient_claims WHERE id=$1)`,[old.claim_id]);
    await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,old.claim_id,old.claim_token,"a".repeat(64)]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK");
    await c.query(`UPDATE app.b028_recipient_claims SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[old.claim_id]);
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,old.claim_id,old.claim_token,"a".repeat(64)]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK");
    const excluded=(await c.query<{id:string}>(`SELECT id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND id<>$2`,[event,old.claim_id])).rows.map((row)=>row.id);
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    const fresh=(await c.query<{claim_id:string;claim_token:string}>(`SELECT * FROM app.b028_claim_manual($1,$1,'live',$2,$3,$4,$5::uuid[])`,[ORG_ID,sid,invoice.lease_id,event,excluded])).rows[0];
    assert.equal(fresh.claim_id,old.claim_id); assert.notEqual(fresh.claim_token,old.claim_token); await c.query("COMMIT");
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,old.claim_id,old.claim_token,"a".repeat(64)]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK");
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    await c.query(`SELECT app.b028_finish_manual($1,$1,'live',$2,$3,$4,$5,$6,$7)`,[ORG_ID,sid,invoice.lease_id,event,fresh.claim_id,fresh.claim_token,"b".repeat(64)]);
    await c.query("COMMIT");
    let calls=0;
    assert.ok(await captureManualReminders(session,invoice.lease_id,event,()=>{if (calls++===0) throw new Error('synthetic capture failure');})>0);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND state='failed'`,[event])).rowCount,1);
    const captured:LocalReminder[]=[];
    const count=await captureManualReminders(session,invoice.lease_id,event,(message)=>captured.push(message));
    assert.ok(count>0);
    assert.equal(captured.length,count);
    assert.ok(captured.every((message)=>message.to && message.text && message.subject));
    assert.equal(await captureManualReminders(session,invoice.lease_id,event,()=>assert.fail('duplicate capture')),0);
    const rows=await c.query<{state:string;attempt:number;digest:string|null}>(`SELECT state,attempt,capture_digest AS digest FROM app.b028_recipient_claims WHERE event_id=$1`,[event]);
    assert.ok(rows.rows.every((row)=>row.state==='captured' && row.attempt>=1 && /^[0-9a-f]{64}$/.test(row.digest ?? '')));
    const next=(await c.query<{id:string}>(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)::text AS id`,[ORG_ID,sid,invoice.lease_id,invoice.id,randomUUID()])).rows[0].id;
    const deliveries:LocalReminder[]=[];
    const totals=await Promise.all([captureManualReminders(session,invoice.lease_id,next,(m)=>deliveries.push(m)),captureManualReminders(session,invoice.lease_id,next,(m)=>deliveries.push(m))]);
    const expected=(await c.query<{n:string}>(`SELECT count(*)::text AS n FROM app.b028_recipient_claims WHERE event_id=$1`,[next])).rows[0].n;
    assert.equal(totals[0]+totals[1],Number(expected));
    assert.equal(deliveries.length,Number(expected));
    assert.equal(new Set(deliveries.map((item)=>item.to)).size,deliveries.length);
  } finally { await c.end(); }
});
