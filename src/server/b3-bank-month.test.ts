import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { readFileSync } from "node:fs";
import { BANK_ADMISSION_SQL_FOR_TEST as ADMIT, BANK_CALENDAR_SQL_FOR_TEST as CALENDAR,
  BANK_SUMMARY_SQL_FOR_TEST as SUMMARY, BANK_LIST_SQL_FOR_TEST as LIST,
  bankMonth, bankCandidateState } from "./b3-bank-month";
import { brandV3ReadForOrg } from "./brand-v3";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session: Session = { userId: id(1), sessionId: id(2), orgId: id(3), liveOrgId: id(3), environment: "live", kind: "staff",
  role: "accountant", name: "Synthetic", email: "", leaseId: null, locale: "en", calendar: "gregorian" };
const ON = { v3: async () => true, now: () => new Date("2030-05-01T00:30:00Z") };
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const saved = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (saved === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = saved; });
let neverCalls = 0;
const never: typeof tx = async () => { neverCalls++; throw new Error("unexpected transaction"); };
test.afterEach(() => { assert.equal(neverCalls, 0); neverCalls = 0; });
const counts = { all: 103, review: 80, matched: 20, ignored: 3 };
const summary = { ...counts, lastUploadAt: "2030-06-01T12:00:00.123456Z", accounts: [{ id: id(4), nickname: "Synthetic", currency: "TWD" }] };
const candidate = { paymentId: id(7), suggestionId: id(8), name: "Synthetic", paidOn: "2030-05-01", amountMinor: "1000", currency: "TWD",
  invoices: [{ id: id(9), month: "2030-04", number: "SYNTHETIC", amountMinor: "1000" }], reasons: { amount_exact: true, last5: "12345", date_delta_days: 0 } };
const raw = (n: number) => ({ id: id(n), postedOn: "2030-05-01", last5: "12345", amountMinor: "1000", currency: "TWD", memo: null,
  account: "Synthetic", status: "suggested", candidates: [candidate] });
function mockTx(handler: (sql: string, args?: unknown[]) => { rows: unknown[] }, overrides: { staff?: boolean; session?: boolean; enabled?: boolean; scope?: boolean } = {}): typeof tx {
  return async (user, fn, scope, options) => {
    assert.equal(user, session.userId); assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    let first = true;
    return fn({ query: async (sql: string, args?: unknown[]) => {
      if (first) { first = false; assert.equal(sql, "SET LOCAL statement_timeout = '2s'"); return { rows: [] }; }
      if (sql.includes("SELECT app.has_role")) { assert.match(sql, /'\{admin,accountant\}'/); return { rows: [{ ok: overrides.staff ?? true }] }; }
      if (sql === ADMIT) { assert.deepEqual(args, [session.orgId, session.sessionId, session.userId, session.environment, session.liveOrgId]); return { rows: [{ valid_scope: overrides.scope ?? true, valid_session: overrides.session ?? true, enabled: overrides.enabled ?? true }] }; }
      if (sql === CALENDAR) { assert.deepEqual(args, [session.orgId, ON.now().toISOString()]); return { rows: [{ month: "2030-04", timezone: "America/Los_Angeles" }] }; }
      return handler(sql, args);
    } } as unknown as Client);
  };
}
const ready = async (input: Parameters<typeof bankMonth>[1], transaction: typeof tx) => {
  const result = await bankMonth(session, input, { ...ON, transaction }); assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("not ready"); return result;
};

test("OFF avoids admission, validation and every bank query; lookup failures are unavailable", async () => {
  assert.deepEqual(await bankMonth({ ...session, kind: "tenant" }, { month: "bad" }, { v3: async () => false, transaction: never }), { state: "off" });
  const broken = async () => { throw new Error("synthetic flag failure"); };
  assert.deepEqual(await bankMonth(session, {}, { v3: org => brandV3ReadForOrg(org, {}, broken), transaction: never }), { state: "unavailable" });
});

test("literal bank.reconcile denies manager, maintenance, portal and missing role before bank tx", async () => {
  for (const deniedSession of [{ ...session, role: "manager" as const }, { ...session, role: "maintenance" as const },
    { ...session, kind: "owner" as const }, { ...session, kind: "tenant" as const }, { ...session, role: null }, { ...session, needsSandbox: true }]) {
    await assert.rejects(bankMonth(deniedSession, {}, { ...ON, transaction: never }), denied);
  }
});

test("candidate precedence: none, exact singleton, partial singleton, multiple, all-same-day wins; manual options never inflate suggestions", () => {
  const exact = { suggestionId: id(8), basis: { amountExact: true, last5Matched: true, dateDeltaDays: 0 } };
  const partial = { ...exact, basis: { ...exact.basis, dateDeltaDays: 2 } };
  const manual = { ...exact, suggestionId: null };
  assert.deepEqual(bankCandidateState([]), { kind: "none", count: 0 });
  assert.deepEqual(bankCandidateState([manual]), { kind: "none", count: 0 });
  assert.deepEqual(bankCandidateState([exact, manual]), { kind: "exact", count: 1 });
  for (const basis of [{ amountExact: false, last5Matched: true, dateDeltaDays: 0 }, { amountExact: true, last5Matched: false, dateDeltaDays: 0 },
    { amountExact: true, last5Matched: true, dateDeltaDays: null }, partial.basis]) {
    assert.deepEqual(bankCandidateState([{ ...exact, basis }]), { kind: "possible", count: 1 });
  }
  assert.deepEqual(bankCandidateState([exact, partial]), { kind: "possible", count: 2 });
  assert.deepEqual(bankCandidateState([exact, { ...exact, basis: { ...exact.basis, last5Matched: false } }]), { kind: "same_day", count: 2 });
  assert.deepEqual(bankCandidateState([exact, exact, partial]), { kind: "possible", count: 3 }, "all eligible suggestions must meet equal date/amount, not just a subset");
});

test("ready shape: uncapped reconciling counts, all-time upload, factual allocations, 50+1 rows and scoped keyset", async () => {
  const seen: string[] = [];
  const first = await ready({ month: "2030-05" }, mockTx((sql, args) => {
    seen.push(sql); assert.deepEqual(args?.slice(0, 2), [session.orgId, "2030-05-01"]);
    if (sql === SUMMARY) return { rows: [summary] };
    assert.equal(sql, LIST); assert.deepEqual(args?.slice(2), ["review", null, null, 51]);
    return { rows: Array.from({ length: 51 }, (_, n) => raw(100 - n)) };
  }));
  assert.deepEqual(seen, [SUMMARY, LIST]); assert.equal(first.rows.length, 50); assert.equal(first.filteredCount, 80);
  assert.deepEqual(first.counts, counts); assert.equal(first.timezone, "America/Los_Angeles");
  assert.equal(first.lastUploadAt, summary.lastUploadAt); assert.equal(first.lastUploadScope, "org_unarchived_accounts_all_time");
  assert.deepEqual(first.rows[0].candidateState, { kind: "exact", count: 1 });
  assert.deepEqual(first.rows[0].candidates[0].invoices, candidate.invoices);
  assert.equal("reasons" in first.rows[0].candidates[0], false); assert.ok(first.nextCursor);
  const second = await ready({ month: "2030-05", cursor: first.nextCursor }, mockTx((sql, args) => {
    if (sql === SUMMARY) return { rows: [summary] };
    assert.deepEqual(args?.slice(2), ["review", "2030-05-01", id(51), 51]); return { rows: [raw(50)] };
  }));
  assert.equal(second.nextCursor, null); assert.deepEqual(second.counts, counts);
  for (const changed of [{ month: "2030-04" }, { month: "2030-05", filter: "matched" as const }]) {
    let business = 0;
    const result = await bankMonth(session, { ...changed, cursor: first.nextCursor }, { ...ON, transaction: mockTx(() => { business++; return { rows: [] }; }) });
    assert.equal(result.state, "unavailable"); assert.equal(business, 0);
  }
});

test("default month comes from the organization's calendar, not the server UTC month", async () => {
  const result = await ready({}, mockTx((sql, args) => {
    assert.equal(args?.[1], "2030-04-01"); return { rows: sql === SUMMARY ? [{ ...summary, all: 0, matched: 0, review: 0, ignored: 0 }] : [] };
  }));
  assert.equal(result.month, "2030-04"); assert.equal(result.filter, "review"); assert.equal(result.counts.all, 0);
});

test("missing membership or expired session throws forbidden; disabled item and incomplete/failed reads never yield zero", async () => {
  for (const overrides of [{ staff: false }, { session: false }, { scope: false }]) await assert.rejects(bankMonth(session, {}, { ...ON,
    transaction: mockTx(() => { throw new Error("unexpected business read"); }, overrides) }), denied);
  assert.deepEqual(await bankMonth(session, {}, { ...ON, transaction: mockTx(() => { throw new Error("unexpected business read"); }, { enabled: false }) }), { state: "unavailable" });
  for (const mode of ["missing", "bad_counts", "timeout"] as const) {
    assert.deepEqual(await bankMonth(session, {}, { ...ON, transaction: mockTx(sql => {
      if (sql === SUMMARY) return { rows: mode === "missing" ? [] : [{ ...summary, all: mode === "bad_counts" ? 1 : counts.all }] };
      throw new Error("statement timeout");
    }) }), { state: "unavailable" });
  }
});

test("invalid month/filter rejected before tx; malformed and forged cursor before summary/list", async () => {
  for (const month of ["", "0000-01", "2030-0", "2030-13", "2030-01-01", "2030-01' OR true--"]) {
    assert.deepEqual(await bankMonth(session, { month }, { ...ON, transaction: never }), { state: "unavailable" });
  }
  assert.deepEqual(await bankMonth(session, { filter: "ignored" as never }, { ...ON, transaction: never }), { state: "unavailable" });
  const scope = { v: 1, org: session.orgId, month: "2030-05", filter: "review", date: "2030-05-01", id: id(1) };
  const forged = [{ org: id(99) }, { month: "2030-04" }, { filter: "all" }, { date: "2030-05-32" }, { id: "bad" }, { v: 2 }]
    .map(change => Buffer.from(JSON.stringify({ ...scope, ...change })).toString("base64url"));
  for (const cursor of ["", "!", "x".repeat(2049), Buffer.from("null").toString("base64url"), ...forged]) {
    let calls = 0;
    assert.deepEqual(await bankMonth(session, { month: "2030-05", cursor }, { ...ON, transaction: mockTx(() => { calls++; return { rows: [] }; }) }), { state: "unavailable" });
    assert.equal(calls, 0);
  }
});

test("read SQL keeps org/account/month/eligibility boundaries and B-017 registration", () => {
  for (const sql of [ADMIT, CALENDAR, SUMMARY, LIST]) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b|FOR SHARE|service_role|enable_seqscan/i);
  assert.match(LIST, /p\.bank_transaction_id IS NULL/); assert.match(LIST, /p\.status IN \('submitted','confirmed'\)/);
  assert.match(LIST, /p\.currency = b\.currency AND p\.amount_minor = b\.amount_minor/);
  assert.match(LIST, /a\.archived_at IS NULL/); assert.match(LIST, /ORDER BY posted_on DESC, id DESC LIMIT \$6/);
  assert.doesNotMatch(SUMMARY, /LIMIT/);
  const registry = JSON.parse(readFileSync("src/server/b017-entry-permissions.json", "utf8"));
  assert.equal(registry["src/server/b3-bank-month.ts#bankMonth"], "bank.reconcile");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["test:unit"].split("&&")[0], /src\/server\/b3-bank-month\.test\.ts/);
  assert.ok(pkg.scripts["test:rls"].split("&&").some((segment: string) => segment.trim() === "tsx --test --test-concurrency=1 src/server/b3-bank-month.integration.test.ts"));
});
