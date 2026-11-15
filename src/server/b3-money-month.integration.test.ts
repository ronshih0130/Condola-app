import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { BILLS_LIST_SQL_FOR_TEST, BILLS_SUMMARY_SQL_FOR_TEST, REPORTS_LIST_SQL_FOR_TEST, REPORTS_SUMMARY_SQL_FOR_TEST,
  moneyMonthBills, moneyMonthReports, type MoneyMonthStatus } from "./b3-money-month";
import { governCustomRole, resolveCustomRoleSession } from "./b017-custom-role-governance";
import { staffPaymentTurns } from "./b3-payment-turns";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Synthetic fixtures only. No provider, notification, queue or domain write helper is invoked.
// Run against the Mac's fully migrated disposable PostgreSQL database, never staging/production.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const MONTH = "2030-05";
const ON = { v3: async () => true, now: () => new Date("2030-05-01T12:00:00Z") };
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
let savedSetting: unknown;
let db: Client;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  savedSetting = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'custom_roles'")).rows[0]?.value;
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
});
test.after(async () => {
  try {
    if (savedSetting === undefined) await query("DELETE FROM platform_settings WHERE key = 'custom_roles'");
    else await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', $1::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(savedSetting)]);
  } finally {
    if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom;
    await db?.end();
  }
});

type Role = "admin" | "manager" | "accountant" | "maintenance";
type Org = { orgId: string; property: string; currency: string; staff: Record<Role, Session> };
async function user() {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
    VALUES ($1, $2, '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [id, `${id}@example.test`]);
  return id;
}
async function session(userId: string, orgId: string, role: Role): Promise<Session> {
  const sessionId = randomUUID();
  await query(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId, liveOrgId: orgId, environment: "live", kind: "staff", role,
    locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
}
async function property(orgId: string, currency = "TWD") {
  return (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, 'Money month synthetic', 'TW', $2, 'Asia/Taipei') RETURNING id::text`, [orgId, currency])).rows[0].id;
}
async function org(): Promise<Org> {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, timezone)
    VALUES ('Money month synthetic', 'TW', 'TWD', 'UTC') RETURNING id::text`)).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user();
    await query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')", [orgId, id, role]);
    staff[role] = await session(id, orgId, role);
  }
  return { orgId, property: await property(orgId), currency: "TWD", staff };
}
let sequence = 0;
async function lease(o: Org, status: "active" | "pending_signature" | "ended" | "terminated" = "active", whole = false) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode)
    VALUES ($1, $2, $3, $4::rental_mode) RETURNING id::text`, [o.orgId, o.property, `U${sequence++}`, whole ? "whole_unit" : "by_room"])).rows[0].id;
  const room = whole ? null : (await query<{ id: string }>("INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'A') RETURNING id::text", [o.orgId, unit])).rows[0].id;
  const id = (await query<{ id: string }>(`INSERT INTO leases
    (org_id, property_id, unit_id, target_room_id, target_unit_id, status, esign_status, start_date, end_date, currency, rent_amount_minor)
    VALUES ($1, $2, $3, $4, $5, $6::lease_status, 'imported', '2029-01-01', '2030-12-31', $7, 0) RETURNING id::text`,
  [o.orgId, o.property, unit, room, whole ? unit : null, status, o.currency])).rows[0].id;
  return { id, unit, room, orgId: o.orgId, property: o.property, currency: o.currency, admin: o.staff.admin.userId };
}
type Lease = Awaited<ReturnType<typeof lease>>;
async function primary(l: Lease, userId?: string) {
  const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, is_tenant, display_name)
    VALUES ($1, $2, true, 'Synthetic tenant') RETURNING id::text`, [l.orgId, userId ?? null])).rows[0].id;
  await query("INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')", [l.orgId, l.id, contact]);
  return contact;
}
async function invoice(l: Lease, opts: { month?: string; due?: string; amount?: string; currency?: string;
  status?: "open" | "draft" | "void" | "written_off"; period?: string | null } = {}) {
  const id = (await query<{ id: string }>(`INSERT INTO invoices
    (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'open') RETURNING id::text`,
  [l.orgId, l.property, l.id, randomUUID(), opts.currency ?? l.currency, opts.due ?? "2030-05-01",
    opts.period === undefined ? `${opts.month ?? MONTH}-01` : opts.period])).rows[0].id;
  const amount = opts.amount ?? "1000";
  // Large-integer fixture stays within unit_amount_minor numeric(18,6), while quantity × price
  // still exactly equals amount_minor. The invoice reader must preserve the bigint total.
  const quantity = BigInt(amount) > BigInt("999999999999") ? 10000 : 1;
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
    VALUES ($1, $2, 1, 'rent', 'Synthetic rent', $4, $3::numeric / $4::numeric, $3::bigint)`, [l.orgId, id, amount, quantity]);
  if (opts.status) await query(`UPDATE invoices SET status = $2::invoice_status,
    void_reason = CASE WHEN $2 = 'void' THEN 'Synthetic void' ELSE NULL END WHERE id = $1`, [id, opts.status]);
  return id;
}
async function pay(l: Lease, opts: { status?: "submitted" | "confirmed" | "rejected" | "reversed"; source?: string;
  amount?: string; at?: string; paidOn?: string; contact?: string; reference?: string } = {}) {
  const status = opts.status ?? "submitted";
  return (await query<{ id: string }>(`INSERT INTO payments
    (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source,
     submitted_by, submitted_at, confirmed_by, confirmed_at, rejected_reason, reference)
    VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, 'bank_transfer', $8::payment_status, $9::payment_source,
      $10, $11::timestamptz, $12, CASE WHEN $12::uuid IS NULL THEN NULL ELSE $11::timestamptz END, $13, $14) RETURNING id::text`,
  [l.orgId, l.property, l.id, opts.contact ?? null, l.currency, opts.amount ?? "1000", opts.paidOn ?? "2029-12-01",
    status, opts.source ?? "tenant_portal", l.admin, opts.at ?? "2030-04-15T00:00:00.123456Z",
    status === "confirmed" || status === "reversed" ? l.admin : null, status === "rejected" ? "Synthetic" : null, opts.reference ?? null])).rows[0].id;
}
const allocate = (l: Lease, payment: string, inv: string, amount = "1000") => query(
  "INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor) VALUES ($1, $2, $3, $4::bigint)", [l.orgId, payment, inv, amount]);
async function settle(l: Lease, inv: string, amount = "1000") {
  const p = await pay(l, { status: "confirmed", amount }); await allocate(l, p, inv, amount); return p;
}
async function bills(s: Session, input: Parameters<typeof moneyMonthBills>[1] = { month: MONTH }, deps: Parameters<typeof moneyMonthBills>[2] = ON) {
  const out = await moneyMonthBills(s, input, deps); assert.equal(out.state, "ready");
  if (out.state !== "ready") throw new Error("bill reader not ready"); return out;
}
async function reports(s: Session, input: Parameters<typeof moneyMonthReports>[1] = { month: MONTH }, deps: Parameters<typeof moneyMonthReports>[2] = ON) {
  const out = await moneyMonthReports(s, input, deps); assert.equal(out.state, "ready");
  if (out.state !== "ready") throw new Error("report reader not ready"); return out;
}
const ids = (xs: { id: string }[]) => xs.map(x => x.id);

test("rules 1–2: all five statuses, paid wins over report, partial remaining, earliest unpaid invoice due date", async () => {
  const o = await org();
  const expected = new Map<string, { status: MoneyMonthStatus; total: string; confirmed: string; remaining: string }>();
  for (const [kind, due] of [["paid", "2030-04-30"], ["reported", "2030-04-30"], ["overdue", "2030-04-30"],
    ["due_today", "2030-05-01"], ["future", "2030-05-02"]] as const) {
    const l = await lease(o); const inv = await invoice(l, { due }); await primary(l);
    const confirmed = kind === "paid" ? "1000" : "200";
    await settle(l, inv, confirmed);
    if (kind === "paid" || kind === "reported") { const p = await pay(l); await allocate(l, p, inv); }
    expected.set(l.id, { status: kind, total: "1000", confirmed, remaining: kind === "paid" ? "0" : "800" });
  }
  const r = await bills(o.staff.accountant);
  assert.deepEqual(r.counts, { all: 5, paid: 1, reported: 1, overdue: 1, due_today: 1, future: 1 });
  for (const row of r.rows) {
    assert.deepEqual({ status: row.status, total: row.totalMinor, confirmed: row.confirmedMinor, remaining: row.remainingMinor }, expected.get(row.leaseId));
    assert.equal(row.tenantName, "Synthetic tenant");
  }
  assert.deepEqual(r.totals, [{ currency: "TWD", totalMinor: "5000", confirmedMinor: "1800", billedRows: 5, paidRows: 1 }]);
  assert.equal((await reports(o.staff.accountant)).yourTurn, 2, "pending report on paid row still needs confirmation");
  const l = await lease(o); const old = await invoice(l, { due: "2030-04-20" }); await settle(l, old);
  await invoice(l, { due: "2030-05-02", amount: "500" });
  const combined = (await bills(o.staff.admin)).rows.find(x => x.leaseId === l.id)!;
  assert.deepEqual([combined.totalMinor, combined.confirmedMinor, combined.remainingMinor, combined.dueDate, combined.status],
    ["1500", "1000", "500", "2030-05-02", "future"]);
});

test("organization calendar, not property/server calendar: yesterday/today/tomorrow around local midnight", async () => {
  const o = await org(); await query("UPDATE organizations SET timezone = 'America/Los_Angeles' WHERE id = $1", [o.orgId]);
  for (const due of ["2030-04-29", "2030-04-30", "2030-05-01"]) await invoice(await lease(o), { due });
  const r = await bills(o.staff.admin, { month: MONTH }, { ...ON, now: () => new Date("2030-05-01T00:30:00Z") });
  assert.equal(r.today, "2030-04-30"); assert.equal(r.timezone, "America/Los_Angeles");
  assert.deepEqual(r.rows.map(x => x.status), ["overdue", "due_today", "future"]);
});

test("rules 5–6/8: selected invoice period, all charge types, 3a denominator, currencies, no cash-date attribution", async () => {
  const o = await org(); const l = await lease(o, "pending_signature", true);
  const april = await invoice(l, { period: "2030-04-30", amount: "700" });
  const may = await invoice(l, { period: "2030-05-01", amount: "1000" });
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor)
    VALUES ($1, $2, 2, 'utility', 'Synthetic utilities', 300, 300), ($1, $2, 3, 'credit', 'Synthetic credit', -50, -50)`, [o.orgId, may]);
  const p = await pay(l, { status: "confirmed", amount: "1950", paidOn: "2030-06-15" });
  await allocate(l, p, april, "700"); await allocate(l, p, may, "1250");
  const usd = await lease({ ...o, property: await property(o.orgId, "USD"), currency: "USD" });
  const usBill = await invoice(usd, { amount: "9007199254740993" }); await settle(usd, usBill, "1");
  for (const opts of [{ amount: "0" }, { status: "draft" as const }, { status: "void" as const }, { period: null }]) await invoice(await lease(o), opts);
  const r = await bills(o.staff.admin);
  assert.equal(r.counts.all, 2); assert.equal(r.counts.paid, 1);
  assert.deepEqual(r.totals, [
    { currency: "TWD", totalMinor: "1250", confirmedMinor: "1250", billedRows: 1, paidRows: 1 },
    { currency: "USD", totalMinor: "9007199254740993", confirmedMinor: "1", billedRows: 1, paidRows: 0 },
  ]);
  const prev = await bills(o.staff.admin, { month: "2030-04" });
  assert.deepEqual(prev.rows.map(x => [x.leaseId, x.totalMinor, x.confirmedMinor]), [[l.id, "700", "700"]]);
  const next = await bills(o.staff.admin, { month: "2030-06" });
  assert.equal(next.counts.all, 0); assert.deepEqual(next.totals, []); assert.deepEqual(next.rows, []);
  // Formula equivalence with stored rent-roll sources for precisely the two eligible invoices.
  const stored = (await query(`SELECT currency::text, sum(total_minor)::text AS due, sum(paid_minor)::text AS paid
    FROM invoices WHERE id = ANY($1::uuid[]) GROUP BY currency ORDER BY currency`, [[may, usBill]])).rows;
  assert.deepEqual(r.totals.map(t => [t.currency, t.totalMinor, t.confirmedMinor]), stored.map(t => [t.currency, t.due, t.paid]));
});

test("rule 8 preserves rent-roll population in both months; rule 9 outstanding counts leases across all periods", async () => {
  const o = await org(); const tenant = await user();
  const active = await lease(o), pending = await lease(o, "pending_signature", true);
  const ended = await lease(o, "ended"), terminated = await lease(o, "terminated");
  const archived = await lease({ ...o, property: await property(o.orgId) });
  const archivedRoom = await lease(o), archivedUnit = await lease(o, "active", true);
  const contact = await primary(active, tenant);
  await query("INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')", [o.orgId, pending.id, contact]); // same person, two leases
  for (const l of [active, pending, ended, terminated, archived, archivedRoom, archivedUnit]) {
    await invoice(l); await invoice(l, { month: "2030-04" });
  }
  await query("UPDATE properties SET archived_at = now() WHERE id = $1", [archived.property]);
  await query("UPDATE rooms SET archived_at = now() WHERE id = $1", [archivedRoom.room]);
  await query("UPDATE units SET archived_at = now() WHERE id = $1", [archivedUnit.unit]);
  const vacant = await lease(o); // space with no bill never enters the denominator
  for (const month of [MONTH, "2030-04"]) {
    const r = await bills(o.staff.admin, { month });
    assert.deepEqual(r.rows.map(x => x.leaseId).sort(), [active.id, pending.id, archivedUnit.id].sort());
    assert.equal(r.population, "rent_roll_active_unarchived"); assert.ok(!r.rows.some(x => x.leaseId === vacant.id));
    assert.equal(r.outstanding.leaseCount, 7, "dashboard counts leases, including ended/archive, not distinct people");
    assert.deepEqual(r.outstanding.currencies, [{ currency: "TWD", amountMinor: "14000", leaseCount: 7 }]);
  }
  assert.equal((await bills(o.staff.admin, { month: "2030-06" })).outstanding.leaseCount, 7);
});

test("written-off remains rent-roll nonvoid data; zero open balance alone cannot make it paid", async () => {
  const o = await org(); const l = await lease(o); await invoice(l, { status: "written_off", due: "2030-04-30" });
  const r = await bills(o.staff.admin);
  assert.equal(r.rows[0].status, "overdue"); assert.equal(r.rows[0].confirmedMinor, "0"); assert.equal(r.counts.paid, 0);
  assert.equal(r.outstanding.leaseCount, 0, "dashboard excludes written_off");
});

test("rules 3–7: allocation beats oldest unpaid; cross-month allocation dedupes; every report oldest first; other stays separate", async () => {
  const o = await org(); const l = await lease(o);
  const april = await invoice(l, { month: "2030-04", due: "2030-04-01" });
  const may = await invoice(l, { due: "2030-05-01" });
  const may2 = await invoice(l, { due: "2030-05-02" });
  const explicit = await pay(l, { at: "2030-04-10T00:00:00.000002Z" }); await allocate(l, explicit, may);
  const fallback = await pay(l, { at: "2030-04-10T00:00:00.000001Z", reference: may }); // free text must NOT nominate May
  const spanning = await pay(l, { amount: "1500", at: "2030-04-09T00:00:00.000001Z" });
  await allocate(l, spanning, april, "500"); await allocate(l, spanning, may, "500"); await allocate(l, spanning, may2, "500");
  const another = await pay(l, { at: "2030-04-11T00:00:00.000001Z" }); await allocate(l, another, may2);
  const noBill = await lease(o); const other = await pay(noBill, { amount: "99", paidOn: "2028-01-01" });
  await pay(l, { status: "rejected" }); await pay(l, { status: "reversed" }); await pay(l, { status: "confirmed" });
  await pay(l, { source: "manager_entry" }); await pay(l, { source: "bank_import" });
  const r = await reports(o.staff.accountant);
  assert.equal(r.yourTurn, 4); assert.equal(r.attachedCount, 3); assert.equal(r.otherCount, 1);
  assert.deepEqual(ids(r.attached), [spanning, explicit, another]); assert.deepEqual(ids(r.other), [other]);
  assert.deepEqual(r.attached[0].billRows, [{ leaseId: l.id, month: "2030-04" }, { leaseId: l.id, month: MONTH }]);
  assert.equal(r.attached[0].attachment, "allocation");
  assert.ok(r.attached.every(x => x.source === "tenant_portal" && x.bankTransactionId === null));
  assert.equal((await bills(o.staff.admin)).counts.all, 1, "two invoices one bill; other report is not a bill");
  assert.equal((await bills(o.staff.admin)).counts.reported, 1);
  const prev = await reports(o.staff.admin, { month: "2030-04" });
  assert.deepEqual(ids(prev.attached), [spanning, fallback]); assert.equal(prev.attached[1].attachment, "oldest_unpaid");
  const next = await reports(o.staff.admin, { month: "2030-06" });
  assert.deepEqual(ids(next.other), [other]); assert.deepEqual(next.attached, [], "navigation never retargets attached reports");
  const turns = await staffPaymentTurns(o.staff.admin, ON); assert.equal(turns.state, "ready");
  if (turns.state === "ready") assert.equal(turns.yourTurn, 5, "shared P1 has identical organization-wide eligibility");
});

test("no unpaid match, paid explicit target, and allocation to excluded bill do not silently target a different invoice", async () => {
  const o = await org(); const l = await lease(o); const inv = await invoice(l); await settle(l, inv);
  const other = await pay(l);
  const paidExplicit = await pay(l); await allocate(l, paidExplicit, inv);
  const x = await lease(o); await invoice(x);
  const excluded = await invoice(x, { status: "draft" }); const excludedReport = await pay(x); await allocate(x, excludedReport, excluded);
  const r = await reports(o.staff.admin);
  assert.deepEqual(ids(r.other).sort(), [other, excludedReport].sort()); assert.deepEqual(ids(r.attached), [paidExplicit]);
  const b = await bills(o.staff.admin);
  assert.equal(b.rows.find(row => row.leaseId === l.id)?.status, "paid");
  assert.equal(b.rows.find(row => row.leaseId === x.id)?.status, "due_today");
});

test("rule 5 confirmation moves previously unmatched money to actual invoice month, regardless of paid date", async () => {
  const o = await org(); const l = await lease(o); const p = await pay(l, { paidOn: "2029-01-01" });
  assert.deepEqual(ids((await reports(o.staff.admin)).other), [p]);
  const june = await invoice(l, { month: "2030-06" }); await allocate(l, p, june);
  await query("UPDATE payments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1", [p, l.admin]);
  assert.equal((await reports(o.staff.admin)).yourTurn, 0);
  assert.equal((await bills(o.staff.admin)).counts.all, 0);
  const r = await bills(o.staff.admin, { month: "2030-06" }); assert.equal(r.rows[0].confirmedMinor, "1000"); assert.equal(r.counts.paid, 1);
});

test("uncapped >50 bills and reports, status filters, deterministic cursors and complete duplicate-free traversal", async () => {
  const o = await org();
  for (let n = 0; n < 57; n++) await invoice(await lease(o), { due: n < 53 ? "2030-05-01" : "2030-05-02" });
  const first = await bills(o.staff.admin, { month: MONTH, status: "due_today" });
  assert.equal(first.rows.length, 50); assert.equal(first.counts.all, 57); assert.equal(first.filteredCount, 53); assert.ok(first.nextCursor);
  const second = await bills(o.staff.admin, { month: MONTH, status: "due_today", cursor: first.nextCursor });
  assert.equal(second.rows.length, 3); assert.equal(second.nextCursor, null); assert.deepEqual(second.totals, first.totals);
  assert.equal(new Set([...first.rows, ...second.rows].map(x => x.leaseId)).size, 53);
  const l = await lease(o); const inv = await invoice(l);
  // Equal timestamps deliberately force UUID tie-breaking. Several reports on the same row.
  for (let n = 0; n < 56; n++) { const p = await pay(l); await allocate(l, p, inv); }
  const otherLease = await lease(o); for (let n = 0; n < 3; n++) await pay(otherLease);
  const p1 = await reports(o.staff.admin); assert.equal(p1.yourTurn, 59); assert.equal(p1.otherCount, 3); assert.equal(p1.attachedCount, 56);
  assert.equal(p1.attached.length + p1.other.length, 50); assert.equal(p1.other.length, 3); assert.ok(p1.nextCursor);
  const p2 = await reports(o.staff.admin, { month: MONTH, cursor: p1.nextCursor });
  assert.equal(p2.attached.length, 9); assert.equal(p2.nextCursor, null); assert.equal(p2.yourTurn, 59);
  const all = [...p1.attached, ...p2.attached]; assert.equal(new Set(ids(all)).size, 56);
  assert.deepEqual(ids(all), ids(all).sort(), "same submitted_at sorts by UUID across page boundary");
});

test("accountant permitted; maintenance/tenant/owner denied; removed, suspended and nonmember sessions cannot use tenant RLS", async () => {
  const o = await org(); const l = await lease(o); await invoice(l); await pay(l);
  for (const role of ["admin", "manager", "accountant"] as const) {
    assert.equal((await bills(o.staff[role])).counts.all, 1); assert.equal((await reports(o.staff[role])).yourTurn, 1);
  }
  const never: typeof tx = async () => { assert.fail("denied before transaction"); };
  for (const s of [o.staff.maintenance, { ...o.staff.admin, kind: "tenant" as const, role: null }, { ...o.staff.admin, kind: "owner" as const, role: null }]) {
    await assert.rejects(moneyMonthBills(s, { month: MONTH }, { ...ON, transaction: never }), denied);
    await assert.rejects(moneyMonthReports(s, { month: MONTH }, { ...ON, transaction: never }), denied);
  }
  await primary(l, o.staff.manager.userId);
  await query("UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId]);
  const visible = await tx(o.staff.manager.userId, async c => (await c.query("SELECT id FROM invoices WHERE lease_id = $1", [l.id])).rows, { orgId: o.orgId, environment: "live" });
  assert.equal(visible.length, 1, "still a tenant, so a current staff fence is essential");
  for (const reader of [moneyMonthBills, moneyMonthReports]) await assert.rejects(reader(o.staff.manager, { month: MONTH }, ON), denied);
  await query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId]);
  const outsider = await session(await user(), o.orgId, "admin");
  for (const reader of [moneyMonthBills, moneyMonthReports]) {
    await assert.rejects(reader(o.staff.manager, { month: MONTH }, ON), denied);
    await assert.rejects(reader(outsider, { month: MONTH }, ON), denied);
  }
});

test("custom keys stay separate; reassignment after revision and in-snapshot revocation fence both readers", async () => {
  const o = await org(); const l = await lease(o); await invoice(l); await pay(l);
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
    const revise = async (grants: string[]) => {
      await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants, requestId: randomUUID() });
      await assign(); // app.b017_effective honours only current revision assignments.
      return session(o.staff.accountant.userId, o.orgId, "accountant");
    };
    await assign();
    const never: typeof tx = async () => { assert.fail("missing custom key before business tx"); };
    assert.equal((await bills(o.staff.accountant)).counts.all, 1);
    await assert.rejects(moneyMonthReports(o.staff.accountant, { month: MONTH }, { ...ON, transaction: never }), denied);
    const payOnly = await revise(["pay.record"]);
    assert.ok((await resolveCustomRoleSession(payOnly)).customRole?.keys?.includes("pay.record"));
    assert.equal((await reports(payOnly)).yourTurn, 1);
    await assert.rejects(moneyMonthBills(payOnly, { month: MONTH }, { ...ON, transaction: never }), denied);
    for (const [reader, removed] of [[moneyMonthBills, "stmt.view"], [moneyMonthReports, "pay.record"]] as const) {
      const both = await revise(["stmt.view", "pay.record"]);
      const revoked: typeof tx = async (...args) => {
        await revise(removed === "stmt.view" ? ["pay.record"] : ["stmt.view"]);
        return tx(...args);
      };
      await assert.rejects(reader(both, { month: MONTH }, { ...ON, transaction: revoked }), denied);
    }
  } finally {
    if (before === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = before;
    await query("UPDATE organizations SET feature_flags = feature_flags - 'custom_roles' WHERE id = $1", [o.orgId]);
  }
});

const sqls = [BILLS_SUMMARY_SQL_FOR_TEST, BILLS_LIST_SQL_FOR_TEST, REPORTS_SUMMARY_SQL_FOR_TEST, REPORTS_LIST_SQL_FOR_TEST];
function sqlParams(sql: string, orgId: string): unknown[] {
  const base: unknown[] = [orgId, `${MONTH}-01`, ON.now().toISOString()];
  return sql === BILLS_LIST_SQL_FOR_TEST || sql === REPORTS_LIST_SQL_FOR_TEST ? [...base, null, null, null, 51] : base;
}
function noBusinessRows(sql: string, rows: Record<string, unknown>[]) {
  if (sql === REPORTS_SUMMARY_SQL_FOR_TEST) assert.deepEqual(rows, [{ count: 0, attached: 0, other: 0, invalid_currencies: 0 }]);
  else if (sql === BILLS_SUMMARY_SQL_FOR_TEST && rows.length) {
    assert.equal(rows[0].all_count, 0); assert.deepEqual(rows[0].totals, []); assert.equal(rows[0].owing, 0); assert.deepEqual(rows[0].outstanding, []);
  } else assert.deepEqual(rows, []);
}

test("actual business SQL: anon denied; nonmember, cross-org, wrong environment read no data without wrapper guards", async () => {
  const o = await org(), other = await org(); const l = await lease(o); await invoice(l); await pay(l);
  const outsider = await user();
  for (const sql of sqls) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query(sql, sqlParams(sql, o.orgId)), (e: unknown) => (e as { code?: string }).code === "42501");
    } finally { await db.query("ROLLBACK"); }
    for (const [userId, pin, env] of [[outsider, o.orgId, "live"], [other.staff.admin.userId, other.orgId, "live"],
      [o.staff.admin.userId, o.orgId, "sandbox"]] as const) {
      const rows = await tx(userId, async c => (await c.query(sql, sqlParams(sql, o.orgId))).rows, { orgId: pin, environment: env });
      noBusinessRows(sql, rows);
    }
  }
  for (const reader of [moneyMonthBills, moneyMonthReports]) {
    await assert.rejects(reader({ ...other.staff.admin, orgId: o.orgId, liveOrgId: o.orgId }, { month: MONTH }, ON), denied);
    await assert.rejects(reader({ ...o.staff.admin, environment: "sandbox" }, { month: MONTH }, ON), denied);
  }
});

test("live/sandbox separation and sandbox-only member cannot reach live parent", async () => {
  const o = await org(); const live = await lease(o); await invoice(live); const liveReport = await pay(live);
  const sb = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id)
    VALUES ('Money month sandbox', 'TW', 'TWD', 'sandbox', $1) RETURNING id::text`, [o.orgId])).rows[0].id;
  const sbLease = await lease({ ...o, orgId: sb, property: await property(sb) }); await invoice(sbLease); const sbReport = await pay(sbLease);
  const admin = { ...o.staff.admin, orgId: sb, environment: "sandbox" as const };
  assert.deepEqual((await bills(admin)).rows.map(x => x.leaseId), [sbLease.id]);
  assert.deepEqual(ids((await reports(admin)).attached), [sbReport]);
  assert.deepEqual((await bills(o.staff.admin)).rows.map(x => x.leaseId), [live.id]);
  assert.deepEqual(ids((await reports(o.staff.admin)).attached), [liveReport]);
  const sbOnly = await user(); await query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')", [sb, sbOnly]);
  for (const reader of [moneyMonthBills, moneyMonthReports]) {
    await assert.rejects(reader({ ...admin, environment: "live" }, { month: MONTH }, ON), denied);
    await assert.rejects(reader(await session(sbOnly, o.orgId, "admin"), { month: MONTH }, ON), denied);
  }
});

test("one native-accountant snapshot for summary and list, read-only enforcement and timeout failure after counts", async () => {
  const o = await org(); const l = await lease(o); const inv = await invoice(l); const pending = await pay(l);
  const racing: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    assert.deepEqual(opts, { isolation: "repeatable read", readOnly: true });
    assert.equal((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    assert.equal((await c.query("SELECT current_user AS role")).rows[0].role, "authenticated");
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await run(...args);
      if (args[0] === BILLS_SUMMARY_SQL_FOR_TEST || args[0] === REPORTS_SUMMARY_SQL_FOR_TEST) {
        await query("UPDATE payments SET status = 'rejected', rejected_reason = 'Synthetic race' WHERE id = $1", [pending]);
      }
      return result;
    };
    return fn(c);
  }, scope, opts);
  const b = await bills(o.staff.accountant, { month: MONTH }, { ...ON, transaction: racing });
  assert.equal(b.counts.reported, 1); assert.equal(b.rows[0].status, "reported");
  assert.equal((await bills(o.staff.accountant)).counts.reported, 0);
  await query("UPDATE payments SET status = 'submitted' WHERE id = $1", [pending]);
  const p = await reports(o.staff.accountant, { month: MONTH }, { ...ON, transaction: racing });
  assert.equal(p.yourTurn, 1); assert.deepEqual(ids(p.attached), [pending]);
  assert.equal((await reports(o.staff.accountant)).yourTurn, 0);
  await assert.rejects(tx(o.staff.admin.userId, async c => {
    await c.query("UPDATE invoices SET due_date = due_date WHERE id = $1", [inv]);
  }, { orgId: o.orgId, environment: "live" }, { isolation: "repeatable read", readOnly: true }),
  // tx() maps database errors to a generic FlowError (it logs SQLSTATE 25006); read-only mode itself is
  // asserted above with SHOW transaction_read_only, as in the merged readers' tests.
  (e: unknown) => (e as { key?: string }).key === "errors.generic");
  for (const [reader, listSql] of [[moneyMonthBills, BILLS_LIST_SQL_FOR_TEST], [moneyMonthReports, REPORTS_LIST_SQL_FOR_TEST]] as const) {
    let countRead = false, cancelled: string | undefined;
    const slow: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
      const run = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
      (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (args[0] === listSql) {
          assert.equal(countRead, true);
          try { await run("SELECT pg_sleep(30)"); } catch (e) { cancelled = (e as { code?: string }).code; throw e; }
        }
        const result = await run(...args);
        if (args[0] === BILLS_SUMMARY_SQL_FOR_TEST || args[0] === REPORTS_SUMMARY_SQL_FOR_TEST) countRead = true;
        return result;
      };
      return fn(c);
    }, scope, opts);
    assert.deepEqual(await reader(o.staff.accountant, { month: MONTH }, { ...ON, transaction: slow }), { state: "unavailable" });
    assert.equal(cancelled, "57014", "reader's own two-second timeout cancels the statement");
  }
});

test("real brand flag OFF and exact opt-in ON, without today/item flags", async () => {
  const o = await org(); await invoice(await lease(o));
  const never: typeof tx = async () => { assert.fail("OFF must not open business transaction"); };
  for (const reader of [moneyMonthBills, moneyMonthReports]) assert.deepEqual(await reader(o.staff.admin, { month: MONTH }, { transaction: never }), { state: "off" });
  await query(`UPDATE organizations SET feature_flags = feature_flags || '{"brand_v2":true,"brand_v3":true}'::jsonb WHERE id = $1`, [o.orgId]);
  assert.equal((await bills(o.staff.admin, { month: MONTH }, { now: ON.now })).counts.all, 1);
  assert.equal((await reports(o.staff.admin, { month: MONTH }, { now: ON.now })).yourTurn, 0);
  for (const flag of [false, "true"]) {
    await query("UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object('brand_v3', $2::jsonb) WHERE id = $1", [o.orgId, JSON.stringify(flag)]);
    for (const reader of [moneyMonthBills, moneyMonthReports]) assert.deepEqual(await reader(o.staff.admin, { month: MONTH }, { transaction: never }), { state: "off" });
  }
});

test("mixed invoice currencies in one lease/month are unavailable, never silently combined or split into extra bill rows", async () => {
  const o = await org(); const l = await lease(o); await invoice(l);
  await invoice(l, { currency: "USD" });
  assert.deepEqual(await moneyMonthBills(o.staff.admin, { month: MONTH }, ON), { state: "unavailable" });
  assert.deepEqual(await moneyMonthReports(o.staff.admin, { month: MONTH }, ON), { state: "unavailable" });
});
