import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { runLocalRentReminders } from "./local-rent-reminders";
import { captureScheduledReminders } from "./local-reminder-capture";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});
test.after(async()=>{await clone.cleanup();});

test("configured local overdue occurrence is unique, scoped and never sends",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const invoice=(await c.query<{id:string;lease_id:string;instant:string}>(`SELECT i.id::text,i.lease_id::text,(((i.due_date+1)::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS instant
      FROM invoices i JOIN leases l ON l.id=i.lease_id JOIN organizations o ON o.id=l.org_id WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL
        AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.org_id=i.org_id AND e.target_id=i.id AND e.threshold=1 AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant')) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(invoice);
    const run=async(db:Client, id=invoice.id)=> (await db.query<{id:string|null}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[ORG_ID,id,invoice.instant])).rows[0].id;
    assert.equal(await run(c),null);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query(`INSERT INTO reminder_rules(org_id,event_type,offsets_days,channels,is_enabled) VALUES ($1,'rent_overdue',ARRAY[1,7]::smallint[],ARRAY['email']::channel_type[],true) ON CONFLICT(org_id,event_type) DO UPDATE SET offsets_days=EXCLUDED.offsets_days,channels=EXCLUDED.channels,is_enabled=true`,[ORG_ID]);
    const mixed=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name,email) VALUES ($1,$2,true,'Synthetic mixed','mixed@example.test') RETURNING id::text`,[ORG_ID,USERS.manager])).rows[0].id;
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'co_tenant')`,[ORG_ID,invoice.lease_id,mixed]);
    const other=new Client({connectionString:process.env.DATABASE_URL}); await other.connect();
    try {
      const results=await Promise.all([run(c),run(other)]);
      assert.equal(results.filter(Boolean).length,1);
      const event=results.find(Boolean)!;
      assert.ok((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND state='queued'`,[event])).rowCount);
      assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id=$2`,[event,USERS.manager])).rowCount,1);
      const staff=(await c.query<{email:string}>(`SELECT coalesce(nullif(btrim(u.email::text),''),nullif(btrim(p.email::text),'')) AS email FROM app.b028_recipient_claims claim JOIN org_members m ON m.id=claim.member_id JOIN auth.users u ON u.id=m.user_id LEFT JOIN profiles p ON p.id=m.user_id WHERE claim.event_id=$1 AND claim.principal_user_id=$2 AND claim.contact_id IS NULL`,[event,USERS.manager])).rows;
      assert.equal(staff.length,1);
      assert.equal((await c.query(`SELECT 1 FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.related_id=$1`,[event])).rowCount,0);
      await c.query(`UPDATE invoices SET status='paid' WHERE id=$1`,[invoice.id]);
      await assert.rejects(captureScheduledReminders(ORG_ID,event,new Date(invoice.instant),()=>assert.fail('paid reminder captured')));
      await c.query(`UPDATE invoices SET status='open' WHERE id=$1`,[invoice.id]);
      const local:Array<{to:string;subject:string;text:string}>=[];
      const eventCaptured=await captureScheduledReminders(ORG_ID,event,new Date(invoice.instant),(message)=>local.push(message));
      const captured=(await c.query<{n:string}>(`SELECT count(*)::text AS n FROM app.b028_recipient_claims WHERE event_id=$1 AND state='captured'`,[event])).rows[0].n;
      assert.ok(Number(captured)>0); assert.equal(eventCaptured,Number(captured));
      assert.ok(local.every((item)=>item.to && item.subject && item.text));
      const staffMessages=local.filter(item=>item.to===staff[0].email);
      assert.equal(staffMessages.length,1);
      assert.match(staffMessages[0].text,/View the rent overview\.|請至租金總覽查看帳單。/);
      await runLocalRentReminders(new Date(invoice.instant),()=>{});
      const again=await runLocalRentReminders(new Date(invoice.instant),()=>assert.fail('duplicate capture'));
      assert.equal(again.captured,0);
    } finally { await other.end(); }
    await c.query(`UPDATE invoices SET status='paid' WHERE id=$1`,[invoice.id]);
    assert.equal(await run(c),null);
    await c.query(`UPDATE invoices SET status='open' WHERE id=$1`,[invoice.id]);
    await c.query(`UPDATE leases SET status='terminated' WHERE id=$1`,[invoice.lease_id]);
    assert.equal(await run(c),null);
    await c.query(`UPDATE leases SET status='active' WHERE id=$1`,[invoice.lease_id]);
  } finally { await c.end(); }
});

test("tenant due preference defaults on, is separately owned, and is rechecked before capture",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const invoice=(await c.query<{id:string;lease_id:string;user_id:string;instant:string}>(`SELECT i.id::text,i.lease_id::text,ct.user_id::text,(((i.due_date-3)::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS instant
      FROM invoices i JOIN leases l ON l.id=i.lease_id JOIN organizations o ON o.id=l.org_id
      JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id
      WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND ct.user_id IS NOT NULL AND ct.email IS NOT NULL
        AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(invoice);
    const {randomUUID}=await import("node:crypto"), sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,invoice.user_id,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query(`INSERT INTO reminder_rules(org_id,event_type,offsets_days,channels,is_enabled) VALUES ($1,'rent_due',ARRAY[-3,0]::smallint[],ARRAY['email']::channel_type[],true) ON CONFLICT(org_id,event_type) DO UPDATE SET offsets_days=EXCLUDED.offsets_days,channels=EXCLUDED.channels,is_enabled=true`,[ORG_ID]);
    const emailOnly=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name,email) VALUES ($1,true,'Synthetic unregistered','unregistered@example.test') RETURNING id::text`,[ORG_ID])).rows[0].id;
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'co_tenant')`,[ORG_ID,invoice.lease_id,emailOnly]);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`,[invoice.user_id]);
    const preference=(value:boolean|null, lease=invoice.lease_id)=>c.query<{enabled:boolean}>(`SELECT app.b010_tenant_due_preference($1,$1,'live',$2,$3,$4) AS enabled`,[ORG_ID,sid,lease,value]);
    assert.equal((await preference(null)).rows[0].enabled,true);
    await assert.rejects(preference(null,randomUUID()),(e:unknown)=>(e as {code?:string}).code==='42501');
    // No stored preference exists yet: scheduling creates and locks the default
    // row, so a concurrent first opt-out waits and applies after creation.
    const firstOptOut=new Client({connectionString:process.env.DATABASE_URL}); await firstOptOut.connect();
    let event:string;
    try {
      await c.query("BEGIN");
      event=(await c.query<{id:string}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[ORG_ID,invoice.id,invoice.instant])).rows[0].id; assert.ok(event);
      const pid=(await c.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      await firstOptOut.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`,[invoice.user_id]);
      const pending=firstOptOut.query(`SELECT app.b010_tenant_due_preference($1,$1,'live',$2,$3,false)`,[ORG_ID,sid,invoice.lease_id]);
      const result=pending.then(()=>"resolved",()=>"rejected");
      const deadline=Date.now()+3000; let blocked=false;
      while (Date.now()<deadline) {
        blocked=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[pid])).rows[0].ok;
        if (blocked) break; await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(blocked,true);
      await c.query("COMMIT"); assert.equal(await result,"resolved");
    } finally {await firstOptOut.end();}
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND member_id IS NOT NULL`,[event])).rowCount,0);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND contact_id=$2 AND principal_user_id IS NULL`,[event,emailOnly])).rowCount,1);
    assert.equal((await preference(false)).rows[0].enabled,false);
    const captured:string[]=[];
    await captureScheduledReminders(ORG_ID,event,new Date(invoice.instant),(m)=>captured.push(m.to));
    assert.ok(captured.includes('unregistered@example.test'));
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id=$2 AND state='queued'`,[event,invoice.user_id])).rowCount,1);
    assert.equal((await preference(true)).rows[0].enabled,true);
    assert.equal(await captureScheduledReminders(ORG_ID,event,new Date(invoice.instant)),1);
    const dueInstant=(await c.query<{instant:string}>(`SELECT ((i.due_date::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS instant FROM invoices i JOIN leases l ON l.id=i.lease_id JOIN organizations o ON o.id=l.org_id WHERE i.id=$1`,[invoice.id])).rows[0].instant;
    const dueEvent=(await c.query<{id:string}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[ORG_ID,invoice.id,dueInstant])).rows[0].id;
    // This race is specifically the primary tenant's preference. Other bound
    // co-tenants have independent preferences and must not win this claim.
    const excluded=(await c.query<{id:string}>(`SELECT id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id IS DISTINCT FROM $2::uuid`,[dueEvent,invoice.user_id])).rows.map(r=>r.id);
    const changer=new Client({connectionString:process.env.DATABASE_URL}); await changer.connect();
    try {
      await c.query("BEGIN");
      const claim=(await c.query<{claim_id:string;claim_token:string}>(`SELECT * FROM app.b028_claim_scheduled($1,$2,$3::uuid[],$4)`,[ORG_ID,dueEvent,excluded,dueInstant])).rows[0]; assert.ok(claim);
      assert.equal((await c.query<{principal_user_id:string}>(`SELECT principal_user_id::text FROM app.b028_recipient_claims WHERE id=$1`,[claim.claim_id])).rows[0].principal_user_id,invoice.user_id);
      const holderPid=(await c.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      await changer.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`,[invoice.user_id]);
      const update=changer.query(`SELECT app.b010_tenant_due_preference($1,$1,'live',$2,$3,false)`,[ORG_ID,sid,invoice.lease_id]);
      const outcome=update.then(()=>"resolved",()=>"rejected");
      const deadline=Date.now()+3000; let blocked=false;
      while (Date.now()<deadline) {
        blocked=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[holderPid])).rows[0].ok;
        if (blocked) break; await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(blocked,true);
      await c.query(`SELECT app.b028_finish_scheduled($1,$2,$3,$4)`,[ORG_ID,claim.claim_id,claim.claim_token,"a".repeat(64)]);
      await c.query("COMMIT"); assert.equal(await outcome,"resolved");
    } finally {await changer.end();}
    assert.equal((await preference(null)).rows[0].enabled,false);
    assert.equal((await c.query(`SELECT 1 FROM audit_log WHERE event_type='tenant_due_reminder_preference_changed' AND org_id=$1 AND actor_user_id=$2`,[ORG_ID,invoice.user_id])).rowCount,3);
    await c.query(`DELETE FROM app.b010_tenant_due_preferences WHERE org_id=$1 AND user_id=$2`,[ORG_ID,invoice.user_id]);
    assert.equal((await preference(null)).rows[0].enabled,true);
    assert.equal((await preference(false)).rows[0].enabled,false);
    await c.query(`UPDATE reminder_rules SET offsets_days=ARRAY[-3,-2,0]::smallint[] WHERE org_id=$1 AND event_type='rent_due'`,[ORG_ID]);
    const earlier=(await c.query<{instant:string}>(`SELECT (((i.due_date-2)::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS instant FROM invoices i JOIN leases l ON l.id=i.lease_id JOIN organizations o ON o.id=l.org_id WHERE i.id=$1`,[invoice.id])).rows[0].instant;
    const afterOptOut=(await c.query<{id:string}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[ORG_ID,invoice.id,earlier])).rows[0].id;
    assert.ok(afterOptOut);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id=$2`,[afterOptOut,invoice.user_id])).rowCount,0);
    assert.equal((await c.query(`SELECT 1 FROM app.b028_recipient_claims WHERE event_id=$1 AND contact_id=$2`,[afterOptOut,emailOnly])).rowCount,1);
  } finally {await c.end();}
});

test("organization timezone wins over a conflicting property zone at midnight and DST",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const invoice=(await c.query<{id:string;property_id:string}>(`SELECT i.id::text,l.property_id::text FROM invoices i JOIN leases l ON l.id=i.lease_id
      WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0
        AND EXISTS(SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
        AND EXISTS(SELECT 1 FROM lease_parties lp JOIN contacts ct ON ct.id=lp.contact_id WHERE lp.lease_id=l.id AND ct.email IS NOT NULL) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(invoice);
    await c.query(`UPDATE organizations SET timezone='America/Los_Angeles',feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE properties SET timezone='Asia/Taipei' WHERE id=$1`,[invoice.property_id]);
    await c.query(`UPDATE invoices SET due_date='2026-03-08' WHERE id=$1`,[invoice.id]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query(`INSERT INTO reminder_rules(org_id,event_type,offsets_days,channels,is_enabled) VALUES ($1,'rent_due',ARRAY[-1,0]::smallint[],ARRAY['email']::channel_type[],true) ON CONFLICT(org_id,event_type) DO UPDATE SET offsets_days=EXCLUDED.offsets_days,channels=EXCLUDED.channels,is_enabled=true`,[ORG_ID]);
    const run=async(at:string)=>(await c.query<{id:string|null}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[ORG_ID,invoice.id,at])).rows[0].id;
    const before=await run('2026-03-08T07:59:59Z'),after=await run('2026-03-08T08:00:00Z');
    assert.ok(before && after && before!==after);
    const rows=(await c.query<{local_date:string;key:string}>(`SELECT local_date::text,occurrence_key AS key FROM app.b010_source_events WHERE id=ANY($1::uuid[]) ORDER BY local_date`,[[before,after]])).rows;
    assert.deepEqual(rows,[{local_date:'2026-03-07',key:'2026-03-08:-1'},{local_date:'2026-03-08',key:'2026-03-08:0'}]);
    const beforePending=(await c.query<{event_id:string}>(`SELECT event_id::text FROM app.b028_pending_scheduled($1)`,['2026-03-08T07:59:59Z'])).rows.map(row=>row.event_id);
    const afterPending=(await c.query<{event_id:string}>(`SELECT event_id::text FROM app.b028_pending_scheduled($1)`,['2026-03-08T08:00:00Z'])).rows.map(row=>row.event_id);
    assert.ok(beforePending.includes(before)); assert.ok(!beforePending.includes(after));
    assert.ok(afterPending.includes(after)); assert.ok(!afterPending.includes(before));
    await c.query("BEGIN"); await c.query("SAVEPOINT wrong_day");
    await assert.rejects(c.query(`SELECT * FROM app.b028_claim_scheduled($1,$2,'{}'::uuid[],$3)`,[ORG_ID,before,'2026-03-08T08:00:00Z']),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK TO SAVEPOINT wrong_day");
    const claim=(await c.query<{claim_id:string;claim_token:string}>(`SELECT * FROM app.b028_claim_scheduled($1,$2,'{}'::uuid[],$3)`,[ORG_ID,after,'2026-03-08T08:00:00Z'])).rows[0]; assert.ok(claim);
    await c.query(`SELECT app.b028_finish_scheduled($1,$2,$3,$4)`,[ORG_ID,claim.claim_id,claim.claim_token,"a".repeat(64)]); await c.query("COMMIT");
    assert.equal(await run('2026-03-08T10:00:00Z'),null);
  } finally {await c.end();}
});
