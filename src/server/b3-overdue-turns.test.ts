import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, OVERDUE_TURN_LIST_LIMIT, staffOverdueTurns } from "./b3-overdue-turns";
import { PAYMENT_TURN_MATTERS_SQL } from "./b3-payment-turns";
import { brandV3ReadForOrg } from "./brand-v3";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const session: Session = {
  userId: "00000000-0000-4000-8000-000000000001", sessionId: "s", orgId: "00000000-0000-4000-8000-000000000002",
  liveOrgId: "00000000-0000-4000-8000-000000000002", environment: "live", kind: "staff", role: "accountant",
  locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "",
};
const saved = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (saved === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = saved; });
const ON = { v3: async () => true, gates: async () => ({ enabled: true }), now: () => new Date("2030-04-30T16:00:00Z") };
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const never: typeof tx = async () => { assert.fail("must not start a transaction"); };

test("brand OFF precedes admission and flags; today OFF precedes the business transaction", async () => {
  const gates = async () => { assert.fail("must not read item flags"); };
  assert.deepEqual(await staffOverdueTurns({ ...session, kind: "tenant", role: null }, { v3: async () => false, gates, transaction: never }), { state: "off" });
  assert.deepEqual(await staffOverdueTurns(session, { ...ON, gates: async () => ({ enabled: false }), transaction: never }), { state: "off" });
});

test("pay.record and staff identity are required before item flags or business tx", async () => {
  const gates = async () => { assert.fail("denial must precede flags"); };
  for (const denied of [
    { ...session, role: "maintenance" as const }, { ...session, role: null },
    { ...session, kind: "tenant" as const }, { ...session, kind: "owner" as const },
  ]) await assert.rejects(staffOverdueTurns(denied, { ...ON, gates, transaction: never }), forbidden);
});

test("flag, clock and transaction failures are unavailable; forbidden is rethrown", async () => {
  const broken = async () => { throw new Error("synthetic failure"); };
  for (const deps of [{ v3: broken }, { gates: broken }, { now: () => new Date(NaN) }, { transaction: broken }]) {
    assert.deepEqual(await staffOverdueTurns(session, { ...ON, transaction: never, ...deps }), { state: "unavailable" });
  }
  await assert.rejects(staffOverdueTurns(session, { ...ON, transaction: async () => { throw new FlowError("errors.forbidden"); } }), forbidden);
  const failingRead = (org: string) => brandV3ReadForOrg(org, {}, broken);
  const offRead = (org: string) => brandV3ReadForOrg(org, {}, async () => ({ v2: true, v3: false }));
  assert.deepEqual(await staffOverdueTurns(session, { ...ON, v3: failingRead, transaction: never }), { state: "unavailable" });
  assert.deepEqual(await staffOverdueTurns(session, { ...ON, v3: offRead, transaction: never }), { state: "off" });
});

test("ready shape preserves exact money, nullable name/reminders, uncapped count and SQL order in one scoped snapshot", async () => {
  let clocks = 0;
  const calls: string[] = [];
  const rows = [
    { lease_id: "a", currency: "TWD", amount_minor: "9007199254740993", oldest_due_date: "2030-03-01", oldest_month: 2, day_number: 61, tenant_name: "Synthetic", place: "Property 2F A" },
    { lease_id: "a", currency: "USD", amount_minor: "42", oldest_due_date: "2030-03-01", oldest_month: 2, day_number: 61, tenant_name: "Synthetic", place: "Property 2F A" },
    { lease_id: "b", currency: "TWD", amount_minor: "100", oldest_due_date: "2030-04-30", oldest_month: 4, day_number: 1, tenant_name: null, place: "Property 3F" },
  ];
  const transaction: typeof tx = async (userId, fn, scope, options) => {
    assert.equal(userId, session.userId);
    assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    return fn({ query: async (sql: string, args?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("app.has_role")) return { rows: [{ ok: true }] };
      if (sql === COUNTS_SQL_FOR_TEST || sql === LISTS_SQL_FOR_TEST) {
        assert.deepEqual(args?.slice(0, 3), [session.orgId, ON.now().toISOString(), "live"]);
        if (sql === LISTS_SQL_FOR_TEST) { assert.equal(args?.[3], OVERDUE_TURN_LIST_LIMIT); return { rows }; }
        return { rows: [{ count: 80 }] };
      }
      assert.equal(sql, "SET LOCAL statement_timeout = '2s'");
      return { rows: [] };
    } } as unknown as Client);
  };
  assert.deepEqual(await staffOverdueTurns(session, { ...ON, transaction, now: () => { clocks++; return ON.now(); } }), {
    state: "ready", count: 80, others: rows.map(r => ({ leaseId: r.lease_id, currency: r.currency, amountMinor: r.amount_minor,
      oldestDueDate: r.oldest_due_date, oldestMonth: r.oldest_month, dayNumber: r.day_number,
      tenantName: r.tenant_name, place: r.place, reminderCount: null })),
  });
  assert.equal(clocks, 1);
  assert.ok(calls.indexOf(COUNTS_SQL_FOR_TEST) < calls.indexOf(LISTS_SQL_FOR_TEST));
});

test("empty success differs from failed, incomplete or refused reads", async () => {
  for (const mode of ["empty", "member-denied", "list-error", "missing-count", "missing-period"] as const) {
    const transaction: typeof tx = async (_user, fn) => fn({ query: async (sql: string) => {
      if (sql.includes("app.has_role")) return { rows: [{ ok: mode !== "member-denied" }] };
      if (sql === COUNTS_SQL_FOR_TEST) return { rows: mode === "missing-count" ? [] : [{ count: mode === "empty" ? 0 : 1 }] };
      if (sql === LISTS_SQL_FOR_TEST) {
        if (mode === "list-error") throw new Error("synthetic timeout after counts");
        if (mode === "missing-period") return { rows: [{ oldest_month: null }] };
      }
      return { rows: [] };
    } } as unknown as Client);
    if (mode === "member-denied") await assert.rejects(staffOverdueTurns(session, { ...ON, transaction }), forbidden);
    else assert.deepEqual(await staffOverdueTurns(session, { ...ON, transaction }), mode === "empty"
      ? { state: "ready", count: 0, others: [] } : { state: "unavailable" });
  }
});

test("SQL reuses exact P1/P2, is read-only, counts before cap, orders by due/lease/currency before limiting", () => {
  for (const sql of [COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST]) {
    assert.ok(sql.startsWith(PAYMENT_TURN_MATTERS_SQL));
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
    assert.doesNotMatch(sql, /\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i);
    assert.doesNotMatch(sql, /b010_source_events|b028_.*(?:claims|attempts)/);
  }
  assert.match(COUNTS_SQL_FOR_TEST, /SELECT count\(\*\)::int AS count FROM overdue$/);
  assert.match(LISTS_SQL_FOR_TEST, /ORDER BY oldest_due_date, lease_id, currency LIMIT \$4/);
  assert.match(LISTS_SQL_FOR_TEST, /ORDER BY m.oldest_due_date, m.lease_id, m.currency$/);
});
