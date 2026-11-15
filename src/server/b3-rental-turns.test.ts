import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, RENTAL_TURN_LIST_LIMIT, staffRentalTurns } from "./b3-rental-turns";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const session: Session = {
  userId: "00000000-0000-4000-8000-000000000001", sessionId: "s", orgId: "00000000-0000-4000-8000-000000000002",
  liveOrgId: "00000000-0000-4000-8000-000000000002", environment: "live", kind: "staff", role: "manager",
  locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "",
};
// Native session admission must be DB-free even on a developer machine with an allowlist.
const saved = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (saved === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = saved; });
const ON = { v3: async () => true, gates: async () => ({ enabled: true, vacant: true, earlyVacancy: true }), now: () => new Date("2030-04-30T16:00:00Z") };
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const never: typeof tx = async () => { assert.fail("must not start a transaction"); };

test("brand OFF precedes admission and all other reads; today OFF precedes business tx", async () => {
  const gates = async () => { assert.fail("must not read item flags"); };
  assert.deepEqual(await staffRentalTurns({ ...session, kind: "tenant", role: null }, { v3: async () => false, gates, transaction: never }), { state: "off" });
  assert.deepEqual(await staffRentalTurns(session, { ...ON, gates: async () => ({ enabled: false, vacant: true, earlyVacancy: true }), transaction: never }), { state: "off" });
});

test("R7: staff session shape and native role deny before flags or transaction", async () => {
  const gates = async () => { assert.fail("denial must precede flag lookup"); };
  for (const denied of [
    { ...session, role: "accountant" as const }, { ...session, role: "maintenance" as const },
    { ...session, role: null }, { ...session, kind: "tenant" as const }, { ...session, kind: "owner" as const },
  ]) await assert.rejects(staffRentalTurns(denied, { ...ON, gates, transaction: never }), forbidden);
});

test("operational errors at flag, clock and transaction boundaries are unavailable; forbidden stays forbidden", async () => {
  const broken = async () => { throw new Error("synthetic failure"); };
  assert.deepEqual(await staffRentalTurns(session, { ...ON, v3: broken, transaction: never }), { state: "unavailable" });
  assert.deepEqual(await staffRentalTurns(session, { ...ON, gates: broken, transaction: never }), { state: "unavailable" });
  assert.deepEqual(await staffRentalTurns(session, { ...ON, now: () => new Date(NaN), transaction: never }), { state: "unavailable" });
  assert.deepEqual(await staffRentalTurns(session, { ...ON, transaction: broken }), { state: "unavailable" });
  await assert.rejects(staffRentalTurns(session, { ...ON, transaction: async () => { throw new FlowError("errors.forbidden"); } }), forbidden);
});

test("ready DTO, uncapped counts, calendar boundary, shared list cap and scoped read-only snapshot", async () => {
  let clocks = 0;
  const calls: string[] = [];
  const rows = [
    { kind: "renewal_ask", target_kind: "room", target_id: "r", property_id: "p", place: "Property 2F A", lease_id: "l", date: "2030-05-01", day_number: 0, tenant_name: "Synthetic", rent_minor: null, rent_currency: null, reason: null },
    { kind: "early_vacancy", target_kind: "unit", target_id: "u", property_id: "p", place: "Property 3F", lease_id: "e", date: "2030-05-10", day_number: 9, tenant_name: null, rent_minor: null, rent_currency: null, reason: "declined" },
    { kind: "vacant", target_kind: "unit", target_id: "v", property_id: "p", place: "Property 4F", lease_id: null, date: null, day_number: null, tenant_name: null, rent_minor: "900000", rent_currency: "TWD", reason: null },
  ];
  const transaction: typeof tx = async (userId, fn, scope, options) => {
    assert.equal(userId, session.userId);
    assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    return fn({ query: async (sql: string, args?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("app.has_role")) return { rows: [{ ok: true }] };
      if (sql === COUNTS_SQL_FOR_TEST || sql === LISTS_SQL_FOR_TEST) {
        assert.deepEqual(args?.slice(0, 5), [session.orgId, "2030-05-01", "live", true, true]);
        if (sql === LISTS_SQL_FOR_TEST) { assert.equal(args?.[5], RENTAL_TURN_LIST_LIMIT); return { rows }; }
        return { rows: [{ kind: "vacant", count: 80 }, { kind: "renewal_ask", count: 3 }, { kind: "early_vacancy", count: 2 }] };
      }
      assert.equal(sql, "SET LOCAL statement_timeout = '2s'");
      return { rows: [] };
    } } as unknown as Client);
  };
  const result = await staffRentalTurns(session, { ...ON, transaction, now: () => { clocks++; return ON.now(); } });
  assert.equal(clocks, 1);
  assert.deepEqual(result, { state: "ready", counts: { vacant: 80, renewalAsk: 3, earlyVacancy: 2 }, mine: rows.map(r => ({
    kind: r.kind, targetKind: r.target_kind, targetId: r.target_id, propertyId: r.property_id, place: r.place,
    tenantName: r.tenant_name, leaseId: r.lease_id, date: r.date, dayNumber: r.day_number, rentMinor: r.rent_minor, rentCurrency: r.rent_currency, reason: r.reason,
  })) });
  assert.ok(calls.indexOf(COUNTS_SQL_FOR_TEST) < calls.indexOf(LISTS_SQL_FOR_TEST));
  // R6 ordering is executed in SQL before LIMIT, then preserved by the mapper above.
  assert.match(LISTS_SQL_FOR_TEST, /ORDER BY CASE kind WHEN 'renewal_ask' THEN 0 WHEN 'early_vacancy' THEN 1 ELSE 2 END,\s+date ASC NULLS LAST, coalesce\(lease_id, target_id\), target_kind\s+LIMIT \$6/);
});

test("empty success differs from failed or refused reads, including failure after counts", async () => {
  for (const mode of ["empty", "member-denied", "list-error"] as const) {
    const transaction: typeof tx = async (_user, fn) => fn({ query: async (sql: string) => {
      if (sql.includes("app.has_role")) return { rows: [{ ok: mode !== "member-denied" }] };
      if (sql === LISTS_SQL_FOR_TEST && mode === "list-error") throw new Error("synthetic list timeout");
      return { rows: [] };
    } } as unknown as Client);
    if (mode === "member-denied") await assert.rejects(staffRentalTurns(session, { ...ON, transaction }), forbidden);
    else assert.deepEqual(await staffRentalTurns(session, { ...ON, transaction }), mode === "empty"
      ? { state: "ready", counts: { vacant: 0, renewalAsk: 0, earlyVacancy: 0 }, mine: [] } : { state: "unavailable" });
  }
});


test("§6 failure contract through the real brand helper: a failed brand_v3 read is unavailable, never off", async () => {
  const { brandV3ReadForOrg } = await import("./brand-v3");
  const failingRead = (org: string) => brandV3ReadForOrg(org, {}, async () => { throw new Error("db down"); });
  const offRead = (org: string) => brandV3ReadForOrg(org, {}, async () => ({ v2: true, v3: false }));
  const never = async () => { throw new Error("no business transaction expected"); };
  assert.deepEqual(await staffRentalTurns(session, { ...ON, v3: failingRead, transaction: never as never }), { state: "unavailable" });
  assert.deepEqual(await staffRentalTurns(session, { ...ON, v3: offRead, transaction: never as never }), { state: "off" });
});
