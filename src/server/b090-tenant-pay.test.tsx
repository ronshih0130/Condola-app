import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { brandV3TenantPayCopy } from "../i18n/lanes/brand-v3-tenant-pay";
import * as formRules from "./b090-tenant-pay-form";
import { majorText, parseAmountMinor, reportProblems, serverErrorField } from "./b090-tenant-pay-form";
import { PAY_HISTORY_MONTHS, payHistoryLines, payMonthFacts, tenantPayState, type PayMonthFacts, type PayMonthRow, type PayReport, type TenantPayState } from "./b090-tenant-pay-rules";
import { tenantPayView, type TenantPayAccount, type TenantPayView } from "./b090-tenant-pay";
import type { TenantHomeBill, TenantHomeFacts } from "./b090-tenant-home-rules";
import type { tenantPaymentHistory } from "./tenant-payment-history";
import type { Session } from "./types";
import {
  TenantPayAccountCard, TenantPayError, TenantPayHistory, TenantPayLoading, TenantPayState as PayStateView, TenantPayV3, TenantReportV3, payMonthLabel,
} from "../components/v3/tenant/pay";
import { errorNotice, readDraft, reportDraftKey, submitGate, sweepDrafts, writeDraft } from "../components/v3/tenant/pay-client";

// B-090 slice 2 (TEN-52, TEN-53). Stories: hub 07-brand/brand-3.0-1113/stories.md TEN-52/TEN-53; screens RT-PAY, RT-REPORT;
// frames 「繳款・這個月要繳」 and 「回報已繳・只報還差的」; wording PR-023.

const BASE = "d561bdf83dcc67668872a4d57865ed24f363d067"; // feat/mac/b090-rt-home (slice 1) before slice 2
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
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const facts = (over: Partial<TenantHomeFacts> = {}): TenantHomeFacts =>
  ({ pendingMinor: 0, nextDue: { month: "2026-11", dueOn: "2026-11-05" }, overdue: null, paidMonth: null, ...over });
const bill = (over: Partial<TenantHomeBill> = {}): TenantHomeBill =>
  ({ state: "due", overdue: false, balanceMinor: 1_850_000, paidMinor: 0, currency: "TWD", ...over });
const state = (b: Partial<TenantHomeBill> = {}, pending = 0, f: Partial<TenantHomeFacts> = {}, canReport = true) =>
  tenantPayState(bill(b), facts(f), { leasePendingMinor: pending }, canReport);
const account: TenantPayAccount = { kind: "account", holder: "林美華", bank: "台新銀行", bankCode: "812", number: "2048-01-0012345", swift: null, routing: null, payee: "owner" };
type Ready = Extract<TenantPayView, { state: "ready" }>;
const ready = (pay: TenantPayState, over: Partial<Ready> = {}): Ready =>
  ({ state: "ready", currency: "TWD", pay, today: "2026-11-15", lastLast5: null, redo: null, account, history: [], olderMonths: false, ...over });
const payHtml = (view: Ready, locale: "zh-TW" | "en" = "zh-TW") =>
  renderToStaticMarkup(<TenantPayV3 view={view} locale={locale} place="信義路四段 120 號 2 樓" company="安居物業" brand="租多啦" />);
const noop = async () => {};
const owner = { userId: "user-a", orgId: "org-1", leaseId: "lease-1" };
const reportHtml = (view: Ready, errorKey?: string) =>
  renderToStaticMarkup(<TenantReportV3 view={view} locale="zh-TW" company="安居物業" owner={owner} errorKey={errorKey} renderId="r" action={noop} />);

test("TEN-52-AC1: lead and the 物件／金額／狀態 card per state; 「回報已繳」 is the only solid button", () => {
  const due = payHtml(ready(state()));
  assert.match(due, /<h1 class="t-pay-lead">11 月租金 NT\$18,500，11\/5 前繳。<\/h1>/, "the frame's lead, verbatim");
  assert.match(due, /<p class="t-pay-kv"><span>物件<\/span><b>信義路四段 120 號 2 樓<\/b><\/p><p class="t-pay-kv"><span>金額<\/span><b class="num" data-testid="tenant-pay-amount">NT\$18,500<\/b><\/p><div class="t-pay-kv"><span>狀態<\/span><span class="t-pay-badge t-pay-warn" data-testid="tenant-pay-status">待繳<\/span><\/div><a class="t-pay-solid" data-testid="tenant-pay-report" href="\/t\/pay\?report=1">回報已繳<\/a>/);
  assert.equal((due.match(/t-pay-solid/g) ?? []).length, 1, "one solid button on the page");
  assert.doesNotMatch(due, /<button[^>]*t-pay-solid/);
  // overdue, partially paid, reported, paid, nothing to pay
  const overdue = payHtml(ready(state({ overdue: true }, 0, { overdue: { month: "2026-10", days: 3 } })));
  assert.match(overdue, /10 月租金還沒繳，已經過了 3 天。/);
  assert.match(overdue, /t-pay-danger" data-testid="tenant-pay-status">逾期</);
  const partPaid = payHtml(ready(state({ state: "partial", paidMinor: 1_000_000, balanceMinor: 850_000 })));
  assert.match(partPaid, /11 月還差 NT\$8,500。/);
  assert.match(partPaid, /data-testid="tenant-pay-status">部分已繳・還差 NT\$8,500</);
  assert.match(partPaid, /tenant-pay-report/);
  const paid = payHtml(ready(state({ state: "paid", balanceMinor: 0 }, 0, { nextDue: null, paidMonth: "2026-11" })));
  assert.match(paid, /<h1 class="t-pay-lead">11 月已繳清。<\/h1>/);
  assert.match(paid, /t-pay-ok" data-testid="tenant-pay-status"><span class="v3-check"[^]*?<\/span>已繳清</, "the tick only for confirmed (PLT-51)");
  assert.doesNotMatch(paid, /tenant-pay-amount|NT\$0/, "no 金額 row and no NT$0 when nothing is owed");
  const none = payHtml(ready(state({ state: "zero_charge", balanceMinor: 0 }, 0, { nextDue: null })));
  assert.match(none, /t-pay-mute" data-testid="tenant-pay-status">目前帳單沒有應付金額。</);
  assert.doesNotMatch(none, /v3-check/);
});

test("TEN-52-AC1 / TEN-53-AC4: 「回報已繳」 hidden when nothing is owed, everything is reported, or the lease cannot report", () => {
  const shows = (s: TenantPayState) => /tenant-pay-report/.test(payHtml(ready(s)));
  assert.equal(shows(state()), true);
  assert.equal(shows(state({}, 1_500_000)), true, "part pending: the rest can still be reported");
  assert.equal(shows(state({}, 1_850_000)), false, "all reported");
  assert.equal(shows(state({}, 2_000_000)), false, "more than owed is waiting");
  assert.equal(shows(state({ state: "paid", balanceMinor: 0 }, 0, { nextDue: null, paidMonth: "2026-11" })), false, "nothing owed");
  assert.equal(shows(state({ state: "credit", balanceMinor: -100 }, 0, { nextDue: null })), false, "credit");
  assert.equal(shows(state({}, 0, {}, false)), false, "the reader says this lease cannot be reported on");
  // rest = owed − lease-wide waiting, the B-087 guard's own arithmetic
  assert.deepEqual([state({}, 1_500_000).restMinor, state({}, 2_000_000).restMinor, state({ balanceMinor: -5 }, 0).restMinor], [350_000, 0, 0]);
  assert.throws(() => state({}, -1));
});

test("TEN-53-AC3 / AC4: the clock line 「已回報 …・等待{company}確認」, with 「；還差 …」 while part is unreported", () => {
  const part = payHtml(ready(state({}, 1_500_000)));
  assert.match(part, /<p class="t-pay-wait" data-testid="tenant-pay-wait"><span class="v3-wait"[^]*?<\/span><span>已回報 NT\$15,000・等待安居物業確認；還差 NT\$3,500<\/span><\/p>/);
  assert.match(part, /data-testid="tenant-pay-status">已送出</, "badge 已送出 (TEN-51-AC1)");
  assert.doesNotMatch(part, /v3-check/, "no tick until confirmed");
  const all = payHtml(ready(state({}, 1_850_000)));
  assert.match(all, /<span>已回報 NT\$18,500・等待安居物業確認<\/span>/);
  assert.match(all, /<h1 class="t-pay-lead">已回報 NT\$18,500，等安居物業確認。<\/h1>/);
  assert.doesNotMatch(payHtml(ready(state())), /tenant-pay-wait/);
});

test("TEN-53-AC5: a refused latest report shows 「輪到你・重新回報」 and its reason", () => {
  const html = payHtml(ready(state(), { redo: { reason: "金額不符" } }));
  assert.match(html, /<p class="t-pay-redo" data-testid="tenant-pay-redo"><b>輪到你・重新回報<\/b><span>未通過原因: 金額不符<\/span><\/p>/);
  assert.match(payHtml(ready(state(), { redo: { reason: null } })), /<span>未通過原因無法顯示。<\/span>/);
});

test("TEN-52-AC2: 「匯到這個帳戶」 with 戶名／銀行（代碼）／帳號 + 「複製」; the payee word follows the account owner", () => {
  const card = (a: TenantPayAccount) => renderToStaticMarkup(<TenantPayAccountCard account={a} locale="zh-TW" brand="租多啦" />);
  const owner = card(account);
  assert.equal(text(owner), "匯到這個帳戶戶名林美華銀行台新銀行（812）帳號2048-01-0012345複製直接匯給屋主，租多啦不經手款項。");
  assert.match(owner, /<b class="num" data-testid="tenant-pay-number">2048-01-0012345<\/b><button type="button" class="t-pay-text" data-testid="tenant-pay-copy">複製<\/button>/);
  assert.match(card({ ...account, payee: "company" }), /直接匯給管理方，租多啦不經手款項。/, "a company account says 管理方 (frame note)");
  assert.match(card({ ...account, swift: "TSIBTWTP", routing: null }), /SWIFT（選填）<\/span><b>TSIBTWTP/);
  const none = card({ kind: "none" });
  assert.equal(text(none), "匯到這個帳戶管理方還沒提供匯款帳戶，請直接問他們。傳訊息");
  assert.match(none, /<a class="t-pay-text" data-testid="tenant-pay-message" href="\/t\/messages">傳訊息<\/a>/, "the existing tenant messages route");
  assert.doesNotMatch(none, /t-pay-solid|<button/);
  assert.equal(text(card({ kind: "legacy", last5: "12345" })), "匯到這個帳戶匯入帳戶末五碼 12345租金請直接匯入屋主／管理方帳戶，租多啦 不經手任何款項。");
  const failed = card({ kind: "error" });
  assert.match(failed, /role="alert" class="t-pay-alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="t-pay-outline" href="\/t\/pay">再試一次<\/a>/, "TEN-52-AC5 in place");
  // the card is absent when the existing payee rule hides it
  assert.doesNotMatch(payHtml(ready(state(), { account: null })), /tenant-pay-account/);
});

const rep = (id: string, status: PayReport["status"], paidOn: string, amountMinor: number, reason: string | null = null): PayReport =>
  ({ id, status, paidOn, amountMinor, currency: "TWD", rejectionReason: reason });
/** What the reader's SQL aggregate yields for one month (over every report), with the month's shown rows. */
function month(ym: string, all: PayReport[], shown = all): PayMonthFacts {
  const newest = [...all].sort((a, b) => b.paidOn.localeCompare(a.paidOn))[0];
  const counted = all.filter(r => r.status === "submitted" || r.status === "confirmed");
  return { month: ym, count: all.length, countedMinor: counted.reduce((n, r) => n + r.amountMinor, 0), anySubmitted: all.some(r => r.status === "submitted"),
    anyConfirmed: all.some(r => r.status === "confirmed"), newestStatus: newest.status, newestAmountMinor: newest.amountMinor, currency: "TWD",
    newestRejectedReason: [...all].sort((a, b) => b.paidOn.localeCompare(a.paidOn)).find(r => r.status === "rejected")?.rejectionReason ?? null, reports: shown };
}

test("TEN-52-AC3: 「之前的繳款」 one line per month, newest first, in tenant words; the line opens that month's reports", () => {
  const lines = payHistoryLines([
    month("2026-11", [rep("d", "submitted", "2026-11-02", 1_500_000)]),
    month("2026-10", [rep("a", "confirmed", "2026-10-03", 1_850_000)]),
    month("2026-09", [rep("b", "confirmed", "2026-09-04", 1_850_000)]),
    month("2026-08", [rep("c", "rejected", "2026-08-05", 1_850_000, "金額不符")]),
    month("2026-07", [rep("f", "confirmed", "2026-07-09", 1_850_000), rep("e", "rejected", "2026-07-01", 1_000_000, "舊的")]),
    month("2025-12", [rep("g", "reversed", "2025-12-01", 1_850_000)]),
  ]);
  assert.deepEqual(lines.map(l => [l.month, l.status, l.amountMinor, l.reason]), [
    ["2026-11", "submitted", 1_500_000, null], ["2026-10", "confirmed", 1_850_000, null], ["2026-09", "confirmed", 1_850_000, null],
    ["2026-08", "rejected", 1_850_000, "金額不符"], ["2026-07", "confirmed", 1_850_000, null], ["2025-12", "reversed", 1_850_000, null],
  ]);
  assert.deepEqual(lines[4].reports.map(r => r.id), ["f", "e"], "a month keeps its reports, newest first");
  // totals come from the aggregate over every report, even when the month lists only some of them
  const big = month("2026-06", Array.from({ length: 30 }, (_, i) => rep(`x${i}`, "confirmed", "2026-06-10", 1_000)), []);
  assert.deepEqual(payHistoryLines([big]).map(l => [l.amountMinor, l.count, l.reports.length]), [[30_000, 30, 0]]);
  const html = renderToStaticMarkup(<TenantPayHistory lines={lines} today="2026-11-15" locale="zh-TW" />);
  assert.match(html, /<h2>之前的繳款<\/h2>/);
  const rows = [...html.matchAll(/<summary><span>([^<]+)<span class="num">([^<]+)<\/span><\/span><span class="t-pay-badge t-pay-([a-z]+)">(?:<span class="v3-(?:check|wait)"[^]*?<\/svg><\/span>)?([^<]+)<\/span><\/summary>/g)]
    .map(m => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(rows, [
    ["11 月　", "NT$15,000", "warn", "等待確認"], ["10 月　", "NT$18,500", "ok", "已確認"], ["9 月　", "NT$18,500", "ok", "已確認"],
    ["8 月　", "NT$18,500", "warn", "未通過"], ["7 月　", "NT$18,500", "ok", "已確認"], ["2025 年 12 月　", "NT$18,500", "mute", "確認已撤銷"],
  ]);
  assert.match(html, /<p class="t-pay-reason">未通過原因: 金額不符<\/p><ul aria-label="8 月的回報"><li><span><time dateTime="2026-08-05">2026-08-05<\/time>　<span class="num">NT\$18,500<\/span><\/span><span>未通過<\/span><\/li><\/ul>/);
  assert.equal(renderToStaticMarkup(<TenantPayHistory lines={[]} today="2026-11-15" locale="zh-TW" />), "", "no past reports: no card");
  assert.equal(payMonthLabel("2026-03", "2026-11-15", "en"), "March 2026");
  // older months beyond the listed ones: no link (no approved wording or tenant page for them yet)
  const older = renderToStaticMarkup(<TenantPayHistory lines={lines} today="2026-11-15" locale="zh-TW" older />);
  assert.match(older, /data-testid="tenant-pay-history" data-older="true"/);
  assert.doesNotMatch(older, /<a /);
  assert.equal(PAY_HISTORY_MONTHS, 12);
});

test("TEN-52-AC3: the reader's SQL rows are shaped strictly; mixed currencies or unknown statuses are refused", () => {
  const row = (over: Partial<PayMonthRow> = {}): PayMonthRow => ({ ym: "2026-10", n: 2, currencies: 1, counted: "3700000", any_submitted: false, any_confirmed: true,
    newest_status: "confirmed", newest_amount: "1850000", currency: "TWD", newest_reason: null, ...over });
  const r = { id: "a", status: "confirmed", amount: "1850000", currency: "TWD", paid_on: "2026-10-03", rejected_reason: "x", ym: "2026-10" };
  assert.deepEqual(payMonthFacts([row()], [r, { ...r, ym: "2026-09" }]), [{ month: "2026-10", count: 2, countedMinor: 3_700_000, anySubmitted: false, anyConfirmed: true,
    newestStatus: "confirmed", newestAmountMinor: 1_850_000, currency: "TWD", newestRejectedReason: null,
    reports: [{ id: "a", status: "confirmed", amountMinor: 1_850_000, currency: "TWD", paidOn: "2026-10-03", rejectionReason: null }] }]);
  for (const bad of [row({ currencies: 2 }), row({ newest_status: "deleted" }), row({ ym: "2026-1" }), row({ counted: "1.5" })]) {
    let out: unknown; try { out = payMonthFacts([bad], []); } catch { out = null; }
    assert.equal(out, null, JSON.stringify(bad));
  }
  assert.equal(payMonthFacts([row()], [{ ...r, currency: "USD" }]), null);
});

test("TEN-52-AC4: never 收款 or 入帳 on the tenant pay files or rendered page", () => {
  for (const file of ["src/i18n/lanes/brand-v3-tenant-pay.ts", "src/components/v3/tenant/pay.tsx", "src/components/v3/tenant/pay-client.tsx",
    "src/components/v3/tenant/pay-route.tsx", "src/server/b090-tenant-pay.ts", "src/server/b090-tenant-pay-rules.ts", "src/server/b090-tenant-pay-form.ts", "public/brand/v3/tenant.css"]) {
    assert.doesNotMatch(source(file), /收款|入帳|收租|代收/, file);
  }
  for (const locale of ["zh-TW", "en"] as const) assert.deepEqual(Object.keys(brandV3TenantPayCopy(locale)).sort(), Object.keys(brandV3TenantPayCopy("zh-TW")).sort());
  const all = payHtml(ready(state({}, 1_500_000), { history: payHistoryLines([month("2026-10", [rep("a", "confirmed", "2026-10-03", 1)])]) })) + reportHtml(ready(state({}, 1_500_000)));
  assert.doesNotMatch(all, /收款|入帳/);
  const css = source("public/brand/v3/tenant.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}").map(r => r.trim()).filter(r => r && !r.startsWith("@media"))) {
    const selector = rule.replace(/^@media[^{]*\{/, "").split("{")[0].trim();
    assert.ok(/^html\[data-brand="v2"\]\[data-brand-v3\] \.v3-tenant-(home|pay)\b/.test(selector), selector);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(/i, "tokens only");
});

test("TEN-52-AC5: loading has no amount; a failed read shows the approved line with 「再試一次」", () => {
  const loading = renderToStaticMarkup(<TenantPayLoading />);
  assert.match(loading, /aria-busy="true"/);
  assert.equal(text(loading), "", "no text at all, so no amount and no NT$0");
  const error = renderToStaticMarkup(<TenantPayError locale="zh-TW" />);
  assert.match(error, /<h1 class="t-pay-lead">繳款<\/h1><div class="t-pay-card t-pay-alert" role="alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="t-pay-outline" href="\/t\/pay">再試一次<\/a>/);
  assert.doesNotMatch(error, /NT\$|<button/);
});

test("TEN-53-AC1: the report form — 金額 = the unreported rest (max), 匯款日期 today, 末五碼 required, no 轉帳截圖, 送出回報 / 取消", () => {
  const html = reportHtml(ready(state({}, 1_500_000), { lastLast5: "54321" }));
  assert.match(html, /<h1 class="t-pay-lead">回報已繳<\/h1>/);
  assert.match(html, /<span>已回報 NT\$15,000・等待安居物業確認；還差 NT\$3,500<\/span>/);
  assert.match(html, /<span>金額<\/span><input data-field="amount" inputMode="numeric" class="num" value="3,500"\/><small>最多 NT\$3,500（還沒回報的部分）。<\/small>/);
  assert.match(html, /<input type="hidden" name="amount" value="3500"\/>/, "the action receives plain major units");
  assert.match(html, /<span>匯款日期<\/span><input data-field="paidOn" type="date" class="num" name="paidOn" value="2026-11-15"\/>/, "the property's date from the reader");
  assert.match(html, /<span>帳號末五碼　<span class="t-pay-badge t-pay-warn">必填<\/span><\/span><input data-field="last5" inputMode="numeric" autoComplete="off" maxLength="5" class="num" name="last5" value="54321"\/><small data-testid="tenant-report-last-used">上次填的，可以改。<\/small>/);
  assert.match(html, /<span>備註（選填）<\/span><input maxLength="200" placeholder="例：分兩次匯" name="reference" value=""\/>/);
  assert.match(html, /<button type="submit" class="t-pay-solid" data-testid="tenant-report-submit">送出回報<\/button><a class="t-pay-text t-pay-cancel" href="\/t\/pay">取消<\/a>/);
  assert.doesNotMatch(html, /轉帳截圖|上傳截圖|type="file"/, "B-086 not built: the screenshot field is hidden (frame note)");
  assert.equal((html.match(/t-pay-solid/g) ?? []).length, 1);
  // existing action contract: the same field names the legacy PayDialog posts
  const names = [...html.slice(html.indexOf("<form"), html.indexOf("</form>")).matchAll(/ name="([a-zA-Z0-9]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(names, ["amount", "last5", "leaseId", "paidOn", "reference", "returnTo"]);
  assert.match(html, /<input type="hidden" name="returnTo" value="tenant"\/>/);
  // no stored last five: empty and no 「上次填的」 helper
  const fresh = reportHtml(ready(state()));
  assert.match(fresh, /maxLength="5" class="num" name="last5" value=""\/><\/label>/);
  assert.doesNotMatch(fresh, /上次填的/);
  assert.match(fresh, /value="18,500"\/><small>最多 NT\$18,500（還沒回報的部分）。/);
  // USD: no 末五碼 field (TWD bank transfers only)
  assert.doesNotMatch(renderToStaticMarkup(<TenantReportV3 view={ready(tenantPayState(bill({ currency: "USD" }), facts(), { leasePendingMinor: 0 }, true), { currency: "USD" })} locale="zh-TW" company="A" owner={owner} errorKey={undefined} renderId="r" action={noop} />), /name="last5"/);
});

test("TEN-53-AC4: all reported → no form, only the waiting line; ?report=1 when nothing is reportable falls back to 繳款", () => {
  const all = ready(state({}, 1_850_000));
  const html = reportHtml(all);
  assert.doesNotMatch(html, /<form|tenant-report-submit/);
  assert.match(html, /tenant-pay-wait/);
  const mode = (report: boolean, errorKey?: string) => ({ report, errorKey, renderId: "r" });
  const view = (v: TenantPayView, m: ReturnType<typeof mode>) => renderToStaticMarkup(<PayStateView view={v} locale="zh-TW" place="p" company="安居物業" brand="租多啦" owner={owner} mode={m} action={noop} legacy={<b>legacy</b>} />);
  assert.match(view(all, mode(true)), /data-testid="tenant-pay-v3"/);
  assert.match(view(ready(state()), mode(true)), /data-testid="tenant-report-v3"/);
  assert.match(view(ready(state()), mode(false)), /data-testid="tenant-pay-v3"/);
  // a refusal after everything got reported meanwhile: the message and the waiting line, no form
  const late = view(all, mode(false, "errors.amountOverUnreported"));
  assert.match(late, /<p class="t-pay-alert" role="alert">金額超過還沒回報的部分。<\/p><a class="t-pay-text" href="\/t\/pay">取消<\/a>/);
  assert.equal(view({ state: "off" }, mode(true)), "<b>legacy</b>");
  assert.match(view({ state: "error" }, mode(true)), /tenant-pay-error/);
});

test("TEN-53-AC6: field checks, the server's refusal on its field, failure keeps the values with 「再試一次」", () => {
  assert.equal(parseAmountMinor("3,500", "TWD"), 350_000);
  assert.equal(parseAmountMinor(" 3500 ", "TWD"), 350_000);
  assert.equal(parseAmountMinor("3500.5", "TWD"), null, "TWD has no decimals");
  assert.equal(parseAmountMinor("12.5", "USD"), 1250);
  assert.equal(parseAmountMinor("-1", "TWD"), null);
  assert.equal(parseAmountMinor("abc", "TWD"), null);
  assert.deepEqual([majorText(350_000, "TWD"), majorText(1250, "USD"), majorText(350_050, "TWD")], ["3500", "12.50", "3500.50"]);
  const ok = { amount: "3,500", paidOn: "2026-11-15", last5: "54321" };
  assert.deepEqual(reportProblems(ok, 350_000, "TWD"), {});
  assert.deepEqual(reportProblems({ ...ok, amount: "0" }, 350_000, "TWD"), { amount: "amountPositive" });
  assert.deepEqual(reportProblems({ ...ok, amount: "3,501" }, 350_000, "TWD"), { amount: "overLimit" });
  assert.deepEqual(reportProblems({ ...ok, last5: "123" }, 350_000, "TWD"), { last5: "last5" });
  assert.deepEqual(reportProblems({ ...ok, last5: "" }, 350_000, "USD"), {}, "末五碼 is required for TWD only");
  assert.deepEqual(reportProblems({ ...ok, paidOn: "" }, 350_000, "TWD"), { paidOn: "required" });
  assert.equal(serverErrorField("errors.amountOverUnreported"), "amount");
  assert.equal(serverErrorField("errors.last5"), "last5");
  assert.equal(serverErrorField("errors.generic"), null);
  // the server refused the amount (B-087): the message under 金額 is the approved 「金額超過還沒回報的部分」
  const over = reportHtml(ready(state({}, 1_500_000)), "errors.amountOverUnreported");
  assert.match(over, /aria-invalid="true" aria-describedby="report-amount-err" value="3,500"\/><small>最多 NT\$3,500（還沒回報的部分）。<\/small><small class="t-pay-err" id="report-amount-err">金額超過還沒回報的部分。<\/small>/);
  assert.match(over, /送出回報<\/button>/);
  // a non-field failure: the message at the top and the button reads 「再試一次」; the draft restores the values
  const failed = reportHtml(ready(state()), "errors.generic");
  assert.match(failed, /<p class="t-pay-alert" data-testid="tenant-report-failed">沒有完成。請檢查欄位後再試一次。<\/p>/);
  // the live region is in the markup from the start and empty, so the text filled in after mount is announced
  assert.match(failed, /<div class="t-pay-sr" role="alert" aria-live="assertive" aria-atomic="true" data-testid="tenant-report-errors"><\/div>/);
  assert.match(failed, /data-testid="tenant-report-submit">再試一次<\/button>/);
  // TEN-53-AC6 draft: bound to tenant + org + lease in the key and the payload; only the four values are stored
  assert.equal(reportDraftKey(owner), "condola:b090-report:user-a:org-1:lease-1");
  const v = { amount: "1,000", paidOn: "2026-11-01", last5: "11111", note: "分兩次" };
  assert.deepEqual(JSON.parse(writeDraft(owner, { ...v, extra: "x" } as typeof v)), { v: 1, userId: "user-a", orgId: "org-1", leaseId: "lease-1", values: v });
  assert.deepEqual(readDraft(writeDraft(owner, v), owner), v);
  for (const other of [{ ...owner, userId: "user-b" }, { ...owner, orgId: "org-2" }, { ...owner, leaseId: "lease-2" }]) {
    assert.equal(readDraft(writeDraft(owner, v), other), null, "another tenant, org or lease never gets this draft");
  }
  for (const bad of [null, "", "{", JSON.stringify(v), JSON.stringify({ v: 1, ...owner, values: { ...v, amount: 1 } }), JSON.stringify({ v: 1, ...owner, values: { ...v, note: "x".repeat(501) } })]) assert.equal(readDraft(bad, owner), null);
  const store = new Map<string, string>([[reportDraftKey(owner), "a"], [reportDraftKey({ ...owner, userId: "user-b" }), "b"], ["condola:payment-request:x", "keep"]]);
  const storage = { get length() { return store.size; }, key: (i: number) => [...store.keys()][i] ?? null, removeItem: (k: string) => { store.delete(k); } };
  sweepDrafts(storage, reportDraftKey(owner));
  assert.deepEqual([...store.keys()], [reportDraftKey(owner), "condola:payment-request:x"], "another account's draft is swept; other keys stay");
  sweepDrafts(storage, null);
  assert.deepEqual([...store.keys()], ["condola:payment-request:x"], "繳款 (after a successful send) clears this tenant's draft too");
  const client = source("src/components/v3/tenant/pay-client.tsx");
  assert.match(client, /sweepDrafts\(sessionStorage, key\);\s*const draft = readDraft\(sessionStorage\.getItem\(key\), me\);\s*sessionStorage\.removeItem\(key\);\s*if \(serverError && draft\) setValues\(draft\);/,
    "other drafts are swept, this one is read once, removed, and restored only after a failed send");
  assert.match(source("src/components/v3/tenant/pay.tsx"), /<ReportDraftSweep \/>/, "繳款 sweeps drafts");
  assert.match(source("src/components/v3/tenant/pay-route.tsx"), /renderId: globalThis\.crypto\.randomUUID\(\)/, "each server render remounts the form");
});

test("TEN-53-AC6 (a11y): the error summary lists the invalid fields in form order and names the first one to focus", () => {
  const labels = { amount: "金額", paidOn: "匯款日期", last5: "帳號末五碼", errorItem: brandV3TenantPayCopy("zh-TW").errorItem };
  assert.deepEqual(errorNotice({ last5: "末五碼請輸入 5 位數字", amount: "金額超過還沒回報的部分。" }, labels, null),
    { focus: "amount", text: "金額：金額超過還沒回報的部分。 帳號末五碼：末五碼請輸入 5 位數字" });
  assert.deepEqual(errorNotice({}, labels, "沒有完成。請檢查欄位後再試一次。"), { focus: null, text: "沒有完成。請檢查欄位後再試一次。" });
  const client = source("src/components/v3/tenant/pay-client.tsx");
  // focus happens in an effect keyed on the committed notice, not right after setState in the submit handler
  assert.match(client, /useEffect\(\(\) => \{\s*if \(!notice\) return;\s*if \(notice\.focus\) formRef\.current\?\.querySelector<HTMLInputElement>\(`\[data-field="\$\{notice\.focus\}"\]`\)\?\.focus\(\);/);
  const submit = client.slice(client.indexOf("function onSubmit"), client.indexOf("const minor = parseAmountMinor"));
  assert.doesNotMatch(submit, /\.focus\(/);
});

test("TEN-53-AC6: no double submit — one send per press, and the button is disabled with 「處理中…」 while saving", () => {
  const gate = submitGate();
  assert.deepEqual([gate.take(), gate.take(), gate.take()], [true, false, false]);
  gate.release();
  assert.equal(gate.take(), true);
  const mocks = (pending: boolean) => ({
    "react-dom": { useFormStatus: () => ({ pending }) }, "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
    "../../../server/b090-tenant-pay-form": formRules,
  });
  const labels = { amount: "金額", max: "最多", paidOn: "匯款日期", last5: "帳號末五碼", required: "必填", lastUsed: "上次", note: "備註", notePlaceholder: "例", submit: "送出回報", saving: "處理中…", cancel: "取消", retry: "再試一次", errorItem: "{field}：{message}" };
  const render = (pending: boolean) => {
    const { TenantReportForm } = compile(source("src/components/v3/tenant/pay-client.tsx"), mocks(pending)) as { TenantReportForm: React.FC<Record<string, unknown>> };
    return renderToStaticMarkup(<TenantReportForm action={noop} owner={owner} currency="TWD" restMinor={100} defaults={{ amount: "1", paidOn: "2026-11-15", last5: "", note: "" }}
      lastUsed={false} needsLast5 serverError={null} messages={{ amountPositive: "a", overLimit: "b", required: "c", last5: "d" }} labels={labels} />);
  };
  assert.match(render(true), /<button type="submit" class="t-pay-solid" data-testid="tenant-report-submit" disabled="" aria-busy="true">處理中…<\/button>/);
  assert.match(render(false), /<button type="submit" class="t-pay-solid" data-testid="tenant-report-submit">送出回報<\/button>/);
  const client = source("src/components/v3/tenant/pay-client.tsx");
  assert.match(client, /if \(sending \|\| !gate\.current\.take\(\)\) \{ event\.preventDefault\(\); return; \}/, "a second submit is dropped before the action runs");
});

test("TEN-52 / TEN-53: the view composes the existing readers for the selected lease only", async () => {
  const session = { kind: "tenant", orgId: "o", userId: "u", locale: "zh-TW", name: "陳" } as unknown as Session;
  type H = Awaited<ReturnType<typeof tenantPaymentHistory>>;
  const readyHistory = {
    state: "ready", lease: { id: "l", status: "active", currency: "TWD", canReport: true, legacyPayeeVisible: true },
    bill: { state: "due", overdue: false, pending: true, balanceMinor: 1_850_000, paidMinor: 0, currency: "TWD", lines: [] }, monthlyDue: [], nextCursor: null,
    reports: [{ id: "r1", status: "rejected", current: { amountMinor: 1_850_000, currency: "TWD", paidOn: "2026-11-02" }, submittedAt: "", confirmedAt: null, rejectionReason: "金額不符", reversalReason: "unavailable", original: { state: "unavailable" } }],
    turn: { waiting: null, reReport: true }, home: facts(),
    pay: { leasePendingMinor: 0, lastLast5: "54321", today: "2026-11-15", olderMonths: true, months: [month("2026-11", [rep("r1", "rejected", "2026-11-02", 1_850_000, "金額不符")])] },
  } as unknown as H;
  const asked: unknown[] = [];
  const history = (h: H) => (async (_s: Session, leaseId: string, o: unknown) => { asked.push([leaseId, o]); return h; }) as never;
  const payee = (view: unknown) => (async (_s: Session, leaseId: string, denied: boolean) => { asked.push(["payee", leaseId, denied]); return view; }) as never;
  const ownerAccount = { enabled: true, last5: null, account: { id: "a", holder_name: "林美華", bank_name: "台新銀行", bank_code: "812", branch_code: "0001", account_number: "2048010012345", account_last5: "12345", owner_contact_id: "owner", is_default_payee: false, details: {} } };
  const v = await tenantPayView(session, "l", { history: history(readyHistory), payee: payee(ownerAccount) });
  assert.deepEqual(asked, [["l", { view: "current", home: true, turn: true, pay: true }], ["payee", "l", true]], "only the selected lease, the existing readers");
  assert.equal(v.state, "ready");
  if (v.state !== "ready") return;
  assert.deepEqual(v.account && { ...v.account, number: "x" }, { kind: "account", holder: "林美華", bank: "台新銀行", bankCode: "812", number: "x", swift: null, routing: null, payee: "owner" });
  assert.deepEqual(v.redo, { reason: "金額不符" });
  assert.deepEqual([v.lastLast5, v.today, v.pay.restMinor], ["54321", "2026-11-15", 1_850_000]);
  assert.deepEqual(v.history.map(l => [l.month, l.status, l.reason]), [["2026-11", "rejected", "金額不符"]], "from the reader's month aggregate");
  assert.equal(v.olderMonths, true);
  const company = await tenantPayView(session, "l", { history: history(readyHistory), payee: payee({ ...ownerAccount, account: { ...ownerAccount.account, owner_contact_id: null } }) });
  assert.equal(company.state === "ready" && company.account?.kind === "account" && company.account.payee, "company");
  const none = await tenantPayView(session, "l", { history: history(readyHistory), payee: payee({ enabled: true, last5: null, account: null }) });
  assert.deepEqual(none.state === "ready" && none.account, { kind: "none" });
  const hidden = await tenantPayView(session, "l", { history: history({ ...readyHistory, lease: { ...(readyHistory as Extract<H, { state: "ready" }>).lease, legacyPayeeVisible: false } } as H), payee: payee(ownerAccount) });
  assert.equal(hidden.state === "ready" && hidden.account, null);
  const quiet = console.error; console.error = () => {};
  try {
    const failedPayee = await tenantPayView(session, "l", { history: history(readyHistory), payee: (async () => { throw new Error("gateway"); }) as never });
    assert.deepEqual(failedPayee.state === "ready" && failedPayee.account, { kind: "error" }, "only that card fails");
    assert.equal((await tenantPayView(session, "l", { history: history({ state: "off" } as H), payee: payee(ownerAccount) })).state, "off");
    assert.equal((await tenantPayView(session, "l", { history: history({ state: "unavailable" } as H), payee: payee(ownerAccount) })).state, "error");
    const { pay: _p, ...noPay } = readyHistory as Extract<H, { state: "ready" }>; void _p;
    assert.equal((await tenantPayView(session, "l", { history: history(noPay as H), payee: payee(ownerAccount) })).state, "error");
    assert.equal((await tenantPayView(session, "l", { history: (async () => { throw new Error("db"); }) as never, payee: payee(ownerAccount) })).state, "error");
  } finally { console.error = quiet; }
});

// ---------- flag OFF parity: /t/pay renders exactly what it rendered before slice 2 ----------
const stub = (testid: string) => function Stub(props: Record<string, unknown>) { return <i data-stub={testid} data-props={JSON.stringify(Object.keys(props).sort())} />; };
function pageMocks(st: { v3: boolean; lease: unknown; history: unknown; money: unknown }) {
  return {
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => st.v3 },
    "@/components/v3/wait-mark": { WaitMark: stub("wait") },
    "@/server/consent-gate": { requireCurrentConsent: async () => undefined },
    "@/i18n": { makeT: () => (key: string, vars?: unknown) => vars ? `${key}:${JSON.stringify(vars)}` : key },
    "@/components/dialogs": { PayDialog: (p: Record<string, unknown>) => <i data-stub="pay-dialog" data-props={JSON.stringify(p)} /> },
    "@/components/ui": { ErrorBanner: ({ error }: { error?: string }) => error ? <i data-stub="error" data-error={error} /> : null, chargeKey: (c: string) => `charge_${c}` },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => true },
    "@/server/format": { electricityMonthLabel: (p: unknown, d: string) => `${p}:${d}`, moneyLabel: (m: unknown, c: string) => `${c}:${m}`, signedMoney: (m: unknown, c: string, _l: unknown, v2: boolean) => `${c}:${m}:${v2}` },
    "@/server/pay-note": { tenantPayeeVisible: () => true, unsignedRentNoteKey: (status: string, empty: boolean) => status === "pending_signature" && empty ? "i_pay_unsigned_bill" : null },
    "@/server/queries": { tenantLeaseMoney: async () => st.money },
    "@/server/sandbox-data": { displaySampleName: (s: string) => `«${s}»` },
    "@/lib/tenant-lease": { selectedLease: async () => ({ session: { orgId: "org", locale: "zh-TW", name: "陳怡君", kind: "tenant" }, lease: st.lease }) },
    "@/components/tenant-payee": { TenantPayee: stub("payee") },
    "@/components/tenant-payment-history": { TenantBillSummary: stub("bill-summary"), TenantPaymentHistory: stub("history") },
    "@/i18n/tenant-payment-history": { tenantPaymentHistoryCopy: () => ({ unavailable: "unavailable" }) },
    "@/server/tenant-payment-history": { tenantPaymentHistory: async () => st.history },
    "@/server/actions": { actionRecordPayment: "action" },
    "@/components/v3/tenant/pay-route": { TenantPayV3Route: stub("tenant-pay-v3") },
  };
}
const lease = { lease_id: "a", firm_name: "安居物業", property_name: "信義路", unit_label: "2F", room_label: null };
const money = (status: string, lines: boolean, dueMinor: number, paidMinor = 0) => ({
  lease: { status, place: "信義路 2F" }, currency: "TWD", dueMinor, paidMinor,
  rentLines: lines ? [{ amount: "1850000" }] : [], depositLines: [], utilityLines: lines ? [{ amount: "30000", periodStart: "2026-10-01", description: "utility" }] : [],
  otherLines: lines ? [{ amount: "-500", chargeType: "credit", description: "" }] : [],
});
const readyHistory = { state: "ready", lease: { canReport: true, legacyPayeeVisible: true }, bill: { balanceMinor: 1850000, currency: "TWD" } };

test("TEN-52 / PLT-46: brand_v3 OFF, /t/pay renders byte-for-byte what it rendered before slice 2", async () => {
  const before = execFileSync("git", ["show", `${BASE}:src/app/t/pay/page.tsx`], { encoding: "utf8" });
  const cases = [
    { lease: null, history: { state: "off" }, money: null },
    { lease, history: { state: "unavailable" }, money: null },
    { lease, history: readyHistory, money: null },
    { lease, history: { ...readyHistory, lease: { canReport: false, legacyPayeeVisible: false } }, money: null },
    { lease, history: { state: "off" }, money: null },
    { lease, history: { state: "off" }, money: money("active", true, 1880000) },
    { lease, history: { state: "off" }, money: money("active", true, 1880000, 100) },
    { lease, history: { state: "off" }, money: money("active", true, 0) },
    { lease, history: { state: "off" }, money: money("pending_signature", false, 0) },
  ];
  const paramsList = [{}, { error: "errors.amountOverUnreported" }, { done: "1" }, { cursor: "c", reportId: ["x", "y"] }, { report: "1" }];
  for (const c of cases) for (const params of paramsList) {
    const mocks = pageMocks({ v3: false, ...c });
    const render = async (code: string) => renderToStaticMarkup(await (compile(code, mocks).default as (p: unknown) => Promise<React.ReactElement>)({ searchParams: Promise.resolve(params) }));
    const baseline = await render(before);
    assert.equal(await render(source("src/app/t/pay/page.tsx")), baseline, JSON.stringify([c, params]));
    assert.doesNotMatch(baseline, /tenant-pay-v3/);
  }
  // ON: the RT-PAY route replaces the body (the existing body is handed over for "off"); no lease keeps the empty state.
  const on = async (c: (typeof cases)[number], params: Record<string, unknown>) => renderToStaticMarkup(await (compile(source("src/app/t/pay/page.tsx"), pageMocks({ v3: true, ...c })).default as (p: unknown) => Promise<React.ReactElement>)({ searchParams: Promise.resolve(params) }));
  assert.equal(await on(cases[2], { report: "1" }), `<i data-stub="tenant-pay-v3" data-props="${JSON.stringify(["action", "brand", "company", "errorKey", "leaseId", "legacy", "place", "report", "session"]).replace(/"/g, "&quot;")}"></i>`);
  assert.equal(await on(cases[0], {}), "<p>i_empty</p>");
});
