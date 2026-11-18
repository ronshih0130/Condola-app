import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as consent from "./consent";
import * as money from "./money";
import * as payNote from "./pay-note";
import * as repairRules from "./repair-rules";
import * as historyRules from "./tenant-payment-history-rules";
import * as monthlyDue from "./tenant-monthly-due-rules";
import type { Session } from "./types";

// B-090 slice 1 re-land (PENDING-RON PR-043; the #233 revert reason): the shared tenantPaymentHistory reader, which the
// brand_v3 OFF /t and /t/pay pages call, must issue byte-identical SQL text and parameters to origin/main's. RT-HOME
// reads its facts through its own v3-only reader (b090-tenant-home-reader.ts) instead. This test runs origin/main's
// tenant-payment-history.ts and the working tree's side by side against the same scripted database and compares every
// statement, every parameter list, the transaction options and the result.

const BASE = "a0aa278e3e92732b066fdbd74bd8f7430d76df0b"; // origin/main before B-090 slice 1 (re-land)
const PATH = "src/server/tenant-payment-history.ts";
const ORG = "00000000-0000-4000-8000-0000000000a1", USER = "00000000-0000-4000-8000-0000000000a2", SESSION = "00000000-0000-4000-8000-0000000000a3";
const LEASE = "00000000-0000-4000-8000-0000000000b1", INVOICE = "00000000-0000-4000-8000-0000000000c1", REPORT = "00000000-0000-4000-8000-0000000000d1";

type Log = unknown[][];
type Db = { gate: "on" | "off" | "missing"; lease: { status: string } | null; lineMismatch?: boolean; reports?: number };

function compile(source: string, log: Log, db: Db) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const client = { query: async (sql: string, params?: unknown[]) => { log.push(["query", sql, params ?? null]); return respond(sql, db); } };
  const mocks: Record<string, unknown> = {
    "@/server/b017-custom-role-governance": {
      guardEffectiveSession: async (s: Session, permission: unknown) => { log.push(["guard", permission]); return s; },
      withEffectiveAuthority: async (_c: unknown, _s: Session, permission: unknown, fn: () => Promise<unknown>) => { log.push(["authority", permission]); return fn(); },
    },
    "./db": { tx: async (userId: string, fn: (c: unknown) => Promise<unknown>, scope: unknown, options: unknown) => { log.push(["tx", userId, scope, options]); return fn(client); } },
    "./errors": { logServerError: (tag: string) => { log.push(["error", tag]); } },
    "./consent": consent, "./money": money, "./pay-note": payNote, "./repair-rules": repairRules,
    "./tenant-payment-history-rules": historyRules, "./tenant-monthly-due-rules": monthlyDue,
  };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports.tenantPaymentHistory as (s: Session, leaseId: string, options: Record<string, unknown>) => Promise<unknown>;
}

const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
function respond(sql: string, db: Db) {
  const stored = consent.buildStoredConsent("signup", new Date("2026-11-01T00:00:00Z"));
  if (sql.startsWith("SELECT o.feature_flags flags")) {
    if (db.gate === "missing") return rows([]);
    return rows([{ flags: { tenant_payment_history: db.gate === "on" }, global: { enabled: true, allowed_org_ids: [ORG] } }]);
  }
  if (/FROM public\.leases l JOIN public\.organizations o ON o\.id=l\.org_id JOIN public\.properties pr/.test(sql)) {
    return rows(db.lease ? [{ status: db.lease.status, currency: "TWD", timezone: "Asia/Taipei", flags: {}, global: {}, consent: stored }] : []);
  }
  if (sql.includes("FROM public.invoices WHERE")) {
    return rows([{ id: INVOICE, status: "partially_paid", total: "1850000", paid: "350000", balance: "1500000", due_on: "2090-03-05", currency: "TWD" }]);
  }
  if (sql.includes("FROM public.invoice_lines")) {
    return rows([{ invoice_id: INVOICE, charge_type: "rent", amount: db.lineMismatch ? "1" : "1850000", description: "Synthetic rent", period_start: "2090-03-01", line_no: 1, invoice_number: "INV-1" }]);
  }
  if (sql.startsWith("SELECT to_char(p.submitted_at")) return rows([{ submitted_at: "2090-01-10T00:00:00.000000Z" }]);
  if (sql.includes("LIMIT 51")) {
    return rows(Array.from({ length: db.reports ?? 1 }, (_, i) => ({ id: i ? `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` : REPORT, status: "submitted", amount: "350000", currency: "TWD",
      paid_on: "2090-01-10", submitted_at: "2090-01-10T00:00:00.000000Z", confirmed_at: null, rejected_reason: null, payer_contact_id: null })));
  }
  if (sql.endsWith(" pending")) return rows([{ pending: true }]);
  if (sql.endsWith("LIMIT 1") && sql.includes("p.status='submitted'")) return rows([{ amount: "350000", currency: "TWD" }]);
  if (sql.endsWith(" own")) return rows([{ own: false }]);
  if (sql.startsWith("SET LOCAL ROLE")) return rows([]);
  if (sql.includes("FROM public.audit_log")) return rows([]);
  if (sql.startsWith("SELECT 1 FROM public.leases")) return rows([{ "?column?": 1 }]);
  throw new Error(`Unscripted SQL: ${sql.slice(0, 80)}`);
}

const session = (over: Partial<Session> = {}): Session => ({
  userId: USER, sessionId: SESSION, email: "", name: "Synthetic", kind: "tenant", role: null, orgId: ORG, liveOrgId: ORG, environment: "live",
  locale: "zh-TW", calendar: "gregorian", leaseId: LEASE, consent: consent.buildStoredConsent("signup", new Date("2026-11-01T00:00:00Z")), ...over,
} as Session);

const scenarios: { label: string; db: Db; options: Record<string, unknown>; s?: Partial<Session>; lease?: string }[] = [
  { label: "tenant_payment_history gate off (the legacy body's own fallback)", db: { gate: "off", lease: { status: "active" } }, options: { view: "current" } },
  { label: "no org/session context", db: { gate: "missing", lease: null }, options: { view: "current" } },
  { label: "/t: current view, ready", db: { gate: "on", lease: { status: "active" } }, options: { view: "current" } },
  { label: "/t/pay: current view with the TEN-51 turn summary", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", turn: true } },
  { label: "next page by cursor", db: { gate: "on", lease: { status: "active" }, reports: 51 }, options: { view: "current", cursor: REPORT } },
  { label: "one exact report", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", reportId: REPORT } },
  { label: "ended lease view", db: { gate: "on", lease: { status: "ended" } }, options: { view: "ended" } },
  { label: "not a party to the lease", db: { gate: "on", lease: null }, options: { view: "current" } },
  { label: "invoice lines do not add up", db: { gate: "on", lease: { status: "active" }, lineMismatch: true }, options: { view: "current" } },
  { label: "pending-signature lease", db: { gate: "on", lease: { status: "pending_signature" } }, options: { view: "current" } },
  { label: "invalid session: nothing is read", db: { gate: "on", lease: { status: "active" } }, options: { view: "current" }, s: { kind: "staff" } as Partial<Session> },
  { label: "invalid lease id: nothing is read", db: { gate: "on", lease: { status: "active" } }, options: { view: "current" }, lease: "not-a-uuid" },
  // B-090 slice 2: the brand_v3 OFF /t/pay body's own calls. A repeated ?cursor / ?reportId arrives as "!" (refused unread).
  { label: "/t/pay: ?cursor= as the page passes it", db: { gate: "on", lease: { status: "active" }, reports: 51 }, options: { view: "current", cursor: REPORT, reportId: undefined } },
  { label: "/t/pay: ?reportId= as the page passes it", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", cursor: undefined, reportId: REPORT } },
  { label: "/t/pay: repeated ?cursor (\"!\")", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", cursor: "!", reportId: undefined } },
  { label: "/t/pay: repeated ?reportId (\"!\")", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", cursor: undefined, reportId: "!" } },
  { label: "/t/pay: both ?cursor and ?reportId", db: { gate: "on", lease: { status: "active" } }, options: { view: "current", cursor: REPORT, reportId: REPORT } },
  { label: "/t/pay: gate off (the legacy money body follows)", db: { gate: "off", lease: { status: "active" } }, options: { view: "current", cursor: REPORT, reportId: undefined } },
];

test("PR-043 / OQ-107: the shared tenantPaymentHistory reader issues origin/main's exact SQL and parameters (flag-OFF path)", async () => {
  const before = execFileSync("git", ["show", `${BASE}:${PATH}`], { encoding: "utf8" });
  const now = readFileSync(PATH, "utf8");
  const quiet = console.error; console.error = () => {};
  try {
    for (const { label, db, options, s, lease } of scenarios) {
      const baseLog: Log = [], headLog: Log = [];
      const baseResult = await compile(before, baseLog, db)(session(s), lease ?? LEASE, { ...options });
      const headResult = await compile(now, headLog, db)(session(s), lease ?? LEASE, { ...options });
      assert.deepEqual(headLog, baseLog, `${label}: statements, parameters and transaction options`);
      assert.deepEqual(headResult, baseResult, `${label}: result`);
      // The #233 revert: the shared reader's invoice query never selects period_start.
      for (const [kind, sql] of headLog) if (kind === "query" && String(sql).includes("FROM public.invoices WHERE")) assert.doesNotMatch(String(sql), /period_start/, label);
    }
  } finally { console.error = quiet; }
  // The scripted database exercised the full ready path at least once (so "equal" is not "both empty").
  const log: Log = [];
  const ready = await compile(now, log, scenarios[3].db)(session(), LEASE, { view: "current", turn: true }) as { state: string };
  assert.equal(ready.state, "ready");
  assert.ok(log.filter(([kind]) => kind === "query").length >= 10);
});

test("PR-043: tenant-payment-history.ts differs from origin/main only by an appended re-export of its admission rules", () => {
  const before = execFileSync("git", ["show", `${BASE}:${PATH}`], { encoding: "utf8" });
  const now = readFileSync(PATH, "utf8");
  assert.ok(now.startsWith(before), "every line of origin/main's reader is unchanged and in place");
  const added = now.slice(before.length).replace(/\/\*\*[\s\S]*?\*\//g, "").trim();
  // B-090 slice 2 widens the one re-export with the own-report scope (personal), still without touching a query.
  assert.equal(added, "export { valid as tenantHistorySessionValid, ctx as TENANT_HISTORY_CONTEXT_SQL, party as TENANT_HISTORY_PARTY_SQL, personal as TENANT_HISTORY_OWN_REPORT_SQL };");
});

const grep = (pattern: string) => execFileSync("git", ["grep", "--untracked", "-l", "-E", pattern, "--", "src"], { encoding: "utf8" }).trim().split("\n").sort();
test("PR-043: only the v3 首頁 path uses the new reader; no caller asks the shared reader for home facts", () => {
  const callers = grep("tenantHomeRead");
  assert.deepEqual(callers.filter(file => !/\.test\.tsx?$/.test(file)), ["src/server/b090-tenant-home-reader.ts", "src/server/b090-tenant-home.ts"]);
  const view = grep("tenantHomeView\\(").filter(file => !/\.test\.tsx?$/.test(file));
  assert.deepEqual(view, ["src/components/v3/tenant/home-route.tsx", "src/server/b090-tenant-home.ts"]);
  // The #233 / #234 shape (an option on the shared reader) is gone: nothing passes `home: true` or `pay: true` to it.
  assert.doesNotMatch(readFileSync(PATH, "utf8"), /(home|pay)\??:\s*boolean|options\.(home|pay)/);
  for (const file of grep("tenantPaymentHistory\\(").filter(file => !/\.test\.tsx?$/.test(file))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /tenantPaymentHistory\([^)]*\b(home|pay)\s*:/, file);
  }
});

test("PR-043 (B-090 slice 2): only the v3 繳款 path uses the new pay reader", () => {
  const callers = grep("tenantPayRead").filter(file => !/\.test\.tsx?$/.test(file));
  assert.deepEqual(callers, ["src/server/b090-tenant-pay-reader.ts", "src/server/b090-tenant-pay.ts"]);
  const view = grep("tenantPayView\\(").filter(file => !/\.test\.tsx?$/.test(file));
  assert.deepEqual(view, ["src/components/v3/tenant/pay-route.tsx", "src/server/b090-tenant-pay.ts"]);
  const route = grep("TenantPayV3Route").filter(file => !/\.test\.tsx?$/.test(file));
  assert.deepEqual(route, ["src/app/t/pay/page.tsx", "src/components/v3/tenant/pay-route.tsx"]);
  // The v3 view asks the shared reader only for options origin/main already accepts.
  assert.match(readFileSync("src/server/b090-tenant-pay.ts", "utf8"), /readHistory\(session, leaseId, \{ view: "current", turn: true \}\)/);
});

// ---------- B-090 slice 2: the brand_v3 OFF /t/pay page makes origin/main's reads, with origin/main's arguments ----------
// The page, its lease helper (src/lib/tenant-lease.ts) and origin/main's copies run side by side with every reader and
// component recorded with its arguments. The only difference allowed is where the one flag lookup sits (now right after
// consent and session). Every reader the OFF body calls is either the shared reader (SQL compared above) or a file that
// is unchanged from origin/main.
const PAY_BASE = "9e296fd97e2cd52a98ce94c9c10ff0cd56312562"; // origin/main after the slice 1 re-land (#239)
const PAY_PAGE = "src/app/t/pay/page.tsx", LEASE_LIB = "src/lib/tenant-lease.ts";
const show = (rev: string, path: string) => execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8" });
type PayCase = { leases: unknown[]; leaseId: string | null; history: unknown; money: unknown };
const payV3Modules = ["@/components/v3/tenant/pay-route", "@/server/actions"];

async function runPayPage(pageSource: string, libSource: string, c: PayCase, params: Record<string, unknown>) {
  const log: unknown[][] = [];
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const jsx = (source: string, mocks: (name: string) => unknown) => {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("require", "exports", code)(mocks, exports);
    return exports;
  };
  const session = { orgId: ORG, userId: USER, kind: "tenant", role: null, locale: "zh-TW", name: "Synthetic", leaseId: c.leaseId };
  const record = (name: string, value: unknown) => async (...args: unknown[]) => { log.push([name, ...args]); return value; };
  const component = (name: string) => function Recorded(props: Record<string, unknown>) {
    log.push([`render:${name}`, JSON.stringify(props, (_k, v) => typeof v === "function" ? "fn" : v)]);
    return React.createElement("i", { "data-stub": name });
  };
  const recording = (name: string): unknown => new Proxy(() => undefined, { get(_t, key) { log.push([`v3:${name}.${String(key)}`]); return recording(`${name}.${String(key)}`); }, apply() { log.push([`v3:${name}()`]); return undefined; } });
  const shared: Record<string, unknown> = {
    "@/server/session": { getSession: record("session", session) },
    "@/server/queries": { tenantLeases: record("leases", c.leases), tenantLeaseMoney: record("lease_money", c.money) },
    "next/navigation": { redirect: (to: string) => { log.push(["redirect", to]); throw new Error(`REDIRECT:${to}`); } },
    "@/server/types": {},
  };
  const lib = jsx(libSource, name => { if (name in shared) return shared[name]; throw new Error(`Unmocked lib dependency: ${name}`); });
  const mocks: Record<string, unknown> = {
    ...shared,
    "@/lib/tenant-lease": lib,
    "@/server/brand-v3": { brandV3EnabledForOrg: async (orgId: string) => { log.push(["flag", orgId]); return false; } },
    "@/server/consent-gate": { requireCurrentConsent: record("consent", undefined) },
    "@/server/brand-v2": { brandV2EnabledForOrg: record("brand_v2", true) },
    "@/server/tenant-payment-history": { tenantPaymentHistory: record("payment_history", c.history) },
    "@/components/v3/wait-mark": { WaitMark: component("wait-mark") },
    "@/i18n": { makeT: () => (key: string, vars?: unknown) => vars ? `${key}:${JSON.stringify(vars)}` : key },
    "@/components/dialogs": { PayDialog: component("pay-dialog") },
    "@/components/ui": { ErrorBanner: component("error-banner"), chargeKey: (k: string) => `charge_${k}` },
    "@/server/format": { electricityMonthLabel: (p: unknown, d: string) => `${p}:${d}`, moneyLabel: (m: unknown, cur: string) => `${cur}:${m}`, signedMoney: (m: unknown, cur: string, _l: unknown, v2: boolean) => `${cur}:${m}:${v2}` },
    "@/server/pay-note": { tenantPayeeVisible: () => true, unsignedRentNoteKey: (status: string, empty: boolean) => status === "pending_signature" && empty ? "i_pay_unsigned_bill" : null },
    "@/server/sandbox-data": { displaySampleName: (x: string) => `«${x}»` },
    "@/components/tenant-payee": { TenantPayee: component("payee") },
    "@/components/tenant-payment-history": { TenantBillSummary: component("bill-summary"), TenantPaymentHistory: component("history") },
    "@/i18n/tenant-payment-history": { tenantPaymentHistoryCopy: () => ({ unavailable: "unavailable" }) },
    "react": React, "react/jsx-runtime": await import("react/jsx-runtime"),
  };
  const page = jsx(pageSource, name => {
    if (name in mocks) return mocks[name];
    if (payV3Modules.includes(name)) return recording(name);
    throw new Error(`Unmocked page dependency: ${name}`);
  });
  log.length = 0; // module loading is not a read
  let html: string;
  try {
    html = renderToStaticMarkup(await (page.default as (p: unknown) => Promise<React.ReactElement>)({ searchParams: Promise.resolve(params) }));
  } catch (error) { html = `THROWN:${(error as Error).message}`; }
  return { log, html };
}

test("PR-043 / OQ-107 (B-090 slice 2): brand_v3 OFF /t/pay makes origin/main's reads with origin/main's arguments", async () => {
  const basePage = show(PAY_BASE, PAY_PAGE), baseLib = show(PAY_BASE, LEASE_LIB);
  const headPage = readFileSync(PAY_PAGE, "utf8"), headLib = readFileSync(LEASE_LIB, "utf8");
  const lease = { lease_id: LEASE, firm_name: "Firm", property_name: "P", unit_label: "2F", room_label: null };
  const other = { ...lease, lease_id: "00000000-0000-4000-8000-0000000000b2" };
  const ready = { state: "ready", lease: { canReport: true, legacyPayeeVisible: true }, bill: { balanceMinor: 1_850_000, currency: "TWD" } };
  const money = (status: string, lines: boolean, dueMinor: number, paidMinor = 0) => ({ lease: { status, place: "P 2F" }, currency: "TWD", dueMinor, paidMinor,
    rentLines: lines ? [{ amount: "1850000" }] : [], depositLines: [], utilityLines: lines ? [{ amount: "30000", periodStart: "2090-02-01", description: "utility" }] : [],
    otherLines: lines ? [{ amount: "-500", chargeType: "credit", description: "" }] : [] });
  const cases: PayCase[] = [
    { leases: [], leaseId: null, history: { state: "off" }, money: null },
    { leases: [lease, other], leaseId: null, history: { state: "off" }, money: null },
    { leases: [lease, other], leaseId: other.lease_id, history: ready, money: null },
    { leases: [lease], leaseId: null, history: { state: "unavailable" }, money: null },
    { leases: [lease], leaseId: null, history: ready, money: null },
    { leases: [lease], leaseId: null, history: { ...ready, lease: { canReport: false, legacyPayeeVisible: false } }, money: null },
    { leases: [lease], leaseId: null, history: { state: "off" }, money: null },
    { leases: [lease], leaseId: null, history: { state: "off" }, money: money("active", true, 1_880_000, 100) },
    { leases: [lease], leaseId: null, history: { state: "off" }, money: money("active", true, 0) },
    { leases: [lease], leaseId: null, history: { state: "off" }, money: money("pending_signature", false, 0) },
  ];
  const paramsList = [{}, { error: "errors.amountOverUnreported" }, { done: "1" }, { cursor: REPORT }, { reportId: REPORT }, { cursor: ["a", "b"], reportId: ["x", "y"] }, { report: "1" }, { report: "1", error: "errors.generic" }];
  let compared = 0;
  for (const c of cases) for (const params of paramsList) {
    const label = JSON.stringify([c.leases.length, c.leaseId, c.history, c.money && (c.money as { dueMinor: number }).dueMinor, params]);
    const base = await runPayPage(basePage, baseLib, c, params);
    const head = await runPayPage(headPage, headLib, c, params);
    assert.equal(head.html, base.html, `${label}: markup`);
    assert.deepEqual(head.log.filter(([name]) => name !== "flag"), base.log.filter(([name]) => name !== "flag"), `${label}: reads, components and their arguments`);
    assert.deepEqual(head.log.filter(([name]) => name === "flag"), [["flag", ORG]], `${label}: exactly one flag lookup`);
    assert.ok(!head.log.some(([name]) => String(name).startsWith("v3:")), `${label}: no v3 module touched`);
    // consent → session → flag, before any data read (the lease list included)
    assert.deepEqual(head.log.slice(0, 3).map(([name]) => name), ["consent", "session", "flag"], label);
    compared += 1;
  }
  assert.equal(compared, cases.length * paramsList.length);
  // The readers the OFF body calls besides the shared reader are unchanged from origin/main.
  for (const file of ["src/server/queries.ts", "src/server/payee.ts", "src/components/tenant-payee.tsx", "src/components/tenant-payment-history.tsx",
    "src/components/dialogs.tsx", "src/server/brand-v3.ts", "src/server/brand-v2.ts", "src/server/session.ts", "src/server/consent-gate.ts"]) {
    assert.equal(readFileSync(file, "utf8"), show(PAY_BASE, file), `${file} is origin/main's`);
  }
});
