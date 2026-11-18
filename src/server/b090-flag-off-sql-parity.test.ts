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
  assert.equal(added, "export { valid as tenantHistorySessionValid, ctx as TENANT_HISTORY_CONTEXT_SQL, party as TENANT_HISTORY_PARTY_SQL };");
});

const grep = (pattern: string) => execFileSync("git", ["grep", "--untracked", "-l", "-E", pattern, "--", "src"], { encoding: "utf8" }).trim().split("\n").sort();
test("PR-043: only the v3 首頁 path uses the new reader; no caller asks the shared reader for home facts", () => {
  const callers = grep("tenantHomeRead");
  assert.deepEqual(callers.filter(file => !/\.test\.tsx?$/.test(file)), ["src/server/b090-tenant-home-reader.ts", "src/server/b090-tenant-home.ts"]);
  const view = grep("tenantHomeView\\(").filter(file => !/\.test\.tsx?$/.test(file));
  assert.deepEqual(view, ["src/components/v3/tenant/home-route.tsx", "src/server/b090-tenant-home.ts"]);
  // The #233 shape (an option on the shared reader) is gone: nothing passes `home: true` to it.
  assert.doesNotMatch(readFileSync(PATH, "utf8"), /home\??:\s*boolean|options\.home/);
  for (const file of grep("tenantPaymentHistory\\(").filter(file => !/\.test\.tsx?$/.test(file))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /tenantPaymentHistory\([^)]*home/, file);
  }
});
