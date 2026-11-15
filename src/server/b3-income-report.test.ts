import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { incomeExpenseLines, incomeExpenseExportData, incomeReportPeriod, revalidateIncomeExport,
  INCOME_REPORT_SUMMARY_SQL, INCOME_REPORT_LIST_SQL, type IncomeReportReady, type IncomeReportLine } from "./b3-income-report";
import { exportIncomeReport, incomeReportCsv } from "./b3-income-report-csv";
import { reportMajor, reportMoney } from "./b3-income-report-format";
import { FlowError } from "./errors";
import type { tx } from "./db";
import { can, noPermHref } from "./perms";
import { areasFor } from "./nav-v3";
import type { Session } from "./types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session: Session = { userId: id(1), sessionId: id(2), orgId: id(3), liveOrgId: id(3), environment: "live",
  kind: "staff", role: "accountant", name: "Synthetic", email: "", leaseId: null, locale: "en", calendar: "gregorian" };
const ON = { v3: async () => true, now: () => new Date("2030-05-01T00:00:00Z") };
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const previous = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(() => { process.env.CUSTOM_ROLES_ORG_ALLOWLIST = ""; });
test.after(() => { if (previous === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = previous; });
const row = (n: number): IncomeReportLine => ({ key: id(n), date: "2030-05-01", kind: "expense", item: "=SUM(1,2)",
  propertyId: id(4), property: "Synthetic, \"property\"", ownerId: id(5), owner: "@owner", currency: "TWD", amountMinor: "9007199254740993",
  sourceAmountMinor: "9007199254740993", sourceId: id(n), invoiceId: null, allocationId: null });
const summary = { count: 80, totals: [{ currency: "TWD", incomeMinor: "100000", expenseMinor: "32000", netMinor: "68000", depositMinor: "1000" }] };
function mockTx(rows: IncomeReportLine[] = [row(7)], overrides: { role?: boolean; summary?: typeof summary; capture?: (sql: string, args?: unknown[]) => void } = {}): typeof tx {
  return async (user, fn, scope, options) => {
    assert.equal(user, session.userId); assert.deepEqual(scope, { orgId: session.orgId, environment: "live" });
    assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
    let first = true;
    return fn({ query: async (sql: string, args?: unknown[]) => {
      overrides.capture?.(sql, args);
      if (first) { first = false; assert.equal(sql, "SET LOCAL statement_timeout = '2s'"); return { rows: [] }; }
      if (sql.includes("SELECT app.has_role")) return { rows: [{ ok: overrides.role ?? true }] };
      if (sql.includes("AT TIME ZONE")) return { rows: [{ today: "2030-04-30", timezone: "America/Los_Angeles" }] };
      if (sql === INCOME_REPORT_SUMMARY_SQL) return { rows: [overrides.summary ?? summary] };
      if (sql === INCOME_REPORT_LIST_SQL) return { rows };
      if (sql.startsWith("SELECT id::text")) return { rows: [] };
      throw new Error(`Unexpected SQL ${sql}`);
    } } as unknown as Client);
  };
}
const ready: IncomeReportReady = { state: "ready", period: incomeReportPeriod({ month: "2030-05" }, "2030-05-01"), timezone: "UTC",
  count: 1, totals: summary.totals, rows: [row(7)], choices: { properties: [], owners: [] }, nextCursor: null };

test("OFF reads no business data and ignores malformed input; denied native/portal actors never open tx", async () => {
  let calls = 0; const never: typeof tx = async () => { calls++; throw new Error("unexpected transaction"); };
  assert.deepEqual(await incomeExpenseLines(session, { month: "bad" }, { v3: async () => false, transaction: never }), { state: "off" });
  for (const subject of [{ ...session, role: "maintenance" as const }, { ...session, role: null },
    { ...session, kind: "owner" as const }, { ...session, kind: "tenant" as const }]) {
    await assert.rejects(incomeExpenseLines(subject, {}, { ...ON, transaction: never }), forbidden);
    await assert.rejects(incomeExpenseExportData(subject, {}, { ...ON, transaction: never }), forbidden);
  }
  assert.equal(calls, 0);
});

test("strict calendar validation: leap days, inclusive ranges, no forged filter broadening", async () => {
  assert.equal(incomeReportPeriod({}, "2030-04-30").month, "2030-04");
  assert.equal(incomeReportPeriod({ month: "2032-02" }, "").end, "2032-02-29");
  assert.equal(incomeReportPeriod({ mode: "range", from: "2030-05-31", to: "2030-05-31" }, "").end, "2030-05-31");
  for (const input of [{ month: "2030-13" }, { mode: "bad" }, { mode: "range", from: "2030-02-29", to: "2030-03-01" },
    { mode: "range", from: "2030-06-01", to: "2030-05-31" }]) assert.throws(() => incomeReportPeriod(input, "2030-05-01"));
  let business = 0;
  const data = await incomeExpenseLines(session, { property: "forged" }, { ...ON, transaction: mockTx([], { capture: sql => { if (sql === INCOME_REPORT_SUMMARY_SQL) business++; } }) });
  assert.equal(data.state, "unavailable"); assert.equal(business, 0);
});

test("one scoped read-only snapshot, organization calendar default, uncapped totals, 50 rows and scoped cursor", async () => {
  const args: unknown[][] = [];
  const data = await incomeExpenseLines(session, {}, { ...ON, transaction: mockTx(Array.from({ length: 51 }, (_, n) => row(n + 10)),
    { capture: (sql, values) => { if (sql === INCOME_REPORT_LIST_SQL) args.push(values!); } }) });
  assert.equal(data.state, "ready"); if (data.state !== "ready") return;
  assert.equal(data.period.month, "2030-04"); assert.equal(data.rows.length, 50); assert.equal(data.count, 80);
  assert.deepEqual(data.totals, summary.totals); assert.ok(data.nextCursor);
  assert.deepEqual(args[0].slice(0, 5), [session.orgId, "2030-04-01", "2030-04-30", null, null]);
  assert.equal(args[0][7], 51);
  const next = await incomeExpenseLines(session, { cursor: data.nextCursor }, { ...ON, transaction: mockTx([row(70)]) });
  assert.equal(next.state, "ready");
  for (const input of [{ month: "2030-05" }, { property: id(6) }, { owner: id(8) }])
    assert.equal((await incomeExpenseLines(session, { ...input, cursor: data.nextCursor }, { ...ON, transaction: mockTx() })).state, "unavailable");
});

test("operational failures are unavailable, current staff denial is forbidden", async () => {
  assert.equal((await incomeExpenseLines(session, {}, { ...ON, v3: async () => { throw new Error("lookup failed"); } })).state, "unavailable");
  await assert.rejects(incomeExpenseLines(session, {}, { ...ON, transaction: mockTx([], { role: false }) }), forbidden);
});

test("export uses all rows in one snapshot and revalidates current native membership", async () => {
  let limit: unknown = 99;
  const data = await incomeExpenseExportData(session, { month: "2030-05", cursor: "ignored" }, { ...ON,
    transaction: mockTx(Array.from({ length: 80 }, (_, n) => row(n + 10)), { capture: (sql, values) => { if (sql === INCOME_REPORT_LIST_SQL) limit = values?.[7]; } }) });
  assert.equal(limit, null); assert.equal(data.rows.length, 80); assert.equal(data.nextCursor, null);
  await assert.rejects(revalidateIncomeExport(session, { ...ON, transaction: mockTx([], { role: false }) }), forbidden);
});

test("CSV exact lines/totals, formula escaping, multiline quoting, large integers, no currency conversion", () => {
  const csv = incomeReportCsv(ready, "en");
  assert.equal(csv, '\uFEFF"Date","Item","Property","Owner","Currency","Amount","Source","Income","Expenses","Net","Deposits"\r\n'
    + `"2030-05-01","Expenses · =SUM(1,2)","Synthetic, ""property""","'@owner","TWD","90071992547409.93","${id(7)}",,,,\r\n`
    + '"","Total",,,"TWD",,,"1000.00","320.00","680.00","10.00"\r\n'.replace('"","Total"', ',"Total"'));
  assert.equal(reportMajor("-9007199254740993"), "-90071992547409.93");
  assert.equal(reportMoney("-101", "TWD", "zh-TW"), "−NT$1.01");
  const multi = incomeReportCsv({ ...ready, rows: [{ ...row(7), property: '\t=attack\n"value"' }],
    totals: [...ready.totals, { currency: "USD", incomeMinor: "1", expenseMinor: "2", netMinor: "-1", depositMinor: "0" }] }, "en");
  assert.ok(multi.includes('"\'\t=attack\n""value"""')); assert.ok(multi.includes('"USD",,,"0.01","0.02","-0.01","0.00"'));
});

test("construction then revalidation then minimal audit; audit/revalidation failures return no CSV", async () => {
  const order: string[] = [];
  const deps = { read: async () => { order.push("read"); return ready; }, revalidate: async () => { order.push("revalidate"); return session; },
    audit: async (event: unknown) => { order.push("audit"); const value = event as Record<string, unknown>;
      assert.deepEqual(Object.keys(value).sort(), ["orgId", "userId", "actorRole", "operationId", "start", "end", "propertyId", "ownerId", "rowCount", "currencyCount"].sort());
      assert.ok(!JSON.stringify(event).includes("Synthetic")); }, operationId: () => id(9) };
  assert.equal(await exportIncomeReport(session, { month: "2030-05" }, deps), incomeReportCsv(ready, "en"));
  assert.deepEqual(order, ["read", "revalidate", "audit"]);
  await assert.rejects(exportIncomeReport(session, {}, { ...deps, audit: async () => { throw new Error("audit failed"); } }), /audit failed/);
  let audit = false;
  await assert.rejects(exportIncomeReport(session, {}, { ...deps, revalidate: async () => { throw new FlowError("errors.forbidden"); },
    audit: async () => { audit = true; } }), forbidden); assert.equal(audit, false);
});

test("stmt.view-only navigation; legacy and nested export gates remain reports.export", () => {
  const viewer: Session = { ...session, customRole: { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId,
    nativeRole: session.role, assigned: true, keys: ["stmt.view"], photos: false, audit: false } };
  assert.equal(can(viewer, "stmt.view"), true); assert.equal(can(viewer, "reports.export"), false);
  assert.ok(areasFor(viewer).flatMap(area => area.links).some(link => link.href === "/m/reports"));
  assert.ok(noPermHref("/m/reports", viewer)); assert.ok(noPermHref("/m/reports/export", viewer));
  const layout = readFileSync("src/app/m/layout.tsx", "utf8");
  assert.ok(layout.includes('/^\\/m\\/reports\\/?$/.test(path) && can(session, "stmt.view")'));
});

// Immutable baseline hashes captured from this branch's HEAD before editing. Only remove
// the explicit ON branch and new imports: every OFF statement/read/render stays byte-identical.
test("OFF page/export legacy bodies and legacy reader stay byte-identical", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  let page = readFileSync("src/app/m/reports/page.tsx", "utf8");
  page = page.slice(page.indexOf('import { ManagementEmptyState'))
    .replace('owner?: string; cursor?: string; error?: string', 'owner?: string; error?: string')
    .replace(/  if \(await brandV3EnabledForOrg\(session.orgId\)\) \{[\s\S]*?\n  \}\n/, "");
  let route = readFileSync("src/app/m/reports/export/route.ts", "utf8");
  route = route.slice(route.indexOf('import { guardEffectiveSession'))
    .replace(/    if \(await brandV3EnabledForOrg\(session.orgId\)\) \{[\s\S]*?\n    \}\n/, "");
  assert.equal(sha(page), "1902b326637a537aa8a979cc38a7dec319039208e78a54e33d2cfc5a4bc3141a"); assert.equal(sha(route), "15bda5dc8e694fb4a1fa127c6176a2931b8aa9143caa82dc004ee8cea53b3db4");
  assert.equal(sha(readFileSync("src/server/income-expense.ts", "utf8")), "1e0d426e7d0f627bec41cd376f550b29077e100530ba70350f012dde4d3c8574");
});

test("financial SQL contract applies cash dates after cumulative allocation, retaining owner/company liability", () => {
  // Policy assertions, paired with executable real-row fixtures in the Mac integration suite.
  assert.ok(INCOME_REPORT_SUMMARY_SQL.indexOf("PARTITION BY invoice_id, currency") < INCOME_REPORT_SUMMARY_SQL.indexOf("date BETWEEN $2::date"));
  assert.ok(!INCOME_REPORT_SUMMARY_SQL.includes("period_start"));
  assert.ok(!INCOME_REPORT_SUMMARY_SQL.includes("unknown_periods"));
  assert.match(INCOME_REPORT_SUMMARY_SQL, /pay\.status = 'confirmed'\s*\)/);
  assert.match(INCOME_REPORT_SUMMARY_SQL, /FROM portions WHERE amount > 0 AND date BETWEEN \$2::date AND \$3::date/);
  assert.match(INCOME_REPORT_SUMMARY_SQL, /e\.status IN \('approved','posted'\) AND e\.bill_to IN \('owner','manager'\)/);
  assert.match(INCOME_REPORT_SUMMARY_SQL, /e\.incurred_on BETWEEN \$2::date AND \$3::date/);
  assert.ok(!INCOME_REPORT_SUMMARY_SQL.includes("repair_cost_on_statement"));
  assert.ok(!INCOME_REPORT_SUMMARY_SQL.includes("paid_by"));
  assert.match(INCOME_REPORT_SUMMARY_SQL, /WHEN charge_type = 'deposit' THEN 'deposit' ELSE 'income'/);
  assert.ok(!INCOME_REPORT_SUMMARY_SQL.includes("LIMIT 50"));
});
