import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import * as model from "../lib/b3-today";
import * as emptyCta from "../lib/empty-cta";
import * as format from "./format";
import * as perms from "./perms";
import { FlowError } from "./errors";
import { setupChecklist } from "./onboarding-progress-rules";
import type { SetupProgress } from "./onboarding-progress";
import type { Session } from "./types";
import type { PaymentTurnMatter, StaffPaymentTurns } from "./b3-payment-turns";
import type { RentalTurnRow, StaffRentalTurns } from "./b3-rental-turns";
import type { OverdueTurnRow, StaffOverdueTurns } from "./b3-overdue-turns";
import type { TodayMonthly, TodayTurns } from "../lib/b3-today";

const requireHere = createRequire(import.meta.url);
const source = (file: string) => readFileSync(file, "utf8");
function compile(sourceText: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const link = { __esModule: true, default: "a" };
const session: Session = { kind: "staff", role: "admin", orgId: "org", liveOrgId: "org", userId: "user", sessionId: "session", name: "王怡君", email: "fixture@example.invalid", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const off = { state: "off" } as const;
const noPayments: StaffPaymentTurns = { state: "ready", counts: [], yourTurn: 0, mine: [], others: [] };
const noRentals: StaffRentalTurns = { state: "ready", counts: { vacant: 0, renewalAsk: 0, earlyVacancy: 0 }, mine: [] };
const noOverdue: StaffOverdueTurns = { state: "ready", count: 0, others: [] };
function payment(id = "p1", rule: "P1" | "P2" = "P1", since = "2026-11-10T00:00:00Z"): PaymentTurnMatter {
  return { id, rule, holder: rule === "P1" ? "manager" : "tenant", step: rule === "P1" ? "confirm_payment" : "re_report", since,
    sinceExact: rule === "P1", timezone: "Asia/Taipei", amountMinor: 3200000, currency: "TWD", paidOn: "2026-11-09", leaseId: `lease-${id}`, place: "松仁匯 7F", tenantName: "陳先生" };
}
function rental(kind: RentalTurnRow["kind"] = "vacant"): RentalTurnRow {
  return { kind, targetKind: "room", targetId: `room-${kind}`, propertyId: "property", place: `民生社區 ${kind}`, tenantName: kind === "vacant" ? null : "周小姐",
    leaseId: kind === "vacant" ? null : `lease-${kind}`, date: "2026-11-30", dayNumber: 16, rentMinor: kind === "vacant" ? "1200000" : null, rentCurrency: kind === "vacant" ? "TWD" : null,
    reason: kind === "early_vacancy" ? "declined" : null };
}
const payments: StaffPaymentTurns = { state: "ready", counts: [{ holder: "manager", step: "confirm_payment", count: 1 }, { holder: "tenant", step: "re_report", count: 1 }], yourTurn: 1, mine: [payment()], others: [payment("p2", "P2")] };
const rentals: StaffRentalTurns = { state: "ready", counts: { vacant: 1, renewalAsk: 1, earlyVacancy: 1 }, mine: [rental(), rental("renewal_ask"), rental("early_vacancy")] };
const overdue: StaffOverdueTurns = { state: "ready", count: 1, others: [{ leaseId: "lease-overdue", currency: "TWD", amountMinor: "2800000", oldestDueDate: "2026-11-01", oldestMonth: 10, singleRentInvoice: false, dayNumber: 13, tenantName: "林小姐", place: "忠孝大樓 3F", reminderCount: null }] };
const turns: TodayTurns = { payments, rentals, overdue, roomUnits: { "room-vacant": "parent-unit", "room-early_vacancy": "parent-unit" } };
const emptyTurns: TodayTurns = { payments: noPayments, rentals: noRentals, overdue: noOverdue, roomUnits: {} };
const monthly: TodayMonthly = { rows: [{ currency: "TWD", due: "112000000", received: "103000000" }], month: 11, defaultCurrency: "TWD" };

const emptyState = compile(source("src/components/empty-state.tsx"), { "next/link": link, "@/i18n": i18n, "./empty-illustration": { EmptyIllustration: () => null } });
const onboarding = compile(source("src/components/onboarding-progress.tsx"), { "@/i18n": i18n, "./empty-state": emptyState });
const avatar = compile(source("src/components/v3/role-avatar.tsx"), { "../../i18n/lanes/brand-v3": copy });
const drawing = compile(source("src/components/v3/m/today/clear-drawing.tsx"), {});
const notice = compile(source("src/components/v3/m/today/signup-notice.tsx"), { "../../../../i18n": i18n });
const todayModule = compile(source("src/components/v3/m/today/today.tsx"), {
  "next/link": link, "../../../../i18n": i18n, "../../../../i18n/lanes/brand-v3": copy,
  "../../../../lib/b3-today": model, "../../../../lib/empty-cta": emptyCta, "../../../../server/format": format,
  "../../../../server/sandbox-data": { displaySampleName: (name: string) => name }, "../../../onboarding-progress": onboarding,
  "../../../empty-state": emptyState, "../../role-avatar": avatar, "./clear-drawing": drawing, "./signup-notice": notice,
});
const TodayPage = todayModule.TodayPage as typeof import("../components/v3/m/today/today").TodayPage;
function render(input: Partial<Parameters<typeof TodayPage>[0]> = {}) {
  return renderToStaticMarkup(<TodayPage session={session} turns={turns} monthly={monthly} query={{}} {...input} />);
}
function readers() {
  const unexpected = () => { throw new Error("Unexpected infrastructure call"); };
  return compile(source("src/server/today-v3.ts"), {
    "./b3-repair-turns": { staffRepairTurns: async () => off },
    "./b3-payment-turns": { staffPaymentTurns: unexpected }, "./b3-rental-turns": { staffRentalTurns: unexpected },
    "./b3-overdue-turns": { staffOverdueTurns: unexpected }, "./b017-custom-role-governance": {}, "./db": { tx: unexpected },
    "./errors": { FlowError, logServerError: () => undefined }, "./org-guard": {}, "./perms": perms, "./queries": { rentRoll: unexpected },
  }) as typeof import("./today-v3");
}
function readDeps() {
  return { repairs: async () => off, enabled: async () => true, payments: async () => payments, rentals: async () => rentals, overdue: async () => overdue, roomUnits: async () => turns.roomUnits };
}

test("B3A-TODAY / T-ROWS: both groups, uncapped counts, approved turn anatomy and destinations", () => {
  const html = render();
  assert.match(html, /王怡君早，今天輪到你的有 4 件。/);
  assert.match(html, /確認已繳款 1 筆、詢問續約意願 1 件、提早找租客 1 件、找新租客 1 件。另外 2 件在等租客。/);
  assert.ok(html.indexOf('id="today-mine-title"') < html.indexOf('id="today-others-title"'));
  assert.match(html, /輪到你・4 件/); assert.match(html, /等別人・2 件/);
  for (const href of ["/m/payments", "/m/rent", "/m/units/parent-unit/invite", "/m/leases/lease-renewal_ask"]) assert.ok(html.includes(`href="${href}"`));
  assert.match(html, /空了 16 天・每月少收 NT\$12,000/);
  assert.match(html, /16 天後到期/); assert.match(html, /逾期 13 天/); assert.match(html, /林小姐・逾期未繳 NT\$28,000/); assert.doesNotMatch(html, /10 月租金/); // several invoices or charges → 逾期未繳
  assert.match(html, /等租客陳先生重新回報/); assert.match(html, /等租客林小姐繳款/);
  assert.match(html, /周小姐不續約・/); // declined renewal
  assert.doesNotMatch(html, /已提醒|發送繳租提醒|派工|等屋主|廠商/);
  assert.equal((html.match(/class="party party-/g) ?? []).length, 6);
  assert.doesNotMatch(html, /<button|class="btn pri"/);
});

test("T-WAIT and SH-NONAME waiting: only tenant-held group and no invented parties", () => {
  const waiting = { ...turns, payments: { ...payments, mine: [], yourTurn: 0, counts: [{ holder: "tenant" as const, step: "re_report" as const, count: 1 }] }, rentals: off };
  const html = render({ turns: waiting });
  assert.match(html, /王怡君早，今天沒有輪到你的事。/); assert.match(html, /另外 2 件在等租客。/);
  assert.doesNotMatch(html, /data-testid="today-mine"|在等租客、屋主|今天都處理好了/);
  assert.match(render({ turns: waiting, session: { ...session, name: "  " } }), /<h1[^>]*>今天沒有輪到你的事。<\/h1>/);
});

test("T-CLEAR: drawing 01 and only checked areas; no primary, no monetary placeholder", () => {
  const html = render({ turns: emptyTurns, monthly: undefined });
  assert.match(html, /王怡君早，今天都處理好了。/); assert.match(html, /data-v3-illustration="01"/);
  assert.match(html, /收款、出租與租約都看過了，沒有要處理的事。/);
  assert.doesNotMatch(html, /維修|0 件|NT\$0|btn pri/);
  const accountant = render({ turns: { ...emptyTurns, rentals: off }, session: { ...session, role: "accountant", name: "" } });
  assert.match(accountant, /<h1[^>]*>今天都處理好了。<\/h1>/); assert.match(accountant, /收款都看過了/);
  assert.doesNotMatch(accountant, /出租與租約/);
});

test("T-FAIL: any unavailable source removes all turn counts and rows; monthly figure independent", () => {
  for (const key of ["payments", "rentals", "overdue"] as const) {
    const html = render({ turns: { ...turns, [key]: { state: "unavailable" } } });
    assert.match(html, /<h1[^>]*>王怡君早。<\/h1>/); assert.match(html, /待辦暫時讀不到。/);
    assert.match(html, /你的資料都還在，稍後再看一次。/); assert.match(html, /class="btn o" type="submit">再試一次/);
    assert.match(html, /data-testid="confirmed-bills"/); assert.doesNotMatch(html, /\d+ 件|今天都處理好了|data-testid="today-(mine|others)"/);
  }
  const nameless = render({ turns: { ...turns, overdue: { state: "unavailable" } }, session: { ...session, name: "" } });
  assert.match(nameless, /<h1[^>]*>待辦暫時讀不到。<\/h1>/);
  assert.equal((nameless.match(/待辦暫時讀不到。/g) ?? []).length, 1); assert.doesNotMatch(nameless, />早。|fixture@/);
});

test("forbidden/off contributes nothing; unexpected rejection becomes unavailable; no reader mutation", async () => {
  const api = readers();
  assert.deepEqual(await api.readTodayTurn(async () => { throw new FlowError("errors.forbidden"); }), off);
  assert.deepEqual(await api.readTodayTurn(async () => { throw new Error("read failed"); }), { state: "unavailable" });
  const result = await api.readTodayTurns(session, { ...readDeps(), rentals: async () => { throw new FlowError("errors.forbidden"); } });
  assert.equal(result.rentals.state, "off"); assert.match(render({ turns: result }), /輪到你的有 1 件/);
  assert.doesNotMatch(render({ turns: result }), /找新租客|詢問續約意願/);
});

test("accountant payment-only and maintenance has no payment/rental reads", async () => {
  const api = readers();
  const forbiddenRental = async () => { assert.fail("accountant must not read rentals"); };
  const result = await api.readTodayTurns({ ...session, role: "accountant" }, { ...readDeps(), rentals: forbiddenRental });
  const html = render({ session: { ...session, role: "accountant" }, turns: result });
  assert.match(html, /輪到你的有 1 件/); assert.match(html, /等別人・2 件/); assert.match(html, /confirmed-bills/);
  assert.doesNotMatch(html, /找新租客|詢問續約|live-onboarding/);
  const nothing = async () => { assert.fail("maintenance must not read turns"); };
  const maintenance = await api.readTodayTurns({ ...session, role: "maintenance" }, { ...readDeps(), payments: nothing, rentals: nothing, overdue: nothing });
  assert.deepEqual(maintenance, { payments: off, rentals: off, overdue: off, repairs: off, roomUnits: {} });
});

test("T-NUM-ZERO and multi-currency: positive bills, zero confirmed; default first and independent totals", () => {
  const data = { ...monthly, rows: [{ currency: "USD", due: "10000", received: "2900" }, { currency: "TWD", due: "3200000", received: "0" }, { currency: "TWD", due: "0", received: "0" }] };
  const html = render({ monthly: data });
  assert.ok(html.indexOf('data-currency="TWD"') < html.indexOf('data-currency="USD"'));
  assert.match(html, /還沒有確認的繳款/); assert.match(html, /應繳 NT\$32,000・已確認 0／1 筆/);
  assert.match(html, /value="0" max="100"/); assert.match(html, /value="29" max="100"/);
  assert.doesNotMatch(html, />NT\$0</); assert.equal((html.match(/>查來源<\/a>/g) ?? []).length, 2);
  assert.equal(model.monthlyBillTotals([{ currency: "TWD", due: "100", received: "100" }, { currency: "TWD", due: "200", received: "250" }])[0][1].paid, 2);
  assert.equal(model.hasMonthlyFigure({ ...monthly, rows: [{ currency: "TWD", due: "0", received: "0" }] }), false);
  assert.equal(model.hasMonthlyFigure(undefined), false);
});

test("T-MORE: first 50 oldest rows, uncapped headline and source links for every mixed group", () => {
  const large: StaffPaymentTurns = { ...payments, yourTurn: 62, counts: [{ holder: "manager", step: "confirm_payment", count: 62 }], mine: Array.from({ length: 50 }, (_, i) => payment(`p-${i}`, "P1", `2026-11-${String(1 + (i % 14)).padStart(2, "0")}T00:00:00Z`)), others: [] };
  const all: TodayTurns = { ...emptyTurns, payments: large };
  const html = render({ turns: all });
  assert.match(html, /今天輪到你的有 62 件/); assert.match(html, /看全部 62 件/);
  assert.equal((html.match(/class="v3-today-row"/g) ?? []).length, 50);
  const overview = model.todayOverview({ ...turns, payments: large });
  assert.equal(overview.state, "ready");
  if (overview.state === "ready") {
    assert.equal(overview.mine.length, 50); assert.equal(overview.mineCount, 65);
    assert.deepEqual(new Set(overview.mineMore.map(item => item.href)), new Set(["/m/payments", "/m/leases", "/m/units"]));
    const times = overview.mine.map(item => item.type === "payment" ? item.row.since : item.type === "rental" ? item.row.date! : item.row.oldestDueDate);
    assert.deepEqual(times, [...times].sort());
  }
  const manyOthers = render({ turns: { ...emptyTurns, overdue: { ...overdue, count: 78 } } });
  assert.match(manyOthers, /href="\/m\/rent">看全部 78 件/);
});

test("SH-NONAME ready and SH-SANDBOX supporting line; English copy remains readable", () => {
  const html = render({ session: { ...session, name: "  " } });
  assert.match(html, /<h1[^>]*>今天輪到你的有 4 件。<\/h1>/); assert.doesNotMatch(html, /早，|fixture@/);
  const sandbox = render({ session: { ...session, environment: "sandbox" } });
  assert.match(sandbox, /這裡的人名、地址和金額都是範例。/); assert.doesNotMatch(sandbox, /另外 2 件在等租客/);
  const english = render({ session: { ...session, locale: "en" } });
  assert.match(english, /Good morning, 王怡君/); assert.match(english, /Waiting for the tenant 陳先生 to report again/);
  assert.doesNotMatch(english, /\{count\}|\{name\}|\{month\}|\{amount\}/);
});

function setup(step: 0 | 1 | 2 | 3 | 4, role: "admin" | "manager" = "admin", complete = false): SetupProgress {
  const allowed = (key: perms.PermKey) => perms.can(role, key);
  return { step, checklistOn: true, hasUnits: step >= 2, inviteMode: "m4", inviteHref: "/m/units/unit/invite", unmappedEntryOk: true, customAuthority: false,
    tenantJoined: complete, permissions: perms.PERMS.flatMap(([key]) => allowed(key) ? [key] : []), checklist: setupChecklist([step > 0, step > 1, step > 2, complete], complete ? "2026-11-14" : null, allowed) };
}
test("setup is a shared separate card above groups, excludes headline count and has at most one primary", () => {
  for (const role of ["admin", "manager"] as const) for (const step of [0, 1, 2, 3] as const) {
    const html = render({ setup: setup(step, role), session: { ...session, role } });
    assert.match(html, /輪到你的有 4 件/);
    assert.ok(html.indexOf('data-testid="live-onboarding"') < html.indexOf('data-testid="today-mine"'));
    assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1);
  }
  const complete = render({ setup: setup(4, "admin", true) });
  assert.match(complete, /<details class="setup-checklist setup-complete"/); assert.doesNotMatch(complete, /class="btn pri"/);
  const accountant = render({ session: { ...session, role: "accountant" }, setup: setup(0) });
  assert.doesNotMatch(accountant, /live-onboarding/);
});

test("missing optional rental fields omit clauses; missing parent lookup fails instead of linking a room as a unit", async () => {
  const sparse = { ...rental(), dayNumber: null, rentMinor: null, rentCurrency: null };
  const html = render({ turns: { ...turns, rentals: { ...rentals, mine: [sparse] } } });
  assert.doesNotMatch(html, /空了 0 天|每月少收 NT\$0/);
  assert.equal(model.todayRowHref({ type: "rental", row: { ...rental(), targetKind: "unit", targetId: "whole-unit" } }, {}), "/m/units/whole-unit/invite");
  assert.throws(() => model.todayRowHref({ type: "rental", row: rental() }, {}), /Missing rental turn unit/);
  const result = await readers().readTodayTurns(session, { ...readDeps(), roomUnits: async () => { throw new Error("lookup failed"); } });
  assert.equal(result.rentals.state, "unavailable"); assert.match(render({ turns: result }), /today-failure/);
});

test("monthly adapter uses DB month, omits errors/forbidden and rollover instead of inventing zero", async () => {
  const api = readers();
  const rows = async () => [] as Awaited<ReturnType<typeof import("./queries").rentRoll>>;
  const context = async () => ({ period: "2026-11", currency: "TWD" });
  assert.deepEqual(await api.readTodayMonthly(session, { context, rows }), { rows: [], month: 11, defaultCurrency: "TWD" });
  for (const error of [new Error("unavailable"), new FlowError("errors.forbidden")]) assert.equal(await api.readTodayMonthly(session, { context, rows: async () => { throw error; } }), undefined);
  let calls = 0;
  assert.equal(await api.readTodayMonthly(session, { rows, context: async () => ({ period: calls++ ? "2026-12" : "2026-11", currency: "TWD" }) }), undefined);
});

test("signup notices retain existing copy and consume only their two result parameters", () => {
  const html = render({ query: { dupFirm: "1", code: "list" } });
  assert.match(html, /role="status"/); assert.match(html, /data-testid="dup-firm"/); assert.match(html, /data-testid="code-list"/);
  assert.doesNotMatch(render(), /data-testid="dup-firm"|data-testid="code-list"/);
  const text = source("src/components/v3/m/today/signup-notice.tsx");
  assert.match(text, /replaceState\(window.history.state/); assert.match(text, /url.hash/);
});

const baseline = (file: string) => execFileSync("git", ["show", `db64f31:${file}`], { encoding: "utf8" });
test("flag OFF /m is byte-identical to the exact branch base, including reads and guards", async () => {
  assert.equal(source("src/components/dashboard-content.tsx"), baseline("src/components/dashboard-content.tsx"));
  for (const query of [{}, { dupFirm: "1" }, { code: "list" }]) {
    const calls: string[] = [];
    const marker = ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => <div data-props={JSON.stringify(props)}>{children}</div>;
    const mocks = {
      "@/components/notification-center-entry": { NotificationCenterEntry: marker }, "@/components/dashboard-content": { DashboardContent: marker },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
      "@/server/b017-custom-role-governance": { guardEffectiveSession: async (value: Session, key: string) => { calls.push(key); return value; } },
      "@/server/brand-v2": { brandV2EnabledForOrg: async () => { calls.push("v2"); return true; } },
      "@/server/onboarding-progress": { readSetupStep: async () => { calls.push("setup"); return setup(0); } },
      "@/lib/empty-cta": emptyCta, "@/server/queries": { dashboard: async () => { calls.push("dashboard"); return { fixture: true }; } },
      "@/server/session": { getSession: async () => session }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => false },
      "@/server/today-v3": { readTodayTurns: () => assert.fail("OFF must not read turns"), readTodayMonthly: () => assert.fail("OFF must not read monthly") },
      "@/components/v3/m/today/today": { TodayPage: () => assert.fail("OFF must not render TodayPage") },
    };
    type Page = (p: { searchParams: Promise<{ dupFirm?: string; code?: string }> }) => Promise<React.ReactNode>;
    const old = compile(baseline("src/app/m/page.tsx"), mocks).default as Page;
    const next = compile(source("src/app/m/page.tsx"), mocks).default as Page;
    const before = renderToStaticMarkup(await old({ searchParams: Promise.resolve(query) }));
    const oldCalls = calls.splice(0);
    const after = renderToStaticMarkup(await next({ searchParams: Promise.resolve(query) }));
    assert.equal(after, before); assert.deepEqual(calls, oldCalls);
  }
});

test("Today CSS is wholly v3-scoped and reuses tokens; original readers stay byte-identical", () => {
  const css = postcss.parse(source("public/brand/v3/today.css"));
  css.walkRules(rule => assert.ok(rule.selector.startsWith('html[data-brand="v2"][data-brand-v3]'), rule.selector));
  css.walkDecls(declaration => assert.doesNotMatch(declaration.value, /#[0-9a-f]{3,8}\b|rgba?\(/i));
  // The rental and overdue readers gain two fields for the T-ROWS sublines (hub PR #15); their own tests cover them.
  // The payment reader now takes its pending-report predicate from b3-payment-eligibility (shared with the money
  // month readers, phase 3 PR 1); its own tests cover it. The two other originals stay byte-identical.
  for (const name of ["queries.ts", "onboarding-progress.ts"]) assert.equal(source(`src/server/${name}`), baseline(`src/server/${name}`));
});

test("Today composition gates P1/P2 without changing the shared payment reader", async () => {
  const api = readers();
  const never = async () => { assert.fail("disabled Today must not load turn readers"); };
  const result = await api.readTodayTurns(session, { ...readDeps(), enabled: async () => false, payments: never, rentals: never, overdue: never });
  assert.deepEqual(result, { payments: off, rentals: off, overdue: off, repairs: off, roomUnits: {} });
  const html = render({ turns: result });
  assert.doesNotMatch(html, /今天都處理好了|today-clear|0 件/); assert.match(html, /confirmed-bills/);
  assert.match(render({ turns: result, session: { ...session, name: "" } }), /<h1[^>]*>今天<\/h1>/);
  const failed = await api.readTodayTurns(session, { ...readDeps(), enabled: async () => { throw new Error("gate timeout"); }, payments: never, rentals: never, overdue: never });
  assert.equal(model.todayOverview(failed).state, "unavailable");
});

test("effective pay.record denial removes payment and overdue rows while stmt.view can still supply the figure", async () => {
  const limited: Session = { ...session, role: "accountant", customRole: { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId,
    nativeRole: "accountant", assigned: true, keys: ["dash.view", "stmt.view"], photos: false, audit: false } };
  const never = async () => { assert.fail("no effective payment grant"); };
  const result = await readers().readTodayTurns(limited, { ...readDeps(), payments: never, rentals: never, overdue: never });
  assert.deepEqual(result, { payments: off, rentals: off, overdue: off, repairs: off, roomUnits: {} });
  assert.equal(perms.can(limited, "stmt.view"), true);
});

test("T-A never claims operational all-clear and keeps the existing explanation and alternate links", () => {
  const html = render({ turns: emptyTurns, monthly: undefined, setup: setup(0) });
  assert.match(html, /先建立第一個單位/); assert.match(html, /還沒有單位，所以還沒有待辦。/);
  assert.match(html, /href="\/m\/import"/); assert.match(html, /href="\/m\/units\/new"/);
  assert.match(html, /href="\/api\/env\?set=sandbox&amp;next=\/m"/);
  assert.doesNotMatch(html, /今天都處理好了|today-clear|0 件/);
  const withoutChecklist = render({ turns: emptyTurns, setup: { ...setup(0), checklistOn: false, checklist: null } });
  assert.match(withoutChecklist, /先建立第一個單位/); assert.match(withoutChecklist, /href="\/m\/import"/);
  assert.doesNotMatch(withoutChecklist, /今天都處理好了|today-clear|live-onboarding/);
  assert.match(render({ turns: emptyTurns, setup: setup(0), session: { ...session, name: "" } }), /先建立第一個單位/);
});

test("manager's next visible setup step survives incomplete admin-only company information", () => {
  const progress = { ...setup(2, "manager"), step: 0 as const };
  progress.checklist = setupChecklist([false, true, false, false], null, key => perms.can("manager", key));
  const html = render({ session: { ...session, role: "manager" }, setup: progress });
  assert.match(html, /href="\/m\/units\/unit\/invite"/);
  assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /href="\/m\/settings"/);
});

test("setup read failure uses T-FAIL without suppressing a successful monthly figure", () => {
  const html = render({ setupFailed: true });
  assert.match(html, /today-failure/); assert.match(html, /confirmed-bills/);
  assert.doesNotMatch(html, /\d+ 件|today-clear|today-mine/);
});

test("v3 route preserves consent/dashboard guard; accountant skips setup and every role skips legacy dashboard reads", async () => {
  for (const role of ["admin", "manager", "accountant"] as const) {
    const current = { ...session, role };
    const calls: string[] = [];
    const api = readers();
    const mocks = {
      "@/components/notification-center-entry": {}, "@/components/dashboard-content": {},
      "@/components/v3/m/today/today": { TodayPage }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => true },
      "@/server/today-v3": { readTodayTurns: async () => emptyTurns, readTodayMonthly: async () => monthly, readTodayTurn: api.readTodayTurn },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
      "@/server/b017-custom-role-governance": { guardEffectiveSession: async (value: Session, key: string) => { calls.push(key); return value; } },
      "@/server/brand-v2": {}, "@/server/onboarding-progress": { readSetupStep: async () => { calls.push("setup"); throw new Error("setup timeout"); } },
      "@/lib/empty-cta": emptyCta, "@/server/queries": { dashboard: async () => assert.fail("ON must not load dashboard") },
      "@/server/session": { getSession: async () => current },
    };
    type Page = (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode>;
    const Page = compile(source("src/app/m/page.tsx"), mocks).default as Page;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    assert.deepEqual(calls, role === "accountant" ? ["consent", "dash.view"] : ["consent", "dash.view", "setup"]);
    assert.match(html, /confirmed-bills/);
    if (role !== "accountant") assert.match(html, /today-failure/);
  }
});


test("T-ROWS (hub PR #15): overdue subline names the rent month only for exactly one rent invoice; early vacancy says 不續約 only for a declined renewal", () => {
  const one = { ...turns, overdue: { state: "ready" as const, count: 1, others: [{ ...(overdue as { others: OverdueTurnRow[] }).others[0], singleRentInvoice: true }] } };
  assert.match(render({ turns: one }), /林小姐・10 月租金 NT\$28,000/);
  const notice = { ...turns, rentals: { ...(rentals as Extract<StaffRentalTurns, { state: "ready" }>), mine: [{ ...rental("early_vacancy"), reason: "notice" as const }] } };
  const html = render({ turns: notice });
  assert.match(html, /周小姐・2026年11月30日 搬出/); assert.doesNotMatch(html, /不續約/);
});

test("T-MORE / R6: the group's first 50 follow kind order then date, even when an older row of a later kind exists", async () => {
  const { todayOverview } = await import("../lib/b3-today");
  const renewals = Array.from({ length: 50 }, (_, i) => ({ ...rental("renewal_ask"), targetId: `r${i}`, leaseId: `l${i}`, date: "2026-12-20" }));
  const oldVacancy = { ...rental("vacant"), targetId: "old", date: "2026-01-01" };
  const view = todayOverview({ payments: noPayments, overdue: noOverdue, roomUnits: {},
    rentals: { state: "ready", counts: { vacant: 1, renewalAsk: 50, earlyVacancy: 0 }, mine: [...renewals, oldVacancy] } });
  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.equal(view.mineCount, 51);
  assert.equal(view.mine.length, 50);
  assert.ok(view.mine.every(item => item.type === "rental" && item.row.kind === "renewal_ask"), "R6: renewals come before vacancies");
  assert.ok(view.mineMore.some(more => more.kind === "vacant" && more.count === 1), "the vacancy stays reachable through 看全部");
});

test("B3A-TODAY-NUM: money page owns 未結餘額; 報修 and 出租 stay unchanged", () => {
  const html = render({ interim: { outstanding: "4180000", owingCount: 3, tickets: 2, occupied: 4, rooms: 5 } });
  const after = html.split('data-testid="today-monthly"')[1] ?? "";
  assert.match(after, /data-testid="today-interim"/);
  assert.doesNotMatch(after, /dash-outstanding|未結餘額|NT\$41,800/); assert.match(after, /href="\/m\/tickets"/); assert.match(after, /href="\/m\/leases"[^>]*>.*4\/5/);
  assert.doesNotMatch(html, /dash-received|i_pending_pay|待確認繳款<\/div>/);
});

test("3b repair-only custom manager is not skipped; failed admitted repair source suppresses data headline", async () => {
  const limited: Session = { ...session, role: "manager", customRole: { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId,
    nativeRole: "manager", assigned: true, keys: ["tickets.update"], photos: true, audit: false } };
  let calls = 0;
  const result = await readers().readTodayTurns(limited, { ...readDeps(), repairs: async () => { calls++; return { state: "unavailable" }; } });
  assert.equal(calls, 1); assert.equal(result.payments.state, "off"); assert.equal(result.rentals.state, "off");
  assert.deepEqual(model.todayTurnCounts(result), { state: "unavailable" });
  assert.deepEqual(model.todayOverview(result), { state: "unavailable" });
});
