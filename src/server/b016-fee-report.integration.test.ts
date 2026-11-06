import assert from "node:assert/strict";
import test from "node:test";
import { query } from "./db";
import { generateStatement } from "./domain";
import { ORG_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
// Isolated, freshly seeded clone: the shared disposable DB is never mutated and
// prior suites (e.g. statement-preview, which mutates its DB) cannot affect this one.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); await resetAndSeed(); });
test.after(async () => { await clone?.cleanup(); });
const admin: Session = { userId: USERS.admin, sessionId: "b016-local", email: "admin@example.invalid",
  name: "B016", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID,
  environment: "live", locale: "en", calendar: "gregorian", leaseId: null };

async function storedStatement(id: string) {
  const statement = (await query(`SELECT fee_rule_snapshot, opening_balance_minor::text,
    rent_received_minor::text, other_income_minor::text, management_fee_minor::text,
    expenses_minor::text, payouts_minor::text, closing_balance_minor::text
    FROM owner_statements WHERE id=$1`, [id])).rows[0];
  const lines = (await query(`SELECT * FROM owner_statement_lines WHERE statement_id=$1 ORDER BY id`, [id])).rows;
  return { statement, lines };
}

test("B-016 January fee snapshot, totals and lines survive rule edit, February issuance and January replay", async () => {
  const payment = (await query<{ id: string; owner: string; paid_on: string; rule: string; percent_bp: number }>(`
    SELECT p.id::text, po.owner_contact_id::text AS owner, p.paid_on::text,
      fr.id::text AS rule, fr.percent_bp
    FROM payments p JOIN leases l ON l.id=p.lease_id
    JOIN property_owners po ON po.org_id=p.org_id AND po.property_id=l.property_id
    JOIN management_agreements ma ON ma.org_id=p.org_id AND ma.owner_contact_id=po.owner_contact_id
    JOIN fee_rules fr ON fr.org_id=ma.org_id AND fr.id=ma.fee_rule_id
    WHERE p.org_id=$1 AND p.status='confirmed' AND fr.kind='percent'
      AND ma.property_id IS NULL AND ma.effective_to IS NULL
      AND ma.effective_from < '2199-01-01'
      AND EXISTS (SELECT 1 FROM payment_allocations a JOIN invoice_lines il ON il.invoice_id=a.invoice_id
        WHERE a.payment_id=p.id AND il.charge_type='rent' AND il.amount_minor>0)
    ORDER BY p.id LIMIT 1`, [ORG_ID])).rows[0];
  assert.ok(payment, "seeded confirmed rent and percentage agreement required");
  const invoiceLinks = (await query<{ id: string; owner_statement_id: string | null }>(`
    SELECT id::text, owner_statement_id::text FROM invoices WHERE org_id=$1`, [ORG_ID])).rows;
  const flags = (await query<{ feature_flags: object }>(`SELECT feature_flags FROM organizations WHERE id=$1`, [ORG_ID])).rows[0].feature_flags;
  const platform = (await query<{ key: string; value: object }>(`
    SELECT key,value FROM platform_settings WHERE key IN ('billing_previews','owner_net_ledger')`)).rows;
  const issuedIds: string[] = [];
  assert.equal((await query(`SELECT count(*)::int AS n FROM owner_statements
    WHERE owner_contact_id=$1 AND period_start IN ('2199-01-01','2199-02-01')`, [payment.owner])).rows[0].n, 0);
  try {
    // Local fixtures only; restore settings and source rows even after failure.
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb
      WHERE key IN ('billing_previews','owner_net_ledger')`);
    await query(`UPDATE organizations SET feature_flags=feature_flags ||
      '{"billing_previews":false,"owner_net_ledger":false}'::jsonb WHERE id=$1`, [ORG_ID]);
    await query(`UPDATE fee_rules SET percent_bp=1000 WHERE id=$1`, [payment.rule]);
    await query(`UPDATE payments SET paid_on='2199-01-15' WHERE id=$1`, [payment.id]);
    const january = await generateStatement(admin, { ownerContactId: payment.owner, month: "2199-01" });
    issuedIds.push(january.statementId);
    const original = await storedStatement(january.statementId);
    assert.equal(original.statement.fee_rule_snapshot.percent_bp, 1000);
    const rent = BigInt(original.statement.rent_received_minor);
    assert.ok(rent > BigInt(0));
    assert.equal(BigInt(original.statement.management_fee_minor), (rent * BigInt(1000) + BigInt(5000)) / BigInt(10000));
    assert.ok(original.lines.length > 0);

    await query(`UPDATE fee_rules SET percent_bp=1500 WHERE id=$1`, [payment.rule]);
    await query(`UPDATE payments SET paid_on='2199-02-15' WHERE id=$1`, [payment.id]);
    const february = await generateStatement(admin, { ownerContactId: payment.owner, month: "2199-02" });
    issuedIds.push(february.statementId);
    const changed = await storedStatement(february.statementId);
    assert.equal(changed.statement.fee_rule_snapshot.percent_bp, 1500);
    assert.equal(BigInt(changed.statement.rent_received_minor), rent);
    assert.equal(BigInt(changed.statement.management_fee_minor), (rent * BigInt(1500) + BigInt(5000)) / BigInt(10000));
    assert.notEqual(changed.statement.management_fee_minor, original.statement.management_fee_minor);
    assert.equal(changed.statement.opening_balance_minor, original.statement.closing_balance_minor);
    assert.deepEqual(await storedStatement(january.statementId), original);
    const replay = await generateStatement(admin, { ownerContactId: payment.owner, month: "2199-01" });
    assert.equal(replay.statementId, january.statementId);
    assert.deepEqual(await storedStatement(january.statementId), original);
  } finally {
    await query(`UPDATE payments SET paid_on=$2::date WHERE id=$1`, [payment.id, payment.paid_on]);
    await query(`UPDATE fee_rules SET percent_bp=$2 WHERE id=$1`, [payment.rule, payment.percent_bp]);
    for (const invoice of invoiceLinks) {
      await query(`UPDATE invoices SET owner_statement_id=$2 WHERE id=$1 AND owner_statement_id IS DISTINCT FROM $2::uuid`,
        [invoice.id, invoice.owner_statement_id]);
    }
    await query(`DELETE FROM owner_statement_lines WHERE statement_id=ANY($1::uuid[])`, [issuedIds]);
    await query(`DELETE FROM owner_statements WHERE id=ANY($1::uuid[])`, [issuedIds]);
    for (const setting of platform) await query(`UPDATE platform_settings SET value=$2::jsonb WHERE key=$1`, [setting.key, JSON.stringify(setting.value)]);
    await query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(flags)]);
  }
});
