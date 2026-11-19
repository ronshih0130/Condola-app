import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { brandV2EnabledForOrg } from "./brand-v2";
import { brandV3EnabledForOrg } from "./brand-v3";
import { ASSIGN_BODY_LIMIT, maintUnitAssignEnabledForOrg } from "./b059-maint-unit-assign";
import { FLAG_GATE } from "./flag-gate";
import { NOTIFY_BLOCKS } from "./b073-notify-settings";
import { readCappedJson } from "./read-capped-json";
import { isUuid } from "./repair-rules";

const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";
const URL = "http://localhost";
function compile(source: string, mocks: Record<string, unknown> | ((name: string) => unknown)) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    // Lauren 2b: migrated routes import the real wrapper, compiled with the same mocks (consent, session, errors).
    if (name === "@/server/flag-gate" && (typeof mocks === "function" || !(name in mocks))) return compile(read("src/server/flag-gate.ts"), mocks);
    // Lauren 2d: migrated gate pages import the real page wrapper, compiled with the same mocks (consent, session, notFound).
    if (name === "@/server/page-flag-gate" && (typeof mocks === "function" || !(name in mocks))) return compile(read("src/server/page-flag-gate.ts"), mocks);
    if (typeof mocks === "function") return mocks(name);
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}

const cases = [
  { path: "src/app/api/owner-view/route.ts", input: { field: "showPhone", value: true } },
  { path: "src/app/api/team-security/route.ts", input: { required: true } },
  ...NOTIFY_BLOCKS.map(block => ({ path: "src/app/api/notify-settings/route.ts", input: { block, field: "leaseExpiry", value: true } })),
  { path: "src/app/o/units/[unitId]/page.tsx" },
  // B-059 (MGT-118): brand_v3 first, then maint_unit_assign (second table below).
  { path: "src/app/api/maint-unit-assign/route.ts", input: { requestId: UNIT, target: UNIT, units: [UNIT] } },
  { path: "src/app/m/assign/page.tsx" },
  { path: "src/app/m/assign/[id]/page.tsx" },
  // B-094 RO-RULES (B-113 / OWN-34-AC6 adds the no-limit lines): brand_v3 OFF or a failed lookup 404s before any rule or limit read.
  { path: "src/app/o/rules/page.tsx" },
];
/** Routes behind brand_v3 AND their own flag: with brand_v3 ON, the item flag OFF (or a throwing lookup) is the 404. */
const itemCases = [
  { path: "src/app/api/maint-unit-assign/route.ts", input: { requestId: UNIT, target: UNIT, units: [UNIT] }, guard: "maintUnitAssignEnabledForOrg" },
  { path: "src/app/m/assign/page.tsx", guard: "maintUnitAssignEnabledForOrg" },
  { path: "src/app/m/assign/[id]/page.tsx", guard: "maintUnitAssignEnabledForOrg" },
];
const encode = (text: string) => new TextEncoder().encode(text);
function streamed(chunks: Uint8Array[], contentLength?: string, path = "/api/owner-view") {
  const calls = { pulls: 0, cancels: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[calls.pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { calls.cancels += 1; },
  }, { highWaterMark: 0 }); // Don't prefetch independently of the handler.
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half",
    headers: { Origin: URL, "Content-Type": "application/json", ...(contentLength === undefined ? {} : { "Content-Length": contentLength }) } };
  return { request: new Request(`${URL}${path}`, init), calls };
}

function recordingDependency(name: string, calls: string[], allowed?: Record<string, unknown>): unknown {
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (allowed && Object.prototype.hasOwnProperty.call(allowed, key)) return Reflect.get(allowed, key);
      const member = `${name}.${String(key)}`;
      calls.push(`read:${member}`);
      return recordingDependency(member, calls);
    },
    apply() {
      calls.push(`read:${name}`);
      return undefined;
    },
  });
}

function trackPageInput<T>(name: string, value: T, calls: string[]) {
  const promise = Promise.resolve(value);
  return new Proxy({ then: promise.then.bind(promise) }, {
    get(target, key, receiver) {
      calls.push(name);
      return Reflect.get(target, key, receiver);
    },
  });
}

function assertPageGuardOrder(path: string, source: string,
  expected: string[] = ["requireCurrentConsent", "getSession", "brandV3EnabledForOrg"], nth = 1) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Lauren 2d: a migrated gate page is `export default withPageFlagGate({ flagKey, flag }, page)`. The wrapper runs
  // requireCurrentConsent(undefined, "page"), getSession(), then the inline flag predicate, then notFound() (its order is
  // proven at runtime below and in page-flag-gate.test.ts). The predicate may only call flag lookups, in the old order;
  // several flags in one `&&` predicate share the single notFound(), so they are compared as a prefix of `expected`.
  const wrapped = file.statements.find(ts.isExportAssignment);
  if (wrapped && ts.isCallExpression(wrapped.expression) && ts.isIdentifier(wrapped.expression.expression)
    && wrapped.expression.expression.text === "withPageFlagGate") {
    const spec = wrapped.expression.arguments[0];
    assert.ok(spec && ts.isObjectLiteralExpression(spec), `${path}: inline withPageFlagGate spec`);
    const flag = spec.properties.find(p => p.name?.getText(file) === "flag");
    assert.ok(flag && ts.isPropertyAssignment(flag) && (ts.isArrowFunction(flag.initializer) || ts.isFunctionExpression(flag.initializer)),
      `${path}: inline flag predicate`);
    const flagCalls: string[] = [];
    const visitFlag = (node: ts.Node): void => {
      ts.forEachChild(node, visitFlag);
      if (ts.isCallExpression(node)) flagCalls.push(node.expression.getText(file));
    };
    visitFlag(flag.initializer.body);
    assert.ok(flagCalls.every(call => /^[A-Za-z0-9]+EnabledForOrg$/.test(call)), `${path}: the flag predicate only looks up flags: ${flagCalls}`);
    const gate = ["requireCurrentConsent", "getSession", ...flagCalls];
    assert.ok(gate.length >= expected.length, `${path}: ${gate}`);
    assert.deepEqual(gate.slice(0, expected.length), expected, path);
    return;
  }
  const page = file.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  assert.ok(page && ts.isFunctionDeclaration(page) && page.body, `${path}: expected a default page function with a body`);

  const calls: string[] = [];
  let foundNotFound = false, seen = 0;
  function visit(node: ts.Node): void {
    if (foundNotFound) return;
    // Visit arguments first so a call inside notFound(...) counts before the 404.
    ts.forEachChild(node, visit);
    if (foundNotFound || !ts.isCallExpression(node)) return;
    const callee = node.expression.getText(file);
    if (callee === "notFound") foundNotFound = ++seen === nth;
    else calls.push(callee);
  }
  for (const statement of page.body.statements) {
    visit(statement);
    if (foundNotFound) break;
  }

  assert.ok(foundNotFound, `${path}: expected a notFound() call in the default export`);
  assert.deepEqual(calls, expected, path);
}

test("brand_v3-only endpoints: OFF and a throwing lookup both return 404 before API permission or body, unit reads, writes or audit", async () => {
  for (const { path, input } of cases) for (const fail of [false, true]) {
    const label = `${path} ${JSON.stringify(input)} ${fail ? "lookup failure" : "flag OFF"}`;
    const calls: string[] = [], lookups: string[] = [];
    const record = (name: string) => () => { calls.push(name); };
    const write = record("write"), writeAudit = record("audit");
    const save = async () => { calls.push("save"); write(); writeAudit(); return { ok: false, status: 404 }; };
    const source = read(path);
    const mocks = {
      "@/server/brand-v3": { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async id => {
        calls.push("flag"); lookups.push(id);
        if (fail) throw new Error("flag lookup failed");
        return false;
      }, async () => true) },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); return null; } },
      "@/server/session": {
        readSession: async () => { calls.push("session"); return { orgId: ORG, kind: input ? "staff" : "owner", role: input ? "admin" : null }; },
        getSession: async () => { calls.push("session"); return { orgId: ORG, kind: "owner", role: null }; },
      },
      "@/server/b073-owner-view": { authorizeSettingsEdit: record("permission"), saveOwnerView: save },
      "@/server/b073-team": { saveTeamSecurity: save },
      "@/server/b073-notify-settings": { authorizeNotifySettings: record("permission"), saveNotifySetting: save },
      "@/server/read-capped-json": { readCappedJson: (request: Request) => { calls.push("body"); return readCappedJson(request); } },
      "@/server/errors": { logServerError: record("log") },
      "@/server/b092-owner-unit": { ownerUnit: record("read") },
      "@/server/b059-maint-unit-assign": { maintUnitAssignEnabledForOrg: record("item-flag"), authorizeAssign: record("permission"), saveAssign: save, ASSIGN_BODY_LIMIT: 96 * 1024 },
      "@/components/v3/owner/unit": {},
      "@/components/v3/owner/units": {},
      "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
    };
    if (input) {
      const route = compile(source, mocks);
      const { request, calls: stream } = streamed([encode(JSON.stringify(input))], undefined, path.slice("src/app".length, -"/route.ts".length));
      const response = await (route.POST as (request: Request) => Promise<Response>)(request);
      assert.equal(response.status, 404, label);
      assert.equal(request.bodyUsed, false, label);
      assert.deepEqual(stream, { pulls: 0, cancels: 0 }, label);
      assert.deepEqual(calls, ["consent", "session", "flag"], label);
    } else {
      assertPageGuardOrder(path, source);
      const allowed = new Map<string, Record<string, unknown>>([
        ["@/server/consent-gate", {
          requireCurrentConsent: async (...args: unknown[]) => {
            calls.push("consent");
            assert.deepEqual(args, [undefined, "page"], label);
            return null;
          },
        }],
        ["@/server/session", { getSession: mocks["@/server/session"].getSession }],
        ["@/server/brand-v3", mocks["@/server/brand-v3"]],
        ["next/navigation", mocks["next/navigation"]],
      ]);
      const route = compile(source, (name: string) => recordingDependency(name, calls, allowed.get(name)));
      const Page = route.default as (props: unknown) => Promise<unknown>;
      // Ignore module-load accesses; CJS export reads during Page still hit the proxies.
      calls.length = 0;
      await assert.rejects(() => Page({
        params: trackPageInput("params", { unitId: UNIT }, calls),
        searchParams: trackPageInput("searchParams", {}, calls),
      }), /^Error: NEXT_NOT_FOUND$/, label);
      // Destructuring binds the tracked values; reading a property or awaiting either records an access.
      assert.deepEqual(calls, ["consent", "session", "flag", "notFound"], label);
    }
    assert.deepEqual(lookups, [ORG], label);
  }
});

test("brand_v3 + item-flag endpoints: brand_v3 ON with the item flag OFF or its lookup throwing return 404 before permission, body, reads, writes or audit", async () => {
  for (const { path, input, guard } of itemCases) for (const fail of [false, true]) {
    const label = `${path} ${fail ? "item lookup failure" : "item flag OFF"}`;
    const calls: string[] = [], lookups: string[] = [];
    const record = (name: string) => () => { calls.push(name); };
    const save = async () => { calls.push("save", "write", "audit"); return { ok: false, status: 404 }; };
    const brand = { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async () => { calls.push("flag"); return true; }, async () => true) };
    const item = { [guard]: (orgId: string) => maintUnitAssignEnabledForOrg(orgId, async id => {
      calls.push("item-flag"); lookups.push(id);
      if (fail) throw new Error("item flag lookup failed");
      return false;
    }) };
    const session = { orgId: ORG, kind: "staff", role: "admin" };
    const source = read(path);
    const notFound = () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); };
    if (input) {
      const route = compile(source, {
        "@/server/brand-v3": brand,
        "@/server/b059-maint-unit-assign": { ...item, authorizeAssign: record("permission"), saveAssign: save, ASSIGN_BODY_LIMIT: 96 * 1024 },
        "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); return null; } },
        "@/server/session": { readSession: async () => { calls.push("session"); return session; } },
        "@/server/read-capped-json": { readCappedJson: (request: Request) => { calls.push("body"); return readCappedJson(request); } },
        "@/server/errors": { logServerError: record("log") },
      });
      const { request, calls: stream } = streamed([encode(JSON.stringify(input))], undefined, path.slice("src/app".length, -"/route.ts".length));
      const response = await (route.POST as (request: Request) => Promise<Response>)(request);
      assert.equal(response.status, 404, label);
      assert.equal(request.bodyUsed, false, label);
      assert.deepEqual(stream, { pulls: 0, cancels: 0 }, label);
      assert.deepEqual(calls, ["consent", "session", "flag", "item-flag"], label);
    } else {
      assertPageGuardOrder(path, source, ["requireCurrentConsent", "getSession", "brandV3EnabledForOrg", guard], 2);
      const allowed = new Map<string, Record<string, unknown>>([
        ["@/server/consent-gate", { requireCurrentConsent: async (...args: unknown[]) => {
          calls.push("consent"); assert.deepEqual(args, [undefined, "page"], label); return null; } }],
        ["@/server/session", { getSession: async () => { calls.push("session"); return session; } }],
        ["@/server/brand-v3", brand],
        ["@/server/b059-maint-unit-assign", item],
        ["next/navigation", { notFound }],
      ]);
      const route = compile(source, (name: string) => recordingDependency(name, calls, allowed.get(name)));
      const Page = route.default as (props: unknown) => Promise<unknown>;
      calls.length = 0;
      await assert.rejects(() => Page({ params: trackPageInput("params", { id: UNIT }, calls), searchParams: trackPageInput("searchParams", {}, calls) }),
        /^Error: NEXT_NOT_FOUND$/, label);
      assert.deepEqual(calls, ["consent", "session", "flag", "item-flag", "notFound"], label);
    }
    assert.deepEqual(lookups, [ORG], label);
  }
});

// B-090 slice 1 re-land (PENDING-RON PR-043, OQ-107, REVIEW-CHECKLIST 13): existing tenant pages that gained a brand_v3
// branch. They are not OFF 404s: OFF they render the legacy page. With the flag OFF and with a throwing flag lookup, the
// v3 modules are never touched (no v3 data read), the reads are exactly origin/main's plus the one flag lookup, nothing
// is written or audited, and the flag is read after consent and session (for the page: consent → session → flag first).
const TENANT_BASE = "a0aa278e3e92732b066fdbd74bd8f7430d76df0b"; // origin/main before the B-090 slice 1 re-land
const TICKET = "00000000-0000-4000-8000-000000000003"; // a repair on the tenant's lease (B-090 slice 3 cases)
const tenantCases = [
  { path: "src/app/t/page.tsx", kind: "page", at: ["/t"] },
  { path: "src/app/t/layout.tsx", kind: "layout", at: ["/t", "/t/pay", "/t/id"] },
  // B-090 slice 2 (RT-PAY / RT-REPORT): 繳款, its 回報已繳 form (?report=1) and a bounced send (?report=1&error=…).
  { path: "src/app/t/pay/page.tsx", kind: "page", at: ["/t/pay", "/t/pay?report=1", "/t/pay?report=1&error=errors.generic", "/t/pay?done=1"] },
  // B-090 slice 3 (RT-REPAIR / RT-LEASE, read parts): 報修 list, one repair's progress (and its cancel step), 我的租約.
  { path: "src/app/t/repair/page.tsx", kind: "page", at: ["/t/repair", `/t/repair?id=${TICKET}`, `/t/repair?id=${TICKET}&cancel=1`, "/t/repair?done=1"] },
  { path: "src/app/t/lease/page.tsx", kind: "page", at: ["/t/lease"] },
] as const;
const tenantV3Modules = ["@/components/v3/tenant/home-route", "@/components/v3/tenant/shell", "@/server/b090-tenant-shell",
  "@/server/b090-tenant-home", "@/server/b090-tenant-home-reader",
  "@/components/v3/tenant/pay-route", "@/server/b090-tenant-pay", "@/server/b090-tenant-pay-reader",
  "@/components/v3/tenant/repair-route", "@/components/v3/tenant/lease-route", "@/server/b090-tenant-lease-repair"];
// /t/pay reads its lease through this helper; each side runs its own revision of it, so the helper's reads are counted.
const TENANT_LEASE_LIB = "src/lib/tenant-lease.ts";

async function runTenantEntry(source: string, kind: "page" | "layout", at: string, fail: boolean, libSource: string) {
  const [path, query = ""] = at.split("?");
  const calls: string[] = [], lookups: string[] = [];
  const read = <T,>(name: string, value: T) => async () => { calls.push(name); return value; };
  const link = ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>;
  const stub = (name: string) => () => { calls.push(`render:${name}`); return null; };
  const lease = { lease_id: UNIT, firm_name: "Firm", property_name: "P", unit_label: "2F", room_label: null, address_display: null, lease_status: "active" };
  const mocks: Record<string, unknown> = {
    "@/server/brand-v3": { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async id => {
      calls.push("flag"); lookups.push(id);
      if (fail) throw new Error("flag lookup failed");
      return false;
    }, async () => true) },
    "@/server/consent-gate": { requireCurrentConsent: read("consent", null) },
    "@/server/session": { getSession: read("session", { orgId: ORG, kind: "tenant", role: null, locale: "zh-TW", name: "Tenant", leaseId: null }) },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: unknown) => { calls.push("guard"); return s; } },
    "@/server/brand-v2": { brandV2EnabledForOrg: read("brand_v2", true) },
    "@/server/line/tenant-entry": { tenantLineEntryEnabled: read("line", true) },
    "@/server/queries": { tenantLeases: read("leases", [lease]), tenantLeaseMoney: read("lease_money", { lease: { rent: "1", deposit: "2", currency: "TWD", status: "active", place: "P 2F" }, dueMinor: 1, paidMinor: 0, currency: "TWD",
      rentLines: [{ amount: "1" }], depositLines: [], utilityLines: [], otherLines: [] }),
      tenantRepairs: read("repairs", [{ id: TICKET, number: "1", title: "Leak", status: "open", category: "plumbing", created_at: "2026-11-15" }]),
      ticketDetail: read("ticket_detail", { ticket: { id: TICKET, number: "1", title: "Leak", description: null, status: "open", category: "plumbing" }, comments: [], photos: [], hiddenPhotoCount: 0 }),
      tenantSignedLeasePdfs: read("signed_pdfs", [{ id: "pdf1", current: true, created_at: "2026-05-01T00:00:00Z" }]) },
    "@/server/upload-recovery": { ticketPhotoRecovery: read("photo_recovery", null) },
    "@/server/repair-rules": { isUuid: (v: string) => /^[0-9a-f-]{36}$/.test(v) },
    "@/lib/repair-labels": { REPAIR_CAT_KEY: { plumbing: "i_cat_plumbing" } },
    "@/components/repair-thread": { RepairThread: stub("repair-thread") },
    "@/components/v3/illustrations": { Illustration: stub("illustration") },
    "@/components/pdf-download-button": { PdfDownloadButton: stub("pdf") },
    "@/components/first-period-summary": { FirstPeriodSummary: stub("first-period") },
    "@/i18n/tenant-signed-pdf": { tenantSignedPdfStrings: () => ({ title: "x", notice: "x", current: "x", historical: "x", uploaded: "x", view: "x", download: "x" }) },
    "@/server/paper-lease-history-time": { signedPdfUploadedAt: () => ({ label: "x" }) },
    "@/server/tenant-payment-history": { tenantPaymentHistory: read("payment_history", { state: "off" }) },
    "@/server/id-docs": { loadLeaseIdCheck: read("id_check", { ready: true }) },
    "@/server/id-sign-gate": { identityRequiredForSigningFor: read("id_required", false) },
    "@/server/tenant-reminder-preferences": { tenantDuePreference: read("due_preference", null) },
    "@/server/db": { query: read("write", null), tx: read("write", null) },
    "@/server/audit": { writeAudit: read("audit", null) },
    "@/components/notification-center-entry": { NotificationCenterEntry: stub("notification-entry") },
    "@/components/handover-entry": { HandoverEntry: stub("handover-entry") },
    "@/components/tenant-payment-history": { TenantBillSummary: stub("bill-summary"), TenantPaymentHistory: stub("history") },
    "@/components/brand": { BrandImage: () => null },
    // The report action is passed to the v3 form only: touching it at all counts as a v3 read.
    "@/server/actions": recordingDependency("v3:@/server/actions", calls, { actionPickLease: "/pick", actionTicket: "/ticket", actionCancelRepair: "/cancel" }),
    "@/components/v3/wait-mark": { WaitMark: stub("wait-mark") },
    "@/components/dialogs": { PayDialog: stub("pay-dialog") },
    "@/components/ui": { ErrorBanner: stub("error-banner"), chargeKey: (k: string) => k, statusClass: (k: string) => k, statusKey: (k: string) => k },
    "@/components/tenant-payee": { TenantPayee: stub("payee") },
    "@/server/pay-note": { tenantPayeeVisible: () => true, unsignedRentNoteKey: () => null },
    "@/server/format": { moneyLabel: () => "NT$1", electricityMonthLabel: () => "m", signedMoney: () => "NT$1", formatDate: () => "d" },
    "@/server/sandbox-data": { displaySampleName: (x: string) => x },
    "@/i18n": { makeT: () => (key: string) => key, dictionary: () => ({}) },
    "@/i18n/lanes/reminders": { reminderCopy: () => ({ tenantTitle: "x" }) },
    "@/i18n/tenant-payment-history": { tenantPaymentHistoryCopy: () => ({ unavailable: "x" }) },
    "@/i18n/line-tenant": { lineTenantCopy: () => ({ manage: "x" }) },
    "@/i18n/tenant-lease-history": { tenantLeaseHistoryCopy: () => ({ link: "x" }) },
    "next/headers": { headers: async () => ({ get: () => path }) },
    "next/link": { __esModule: true, default: link },
    "next/navigation": { redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
  };
  mocks["@/lib/tenant-lease"] = compile(libSource, (name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "@/server/types") return {};
    throw new Error(`Unmocked lease-helper dependency: ${name}`);
  });
  const entry = compile(source, (name: string) => {
    if (name in mocks) return mocks[name];
    if ((tenantV3Modules as readonly string[]).includes(name)) return recordingDependency(`v3:${name}`, calls);
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  });
  calls.length = 0; // module-load accesses are not reads
  const Entry = entry.default as (props: unknown) => Promise<React.ReactElement>;
  const searchParams = Promise.resolve(Object.fromEntries(new URLSearchParams(query)));
  const html = renderToStaticMarkup(await (kind === "page" ? Entry({ searchParams }) : Entry({ children: <main>page</main> })));
  return { calls, lookups, html };
}

test("brand_v3 tenant 首頁, 繳款 and layout (B-090): OFF and a throwing lookup add no v3 read, write or audit; flag after consent and session", async () => {
  const baseLib = execFileSync("git", ["show", `${TENANT_BASE}:${TENANT_LEASE_LIB}`], { encoding: "utf8" });
  for (const { path, kind, at: paths } of tenantCases) for (const at of paths) for (const fail of [false, true]) {
    const label = `${path} ${at} ${fail ? "lookup failure" : "flag OFF"}`;
    const base = await runTenantEntry(execFileSync("git", ["show", `${TENANT_BASE}:${path}`], { encoding: "utf8" }), kind, at, fail, baseLib);
    const head = await runTenantEntry(read(path), kind, at, fail, read(TENANT_LEASE_LIB));
    assert.equal(head.html, base.html, `${label}: the legacy markup`);
    // /t/pay already read the flag on origin/main (after its lease read); the 首頁 and the layout did not.
    assert.deepEqual(head.calls.filter(call => call !== "flag"), base.calls.filter(call => call !== "flag"), `${label}: origin/main's reads, in order, plus only the flag lookup`);
    assert.ok(base.calls.filter(call => call === "flag").length <= 1, label);
    assert.equal(head.calls.filter(call => call === "flag").length, 1, label);
    assert.ok(!head.calls.some(call => call.startsWith("read:v3:") || call === "write" || call === "audit" || call === "notFound"), `${label}: ${head.calls.join(",")}`);
    const flag = head.calls.indexOf("flag");
    assert.ok(head.calls.indexOf("consent") < flag && head.calls.indexOf("session") < flag, label);
    if (kind === "page") assert.deepEqual(head.calls.slice(0, 3), ["consent", "session", "flag"], label);
    else assert.equal(head.calls[flag - 1], "consent", `${label}: no data read between consent and the flag`);
    assert.deepEqual(head.lookups, [ORG], label);
  }
});

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const path = `${dir}/${e.name}`;
  return e.isDirectory() ? walk(path) : [path];
});
test("brand_v3 endpoint registry covers every added route and page importing the flag", () => {
  const prod = "a4bf67306147a14cbd5b6c463521d8cb34cba874";
  const added = new Set(execFileSync("git", ["diff", "--name-only", "--diff-filter=A", prod, "HEAD", "--", "src/app"], { encoding: "utf8" }).trim().split("\n"));
  const covered = new Set(cases.map(row => row.path));
  const flagged = walk("src/app").filter(path => /\/(?:route\.ts|page\.tsx)$/.test(path)).filter(path =>
    ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest).statements.some(s =>
      ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@/server/brand-v3"));
  for (const path of flagged) if (added.has(path)) assert.ok(covered.has(path), `Missing flag-OFF case: ${path}`);
  // An added route or page behind an item flag as well (B-059 maint_unit_assign) also needs its item-flag case.
  const itemCovered = new Set(itemCases.map(row => row.path));
  const itemFlagged = walk("src/app").filter(path => /\/(?:route\.ts|page\.tsx)$/.test(path)).filter(path =>
    /maintUnitAssignEnabledForOrg\(/.test(read(path)));
  for (const path of itemFlagged) if (added.has(path)) assert.ok(itemCovered.has(path), `Missing item-flag OFF case: ${path}`);
  // B-090: every tenant page or layout that started reading the flag after TENANT_BASE is in the tenant table above.
  const tenantCovered = new Set<string>(tenantCases.map(row => row.path));
  const importsFlag = (text: string) => /from "@\/server\/brand-v3"/.test(text);
  const atBase = (path: string) => { try { return execFileSync("git", ["show", `${TENANT_BASE}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
  for (const path of walk("src/app/t").filter(path => /\/(?:page|layout)\.tsx$/.test(path))) {
    if (importsFlag(read(path)) && !importsFlag(atBase(path))) assert.ok(tenantCovered.has(path), `Missing tenant flag-OFF case: ${path}`);
  }
  for (const { path } of tenantCases) assert.ok(importsFlag(read(path)), `${path} no longer reads the flag: drop its tenant case`);
});

test("existing management pages and layout keep their flag-OFF regression tests", () => {
  // /m/settings, /m/roles, /m/notify, /m/account, /m/team, /m/audit and /m/layout are not OFF 404s.
  for (const [file, labels] of [
    ["b073-owner-view.test.tsx", ["/m/settings", "/m/roles", "/m/notify", "/m/account"]],
    ["b073-team.test.tsx", ["/m/team"]],
    ["b073-audit.test.tsx", ["/m/audit"]],
    ["b073-notify-settings.test.tsx", ["/m/notify page and layout"]],
  ] as const) {
    const titles = read(`src/server/${file}`).split("\n").filter(line => line.startsWith('test("') && line.includes("flag OFF"));
    for (const label of labels) assert.ok(titles.some(title => title.includes(label)), `Missing flag OFF test for ${label} in ${file}`);
  }
});

test("readCappedJson cancels an oversized stream as soon as it crosses 1 KiB, without Content-Length", async () => {
  const { request, calls } = streamed([new Uint8Array(1024), new Uint8Array(1024)]);
  assert.equal(request.headers.has("content-length"), false);
  assert.deepEqual(await readCappedJson(request), { ok: false, status: 413 });
  assert.deepEqual(calls, { pulls: 2, cancels: 1 });
});

test("readCappedJson rejects declared Content-Length 5000 without a pull", async () => {
  const { request, calls } = streamed([encode("{}")], "5000");
  assert.deepEqual(await readCappedJson(request), { ok: false, status: 413 });
  assert.equal(request.bodyUsed, false);
  assert.equal(calls.pulls, 0);
});

test("readCappedJson accepts exactly 1024 bytes, rejects invalid JSON and decodes split UTF-8", async () => {
  const value = "x".repeat(1022), exact = encode(JSON.stringify(value));
  assert.equal(exact.byteLength, 1024);
  assert.deepEqual(await readCappedJson(streamed([exact]).request), { ok: true, value });
  assert.deepEqual(await readCappedJson(streamed([encode("{")]).request), { ok: false, status: 400 });
  const utf8 = encode('"屋🙂"');
  assert.deepEqual(await readCappedJson(streamed([utf8.slice(0, 2), utf8.slice(2, 6), utf8.slice(6)]).request), { ok: true, value: "屋🙂" });
});

// Lauren 2b: the four org-flag API routes moved to withFlagGate (src/server/flag-gate.ts). Byte-identical proof: each
// scenario runs the pre-migration source (GATE_BASE, origin/main before 2b) and the current source through the same
// harness and compares status, every header, body bytes, the dependency calls in order and the request-stream pulls.
// Flag OFF (brand_v3 OFF, a throwing brand_v3/brand_v2 lookup caught inside brandV3EnabledForOrg, and for
// maint-unit-assign the item flag OFF or throwing) must also be a 404 with no body read, permission, save or log.
const GATE_BASE = "614e952172e641a80d8fd5b952d3f10104f41842";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const gateRoutes = [
  { path: "src/app/api/owner-view/route.ts", flagKey: "brand_v3", limit: 1024, input: { field: "showPhone", value: true } },
  { path: "src/app/api/team-security/route.ts", flagKey: "brand_v3", limit: 1024, input: { required: true } },
  { path: "src/app/api/notify-settings/route.ts", flagKey: "brand_v3", limit: 1024, input: { block: "tenant", field: "leaseExpiry", value: true } },
  { path: "src/app/api/maint-unit-assign/route.ts", flagKey: "maint_unit_assign", limit: ASSIGN_BODY_LIMIT, item: true,
    input: { requestId: UNIT, target: UNIT, units: [UNIT] } },
] as const;
type GateRoute = (typeof gateRoutes)[number];
type GateScenario = {
  name: string; expect: number; flagOff?: true; itemOnly?: true;
  consent?: "deny"; session?: "null" | "throw"; origin?: string | null;
  brand?: "off" | "v3-throw" | "v2-throw"; item?: "off" | "throw";
  permission?: "deny" | "throw"; contentType?: string | null;
  body?: (route: GateRoute) => { chunks: Uint8Array[]; contentLength?: string };
  save?: "fail" | "throw";
};
const gateScenarios: GateScenario[] = [
  { name: "brand_v3 OFF", brand: "off", expect: 404, flagOff: true },
  { name: "brand_v3 lookup throws (caught in brandV3EnabledForOrg)", brand: "v3-throw", expect: 404, flagOff: true },
  { name: "brand_v2 lookup throws (caught in brandV3EnabledForOrg)", brand: "v2-throw", expect: 404, flagOff: true },
  { name: "brand_v3 OFF with a non-JSON type and an oversized declared body", brand: "off", contentType: "text/plain",
    body: route => ({ chunks: [encode("{")], contentLength: String(route.limit * 4) }), expect: 404, flagOff: true },
  { name: "item flag OFF (brand_v3 ON)", item: "off", expect: 404, flagOff: true, itemOnly: true },
  { name: "item flag lookup throws (brand_v3 ON)", item: "throw", expect: 404, flagOff: true, itemOnly: true },
  { name: "consent denied", consent: "deny", expect: 409 },
  { name: "session read throws", session: "throw", expect: 500 },
  { name: "no session", session: "null", expect: 401 },
  { name: "cross-origin", origin: "http://evil.example", expect: 403 },
  { name: "no Origin header", origin: null, expect: 403 },
  { name: "cross-origin with brand_v3 OFF", origin: "http://evil.example", brand: "off", expect: 403 },
  { name: "permission denied", permission: "deny", expect: 403 },
  { name: "permission throws", permission: "throw", expect: 500 },
  { name: "text/plain", contentType: "text/plain", expect: 415 },
  { name: "no content type", contentType: null, expect: 415 },
  { name: "declared Content-Length over the cap", body: route => ({ chunks: [encode("{}")], contentLength: String(route.limit + 1) }), expect: 413 },
  { name: "streamed body over the cap", body: route => ({ chunks: [new Uint8Array(route.limit), new Uint8Array(1)] }), expect: 413 },
  { name: "invalid JSON", body: () => ({ chunks: [encode("{")] }), expect: 400 },
  { name: "save refused", save: "fail", expect: 409 },
  { name: "save throws", save: "throw", expect: 500 },
  { name: "success (charset parameter)", contentType: "application/json; charset=utf-8", expect: 200 },
  { name: "success", expect: 200 },
];

async function runGateRoute(source: string, route: GateRoute, sc: GateScenario) {
  const calls: string[] = [];
  const SESSION = { orgId: ORG, kind: "staff", role: "admin" }, AUTH = { orgId: ORG, kind: "staff", role: "admin", authorized: true };
  const denied = new Response("consent", { status: 409, headers: { "X-Consent": "required" } });
  const permission = async (...args: unknown[]) => {
    calls.push(`permission:${args.length}:${args[0] === SESSION}`);
    if (sc.permission === "throw") throw new Error("permission boom");
    return sc.permission === "deny" ? null : AUTH;
  };
  const save = async (...args: unknown[]) => {
    calls.push(`save:${args.length}:${args[0] === AUTH}:${JSON.stringify(args[1])}`);
    if (sc.save === "throw") throw new Error("save boom");
    if (sc.save === "fail") return { ok: false, status: 409 };
    return { ok: true, privacy: { showName: true, showPhone: true }, required: true, block: "tenant", toggles: { leaseExpiry: true },
      status: "saved", units: 1, replayed: false };
  };
  const mocks = {
    "@/server/consent-gate": { requireCurrentConsent: async (...args: unknown[]) => {
      calls.push(`consent:${JSON.stringify(args)}:${args.length}`); return sc.consent === "deny" ? denied : null; } },
    "@/server/session": { readSession: async (...args: unknown[]) => {
      calls.push(`session:${args.length}`);
      if (sc.session === "throw") throw new Error("session boom");
      return sc.session === "null" ? null : SESSION;
    } },
    "@/server/brand-v3": { brandV3EnabledForOrg: (...args: unknown[]) => {
      calls.push(`flag:${args.length}:${String(args[0])}`);
      return brandV3EnabledForOrg(args[0] as string, {}, async () => {
        calls.push("flag:v3");
        if (sc.brand === "v3-throw") throw new Error("brand_v3 lookup failed");
        return sc.brand !== "off";
      }, async () => {
        calls.push("flag:v2");
        if (sc.brand === "v2-throw") throw new Error("brand_v2 lookup failed");
        return true;
      });
    } },
    "@/server/b073-owner-view": { authorizeSettingsEdit: permission, saveOwnerView: save },
    "@/server/b073-team": { saveTeamSecurity: save },
    "@/server/b073-notify-settings": { authorizeNotifySettings: permission, saveNotifySetting: save },
    "@/server/b059-maint-unit-assign": { ASSIGN_BODY_LIMIT, authorizeAssign: permission, saveAssign: save,
      maintUnitAssignEnabledForOrg: (...args: unknown[]) => {
        calls.push(`item-flag:${args.length}:${String(args[0])}`);
        return maintUnitAssignEnabledForOrg(args[0] as string, async () => {
          calls.push("item-flag:lookup");
          if (sc.item === "throw") throw new Error("item flag lookup failed");
          return sc.item !== "off";
        });
      } },
    "@/server/read-capped-json": { readCappedJson: (request: Request, ...rest: unknown[]) => {
      calls.push(`body:${rest.length}:${String(rest[0])}`);
      return readCappedJson(request, ...(rest as [number?]));
    } },
    "@/server/errors": { logServerError: (...args: unknown[]) => {
      calls.push(`log:${args.length}:${String(args[0])}:${(args[1] as Error)?.message}`); } },
  };
  const exports = compile(source, mocks);
  const stream = { pulls: 0, cancels: 0 };
  const { chunks, contentLength } = sc.body?.(route) ?? { chunks: [encode(JSON.stringify(route.input))] };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[stream.pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { stream.cancels += 1; },
  }, { highWaterMark: 0 }); // Don't prefetch independently of the handler.
  const headers: Record<string, string> = {};
  if (sc.origin !== null) headers.Origin = sc.origin ?? URL;
  if (sc.contentType !== null) headers["Content-Type"] = sc.contentType ?? "application/json";
  if (contentLength !== undefined) headers["Content-Length"] = contentLength;
  const request = new Request(`${URL}${route.path.slice("src/app".length, -"/route.ts".length)}`,
    { method: "POST", body, duplex: "half", headers } as RequestInit & { duplex: "half" });
  const response = await (exports.POST as (request: Request, ctx: unknown) => Promise<Response>)(request, { params: Promise.resolve({}) });
  const bytes = [...new Uint8Array(await response.arrayBuffer())];
  return {
    response: { status: response.status, statusText: response.statusText, headers: [...response.headers], bytes },
    calls, stream, bodyUsed: request.bodyUsed, exports,
  };
}

test("Lauren 2b withFlagGate routes: flag OFF and every flag-ON path answer byte-for-byte as before the migration", async () => {
  for (const route of gateRoutes) {
    const base = execFileSync("git", ["show", `${GATE_BASE}:${route.path}`], { encoding: "utf8" });
    const head = read(route.path);
    for (const sc of gateScenarios) {
      if (sc.itemOnly && !("item" in route)) continue;
      const label = `${route.path} ${sc.name}`;
      const before = await runGateRoute(base, route, sc), after = await runGateRoute(head, route, sc);
      assert.deepEqual(after.response, before.response, `${label}: status, headers and body bytes`);
      assert.deepEqual(after.calls, before.calls, `${label}: the same dependency calls in the same order`);
      assert.deepEqual([after.stream, after.bodyUsed], [before.stream, before.bodyUsed], `${label}: the same body reads`);
      assert.equal(after.response.status, sc.expect, label);
      const gateHeaders = [["cache-control", "private, no-store"], ...(sc.expect === 200 ? [["content-type", "application/json"]] : []), ["vary", "Cookie"]];
      assert.deepEqual(after.response.headers, sc.consent ? [["content-type", "text/plain;charset=UTF-8"], ["x-consent", "required"]] : gateHeaders, label);
      if (sc.flagOff) {
        assert.deepEqual(after.response.bytes, [], label);
        assert.equal(after.bodyUsed, false, label);
        assert.deepEqual(after.stream, { pulls: 0, cancels: 0 }, label);
        assert.ok(!after.calls.some(call => /^(permission|body|save|log):/.test(call)), `${label}: ${after.calls.join(",")}`);
      }
    }
  }
});

test("Lauren 2b withFlagGate routes: every exported method carries FLAG_GATE, the module loads, and the gate is a direct call", async () => {
  const loaded: Record<string, Record<string, unknown>> = {
    "src/app/api/owner-view/route.ts": await import("../app/api/owner-view/route"),
    "src/app/api/team-security/route.ts": await import("../app/api/team-security/route"),
    "src/app/api/notify-settings/route.ts": await import("../app/api/notify-settings/route"),
    "src/app/api/maint-unit-assign/route.ts": await import("../app/api/maint-unit-assign/route"),
  };
  // The real module (real wrapper, real dependencies) and the harness-compiled source both carry the metadata.
  const unwrapped: string[] = [];
  for (const route of gateRoutes) {
    const compiled = (await runGateRoute(read(route.path), route, { name: "load", expect: 200 })).exports;
    for (const [where, mod] of [["import", loaded[route.path]], ["compiled", compiled]] as const) {
      const label = `${route.path} (${where})`;
      assert.equal(mod.dynamic, "force-dynamic", label);
      const handlers = Object.keys(mod).filter(key => typeof mod[key] === "function");
      assert.ok(handlers.length > 0, label);
      for (const key of handlers) {
        assert.ok(HTTP_METHODS.includes(key), `${label}: unexpected runtime export ${key}`);
        const marker = (mod[key] as Record<symbol, unknown>)[FLAG_GATE];
        if (typeof marker !== "string") unwrapped.push(`${label}#${key}`);
        else assert.equal(marker, route.flagKey, `${label}#${key}`);
      }
    }
  }
  assert.deepEqual(unwrapped, [], "every exported method is wrapped in withFlagGate (typeof handler[FLAG_GATE] === \"string\")");
  for (const route of gateRoutes) {
    // Source shape (HANDOFF-MAC lessons r1/r2/r3/B1/B2): only `export const <METHOD> = withFlagGate(spec, handler)`.
    const file = ts.createSourceFile(route.path, read(route.path), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      assert.ok(!ts.isExportDeclaration(statement), `${route.path}: no export { } / export … from`);
      assert.ok(!ts.isExportAssignment(statement), `${route.path}: no export default`);
      assert.ok(!(ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)), `${route.path}: no top-level await`);
      const exported = (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement))
        && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      assert.ok(!ts.isFunctionDeclaration(statement) || !HTTP_METHODS.includes(statement.name?.text ?? ""), `${route.path}: hand-written method`);
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(file);
        if (!HTTP_METHODS.includes(name)) continue;
        const init = declaration.initializer;
        assert.ok(init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "withFlagGate",
          `${route.path}#${name}: a direct withFlagGate(...) call`);
        assert.equal(init.arguments.length, 2, `${route.path}#${name}: no deps argument in production`);
        const spec = init.arguments[0];
        assert.ok(ts.isObjectLiteralExpression(spec), `${route.path}#${name}: inline spec`);
        const prop = (key: string) => spec.properties.find(p => p.name?.getText(file) === key);
        const sameOrigin = prop("sameOrigin"), flagKey = prop("flagKey");
        assert.ok(sameOrigin && ts.isPropertyAssignment(sameOrigin) && sameOrigin.initializer.kind === ts.SyntaxKind.TrueKeyword, `${route.path}#${name}: sameOrigin: true`);
        assert.ok(flagKey && ts.isPropertyAssignment(flagKey) && ts.isStringLiteral(flagKey.initializer) && flagKey.initializer.text === route.flagKey, `${route.path}#${name}: flagKey`);
      }
    }
    assert.match(read("ops/flags.yaml"), new RegExp(`^  ${route.flagKey}:$`, "m"), `${route.flagKey} is a registry key`);
  }
});

test("Lauren 2b predicates never reject: brandV3EnabledForOrg and maintUnitAssignEnabledForOrg fail closed to false", async () => {
  const boom = () => { throw new Error("sync boom"); };
  const reject = async () => { throw new Error("async boom"); };
  const hostileEnv = new Proxy({}, { get: boom }) as Record<string, string | undefined>;
  for (const orgId of [ORG, "", null, undefined, "not-a-uuid"]) {
    for (const [v3, v2, env] of [[boom, async () => true, {}], [reject, async () => true, {}], [async () => true, boom, {}],
      [async () => true, reject, {}], [async () => "true", async () => true, {}]] as const) {
      // Rejection would surface here as a thrown await; the gate's flag catch would turn it into a 404 instead of a 500.
      assert.equal(await brandV3EnabledForOrg(orgId, env, v3 as never, v2 as never), false, String(orgId));
    }
    // With the real brand_v2 predicate (the v2 default): a throwing env read (outside brandV2EnabledForOrg's own try) or a
    // rejecting brand_v2 lookup is still OFF, because brandV3EnabledForOrg calls v2 inside its try.
    for (const env of [hostileEnv, {}]) {
      assert.equal(await brandV3EnabledForOrg(orgId, env, async () => true, (id, e) => brandV2EnabledForOrg(id, e, reject)), false, String(orgId));
    }
    for (const lookup of [boom, reject, async () => "true" as never, async () => 1 as never]) {
      assert.equal(await maintUnitAssignEnabledForOrg(orgId, lookup as never), false, String(orgId));
    }
  }
  assert.equal(await brandV3EnabledForOrg(ORG, {}, async () => true, async () => true), true);
  assert.equal(await maintUnitAssignEnabledForOrg(ORG, async () => true), true);
});

// Lauren 2d (CEO option a; hub 20-build/lauren-1-6/page-gate-proposal.md): the 10 gate pages moved to withPageFlagGate
// (src/server/page-flag-gate.ts). Proof as in 2b: each scenario runs the pre-migration page source (PAGE_GATE_BASE,
// origin/main before 2d) and the current source through the same harness, and compares every dependency call in order
// (consent, session, each flag lookup, every params/searchParams read, every data read or helper call, notFound) and the
// outcome: the returned element tree (components and data are recording stubs) or the error. Flag OFF must be
// notFound() with no params/searchParams read and no data read. /t/settlement is not a gate page here (it reads the
// lease and may redirect before its flag check), so it stays hand-written.
const PAGE_GATE_BASE = "7150b2f684b91aed1ea5f85423a2d6bfd4bdfc56";
type GatePage = { path: string; flagKey: string; kind: "staff" | "owner"; item?: true; kindGate?: true; params: Record<string, string> };
const gatePages: GatePage[] = [
  { path: "src/app/m/assign/page.tsx", flagKey: "maint_unit_assign", kind: "staff", item: true, params: {} },
  { path: "src/app/m/assign/[id]/page.tsx", flagKey: "maint_unit_assign", kind: "staff", item: true, params: { id: UNIT } },
  { path: "src/app/m/leases/[id]/settlement/page.tsx", flagKey: "brand_v3", kind: "staff", params: { id: UNIT } },
  { path: "src/app/m/more/page.tsx", flagKey: "brand_v3", kind: "staff", kindGate: true, params: {} },
  { path: "src/app/m/properties/[id]/shared-meter/page.tsx", flagKey: "brand_v3", kind: "staff", params: { id: UNIT } },
  { path: "src/app/m/tenants/[id]/phone-history/page.tsx", flagKey: "brand_v3", kind: "staff", params: { id: UNIT } },
  { path: "src/app/o/decided/page.tsx", flagKey: "brand_v3", kind: "owner", params: {} },
  { path: "src/app/o/leases/[id]/settlement/page.tsx", flagKey: "brand_v3", kind: "owner", kindGate: true, params: { id: UNIT } },
  { path: "src/app/o/rules/page.tsx", flagKey: "brand_v3", kind: "owner", params: {} },
  { path: "src/app/o/units/[unitId]/page.tsx", flagKey: "brand_v3", kind: "owner", params: { unitId: UNIT } },
];
type PageScenario = {
  name: string; flagOff?: true; itemOnly?: true; consent?: "redirect"; session?: "redirect" | "throw";
  brand?: "off" | "v3-throw" | "v2-throw"; item?: "off" | "throw"; otherKind?: true; badId?: true;
  reads?: unknown; search?: Record<string, string>; role?: string;
};
const pageScenarios: PageScenario[] = [
  { name: "brand_v3 OFF", brand: "off", flagOff: true },
  { name: "brand_v3 lookup throws (caught in brandV3EnabledForOrg)", brand: "v3-throw", flagOff: true },
  { name: "brand_v2 lookup throws (caught in brandV3EnabledForOrg)", brand: "v2-throw", flagOff: true },
  { name: "brand_v3 OFF with query params", brand: "off", search: { after: "2026-11-01", trail: "a", room: "r1" }, flagOff: true },
  { name: "item flag OFF (brand_v3 ON)", item: "off", flagOff: true, itemOnly: true },
  { name: "item flag lookup throws (brand_v3 ON)", item: "throw", flagOff: true, itemOnly: true },
  { name: "the other session kind, brand_v3 OFF", otherKind: true, brand: "off", flagOff: true },
  { name: "the other session kind, brand_v3 ON", otherKind: true },
  { name: "consent redirects", consent: "redirect" },
  { name: "no session (getSession redirects to /login)", session: "redirect" },
  { name: "session read throws", session: "throw" },
  { name: "ON, readers return stubs", },
  { name: "ON, a manager role", role: "manager" },
  { name: "ON, a bad id", badId: true },
  { name: "ON, query params", search: { after: "2026-11-01", trail: "a", room: "r1" } },
  { name: "ON, reader says off", reads: { state: "off" } },
  { name: "ON, reader says forbidden", reads: { state: "forbidden" } },
  { name: "ON, reader fails", reads: { state: "error" } },
  { name: "ON, ready and vacant", reads: { state: "ready", unit: { vacant: true } } },
  { name: "ON, ready", reads: { state: "ready", unit: { vacant: false, id: UNIT }, rows: [] } },
];

// Data readers, helpers and components are recording stubs: a call records its name and argument count and returns
// the scenario's `reads` value (or another stub); a stub is never thenable, so awaiting one resolves to it.
const pageStubNames = new WeakMap<object, string>();
function pageStub(name: string, calls: string[], sc: PageScenario): unknown {
  const stub: unknown = new Proxy(function stub() { /* recording stub */ }, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => `«${name}»`;
      if (typeof key === "symbol" || key === "then") return undefined;
      return pageStub(`${name}.${key}`, calls, sc);
    },
    apply(_target, _this, args: unknown[]) {
      // Codex 2d r1 SHOULD: record the normalized arguments, not just their count, so a changed id or session is caught.
      calls.push(`call:${name}(${JSON.stringify(args.map(arg => pageOutcome(arg)))})`);
      return sc.reads !== undefined ? sc.reads : pageStub(`${name}()`, calls, sc);
    },
  });
  pageStubNames.set(stub as object, name);
  return stub;
}
function pageOutcome(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || typeof value !== "object" && typeof value !== "function") return value;
  if (pageStubNames.has(value as object)) return `stub:${pageStubNames.get(value as object)}`;
  if (typeof value === "function") return `fn:${(value as { name: string }).name}`;
  if (seen.has(value)) return "seen";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => pageOutcome(item, seen));
  if (React.isValidElement(value)) {
    const element = value as React.ReactElement<Record<string, unknown>>;
    return { type: pageOutcome(element.type, seen), key: element.key, props: pageOutcome(element.props, seen) };
  }
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, pageOutcome((value as Record<string, unknown>)[key], seen)]));
}

async function runGatePage(source: string, page: GatePage, sc: PageScenario) {
  const calls: string[] = [];
  const kind = sc.otherKind ? (page.kind === "staff" ? "owner" : "staff") : page.kind;
  const SESSION = { orgId: ORG, kind, role: sc.role ?? "admin", locale: "zh-TW", calendar: "gregorian", customRole: null };
  const known: Record<string, Record<string, unknown>> = {
    "@/server/consent-gate": { requireCurrentConsent: async (...args: unknown[]) => {
      calls.push(`consent:${JSON.stringify(args)}:${args.length}`);
      if (sc.consent === "redirect") throw new Error("NEXT_REDIRECT /consent");
      return null;
    } },
    "@/server/session": { getSession: async (...args: unknown[]) => {
      calls.push(`session:${args.length}`);
      if (sc.session === "redirect") throw new Error("NEXT_REDIRECT /login");
      if (sc.session === "throw") throw new Error("session boom");
      return SESSION;
    } },
    "@/server/brand-v3": { brandV3EnabledForOrg: (...args: unknown[]) => {
      calls.push(`flag:${args.length}:${String(args[0])}`);
      return brandV3EnabledForOrg(args[0] as string, {}, async () => {
        calls.push("flag:v3");
        if (sc.brand === "v3-throw") throw new Error("brand_v3 lookup failed");
        return sc.brand !== "off";
      }, async () => {
        calls.push("flag:v2");
        if (sc.brand === "v2-throw") throw new Error("brand_v2 lookup failed");
        return true;
      });
    } },
    "@/server/b059-maint-unit-assign": { maintUnitAssignEnabledForOrg: (...args: unknown[]) => {
      calls.push(`item-flag:${args.length}:${String(args[0])}`);
      return maintUnitAssignEnabledForOrg(args[0] as string, async () => {
        calls.push("item-flag:lookup");
        if (sc.item === "throw") throw new Error("item flag lookup failed");
        return sc.item !== "off";
      });
    } },
    "@/server/repair-rules": { isUuid: (...args: unknown[]) => { calls.push(`isUuid:${String(args[0])}`); return isUuid(args[0] as string); } },
    "next/navigation": {
      notFound: (...args: unknown[]) => { calls.push(`notFound:${args.length}`); throw new Error("NEXT_NOT_FOUND"); },
      redirect: (...args: unknown[]) => { calls.push(`redirect:${JSON.stringify(args)}`); throw new Error("NEXT_REDIRECT"); },
    },
  };
  const resolve = (name: string): unknown => {
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    const members = known[name] ?? {};
    return new Proxy(members, { get(target, key) {
      if (typeof key === "symbol" || key === "then" || key === "__esModule") return undefined;
      return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : pageStub(`${name}.${key}`, calls, sc);
    } });
  };
  const exports = compile(source, resolve);
  calls.length = 0; // module-load reads are not part of a request
  const params = sc.badId ? Object.fromEntries(Object.keys(page.params).map(key => [key, "not-a-uuid"])) : page.params;
  let outcome: unknown;
  try {
    outcome = { result: pageOutcome(await (exports.default as (props: unknown) => Promise<unknown>)({
      params: trackPageInput("params", params, calls), searchParams: trackPageInput("searchParams", sc.search ?? {}, calls) })) };
  } catch (error) {
    outcome = { error: (error as Error).message };
  }
  return { calls, outcome, exports };
}

test("Lauren 2d withPageFlagGate pages: flag OFF and every other path behave exactly as before the migration", async () => {
  for (const page of gatePages) {
    const base = execFileSync("git", ["show", `${PAGE_GATE_BASE}:${page.path}`], { encoding: "utf8" });
    const head = read(page.path);
    assert.notEqual(head, base, `${page.path} is migrated`);
    for (const sc of pageScenarios) {
      if (sc.itemOnly && !page.item) continue;
      const label = `${page.path} ${sc.name}`;
      const before = await runGatePage(base, page, sc), after = await runGatePage(head, page, sc);
      assert.deepEqual(after.calls, before.calls, `${label}: the same dependency calls in the same order`);
      assert.deepEqual(after.outcome, before.outcome, `${label}: the same element tree or error`);
      assert.match(after.calls[0] ?? "", /^consent:\[null,"page"\]:2$/, label);
      if (sc.flagOff || (sc.otherKind && page.kindGate)) {
        assert.deepEqual(after.outcome, { error: "NEXT_NOT_FOUND" }, label);
        assert.equal(after.calls.at(-1), "notFound:0", label);
        assert.ok(!after.calls.some(call => /^(params|searchParams|call:|isUuid:)/.test(call)), `${label}: ${after.calls.join(",")}`);
      }
      if (sc.otherKind && page.kindGate) assert.ok(!after.calls.some(call => call.startsWith("flag")), `${label}: no lookup for the wrong kind`);
    }
  }
});

test("Lauren 2d withPageFlagGate pages: the default export carries FLAG_GATE, the module loads, and the gate is a direct inline call", async () => {
  const loaded: Record<string, Record<string, unknown>> = {
    "src/app/m/assign/page.tsx": await import("../app/m/assign/page"),
    "src/app/m/assign/[id]/page.tsx": await import("../app/m/assign/[id]/page"),
    "src/app/m/leases/[id]/settlement/page.tsx": await import("../app/m/leases/[id]/settlement/page"),
    "src/app/m/more/page.tsx": await import("../app/m/more/page"),
    "src/app/m/properties/[id]/shared-meter/page.tsx": await import("../app/m/properties/[id]/shared-meter/page"),
    "src/app/m/tenants/[id]/phone-history/page.tsx": await import("../app/m/tenants/[id]/phone-history/page"),
    "src/app/o/decided/page.tsx": await import("../app/o/decided/page"),
    "src/app/o/leases/[id]/settlement/page.tsx": await import("../app/o/leases/[id]/settlement/page"),
    "src/app/o/rules/page.tsx": await import("../app/o/rules/page"),
    "src/app/o/units/[unitId]/page.tsx": await import("../app/o/units/[unitId]/page"),
  };
  assert.deepEqual(Object.keys(loaded).sort(), gatePages.map(page => page.path).sort());
  for (const page of gatePages) {
    const compiled = (await runGatePage(read(page.path), page, { name: "load", brand: "off" })).exports;
    for (const [where, mod] of [["import", loaded[page.path]], ["compiled", compiled]] as const) {
      const label = `${page.path} (${where})`;
      assert.equal(mod.dynamic, "force-dynamic", label);
      assert.equal(typeof mod.default, "function", label);
      assert.equal((mod.default as Record<symbol, unknown>)[FLAG_GATE], page.flagKey, `${label}: typeof default[FLAG_GATE] === "string"`);
    }
    // Source shape: only `export default withPageFlagGate({ flagKey: "<key>", flag: <inline> }, <inline page>)`.
    const file = ts.createSourceFile(page.path, read(page.path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const defaults = file.statements.filter(statement => ts.isExportAssignment(statement)
      || ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)));
    assert.equal(defaults.length, 1, `${page.path}: one default export`);
    const [statement] = defaults;
    assert.ok(ts.isExportAssignment(statement) && !statement.isExportEquals, `${page.path}: export default <expression>`);
    const call = statement.expression;
    assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "withPageFlagGate",
      `${page.path}: a direct withPageFlagGate(...) call`);
    assert.equal(call.arguments.length, 2, `${page.path}: no deps argument in production`);
    const [spec, body] = call.arguments;
    assert.ok(ts.isObjectLiteralExpression(spec), `${page.path}: inline spec`);
    assert.deepEqual(spec.properties.map(p => ts.isPropertyAssignment(p) ? p.name.getText(file) : `<${ts.SyntaxKind[p.kind]}>`), ["flagKey", "flag"], page.path);
    const [flagKey, flag] = spec.properties as unknown as [ts.PropertyAssignment, ts.PropertyAssignment];
    assert.ok(ts.isStringLiteral(flagKey.initializer) && flagKey.initializer.text === page.flagKey, `${page.path}: flagKey`);
    assert.ok(ts.isArrowFunction(flag.initializer), `${page.path}: inline flag predicate`);
    assert.ok(ts.isArrowFunction(body), `${page.path}: inline page`);
    assert.ok(file.statements.some(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@/server/page-flag-gate"
      && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      && s.importClause.namedBindings.elements.some(e => e.name.text === "withPageFlagGate" && !e.propertyName)), `${page.path}: imported unaliased`);
    assert.ok(!/requireCurrentConsent|getSession/.test(read(page.path)), `${page.path}: the wrapper alone runs consent and session`);
    assert.match(read("ops/flags.yaml"), new RegExp(`^  ${page.flagKey}:$`, "m"), `${page.flagKey} is a registry key`);
  }
});
