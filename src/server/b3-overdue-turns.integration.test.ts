import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, OVERDUE_TURN_LIST_LIMIT, staffOverdueTurns } from "./b3-overdue-turns";
import { governCustomRole, resolveCustomRoleSession } from "./b017-custom-role-governance";
import { staffPaymentTurns } from "./b3-payment-turns";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Synthetic fixtures only. Run on the Mac's disposable, fully migrated PostgreSQL 16 DB.
// No migration application, outbound work or provider calls in this suite.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const TODAY = "2030-05-01";
const ON = { v3: async () => true, now: () => new Date(`${TODAY}T04:00:00Z`) };
const date = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const savedSettings = new Map<string, unknown>();
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
let db: Client;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  for (const key of ["today_home", "today_dash", "custom_roles"]) {
    const row = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0];
    if (row) savedSettings.set(key, row.value);
  }
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
});
test.after(async () => {
  try {
    for (const key of ["today_home", "today_dash", "custom_roles"]) {
      if (savedSettings.has(key)) await query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(savedSettings.get(key))]);
      else await query("DELETE FROM platform_settings WHERE key = $1", [key]);
    }
  } finally {
    if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom;
    await db?.end();
  }
});

type Role = "admin" | "manager" | "accountant" | "maintenance";
type Org = { orgId: string; property: string; staff: Record<Role, Session> };
async function user() {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
    VALUES ($1, $2, '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [id, `${id}@example.test`]);
  return id;
}
async function staffSession(userId: string, orgId: string, role: Role): Promise<Session> {
  const sessionId = randomUUID();
  await query(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId, liveOrgId: orgId, environment: "live", kind: "staff", role,
    locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
}
async function enable(orgId: string) {
  await query(`UPDATE organizations SET feature_flags = feature_flags ||
    '{"today_home":true,"today_dash":true}'::jsonb WHERE id = $1`, [orgId]);
  for (const key of ["today_home", "today_dash"]) {
    await query(`INSERT INTO platform_settings (key, value) VALUES ($1, jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($2::text)))
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('enabled', true, 'allowed_org_ids',
        coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($2::text))`, [key, orgId]);
  }
}
async function makeOrg(): Promise<Org> {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency)
    VALUES ('Overdue turns synthetic', 'TW', 'TWD') RETURNING id::text`)).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user();
    await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')`, [orgId, id, role]);
    staff[role] = await staffSession(id, orgId, role);
  }
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, 'Synthetic property', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId])).rows[0].id;
  await enable(orgId);
  return { orgId, property, staff };
}
let sequence = 0;
async function lease(o: Org, status: "active" | "ended" = "active", whole = false) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode)
    VALUES ($1, $2, $3, $4::rental_mode) RETURNING id::text`, [o.orgId, o.property, `U${sequence++}`, whole ? "whole_unit" : "by_room"])).rows[0].id;
  const room = whole ? null : (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label)
    VALUES ($1, $2, 'A') RETURNING id::text`, [o.orgId, unit])).rows[0].id;
  const id = (await query<{ id: string }>(`INSERT INTO leases
    (org_id, property_id, unit_id, target_room_id, target_unit_id, status, esign_status, start_date, end_date, currency, rent_amount_minor)
    VALUES ($1, $2, $3, $4, $5, $6::lease_status, 'imported', '2029-01-01', $7, 'TWD', 0) RETURNING id::text`,
  [o.orgId, o.property, unit, room, whole ? unit : null, status, status === "ended" ? date(-10) : date(100)])).rows[0].id;
  return { id, unit, room, orgId: o.orgId, property: o.property };
}
type Lease = Awaited<ReturnType<typeof lease>>;
async function invoice(l: Lease, opts: {
  due?: string; period?: string | null; amount?: string; paid?: string; currency?: string;
  status?: "open" | "partially_paid" | "paid" | "draft" | "void";
} = {}) {
  const id = (await query<{ id: string }>(`INSERT INTO invoices
    (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'open') RETURNING id::text`,
  [l.orgId, l.property, l.id, randomUUID(), opts.currency ?? "TWD", opts.due ?? date(-1), opts.period === undefined ? "2030-04-01" : opts.period])).rows[0].id;
  const amount = opts.amount ?? "100000";
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor)
    VALUES ($1, $2, 1, 'rent', 'Synthetic rent', $3::bigint, $3::bigint)`, [l.orgId, id, amount]);
  await query(`UPDATE invoices SET paid_minor = $2, status = $3::invoice_status,
    void_reason = CASE WHEN $3 = 'void' THEN 'Synthetic void' ELSE NULL END WHERE id = $1`,
  [id, opts.paid ?? "0", opts.status ?? "open"]);
  return id;
}
async function pay(l: Lease, status: "submitted" | "rejected" | "confirmed" | "reversed", source = "tenant_portal", confirmer?: string) {
  return (await query<{ id: string }>(`INSERT INTO payments
    (org_id, property_id, lease_id, currency, amount_minor, paid_on, method, status, source, submitted_at, confirmed_by, confirmed_at, rejected_reason)
    VALUES ($1, $2, $3, 'TWD', 100, '2030-04-01', 'bank_transfer', $4::payment_status, $5::payment_source,
      clock_timestamp(), $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
      CASE WHEN $4 = 'rejected' THEN 'Synthetic reason' ELSE NULL END) RETURNING id::text`,
  [l.orgId, l.property, l.id, status, source, confirmer ?? null])).rows[0].id;
}
async function ready(s: Session, extra: Parameters<typeof staffOverdueTurns>[1] = {}) {
  const r = await staffOverdueTurns(s, { ...ON, ...extra });
  assert.equal(r.state, "ready");
  if (r.state !== "ready") throw new Error("not ready");
  return r;
}
const ids = (r: Awaited<ReturnType<typeof ready>>) => r.others.map(x => x.leaseId);
async function primary(l: Lease, name = "Primary synthetic") {
  const id = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name)
    VALUES ($1, true, $2) RETURNING id::text`, [l.orgId, name])).rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')`, [l.orgId, l.id, id]);
  return id;
}

test("R5 due today/future excluded; yesterday is day 1 in each property's calendar", async () => {
  const o = await makeOrg();
  const yesterday = await lease(o); await invoice(yesterday);
  await invoice(await lease(o), { due: TODAY });
  await invoice(await lease(o), { due: date(1) });
  const r = await ready(o.staff.accountant, { now: () => new Date("2030-04-30T16:00:00Z") });
  assert.deepEqual(ids(r), [yesterday.id]);
  assert.equal(r.others[0].dayNumber, 1);
  assert.equal((await ready(o.staff.accountant, { now: () => new Date("2030-04-30T15:59:59Z") })).count, 0);
  // Same instant is still April 30 in Los Angeles; no hardcoded Taiwan calendar.
  await query("UPDATE properties SET timezone = 'America/Los_Angeles' WHERE id = $1", [o.property]);
  assert.equal((await ready(o.staff.accountant, { now: () => new Date("2030-04-30T16:00:00Z") })).count, 0);
  assert.equal((await ready(o.staff.accountant, { now: () => new Date("2030-05-01T07:00:00Z") })).others[0].dayNumber, 1);
  // Spring DST: 23 elapsed hours still cross one calendar day.
  await query("UPDATE invoices SET due_date = '2030-03-10' WHERE lease_id = $1", [yesterday.id]);
  assert.equal((await ready(o.staff.accountant, { now: () => new Date("2030-03-11T07:00:00Z") })).others[0].dayNumber, 1);
});

test("R5 all periods and several invoices sum by lease/currency; period month, primary tenant, place and partial balance", async () => {
  const o = await makeOrg(); const l = await lease(o); await primary(l);
  await invoice(l, { due: "2030-01-15", period: "2029-12-01", amount: "123456", paid: "23456", status: "partially_paid" });
  await invoice(l, { due: "2030-03-05", period: "2030-02-01", amount: "70000" });
  await invoice(l, { amount: "30000" });
  await invoice(l, { due: TODAY, amount: "999999" });
  await invoice(l, { currency: "USD", due: "2030-02-01", period: "2030-01-01", amount: "321" });
  const r = await ready(o.staff.accountant);
  assert.equal(r.count, 2);
  assert.deepEqual(r.others.map(x => [x.currency, x.amountMinor, x.oldestDueDate, x.oldestMonth, x.dayNumber]), [
    ["TWD", "200000", "2030-01-15", 12, 106], ["USD", "321", "2030-02-01", 1, 89],
  ]);
  for (const row of r.others) {
    assert.equal(row.leaseId, l.id); assert.equal(row.tenantName, "Primary synthetic");
    assert.match(row.place, /^Synthetic property U\d+ A$/); assert.equal(row.reminderCount, null);
  }
  const whole = await lease(o, "ended", true); await invoice(whole);
  // Archived space/lease is not a reason to erase collectible debt.
  await query("UPDATE units SET archived_at = now() WHERE id = $1", [whole.unit]);
  const ended = (await ready(o.staff.manager)).others.find(x => x.leaseId === whole.id)!;
  assert.equal(ended.amountMinor, "100000"); assert.equal(ended.tenantName, null);
  assert.match(ended.place, /^Synthetic property U\d+$/);
});

test("zero/paid/draft/void balances excluded; sum above MAX_SAFE_INTEGER stays an exact string", async () => {
  const o = await makeOrg();
  for (const status of ["open", "partially_paid", "paid", "draft", "void"] as const) {
    await invoice(await lease(o), { status, amount: "100", paid: status === "open" || status === "partially_paid" || status === "paid" ? "100" : "0" });
  }
  assert.deepEqual(await ready(o.staff.admin), { state: "ready", count: 0, others: [] });
  const l = await lease(o);
  // Quantity and unit price fit their numeric columns; total exceeds Number.MAX_SAFE_INTEGER.
  await invoice(l, { amount: "100000000000" });
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
    SELECT $1, id, n, 'rent', 'Synthetic precision', 100000, 100000000000, 10000000000000000
    FROM invoices CROSS JOIN generate_series(2, 3) n WHERE lease_id = $2`, [o.orgId, l.id]);
  assert.equal((await ready(o.staff.admin)).others[0].amountMinor, "20000100000000000");
});

test("R5 P2 wins over overdue on every currency and ended leases; submitted suppresses; confirmed is not suppression", async () => {
  const o = await makeOrg();
  const rejected = await lease(o, "ended"); await invoice(rejected); await invoice(rejected, { currency: "USD" });
  await pay(rejected, "rejected"); const latest = await pay(rejected, "rejected");
  await pay(rejected, "confirmed", "tenant_portal", o.staff.admin.userId);
  const pending = await lease(o); await invoice(pending); await pay(pending, "submitted"); await pay(pending, "rejected");
  const confirmed = await lease(o); await invoice(confirmed); await pay(confirmed, "confirmed", "tenant_portal", o.staff.admin.userId);
  const manual = await lease(o); await invoice(manual); await pay(manual, "submitted", "manager_entry");
  const reversed = await lease(o); await invoice(reversed); await pay(reversed, "reversed", "tenant_portal", o.staff.admin.userId);
  assert.deepEqual(ids(await ready(o.staff.accountant)).sort(), [confirmed.id, manual.id, reversed.id].sort());
  const turns = await staffPaymentTurns(o.staff.accountant, { v3: ON.v3 });
  assert.equal(turns.state, "ready");
  if (turns.state !== "ready") throw new Error("payment reader not ready");
  assert.deepEqual(turns.others.map(x => x.id), [latest]);
  assert.deepEqual(turns.mine.map(x => x.leaseId), [pending.id]);
  // Resolving the open balance clears both generic overdue and P2, without changing reports.
  await query("UPDATE invoices SET paid_minor = total_minor, status = 'paid' WHERE lease_id = $1", [rejected.id]);
  assert.ok(!ids(await ready(o.staff.manager)).includes(rejected.id));
});

test("R6 uncapped count >50, oldest due first then stable lease/currency, with stable oldest invoice tie", async () => {
  const o = await makeOrg();
  const expected: { leaseId: string; currency: string; oldestDueDate: string }[] = [];
  for (let n = 0; n < 53; n++) {
    const l = await lease(o); const due = date(-1 - n % 3);
    await invoice(l, { due }); expected.push({ leaseId: l.id, currency: "TWD", oldestDueDate: due });
    if (n === 0) { await invoice(l, { due, currency: "USD" }); expected.push({ leaseId: l.id, currency: "USD", oldestDueDate: due }); }
  }
  expected.sort((a, b) => a.oldestDueDate.localeCompare(b.oldestDueDate) || a.leaseId.localeCompare(b.leaseId) || a.currency.localeCompare(b.currency));
  const r = await ready(o.staff.admin);
  assert.equal(r.count, 54); assert.equal(r.others.length, OVERDUE_TURN_LIST_LIMIT);
  assert.deepEqual(r.others.map(({ leaseId, currency, oldestDueDate }) => ({ leaseId, currency, oldestDueDate })), expected.slice(0, 50));
  assert.deepEqual((await ready(o.staff.admin)).others, r.others);
  const other = await makeOrg(); const l = await lease(other);
  const a = await invoice(l, { period: "2030-02-01" }), b = await invoice(l, { period: "2030-03-01" });
  assert.equal((await ready(other.staff.admin)).others[0].oldestMonth, a < b ? 2 : 3);
});

test("pay.record admission: accountant allowed, maintenance/nonstaff/nonmember and suspended dual-role staff refused", async () => {
  const o = await makeOrg(); const l = await lease(o); await invoice(l);
  for (const role of ["admin", "manager", "accountant"] as const) assert.deepEqual(ids(await ready(o.staff[role])), [l.id]);
  let opened = 0;
  const counting: typeof tx = (...args) => { opened++; return tx(...args); };
  for (const s of [o.staff.maintenance, { ...o.staff.admin, kind: "tenant" as const, role: null }, { ...o.staff.admin, kind: "owner" as const, role: null }]) {
    await assert.rejects(staffOverdueTurns(s, { ...ON, transaction: counting }), denied);
  }
  assert.equal(opened, 0);
  const outsider = await user();
  await assert.rejects(staffOverdueTurns(await staffSession(outsider, o.orgId, "admin"), ON), denied);
  const contact = await primary(l);
  await query("UPDATE contacts SET user_id = $2 WHERE id = $1", [contact, o.staff.manager.userId]);
  await query("UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId]);
  assert.equal(await tx(o.staff.manager.userId, async c => (await c.query("SELECT id FROM invoices WHERE lease_id = $1", [l.id])).rowCount,
    { orgId: o.orgId, environment: "live" }), 1, "tenant policy alone still sees own invoice");
  await assert.rejects(staffOverdueTurns(o.staff.manager, ON), denied);
});

test("custom role without pay.record denied; current revision assignment allowed and authority rechecked in snapshot", async () => {
  const o = await makeOrg(); const l = await lease(o); await invoice(l);
  await query("UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.admin.userId]);
  const before = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}'::jsonb WHERE id = $1`, [o.orgId]);
    const memberId = (await query<{ id: string }>("SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.accountant.userId])).rows[0].id;
    const created = await governCustomRole(o.staff.admin, { operation: "create", grants: ["stmt.view"], requestId: randomUUID() });
    assert.ok(created.roleId); const roleId = created.roleId!;
    const assign = () => governCustomRole(o.staff.admin, { operation: "assign", roleId, memberId, requestId: randomUUID() });
    await assign();
    const never: typeof tx = async () => { assert.fail("pay.record refusal must precede transaction"); };
    await assert.rejects(staffOverdueTurns(o.staff.accountant, { ...ON, transaction: never }), denied);
    await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["pay.record"], requestId: randomUUID() });
    await assign(); // app.b017_effective honours only the current role revision.
    const granted = await staffSession(o.staff.accountant.userId, o.orgId, "accountant");
    assert.ok((await resolveCustomRoleSession(granted)).customRole?.keys?.includes("pay.record"));
    assert.deepEqual(ids(await ready(granted)), [l.id]);
    const revoked: typeof tx = async (...args) => {
      await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["stmt.view"], requestId: randomUUID() });
      await assign();
      return tx(...args);
    };
    await assert.rejects(staffOverdueTurns(granted, { ...ON, transaction: revoked }), denied);
  } finally {
    if (before === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = before;
    await query(`UPDATE organizations SET feature_flags = feature_flags - 'custom_roles' WHERE id = $1`, [o.orgId]);
  }
});

test("cross-org and wrong environment isolation; sandbox uses live-parent flags but selected sandbox data", async () => {
  const o = await makeOrg(), other = await makeOrg();
  const live = await lease(o); await invoice(live);
  const elsewhere = await lease(other); await invoice(elsewhere);
  assert.deepEqual(ids(await ready(other.staff.admin)), [elsewhere.id]);
  await assert.rejects(staffOverdueTurns({ ...other.staff.admin, orgId: o.orgId, liveOrgId: o.orgId }, ON), denied);
  const sandbox = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id)
    VALUES ('Overdue synthetic sandbox', 'TW', 'TWD', 'sandbox', $1) RETURNING id::text`, [o.orgId])).rows[0].id;
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, 'Sandbox property', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [sandbox])).rows[0].id;
  const sb = await lease({ ...o, orgId: sandbox, property }); await invoice(sb);
  await query("INSERT INTO sample_marks (org_id, entity_table, entity_id) VALUES ($1, 'leases', $2)", [sandbox, sb.id]);
  assert.deepEqual(ids(await ready(o.staff.admin)), [live.id]);
  assert.deepEqual(ids(await ready({ ...o.staff.admin, orgId: sandbox, environment: "sandbox" })), [sb.id]);
  for (const s of [{ ...o.staff.admin, orgId: sandbox, environment: "live" as const }, { ...o.staff.admin, environment: "sandbox" as const }]) {
    // A session whose org and environment disagree never yields data: either the item gate (read for the
    // session's own org) is off, or admission/RLS refuses. It must never be "ready".
    const outcome = await staffOverdueTurns(s, ON).then(r => r.state, (e: unknown) => (e as { key?: string })?.key);
    assert.ok(outcome === "off" || outcome === "errors.forbidden", `mismatched session: ${outcome}`);
    const params = [s.orgId, ON.now().toISOString(), s.environment];
    const result = await tx(s.userId, async c => (await c.query(LISTS_SQL_FOR_TEST, [...params, 50])).rows,
      { orgId: s.orgId, environment: s.environment });
    assert.deepEqual(result, [], "RLS denies wrong-environment SQL even without reader guard");
  }
  const sbOnly = await user();
  await query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')", [sandbox, sbOnly]);
  await assert.rejects(staffOverdueTurns(await staffSession(sbOnly, o.orgId, "admin"), ON), denied);
});

test("live sample exclusions cover invoice, lease, property, unit, room and tenant name", async () => {
  for (const table of ["invoices", "leases", "properties", "units", "rooms", "contacts"] as const) {
    const o = await makeOrg(); const l = await lease(o); const inv = await invoice(l); const contact = await primary(l);
    const id = { invoices: inv, leases: l.id, properties: l.property, units: l.unit, rooms: l.room, contacts: contact }[table];
    await query("INSERT INTO sample_marks (org_id, entity_table, entity_id) VALUES ($1, $2, $3)", [o.orgId, table, id]);
    const r = await ready(o.staff.admin);
    if (table === "contacts") { assert.equal(r.count, 1); assert.equal(r.others[0].tenantName, null); }
    else assert.deepEqual(r, { state: "ready", count: 0, others: [] }, table);
  }
});

test("SQL-level anon and nonmember denial; authenticated, read-only repeatable-read execution", async () => {
  const o = await makeOrg(), other = await makeOrg(); await invoice(await lease(o));
  const params = [o.orgId, ON.now().toISOString(), "live"];
  const outsider = await user();
  for (const sql of [COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST]) {
    const args = sql === LISTS_SQL_FOR_TEST ? [...params, 50] : params;
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query(sql, args), (e: unknown) => (e as { code?: string }).code === "42501");
    } finally { await db.query("ROLLBACK"); }
    for (const [userId, pin] of [[outsider, o.orgId], [other.staff.admin.userId, other.orgId]]) {
      const rows = await tx(userId, async c => (await c.query(sql, args)).rows, { orgId: pin, environment: "live" });
      assert.deepEqual(rows, sql === COUNTS_SQL_FOR_TEST ? [{ count: 0 }] : []);
    }
  }
  const probe: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    assert.equal((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    assert.equal((await c.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
    assert.equal((await c.query("SELECT current_user AS role")).rows[0].role, "authenticated");
    return fn(c);
  }, scope, opts);
  await ready(o.staff.accountant, { transaction: probe });
});

test("reminder fallback: success/all-failed fixtures both remain unknown because authenticated SELECT is revoked", async () => {
  const o = await makeOrg(); const l = await lease(o); const inv = await invoice(l);
  // Direct synthetic fixtures, no enqueue helper, transport, job, or provider invocation.
  // These statuses illustrate why counting source events alone would be incorrect. This
  // tests the authorized null fallback, NOT a success aggregation that RLS cannot supply.
  for (const statuses of [["accepted", "failed"], ["failed", "failed"]]) {
    const event = (await db.query(`INSERT INTO app.b010_source_events
      (org_id, lease_id, invoice_id, kind, occurrence_key, local_date)
      VALUES ($1, $2, $3, 'rent_overdue', $4, $5) RETURNING id`, [o.orgId, l.id, inv, randomUUID(), TODAY])).rows[0].id;
    for (const [n, status] of statuses.entries()) {
      await db.query(`INSERT INTO app.b028_delivery_attempts (org_id, source_kind, source_id, recipient_key, channel, status)
        VALUES ($1, 'overdue_test', $2, 'synthetic', $3, $4)`, [o.orgId, event, n === 0 ? "email" : "line", status]);
    }
  }
  for (const table of ["b010_source_events", "b028_recipient_claims", "b028_delivery_attempts", "b028_delivery_attempt_events"]) {
    await db.query("BEGIN");
    try {
      await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('app.active_org_id', $2, true), set_config('app.env', 'live', true)`, [o.staff.accountant.userId, o.orgId]);
      await db.query("SET LOCAL ROLE authenticated");
      await assert.rejects(db.query(`SELECT * FROM app.${table} WHERE org_id = $1`, [o.orgId]),
        (e: unknown) => (e as { code?: string }).code === "42501");
    } finally { await db.query("ROLLBACK"); }
  }
  const acl = (await db.query(`SELECT
    has_function_privilege('authenticated', 'app.b028_delivery_status(uuid,text,uuid)', 'EXECUTE') AS delivery,
    has_function_privilege('authenticated', 'app.b010_manual_status(uuid,uuid,text,uuid,uuid,uuid)', 'EXECUTE') AS manual`)).rows[0];
  assert.deepEqual(acl, { delivery: false, manual: false }, "status helpers cannot bypass the revoked tables");
  assert.equal((await ready(o.staff.accountant)).others[0].reminderCount, null);
});

test("flag matrix: real brand OFF, today_home/dash org and global gates OFF prevent business tx", async () => {
  const o = await makeOrg(); await invoice(await lease(o));
  let opened = 0;
  const counting: typeof tx = (...args) => { opened++; return tx(...args); };
  assert.deepEqual(await staffOverdueTurns(o.staff.admin, { transaction: counting }), { state: "off" });
  assert.equal(opened, 0);
  for (const key of ["today_home", "today_dash"]) {
    for (const value of [false, "true"]) {
      await query("UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1", [o.orgId, key, JSON.stringify(value)]);
      assert.deepEqual(await staffOverdueTurns(o.staff.admin, { ...ON, transaction: counting }), { state: "off" });
    }
    await query("UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object($2::text, true) WHERE id = $1", [o.orgId, key]);
    const saved = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0].value;
    try {
      for (const value of [{ enabled: false, allowed_org_ids: [o.orgId] }, { enabled: true, allowed_org_ids: [] }, { enabled: true, allowed_org_ids: [o.orgId, 1] }]) {
        await query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
        assert.deepEqual(await staffOverdueTurns(o.staff.admin, { ...ON, transaction: counting }), { state: "off" });
      }
    } finally { await query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(saved)]); }
  }
  assert.equal(opened, 0);
  assert.equal((await ready(o.staff.admin, { transaction: counting })).count, 1); assert.equal(opened, 1);
});

test("one snapshot: submitted report between count and list only suppresses on the next read", async () => {
  const o = await makeOrg(); const l = await lease(o); await invoice(l);
  let resolved = false;
  const interleaved: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await run(...args);
      if (args[0] === COUNTS_SQL_FOR_TEST) {
        assert.deepEqual(result.rows, [{ count: 1 }]); await pay(l, "submitted"); resolved = true;
      }
      return result;
    };
    return fn(c);
  }, scope, opts);
  const r = await ready(o.staff.accountant, { transaction: interleaved });
  assert.ok(resolved); assert.equal(r.count, 1); assert.deepEqual(ids(r), [l.id]);
  assert.deepEqual(await ready(o.staff.accountant), { state: "ready", count: 0, others: [] });
});

test("invalid period or property timezone is unavailable; real timeout after counts never leaks partial totals", async () => {
  const o = await makeOrg(); const l = await lease(o); const inv = await invoice(l, { period: null });
  assert.deepEqual(await staffOverdueTurns(o.staff.admin, ON), { state: "unavailable" });
  await query("UPDATE invoices SET period_start = '2030-04-01' WHERE id = $1", [inv]);
  await query("UPDATE properties SET timezone = 'Not/AZone' WHERE id = $1", [o.property]);
  assert.deepEqual(await staffOverdueTurns(o.staff.admin, ON), { state: "unavailable" });
  await query("UPDATE properties SET timezone = 'Asia/Taipei' WHERE id = $1", [o.property]);
  let counted = false; let code: string | undefined;
  const slow: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      if (args[0] === LISTS_SQL_FOR_TEST) {
        assert.ok(counted);
        try { await run("SELECT pg_sleep(30)"); } catch (e) { code = (e as { code?: string }).code; throw e; }
      }
      const result = await run(...args);
      if (args[0] === COUNTS_SQL_FOR_TEST) { assert.deepEqual(result.rows, [{ count: 1 }]); counted = true; }
      return result;
    };
    return fn(c);
  }, scope, opts);
  assert.deepEqual(await staffOverdueTurns(o.staff.admin, { ...ON, transaction: slow }), { state: "unavailable" });
  assert.equal(code, "57014");
});
