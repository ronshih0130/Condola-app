import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import { DashboardContent } from "../dashboard-content";
import { PaymentsContent } from "../payments-content";
import { TenantPayReadyContent, TenantPaymentHistory, TenantPaymentTurnLine } from "../tenant-payment-history";
import { ConfirmedBills } from "./payment-turns";
import { LocaleProvider } from "../locale";
import { makeT, type Locale } from "../../i18n";
import { brandV3Copy } from "../../i18n/lanes/brand-v3";
import { currentPaymentHistoryOptions, omitFailure, omitForbidden } from "../../lib/b3-payment-ui";
import { resolveEmptyCta } from "../../lib/empty-cta";
import { FlowError } from "../../server/errors";
import { tenantPaymentTurn, type StaffPaymentTurns, type PaymentTurnMatter } from "../../server/b3-payment-turns";
import type { Session } from "../../server/types";
import type { SetupProgress } from "../../server/onboarding-progress";
import { PERMS } from "../../server/perms";

Object.assign(globalThis, { React });
const render = (node: React.ReactNode, locale: Locale = "zh-TW") => renderToStaticMarkup(<LocaleProvider locale={locale}>{node}</LocaleProvider>);
const session: Session = {
  kind: "staff", role: "admin", locale: "zh-TW", environment: "live", name: "Test", calendar: "gregorian",
  userId: "user", sessionId: "session", email: "test@example.invalid", orgId: "org", liveOrgId: "org", leaseId: null,
};
const setup: SetupProgress = {
  step: 4, checklistOn: false, hasUnits: true, inviteMode: "lease", inviteHref: "/m/leases/one",
  unmappedEntryOk: true, customAuthority: false, tenantJoined: true, permissions: PERMS.map(([key]) => key), checklist: null,
};
const data = { received: 123, outstanding: 456, owingCount: 1, pending: 7, tickets: 8, occupied: 9, rooms: 10, properties: [], owing: [], expiring: [] };
const mine: PaymentTurnMatter = {
  id: "submitted", rule: "P1", holder: "manager", step: "confirm_payment", since: "2026-11-01T00:00:00Z", sinceExact: true,
  timezone: "UTC", amountMinor: 3200000, currency: "TWD", paidOn: "2026-11-01", leaseId: "lease", place: "Place A", tenantName: "Tenant A",
};
const other: PaymentTurnMatter = { ...mine, id: "rejected", rule: "P2", holder: "tenant", step: "re_report", sinceExact: false, tenantName: null };
const turns: Extract<StaffPaymentTurns, { state: "ready" }> = {
  state: "ready", yourTurn: 120,
  counts: [{ holder: "manager", step: "confirm_payment", count: 120 }, { holder: "tenant", step: "re_report", count: 60 }],
  mine: [mine], others: [other],
};
const bills = [{ currency: "TWD", due: "30000", received: "10000" }, { currency: "TWD", due: "10000", received: "10000" }];
const cta = resolveEmptyCta({ page: "DASH", setup, can: () => true });
function dashboard(extra: Partial<Parameters<typeof DashboardContent>[0]> = {}) {
  return render(<DashboardContent session={session} data={data} setup={setup} cta={cta} query={{}} v2 {...extra} />);
}

test("MGT-125-AC1/AC2 MGT-126-AC1/AC4: ready headline and ordered groups use uncapped counts and one linked avatar per row", () => {
  const html = dashboard({ v3: true, turns, bills, month: 11 });
  assert.match(html, /Test早，今天輪到你的有 120 件。/);
  assert.ok(html.indexOf("輪到你・120 件") < html.indexOf("等別人・60 件"));
  assert.ok(html.indexOf("等別人・60 件") < html.indexOf('data-testid="confirmed-bills"'));
  assert.equal((html.match(/class="v3-turn-row" href="\/m\/payments"/g) ?? []).length, 2);
  assert.equal((html.match(/role="img" class="party party-[mt]"/g) ?? []).length, 2);
  assert.match(html, /Place A・Tenant A・NT\$32,000・<span class="turn-tag"/);
  assert.match(html, /輪到你・確認已繳款/);
  assert.match(html, /等租客重新回報/);
  assert.doesNotMatch(html, /第 \d+ 天|relay|dash-received|待確認|btn pri/);
  assert.equal((html.match(/class="card kpi"/g) ?? []).length, 3);
  const legacy = dashboard();
  for (const card of html.match(/<a class="card kpi"[\s\S]*?<\/a>/g) ?? []) assert.ok(legacy.includes(card));
});

test("PLT-53-AC5 MGT-126-AC1: waiting name is optional; no day count even with an exact manager timestamp", () => {
  const html = dashboard({ v3: true, turns: { ...turns, others: [{ ...other, tenantName: "Tenant B" }] } });
  assert.match(html, /等租客Tenant B重新回報/);
  assert.doesNotMatch(html, /第 \d+ 天/);
});

test("MGT-125-AC3: ready with zero keeps the existing greeting and omits empty groups", () => {
  const html = dashboard({ v3: true, turns: { state: "ready", yourTurn: 0, counts: [], mine: [], others: [] } });
  assert.ok(html.includes(makeT("zh-TW")("i_morning", { name: session.name })));
  assert.doesNotMatch(html, /v3-turn-group|輪到你的有|0 件/);
});

test("MGT-125-AC3 PLT-53-AC6: unavailable and forbidden have no payment turns or count; unexpected failures propagate", async () => {
  const forbidden = await omitForbidden(async () => { throw new FlowError("errors.forbidden"); });
  assert.equal(forbidden, undefined);
  for (const result of [{ state: "unavailable" } as const, forbidden]) {
    const html = dashboard({ v3: true, turns: result });
    assert.doesNotMatch(html, /v3-turn-group|輪到你的有|0 件/);
    assert.ok(html.includes(makeT("zh-TW")("i_morning", { name: session.name })));
  }
  for (const error of [new FlowError("errors.other"), new Error("errors.forbidden")]) {
    await assert.rejects(omitForbidden(async () => { throw error; }), actual => actual === error);
  }
});

test("MGT-125-AC4 PLT-46: flag OFF, reader off, and no-units branch equal the existing dashboard markup", () => {
  assert.equal(dashboard({ v3: false, turns, bills, month: 11 }), dashboard());
  assert.equal(dashboard({ v3: true, turns: { state: "off" }, bills, month: 11 }), dashboard());
  const emptySetup = { ...setup, hasUnits: false };
  assert.equal(dashboard({ setup: emptySetup, v3: true, turns, bills, month: 11 }), dashboard({ setup: emptySetup }));
});

test("MGT-125-AC5: monthly number totals one currency, floors percent, and counts only fully covered positive dues", () => {
  const html = render(<ConfirmedBills rows={[...bills, { currency: "TWD", due: "20000", received: "0" }]} month={11} locale="zh-TW" />);
  assert.match(html, /11 月帳單，已確認繳款/);
  assert.match(html, /class="v3-bill-amount">NT\$200/);
  assert.match(html, /應繳 NT\$600・已確認 33%・1／3 筆/);
  assert.match(html, /href="\/m\/rent">查來源/);
  assert.match(html, /<progress[^>]*value="33"/);
});

test("MGT-125-AC5: two currencies remain separate; overpayment is fully covered and bar stays bounded", () => {
  const html = render(<ConfirmedBills rows={[...bills, { currency: "USD", due: "10000", received: "11000" }]} month={11} locale="en" />);
  assert.equal((html.match(/data-testid="confirmed-bills"/g) ?? []).length, 2);
  assert.match(html, /Confirmed 50%・1\/2 entries/);
  assert.match(html, /Confirmed 110%・1\/1 entries/);
  assert.match(html, /value="100"/);
});

test("MGT-125-AC5: no positive dues produces no number; nonpositive total suppresses percent", () => {
  assert.equal(render(<ConfirmedBills rows={[{ currency: "TWD", due: "0", received: "10000" }]} month={11} locale="en" />), "");
  const html = render(<ConfirmedBills rows={[{ currency: "TWD", due: "100", received: "0" }, { currency: "TWD", due: "-100", received: "0" }]} month={11} locale="en" />);
  assert.doesNotMatch(html, /%|<progress/);
  assert.match(html, /0\/1 entries/);
});

test("MGT-125-AC5 PLT-53-AC6: forbidden rent roll omits the number without hiding available payment turns", async () => {
  const forbiddenBills = await omitForbidden<typeof bills>(async () => { throw new FlowError("errors.forbidden"); });
  const html = dashboard({ v3: true, turns, bills: forbiddenBills, month: 11 });
  assert.doesNotMatch(html, /confirmed-bills/);
  assert.match(html, /輪到你・120 件/);
});

type History = Parameters<typeof TenantPaymentHistory>[0]["data"];
const history: History = {
  state: "ready", lease: { id: "lease", status: "active", currency: "TWD", canReport: true, legacyPayeeVisible: false },
  bill: { state: "due", overdue: false, pending: true, balanceMinor: 3200000, paidMinor: 0, currency: "TWD", lines: [] },
  monthlyDue: [], reports: [], nextCursor: null,
};
test("TEN-51-AC1/AC3/AC4 PLT-53-AC3: waiting uses the own-report amount, firm, clock and existing bilingual sentence", () => {
  const turn = tenantPaymentTurn({ ...history, turn: { waiting: { amountMinor: 3200000, currency: "TWD" }, reReport: false } });
  for (const locale of ["zh-TW", "en"] as const) {
    const html = render(<TenantPaymentTurnLine v3 turn={turn} firm="Test Firm" locale={locale} />);
    assert.ok(html.includes(makeT(locale)("i_reported_wait", { amount: "NT$32,000", firm: "Test Firm" })));
    assert.match(html, /v3-wait/);
    assert.doesNotMatch(html, /v3-check|Tenant A|Test Manager/);
  }
});

test("TEN-51-AC2: re-report line and no-turn states", () => {
  const turn = tenantPaymentTurn({ ...history, turn: { waiting: null, reReport: true } });
  assert.equal(render(<TenantPaymentTurnLine v3 turn={turn} firm="Firm" locale="zh-TW" />), '<p class="v3-tenant-turn" data-testid="tenant-payment-turn">輪到你・重新回報</p>');
  for (const input of [history, { state: "off" } as const, { state: "unavailable" } as const, { ...history, turn: { waiting: null, reReport: false } }]) {
    assert.equal(render(<TenantPaymentTurnLine v3 turn={tenantPaymentTurn(input)} firm="Firm" locale="en" />), "");
  }
});

test("TEN-51 PLT-46: flag OFF preserves full ready-page and history markup despite supplied turn inputs", () => {
  const props = { data: history, locale: "zh-TW" as const, place: "Place", firm: "Firm", report: <button>{makeT("zh-TW")("i_report_pay")}</button> };
  const turn = { kind: "waiting", amountMinor: 3200000, currency: "TWD" } as const;
  assert.equal(render(<TenantPayReadyContent {...props} v3={false} turn={turn} />), render(<TenantPayReadyContent {...props} />));
  assert.equal(render(<TenantPaymentHistory data={{ ...history, turn: { waiting: null, reReport: true } }} locale="zh-TW" pathname="/t/pay" v3={false} />), render(<TenantPaymentHistory data={history} locale="zh-TW" pathname="/t/pay" />));
  assert.equal(render(<TenantPaymentTurnLine v3={false} turn={turn} firm="Firm" locale="en" />), render(<TenantPaymentTurnLine firm="Firm" locale="en" />));
  const on = render(<TenantPayReadyContent {...props} v3 turn={turn} />);
  assert.ok(on.indexOf('data-testid="tenant-payment-turn"') < on.indexOf('data-testid="tenant-payment-summary"'));
  assert.ok(on.includes(`<button>${makeT("zh-TW")("i_report_pay")}</button>`));
});

test("TEN-51 PLT-46: initial and selected history requests add turn only when ON", () => {
  for (const selection of [{}, { cursor: "cursor", reportId: undefined }, { cursor: undefined, reportId: "report" }]) {
    const off = currentPaymentHistoryOptions(false, selection);
    assert.deepEqual(off, { view: "current", ...selection });
    assert.equal(Object.hasOwn(off, "turn"), false);
    assert.deepEqual(currentPaymentHistoryOptions(true, selection), { ...off, turn: true });
  }
  const page = readFileSync("src/app/t/pay/page.tsx", "utf8");
  assert.match(page, /tenantPaymentHistory\(session, lease\.lease_id, currentPaymentHistoryOptions\(v3\)\)/);
  assert.match(page, /currentPaymentHistoryOptions\(v3, \{ cursor, reportId \}\)/);
  assert.match(page, /v3 \? tenantPaymentTurn\(history\) : undefined/);
});

const paymentRows = ["submitted", "rejected", "confirmed", "reversed", "old-rejected"].map(id => ({
  id, status: id === "old-rejected" ? "rejected" : id, amount: "3200000", currency: "TWD", paid_on: "2026-11-01", last5: null, tenant: "Tenant A", place: "Place A",
}));
const paymentProps = { rows: paymentRows, locale: "zh-TW" as const, canAct: true, canReverse: true, reverseNote: "", actions: { confirm: () => {}, reject: () => {}, reverse: () => {} } };
const payments = (extra: Partial<Parameters<typeof PaymentsContent>[0]> = {}) => render(<PaymentsContent {...paymentProps} {...extra} />);

test("MGT-126-AC3 MGT-127-AC1: ready table adds holder before actions and uncapped supporting count", () => {
  const html = payments({ v3: true, turns });
  assert.match(html, /120 筆等你核對/);
  assert.match(html, /<th>輪到誰<\/th><th><\/th>/);
  assert.equal((html.match(/data-label="輪到誰"/g) ?? []).length, paymentRows.length);
  assert.equal((html.match(/party-m"/g) ?? []).length, 1);
  assert.equal((html.match(/party-t"/g) ?? []).length, 1);
  assert.match(html, /等租客重新回報/);
  assert.equal((html.match(/data-testid="confirm-payment"/g) ?? []).length, 1);
  assert.match(html, /class="btn sm v3-confirm-payment"/);
  assert.doesNotMatch(html, /class="btn sm pri"/);
  assert.doesNotMatch(payments({ v3: true, turns, canAct: false }), /data-testid="confirm-payment"|party-m"/);
  assert.doesNotMatch(payments({ v3: true, turns: { ...turns, yourTurn: 0 } }), /筆等你核對/);
});

test("MGT-127-AC5 PLT-46: OFF equals original table; off/unavailable readers keep the existing v3 table unchanged", () => {
  assert.equal(payments({ v3: false, turns }), payments());
  for (const state of ["off", "unavailable"] as const) {
    assert.equal(payments({ v3: true, turns: { state } }), payments({ v3: true }));
    assert.doesNotMatch(payments({ v3: true, turns: { state } }), /輪到誰|筆等你核對/);
  }
});

test("PLT-46 MGT-125-AC4: page wiring gates the extra reads and retains existing guards", () => {
  const page = readFileSync("src/app/m/page.tsx", "utf8");
  assert.match(page, /guardEffectiveSession\(await getSession\(\), "dash.view"\)/);
  assert.match(page, /v3 \? omitForbidden\(\(\) => staffPaymentTurns\(session\)\) : undefined/);
  assert.match(page, /v3 && can\(session, "stmt.view"\) \? omitFailure\(\(\) => rentRoll\(session\), /);
  assert.match(readFileSync("src/app/m/payments/page.tsx", "utf8"), /listPayments\(session\), v3 \? omitForbidden\(\(\) => staffPaymentTurns\(session\)\) : undefined/);
});

test("MGT-125-AC1: a user without a name gets the same sentence without the name, not a dangling greeting", () => {
  const ready: StaffPaymentTurns = { state: "ready", yourTurn: 3, counts: [{ holder: "manager", step: "confirm_payment", count: 3 }], mine: [], others: [] };
  for (const name of ["", "   "]) {
    const html = dashboard({ session: { ...session, name }, v3: true, turns: ready });
    assert.ok(html.includes("今天輪到你的有 3 件。"));
    assert.doesNotMatch(html, /早，今天/);
  }
  assert.ok(dashboard({ v3: true, turns: ready }).includes(`${session.name}早，今天輪到你的有 3 件。`));
});

test("MGT-125-AC5 / MGT-127 (B5: no number is dropped): a card leaves 今天 only when its 3.0 replacement is rendered", () => {
  const paid = makeT("zh-TW")("i_paid"), pending = makeT("zh-TW")("i_pending_pay");
  const kpi = (html: string, label: string) => html.includes(`<div class="lbl">${label}</div>`);
  const on = dashboard({ v3: true, turns, bills, month: 11 });
  assert.equal(kpi(on, paid), false, "the monthly figure replaces 已繳");
  assert.equal(kpi(on, pending), false, "待確認 moved to 收款 once the turn data is ready");
  // no monthly figure available (no stmt.view, or the read failed): 已繳 stays
  assert.equal(kpi(dashboard({ v3: true, turns, month: 11 }), paid), true);
  // turn data unavailable or refused: 待確認 stays, and no turn count is shown
  for (const t of [{ state: "unavailable" } as const, undefined]) {
    const html = dashboard({ v3: true, turns: t, bills, month: 11 });
    assert.equal(kpi(html, pending), true);
    assert.doesNotMatch(html, /輪到你的有/);
  }
  // the other three cards always stay in this slice
  for (const label of ["i_open_balance", "i_nav_tickets", "i_occ"] as const) assert.equal(kpi(on, makeT("zh-TW")(label)), true, label);
});

test("MGT-125-AC5: a failed read of the monthly figure is left out and logged, a refusal is left out silently; neither throws", async () => {
  const seen: unknown[] = [];
  const boom = new Error("rent roll timeout");
  assert.equal(await omitFailure(async () => { throw boom; }, e => seen.push(e)), undefined);
  assert.equal(await omitFailure(async () => { throw new FlowError("errors.forbidden"); }, e => seen.push(e)), undefined);
  assert.equal(await omitFailure(async () => 7, e => seen.push(e)), 7);
  assert.deepEqual(seen, [boom]);
});

test("PLT-46 TEN-51 MGT-125 MGT-127: every new copy key has both locales and identical interpolation fields", () => {
  const zh = brandV3Copy("zh-TW"), en = brandV3Copy("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
    assert.ok(zh[key].trim() && en[key].trim());
    assert.deepEqual((zh[key].match(/\{\w+\}/g) ?? []).sort(), (en[key].match(/\{\w+\}/g) ?? []).sort());
  }
});

test("PLT-47-AC3 MGT-126-AC1/AC4: new CSS is flag-scoped, existing-token-only and gives links/buttons 44px targets", () => {
  const source = readFileSync("public/brand/v3/theme.css", "utf8").split("/* B-070 3a:")[1];
  const css = postcss.parse("/* B-070 3a:" + source);
  css.walkRules(rule => assert.ok(rule.selector.startsWith('html[data-brand="v2"][data-brand-v3] '), rule.selector));
  css.walkDecls(decl => {
    assert.ok(!decl.prop.startsWith("--"));
    assert.doesNotMatch(decl.value, /#[\da-f]{3,8}|rgba?\(|hsla?\(/i);
  });
  for (const selector of [".v3-turn-row", ".v3-bill-source", ".btn.v3-confirm-payment"]) {
    const rule = css.nodes.find(node => node.type === "rule" && node.selector.endsWith(` ${selector}`));
    assert.ok(rule?.type === "rule");
    assert.ok(rule.nodes.some(node => node.type === "decl" && node.prop === "min-height" && node.value === "44px"));
    assert.ok(rule.nodes.some(node => node.type === "decl" && node.prop === "min-width" && node.value === "44px"));
  }
});
