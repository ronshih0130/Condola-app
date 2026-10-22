import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { correctBillPayment, loadRentSettlement, recordBillPayment, reverseBillPayment } from "./rent-settlement";
import { instantSettlementMonth, taipeiCalendarDate } from "./rent-settlement-math";
import type { OrgRole, Session } from "./types";

function staff(userId: string, role: OrgRole, orgId = ORG_ID): Session {
  return {
    userId,
    sessionId: "settlement",
    email: `${role}@songxin.demo`,
    name: role,
    kind: "staff",
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

const admin = staff(USERS.admin, "admin");
const maintenance = staff(USERS.maintenance, "maintenance");

async function balanceOf(invoiceId: string) {
  return tx(USERS.admin, async (client) => {
    const row = await client.query<{ balance: string; status: string }>(
      `SELECT balance_minor::text AS balance, status::text
         FROM invoices WHERE id = $1 AND org_id = $2`,
      [invoiceId, ORG_ID],
    );
    return row.rows[0];
  });
}

test("bill payments stay org-scoped, partial, correctable, and reversible", async () => {
  const seed = await tx(USERS.admin, async (client) => {
    const invoice = await client.query<{ id: string; balance: string }>(
      `SELECT id::text, balance_minor::text AS balance
         FROM invoices WHERE org_id = $1 AND invoice_number = 'INV-SEED-001'`,
      [ORG_ID],
    );
    return invoice.rows[0];
  });
  assert.ok(seed);
  const original = seed.balance;
  let latest = "";
  try {
    const recorded = await recordBillPayment(admin, {
      invoiceId: seed.id,
      amount: "4000",
      paidOn: "2099-01-31",
      method: "bank_transfer",
      reason: "登錄已繳",
    });
    latest = recorded.paymentId;
    const partial = await balanceOf(seed.id);
    assert.equal(partial?.balance, String(BigInt(original) - BigInt(400_000)));
    assert.equal(partial?.status, "partially_paid");

    const zones = await tx(USERS.admin, async (client) => {
      const row = await client.query<{ evening: string; midnight: string }>(
        `SELECT to_char(timestamptz '2026-03-31 15:59:59+00' AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS evening,
                to_char(timestamptz '2026-03-31 16:00:00+00' AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS midnight`,
      );
      return row.rows[0];
    });
    assert.equal(zones?.evening, taipeiCalendarDate(new Date("2026-03-31T15:59:59.000Z")));
    assert.equal(zones?.midnight, taipeiCalendarDate(new Date("2026-03-31T16:00:00.000Z")));
    assert.equal(instantSettlementMonth(`${zones?.evening}T00:00:00+08:00`), "2026-03");
    assert.equal(instantSettlementMonth(`${zones?.midnight}T00:00:00+08:00`), "2026-04");

    const march = await loadRentSettlement(admin, "2099-01", "2026-10-22");
    const april = await loadRentSettlement(admin, "2099-02", "2026-10-22");
    const owner = march?.owners.find((row) => row.ownerName === "陳建宏" && row.currency === "TWD");
    assert.equal(owner?.rentMinor, BigInt(400_000));
    assert.equal(owner?.feeMinor, BigInt(32_000));
    assert.equal(owner?.netMinor, BigInt(368_000));
    assert.equal(april?.owners.find((row) => row.ownerName === "陳建宏")?.rentMinor, BigInt(0));
    assert.equal(march?.payments.some((row) => row.id === recorded.paymentId && row.status === "confirmed"), true);

    const corrected = await correctBillPayment(admin, {
      paymentId: recorded.paymentId,
      amount: "5000",
      paidOn: "2099-02-01",
      method: "cash",
      reason: "更正金額",
    });
    latest = corrected.paymentId;
    const afterCorrect = await balanceOf(seed.id);
    assert.equal(afterCorrect?.balance, String(BigInt(original) - BigInt(500_000)));
    const marchAfter = await loadRentSettlement(admin, "2099-01", "2026-10-22");
    const aprilAfter = await loadRentSettlement(admin, "2099-02", "2026-10-22");
    assert.equal(marchAfter?.owners.find((row) => row.ownerName === "陳建宏" && row.currency === "TWD")?.rentMinor, BigInt(0));
    const aprilOwner = aprilAfter?.owners.find((row) => row.ownerName === "陳建宏" && row.currency === "TWD");
    assert.equal(aprilOwner?.rentMinor, BigInt(500_000));
    assert.equal(aprilOwner?.feeMinor, BigInt(40_000));
    assert.equal(aprilOwner?.netMinor, BigInt(460_000));

    await assert.rejects(
      () => recordBillPayment(maintenance, { invoiceId: seed.id, amount: "1", paidOn: "2026-04-02", method: "cash", reason: "登錄已繳" }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const coastId = await tx(USERS.admin, async (client) => {
      const row = await client.query<{ id: string }>(`SELECT id::text FROM organizations WHERE id <> $1 LIMIT 1`, [ORG_ID]);
      return row.rows[0]?.id;
    });
    if (coastId) {
      const coast = staff(USERS.coastAdmin, "admin", coastId);
      await assert.rejects(
        () => reverseBillPayment(coast, corrected.paymentId, "其他公司"),
        (error: unknown) => error instanceof FlowError,
      );
    }

    await reverseBillPayment(admin, corrected.paymentId, "沖回這筆");
    const restored = await balanceOf(seed.id);
    assert.equal(restored?.balance, original);
    assert.equal(restored?.status, "open");
    const aprilEmpty = await loadRentSettlement(admin, "2099-02", "2026-10-22");
    assert.equal(aprilEmpty?.owners.find((row) => row.ownerName === "陳建宏" && row.currency === "TWD")?.rentMinor, BigInt(0));

    const audit = await tx(USERS.admin, async (client) => {
      const rows = await client.query<{ kind: string; reason: string }>(
        `SELECT kind, reason FROM payment_corrections
          WHERE org_id = $1 AND (payment_id = $2 OR payment_id = $3 OR replaces_payment_id = $2)
          ORDER BY created_at`,
        [ORG_ID, recorded.paymentId, corrected.paymentId],
      );
      return rows.rows;
    });
    assert.deepEqual(
      audit.map((row) => row.kind),
      ["record", "correct", "reverse"],
    );
    assert.equal(audit[1]?.reason, "更正金額");
    assert.equal(audit[2]?.reason, "沖回這筆");
  } finally {
    if (latest) {
      await withClient(async (client) => {
        await client.query("BEGIN");
        const open = await client.query<{ id: string; ledger: string | null; status: string }>(
          `SELECT id::text, ledger_transaction_id::text AS ledger, status::text
             FROM payments WHERE org_id = $1 AND lease_id = (
               SELECT lease_id FROM invoices WHERE id = $2
             ) AND status = 'confirmed' AND paid_on IN ('2099-01-31', '2099-02-01')`,
          [ORG_ID, seed.id],
        );
        for (const payment of open.rows) {
          if (payment.ledger) await client.query(`SELECT post_reversal($1::uuid, $2)`, [payment.ledger, "test cleanup"]);
          await client.query(`UPDATE payments SET status = 'reversed' WHERE id = $1 AND status = 'confirmed'`, [payment.id]);
        }
        await client.query("COMMIT");
      }).catch(() => undefined);
    }
  }
});

test("anon and authenticated cannot execute invoice recalc, and a member insert still recalculates", async () => {
  const rules = readFileSync(new URL("../../supabase/migrations/20261029190000_payment_settlement_rules.sql", import.meta.url), "utf8");
  await withClient(async (client) => {
    await client.query(rules);
    await client.query(rules);
  });

  const defs = await query<{ proname: string; prosecdef: boolean; proconfig: string | null }>(
    `SELECT p.proname, p.prosecdef, p.proconfig::text AS proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('fn_invoice_recalc', 'fn_invoice_lines_changed', 'fn_payment_status_changed')
      ORDER BY p.proname`,
  );
  assert.deepEqual(
    defs.rows.map((row) => row.proname),
    ["fn_invoice_lines_changed", "fn_invoice_recalc", "fn_payment_status_changed"],
  );
  for (const row of defs.rows) {
    assert.equal(row.prosecdef, true, row.proname);
    assert.match(row.proconfig ?? "", /search_path=public, pg_temp/, row.proname);
  }

  const priv = await query<{
    anon_recalc: boolean;
    auth_recalc: boolean;
    anon_lines: boolean;
    auth_lines: boolean;
    anon_payment: boolean;
    auth_payment: boolean;
    service_recalc: boolean;
    service_lines: boolean;
    service_payment: boolean;
  }>(
    `SELECT
       has_function_privilege('anon', 'public.fn_invoice_recalc(uuid)', 'EXECUTE') AS anon_recalc,
       has_function_privilege('authenticated', 'public.fn_invoice_recalc(uuid)', 'EXECUTE') AS auth_recalc,
       has_function_privilege('anon', 'public.fn_invoice_lines_changed()', 'EXECUTE') AS anon_lines,
       has_function_privilege('authenticated', 'public.fn_invoice_lines_changed()', 'EXECUTE') AS auth_lines,
       has_function_privilege('anon', 'public.fn_payment_status_changed()', 'EXECUTE') AS anon_payment,
       has_function_privilege('authenticated', 'public.fn_payment_status_changed()', 'EXECUTE') AS auth_payment,
       has_function_privilege('service_role', 'public.fn_invoice_recalc(uuid)', 'EXECUTE') AS service_recalc,
       has_function_privilege('service_role', 'public.fn_invoice_lines_changed()', 'EXECUTE') AS service_lines,
       has_function_privilege('service_role', 'public.fn_payment_status_changed()', 'EXECUTE') AS service_payment`,
  );
  assert.equal(priv.rows[0]?.anon_recalc, false);
  assert.equal(priv.rows[0]?.auth_recalc, false);
  assert.equal(priv.rows[0]?.anon_lines, false);
  assert.equal(priv.rows[0]?.auth_lines, false);
  assert.equal(priv.rows[0]?.anon_payment, false);
  assert.equal(priv.rows[0]?.auth_payment, false);
  assert.equal(priv.rows[0]?.service_recalc, true);
  assert.equal(priv.rows[0]?.service_lines, true);
  assert.equal(priv.rows[0]?.service_payment, true);

  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE anon");
    await client.query("SAVEPOINT recalc");
    await assert.rejects(
      () => client.query(`SELECT fn_invoice_recalc('00000000-0000-4000-8000-000000000099'::uuid)`),
      /permission denied/i,
    );
    await client.query("ROLLBACK TO SAVEPOINT recalc");
    await assert.rejects(() => client.query(`SELECT fn_invoice_lines_changed()`), /permission denied/i);
    await client.query("ROLLBACK TO SAVEPOINT recalc");
    await assert.rejects(() => client.query(`SELECT fn_payment_status_changed()`), /permission denied/i);
    await client.query("ROLLBACK");
  });

  await tx(USERS.admin, async (client) => {
    await client.query("SAVEPOINT recalc");
    await assert.rejects(
      () => client.query(`SELECT fn_invoice_recalc('00000000-0000-4000-8000-000000000099'::uuid)`),
      /permission denied/i,
    );
    await client.query("ROLLBACK TO SAVEPOINT recalc");
    await assert.rejects(() => client.query(`SELECT fn_invoice_lines_changed()`), /permission denied/i);
    await client.query("ROLLBACK TO SAVEPOINT recalc");
    await assert.rejects(() => client.query(`SELECT fn_payment_status_changed()`), /permission denied/i);
  });

  const invoice = await tx(USERS.admin, async (client) => {
    const row = await client.query<{ id: string; total: string }>(
      `SELECT id::text, total_minor::text AS total FROM invoices WHERE org_id = $1 AND invoice_number = 'INV-SEED-001'`,
      [ORG_ID],
    );
    return row.rows[0];
  });
  assert.ok(invoice);
  const lineId = await tx(USERS.admin, async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
       VALUES ($1,$2,90,'adjustment','qa line',1,100,100) RETURNING id::text`,
      [ORG_ID, invoice.id],
    );
    return row.rows[0]?.id;
  });
  assert.ok(lineId);
  const after = await tx(USERS.admin, async (client) => {
    const row = await client.query<{ total: string }>(`SELECT total_minor::text AS total FROM invoices WHERE id = $1`, [invoice.id]);
    return row.rows[0]?.total;
  });
  assert.equal(BigInt(after ?? "0") - BigInt(invoice.total), BigInt(100));
  await tx(USERS.admin, async (client) => {
    await client.query(`DELETE FROM invoice_lines WHERE id = $1`, [lineId]);
  });

  await withClient(async (client) => {
    await assert.rejects(
      () => client.query(`SELECT post_reversal('00000000-0000-4000-8000-000000009999'::uuid, 'missing')`),
      /not found/i,
    );
  });
  const txn = await query<{ id: string }>(`SELECT id::text FROM ledger_transactions WHERE org_id = $1 LIMIT 1`, [ORG_ID]);
  assert.ok(txn.rows[0]);
  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.coastAdmin]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query("SET LOCAL ROLE authenticated");
    await assert.rejects(
      () => client.query(`SELECT post_reversal($1::uuid, 'cross')`, [txn.rows[0].id]),
      (error: unknown) => error instanceof Error && /42501|insufficient_privilege|cross-organization/i.test(error.message),
    );
    await client.query("ROLLBACK");
  });
});
