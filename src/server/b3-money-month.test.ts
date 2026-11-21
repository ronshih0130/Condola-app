import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { BILLS_LIST_SQL_FOR_TEST, BILLS_SUMMARY_SQL_FOR_TEST, MONEY_MONTH_LIST_LIMIT, MONEY_MONTH_STATUSES,
  REPORTS_LIST_SQL_FOR_TEST, REPORTS_SUMMARY_SQL_FOR_TEST, moneyMonthBills, moneyMonthReports, moneyMonthStatus,
  type MoneyMonthBill, type MoneyMonthReport } from "./b3-money-month";
import { PENDING_TENANT_REPORT_SQL } from "./b3-payment-eligibility";
import { PAYMENT_TURN_MATTERS_SQL } from "./b3-payment-turns";
import { brandV3ReadForOrg } from "./brand-v3";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const session: Session = { userId: id(1), sessionId: id(2), orgId: id(3), liveOrgId: id(3), environment: "live",
  kind: "staff", role: "accountant", name: "Synthetic", email: "", leaseId: null, locale: "en", calendar: "gregorian" };
const month = "2030-05";
const ON = { v3: async () => true, now: () => new Date("2030-05-01T00:30:00Z") };
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
// The readers catch every non-forbidden error as "unavailable", so a failing transaction alone cannot prove
// it was never opened: count calls outside the reader and check after every test.
let neverCalls = 0;
const never: typeof tx = async () => { neverCalls++; throw new Error("must not open business transaction"); };
test.afterEach(() => { const calls = neverCalls; neverCalls = 0; assert.equal(calls, 0, "a business transaction was opened"); });
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom; });
const readers = [moneyMonthBills, moneyMonthReports];

test("OFF precedes permission, input validation and business SQL, with no separate item flag", async () => {
  for (const reader of readers) assert.deepEqual(await reader({ ...session, kind: "tenant", role: null }, { month: "bad" },
    { v3: async () => false, transaction: never }), { state: "off" });
});

test("literal stmt.view/pay.record admission refuses maintenance, tenant and owner before tx", async () => {
  for (const reader of readers) for (const denied of [
    { ...session, role: "maintenance" as const }, { ...session, role: null },
    { ...session, kind: "tenant" as const }, { ...session, kind: "owner" as const },
  ]) await assert.rejects(reader(denied, { month }, { ...ON, transaction: never }), forbidden);
});

test("operational failures including real brandV3ReadForOrg failure are unavailable, permission denial escapes", async () => {
  const broken = async () => { throw new Error("synthetic failure"); };
  for (const reader of readers) {
    for (const deps of [{ v3: broken }, { transaction: broken }, { now: () => new Date(NaN) },
      { v3: (org: string) => brandV3ReadForOrg(org, {}, broken) }]) {
      assert.deepEqual(await reader(session, { month }, { ...ON, transaction: never, ...deps }), { state: "unavailable" });
    }
    assert.deepEqual(await reader(session, { month }, { ...ON, transaction: never,
      v3: (org: string) => brandV3ReadForOrg(org, {}, async () => ({ v2: true, v3: false })) }), { state: "off" });
    await assert.rejects(reader(session, { month }, { ...ON, transaction: async () => { throw new FlowError("errors.forbidden"); } }), forbidden);
  }
});

test("MGT-141 precedence: paid > reported > overdue > partial > due today > future", () => {
  const today = "2030-05-01";
  for (const [confirmed, pending, due, expected] of [
    ["100", true, "2030-04-30", "paid"], ["101", false, "2030-05-02", "paid"],
    ["20", true, "2030-04-30", "reported"], ["0", true, today, "reported"], ["0", true, "2030-05-02", "reported"],
    ["0", false, "2030-04-30", "overdue"], ["20", false, "2030-04-30", "overdue"],
    ["0", false, today, "due_today"], ["20", false, today, "partial"],
    ["0", false, "2030-05-02", "future"], ["20", false, "2030-05-02", "partial"],
  ] as const) assert.equal(moneyMonthStatus("100", confirmed, pending, due, today), expected);
  assert.notEqual(moneyMonthStatus("0", "0", false, today, today), "paid", "zero balance is not proof of paid");
  assert.equal(moneyMonthStatus("9007199254740993", "9007199254740992", false, today, today), "partial");
  assert.equal(MONEY_MONTH_STATUSES.length, 6);
});

test("MGT-141 due-1/due/due+1: partial becomes overdue, full stays paid, pending beats both", () => {
  const due = "2030-05-02";
  for (const [today, expected] of [["2030-05-01", "partial"], [due, "partial"], ["2030-05-03", "overdue"]] as const) {
    assert.equal(moneyMonthStatus("1000", "200", false, due, today), expected);
    assert.equal(moneyMonthStatus("1000", "200", true, due, today), "reported");
    for (const pending of [false, true]) assert.equal(moneyMonthStatus("1000", "1000", pending, due, today), "paid");
  }
});

const bill = (n: number): MoneyMonthBill => ({ leaseId: id(n), month, place: "Synthetic 2F A", tenantName: null,
  currency: "USD", dueDate: "2030-05-01", totalMinor: "9007199254740993", confirmedMinor: "1", remainingMinor: "9007199254740992", status: "partial",
  propertyToday: "2030-05-01" });
const report = (n: number, other = false): MoneyMonthReport => ({ id: id(n), leaseId: id(999), place: "Synthetic", tenantName: null,
  amountMinor: "9007199254740993", currency: "USD", paidOn: "2030-01-01", submittedAt: "2030-04-30T23:00:00.123456Z",
  source: "tenant_portal", bankTransactionId: null, proofFileId: null,
  billRows: other ? [] : [{ leaseId: id(999), month }], attachment: other ? "other" : "oldest_unpaid" });
const summary = { today: "2030-05-01", timezone: "UTC", invalid_currencies: 0, all_count: 80, counts: { due_today: 80 },
  totals: [{ currency: "USD", totalMinor: "720575940379279440", confirmedMinor: "80", billedRows: 80, paidRows: 0 }],
  owing: 90, outstanding: [{ currency: "USD", amountMinor: "810647932926689280", leaseCount: 90 }] };
const reportSummary = { today: "2030-05-01", timezone: "UTC", count: 80, attached: 60, other: 20, invalid_currencies: 0 };

function mockTx(handler: (sql: string, args?: unknown[]) => { rows: unknown[] }): typeof tx {
  return async (user, fn, scope, options) => {
    assert.equal(user, session.userId);
    assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    let first = true;
    return fn({ query: async (sql: string, args?: unknown[]) => {
      if (first) { first = false; assert.equal(sql, "SET LOCAL statement_timeout = '2s'"); return { rows: [] }; }
      // Measured planner setting (see b3-money-month.ts); scoped to this read-only transaction.
      if (sql === "SET LOCAL enable_seqscan = off") return { rows: [] };
      if (sql.includes("SELECT app.has_role")) return { rows: [{ ok: true }] };
      assert.deepEqual(args?.slice(0, 3), [session.orgId, `${month}-01`, ON.now().toISOString()]);
      return handler(sql, args);
    } } as unknown as Client);
  };
}

test("bill ready shape: exact amounts, all counts/totals before status/cursor, 50+1 keyset page in one snapshot", async () => {
  let clocks = 0;
  const calls: string[] = [];
  const transaction = mockTx((sql, args) => {
    calls.push(sql);
    if (sql === BILLS_SUMMARY_SQL_FOR_TEST) return { rows: [summary] };
    assert.equal(sql, BILLS_LIST_SQL_FOR_TEST);
    assert.deepEqual(args?.slice(3), ["due_today", null, null, 51]);
    return { rows: Array.from({ length: 51 }, (_, n) => ({ ...bill(n + 10), has_pending_report: false })) };
  });
  const first = await moneyMonthBills(session, { month, status: "due_today" }, { ...ON, transaction, now: () => { clocks++; return ON.now(); } });
  assert.equal(first.state, "ready"); if (first.state !== "ready") return;
  assert.equal(first.rows.length, MONEY_MONTH_LIST_LIMIT);
  assert.deepEqual(first.rows[0], bill(10));
  assert.deepEqual(first.counts, { all: 80, paid: 0, reported: 0, overdue: 0, due_today: 80, future: 0 });
  assert.equal(first.filteredCount, 80);
  assert.deepEqual(first.totals, summary.totals);
  assert.deepEqual(first.outstanding, { leaseCount: 90, currencies: summary.outstanding });
  assert.equal(first.population, "rent_roll_active_unarchived");
  assert.equal(first.timezone, "UTC");
  assert.equal(clocks, 1);
  assert.deepEqual(calls, [BILLS_SUMMARY_SQL_FOR_TEST, BILLS_LIST_SQL_FOR_TEST]);
  assert.ok(first.nextCursor);
  const page2 = mockTx((sql, args) => {
    if (sql === BILLS_SUMMARY_SQL_FOR_TEST) return { rows: [summary] };
    assert.deepEqual(args?.slice(3), ["due_today", "2030-05-01", id(59), 51]);
    return { rows: [{ ...bill(60), has_pending_report: false }] };
  });
  const second = await moneyMonthBills(session, { month, status: "due_today", cursor: first.nextCursor }, { ...ON, transaction: page2 });
  assert.equal(second.state, "ready"); if (second.state !== "ready") return;
  assert.equal(second.counts.all, 80); assert.deepEqual(second.rows, [bill(60)]); assert.equal(second.nextCursor, null);
  for (const changed of [{ month: "2030-04", status: "due_today" as const }, { month, status: "paid" as const }, { month }]) {
    assert.deepEqual(await moneyMonthBills(session, { ...changed, cursor: first.nextCursor }, { ...ON, transaction: never }), { state: "unavailable" });
  }
  assert.deepEqual(await moneyMonthBills({ ...session, orgId: id(4) }, { month, status: "due_today", cursor: first.nextCursor }, { ...ON, transaction: never }), { state: "unavailable" });
});

test("reports ready shape separates other reports; counts are reports, not attachments, and cursor preserves microseconds", async () => {
  const rows = [...Array.from({ length: 20 }, (_, n) => report(n + 10, true)), ...Array.from({ length: 31 }, (_, n) => report(n + 100))];
  const transaction = mockTx((sql, args) => {
    if (sql === REPORTS_SUMMARY_SQL_FOR_TEST) return { rows: [reportSummary] };
    assert.equal(sql, REPORTS_LIST_SQL_FOR_TEST); assert.deepEqual(args?.slice(3), [null, null, null, 51]);
    return { rows };
  });
  const first = await moneyMonthReports(session, { month }, { ...ON, transaction });
  assert.equal(first.state, "ready"); if (first.state !== "ready") return;
  assert.equal(first.yourTurn, 80); assert.equal(first.attachedCount, 60); assert.equal(first.otherCount, 20);
  assert.equal(first.otherScope, "all_pending");
  assert.equal(first.today, reportSummary.today); assert.equal(first.timezone, reportSummary.timezone);
  assert.deepEqual(first.other, rows.slice(0, 20)); assert.deepEqual(first.attached, rows.slice(20, 50));
  assert.ok(first.nextCursor);
  const second = await moneyMonthReports(session, { month, cursor: first.nextCursor }, { ...ON, transaction: mockTx((sql, args) => {
    if (sql === REPORTS_SUMMARY_SQL_FOR_TEST) return { rows: [reportSummary] };
    assert.deepEqual(args?.slice(3), [1, "2030-04-30T23:00:00.123456Z", id(129), 51]);
    return { rows: [report(130)] };
  }) });
  assert.equal(second.state, "ready"); if (second.state === "ready") assert.equal(second.nextCursor, null);
  assert.deepEqual(await moneyMonthBills(session, { month, cursor: first.nextCursor }, { ...ON, transaction: never }), { state: "unavailable" });
});

test("empty ready differs from missing summary, mixed currency, list failure, and lost staff membership", async () => {
  for (const reader of readers) {
    const bills = reader === moneyMonthBills;
    for (const mode of ["empty", "missing", "mixed", "timeout", "denied"] as const) {
      const transaction: typeof tx = async (_user, fn) => fn({ query: async (sql: string) => {
        if (sql.includes("SELECT app.has_role")) return { rows: [{ ok: mode !== "denied" }] };
        if (sql === (bills ? BILLS_SUMMARY_SQL_FOR_TEST : REPORTS_SUMMARY_SQL_FOR_TEST)) return { rows: mode === "missing" ? [] : [{
          ...(bills ? { ...summary, all_count: 0, counts: {}, totals: [], owing: 0, outstanding: [] } : { ...reportSummary, count: 0, attached: 0, other: 0 }),
          invalid_currencies: mode === "mixed" ? 1 : 0,
        }] };
        if ((sql === BILLS_LIST_SQL_FOR_TEST || sql === REPORTS_LIST_SQL_FOR_TEST) && mode === "timeout") throw new Error("statement timeout");
        return { rows: [] };
      } } as unknown as Client);
      if (mode === "denied") await assert.rejects(reader(session, { month }, { ...ON, transaction }), forbidden);
      else {
        const result = await reader(session, { month }, { ...ON, transaction });
        assert.equal(result.state, mode === "empty" ? "ready" : "unavailable");
        if (result.state === "ready") assert.equal("rows" in result ? result.rows.length : result.other.length + result.attached.length, 0);
      }
    }
  }
});

test("invalid month/status/cursor rejected before business tx, including forged dates and identifiers", async () => {
  let opened = 0;
  const transaction: typeof tx = async () => { opened++; throw new Error("unexpected transaction"); };
  for (const reader of readers) {
    for (const bad of ["", "2030-5", "2030-00", "2030-13", "0000-01", "2030-01-01", "2030-05' OR true--"]) {
      assert.deepEqual(await reader(session, { month: bad }, { ...ON, transaction }), { state: "unavailable" });
    }
    for (const cursor of ["", "!", "x".repeat(2049), Buffer.from("null").toString("base64url")]) {
      assert.deepEqual(await reader(session, { month, cursor }, { ...ON, transaction }), { state: "unavailable" });
    }
  }
  assert.deepEqual(await moneyMonthBills(session, { month, status: "sixth" as never }, { ...ON, transaction }), { state: "unavailable" });
  for (const [date, cursorId] of [["2030-02-30", id(1)], ["2030-05-01", "bad-id"]]) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, kind: "bills", org: session.orgId, month, status: null, date, id: cursorId })).toString("base64url");
    assert.deepEqual(await moneyMonthBills(session, { month, cursor }, { ...ON, transaction }), { state: "unavailable" });
  }
  assert.equal(opened, 0);
});

test("SQL is read-only, shares P1 eligibility verbatim, and does not infer report targets from free text", () => {
  assert.ok(PAYMENT_TURN_MATTERS_SQL.includes(PENDING_TENANT_REPORT_SQL));
  for (const sql of [BILLS_SUMMARY_SQL_FOR_TEST, BILLS_LIST_SQL_FOR_TEST, REPORTS_SUMMARY_SQL_FOR_TEST, REPORTS_LIST_SQL_FOR_TEST]) {
    assert.ok(sql.includes(PENDING_TENANT_REPORT_SQL));
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
    assert.doesNotMatch(sql, /\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i);
    assert.doesNotMatch(sql, /reference|enable_seqscan|service_role/);
  }
  assert.match(BILLS_LIST_SQL_FOR_TEST, /ORDER BY b.due_date, b.lease_id LIMIT \$7/);
  assert.match(REPORTS_LIST_SQL_FOR_TEST, /ORDER BY p.group_order, p.submitted_at, p.id LIMIT \$7/);
});

test("PLT-54: due/overdue use each row's property date (the 今天 expression), never the organization date", () => {
  for (const sql of [BILLS_SUMMARY_SQL_FOR_TEST, BILLS_LIST_SQL_FOR_TEST, REPORTS_SUMMARY_SQL_FOR_TEST, REPORTS_LIST_SQL_FOR_TEST]) {
    // Same expression as b3-overdue-turns, on the lease's own property (l.property_id), no fallback.
    assert.match(sql, /l\.id AS lease_id, l\.property_id AS lease_property_id/);
    assert.match(sql, /\(\$3::timestamptz AT TIME ZONE lp\.timezone\)::date AS property_today/);
    assert.match(sql, /JOIN properties lp ON lp\.id = t\.lease_property_id AND lp\.org_id = \$1/);
    assert.match(sql, /GROUP BY lease_id, month, property_today/);
    assert.match(sql, /WHEN b\.due_date < b\.property_today THEN 'overdue'/);
    assert.match(sql, /WHEN b\.due_date = b\.property_today THEN 'due_today'/);
    assert.match(sql, /CASE WHEN b\.due_date = b\.property_today THEN 'due_today' ELSE 'future' END/);
    assert.doesNotMatch(sql, /c\.today THEN|selected_bill_(facts|states) b CROSS JOIN calendar/, "no due-state comparison against the organization calendar");
    // PLT-54-AC3: month grouping by invoice period is unchanged.
    assert.match(sql, /date_trunc\('month', i\.period_start\)::date AS month/);
    // Planner materialization unchanged.
    for (const cte of ["confirmed_allocations", "lease_targets", "eligible_leases", "eligible_invoices"]) assert.match(sql, new RegExp(`${cte} AS MATERIALIZED`));
  }
  assert.match(BILLS_LIST_SQL_FOR_TEST, /b\.property_today::text AS "propertyToday"/);
  // The organization calendar remains only for the default month / report dates.
  assert.match(BILLS_SUMMARY_SQL_FOR_TEST, /SELECT timezone, \(\$3::timestamptz AT TIME ZONE timezone\)::date AS today\s+FROM organizations WHERE id = \$1/);
});

test("PLT-54: list status uses the row's property date, not the summary's organization date; missing date is unavailable", async () => {
  const rows = [
    // Organization says 2030-05-01 (summary.today); these properties are a day either side.
    { ...bill(1), dueDate: "2030-05-01", confirmedMinor: "0", propertyToday: "2030-05-02", has_pending_report: false },
    { ...bill(2), dueDate: "2030-04-30", confirmedMinor: "0", propertyToday: "2030-04-30", has_pending_report: false },
    { ...bill(3), dueDate: "2030-05-01", confirmedMinor: "1", propertyToday: "2030-04-30", has_pending_report: false },
  ];
  const result = await moneyMonthBills(session, { month }, { ...ON, transaction: mockTx(sql =>
    ({ rows: sql === BILLS_SUMMARY_SQL_FOR_TEST ? [summary] : rows })) });
  assert.equal(result.state, "ready"); if (result.state !== "ready") return;
  assert.equal(result.today, "2030-05-01");
  assert.deepEqual(result.rows.map(r => [r.status, r.propertyToday]), [["overdue", "2030-05-02"], ["due_today", "2030-04-30"], ["partial", "2030-04-30"]]);
  for (const propertyToday of [undefined, null, "", "2030-02-30"]) {
    assert.deepEqual(await moneyMonthBills(session, { month }, { ...ON, transaction: mockTx(sql =>
      ({ rows: sql === BILLS_SUMMARY_SQL_FOR_TEST ? [summary] : [{ ...rows[0], propertyToday }] })) }), { state: "unavailable" });
  }
});

test("other-report page cursor stays in the other group, with full timestamp precision", async () => {
  const first = await moneyMonthReports(session, { month }, { ...ON, transaction: mockTx(sql => {
    if (sql === REPORTS_SUMMARY_SQL_FOR_TEST) return { rows: [{ ...reportSummary, attached: 0, other: 80 }] };
    return { rows: Array.from({ length: 51 }, (_, n) => report(n + 10, true)) };
  }) });
  assert.equal(first.state, "ready"); if (first.state !== "ready") return;
  assert.ok(first.nextCursor);
  const second = await moneyMonthReports(session, { month, cursor: first.nextCursor }, { ...ON, transaction: mockTx((sql, args) => {
    if (sql === REPORTS_SUMMARY_SQL_FOR_TEST) return { rows: [{ ...reportSummary, attached: 0, other: 80 }] };
    assert.deepEqual(args?.slice(3), [0, "2030-04-30T23:00:00.123456Z", id(59), 51]);
    return { rows: [] };
  }) });
  assert.equal(second.state, "ready");
  const bad = Buffer.from(JSON.stringify({ v: 1, kind: "reports", org: session.orgId, month, status: null,
    id: id(1), date: "2030-02-30T23:00:00.123456Z", group: 0 })).toString("base64url");
  assert.deepEqual(await moneyMonthReports(session, { month, cursor: bad }, { ...ON, transaction: never }), { state: "unavailable" });
});
