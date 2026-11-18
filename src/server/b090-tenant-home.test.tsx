import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../i18n";
import * as brandCopy from "../i18n/lanes/brand-v3";
import * as laneModule from "../i18n/lanes/brand-v3-tenant-home";
import { brandV3TenantHomeCopy } from "../i18n/lanes/brand-v3-tenant-home";
import * as nav from "./nav-v3";
import { RoleAvatar } from "../components/v3/role-avatar";
import { ShellIcon } from "../components/v3/shell/icon";
import { Illustration } from "../components/v3/illustrations";
import { TenantHomeError, TenantHomeLoading, TenantHomeState, TenantHomeV3, tenantHomeSentence } from "../components/v3/tenant/home";
import { tenantShellContext, tenantShellCurrent } from "../components/v3/tenant/shell";
import { homeRepairStep, homeRepairs, tenantHomeFacts, tenantHomeHeadline, tenantHomeWaiting, type TenantHomeBill, type TenantHomeFacts } from "./b090-tenant-home-rules";
import { tenantHomeView, type TenantHomeView } from "./b090-tenant-home";
import type { tenantPaymentHistory } from "./tenant-payment-history";
import type { Session } from "./types";
import type { TenantShellView } from "./b090-tenant-shell";

// B-090 slice 1 (TEN-54, TEN-55-AC1). Stories: hub 07-brand/brand-3.0-1113/stories.md TEN-54/TEN-55; screens RT-HOME;
// frames 「首頁・已回報，還有兩件事」 and 「首頁・這個月都好了」; wording PR-023.

const BASE = "3a571efd6300dd092ae0de988f3fe1a761417fd2"; // origin/main before B-090 slice 1
const requireHere = createRequire(import.meta.url);
const source = (path: string) => readFileSync(path, "utf8");
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}

const facts = (over: Partial<TenantHomeFacts> = {}): TenantHomeFacts =>
  ({ pendingMinor: 0, nextDue: { month: "2026-11", dueOn: "2026-11-05" }, overdue: null, paidMonth: null, ...over });
const bill = (over: Partial<TenantHomeBill> = {}): TenantHomeBill =>
  ({ state: "due", overdue: false, balanceMinor: 1_850_000, paidMinor: 0, currency: "TWD", ...over });
const ready = (headline: ReturnType<typeof tenantHomeHeadline>, over: Partial<Extract<TenantHomeView, { state: "ready" }>> = {}) =>
  ({ state: "ready" as const, headline, waiting: false, currency: "TWD", repairs: [], ...over });
const html = (view: Extract<TenantHomeView, { state: "ready" }>, locale: "zh-TW" | "en" = "zh-TW", name = "陳怡君") =>
  renderToStaticMarkup(<TenantHomeV3 view={view} locale={locale} name={name} company="安居物業" />);

test("TEN-54-AC1: one headline per state, verbatim zh-TW sentences", () => {
  const sentence = (b: TenantHomeBill, f: TenantHomeFacts, name = "陳怡君") => tenantHomeSentence(tenantHomeHeadline(b, f), "TWD", "zh-TW", name, "安居物業");
  assert.equal(sentence(bill(), facts()), "陳怡君你好，11 月租金 NT$18,500，11/5 前繳。");
  assert.equal(sentence(bill(), facts(), " "), "11 月租金 NT$18,500，11/5 前繳。", "no name: the RT-PAY lead form");
  assert.equal(sentence(bill(), facts({ pendingMinor: 1_850_000 })), "已回報 NT$18,500，等安居物業確認。");
  assert.equal(sentence(bill({ state: "paid", balanceMinor: 0 }), facts({ nextDue: null, paidMonth: "2026-11" })), "11 月已繳清。");
  assert.equal(sentence(bill({ overdue: true }), facts({ overdue: { month: "2026-10", days: 3 } })), "10 月租金還沒繳，已經過了 3 天。");
  assert.equal(sentence(bill(), facts({ pendingMinor: 1_500_000 })), "11 月還差 NT$3,500。", "還差 = owed minus what is waiting");
  assert.equal(sentence(bill({ state: "partial", paidMinor: 1_000_000, balanceMinor: 850_000 }), facts()), "11 月還差 NT$8,500。");
  // overdue but something already paid or reported: still owed → 還差, not 「還沒繳」
  assert.equal(tenantHomeHeadline(bill({ overdue: true, paidMinor: 1 }), facts({ overdue: { month: "2026-10", days: 3 } })).kind, "partial");
  assert.equal(tenantHomeHeadline(bill({ overdue: true }), facts({ pendingMinor: 5, overdue: { month: "2026-10", days: 3 } })).kind, "partial");
  // nothing owed and not settled by confirmed payments: the bill's own existing label, never 已繳清
  for (const state of ["zero_charge", "credit", "offset", "no_invoice", "nonpayable", "unsigned"] as const) {
    const h = tenantHomeHeadline(bill({ state, balanceMinor: state === "credit" ? -100 : 0 }), facts({ nextDue: null, paidMonth: "2026-10" }));
    assert.deepEqual(h, { kind: "none", state });
  }
  assert.equal(tenantHomeSentence({ kind: "none", state: "unsigned" }, "TWD", "zh-TW", "x", "y"), "合約尚未簽署，帳單尚未開立。");
  // Codex r1: a positive balance never gives 已繳清, even when the input says "paid" (inconsistent).
  const odd = tenantHomeHeadline(bill({ state: "paid", balanceMinor: 100 }), facts({ nextDue: null, paidMonth: "2026-11" }));
  assert.notEqual(odd.kind, "paid");
  assert.deepEqual(odd, { kind: "none", state: "due" });
  assert.notEqual(tenantHomeSentence(odd, "TWD", "zh-TW", "x", "y"), tenantHomeSentence({ kind: "none", state: "paid" }, "TWD", "zh-TW", "x", "y"));
  assert.equal(tenantHomeHeadline(bill({ state: "paid", balanceMinor: 100 }), facts({ paidMonth: "2026-10" })).kind, "due");
  assert.deepEqual(tenantHomeHeadline(bill({ state: "paid", balanceMinor: 0 }), facts({ nextDue: null, paidMonth: null })), { kind: "none", state: "paid" });
  const en = (h: ReturnType<typeof tenantHomeHeadline>) => tenantHomeSentence(h, "TWD", "en", "Amy", "Anju");
  assert.equal(en({ kind: "due", month: "2026-11", amountMinor: 1_850_000, dueOn: "2026-11-05" }), "Hello Amy, November rent of NT$18,500 is due by Nov 5.");
  assert.equal(en({ kind: "overdue", month: "2026-10", days: 1 }), "October rent is unpaid and 1 day past due.");
});

test("TEN-54-AC1: facts come from the property's own date; months follow period_start, else the due date", () => {
  const f = tenantHomeFacts([
    { status: "paid", balance: 0, dueOn: "2026-10-05", periodStart: "2026-10-01" },
    { status: "paid", balance: 0, dueOn: "2026-09-05", periodStart: null },
    { status: "open", balance: 1_850_000, dueOn: "2026-12-05", periodStart: "2026-12-01" },
    { status: "partially_paid", balance: 500, dueOn: "2026-11-05", periodStart: null },
    { status: "void", balance: 99, dueOn: "2026-01-01", periodStart: null },
  ], "2026-11-08", 700);
  assert.deepEqual(f, { pendingMinor: 700, nextDue: { month: "2026-11", dueOn: "2026-11-05" }, overdue: { month: "2026-11", days: 3 }, paidMonth: "2026-10" });
  assert.equal(tenantHomeFacts([{ status: "open", balance: 1, dueOn: "2026-11-08", periodStart: null }], "2026-11-08", 0).overdue, null, "due today is not overdue");
  assert.throws(() => tenantHomeFacts([], "11/8", 0));
  assert.throws(() => tenantHomeFacts([], "2026-11-08", -1));
});

test("PLT-51 / TEN-54-AC1: the tick only when the manager confirmed; the clock when a report is waiting", () => {
  const paid = html(ready({ kind: "paid", month: "2026-11" }));
  assert.match(paid, /class="v3-check"/);
  assert.match(paid, /11 月已繳清。.*已確認/);
  assert.doesNotMatch(paid, /v3-wait/);
  for (const h of [{ kind: "due", month: "2026-11", amountMinor: 1, dueOn: "2026-11-05" }, { kind: "reported", amountMinor: 1 },
    { kind: "overdue", month: "2026-11", days: 2 }, { kind: "partial", month: "2026-11", restMinor: 1 }, { kind: "none", state: "zero_charge" }] as const) {
    assert.doesNotMatch(html(ready(h, { waiting: h.kind === "reported" || h.kind === "partial" })), /v3-check/, h.kind);
  }
  const reported = html(ready({ kind: "reported", amountMinor: 1_850_000 }, { waiting: true }));
  assert.match(reported, /<h1 class="t-home-lead">已回報 NT\$18,500，等安居物業確認。<\/h1>/);
  assert.match(reported, /data-testid="tenant-home-wait"><span class="v3-wait"[^>]*>.*<\/span>等安居物業確認，確認後這裡會打勾。<\/p>/);
  const w = (h: ReturnType<typeof tenantHomeHeadline>, pendingMinor: number) => tenantHomeWaiting(h, facts({ pendingMinor }));
  assert.equal(w({ kind: "reported", amountMinor: 5 }, 5), true);
  assert.equal(w({ kind: "partial", month: "2026-11", restMinor: 5 }, 5), true);
  assert.equal(w({ kind: "partial", month: "2026-11", restMinor: 5 }, 0), false, "partly paid, nothing waiting: no clock");
  assert.equal(w({ kind: "due", month: "2026-11", amountMinor: 5, dueOn: "2026-11-05" }, 0), false);
});

test("TEN-54-AC2: a repair card only for an open repair, newest first, with text links only", () => {
  assert.deepEqual(["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled", "x"].map(homeRepairStep),
    ["reported", "reported", "dispatched", "working", "working", null, null, null, null]);
  const rows = [
    { id: "a", title: "舊", status: "open", created_at: "2026-11-01" }, { id: "b", title: "完成", status: "closed", created_at: "2026-11-09" },
    { id: "c", title: "中", status: "assigned", created_at: "2026-11-05" }, { id: "d", title: "新", status: "in_progress", created_at: "2026-11-08" },
    { id: "e", title: "最舊", status: "triaged", created_at: "2026-10-01" },
  ];
  assert.deepEqual(homeRepairs(rows).map(r => [r.id, r.step]), [["d", "working"], ["c", "dispatched"], ["a", "reported"]]);
  const view = ready({ kind: "due", month: "2026-11", amountMinor: 1_850_000, dueOn: "2026-11-05" }, {
    repairs: [{ id: "11111111-1111-4111-8111-111111111111", title: "浴室天花板滴水", step: "dispatched" }] });
  const out = html(view);
  assert.match(out, /<h2>報修・浴室天花板滴水<\/h2><span class="t-home-badge">已派工<\/span>/);
  assert.match(out, /<a class="t-home-text" href="\/t\/repair\?id=11111111-1111-4111-8111-111111111111">看進度<\/a>/);
  assert.doesNotMatch(out, /<button|btn pri|約好時間|回覆你了|續約|手機號碼/, "no solid button; omitted cards never render");
  assert.equal((html(ready(view.headline)).match(/tenant-home-repair/g) ?? []).length, 0, "no repair, no card");
});

test("TEN-54-AC3: nothing due and no card shows drawing 07 and no button; an open repair's card replaces the drawing", () => {
  for (const h of [{ kind: "paid", month: "2026-11" }, { kind: "none", state: "no_invoice" }] as const) {
    const out = html(ready(h));
    assert.match(out, /data-testid="tenant-home-empty"><svg class="v3-illustration" data-v3-illustration="07"/);
    assert.doesNotMatch(out, /<button|<a /);
    // TEN-54-AC3 ("Given nothing is due and no card applies"): a card applies, so no drawing; the card shows.
    const withRepair = html(ready(h, { repairs: [{ id: "r", title: "t", step: "reported" }] }));
    assert.doesNotMatch(withRepair, /data-v3-illustration/);
    assert.match(withRepair, /<h2>報修・t<\/h2>/);
  }
  assert.doesNotMatch(html(ready({ kind: "due", month: "2026-11", amountMinor: 1, dueOn: "2026-11-05" })), /data-v3-illustration/);
  // Regression, TEN-54-AC3 ("Given nothing is due and no card applies … drawing 07 and no button"): no payable bill
  // + one open repair → the repair card shows and drawing 07 does NOT; still no button.
  const noBill = tenantHomeHeadline(bill({ state: "nonpayable", balanceMinor: 0 }), facts({ nextDue: null }));
  assert.deepEqual(noBill, { kind: "none", state: "nonpayable" });
  const regression = html(ready(noBill, { repairs: [{ id: "22222222-2222-4222-8222-222222222222", title: "浴室天花板滴水", step: "reported" }] }));
  assert.match(regression, /<h1 class="t-home-lead">目前沒有可付款的已開立帳單。<\/h1>/);
  assert.equal((regression.match(/data-testid="tenant-home-repair"/g) ?? []).length, 1);
  assert.doesNotMatch(regression, /data-v3-illustration|tenant-home-empty/);
  assert.doesNotMatch(regression, /<button|btn pri|t-home-outline/);
  const drawing = renderToStaticMarkup(<Illustration name="07" />);
  assert.match(drawing, /viewBox="0 0 176 120"/); assert.match(drawing, /aria-hidden="true"/); assert.match(drawing, /focusable="false"/);
  assert.equal((drawing.match(/var\(--c-brand\)/g) ?? []).length, 1);
  assert.doesNotMatch(drawing, /#[0-9a-f]{3,8}|<title|aria-label/i);
});

test("TEN-54-AC4: loading has no amount; a failed read shows the approved line with 「再試一次」", async () => {
  const loading = renderToStaticMarkup(<TenantHomeLoading />);
  assert.match(loading, /aria-busy="true"/);
  assert.equal(loading.replace(/<[^>]+>/g, ""), "", "no text at all, so no amount and no NT$0");
  const error = renderToStaticMarkup(<TenantHomeError locale="zh-TW" />);
  assert.match(error, /role="alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="t-home-outline" href="\/t">再試一次<\/a>/);
  assert.doesNotMatch(error, /NT\$|<button/);
  assert.equal(renderToStaticMarkup(<TenantHomeState view={{ state: "error" }} locale="zh-TW" name="x" company="y" legacy={<b>legacy</b>} />), error);
  assert.equal(renderToStaticMarkup(<TenantHomeState view={{ state: "off" }} locale="zh-TW" name="x" company="y" legacy={<b>legacy</b>} />), "<b>legacy</b>");

  const session = { kind: "tenant", orgId: "o", userId: "u", locale: "zh-TW", name: "陳" } as unknown as Session;
  type H = Awaited<ReturnType<typeof tenantPaymentHistory>>;
  const historyOf = (h: H) => (async () => h) as unknown as typeof tenantPaymentHistory;
  const readyHistory = { state: "ready", lease: { id: "l", status: "active", currency: "TWD", canReport: true, legacyPayeeVisible: false },
    bill: { state: "due", overdue: false, pending: false, balanceMinor: 100, paidMinor: 0, currency: "TWD", lines: [] }, monthlyDue: [], reports: [], nextCursor: null,
    home: facts({ nextDue: { month: "2026-11", dueOn: "2026-11-05" } }) } as unknown as H;
  const asked: unknown[] = [];
  const repairs = (async (_s: Session, leaseId: string) => { asked.push(leaseId); return [{ id: "r", number: "1", title: "t", status: "open", category: "other", created_at: "2026" }]; }) as never;
  const ok = await tenantHomeView(session, "l", { history: (async (_s: Session, leaseId: string, o: unknown) => { asked.push([leaseId, o]); return readyHistory; }) as never, repairs });
  assert.equal(ok.state, "ready");
  assert.deepEqual(asked, [["l", { view: "current", home: true }], "l"], "only the selected lease, the existing readers");
  assert.deepEqual((await tenantHomeView(session, "l", { history: historyOf({ state: "off" }), repairs })).state, "off");
  assert.deepEqual((await tenantHomeView(session, "l", { history: historyOf({ state: "unavailable" }), repairs })).state, "error");
  const { home: _drop, ...noHome } = readyHistory as Extract<H, { state: "ready" }>; void _drop;
  assert.deepEqual((await tenantHomeView(session, "l", { history: historyOf(noHome as H), repairs })).state, "error");
  const quiet = console.error; console.error = () => {};
  try {
    assert.deepEqual((await tenantHomeView(session, "l", { history: historyOf(readyHistory), repairs: (async () => { throw new Error("db"); }) as never })).state, "error");
  } finally { console.error = quiet; }
});

function shellModule(path: string, open: "more" | null = null) {
  const base = {
    "next/link": { __esModule: true, default: "a" }, "next/navigation": { usePathname: () => path },
    "./locale": { useT: () => i18n.makeT("zh-TW"), useLocale: () => "zh-TW" }, "@/server/perms": {}, "@/line-copy": {},
    "./brand": { BrandImage: () => <span /> }, "@/i18n/lanes/repair-owner-policy": {},
  };
  const chrome = compile(source("src/components/chrome.tsx"), base);
  const mocks = {
    ...base, "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": brandCopy, "../../../server/nav-v3": nav,
    "../../chrome": chrome, "../role-avatar": { RoleAvatar }, "./icon": { ShellIcon }, "../../../i18n/lanes/brand-v3-tenant-home": laneModule,
    ...(open ? { react: { ...React, useState: () => [{ kind: open, top: 64, left: 8 }, () => {}] } } : {}),
  };
  const shared = compile(source("src/components/v3/shell/shared-shell.tsx"), mocks);
  return compile(source("src/components/v3/tenant/shell.tsx"), { ...mocks, "../shell/shared-shell": shared }) as { TenantShellV3: React.FC<{ locale: "zh-TW" | "en"; view: TenantShellView; children: React.ReactNode }> };
}
const shellView = { name: "陳怡君", place: "信義路四段 120 號 2 樓", company: "安居物業", canSwitchToOwner: false,
  more: [{ id: "lease", href: "/t/lease", label: "我的租約", icon: "doc" as const }, { id: "history", href: "/t/history", label: "查看已結束合約", icon: "doc" as const }],
  notification: { id: "notifications", href: "/t/notifications", label: "通知", icon: "bell" as const } };

test("TEN-55-AC1: tenant tab bar 首頁／繳款／報修／訊息／更多 links the existing routes, with aria-current", () => {
  const expected: Record<string, string | undefined> = { "/t": "home", "/t/": "home", "/t/pay": "pay", "/t/pay?done=1": "pay", "/t/repair": "repair",
    "/t/messages": "messages", "/t/lease": "lease", "/t/history/abc": "history", "/t/notifications": undefined, "/t/payments": undefined };
  for (const [path, id] of Object.entries(expected)) assert.equal(tenantShellCurrent(path, shellView.more), id, path);
  for (const [path, id] of [["/t", "home"], ["/t/pay", "pay"], ["/t/repair", "repair"], ["/t/messages", "messages"]] as const) {
    const { TenantShellV3 } = shellModule(path);
    const out = renderToStaticMarkup(<TenantShellV3 locale="zh-TW" view={shellView}><main>page</main></TenantShellV3>);
    const tabs = out.slice(out.indexOf('data-testid="v3-phone-tabs"'));
    assert.match(out, /data-testid="tenant-shell-v3"/);
    assert.match(out, /<link rel="stylesheet" href="\/brand\/v3\/tenant.css"\/>/);
    const links = [...tabs.matchAll(/<a href="([^"]+)" data-area="([a-z]+)"( class="on")?( aria-current="page")?/g)].map(m => [m[1], m[2], Boolean(m[4])]);
    assert.deepEqual(links, [["/t", "home", id === "home"], ["/t/pay", "pay", id === "pay"], ["/t/repair", "repair", id === "repair"], ["/t/messages", "messages", id === "messages"]]);
    assert.deepEqual([...tabs.matchAll(/<\/svg>([^<]+)<\/(?:a|button)>/g)].map(m => m[1]), ["首頁", "繳款", "報修", "訊息", "更多"]);
    assert.match(tabs, /<button type="button" data-area="more" aria-haspopup="menu" aria-expanded="false">/, "更多 opens the menu and is not current");
    assert.match(out, /<div class="wm">租多啦・租客<\/div><div class="cap">陳怡君 你好｜信義路四段 120 號 2 樓<\/div><a class="shell-bell" data-testid="shell-bell" href="\/t\/notifications"/);
    assert.doesNotMatch(out, /收款/);
  }
  const { TenantShellV3 } = shellModule("/t/lease");
  const lease = renderToStaticMarkup(<TenantShellV3 locale="en" view={{ ...shellView, notification: null }}><main /></TenantShellV3>);
  assert.match(lease, /<button type="button" data-area="more" class="on" aria-current="page"/);
  assert.doesNotMatch(lease, /shell-bell/);
  assert.match(lease, /Home<\/a>.*Pay<\/a>.*Repairs<\/a>.*Messages<\/a>.*More<\/button>/);
  const menu = renderToStaticMarkup(<>{(shellModule("/t/history", "more").TenantShellV3)({ locale: "zh-TW", view: shellView, children: <main /> })}</>);
  assert.match(menu, /role="menuitem" href="\/t\/lease" class="shell-more-entry">.*我的租約.*role="menuitem" href="\/t\/history" class="shell-more-entry" aria-current="page">/);
  assert.equal(tenantShellContext({ name: " ", place: "A 2F" }, "zh-TW"), "A 2F");
  assert.equal(tenantShellContext({ name: "陳", place: null }, "zh-TW"), "陳 你好");
});

test("TEN-52-AC4 rule on this slice: no 收款 or 入帳 in the tenant lane, the tenant shell or 首頁", () => {
  for (const file of ["src/i18n/lanes/brand-v3-tenant-home.ts", "src/components/v3/tenant/shell.tsx", "src/components/v3/tenant/home.tsx",
    "src/components/v3/tenant/home-route.tsx", "src/server/b090-tenant-shell.ts", "public/brand/v3/tenant.css"]) {
    assert.doesNotMatch(source(file), /收款|入帳|收租|代收/, file);
  }
  for (const locale of ["zh-TW", "en"] as const) assert.deepEqual(Object.keys(brandV3TenantHomeCopy(locale)).sort(), Object.keys(brandV3TenantHomeCopy("zh-TW")).sort());
  const css = source("public/brand/v3/tenant.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}").map(r => r.trim()).filter(r => r && !r.startsWith("@media"))) {
    const selector = rule.replace(/^@media[^{]*\{/, "").split("{")[0].trim();
    // B-090 slice 2 adds the 繳款 page's own scope (.v3-tenant-pay) to the same sheet.
    assert.ok(/^html\[data-brand="v2"\]\[data-brand-v3\] \.v3-tenant-(home|pay)\b/.test(selector), selector);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(/i, "tokens only");
});

// ---------- flag OFF parity: /t and the tenant layout render exactly what origin/main rendered ----------
const stub = (testid: string) => function Stub() { return <i data-stub={testid} />; };
function pageMocks(state: { v3: boolean; leases: unknown[]; leaseId: string | null; history: unknown; money: unknown; idReady: boolean }) {
  return {
    "@/components/notification-center-entry": { NotificationCenterEntry: stub("notification-entry") },
    "@/components/handover-entry": { HandoverEntry: stub("handover-entry") },
    "@/server/consent-gate": { requireCurrentConsent: async () => undefined },
    "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
    "@/i18n": { makeT: () => (key: string, vars?: unknown) => vars ? `${key}:${JSON.stringify(vars)}` : key },
    "@/server/actions": { actionPickLease: "/pick" },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => true },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => state.v3 },
    "@/components/v3/tenant/home-route": { TenantHomeV3Route: stub("tenant-home-v3") },
    "@/server/format": { moneyLabel: (m: unknown, c: string) => `${c}:${m}` },
    "@/server/id-docs": { loadLeaseIdCheck: async () => ({ ready: state.idReady }) },
    "@/server/id-sign-gate": { identityRequiredForSigningFor: async () => true },
    "@/server/queries": { tenantLeases: async () => state.leases, tenantLeaseMoney: async () => state.money },
    "@/server/sandbox-data": { displaySampleName: (s: string) => `«${s}»` },
    "@/server/session": { getSession: async () => ({ orgId: "org", locale: "zh-TW", name: "陳怡君", leaseId: state.leaseId, kind: "tenant" }) },
    "@/server/tenant-reminder-preferences": { tenantDuePreference: async () => true },
    "@/i18n/lanes/reminders": { reminderCopy: () => ({ tenantTitle: "提醒" }) },
    "@/server/tenant-payment-history": { tenantPaymentHistory: async () => state.history },
    "@/components/tenant-payment-history": { TenantBillSummary: stub("bill-summary") },
    "@/i18n/tenant-payment-history": { tenantPaymentHistoryCopy: () => ({ unavailable: "unavailable" }) },
  };
}
const lease = (id: string, status = "active") => ({ lease_id: id, firm_name: "安居物業", property_name: "信義路", unit_label: "2F", room_label: null, address_display: null, lease_status: status });

test("TEN-54 / PLT-46: brand_v3 OFF, /t renders byte-for-byte what origin/main rendered", async () => {
  const before = execFileSync("git", ["show", `${BASE}:src/app/t/page.tsx`], { encoding: "utf8" });
  const money = (status: string) => ({ lease: { rent: "1850000", deposit: "3700000", currency: "TWD", status }, dueMinor: 1850000 });
  const cases = [
    { leases: [lease("a"), lease("b")], leaseId: null, history: { state: "off" }, money: null, idReady: true },
    { leases: [], leaseId: null, history: { state: "off" }, money: null, idReady: true },
    { leases: [lease("a")], leaseId: null, history: { state: "off" }, money: money("active"), idReady: false },
    { leases: [lease("a", "pending_signature")], leaseId: null, history: { state: "off" }, money: money("pending_signature"), idReady: true },
    { leases: [lease("a"), lease("b")], leaseId: "b", history: { state: "ready" }, money: null, idReady: true },
    { leases: [lease("a")], leaseId: null, history: { state: "unavailable" }, money: null, idReady: true },
  ];
  for (const c of cases) {
    const mocks = pageMocks({ v3: false, ...c });
    const render = async (text: string) => renderToStaticMarkup(await (compile(text, mocks).default as () => Promise<React.ReactElement>)());
    const baseline = await render(before);
    assert.equal(await render(source("src/app/t/page.tsx")), baseline);
    assert.doesNotMatch(baseline, /tenant-home-v3/);
  }
  // ON: the RT-HOME route replaces the body; the lease picker and the empty state stay the existing ones.
  const on = async (c: (typeof cases)[number]) => renderToStaticMarkup(await (compile(source("src/app/t/page.tsx"), pageMocks({ v3: true, ...c })).default as () => Promise<React.ReactElement>)());
  assert.match(await on(cases[2]), /^<i data-stub="tenant-home-v3"><\/i>$/);
  assert.match(await on(cases[0]), /data-testid="lease-picker"/);
  assert.equal(await on(cases[1]), '<p data-v2-page="t-home">i_empty</p>');
});

function layoutMocks(state: { v3: boolean; path: string; line: boolean; kind?: string }) {
  return {
    "@/server/line/tenant-entry": { tenantLineEntryEnabled: async () => state.line },
    "@/i18n/line-tenant": { lineTenantCopy: () => ({ manage: "LINE 設定" }) },
    "next/headers": { headers: async () => ({ get: () => state.path }) },
    "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
    "next/navigation": { redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } },
    "@/i18n": { makeT: () => (key: string) => key },
    "@/i18n/tenant-lease-history": { tenantLeaseHistoryCopy: () => ({ link: "查看已結束合約" }) },
    "@/components/brand": { BrandImage: (p: { variant: string }) => <span data-variant={p.variant} /> },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => true },
    "@/server/consent-gate": { requireCurrentConsent: async () => undefined },
    "@/server/session": { getSession: async () => ({ orgId: "org", locale: "zh-TW", name: "陳", kind: state.kind ?? "tenant" }) },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: unknown) => s },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => state.v3 },
    "@/server/b090-tenant-shell": { tenantShellView: async (_s: unknown, line: boolean) => ({ line }) },
    "@/components/v3/tenant/shell": { TenantShellV3: ({ view, children }: { view: unknown; children: React.ReactNode }) => <div data-tenant-shell={JSON.stringify(view)}>{children}</div> },
  };
}

test("TEN-55-AC1 / PLT-46: brand_v3 OFF, the tenant layout is unchanged; ON wraps pages in the tenant shell (not the ID task pages)", async () => {
  const before = execFileSync("git", ["show", `${BASE}:src/app/t/layout.tsx`], { encoding: "utf8" });
  const render = async (text: string, mocks: Record<string, unknown>) =>
    renderToStaticMarkup(await (compile(text, mocks).default as (p: { children: React.ReactNode }) => Promise<React.ReactElement>)({ children: <main>page</main> }));
  for (const path of ["/t", "/t/pay", "/t/repair", "/t/messages", "/t/lease", "/t/id", "/t/id/notice", ""]) for (const line of [false, true]) {
    const mocks = layoutMocks({ v3: false, path, line });
    const baseline = await render(before, mocks);
    assert.equal(await render(source("src/app/t/layout.tsx"), mocks), baseline, `${path}/${line}`);
    assert.doesNotMatch(baseline, /data-tenant-shell/);
    const on = await render(source("src/app/t/layout.tsx"), layoutMocks({ v3: true, path, line }));
    if (path.startsWith("/t/id")) assert.equal(on, baseline, "ID task pages keep their focused frame");
    else assert.equal(on, `<div data-tenant-shell="${JSON.stringify({ line }).replace(/"/g, "&quot;")}"><main>page</main></div>`);
  }
  // P-TEN only: anyone else is still sent to /m first, flag ON or OFF.
  for (const v3 of [false, true]) await assert.rejects(render(source("src/app/t/layout.tsx"), layoutMocks({ v3, path: "/t", line: false, kind: "owner" })), /REDIRECT:\/m/);
});
