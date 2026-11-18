import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { brandV3EnabledForOrg } from "./brand-v3";
import { NOTIFY_BLOCKS } from "./b073-notify-settings";
import { readCappedJson } from "./read-capped-json";

const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";
const URL = "http://localhost";
function compile(source: string, mocks: Record<string, unknown> | ((name: string) => unknown)) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
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
  // B-094 RO-RULES (B-113 / OWN-34-AC6 adds the no-limit lines): brand_v3 OFF or a failed lookup 404s before any rule or limit read.
  { path: "src/app/o/rules/page.tsx" },
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

function assertPageGuardOrder(path: string, source: string) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = file.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  assert.ok(page && ts.isFunctionDeclaration(page) && page.body, `${path}: expected a default page function with a body`);

  const calls: string[] = [];
  let foundNotFound = false;
  function visit(node: ts.Node): void {
    if (foundNotFound) return;
    // Visit arguments first so a call inside notFound(...) counts before the 404.
    ts.forEachChild(node, visit);
    if (foundNotFound || !ts.isCallExpression(node)) return;
    const callee = node.expression.getText(file);
    if (callee === "notFound") foundNotFound = true;
    else calls.push(callee);
  }
  for (const statement of page.body.statements) {
    visit(statement);
    if (foundNotFound) break;
  }

  assert.ok(foundNotFound, `${path}: expected a notFound() call in the default export`);
  assert.deepEqual(calls, ["requireCurrentConsent", "getSession", "brandV3EnabledForOrg"], path);
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

// B-090 slice 1 re-land (PENDING-RON PR-043, OQ-107, REVIEW-CHECKLIST 13): existing tenant pages that gained a brand_v3
// branch. They are not OFF 404s: OFF they render the legacy page. With the flag OFF and with a throwing flag lookup, the
// v3 modules are never touched (no v3 data read), the reads are exactly origin/main's plus the one flag lookup, nothing
// is written or audited, and the flag is read after consent and session (for the page: consent → session → flag first).
const TENANT_BASE = "a0aa278e3e92732b066fdbd74bd8f7430d76df0b"; // origin/main before the B-090 slice 1 re-land
const tenantCases = [
  { path: "src/app/t/page.tsx", kind: "page", at: ["/t"] },
  { path: "src/app/t/layout.tsx", kind: "layout", at: ["/t", "/t/pay", "/t/id"] },
  // B-090 slice 2 (RT-PAY / RT-REPORT): 繳款, its 回報已繳 form (?report=1) and a bounced send (?report=1&error=…).
  { path: "src/app/t/pay/page.tsx", kind: "page", at: ["/t/pay", "/t/pay?report=1", "/t/pay?report=1&error=errors.generic", "/t/pay?done=1"] },
] as const;
const tenantV3Modules = ["@/components/v3/tenant/home-route", "@/components/v3/tenant/shell", "@/server/b090-tenant-shell",
  "@/server/b090-tenant-home", "@/server/b090-tenant-home-reader",
  "@/components/v3/tenant/pay-route", "@/server/b090-tenant-pay", "@/server/b090-tenant-pay-reader"];
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
      rentLines: [{ amount: "1" }], depositLines: [], utilityLines: [], otherLines: [] }) },
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
    "@/server/actions": recordingDependency("v3:@/server/actions", calls, { actionPickLease: "/pick" }),
    "@/components/v3/wait-mark": { WaitMark: stub("wait-mark") },
    "@/components/dialogs": { PayDialog: stub("pay-dialog") },
    "@/components/ui": { ErrorBanner: stub("error-banner"), chargeKey: (k: string) => k },
    "@/components/tenant-payee": { TenantPayee: stub("payee") },
    "@/server/pay-note": { tenantPayeeVisible: () => true, unsignedRentNoteKey: () => null },
    "@/server/format": { moneyLabel: () => "NT$1", electricityMonthLabel: () => "m", signedMoney: () => "NT$1" },
    "@/server/sandbox-data": { displaySampleName: (x: string) => x },
    "@/i18n": { makeT: () => (key: string) => key },
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
