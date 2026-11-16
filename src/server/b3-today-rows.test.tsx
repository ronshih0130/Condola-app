import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import * as model from "../lib/b3-today";
import * as emptyCta from "../lib/empty-cta";
import * as format from "./format";
import * as perms from "./perms";
import { FlowError } from "./errors";
import { compareRepairMine, staffRepairTodayTurns, REPAIR_TODAY_MAX_PAGES, type RepairMatter, type StaffRepairTurns } from "./b3-repair-turns";
import { repairDayNumber, repairWhy, todayRepairRows, type TodayRepairRow, type TodayRepairs } from "./b3-today-repairs";
import type { Session } from "./types";
import type { PaymentTurnMatter, StaffPaymentTurns } from "./b3-payment-turns";
import type { RentalTurnRow, StaffRentalTurns } from "./b3-rental-turns";
import type { StaffOverdueTurns } from "./b3-overdue-turns";
import type { TodayTurns } from "../lib/b3-today";

// MGT-148 (T-ROWS-2) and MGT-149 (T-REPAIR), Round 7 batch 2 frames 「第七輪・第二批」. Synthetic fixtures only.
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
const NOW = new Date("2026-11-16T02:00:00Z");
const session: Session = { kind: "staff", role: "manager", orgId: "org", liveOrgId: "org", userId: "user", sessionId: "session", name: "王怡君", email: "fixture@example.invalid", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const off = { state: "off" } as const;
const avatar = compile(source("src/components/v3/role-avatar.tsx"), { "../../i18n/lanes/brand-v3": copy });
const emptyState = compile(source("src/components/empty-state.tsx"), { "next/link": link, "@/i18n": i18n, "./empty-illustration": { EmptyIllustration: () => null } });
const onboarding = compile(source("src/components/onboarding-progress.tsx"), { "@/i18n": i18n, "./empty-state": emptyState });
const today = compile(source("src/components/v3/m/today/today.tsx"), {
  "next/link": link, "../../../../i18n": i18n, "../../../../i18n/lanes/brand-v3": copy,
  "../../../../lib/b3-today": model, "../../../../lib/empty-cta": emptyCta, "../../../../server/format": format,
  "../../../../server/sandbox-data": { displaySampleName: (name: string) => name }, "../../../onboarding-progress": onboarding,
  "../../../empty-state": emptyState, "../../role-avatar": avatar, "./clear-drawing": compile(source("src/components/v3/m/today/clear-drawing.tsx"), {}),
  "./signup-notice": compile(source("src/components/v3/m/today/signup-notice.tsx"), { "../../../../i18n": i18n }),
});
const TodayPage = today.TodayPage as typeof import("../components/v3/m/today/today").TodayPage;
const render = (turns: TodayTurns, extra: Partial<Parameters<typeof TodayPage>[0]> = {}) =>
  renderToStaticMarkup(<TodayPage session={session} turns={turns} query={{}} now={NOW} {...extra} />);

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function repair(holder: RepairMatter["holder"], step: RepairMatter["step"], extra: Partial<TodayRepairRow> = {}): TodayRepairRow {
  return { ticketId: id(), rule: holder === "owner" ? "R3" : holder === "vendor" ? (step === "report_cost" ? "R7a" : "R7b") : step === "confirm_cost" ? "R2" : "R8",
    holder, step, viewerCanAct: holder === "manager", since: "2026-11-10T00:00:00Z", sinceExact: false, timezone: "Asia/Taipei",
    place: "景興路套房", title: "洗手台漏水", why: null, dayNumber: null, ...extra };
}
function repairs(mine: TodayRepairRow[], others: TodayRepairRow[] = [], extraCounts: Extract<TodayRepairs, { state: "ready" }>["counts"] = []): TodayRepairs {
  const counts = new Map<string, { holder: RepairMatter["holder"]; step: RepairMatter["step"]; canAct: boolean; count: number }>();
  for (const row of [...mine, ...others]) {
    const key = `${row.holder}:${row.step}:${row.viewerCanAct}`;
    const current = counts.get(key) ?? { holder: row.holder, step: row.step, canAct: row.viewerCanAct, count: 0 };
    current.count++; counts.set(key, current);
  }
  return { state: "ready", counts: [...counts.values(), ...extraCounts], yourTurn: mine.length + extraCounts.filter(c => c.holder === "manager" && c.canAct).reduce((s, c) => s + c.count, 0), mine, others };
}
function payment(rule: "P1" | "P2"): PaymentTurnMatter {
  return { id: `pay-${rule}`, rule, holder: rule === "P1" ? "manager" : "tenant", step: rule === "P1" ? "confirm_payment" : "re_report", since: "2026-11-12T00:00:00Z",
    sinceExact: true, timezone: "Asia/Taipei", amountMinor: 3200000, currency: "TWD", paidOn: "2026-11-11", leaseId: "lease-1", place: "松仁匯 7F", tenantName: "陳先生" };
}
function rental(kind: RentalTurnRow["kind"]): RentalTurnRow {
  return { kind, targetKind: "unit", targetId: `unit-${kind}`, propertyId: "property", place: "民生社區 5F", tenantName: kind === "vacant" ? null : "周小姐",
    leaseId: `lease-${kind}`, date: "2026-12-31", dayNumber: 45, rentMinor: null, rentCurrency: null, reason: kind === "early_vacancy" ? "declined" : null };
}
const payments: StaffPaymentTurns = { state: "ready", counts: [{ holder: "manager", step: "confirm_payment", count: 1 }, { holder: "tenant", step: "re_report", count: 1 }],
  yourTurn: 1, mine: [payment("P1")], others: [payment("P2")] };
const rentals: StaffRentalTurns = { state: "ready", counts: { vacant: 1, renewalAsk: 1, earlyVacancy: 1 }, mine: [rental("vacant"), rental("renewal_ask"), rental("early_vacancy")] };
const overdue: StaffOverdueTurns = { state: "ready", count: 1, others: [{ leaseId: "lease-o", currency: "TWD", amountMinor: "2800000", oldestDueDate: "2026-11-01", oldestMonth: 11,
  singleRentInvoice: true, dayNumber: 4, tenantName: "林小姐", place: "忠孝大樓 3F", reminderCount: null }] };
const empty: TodayTurns = { payments: { state: "ready", counts: [], yourTurn: 0, mine: [], others: [] }, rentals: { state: "ready", counts: { vacant: 0, renewalAsk: 0, earlyVacancy: 0 }, mine: [] },
  overdue: { state: "ready", count: 0, others: [] }, roomUnits: {} };
const kinds = {
  bank: { state: "ready" as const, count: 1, oldestMonth: "2026-10", since: "2026-10-28" },
  monthClose: { state: "ready" as const, row: { period: "2026-10", month: 10, owners: 2, since: "2026-11-01" } },
  reply: { state: "ready" as const, threads: 3, oldest: "2026-11-15T00:00:00Z" },
};
const turnTexts = (html: string, group: "mine" | "others") =>
  [...(html.split(`data-testid="today-${group}"`)[1] ?? "").split("</section>")[0].matchAll(/<span class="v3-today-turn">.*?<\/span><span>(.*?)<\/span>/g)].map(m => m[1]);

test("T-ROWS-2 / T-REPAIR full frame: kind order, one avatar and sentence per row, whole-row links, no buttons", () => {
  const mineRepairs = [repair("manager", "in_progress", { place: "松仁匯 7F", title: "冷氣不冷", rule: "R8-blocked", why: "link", since: "2026-11-01T00:00:00Z" }),
    repair("manager", "re_estimate", { place: "民生社區 5F", title: "冷氣不冷", rule: "R5" }),
    repair("manager", "dispatch", { place: "信義路 2 樓", title: "浴室天花板滴水", rule: "R6", why: "declined" }),
    repair("manager", "confirm_cost", { sinceExact: true, dayNumber: 1 })];
  const otherRepairs = [repair("owner", "approve_estimate", { viewerCanAct: false, title: "熱水器不熱", since: "2026-11-09T00:00:00Z" }),
    repair("vendor", "do_repair", { viewerCanAct: false, title: "冷氣不冷", since: "2026-11-11T00:00:00Z" }),
    repair("manager", "confirm_cost", { viewerCanAct: false, rule: "R2", since: "2026-11-08T00:00:00Z" })];
  const turns: TodayTurns = { payments, rentals, overdue, roomUnits: {}, repairs: repairs(mineRepairs, otherRepairs), ...kinds };
  const html = render(turns);
  // Headline N counts each matter once; 待你回覆 is one summary row (3 conversations → 1).
  assert.match(html, /王怡君早，今天輪到你的有 11 件。/);
  assert.match(html, /輪到你・11 件/); assert.match(html, /等別人・5 件/);
  assert.deepEqual(turnTexts(html, "mine"), ["輪到你・確認已繳款", "輪到你・核對費用・第 1 天", "輪到你・派工", "輪到你・重新估價", "輪到你・處理中",
    "輪到你・回覆", "輪到你・開始對帳", "輪到你・開始月結", "輪到你・詢問續約意願", "輪到你・提早找租客", "輪到你・找新租客"]);
  // 等別人: payment and rental rows first, then repairs by date only.
  assert.deepEqual(turnTexts(html, "others"), ["等租客陳先生重新回報", "等租客林小姐繳款", "等管理方核對費用", "等屋主核准估價", "等廠商到場維修"]);
  for (const text of ["浴室天花板滴水・廠商沒有接", "冷氣不冷・廠商的連結已失效", "1 筆銀行明細還沒對上", "10 月還沒月結・2 位屋主在等報表", "3 則・最久 26 小時"]) assert.ok(html.includes(text), text);
  for (const href of mineRepairs.map(r => `/m/tickets/${r.ticketId}`).concat(["/m/bank?month=2026-10", "/m/close", "/m/messages"])) assert.ok(html.includes(`href="${href}"`), href);
  assert.equal((html.match(/<li data-turn-kind=/g) ?? []).length, 16);
  assert.equal((html.match(/class="party party-/g) ?? []).length, 16, "one holder avatar per row");
  assert.equal((html.match(/class="party party-o"/g) ?? []).length, 1); assert.equal((html.match(/class="party party-v"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button|class="btn pri"|rail|逾期 \d+ 天<\/span><\/a><\/li><li data-turn-kind="repair/);
  // T-LINE: every action in kind order, and only the parties that have rows.
  assert.match(html, /確認已繳款 1 筆、核對 1 筆費用、派工 1 件、重新估價 1 件、處理中 1 件、回覆 3 則、對帳 1 筆、月結 1 個月、詢問續約意願 1 件、提早找租客 1 件、找新租客 1 件。另外 5 件在等租客、屋主、廠商和管理方。/);
  // Main line property, second line the repair item; the overdue badge never appears without an agreed date (no source).
  assert.match(html, /<strong>信義路 2 樓<\/strong><span>浴室天花板滴水・廠商沒有接<\/span>/);
  assert.equal((html.match(/逾期 \d+ 天/g) ?? []).length, 1, "only the rent row's badge");
});

test("MGT-149-AC2/AC5: viewer who cannot act reads 等管理方{step}, never 輪到你, and is not counted", () => {
  const blocked = repair("manager", "confirm_cost", { viewerCanAct: false, rule: "R8-blocked" });
  const html = render({ ...empty, repairs: repairs([], [blocked, repair("vendor", "report_cost", { viewerCanAct: false })]) });
  assert.match(html, /王怡君早，今天沒有輪到你的事。/); assert.match(html, /另外 2 件在等廠商和管理方。/);
  assert.match(html, /等管理方核對費用/); assert.match(html, /等廠商回報費用/); assert.doesNotMatch(html, /輪到你・|第 \d+ 天|data-testid="today-mine"/);
  assert.throws(() => render({ ...empty, repairs: repairs([repair("manager", "done")]) }), /Unapproved repair step/);
});

test("sinceExact=false leaves the day clause out; exact waits gain 「・第 {n} 天」 from the property calendar", () => {
  assert.equal(repairDayNumber({ since: "2026-11-15T15:30:00Z", sinceExact: true, timezone: "Asia/Taipei" }, NOW), 2);
  assert.equal(repairDayNumber({ since: "2026-11-15T15:30:00Z", sinceExact: false, timezone: "Asia/Taipei" }, NOW), null);
  assert.equal(repairDayNumber({ since: null, sinceExact: true, timezone: "Asia/Taipei" }, NOW), null);
  const html = render({ ...empty, repairs: repairs([repair("manager", "dispatch")], [repair("owner", "approve_estimate", { viewerCanAct: false, dayNumber: 2, sinceExact: true })]) });
  assert.match(html, /輪到你・派工<\/span>/); assert.match(html, /等屋主核准估價・第 2 天/);
});

test("repair why: R6 declined; R8-blocked link only for expired, unshared (enhanced) or revoked; nothing else is explained", () => {
  const facts = { activeJob: true, expired: false, unshared: false, lastRevoked: false };
  assert.equal(repairWhy({ rule: "R6" }, facts, false), "declined");
  assert.equal(repairWhy({ rule: "R8-blocked" }, { ...facts, expired: true }, false), "link");
  assert.equal(repairWhy({ rule: "R8-blocked" }, { ...facts, unshared: true }, true), "link");
  assert.equal(repairWhy({ rule: "R8-blocked" }, { ...facts, unshared: true }, false), null, "legacy links need no sharing");
  assert.equal(repairWhy({ rule: "R8-blocked" }, facts, true), null, "authorisation/cost guard causes get no clause");
  assert.equal(repairWhy({ rule: "R8-blocked" }, { ...facts, activeJob: false, lastRevoked: true }, false), "link");
  assert.equal(repairWhy({ rule: "R8-blocked" }, { ...facts, activeJob: false }, false), null, "emergency with no job ever");
  for (const rule of ["R2", "R3", "R5", "R7a", "R7b", "R8"] as const) assert.equal(repairWhy({ rule }, { ...facts, expired: true, lastRevoked: true }, true), null, rule);
});

test("MGT-149-AC4: 輪到你 repairs sort by step first, exact before approximate, then oldest, then ticket id", () => {
  const rows = [repair("manager", "in_progress", { since: "2026-01-01T00:00:00Z" }), repair("manager", "re_estimate", { since: "2026-02-01T00:00:00Z" }),
    repair("manager", "dispatch", { since: "2026-11-01T00:00:00Z" }), repair("manager", "dispatch", { since: null }),
    repair("manager", "dispatch", { since: "2026-11-05T00:00:00Z", sinceExact: true }), repair("manager", "confirm_cost", { since: "2026-11-10T00:00:00Z" })];
  const sorted = [...rows].sort(compareRepairMine);
  assert.deepEqual(sorted.map(r => r.step), ["confirm_cost", "dispatch", "dispatch", "dispatch", "re_estimate", "in_progress"]);
  assert.deepEqual(sorted.slice(1, 4).map(r => r.since), ["2026-11-05T00:00:00Z", "2026-11-01T00:00:00Z", null]);
  const overview = model.todayOverview({ ...empty, repairs: repairs([...rows].reverse()) });
  assert.equal(overview.state, "ready");
  if (overview.state === "ready") assert.deepEqual(overview.mine.map(item => item.type === "repair" ? item.row.ticketId : ""), sorted.map(r => r.ticketId));
});

function snapshot(mine: RepairMatter[], others: RepairMatter[] = [], yourTurn = mine.length): Extract<StaffRepairTurns, { state: "ready" }> {
  return { state: "ready", counts: [], yourTurn, mine, others, next: { mine: null, others: null }, detail: null };
}
test("staffRepairTodayTurns reads every 輪到你 page on one repeatable-read client, then keeps the first 50 by step", async () => {
  const older = Array.from({ length: 60 }, (_, i) => repair("manager", "in_progress", { since: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  const newer = Array.from({ length: 3 }, () => repair("manager", "confirm_cost", { since: "2026-11-15T00:00:00Z" }));
  const all = [...older, ...newer];
  const calls: unknown[][] = [];
  const page = (rows: RepairMatter[], start: number) => ({ ...snapshot(rows.slice(start, start + 50), [], all.length),
    next: { mine: start + 50 < rows.length ? { since: rows[start + 49].since, ticketId: rows[start + 49].ticketId } : null, others: null } });
  let clients = 0;
  const transaction = (async (_user: string, callback: (client: unknown) => Promise<unknown>, options: unknown) => {
    clients++; assert.deepEqual(options, { isolation: "repeatable read" });
    return callback({ query: async (sql: string, args?: unknown[]) => {
      if (!sql.includes("b3_staff_repair_turns")) return { rows: [] };
      calls.push(args ?? []);
      const after = args?.[7] as { ticketId: string } | null;
      return { rows: [{ result: page(all, after ? all.findIndex(r => r.ticketId === after.ticketId) + 1 : 0) }] };
    } });
  }) as never;
  const result = await staffRepairTodayTurns({ ...session, role: "admin" }, { v3: async () => true, transaction });
  assert.equal(clients, 1); assert.equal(calls.length, 2); assert.equal(calls[1][6], "mine");
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.yourTurn, 63); assert.equal(result.mine.length, 50);
  assert.deepEqual(result.mine.slice(0, 3).map(r => r.step), ["confirm_cost", "confirm_cost", "confirm_cost"]);
  // A disagreeing snapshot, or more pages than the bound, is unavailable (T-FAIL), never a mis-ordered list.
  const short = (async (_u: string, cb: (client: unknown) => Promise<unknown>) => cb({ query: async (sql: string) =>
    ({ rows: sql.includes("b3_staff_repair_turns") ? [{ result: snapshot(newer, [], 9) }] : [] }) })) as never;
  assert.deepEqual(await staffRepairTodayTurns({ ...session, role: "admin" }, { v3: async () => true, transaction: short }), { state: "unavailable" });
  const endless = (async (_u: string, cb: (client: unknown) => Promise<unknown>) => cb({ query: async (sql: string) =>
    ({ rows: sql.includes("b3_staff_repair_turns") ? [{ result: { ...snapshot(newer, [], 1000), next: { mine: { since: null, ticketId: newer[0].ticketId }, others: null } } }] : [] }) })) as never;
  assert.deepEqual(await staffRepairTodayTurns({ ...session, role: "admin" }, { v3: async () => true, transaction: endless }), { state: "unavailable" });
  assert.equal(REPAIR_TODAY_MAX_PAGES, 20);
  const never = (async () => { throw new Error("transaction must not run"); }) as never;
  assert.deepEqual(await staffRepairTodayTurns(session, { v3: async () => false, transaction: never }), { state: "off" });
  await assert.rejects(staffRepairTodayTurns({ ...session, role: "accountant" }, { v3: async () => true, transaction: never }), (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
});

test("todayRepairRows adds the repair item and why facts; maintenance projection is no rows; missing facts fail", async () => {
  const blocked = repair("manager", "dispatch", { rule: "R8-blocked" });
  const facts = async () => ({ enhanced: false, facts: { [blocked.ticketId]: { title: "門鎖卡住", activeJob: true, expired: true, unshared: false, lastRevoked: false } } });
  const result = await todayRepairRows(session, { turns: async () => snapshot([blocked]), facts, now: () => NOW });
  assert.equal(result.state, "ready");
  if (result.state === "ready") { assert.equal(result.mine[0].title, "門鎖卡住"); assert.equal(result.mine[0].why, "link"); assert.equal(result.mine[0].dayNumber, null); }
  assert.deepEqual(await todayRepairRows(session, { turns: async () => ({ ...snapshot([]), projection: "maintenance" as const }), facts: async () => assert.fail("no lookup") }), off);
  await assert.rejects(todayRepairRows(session, { turns: async () => snapshot([blocked]), facts: async () => ({ enhanced: false, facts: {} }) }), /Missing repair row facts/);
  assert.deepEqual(await todayRepairRows(session, { turns: async () => snapshot([]), facts: async () => assert.fail("nothing to look up") }),
    { state: "ready", counts: [], yourTurn: 0, mine: [], others: [] });
  // An admitted row whose presentation lookup is denied is a failure (unavailable), never a silently absent source.
  await assert.rejects(todayRepairRows(session, { turns: async () => snapshot([blocked]), facts: async () => { throw new FlowError("errors.forbidden"); } }),
    (e: unknown) => !(e instanceof FlowError) && /denied/.test(String(e)));
  // A holder/step pair without an approved B6 sentence fails honestly instead of rendering invented text.
  await assert.rejects(todayRepairRows(session, { turns: async () => snapshot([], [repair("vendor", "dispatch", { viewerCanAct: false })]), facts }), /approved sentence/);
});

function readers() {
  return compile(source("src/server/today-v3.ts"), {
    "./b3-today-repairs": { todayRepairRows: async () => assert.fail("default repair reader") },
    "./b3-today-kinds": { todayBankTurn: async () => assert.fail("default bank reader"), todayMonthCloseTurn: async () => assert.fail("default month reader"), todayReplyTurn: async () => assert.fail("default reply reader") },
    "./b3-payment-turns": {}, "./b3-rental-turns": {}, "./b3-overdue-turns": {}, "./b017-custom-role-governance": {}, "./db": {},
    "./errors": { FlowError, logServerError: () => undefined }, "./org-guard": {}, "./perms": perms, "./queries": {},
  }) as typeof import("./today-v3");
}
const deps = (calls: string[]) => ({
  enabled: async () => true, roomUnits: async () => ({}),
  payments: async () => { calls.push("payments"); return payments; }, rentals: async () => { calls.push("rentals"); return rentals; },
  overdue: async () => { calls.push("overdue"); return overdue; }, repairs: async () => { calls.push("repairs"); return repairs([repair("manager", "dispatch")]); },
  bank: async () => { calls.push("bank"); return kinds.bank; }, monthClose: async () => { calls.push("monthClose"); return kinds.monthClose; },
  reply: async () => { calls.push("reply"); return kinds.reply; },
});

test("roles: the accountant reads money rows only; P-MNT reads nothing; manager has no bank/month-close (perms)", async () => {
  const api = readers();
  for (const [role, expected] of [["accountant", ["payments", "overdue", "bank", "monthClose"]], ["manager", ["payments", "rentals", "overdue", "repairs", "reply"]],
    ["admin", ["payments", "rentals", "overdue", "repairs", "bank", "monthClose", "reply"]], ["maintenance", []]] as const) {
    const calls: string[] = [];
    const turns = await api.readTodayTurns({ ...session, role }, deps(calls));
    assert.deepEqual(calls.sort(), [...expected].sort(), role);
    if (role === "accountant") {
      const html = render(turns, { session: { ...session, role } });
      assert.doesNotMatch(html, /待你回覆|報修|派工|找新租客/); assert.match(html, /銀行對帳/); assert.match(html, /月結/);
      assert.match(html, /今天輪到你的有 3 件。/);
    }
  }
  const custom: Session = { ...session, role: "manager", customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "manager", assigned: true, keys: ["tickets.update"], photos: true, audit: false } };
  const calls: string[] = [];
  await api.readTodayTurns(custom, deps(calls));
  assert.deepEqual(calls, ["repairs"], "repair-only custom manager still loads repair work");
});

test("T-FAIL: any new source failing hides the whole turn section and the count; forbidden is absent", async () => {
  for (const key of ["repairs", "bank", "monthClose", "reply"] as const) {
    const html = render({ payments, rentals, overdue, roomUnits: {}, ...kinds, repairs: repairs([repair("manager", "dispatch")]), [key]: { state: "unavailable" } });
    assert.match(html, /<h1[^>]*>王怡君早。<\/h1>/); assert.match(html, /待辦暫時讀不到。/);
    assert.doesNotMatch(html, /\d+ 件|data-testid="today-(mine|others)"/);
  }
  const api = readers();
  const result = await api.readTodayTurns({ ...session, role: "admin" }, { ...deps([]), bank: async () => { throw new FlowError("errors.forbidden"); }, reply: async () => { throw new Error("timeout"); } });
  assert.equal(result.bank?.state, "off"); assert.equal(result.reply?.state, "unavailable");
  assert.equal(model.todayOverview(result).state, "unavailable");
});

test("MGT-148-AC5: a kind whose flag is OFF has no row and no count; only kinds with rows are named", () => {
  const html = render({ ...empty, bank: off, monthClose: { state: "ready", row: null }, reply: { state: "ready", threads: 0, oldest: null } });
  assert.match(html, /今天都處理好了/); assert.doesNotMatch(html, /銀行對帳|月結|待你回覆|0 則|0 筆/);
  assert.match(html, /收款、出租與租約、訊息都看過了/);
  const offOnly = model.todayOverview({ payments: off, rentals: off, overdue: off, roomUnits: {}, repairs: off, bank: off, monthClose: off, reply: off });
  assert.equal(offOnly.state, "off");
});

test("T-MORE: more than 50 rows keeps the group's own order and links each kind; a one-row kind past 50 stays reachable", () => {
  const many = Array.from({ length: 62 }, (_, i) => repair("manager", "dispatch", { since: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  const turns: TodayTurns = { ...empty, repairs: { ...(repairs(many.slice(0, 50)) as Extract<TodayRepairs, { state: "ready" }>), yourTurn: 62,
    counts: [{ holder: "manager", step: "dispatch", canAct: true, count: 62 }] }, bank: kinds.bank };
  const html = render(turns);
  assert.match(html, /今天輪到你的有 63 件/); assert.equal((html.match(/<li data-turn-kind=/g) ?? []).length, 50);
  assert.match(html, /href="\/m\/tickets"><span>維修・<\/span>看全部 62 件/);
  assert.match(html, /href="\/m\/bank\?month=2026-10"><span>銀行對帳・<\/span>看全部 1 件/);
  const few = render({ ...empty, repairs: repairs([repair("manager", "dispatch")]), bank: kinds.bank });
  assert.doesNotMatch(few, /看全部/);
  const waiting = Array.from({ length: 51 }, () => repair("vendor", "do_repair", { viewerCanAct: false }));
  assert.match(render({ ...empty, repairs: { ...(repairs([], waiting.slice(0, 50)) as Extract<TodayRepairs, { state: "ready" }>), counts: [{ holder: "vendor", step: "do_repair", canAct: false, count: 51 }] } }),
    /href="\/m\/tickets">看全部 51 件/);
});

test("待你回覆 wait label and bank link month; English copy has no raw placeholders", () => {
  const c = copy.brandV3TodayCopy("zh-TW");
  const label = today.waitLabel as (copy: unknown, since: string | null, now: Date) => string;
  assert.equal(label(c, "2026-11-16T01:40:00Z", NOW), "1 小時");
  assert.equal(label(c, "2026-11-14T03:00:00Z", NOW), "47 小時");
  assert.equal(label(c, "2026-11-13T00:00:00Z", NOW), "3 天");
  assert.equal(label(c, null, NOW), "");
  assert.equal(model.bankHref("2026-10"), "/m/bank?month=2026-10"); assert.equal(model.bankHref("bad"), "/m/bank"); assert.equal(model.bankHref(null), "/m/bank");
  const english = render({ payments, rentals, overdue, roomUnits: {}, ...kinds, repairs: repairs([repair("manager", "dispatch", { why: "declined", rule: "R6" })], [repair("owner", "approve_estimate", { viewerCanAct: false })]) },
    { session: { ...session, locale: "en" } });
  assert.match(english, /Your turn · dispatch/); assert.match(english, /Waiting for the owner to approve the estimate/); assert.match(english, /The vendor declined/);
  assert.doesNotMatch(english, /\{[a-z]+\}/i);
});

test("approved new words are used verbatim (screens.md § Round 7 batch 2)", () => {
  const zh = copy.brandV3TodayCopy("zh-TW");
  assert.equal(zh.whyDeclined, "廠商沒有接"); assert.equal(zh.whyLink, "廠商的連結已失效");
  assert.equal(zh.bankLine, "{count} 筆銀行明細還沒對上"); assert.equal(zh.monthCloseLine, "{month} 月還沒月結・{count} 位屋主在等報表");
  assert.equal(zh.replyLine, "{count} 則・最久 {wait}"); assert.equal(zh.waitManager, "等管理方{step}");
  for (const word of ["核對費用", "派工", "重新估價", "處理中", "核准估價", "到場維修", "回報費用"]) assert.ok(Object.values(zh).includes(word), word);
  // Kinds with no data source stay hidden (GS-44): no strings for them ship.
  for (const missing of ["審閱期剩", "付押金", "簽名", "點交", "匯出", "加入失敗", "押金還沒結算", "逾期未完工"]) assert.ok(!JSON.stringify(zh).includes(missing), missing);
});
