import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { brandLeases, leasesListSql, leasesSearchTerms, leasesSummarySql, LEASE_ENDING_SOON_DAYS } from "./b3-leases";
import { TENANTS_ADMISSION_SQL as ADMIT } from "./b3-tenants";
import { leaseSearchSql } from "./list-search";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session: Session = { userId: id(1), sessionId: id(2), orgId: id(3), liveOrgId: id(3), environment: "live", kind: "staff", role: "manager",
  locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
const on = { v3: async () => true, now: () => new Date("2026-11-15T08:00:00.000Z") };
const saved = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (saved === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = saved; });
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const never: typeof tx = async () => { assert.fail("Unexpected transaction"); };
function mock(handler: (sql: string, args: unknown[]) => unknown[], role: string | null = "manager"): typeof tx {
  return async (user, fn, scope, options) => {
    assert.equal(user, session.userId); assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    let first = true;
    return fn({ query: async (sql: string, args: unknown[] = []) => {
      if (first) { first = false; assert.equal(sql, "SET LOCAL statement_timeout = '2s'"); return { rows: [] }; }
      if (sql === ADMIT) return { rows: role ? [{ role, directory: false, mobileRequired: false }] : [] };
      return { rows: handler(sql, args) };
    } } as unknown as Client);
  };
}
const row = (n: number) => ({ id: id(n), tenant: `Person ${n}`, place: "Unit", status: "active", endDate: "2027-01-01", endingSoon: n === 10, phone: "+19995550123" });
const LIST = leasesListSql(true), SUMMARY = leasesSummarySql(true);

test("OFF avoids data and permission work; flag lookup error becomes unavailable", async () => {
  assert.deepEqual(await brandLeases({ ...session, kind: "tenant" }, {}, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await brandLeases(session, {}, { v3: async () => { throw Error("synthetic"); }, transaction: never }), { state: "unavailable" });
});
test("R3-LIST admits admin and manager only: accountant, maintenance, portals and sandbox gates are 403 before data", async () => {
  for (const s of [{ ...session, role: "accountant" as const }, { ...session, role: "maintenance" as const }, { ...session, role: null },
    { ...session, kind: "tenant" as const }, { ...session, kind: "owner" as const }, { ...session, needsSandbox: true }])
    await assert.rejects(brandLeases(s, {}, { ...on, transaction: never }), denied);
  // The current membership decides, never the session's role.
  await assert.rejects(brandLeases(session, {}, { ...on, transaction: mock(() => assert.fail("no data"), "accountant") }), denied);
  await assert.rejects(brandLeases(session, {}, { ...on, transaction: mock(() => assert.fail("no data"), null) }), denied);
});
test("list: counts, 50-row pages by offset, literal search, captured instant and DTO without contact fields", async () => {
  const first = await brandLeases(session, { q: "%_\\", page: "2" }, { ...on, transaction: mock((sql, args) => {
    if (sql === SUMMARY) { assert.deepEqual(args, [session.orgId, "%\\%\\_\\\\%"]); return [{ total: 120, filteredCount: 70 }]; }
    assert.equal(sql, LIST); assert.deepEqual(args, [session.orgId, "%\\%\\_\\\\%", "2026-11-15T08:00:00.000Z", 51, 50]);
    return Array.from({ length: 51 }, (_, n) => row(n + 10));
  }) });
  assert.equal(first.state, "ready"); if (first.state !== "ready") assert.fail();
  assert.equal(first.total, 120); assert.equal(first.filteredCount, 70); assert.equal(first.lastPage, 2); assert.equal(first.page, 2); assert.equal(first.hasNext, true);
  assert.equal(first.rows.length, 50); assert.equal(first.rows[0].endingSoon, true); assert.equal(first.rows[1].endingSoon, false);
  assert.equal("phone" in first.rows[0], false);
  const last = await brandLeases(session, {}, { ...on, transaction: mock((sql, args) => sql === SUMMARY ? [{ total: 1, filteredCount: 1 }] : (assert.equal(args[4], 0), [row(1)])) });
  if (last.state !== "ready") assert.fail(); assert.equal(last.hasNext, false); assert.equal(last.q, ""); assert.equal(last.lastPage, 1);
  const none = await brandLeases(session, { q: "x" }, { ...on, transaction: mock(sql => sql === SUMMARY ? [{ total: 3, filteredCount: 0 }] : []) });
  if (none.state !== "ready") assert.fail(); assert.equal(none.lastPage, 1); assert.equal(none.filteredCount, 0);
});
test("data errors become unavailable, not a zero or an empty list", async () => {
  assert.deepEqual(await brandLeases(session, {}, { ...on, transaction: mock(() => { throw new Error("timeout"); }) }), { state: "unavailable" });
  assert.deepEqual(await brandLeases(session, {}, { ...on, transaction: mock(sql => sql === SUMMARY ? [] : []) }), { state: "unavailable" });
});
test("search matches the legacy list; contact terms only with tenants.contact authority", () => {
  assert.equal(`AND ($2::text IS NULL OR ${leasesSearchTerms(true)})`, leaseSearchSql());
  assert.doesNotMatch(leasesSearchTerms(false), /phone|email|has_role/);
  assert.match(leasesSearchTerms(false), /c\.display_name/);
  assert.doesNotMatch(leasesListSql(false), /phone_e164|email/);
  assert.match(SUMMARY, /count\(\*\)::int AS total/); assert.match(SUMMARY, /FILTER \(WHERE \$2::text IS NULL OR/);
});
test("即將到期 = active and ending within 60 days of the property's own calendar; legacy population and order", () => {
  assert.equal(LEASE_ENDING_SOON_DAYS, 60);
  assert.match(LIST, /l\.status='active' AND l\.end_date IS NOT NULL/);
  assert.match(LIST, /BETWEEN \(\$3::timestamptz AT TIME ZONE p\.timezone\)::date\s+AND \(\$3::timestamptz AT TIME ZONE p\.timezone\)::date \+ 60/);
  assert.doesNotMatch(LIST, /Asia\/Taipei/);
  assert.match(LIST, /JOIN lease_parties lp ON lp\.lease_id=l\.id AND lp\.org_id=l\.org_id AND lp\.role='primary'/);
  assert.match(LIST, /ORDER BY l\.created_at DESC, l\.id LIMIT \$4 OFFSET \$5/);
  assert.doesNotMatch(LIST, /rent_amount_minor|deposit_amount_minor/);
});

const stripImports = (source: string, lines: string[]) => lines.reduce((s, line) => {
  assert.ok(s.startsWith(`${line}\n`), line); return s.slice(line.length + 1);
}, source);
test("OFF parity: /m/leases legacy branch is byte-identical once the v3 gate is removed", () => {
  const current = readFileSync("src/app/m/leases/page.tsx", "utf8");
  const stripped = stripImports(current, ['import { Suspense } from "react";', 'import { brandV3EnabledForOrg } from "@/server/brand-v3";',
    'import { LeasesV3Page } from "@/components/v3/m/leases/page";', 'import { LeasesLoading } from "@/components/v3/m/leases/leases";'])
    .replace(/  if \(await brandV3EnabledForOrg\(session\.orgId\)\) \{\n[\s\S]*?\n  \}\n/, "");
  // origin/main 578cdfd, frozen independently of HEAD.
  assert.equal(createHash("sha256").update(stripped).digest("hex"), "cd1d7e9a0c96e1d7aa6e9bc42496486b6414587774888350293ac0b824602006");
});
test("/m/leases/[id] is the existing page for every request and query: byte-identical to origin/main", () => {
  const current = readFileSync("src/app/m/leases/[id]/page.tsx", "utf8");
  // origin/main 578cdfd, frozen independently of HEAD. No brand_v3 branch, so no query reaches a v3 page.
  assert.equal(createHash("sha256").update(current).digest("hex"), "7e563b7c2dfc90f9e7d6c7b0e59e433aa25419c4252dae906249dbc86f7718ee");
  assert.doesNotMatch(current, /brand-v3|brandV3|components\/v3/);
  assert.equal(existsSync("src/components/v3/m/leases/lease.tsx"), false);
});
test("handover page and lease layout stay untouched; the list reader is read-only and pinned in the B-017 registry", () => {
  const registry = JSON.parse(readFileSync("src/server/b017-entry-permissions.json", "utf8"));
  assert.equal(registry["src/server/b3-leases.ts#brandLeases"], "leases.edit");
  assert.equal("src/server/b3-leases.ts#brandLease" in registry, false);
  const source = readFileSync("src/server/b3-leases.ts", "utf8");
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|svc\(|withEffectiveAuthority)\b/);
  assert.doesNotMatch(source, /export async function brandLease\b|LEASE_ONE_SQL/);
  for (const file of ["src/app/m/handover/[leaseId]/page.tsx", "src/app/m/leases/[id]/layout.tsx"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /brand-v3|v3\/m\/leases/, file);
});
