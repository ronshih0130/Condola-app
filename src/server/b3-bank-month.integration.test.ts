import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { BANK_ADMISSION_SQL_FOR_TEST as ADMIT, BANK_CALENDAR_SQL_FOR_TEST as CALENDAR,
  BANK_SUMMARY_SQL_FOR_TEST as SUMMARY, BANK_LIST_SQL_FOR_TEST as LIST, bankMonth, type BankMonthInput } from "./b3-bank-month";
import { decideBankMatch, importBankFile } from "./bank-matching";
import { governCustomRole } from "./b017-custom-role-governance";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Mac runner only: fully migrated disposable LOCAL PostgreSQL, using its table-owner fixture login.
// No migration/seed, provider, transport, production/staging, or notification helper is executed here.
// Decision regression uses already-confirmed payments; other item flags remain OFF.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const MONTH = "2030-05";
const ON = { v3: async () => true, now: () => new Date("2030-05-01T00:30:00Z") };
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
const settings = new Map<string, unknown>();
let db: Client;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  for (const key of ["bank_matching", "custom_roles"]) settings.set(key, (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0]?.value);
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
});
test.after(async () => {
  try {
    for (const [key, value] of settings) {
      if (value === undefined) await query("DELETE FROM platform_settings WHERE key = $1", [key]);
      else await query("INSERT INTO platform_settings (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
    }
  } finally {
    if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom;
    await db?.end();
  }
});
async function user() {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
    VALUES ($1,$2,'{}'::jsonb,now(),'authenticated','authenticated')`, [id, `${id}@example.test`]); return id;
}
type Role = "admin" | "manager" | "accountant" | "maintenance";
async function makeSession(userId: string, orgId: string, role: Role): Promise<Session> {
  const sessionId = randomUUID();
  await query("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId, liveOrgId: orgId, environment: "live", kind: "staff", role, locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
}
async function org() {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name,country_code,default_currency,timezone,feature_flags)
    VALUES ('Bank month synthetic','TW','TWD','America/Los_Angeles','{"bank_matching":true}'::jsonb) RETURNING id::text`)).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user(); await query("INSERT INTO org_members (org_id,user_id,role,status) VALUES ($1,$2,$3::org_role,'active')", [orgId, id, role]);
    staff[role] = await makeSession(id, orgId, role);
  }
  await query(`INSERT INTO platform_settings (key,value) VALUES ('bank_matching', jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
    ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('enabled',true,'allowed_org_ids',coalesce(platform_settings.value->'allowed_org_ids','[]'::jsonb) || jsonb_build_array($1::text))`, [orgId]);
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id,name,country_code,currency,timezone)
    VALUES ($1,'Synthetic property','TW','TWD','Asia/Taipei') RETURNING id::text`, [orgId])).rows[0].id;
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id,property_id,label,rental_mode) VALUES ($1,$2,'Synthetic unit','whole_unit') RETURNING id::text`, [orgId, property])).rows[0].id;
  const lease = (await query<{ id: string }>(`INSERT INTO leases (org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES ($1,$2,$3,$3,'active','imported','2029-01-01','2031-01-01','TWD',0) RETURNING id::text`, [orgId, property, unit])).rows[0].id;
  return { orgId, staff, property, lease };
}
type Org = Awaited<ReturnType<typeof org>>;
async function account(o: Org, archived = false, dedicated = false) {
  return (await query<{ id: string }>(`INSERT INTO bank_accounts (org_id,nickname,currency,property_id,archived_at)
    VALUES ($1,'Synthetic account','TWD',$2,CASE WHEN $3 THEN now() ELSE NULL END) RETURNING id::text`, [o.orgId, dedicated ? o.property : null, archived])).rows[0].id;
}
async function imported(o: Org, accountId: string, at = "2030-06-01T12:00:00Z") {
  const file = (await query<{ id: string }>(`INSERT INTO files (org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
    VALUES ($1,'bank-imports',$2,'synthetic.csv','text/csv',10,$3) RETURNING id::text`, [o.orgId, `synthetic/${randomUUID()}.csv`, o.staff.admin.userId])).rows[0].id;
  const id = (await query<{ id: string }>(`INSERT INTO bank_statement_imports (org_id,bank_account_id,file_id,status,row_count,uploaded_by,created_at)
    VALUES ($1,$2,$3,'completed',1,$4,$5) RETURNING id::text`, [o.orgId, accountId, file, o.staff.admin.userId, at])).rows[0].id;
  return { id, accountId };
}
async function line(o: Org, imp: Awaited<ReturnType<typeof imported>>, opts: { date?: string; amount?: string; status?: "unmatched" | "suggested" | "matched" | "ignored"; currency?: string } = {}) {
  return (await query<{ id: string }>(`INSERT INTO bank_transactions
    (org_id,bank_account_id,import_id,row_number,posted_on,amount_minor,currency,description,counterparty_account_last5,raw,dedupe_hash,status)
    VALUES ($1,$2,$3,1,$4,$5::bigint,$6,'Synthetic memo','12345','{}'::jsonb,$7,$8::bank_txn_status) RETURNING id::text`,
  [o.orgId, imp.accountId, imp.id, opts.date ?? "2030-05-12", opts.amount ?? "1000", opts.currency ?? "TWD", randomUUID(), opts.status ?? "unmatched"])).rows[0].id;
}
async function payment(o: Org, opts: { amount?: string; date?: string; status?: "submitted" | "confirmed" | "rejected"; linked?: string; currency?: string } = {}) {
  const status = opts.status ?? "confirmed";
  return (await query<{ id: string }>(`INSERT INTO payments (org_id,property_id,lease_id,currency,amount_minor,paid_on,payer_account_last5,method,status,source,submitted_by,confirmed_by,confirmed_at,rejected_reason,bank_transaction_id)
    VALUES ($1,$2,$3,$4,$5::bigint,$6,'12345','bank_transfer',$7::payment_status,'tenant_portal',$8,
      CASE WHEN $7 = 'confirmed' THEN $8::uuid ELSE NULL END, CASE WHEN $7 = 'confirmed' THEN now() ELSE NULL END,
      CASE WHEN $7 = 'rejected' THEN 'Synthetic rejection' ELSE NULL END,$9) RETURNING id::text`,
  [o.orgId, o.property, o.lease, opts.currency ?? "TWD", opts.amount ?? "1000", opts.date ?? "2030-05-12", status, o.staff.admin.userId, opts.linked ?? null])).rows[0].id;
}
async function suggestion(o: Org, bank: string, pay: string, reasons: unknown = { amount_exact: true, last5: "12345", date_delta_days: 0 }) {
  return (await query<{ id: string }>(`INSERT INTO bank_match_suggestions (org_id,bank_transaction_id,payment_id,score,reasons,status)
    VALUES ($1,$2,$3,0.8,$4::jsonb,'suggested') RETURNING id::text`, [o.orgId, bank, pay, JSON.stringify(reasons)])).rows[0].id;
}
async function read(s: Session, input: BankMonthInput = { month: MONTH }, deps: Parameters<typeof bankMonth>[2] = ON) {
  const result = await bankMonth(s, input, deps); assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("bank reader not ready"); return result;
}

test("selected-month population, archived exclusion, ignored only in all, uncapped counts, all-time upload and default org calendar", async () => {
  const o = await org(), a = await account(o), archived = await account(o, true);
  const imp = await imported(o, a), old = await imported(o, archived, "2030-07-01T00:00:00Z");
  const wanted = [];
  for (const status of ["unmatched", "suggested", "matched", "ignored"] as const) wanted.push(await line(o, imp, { status }));
  const april = await line(o, imp, { date: "2030-04-30" });
  await line(o, imp, { date: "2030-06-01" }); await line(o, old);
  const result = await read(o.staff.accountant, { month: MONTH, filter: "all" });
  assert.deepEqual(result.counts, { all: 4, matched: 1, review: 2, ignored: 1 });
  assert.deepEqual(result.rows.map(r => r.id).sort(), wanted.sort());
  assert.equal(result.accounts.length, 1); assert.equal(result.lastUploadAt, "2030-06-01T12:00:00.000000Z");
  assert.equal(result.lastUploadScope, "org_unarchived_accounts_all_time");
  assert.equal((await read(o.staff.accountant)).rows.length, 2);
  assert.deepEqual((await read(o.staff.accountant, { month: MONTH, filter: "matched" })).rows.map(r => r.status), ["matched"]);
  const current = await read(o.staff.admin, {}); assert.equal(current.month, "2030-04"); assert.deepEqual(current.rows.map(r => r.id), [april]);
  const empty = await read(o.staff.admin, { month: "2020-01" }); assert.equal(empty.counts.all, 0); assert.equal(empty.rows.length, 0);
});

test("exact, several, same-day, none and single partial states; payment eligibility and allocation context", async () => {
  const o = await org(), a = await account(o, false, true), imp = await imported(o, a);
  const exact = await line(o, imp, { status: "suggested", amount: "1000" });
  const p = await payment(o); await suggestion(o, exact, p);
  const invoice = (await query<{ id: string }>(`INSERT INTO invoices (org_id,property_id,lease_id,invoice_number,currency,due_date,period_start,status)
    VALUES ($1,$2,$3,'SYNTHETIC-APRIL','TWD','2030-04-01','2030-04-01','open') RETURNING id::text`, [o.orgId, o.property, o.lease])).rows[0].id;
  await query(`INSERT INTO invoice_lines (org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor)
    VALUES ($1,$2,1,'rent','Synthetic',1000,1000)`, [o.orgId, invoice]);
  await query("INSERT INTO payment_allocations (org_id,payment_id,invoice_id,amount_minor) VALUES ($1,$2,$3,1000)", [o.orgId, p, invoice]);
  const multi = await line(o, imp, { status: "suggested", amount: "2000" });
  for (const days of [0, 2]) await suggestion(o, multi, await payment(o, { amount: "2000" }), { amount_exact: true, last5: "12345", date_delta_days: days });
  const same = await line(o, imp, { status: "suggested", amount: "3000" });
  for (const last5 of ["12345", null]) await suggestion(o, same, await payment(o, { amount: "3000" }), { amount_exact: true, last5, date_delta_days: 0 });
  const none = await line(o, imp, { amount: "4000" });
  const manual = await payment(o, { amount: "4000" });
  const partial = await line(o, imp, { status: "suggested", amount: "5000" });
  await suggestion(o, partial, await payment(o, { amount: "5000" }), { amount_exact: true, last5: null, date_delta_days: 1 });
  // Stale suggestions are neither candidates nor counts: rejected, linked, amount/currency changed.
  const linkedBank = await line(o, imp, { status: "matched", amount: "1000" });
  for (const opts of [{ status: "rejected" as const }, { linked: linkedBank }, { amount: "1001" }, { currency: "USD" }]) await suggestion(o, exact, await payment(o, opts));
  const result = await read(o.staff.admin), get = (id: string) => result.rows.find(r => r.id === id)!;
  for (const [id, kind, count] of [[exact, "exact", 1], [multi, "possible", 2], [same, "same_day", 2], [none, "none", 0], [partial, "possible", 1]] as const) assert.deepEqual(get(id).candidateState, { kind, count });
  assert.deepEqual(get(exact).candidates.map(c => c.paymentId), [p]);
  assert.deepEqual(get(exact).candidates[0].invoices, [{ id: invoice, month: "2030-04", number: "SYNTHETIC-APRIL", amountMinor: "1000" }]);
  assert.equal(get(none).candidates[0].paymentId, manual); assert.equal(get(none).candidates[0].suggestionId, null);
  const negative = await line(o, imp, { amount: "-1000" }), large = await line(o, imp, { amount: "9007199254740993" });
  const all = await read(o.staff.admin); assert.equal(all.rows.find(r => r.id === negative)?.amountMinor, "-1000");
  assert.equal(all.rows.find(r => r.id === large)?.amountMinor, "9007199254740993");
  assert.deepEqual(all.rows.find(r => r.id === large)?.candidates, []);
});

test("50-row keyset pagination keeps full counts and no duplicate/skipped IDs", async () => {
  const o = await org(), imp = await imported(o, await account(o));
  const ids = [];
  for (let i = 0; i < 57; i++) ids.push(await line(o, imp));
  const first = await read(o.staff.admin); assert.equal(first.rows.length, 50); assert.equal(first.counts.all, 57); assert.ok(first.nextCursor);
  const second = await read(o.staff.admin, { month: MONTH, cursor: first.nextCursor });
  assert.equal(second.rows.length, 7); assert.equal(second.counts.all, 57); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.rows, ...second.rows].map(r => r.id).sort(), ids.sort());
  assert.deepEqual(await bankMonth(o.staff.admin, { month: MONTH, filter: "all", cursor: first.nextCursor }, ON), { state: "unavailable" });
});

function sqlParams(sql: string, s: Session): unknown[] {
  if (sql === ADMIT) return [s.orgId, s.sessionId, s.userId, s.environment, s.liveOrgId];
  if (sql === CALENDAR) return [s.orgId, ON.now().toISOString()];
  return sql === SUMMARY ? [s.orgId, `${MONTH}-01`] : [s.orgId, `${MONTH}-01`, "all", null, null, 51];
}
test("actual SQL rejects anon; cross-org/nonmember/wrong-environment cannot read bank rows or candidates", async () => {
  const o = await org(), other = await org(), imp = await imported(o, await account(o));
  const bank = await line(o, imp); await suggestion(o, bank, await payment(o));
  const outsider = await user();
  for (const sql of [CALENDAR, SUMMARY, LIST]) {
    await db.query("BEGIN");
    try { await db.query("SET LOCAL ROLE anon"); await assert.rejects(db.query(sql, sqlParams(sql, o.staff.admin)), (e: unknown) => (e as { code?: string }).code === "42501"); }
    finally { await db.query("ROLLBACK"); }
    for (const [userId, pin, env] of [[outsider, o.orgId, "live"], [other.staff.admin.userId, other.orgId, "live"], [o.staff.admin.userId, o.orgId, "sandbox"]] as const) {
      const rows = await tx(userId, async c => (await c.query(sql, sqlParams(sql, o.staff.admin))).rows, { orgId: pin, environment: env });
      if (sql === SUMMARY) assert.deepEqual(rows, [{ all: 0, matched: 0, review: 0, ignored: 0, lastUploadAt: null, accounts: [] }]);
      else assert.deepEqual(rows, []);
    }
  }
  await assert.rejects(bankMonth({ ...other.staff.admin, orgId: o.orgId, liveOrgId: o.orgId }, { month: MONTH }, ON), denied);
  await assert.rejects(bankMonth({ ...o.staff.admin, environment: "sandbox" }, { month: MONTH }, ON), denied);
});

test("native permission, stale membership and session denial; item OFF is unavailable, brand OFF skips business tx", async () => {
  const o = await org(); await line(o, await imported(o, await account(o)));
  for (const s of [o.staff.manager, o.staff.maintenance, { ...o.staff.admin, kind: "tenant" as const }, { ...o.staff.admin, kind: "owner" as const }]) await assert.rejects(bankMonth(s, { month: MONTH }, ON), denied);
  await query("UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2", [o.orgId, o.staff.accountant.userId]);
  await assert.rejects(bankMonth(o.staff.accountant, { month: MONTH }, ON), denied);
  await query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [o.staff.admin.sessionId]);
  await assert.rejects(bankMonth(o.staff.admin, { month: MONTH }, ON), denied);
  const fresh = await makeSession(o.staff.admin.userId, o.orgId, "admin");
  await query("UPDATE organizations SET feature_flags=feature_flags - 'bank_matching' WHERE id=$1", [o.orgId]);
  assert.deepEqual(await bankMonth(fresh, { month: MONTH }, ON), { state: "unavailable" });
  let opened = 0;
  const never: typeof tx = async () => { opened++; throw new Error("OFF transaction"); };
  assert.deepEqual(await bankMonth(fresh, { month: MONTH }, { transaction: never }), { state: "off" }); assert.equal(opened, 0);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true,"brand_v2":true,"brand_v3":true}'::jsonb WHERE id=$1`, [o.orgId]);
  assert.equal((await read(fresh, { month: MONTH }, { now: ON.now })).counts.all, 1);
});

test("B-017 custom permission denied before read and revoked between admission and snapshot", async () => {
  const o = await org(); await line(o, await imported(o, await account(o)));
  await query("UPDATE org_members SET is_billing_owner=true WHERE org_id=$1 AND user_id=$2", [o.orgId, o.staff.admin.userId]);
  const before = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await query(`INSERT INTO platform_settings (key,value) VALUES ('custom_roles',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"custom_roles":true}'::jsonb WHERE id=$1`, [o.orgId]);
    const memberId = (await query<{ id: string }>("SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2", [o.orgId, o.staff.accountant.userId])).rows[0].id;
    const roleId = (await governCustomRole(o.staff.admin, { operation: "create", grants: ["stmt.view"], requestId: randomUUID() })).roleId!;
    const assign = () => governCustomRole(o.staff.admin, { operation: "assign", roleId, memberId, requestId: randomUUID() });
    await assign(); await assert.rejects(bankMonth(o.staff.accountant, { month: MONTH }, ON), denied);
    await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["bank.reconcile"], requestId: randomUUID() }); await assign();
    const fresh = await makeSession(o.staff.accountant.userId, o.orgId, "accountant");
    assert.equal((await read(fresh)).counts.all, 1);
    const revoked: typeof tx = async (...args) => {
      await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["stmt.view"], requestId: randomUUID() }); await assign();
      return tx(...args);
    };
    await assert.rejects(bankMonth(fresh, { month: MONTH }, { ...ON, transaction: revoked }), denied);
  } finally {
    if (before === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = before;
  }
});

test("summary/list share a read-only repeatable snapshot; actual two-second statement timeout returns unavailable", async () => {
  const o = await org(), bank = await line(o, await imported(o, await account(o)));
  const racing: typeof tx = (user, fn, scope, options) => tx(user, async c => {
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    assert.equal((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    assert.equal((await c.query("SELECT current_user AS role")).rows[0].role, "authenticated");
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await run(...args);
      if (args[0] === SUMMARY) await query("UPDATE bank_transactions SET status='matched' WHERE id=$1", [bank]);
      return result;
    };
    return fn(c);
  }, scope, options);
  const pinned = await read(o.staff.accountant, { month: MONTH }, { ...ON, transaction: racing });
  assert.equal(pinned.counts.review, 1); assert.equal(pinned.rows[0].status, "unmatched");
  assert.equal((await read(o.staff.accountant)).counts.matched, 1);
  let counted = false, cancelled: string | undefined;
  const slow: typeof tx = (user, fn, scope, options) => tx(user, async c => {
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      if (args[0] === LIST) {
        assert.equal(counted, true);
        try { await run("SELECT pg_sleep(30)"); } catch (e) { cancelled = (e as { code?: string }).code; throw e; }
      }
      const result = await run(...args); if (args[0] === SUMMARY) counted = true; return result;
    };
    return fn(c);
  }, scope, options);
  assert.deepEqual(await bankMonth(o.staff.accountant, { month: MONTH }, { ...ON, transaction: slow }), { state: "unavailable" });
  assert.equal(cancelled, "57014");
});

test("unchanged writers: identical file deduplicates; accept moves to matched; reject stays review; manual match and failed match", async () => {
  const o = await org(), a = await account(o);
  // Already-confirmed targets avoid confirmation/event-production paths. All other item flags are OFF.
  await payment(o, { amount: "1000", date: "2030-05-12" });
  const bytes = new TextEncoder().encode("date,amount,last5,memo\n2030-05-12,10.00,12345,synthetic");
  const first = await importBankFile(o.staff.admin, a, bytes, "utf-8"), again = await importBankFile(o.staff.admin, a, bytes, "utf-8");
  assert.ok(first && again); assert.equal(again.duplicate, true); assert.equal(first.importId, again.importId);
  const before = await read(o.staff.admin); assert.equal(before.counts.all, 1);
  assert.equal((await query("SELECT count(*)::int AS n FROM bank_statement_imports WHERE org_id=$1", [o.orgId])).rows[0].n, 1);
  const exact = before.rows[0]; assert.equal(exact.candidateState.kind, "exact");
  assert.equal(await decideBankMatch(o.staff.admin, { bankId: exact.id, suggestionId: exact.candidates[0].suggestionId!, decision: "match", reason: "confirmed_amount", requestId: randomUUID() }), true);
  const after = await read(o.staff.admin); assert.equal(after.counts.review, 0); assert.equal(after.counts.matched, 1); assert.equal(after.rows.length, 0);
  assert.equal((await read(o.staff.admin, { month: MONTH, filter: "matched" })).rows[0].id, exact.id);
  const imp = await imported(o, a), bank = await line(o, imp, { status: "suggested", amount: "2000" });
  const pay = await payment(o, { amount: "2000" }), suggest = await suggestion(o, bank, pay);
  assert.equal(await decideBankMatch(o.staff.admin, { bankId: bank, suggestionId: suggest, decision: "reject", reason: "wrong_payment", requestId: randomUUID() }), true);
  const rejected = (await read(o.staff.admin)).rows.find(r => r.id === bank)!;
  assert.equal(rejected.status, "unmatched"); assert.equal(rejected.candidateState.kind, "none");
  const mismatch = await payment(o, { amount: "2001" });
  await assert.rejects(decideBankMatch(o.staff.admin, { bankId: bank, paymentId: mismatch, decision: "match", reason: "other", requestId: randomUUID() }));
  assert.deepEqual((await read(o.staff.admin)).rows.find(r => r.id === bank), rejected, "failed writer leaves row and candidates unchanged");
  assert.equal(await decideBankMatch(o.staff.admin, { bankId: bank, paymentId: pay, decision: "match", reason: "confirmed_amount", requestId: randomUUID() }), true);
  assert.equal((await read(o.staff.admin)).counts.matched, 2);
});

test("live/sandbox rows remain separate, live parent pin is required, sandbox-only member cannot reach parent", async () => {
  const o = await org(); const live = await line(o, await imported(o, await account(o)));
  const sb = (await query<{ id: string }>(`INSERT INTO organizations (name,country_code,default_currency,timezone,environment,live_org_id,feature_flags)
    VALUES ('Bank synthetic sandbox','TW','TWD','UTC','sandbox',$1,'{"bank_matching":true}'::jsonb) RETURNING id::text`, [o.orgId])).rows[0].id;
  await query(`UPDATE platform_settings SET value=jsonb_set(value,'{allowed_org_ids}',value->'allowed_org_ids' || jsonb_build_array($1::text)) WHERE key='bank_matching'`, [sb]);
  const sandboxOrg = { ...o, orgId: sb };
  const sandbox = await line(sandboxOrg, await imported(sandboxOrg, await account(sandboxOrg)));
  const staff = { ...o.staff.admin, orgId: sb, environment: "sandbox" as const };
  assert.deepEqual((await read(staff)).rows.map(r => r.id), [sandbox]);
  assert.deepEqual((await read(o.staff.admin)).rows.map(r => r.id), [live]);
  await assert.rejects(bankMonth({ ...staff, liveOrgId: sb }, { month: MONTH }, ON), denied);
  await assert.rejects(bankMonth({ ...staff, environment: "live" }, { month: MONTH }, ON), denied);
  const isolated = await user();
  await query("INSERT INTO org_members (org_id,user_id,role,status) VALUES ($1,$2,'admin','active')", [sb, isolated]);
  await assert.rejects(bankMonth(await makeSession(isolated, o.orgId, "admin"), { month: MONTH }, ON), denied);
});
