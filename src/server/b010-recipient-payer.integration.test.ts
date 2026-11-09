import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";

// Regression for the b010 co-tenant payer gap: on the b010_event_id branch a
// payment_* recipient must be the payer, not just any co-tenant on the lease.
// rent_* on the same branch is unaffected. Everything runs in one transaction
// (same txid) so the b017_old_source_transactions fence passes, and is rolled
// back at the end so no fixture leaks.
test("b010 payment_* accepts only the payer; co-tenant rejects; rent path unchanged", async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");

    const payer = (await c.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0];
    assert.ok(payer, "seed payer contact for USERS.tenant");
    const other = (await c.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL LIMIT 1`, [ORG_ID, USERS.tenant2])).rows[0];
    assert.ok(other, "seed co-tenant contact for USERS.tenant2");

    const property = (await c.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'B010 payer-check','TW','TWD','Asia/Taipei') RETURNING id::text`, [ORG_ID])).rows[0].id;
    const unit = (await c.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'B010') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
    // (1) lease with primary=USERS.tenant and co_tenant=USERS.tenant2
    const lease = (await c.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id::text`, [ORG_ID, property, unit])).rows[0].id;
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, lease, payer.id]);
    await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`, [ORG_ID, lease, other.id]);

    const invoice = (await c.query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES($1,$2,$3,$4,'TWD','2026-11-01','open',100000) RETURNING id::text`, [ORG_ID, property, lease, `B010-${randomUUID()}`])).rows[0].id;

    // (2) payment whose payer is the primary tenant
    const payment = (await c.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,$4,'TWD',100,'2026-11-01','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`, [ORG_ID, property, lease, payer.id, USERS.tenant])).rows[0].id;

    // (3) payment_confirmed b010 + center event with b010_event_id (occurred_at=created_at)
    const b010 = (await c.query<{ id: string; created_at: string }>(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_confirmed',$4,$5) RETURNING id::text,created_at::text`, [ORG_ID, lease, payment, randomUUID(), USERS.admin])).rows[0];
    const event = (await c.query<{ id: string }>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'payment_confirmed',$2,$3) RETURNING id::text`, [ORG_ID, b010.id, b010.created_at])).rows[0].id;

    // (4) a co-tenant who is not the payer must fail closed with 23514 / Invalid recipient
    await c.query("SAVEPOINT cotenant");
    await assert.rejects(
      c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4)`, [ORG_ID, event, USERS.tenant2, other.id]),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "23514" && /Invalid recipient/.test(e.message ?? "");
      },
    );
    await c.query("ROLLBACK TO SAVEPOINT cotenant");

    // (5) the payer is a valid recipient
    const payerRecipient = (await c.query<{ id: string }>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4) RETURNING id::text`, [ORG_ID, event, USERS.tenant, payer.id])).rows[0];
    assert.ok(payerRecipient.id, "payer recipient should insert");

    // (6) rent_due on the same b010 branch is unchanged: the co-tenant stays valid
    const rentB010 = (await c.query<{ id: string; created_at: string }>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`, [ORG_ID, lease, invoice, randomUUID()])).rows[0];
    const rentEvent = (await c.query<{ id: string }>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`, [ORG_ID, rentB010.id, rentB010.created_at])).rows[0].id;
    const rentRecipient = (await c.query<{ id: string }>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4) RETURNING id::text`, [ORG_ID, rentEvent, USERS.tenant2, other.id])).rows[0];
    assert.ok(rentRecipient.id, "co-tenant rent_due recipient should still insert");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
