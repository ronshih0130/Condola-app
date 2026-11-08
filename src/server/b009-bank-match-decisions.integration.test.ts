import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, USERS } from "./ids";
import { decideBankMatch, importBankFile } from "./bank-matching";
import type { Session } from "./types";

const source = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let admin: Client, db: Client, name: string, previous: string | undefined, owned = false;
let session: Session, accountId: string, currency: string;

test.before(async () => {
  name = `condola_b009d_${randomUUID().replaceAll("-", "")}`;
  const template = decodeURIComponent(source.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(template)) throw new Error("Invalid template");
  admin = new Client({ connectionString: withDatabase(source, "postgres") }); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`); owned = true;
  db = new Client({ connectionString: withDatabase(source, name) }); await db.connect();
  const installed = (await db.query<{ installed: boolean }>(`SELECT to_regclass('app.b009_file_imports') IS NOT NULL AS installed`)).rows[0].installed;
  if (!installed) await db.query(await readFile(new URL("../../supabase/migrations/20261031100209_b009_bank_match_decisions.sql", import.meta.url), "utf8"));
  const coded = (await db.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='b009_decisions_reason_code') AS present`)).rows[0].present;
  if (!coded) await db.query(await readFile(new URL("../../supabase/migrations/20261031100225_b009_decision_reason_codes.sql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../supabase/migrations/20261104120400_b009_bank_match_owner.sql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../../supabase/migrations/20261106010000_b009_bank_match_decisions.sql", import.meta.url), "utf8"));
  const objects = (await db.query(`SELECT to_regclass('app.b009_decisions') IS NOT NULL AS decisions,to_regprocedure('app.b009_direct_write_guard()') IS NOT NULL AS guard,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('b009_import_guard','b009_transaction_guard','b009_suggestion_guard','b009_payment_insert_guard','b009_payment_guard') AND NOT tgisinternal) AS guards`)).rows[0];
  assert.deepEqual(objects, { decisions: true, guard: true, guards: 5 });
  previous = process.env.DATABASE_URL; process.env.DATABASE_URL = withDatabase(source, name);
  await resetAndSeed();
  const sid = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`, [sid, USERS.admin, randomUUID()]);
  session = { userId: USERS.admin, sessionId: sid, orgId: ORG_ID, liveOrgId: ORG_ID, kind: "staff", role: "admin", environment: "live", locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" } as Session;
  const account = (await db.query(`SELECT id,currency FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [ORG_ID])).rows[0];
  assert.ok(account);
  accountId = account.id;
  currency = account.currency;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":false}'::jsonb WHERE id=$1`, [ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',false,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`, [ORG_ID]);
});

test.after(async () => {
  if (previous === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous;
  await db?.end();
  if (owned) await admin.query(`DROP DATABASE "${name}"`);
  await admin?.end();
});

function csv(rows: Array<[string, string]>) {
  return Buffer.from("date,description,amount\n" + rows.map(([description, amount]) => `2026-11-01,${description},${amount}`).join("\n") + "\n");
}

async function count(table: string, where = "", values: unknown[] = []) {
  return (await db.query(`SELECT count(*)::int AS count FROM ${table} ${where}`, values)).rows[0].count as number;
}

async function importRows(rows: Array<[string, string]>) {
  const result = await importBankFile(session, accountId, csv(rows), "utf-8");
  assert.ok(result);
  return result;
}

async function bankRow(description: string, amount: string) {
  const result = await importRows([[description, amount]]);
  const rows = (await db.query(`SELECT id,status FROM bank_transactions WHERE import_id=$1`, [result.importId])).rows;
  assert.equal(rows.length, 1);
  return rows[0] as { id: string; status: string };
}

async function payment(amountMinor: number) {
  const propertyId = randomUUID(), unitId = randomUUID(), leaseId = randomUUID();
  const invoiceId = randomUUID(), paymentId = randomUUID();
  await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone)
    VALUES ($1,$2,$3,'TW','TWD','Asia/Taipei')`, [propertyId, ORG_ID, `Decision ${propertyId}`]);
  await db.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,$4)`,
    [unitId, ORG_ID, propertyId, `Unit ${unitId}`]);
  await db.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor)
    VALUES ($1,$2,$3,$4,$4,'active','2026-01-01',$5,0)`, [leaseId, ORG_ID, propertyId, unitId, currency]);
  await db.query(`INSERT INTO invoices(id,org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor)
    VALUES ($1,$2,$3,$4,$5,$6,'2026-11-01','open',$7)`,
    [invoiceId, ORG_ID, propertyId, leaseId, `B009D-${invoiceId}`, currency, amountMinor]);
  await db.query(`INSERT INTO payments(id,org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by)
    VALUES ($1,$2,$3,$4,$5,$6,'2026-11-01','bank_transfer','submitted','tenant_portal',$7)`,
    [paymentId, ORG_ID, propertyId, leaseId, currency, amountMinor, USERS.admin]);
  return paymentId;
}

test("a: disabled flag returns null without writing import or decision rows", { concurrency: false }, async () => {
  const tables = ["bank_transactions", "app.b009_row_identities", "app.b009_decisions"];
  const before = await Promise.all(tables.map(table => count(table)));
  assert.equal(await importBankFile(session, accountId, csv([["disabled", "4321.00"]]), "utf-8"), null);
  assert.equal(await decideBankMatch(session, {
    bankId: randomUUID(), paymentId: randomUUID(), decision: "match", reason: "other",
  }), null);
  assert.deepEqual(await Promise.all(tables.map(table => count(table))), before);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`, [ORG_ID]);
});

test("b: exact imports and overlapping rows deduplicate while identical rows retain multiplicity", { concurrency: false }, async () => {
  const rows: Array<[string, string]> = [["overlap-old-a", "4321.00"], ["overlap-old-b", "4322.00"]];
  await importRows(rows);
  const before = await count("bank_transactions");
  assert.equal((await importRows(rows)).duplicate, true);
  assert.equal(await count("bank_transactions"), before);
  const overlap = await importRows([["overlap-new", "4323.00"], rows[0]]);
  assert.equal(overlap.duplicateRows, 1);
  assert.equal(await count("bank_transactions"), before + 1);
  const identical = await importRows([["identical", "4324.00"], ["identical", "4324.00"]]);
  assert.equal(await count("bank_transactions", "WHERE import_id=$1", [identical.importId]), 2);
  assert.equal(await count("bank_transactions"), before + 3);
});

test("c: ambiguous payments produce suggestions without allocating or confirming", { concurrency: false }, async () => {
  const payments = [await payment(555500), await payment(555500)];
  const bank = await bankRow("ambiguous", "5555.00");
  const suggestions = (await db.query(`SELECT payment_id FROM bank_match_suggestions WHERE bank_transaction_id=$1`, [bank.id])).rows;
  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map(row => row.payment_id).sort(), [...payments].sort());
  const statuses = (await db.query(`SELECT status FROM payments WHERE id=ANY($1::uuid[])`, [payments])).rows;
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every(row => row.status === "submitted"));
  assert.equal(await count("payment_allocations", "WHERE payment_id=ANY($1::uuid[])", [payments]), 0);
  const unmatched = await bankRow("no-candidate", "5556.00");
  assert.equal(unmatched.status, "unmatched");
  assert.equal(await count("bank_match_suggestions", "WHERE bank_transaction_id=$1", [unmatched.id]), 0);
});

test("d: manual decisions are idempotent and reject request ID payload changes", { concurrency: false }, async () => {
  const paymentId = await payment(666600);
  const bank = await bankRow("manual", "6666.00");
  const requestId = randomUUID();
  const input = { bankId: bank.id, paymentId, decision: "match" as const, reason: "confirmed_amount" as const, requestId };
  assert.equal(await decideBankMatch(session, input), true);
  assert.equal(await decideBankMatch(session, input), true);
  assert.equal(await count("app.b009_decisions", "WHERE request_id=$1", [requestId]), 1);
  await assert.rejects(() => decideBankMatch(session, { ...input, reason: "other" }));
  const decisions = (await db.query(`SELECT actor_id,source FROM app.b009_decisions WHERE request_id=$1`, [requestId])).rows;
  assert.deepEqual(decisions, [{ actor_id: USERS.admin, source: "manual" }]);
});

test("e: rejecting a suggestion retains its decision and suggestion source", { concurrency: false }, async () => {
  const paymentId = await payment(777700);
  const bank = await bankRow("reject-suggestion", "7777.00");
  const suggestions = (await db.query(`SELECT id FROM bank_match_suggestions WHERE bank_transaction_id=$1 AND payment_id=$2`, [bank.id, paymentId])).rows;
  assert.equal(suggestions.length, 1);
  const requestId = randomUUID();
  assert.equal(await decideBankMatch(session, {
    bankId: bank.id, suggestionId: suggestions[0].id, decision: "reject", reason: "wrong_payment", requestId,
  }), true);
  const decisions = (await db.query(`SELECT decision,source FROM app.b009_decisions WHERE request_id=$1`, [requestId])).rows;
  assert.deepEqual(decisions, [{ decision: "reject", source: "suggestion" }]);
});

test("f: concurrent matches permit exactly one payment to claim a bank row", { concurrency: false }, async () => {
  const payments = [await payment(888800), await payment(888800), await payment(888800)];
  const bank = await bankRow("concurrent", "8888.00");
  const results = await Promise.allSettled(payments.map(paymentId => decideBankMatch(session, {
    bankId: bank.id, paymentId, decision: "match", reason: "confirmed_amount", requestId: randomUUID(),
  })));
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value === true).length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 2);
  assert.equal(await count("app.b009_decisions", "WHERE bank_transaction_id=$1 AND decision='match'", [bank.id]), 1);
});

test("g: foreign organizations and sandbox sessions cannot import or decide", { concurrency: false }, async () => {
  for (const denied of [{ ...session, orgId: randomUUID() }, { ...session, environment: "sandbox" } as Session]) {
    assert.equal(await importBankFile(denied, accountId, csv([["denied", "9999.00"]]), "utf-8"), null);
    assert.equal(await decideBankMatch(denied, {
      bankId: randomUUID(), paymentId: randomUUID(), decision: "match", reason: "other",
    }), null);
  }
});
