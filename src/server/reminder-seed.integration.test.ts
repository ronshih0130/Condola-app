import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, USERS } from "./ids";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async()=>{
  clone=await cloneTestDatabase();
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try {process.env.DEMO_MODE="true";process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");await resetAndSeed();}
  catch(error){await clone.cleanup();throw error;}
  finally {if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await clone?.cleanup();});

test("repeated guarded demo reset clears only these private event references",async()=>{
  const beforeDemo=process.env.DEMO_MODE, beforeKey=process.env.ID_DOC_ENCRYPTION_KEY;
  process.env.DEMO_MODE="true";
  process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    // The seeded tenant2 has an unpaid invoice; tenant1 is fully paid.
    // Unlinked email-only contacts cannot supply a principal read marker.
    const invoice=(await c.query<{id:string;lease_id:string}>(`SELECT i.id::text,i.lease_id::text FROM invoices i JOIN leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0) AND EXISTS (SELECT 1 FROM lease_parties lp JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id WHERE lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role IN ('primary','co_tenant') AND ct.user_id=$2 AND ct.archived_at IS NULL AND ct.email IS NOT NULL AND btrim(ct.email::text)<>'') ORDER BY i.id LIMIT 1`,[ORG_ID,USERS.tenant2])).rows[0];
    const payment=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];
    const contact=(await c.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.tenant2])).rows[0];
    assert.ok(invoice && payment && contact);
    const session=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[session,USERS.admin,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`,[USERS.admin]);
    const event=(await c.query<{id:string}>(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)::text AS id`,[ORG_ID,session,invoice.lease_id,invoice.id,randomUUID()])).rows[0].id;
    const claim=(await c.query<{id:string;principal_user_id:string|null}>(`SELECT id::text,principal_user_id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND principal_user_id IS NOT NULL LIMIT 1`,[event])).rows[0];
    assert.ok(claim);
    assert.equal(claim.principal_user_id,USERS.tenant2);
    await c.query(`INSERT INTO app.b028_read_markers(org_id,claim_id,principal_user_id) VALUES ($1,$2,$3)`,[ORG_ID,claim.id,claim.principal_user_id]);
    await c.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES ($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,randomUUID(),"a".repeat(64),payment.id]);
    await c.query(`INSERT INTO app.b010_tenant_due_preferences(org_id,user_id,due_enabled) VALUES ($1,$2,false)`,[ORG_ID,USERS.tenant2]);
    await c.query(`CREATE TABLE app.b010_reset_unrelated_probe (value integer NOT NULL)`);
    await c.query(`INSERT INTO app.b010_reset_unrelated_probe VALUES (7)`);
    await c.end();
    for (let i=0;i<2;i++) {
      await resetAndSeed();
      const verify=new Client({connectionString:process.env.DATABASE_URL}); await verify.connect();
      try {
        for (const table of ["b028_read_markers","b028_recipient_claims","b010_payment_commands","b010_source_events","b010_tenant_due_preferences"]) {
          const row=await verify.query<{n:string}>(`SELECT count(*)::text AS n FROM app."${table}"`);
          assert.equal(row.rows[0].n,"0",table);
        }
        assert.equal((await verify.query(`SELECT 1 FROM organizations WHERE id=$1`,[ORG_ID])).rowCount,1);
        assert.equal((await verify.query(`SELECT 1 FROM app.b010_reset_unrelated_probe WHERE value=7`)).rowCount,1);
      } finally {await verify.end();}
    }
  } finally {
    await c.end().catch(()=>{});
    if (beforeDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=beforeDemo;
    if (beforeKey === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=beforeKey;
  }
});


test("a synthetic schema-absence probe without event tables still resets",async()=>{
  const beforeDemo=process.env.DEMO_MODE, beforeKey=process.env.ID_DOC_ENCRYPTION_KEY;
  process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    // Capability-absence compatibility, not a historical-upgrade claim. This
    // is the uniquely owned clone, never its shared source. New center children
    // must be absent before removing their referenced B010 event table.
    await c.query(`DROP TABLE IF EXISTS app.b028_notification_event_recipients`);
    await c.query(`DROP TABLE IF EXISTS app.b017_center_resolutions`);
    await c.query(`DROP TABLE IF EXISTS app.b028_center_mark_contexts,app.b028_center_cursors,app.b028_center_reads,app.b028_center_recipients,app.b028_center_events`);
    await c.query(`DROP TABLE IF EXISTS app.b017_old_source_transactions,app.b017_occurrences`);
    await c.query(`DROP TABLE app.b028_read_markers,app.b028_recipient_claims,app.b010_payment_commands,app.b010_source_events,app.b010_tenant_due_preferences`);
    await c.end();
    await resetAndSeed();
  } finally {
    await c.end().catch(()=>{});
    if (beforeDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=beforeDemo;
    if (beforeKey === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=beforeKey;
  }
});
