import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { incomeExpenseLines, incomeExpenseExportData, revalidateIncomeExport, INCOME_REPORT_SUMMARY_SQL,
  type IncomeReportInput, type IncomeReportReady } from "./b3-income-report";
import { exportIncomeReport, incomeReportCsv } from "./b3-income-report-csv";
import { governCustomRole, resolveCustomRoleSession } from "./b017-custom-role-governance";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Mac only: fully migrated disposable PostgreSQL. Fixtures never invoke domain actions,
// notification producers, providers or queues. No migrations are applied by this file.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const ON = { v3: async () => true, now: () => new Date("2030-05-01T00:30:00Z") };
const denied = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
let savedSetting: unknown;
test.before(async () => {
  savedSetting = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'custom_roles'")).rows[0]?.value;
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
});
test.after(async () => {
  if (savedSetting === undefined) await query("DELETE FROM platform_settings WHERE key = 'custom_roles'");
  else await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(savedSetting)]);
  if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom;
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
    VALUES ($1, 'Report synthetic', 'TW', $2, 'Asia/Taipei') RETURNING id::text`, [orgId, currency])).rows[0].id;
}
async function org(): Promise<Org> {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, timezone)
    VALUES ('Report synthetic', 'TW', 'TWD', 'UTC') RETURNING id::text`)).rows[0].id;
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
async function pay(l: Lease, opts: { status?: "submitted" | "confirmed" | "rejected" | "reversed"; source?: string;
  amount?: string; at?: string; paidOn?: string; contact?: string; reference?: string } = {}) {
  const status = opts.status ?? "submitted";
  return (await query<{ id: string }>(`INSERT INTO payments
    (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source,
     submitted_by, submitted_at, confirmed_by, confirmed_at, rejected_reason, reference)
    VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, 'bank_transfer', $8::payment_status, $9::payment_source,
      $10, $11::timestamptz, $12, CASE WHEN $12::uuid IS NULL THEN NULL ELSE $11::timestamptz END, $13, $14) RETURNING id::text`,
  [l.orgId, l.property, l.id, opts.contact ?? null, l.currency, opts.amount ?? "1000", opts.paidOn ?? "2030-05-01",
    status, opts.source ?? "tenant_portal", l.admin, opts.at ?? "2030-04-15T00:00:00.123456Z",
    status === "confirmed" || status === "reversed" ? l.admin : null, status === "rejected" ? "Synthetic" : null, opts.reference ?? null])).rows[0].id;
}
const allocate = (l: Lease, payment: string, inv: string, amount = "1000") => query(
  "INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor) VALUES ($1, $2, $3, $4::bigint)", [l.orgId, payment, inv, amount]);
async function invoice(l: Lease, period: string | null = "2030-05-01", lines: [string, string][] = [["rent", "1000"]]) {
  const id = (await query<{ id: string }>(`INSERT INTO invoices
    (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status)
    VALUES ($1, $2, $3, $4, $5, '2030-05-01', $6, 'open') RETURNING id::text`,
  [l.orgId, l.property, l.id, randomUUID(), l.currency, period])).rows[0].id;
  for (let n = 0; n < lines.length; n++) {
    const [kind, amount] = lines[n];
    const quantity = BigInt(amount) > BigInt("999999999999") ? 10000 : 1;
    await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
      VALUES ($1, $2, $3, $4::charge_type, 'Synthetic private line', $6, $5::numeric / $6, $5::bigint)`,
    [l.orgId, id, n + 1, kind, amount, quantity]);
  }
  return id;
}
async function receipt(l: Lease, period: string, lines: [string, string][], amount: string, paidOn = "2030-05-01", status: "confirmed" | "submitted" = "confirmed") {
  const inv = await invoice(l, period, lines);
  const payment = await pay(l, { amount, paidOn, status });
  await allocate(l, payment, inv, amount); return payment;
}
async function expense(o: Org, amount: string, billTo = "owner", status = "approved", date = "2030-05-31", ticket?: string) {
  return (await query<{ id: string }>(`INSERT INTO expenses
    (org_id, property_id, category, description, currency, amount_minor, incurred_on, paid_by, bill_to, status, ticket_id, approved_by, approved_at, created_by)
    VALUES ($1, $2, 'repair', 'Synthetic private expense', $3, $4::bigint, $5, 'manager_firm', $6::cost_bearer, $7::expense_status, $8,
      $9, now(), $9) RETURNING id::text`, [o.orgId, o.property, o.currency, amount, date, billTo, status, ticket ?? null, o.staff.admin.userId])).rows[0].id;
}
async function read(s: Session, input: IncomeReportInput = { month: "2030-05" }): Promise<IncomeReportReady> {
  const data = await incomeExpenseLines(s, input, ON);
  assert.equal(data.state, "ready"); if (data.state !== "ready") throw new Error("report unavailable"); return data;
}

test("real allocations: waterfall, deposits, partials, early rent service date, paid_on, payer basis, open repair, currencies", async () => {
  const o = await org(), l = await lease(o);
  const main = await receipt(l, "2030-05-01", [["rent", "1000"], ["utility", "200"], ["deposit", "500"]], "1700");
  const early = await receipt(l, "2030-06-01", [["rent", "1000"], ["utility", "200"], ["deposit", "500"]], "1700");
  await receipt(l, "2030-05-31", [["rent", "100"]], "100", "2030-05-31");
  await receipt(l, "2030-05-01", [["rent", "1000"], ["deposit", "500"]], "250");
  await receipt(l, "2030-04-01", [["rent", "50"]], "50"); // arrears paid in selected month
  await receipt(l, "2030-05-01", [["rent", "999"]], "999", "2030-04-30");
  await receipt(l, "2030-05-01", [["rent", "999"]], "999", "2030-06-01");
  await receipt(l, "2030-05-01", [["rent", "999"]], "999", "2030-05-01", "submitted");
  const ticket = (await query<{ id: string }>(`INSERT INTO maintenance_tickets
    (org_id, property_id, ticket_number, title, status) VALUES ($1, $2, 1, 'Synthetic open repair', 'open') RETURNING id::text`, [o.orgId, o.property])).rows[0].id;
  const company = await expense(o, "200", "manager", "approved", "2030-05-01", ticket);
  await expense(o, "300", "owner", "posted");
  for (const status of ["draft", "submitted", "rejected", "void"]) await expense(o, "999", "owner", status);
  await expense(o, "999", "tenant"); await expense(o, "999", "owner", "approved", "2030-06-01");
  const usd: Org = { ...o, property: await property(o.orgId, "USD"), currency: "USD" }, ul = await lease(usd);
  await receipt(ul, "2030-05-01", [["rent", "9007199254740993"]], "9007199254740993");
  await expense(usd, "7");
  const data = await read(o.staff.accountant);
  assert.deepEqual(data.totals, [
    { currency: "TWD", incomeMinor: "2799", expenseMinor: "500", netMinor: "2299", depositMinor: "1000", earlyRentMinor: "1000", prepaymentMinor: "0" },
    { currency: "USD", incomeMinor: "9007199254740993", expenseMinor: "7", netMinor: "9007199254740986", depositMinor: "0", earlyRentMinor: "0", prepaymentMinor: "0" },
  ]);
  assert.equal(data.rows.filter(r => r.sourceId === main).length, 3);
  assert.deepEqual(data.rows.filter(r => r.sourceId === early).map(r => r.kind).sort(), ["deposit", "earlyRent", "income"]);
  assert.ok(data.rows.some(r => r.sourceId === company));
  const future = await read(o.staff.admin, { month: "2030-06", property: o.property });
  assert.deepEqual(future.rows.filter(r => r.sourceId === early).map(r => [r.kind, r.amountMinor, r.date, r.paidOn]),
    [["income", "1000", "2030-06-01", "2030-05-01"]]);
  const boundary = await read(o.staff.admin, { mode: "range", from: "2030-05-31", to: "2030-05-31" });
  assert.equal(boundary.totals.find(r => r.currency === "TWD")?.incomeMinor, "100");
  assert.equal(boundary.totals.find(r => r.currency === "TWD")?.expenseMinor, "300");
});

test("same invoice rent 100 + deposit 100: two payments of 100 consume each line once", async () => {
  const o = await org(), l = await lease(o), inv = await invoice(l, "2030-05-01", [["rent", "100"], ["deposit", "100"]]);
  // Insert later cash date first, with an earlier confirmation: paid_on must win.
  const second = await pay(l, { status: "confirmed", amount: "100", paidOn: "2030-05-02", at: "2030-05-02T00:00:00Z" });
  const first = await pay(l, { status: "confirmed", amount: "100", paidOn: "2030-05-01", at: "2030-05-03T00:00:00Z" });
  await allocate(l, second, inv, "100"); await allocate(l, first, inv, "100");
  const data = await read(o.staff.accountant);
  assert.deepEqual(data.totals, [{ currency: "TWD", incomeMinor: "100", expenseMinor: "0", netMinor: "100", depositMinor: "100", earlyRentMinor: "0", prepaymentMinor: "0" }]);
  assert.deepEqual(data.rows.map(r => [r.sourceId, r.kind, r.amountMinor]), [[first, "income", "100"], [second, "deposit", "100"]]);
  const exported = await incomeExpenseExportData(o.staff.accountant, { month: "2030-05" }, ON);
  assert.deepEqual(exported.rows, data.rows); assert.deepEqual(exported.totals, data.totals);
  assert.equal(incomeReportCsv(exported, "en"), incomeReportCsv(data, "en"));
});

test("cross-period invoice: May 150 consumes rent 100 + deposit 50; June 50 consumes deposit only", async () => {
  const o = await org(), l = await lease(o), inv = await invoice(l, "2030-05-01", [["rent", "100"], ["deposit", "100"]]);
  // Non-confirmed allocations must not consume any interval.
  const pending = await pay(l, { amount: "100", paidOn: "2030-04-01" }); await allocate(l, pending, inv, "100");
  const first = await pay(l, { status: "confirmed", amount: "150", paidOn: "2030-05-01" }); await allocate(l, first, inv, "150");
  const second = await pay(l, { status: "confirmed", amount: "50", paidOn: "2030-06-01" }); await allocate(l, second, inv, "50");
  const may = await read(o.staff.admin), june = await read(o.staff.admin, { month: "2030-06" });
  assert.deepEqual(may.totals, [{ currency: "TWD", incomeMinor: "100", expenseMinor: "0", netMinor: "100", depositMinor: "50", earlyRentMinor: "0", prepaymentMinor: "0" }]);
  assert.deepEqual(june.totals, [{ currency: "TWD", incomeMinor: "0", expenseMinor: "0", netMinor: "0", depositMinor: "50", earlyRentMinor: "0", prepaymentMinor: "0" }]);
  assert.ok(may.rows.every(r => r.sourceId === first));
  assert.deepEqual(june.rows.map(r => [r.sourceId, r.kind, r.amountMinor]), [[second, "deposit", "50"]]);
  const range = await read(o.staff.admin, { mode: "range", from: "2030-05-01", to: "2030-06-30" });
  assert.deepEqual(range.rows, [...may.rows, ...june.rows]);
});

test("PR-019 May-paid June rent: May separate, June income, inclusive range edges and unchanged deposits", async () => {
  const o = await org(), l = await lease(o);
  const early = await receipt(l, "2030-06-01", [["rent", "100"], ["deposit", "50"]], "150", "2030-05-15");
  const may = await read(o.staff.admin);
  assert.deepEqual(may.totals, [{ currency: "TWD", incomeMinor: "0", expenseMinor: "0", netMinor: "0", depositMinor: "50", earlyRentMinor: "100", prepaymentMinor: "0" }]);
  const earlyRow = may.rows.find(r => r.kind === "earlyRent")!;
  assert.equal(earlyRow.sourceId, early); assert.equal(earlyRow.date, "2030-05-15");
  assert.equal(earlyRow.leaseId, l.id); assert.equal(earlyRow.serviceMonthStart, "2030-06-01");
  assert.ok(earlyRow.invoiceId); assert.ok(earlyRow.allocationId);
  const june = await read(o.staff.admin, { month: "2030-06" });
  assert.equal(june.count, 1); assert.equal(june.totals[0].incomeMinor, "100"); assert.equal(june.totals[0].earlyRentMinor, "0");
  assert.equal(june.totals[0].depositMinor, "0");
  assert.deepEqual(june.rows.map(r => [r.sourceId, r.date, r.paidOn, r.kind]), [[early, "2030-06-01", "2030-05-15", "income"]]);
  for (const [from, to, kinds] of [
    ["2030-05-15", "2030-05-15", ["deposit", "earlyRent"]],
    ["2030-06-01", "2030-06-01", ["income"]],
    ["2030-05-15", "2030-06-01", ["deposit", "income"]],
    ["2030-05-16", "2030-05-31", []], ["2030-06-02", "2030-06-30", []],
  ] as const) {
    const range = await read(o.staff.admin, { mode: "range", from, to });
    assert.deepEqual(range.rows.map(r => r.kind).sort(), [...kinds]);
  }
  const exported = await incomeExpenseExportData(o.staff.admin, { month: "2030-05" }, ON);
  assert.deepEqual(exported.rows, may.rows); assert.deepEqual(exported.totals, may.totals);
  assert.ok(incomeReportCsv(exported, "zh-TW").includes('"預收租金"'));
  const inv = await invoice(l, null, [["rent", "25"]]);
  const payment = await pay(l, { status: "confirmed", amount: "25", paidOn: "2030-05-20" }); await allocate(l, payment, inv, "25");
  assert.equal((await read(o.staff.admin)).totals[0].incomeMinor, "25", "missing service date retains cash recognition");
});

test("PR-019 exact non-first invoice start and early waterfall portions survive later report filtering", async () => {
  const o = await org(), l = await lease(o), inv = await invoice(l, "2030-06-15", [["rent", "100"], ["deposit", "100"]]);
  const first = await pay(l, { status: "confirmed", amount: "150", paidOn: "2030-05-31" }); await allocate(l, first, inv, "150");
  const second = await pay(l, { status: "confirmed", amount: "50", paidOn: "2030-06-01" }); await allocate(l, second, inv, "50");
  const june = await read(o.staff.admin, { month: "2030-06" });
  assert.deepEqual(june.rows.map(r => [r.sourceId, r.kind, r.amountMinor]), [[second, "deposit", "50"], [first, "income", "100"]]);
  assert.equal((await read(o.staff.admin, { mode: "range", from: "2030-06-02", to: "2030-06-14" })).count, 0);
  assert.equal((await read(o.staff.admin, { mode: "range", from: "2030-06-15", to: "2030-06-15" })).totals[0].incomeMinor, "100");
});

test("PR-019 partial and wholly unallocated confirmed payments: remainder per payment, currencies and org isolation", async () => {
  const o = await org(), l = await lease(o), other = await org(), otherLease = await lease(other);
  const partial = await pay(l, { status: "confirmed", amount: "200", paidOn: "2030-05-31" });
  await allocate(l, partial, await invoice(l, "2030-05-01", [["rent", "50"]]), "50");
  await allocate(l, partial, await invoice(l, "2030-06-01", [["rent", "70"]]), "70");
  const unused = await pay(l, { status: "confirmed", amount: "30" });
  const foreign = await pay(otherLease, { status: "confirmed", amount: "999" });
  for (const status of ["submitted", "rejected", "reversed"] as const) await pay(l, { status, amount: "999" });
  for (const paidOn of ["2030-04-30", "2030-06-01"]) await pay(l, { status: "confirmed", amount: "999", paidOn });
  const usd = { ...o, property: await property(o.orgId, "USD"), currency: "USD" };
  await pay(await lease(usd), { status: "confirmed", amount: "9007199254740993" });
  const may = await read(o.staff.admin);
  assert.deepEqual(may.totals, [
    { currency: "TWD", incomeMinor: "50", expenseMinor: "0", netMinor: "50", depositMinor: "0", earlyRentMinor: "70", prepaymentMinor: "110" },
    { currency: "USD", incomeMinor: "0", expenseMinor: "0", netMinor: "0", depositMinor: "0", earlyRentMinor: "0", prepaymentMinor: "9007199254740993" },
  ]);
  assert.deepEqual(may.rows.filter(r => r.kind === "prepayment" && r.currency === "TWD").map(r => [r.sourceId, r.amountMinor]), [[unused, "30"], [partial, "80"]]);
  assert.equal(may.rows.find(r => r.sourceId === partial && r.kind === "prepayment")?.sourceAmountMinor, "200");
  assert.ok(may.rows.every(r => r.sourceId !== foreign));
  assert.deepEqual((await read(other.staff.admin)).rows.map(r => r.sourceId), [foreign]);
  assert.equal((await read(o.staff.admin, { month: "2030-05", property: other.property })).count, 0);
  const edge = await read(o.staff.admin, { mode: "range", from: "2030-05-31", to: "2030-05-31", property: o.property });
  assert.equal(edge.totals[0].prepaymentMinor, "80");
  const exported = await incomeExpenseExportData(o.staff.admin, { month: "2030-05" }, ON);
  assert.deepEqual(exported.rows, may.rows); assert.deepEqual(exported.totals, may.totals);
  const csv = incomeReportCsv(exported, "zh-TW");
  assert.ok(csv.includes('"預付"')); assert.ok(csv.includes('"預收租金"')); assert.ok(!csv.includes(foreign));
});

test("owner overlap/property filters, org calendar default, pagination totals and complete CSV all use one population", async () => {
  const o = await org();
  const owner = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_owner, display_name)
    VALUES ($1, true, 'Synthetic private owner') RETURNING id::text`, [o.orgId])).rows[0].id;
  await query(`INSERT INTO property_owners (org_id, property_id, owner_contact_id, effective_from, effective_to, is_primary)
    VALUES ($1, $2, $3, '2030-05-31', '2030-06-30', true)`, [o.orgId, o.property, owner]);
  for (let n = 0; n < 55; n++) await expense(o, "10");
  const first = await read(o.staff.admin, { month: "2030-05", owner, property: o.property });
  assert.equal(first.count, 55); assert.equal(first.rows.length, 50); assert.ok(first.nextCursor);
  const second = await read(o.staff.admin, { month: "2030-05", owner, property: o.property, cursor: first.nextCursor });
  assert.equal(second.rows.length, 5); assert.deepEqual(first.totals, second.totals);
  assert.equal(new Set([...first.rows, ...second.rows].map(r => r.key)).size, 55);
  const all = await incomeExpenseExportData(o.staff.admin, { month: "2030-05", owner, property: o.property, cursor: first.nextCursor }, ON);
  assert.equal(all.rows.length, 55); assert.deepEqual(all.totals, first.totals);
  assert.equal(incomeReportCsv(all, "en").split('\r\n').length, 58);
  assert.equal((await read(o.staff.admin, { month: "2030-04", owner })).count, 0);
  await query("UPDATE organizations SET timezone = 'America/Los_Angeles' WHERE id = $1", [o.orgId]);
  assert.equal((await read(o.staff.admin, {})).period.month, "2030-04");
});

test("cross-org/environment and actual anonymous business SQL denied; staff removal never falls through tenant visibility", async () => {
  const o = await org(), other = await org(), l = await lease(o); await receipt(l, "2030-05-01", [["rent", "100"]], "100");
  await assert.rejects(incomeExpenseLines({ ...o.staff.admin, orgId: other.orgId, liveOrgId: other.orgId }, {}, ON), denied);
  await assert.rejects(incomeExpenseLines({ ...o.staff.admin, environment: "sandbox" }, {}, ON), denied);
  assert.equal((await read(o.staff.admin, { month: "2030-05", property: other.property })).count, 0);
  for (const subject of [o.staff.maintenance, { ...o.staff.admin, kind: "tenant" as const, role: null }, { ...o.staff.admin, kind: "owner" as const, role: null }])
    await assert.rejects(incomeExpenseLines(subject, {}, ON), denied);
  await primary(l, o.staff.manager.userId);
  for (const status of ["suspended", "removed"]) {
    if (status === "suspended") await query("UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId]);
    else await query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId]);
    await assert.rejects(incomeExpenseLines(o.staff.manager, {}, ON), denied);
  }
  const anon = new Client({ connectionString: process.env.DATABASE_URL }); await anon.connect();
  try {
    await anon.query("BEGIN READ ONLY"); await anon.query("SET LOCAL ROLE anon");
    await assert.rejects(anon.query(INCOME_REPORT_SUMMARY_SQL, [o.orgId, "2030-05-01", "2030-05-31", null, null]), /permission denied/);
  } finally { await anon.query("ROLLBACK"); await anon.end(); }
});

test("stmt.view-only can view but cannot export; revoked export authority fails before audit", async () => {
  const o = await org(); await expense(o, "100");
  await query("UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.admin.userId]);
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
  try {
    await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}'::jsonb WHERE id = $1`, [o.orgId]);
    const member = (await query<{ id: string }>("SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.accountant.userId])).rows[0].id;
    const { roleId } = await governCustomRole(o.staff.admin, { operation: "create", grants: ["stmt.view"], requestId: randomUUID() }); assert.ok(roleId);
    const assign = () => governCustomRole(o.staff.admin, { operation: "assign", roleId: roleId!, memberId: member, requestId: randomUUID() });
    await assign(); const viewer = await resolveCustomRoleSession(o.staff.accountant);
    assert.equal((await read(viewer)).count, 1);
    await assert.rejects(incomeExpenseExportData(viewer, { month: "2030-05" }, ON), denied);
    await governCustomRole(o.staff.admin, { operation: "revise", roleId: roleId!, grants: ["stmt.view", "reports.export"], requestId: randomUUID() });
    await assign(); const exporter = await resolveCustomRoleSession(o.staff.accountant); let audited = false;
    await assert.rejects(exportIncomeReport(exporter, { month: "2030-05" }, {
      read: async (s, input) => { const data = await incomeExpenseExportData(s, input, ON);
        await governCustomRole(o.staff.admin, { operation: "revise", roleId: roleId!, grants: ["stmt.view"], requestId: randomUUID() });
        await assign(); return data; },
      revalidate: s => revalidateIncomeExport(s, ON), audit: async () => { audited = true; },
    }), denied); assert.equal(audited, false);
  } finally { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; }
});

test("real service-role export audit after RLS read, exact CSV, no rows/contacts/content; read-only and 2s enforced", async () => {
  const o = await org(); await expense(o, "100"); const operationId = randomUUID();
  const all = await incomeExpenseExportData(o.staff.admin, { month: "2030-05" }, ON);
  const body = await exportIncomeReport(o.staff.admin, { month: "2030-05", property: o.property }, {
    read: (s, input) => incomeExpenseExportData(s, input, ON), revalidate: s => revalidateIncomeExport(s, ON), operationId: () => operationId,
  });
  assert.equal(body, incomeReportCsv(all, "en"));
  const audit = (await query<{ actor_user_id: string; new_row: Record<string, unknown> }>(
    "SELECT actor_user_id, new_row FROM audit_log WHERE org_id = $1 AND request_id = $2 AND event_type = 'income_report_exported'", [o.orgId, operationId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, o.staff.admin.userId);
  assert.deepEqual(audit[0].new_row, { event: "income_report_exported", operation_id: operationId, start: "2030-05-01", end: "2030-05-31",
    property_id: o.property, owner_id: null, row_count: 1, currency_count: 1 });
  assert.ok(!JSON.stringify(audit).includes("Synthetic"));
  const checked: typeof tx = (userId, fn, scope, options) => tx(userId, async client => {
    const result = await fn(client);
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    assert.equal((await client.query("SHOW statement_timeout")).rows[0].statement_timeout, "2s");
    return result;
  }, scope, options);
  assert.equal((await incomeExpenseLines(o.staff.admin, { month: "2030-05" }, { ...ON, transaction: checked })).state, "ready");
});
