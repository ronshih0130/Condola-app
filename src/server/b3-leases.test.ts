import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { brandLease, brandLeases, LEASE_ONE_SQL, leasesListSql, leasesSearchTerms, leasesSummarySql, LEASE_ENDING_SOON_DAYS } from "./b3-leases";
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
  assert.deepEqual(await brandLease({ ...session, kind: "tenant" }, "bad", { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await brandLeases(session, {}, { v3: async () => { throw Error("synthetic"); }, transaction: never }), { state: "unavailable" });
  assert.deepEqual(await brandLease(session, id(9), { v3: async () => { throw Error("synthetic"); }, transaction: never }), { state: "unavailable" });
});
test("R3-LIST admits admin and manager only: accountant, maintenance, portals and sandbox gates are 403 before data", async () => {
  for (const s of [{ ...session, role: "accountant" as const }, { ...session, role: "maintenance" as const }, { ...session, role: null },
    { ...session, kind: "tenant" as const }, { ...session, kind: "owner" as const }, { ...session, needsSandbox: true }])
    await assert.rejects(brandLeases(s, {}, { ...on, transaction: never }), denied);
  // The current membership decides, never the session's role.
  await assert.rejects(brandLeases(session, {}, { ...on, transaction: mock(() => assert.fail("no data"), "accountant") }), denied);
  await assert.rejects(brandLeases(session, {}, { ...on, transaction: mock(() => assert.fail("no data"), null) }), denied);
});
test("lease page admits admin, manager and accountant (read only); maintenance and portals are 403", async () => {
  for (const s of [{ ...session, role: "maintenance" as const }, { ...session, role: null }, { ...session, kind: "tenant" as const },
    { ...session, kind: "owner" as const }, { ...session, needsSandbox: true }])
    await assert.rejects(brandLease(s, id(9), { ...on, transaction: never }), denied);
  await assert.rejects(brandLease(session, id(9), { ...on, transaction: mock(() => assert.fail("no data"), null) }), denied);
  const record = { id: id(9), tenant: "Person", place: "Unit", status: "active", startDate: "2026-01-01", endDate: null, currency: "TWD",
    rentMinor: "1800000", depositMinor: "3600000", dueDay: 5, phone: "+19995550123", email: "x@example.test" };
  for (const role of ["admin", "manager", "accountant"]) {
    const data = await brandLease({ ...session, role: role as Session["role"] }, id(9), { ...on, transaction: mock((sql, args) => {
      assert.equal(sql, LEASE_ONE_SQL); assert.deepEqual(args, [session.orgId, id(9)]); return [record];
    }, role) });
    assert.deepEqual(data, { state: "ready", id: id(9), tenant: "Person", place: "Unit", status: "active", startDate: "2026-01-01", endDate: null,
      currency: "TWD", rentMinor: "1800000", depositMinor: "3600000", dueDay: 5 });
  }
});
test("lease page: malformed id and missing/foreign lease are not found", async () => {
  assert.deepEqual(await brandLease(session, "not-a-uuid", { ...on, transaction: never }), { state: "not_found" });
  assert.deepEqual(await brandLease(session, id(9), { ...on, transaction: mock(() => []) }), { state: "not_found" });
  assert.match(LEASE_ONE_SQL, /WHERE l\.org_id=\$1/); assert.match(LEASE_ONE_SQL, /AND l\.id=\$2::uuid/);
  assert.doesNotMatch(LEASE_ONE_SQL, /phone|email|line_user_id|identity/);
});
test("list: counts, 50-row pages by offset, literal search, captured instant and DTO without contact fields", async () => {
  const first = await brandLeases(session, { q: "%_\\", page: "2" }, { ...on, transaction: mock((sql, args) => {
    if (sql === SUMMARY) { assert.deepEqual(args, [session.orgId, "%\\%\\_\\\\%"]); return [{ total: 120, filteredCount: 70 }]; }
    assert.equal(sql, LIST); assert.deepEqual(args, [session.orgId, "%\\%\\_\\\\%", "2026-11-15T08:00:00.000Z", 51, 50]);
    return Array.from({ length: 51 }, (_, n) => row(n + 10));
  }) });
  assert.equal(first.state, "ready"); if (first.state !== "ready") assert.fail();
  assert.equal(first.total, 120); assert.equal(first.filteredCount, 70); assert.equal(first.page, 2); assert.equal(first.hasNext, true);
  assert.equal(first.rows.length, 50); assert.equal(first.rows[0].endingSoon, true); assert.equal(first.rows[1].endingSoon, false);
  assert.equal("phone" in first.rows[0], false);
  const last = await brandLeases(session, {}, { ...on, transaction: mock((sql, args) => sql === SUMMARY ? [{ total: 1, filteredCount: 1 }] : (assert.equal(args[4], 0), [row(1)])) });
  if (last.state !== "ready") assert.fail(); assert.equal(last.hasNext, false); assert.equal(last.q, "");
});
test("data errors become unavailable, not a zero or an empty list", async () => {
  assert.deepEqual(await brandLeases(session, {}, { ...on, transaction: mock(() => { throw new Error("timeout"); }) }), { state: "unavailable" });
  assert.deepEqual(await brandLeases(session, {}, { ...on, transaction: mock(sql => sql === SUMMARY ? [] : []) }), { state: "unavailable" });
  assert.deepEqual(await brandLease(session, id(9), { ...on, transaction: mock(() => { throw new Error("timeout"); }) }), { state: "unavailable" });
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
test("OFF parity: /m/leases/[id] legacy page is byte-identical once the v3 gate is removed", () => {
  const current = readFileSync("src/app/m/leases/[id]/page.tsx", "utf8");
  const stripped = stripImports(current, ['import { Suspense } from "react";', 'import { brandV3EnabledForOrg } from "@/server/brand-v3";',
    'import { LeaseV3Page } from "@/components/v3/m/leases/page";', 'import { LeaseLoading, leaseV3View } from "@/components/v3/m/leases/lease";'])
    .replace(/  if \(leaseV3View\(query\) && await brandV3EnabledForOrg\(session\.orgId\)\) \{\n[\s\S]*?\n  \}\n/, "");
  assert.equal(createHash("sha256").update(stripped).digest("hex"), "7e563b7c2dfc90f9e7d6c7b0e59e433aa25419c4252dae906249dbc86f7718ee");
  // The gate runs after the existing id check and before any legacy reader.
  assert.ok(current.indexOf("leaseV3View(query)") > current.indexOf("if (!isUuid(id)) notFound();"));
  assert.ok(current.indexOf("leaseV3View(query)") < current.indexOf("await leaseDetail(session, id)"));
});
test("handover page and lease layout stay untouched; readers are read-only and pinned in the B-017 registry", () => {
  const registry = JSON.parse(readFileSync("src/server/b017-entry-permissions.json", "utf8"));
  assert.equal(registry["src/server/b3-leases.ts#brandLeases"], "leases.edit");
  assert.equal(registry["src/server/b3-leases.ts#brandLease"], "props.view");
  const source = readFileSync("src/server/b3-leases.ts", "utf8");
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|svc\(|withEffectiveAuthority)\b/);
  for (const file of ["src/app/m/handover/[leaseId]/page.tsx", "src/app/m/leases/[id]/layout.tsx"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /brand-v3|v3\/m\/leases/, file);
});
