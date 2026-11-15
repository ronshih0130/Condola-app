import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as i18n from "../i18n";
import * as ownStatus from "../i18n/lanes/brand-v3-own-status";
import * as copy from "../i18n/lanes/brand-v3-money";
import * as brand from "../i18n/lanes/brand-v3";
import * as center from "../i18n/lanes/notification-center";
import * as format from "./format";
import * as perms from "./perms";
import { FlowError } from "./errors";
import { RoleAvatar } from "../components/v3/role-avatar";
import { CompletionCheck } from "../components/v3/completion-check";
import type { MoneyPage as View } from "../components/v3/m/money/money";
import type * as Model from "./money-page";
import type { MoneyMonthBills, MoneyMonthReports, MoneyMonthBill, MoneyMonthReport } from "./b3-money-month";
import { moneyMonthStatus } from "./b3-money-month";
import type { Session } from "./types";

const source = (file: string) => readFileSync(file, "utf8");
const requireHere = createRequire(import.meta.url);
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked: ${name}`);
  }, exports);
  return exports;
}
const model = compile(source("src/server/money-page.ts"), {
  "./b3-money-month": {}, "./errors": { FlowError, logServerError: () => {} }, "./perms": perms,
}) as typeof Model;
const session: Session = { kind: "staff", role: "admin", orgId: "org", liveOrgId: "org", userId: "user", sessionId: "session", name: "王怡君", email: "fixture@example.invalid", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const confirm = async () => {};
const proxy = compile(source("src/components/v3/m/money/proxy-confirmation.tsx"), {
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
  "../../../../i18n/lanes/brand-v3-money": copy, "../../../../i18n/lanes/brand-v3": brand,
  "../../../../i18n/lanes/brand-v3-own-status": ownStatus,
  "../../../../server/actions": { actionConfirmPayment: confirm }, "../../completion-check": { CompletionCheck },
});
const view = compile(source("src/components/v3/m/money/money.tsx"), {
  "./proxy-confirmation": proxy,
  "next/link": { __esModule: true, default: "a" }, "../../../../i18n": i18n,
  "../../../../i18n/lanes/brand-v3-money": copy, "../../../../i18n/lanes/brand-v3": brand,
  "../../../../i18n/lanes/notification-center": center,
  "../../../../server/actions": { actionConfirmPayment: confirm }, "../../../../server/money-page": model,
  "../../../../server/perms": perms, "../../../../server/format": format, "../../../../server/sandbox-data": { displaySampleName: (name: string) => name },
  "../../../ui": { ErrorBanner: ({ error }: { error?: string }) => error ? <p>{error}</p> : null },
  "../../role-avatar": { RoleAvatar }, "../../completion-check": { CompletionCheck },
}).MoneyPage as typeof View;
function bill(status: MoneyMonthBill["status"], leaseId = status): MoneyMonthBill {
  return { leaseId, status, month: "2026-11", place: `Property ${leaseId}`, tenantName: `Tenant ${leaseId}`, currency: "TWD", dueDate: "2026-11-10", totalMinor: "3200000", confirmedMinor: status === "paid" ? "3200000" : "1000000", remainingMinor: status === "paid" ? "0" : "2200000" };
}
function report(id: string, other = false): MoneyMonthReport {
  return { id, leaseId: "reported", place: "Property reported", tenantName: "Tenant reported", amountMinor: "50000", currency: "TWD", paidOn: "2026-10-01", submittedAt: `2026-11-${id === "r1" ? "10" : "11"}T18:00:00Z`, source: "tenant_portal", ownerPayee: null, bankTransactionId: null, proofFileId: null, billRows: other ? [] : [{ leaseId: "reported", month: "2026-11" }], attachment: other ? "other" : "oldest_unpaid" };
}
const bills: Extract<MoneyMonthBills, { state: "ready" }> = {
  state: "ready", month: "2026-11", today: "2026-11-14", timezone: "Asia/Taipei", population: "rent_roll_active_unarchived",
  counts: { all: 5, paid: 1, reported: 1, overdue: 1, due_today: 1, future: 1 }, filteredCount: 5, totals: [],
  outstanding: { leaseCount: 3, currencies: [{ currency: "TWD", amountMinor: "9000000", leaseCount: 3 }] },
  rows: [bill("overdue"), bill("reported"), bill("future"), bill("paid"), bill("due_today")], nextCursor: null,
};
const reports: Extract<MoneyMonthReports, { state: "ready" }> = {
  state: "ready", month: "2026-11", today: "2026-11-14", timezone: "Asia/Taipei", yourTurn: 3, attachedCount: 2, otherCount: 1, otherScope: "all_pending",
  attached: [report("r2"), report("r1")], other: [report("other", true)], nextCursor: null,
};
function render(extra: Partial<React.ComponentProps<typeof View>> = {}) {
  return renderToStaticMarkup(React.createElement(view, { session, month: "2026-11", tab: "all", bills, reports, ...extra }));
}
const deps = { bills: async () => bills as MoneyMonthBills, reports: async () => reports as MoneyMonthReports, now: () => new Date("2026-11-14T00:00:00Z") };

test("approved headline, remaining amount, outstanding, and all five tabs (counts use reader totals)", () => {
  for (const [tab, expected] of [["all", 5], ["yours", 1], ["overdue", 1], ["future", 1], ["paid", 1]] as const) {
    const html = render({ tab });
    assert.equal((html.match(/data-testid="money-bill"/g) ?? []).length, expected);
    assert.match(html, /11 月 5 筆應繳，1 筆已確認繳款。/);
    assert.match(html, /3 筆等你核對/); assert.match(html, /未結餘額 NT\$90,000・3 位租客/);
    assert.match(html, new RegExp(`aria-current="page" data-testid="money-tab-${tab}"`));
    if (tab === "overdue") { assert.match(html, /NT\$22,000/); assert.doesNotMatch(html, /NT\$32,000/); }
  }
  const html = render({ reports: { ...reports, yourTurn: 145 }, bills: { ...bills, counts: { ...bills.counts, all: 123 } } });
  assert.match(html, /123 筆應繳/); assert.match(html, /145 筆等你核對/);
  assert.match(html, /money-tab-yours">輪到你 <span>145<\/span>/);
});

test("其他回報 only at top of 輪到你; multiple attached reports oldest first, each confirms its own id", () => {
  const html = render({ tab: "yours" });
  assert.ok(html.indexOf('data-testid="money-other"') < html.indexOf('data-testid="money-bill"'));
  assert.ok(html.indexOf('data-report-id="r1"') < html.indexOf('data-report-id="r2"'));
  for (const id of ["other", "r1", "r2"]) assert.ok(html.includes(`name="paymentId" value="${id}"`));
  assert.equal((html.match(/data-testid="confirm-payment"/g) ?? []).length, 3);
  assert.match(html, /2026年11月11日/); // report r1 uses the organization's date, not the paid date
  assert.doesNotMatch(render(), /money-other|其他回報/);
  assert.doesNotMatch(html, /復原|匯出對帳表|btn pri|銀行明細/);
  assert.match(render({ reports: { ...reports, attached: [{ ...report("r1"), bankTransactionId: "bank" }] } }), /銀行明細/);
});

test("paid is the only state with the existing completion mark; unpaid rows never animate confirmation", () => {
  assert.match(render({ tab: "paid" }), /v3-check/);
  for (const tab of ["yours", "overdue", "future"] as const) assert.doesNotMatch(render({ tab }), /v3-check/);
});

test("M-PROXY: owner payee opens the sheet; management and unassigned payees retain the normal action", () => {
  const ownerReports = { ...reports, attached: [{ ...report("r1"), ownerPayee: { displayName: "Synthetic owner" } }, report("r2")] };
  for (const role of ["admin", "manager", "accountant"] as const) {
    const html = render({ session: { ...session, role }, reports: ownerReports });
    assert.equal((html.match(/data-testid="confirm-owner-payment"/g) ?? []).length, 1);
    assert.equal((html.match(/data-testid="confirm-payment"/g) ?? []).length, 1);
    assert.match(html, /name="paymentId" value="r2"/);
    assert.doesNotMatch(html, /name="paymentId" value="r1"|v3-proxy-sheet/);
  }
  // Even an incorrectly supplied ready DTO cannot give a denied viewer a button.
  for (const viewer of [{ ...session, role: "maintenance" as const }, { ...session, kind: "owner" as const },
    { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin" as const, assigned: true,
      keys: ["stmt.view" as const], photos: false, audit: false } }]) {
    assert.doesNotMatch(render({ session: viewer, reports: ownerReports }), /data-testid="confirm-(owner-)?payment"/);
  }
  assert.doesNotMatch(render({ reports: { state: "forbidden" } }), /confirm-owner-payment/);
});

test("MGT-141: due-state tab membership, remaining line, headline and completion across the due boundary", () => {
  const due = "2026-11-15";
  for (const [today, bucket] of [["2026-11-14", "future"], [due, "due_today"], ["2026-11-16", "overdue"]] as const) {
    for (const full of [false, true]) for (const pending of [false, true]) {
      const confirmed = full ? "3200000" : "1000000";
      const status = moneyMonthStatus("3200000", confirmed, pending, due, today);
      const row = { ...bill(status), dueDate: due, confirmedMinor: confirmed, remainingMinor: full ? "0" : "2200000" };
      const expectedBucket = full ? "paid" : pending ? "reported" : bucket;
      const counts = { all: 1, paid: 0, reported: 0, overdue: 0, due_today: 0, future: 0, [expectedBucket]: 1 };
      const snapshot = { ...bills, today, counts, rows: [row], totals: [{ currency: "TWD", totalMinor: "3200000", confirmedMinor: confirmed, billedRows: 1, paidRows: full ? 1 : 0 }] };
      for (const tab of ["all", "yours", "overdue", "future", "paid"] as const) {
        const visible = tab === "all" || (tab === "yours" ? expectedBucket === "reported" : expectedBucket === tab);
        assert.equal(model.moneyBillMatchesTab(row, today, tab), visible);
        const html = render({ tab, bills: snapshot, reports: { ...reports, attached: [], other: [], yourTurn: 0 } });
        assert.equal((html.match(/data-testid="money-bill"/g) ?? []).length, visible ? 1 : 0);
        assert.match(html, new RegExp(`11 月 1 筆應繳，${full ? 1 : 0} 筆已確認繳款。`));
        if (visible) {
          assert.match(html, new RegExp(`data-status="${status}"`));
          if (full) { assert.match(html, /v3-check/); assert.doesNotMatch(html, /money-partial-amounts/); }
          else {
            assert.doesNotMatch(html, /v3-check/);
            assert.match(html, /已繳 NT\$10,000・還差 NT\$22,000/);
            if (!pending && bucket !== "overdue") { assert.match(html, /部分已繳/); assert.match(html, /等租客繳款/); }
          }
        }
      }
    }
  }
});

test("MGT-141 partial amounts use existing formatting in both locales and currencies; unpaid has no paid line", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const currency of ["TWD", "USD"] as const) {
    const row = { ...bill("partial"), dueDate: "2026-11-15", currency };
    const html = render({ session: { ...session, locale }, bills: { ...bills, rows: [row] } });
    const line = locale === "en"
      ? `Paid ${format.moneyLabel(row.confirmedMinor, currency, locale)} · Remaining ${format.moneyLabel(row.remainingMinor, currency, locale)}`
      : `已繳 ${format.moneyLabel(row.confirmedMinor, currency, locale)}・還差 ${format.moneyLabel(row.remainingMinor, currency, locale)}`;
    assert.ok(html.includes(line));
    assert.ok(html.includes(locale === "en" ? "Partially paid" : "部分已繳"));
    assert.equal((html.match(/data-testid="money-tab-/g) ?? []).length, 5);
  }
  assert.doesNotMatch(render({ bills: { ...bills, rows: [{ ...bill("due_today"), confirmedMinor: "0", remainingMinor: "3200000" }] } }), /money-partial-amounts|部分已繳/);
});

test("no pay.record: bills remain, but no report source, turn count, row action, or reported-state disclosure", async () => {
  const limited: Session = { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned: true, keys: ["stmt.view"], photos: false, audit: false } };
  const data = await model.readMoneyPage(limited, {}, { ...deps, reports: async () => assert.fail("must not read reports") });
  assert.equal(data.reports.state, "forbidden");
  const html = render({ session: limited, ...data });
  assert.match(html, /5 筆應繳/);
  assert.match(html, /class="v3-money-status">—<\/span>/);
  assert.doesNotMatch(html, /money-tab-yours|等你核對|confirm-payment|租客回報|已回報|data-status="reported"|v3-money-reported|party-/);
});

test("forbidden, off and unavailable readers remain independent and never become a zero count", async () => {
  for (const state of ["off", "unavailable"] as const) {
    const unavailableBills = await model.readMoneyPage(session, {}, { ...deps, bills: async () => ({ state }) });
    const html = render({ ...unavailableBills, tab: "yours" });
    assert.match(html, /3 筆等你核對/); assert.doesNotMatch(html, /0 筆應繳|未結餘額/);
    assert.match(html, /money-tab-all">全部 <span>—<\/span>/);
    assert.equal((html.match(/confirm-payment/g) ?? []).length, 3);
    const unavailableReports = await model.readMoneyPage(session, {}, { ...deps, reports: async () => ({ state }) });
    const partial = render(unavailableReports);
    assert.match(partial, /5 筆應繳/); assert.match(partial, /money-tab-yours">輪到你 <span>—<\/span>/);
    assert.doesNotMatch(partial, /等你核對|confirm-payment/);
  }
  for (const key of ["bills", "reports"] as const) {
    const denied = await model.readMoneyPage(session, {}, { ...deps, [key]: async () => { throw new FlowError("errors.forbidden"); } });
    assert.equal(denied[key].state, "forbidden");
    const broken = await model.readMoneyPage(session, {}, { ...deps, [key]: async () => { throw new Error("offline"); } });
    assert.equal(broken[key].state, "unavailable");
  }
  const payOnly: Session = { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned: true, keys: ["pay.record"], photos: false, audit: false } };
  const data = await model.readMoneyPage(payOnly, {}, { ...deps, bills: async () => assert.fail("no stmt.view") });
  assert.equal(data.bills.state, "forbidden"); assert.equal(data.reports.state, "ready");
});

test("zero omits supporting clauses, but ready tab counts can truthfully be zero", () => {
  const html = render({ bills: { ...bills, counts: { all: 0, paid: 0, reported: 0, overdue: 0, due_today: 0, future: 0 }, rows: [], outstanding: { leaseCount: 0, currencies: [] } }, reports: { ...reports, yourTurn: 0, attachedCount: 0, otherCount: 0, attached: [], other: [] } });
  assert.doesNotMatch(html, /money-supporting/); assert.match(html, /money-empty/);
  assert.match(html, /money-tab-yours">輪到你 <span>0<\/span>/);
});

test("month links preserve the tab, cross years, and invalid input uses the reader's org calendar", async () => {
  const html = render({ month: "2026-01", tab: "overdue" });
  assert.match(html, /month=2025-12&amp;tab=overdue/); assert.match(html, /month=2026-02&amp;tab=overdue/);
  assert.equal(model.adjacentMoneyMonth("2026-12", 1), "2027-01");
  for (const value of ["2026-13", "0000-01", "2026-1", "bad"]) assert.equal(model.validMoneyMonth(value), false);
  const seen: string[] = [];
  const result = await model.readMoneyPage(session, { month: "bad", tab: "injected" }, { ...deps,
    now: () => new Date("2026-10-31T18:00:00Z"), bills: async (_session, input) => { seen.push(input.month); return bills; },
  });
  assert.deepEqual(seen, ["2026-10", "2026-11"]); assert.equal(result.month, "2026-11"); assert.equal(result.tab, "all");
});

test("one call per reader uses the selected status and only the primary cursor; summary and rows stay together", async () => {
  for (const tab of ["all", "yours", "overdue", "future", "paid"] as const) {
    const billInputs: unknown[] = [], reportInputs: unknown[] = [];
    const data = await model.readMoneyPage(session, { month: "2026-11", tab, cursor: "opaque+/=?" }, { ...deps,
      bills: async (_session, input) => { billInputs.push(input); return { ...bills, rows: [bill("paid")], nextCursor: "bill-next" }; },
      reports: async (_session, input) => { reportInputs.push(input); return { ...reports, attached: [], nextCursor: "report-next" }; },
    });
    assert.deepEqual(billInputs, [{ month: "2026-11", status: tab === "all" ? undefined : tab === "yours" ? "reported" : tab, cursor: tab === "yours" ? undefined : "opaque+/=?" }]);
    assert.deepEqual(reportInputs, [{ month: "2026-11", cursor: tab === "yours" ? "opaque+/=?" : undefined }]);
    assert.equal(data.bills.state, "ready");
    if (data.bills.state === "ready") { assert.equal(data.bills.counts.paid, 1); assert.equal(data.bills.rows.length, 1); }
    assert.match(render(data), /5 筆應繳，1 筆已確認繳款/);
    assert.match(render(data), new RegExp(`cursor=${tab === "yours" ? "report" : "bill"}-next`));
  }
});

test("paging links preserve month/tab, encode opaque cursors and reuse shipped bilingual words", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const tab of ["all", "yours"] as const) {
    const html = render({ session: { ...session, locale }, tab, cursor: "current",
      bills: { ...bills, nextCursor: "bill+/=?" }, reports: { ...reports, nextCursor: "report+/=?" } });
    assert.match(html, new RegExp(`href="/m/payments\\?month=2026-11&amp;tab=${tab}&amp;cursor=${tab === "yours" ? "report" : "bill"}%2B%2F%3D%3F"`));
    assert.match(html, new RegExp(`href="/m/payments\\?month=2026-11&amp;tab=${tab}">${locale === "en" ? "Back to first page" : "返回第一頁"}`));
    assert.ok(html.includes(locale === "en" ? "Next page" : "下一頁"));
  }
  assert.doesNotMatch(render(), /下一頁|返回第一頁/);
});

test("invalid primary cursors fail only that reader and retain a first-page/retry path", async () => {
  for (const tab of ["all", "yours"] as const) for (const cursor of ["", "!invalid"]) {
    const data = await model.readMoneyPage(session, { month: "2026-11", tab, cursor }, { ...deps,
      bills: async (_s, input) => input.cursor !== undefined ? { state: "unavailable" } : bills,
      reports: async (_s, input) => input.cursor !== undefined ? { state: "unavailable" } : reports,
    });
    assert.equal(data[tab === "yours" ? "reports" : "bills"].state, "unavailable");
    assert.equal(data[tab === "yours" ? "bills" : "reports"].state, "ready");
    assert.match(render(data), /返回第一頁/); assert.match(render(data), /再試一次/);
  }
});

test("pay.record-only and bill failure still select the org month; both reads are bounded to one retry", async () => {
  for (const mode of ["payOnly", "failure", "billCalendar"] as const) {
    const limited = mode === "payOnly" ? { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin" as const, assigned: true, keys: ["pay.record"] as perms.PermKey[], photos: false, audit: false } } : session;
    const billMonths: string[] = [], reportMonths: string[] = [];
    const data = await model.readMoneyPage(limited, {}, { ...deps, now: () => new Date("2026-10-31T18:00:00Z"),
      bills: async (_s, input) => { billMonths.push(input.month); return mode === "failure" ? { state: "unavailable" } : { ...bills, today: "2026-11-01" }; },
      reports: async (_s, input) => { reportMonths.push(input.month); return { ...reports, today: reportMonths.length === 1 ? "2026-11-01" : "2026-12-01" }; },
    });
    assert.equal(data.month, "2026-11"); assert.deepEqual(reportMonths, ["2026-10", "2026-11"]);
    assert.deepEqual(billMonths, mode === "payOnly" ? [] : ["2026-10", "2026-11"]);
  }
  let calls = 0;
  const explicit = await model.readMoneyPage(session, { month: "2026-09" }, { ...deps,
    bills: async () => { calls++; return bills; }, reports: async () => { calls++; return reports; } });
  assert.equal(explicit.month, "2026-09"); assert.equal(calls, 2);
});

test("list link follows pay.record permission; confirmation and retry preserve month/tab", () => {
  const html = render({ month: "2026-09", tab: "yours", error: "errors.generic" });
  assert.match(html, /href="\/m\/payments\/list">待確認繳款<\/a>/);
  assert.match(html, /name="returnTo" value="\/m\/payments\?month=2026-09&amp;tab=yours"/);
  assert.match(html, /href="\/m\/payments\?month=2026-09&amp;tab=yours">再試一次/);
  const limited: Session = { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned: true, keys: ["stmt.view"], photos: false, audit: false } };
  assert.doesNotMatch(render({ session: limited, reports: { state: "forbidden" } }), /\/m\/payments\/list/);
});

test("scoped CSS uses tokens only", () => {
  const css = postcss.parse(source("public/brand/v3/money.css"));
  css.walkRules(rule => assert.ok(rule.selector.startsWith('html[data-brand="v2"][data-brand-v3]')));
  css.walkDecls(decl => assert.doesNotMatch(decl.value, /#[0-9a-f]{3,8}\b|rgba?\(/i));
});

test("/m/payments and /m/rent OFF render byte-identical legacy markup; ON renders the same new tree", async () => {
  type Page = (props: { searchParams: Promise<Model.MoneyParams> }) => Promise<React.ReactNode>;
  const baseline = (file: string) => execFileSync("git", ["show", `e1cd98f:${file}`], { encoding: "utf8" });
  for (const locale of ["zh-TW", "en"] as const) for (const empty of [false, true]) for (const role of ["admin", "accountant"] as const) {
    let v3 = false, reads = 0, allowLegacy = false;
    const read = <T,>(value: T) => async () => { reads++; if (v3 && !allowLegacy) assert.fail("v3 must not use old readers"); return value; };
    const node = ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => <div>{title}{children}</div>;
    const mocks = {
      "react": React, "next/link": { __esModule: true, default: "a" }, "@/i18n": i18n,
      "@/server/brand-v3": { brandV3EnabledForOrg: async () => v3 },
      "@/components/v3/m/money/page": { MoneyMonthPage: ({ params }: { params: Model.MoneyParams }) => <div data-month={params.month} data-tab={params.tab}>money</div> },
      "@/components/v3/completion-check": { CompletionCheck }, "@/components/management-empty-state": { ManagementEmptyState: () => <div>empty</div> },
      "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/components/ui": { PageHeader: node, ErrorBanner: () => null, statusClass: (s: string) => s, statusKey: () => "i_paid_up" },
      "@/components/rf": { Cell: node, RfTable: node },
      "@/server/auth-actions": { actionReversePayment: confirm }, "@/server/actions": { actionConfirmPayment: confirm, actionRejectPayment: confirm },
      "@/server/format": format, "@/server/perms": perms,
      "@/server/queries": {
        listPayments: read(empty ? [] : [{ id: "pending", tenant: "Tenant", place: "Property", paid_on: "2026-11-10", last5: "12345", amount: "50000", currency: "TWD", status: "submitted" }, { id: "paid", tenant: "Tenant", place: "Property", paid_on: "2026-11-09", amount: "50000", currency: "TWD", status: "confirmed" }]),
        rentRoll: read(empty ? [] : [{ property_id: "p", property_name: "Property", space_id: "s", space_label: "3F", lease_id: "l", tenant: "Tenant", currency: "TWD", balance: "10000", due: "50000", received: "40000", rent: "50000", due_date: "2026-11-10" }]),
      },
      "@/server/sandbox-data": { displaySampleName: (value: string) => value },
      "@/server/session": { getSession: async () => ({ ...session, locale, role }) },
      "@/server/monthly-billing-plan": { monthlyBillingAvailable: read(false) },
      "@/i18n/monthly-billing-preview": { monthlyBillingCopy: () => ({ title: "Preview" }) },
      "@/server/manual-reminders": { manualRemindersEnabled: read(false) }, "@/server/money": { taipeiToday: () => "2026-11-14" },
    };
    Object.assign(mocks, { "@/components/legacy-payments-list": compile(source("src/components/legacy-payments-list.tsx"), mocks) });
    const trees: string[] = [];
    for (const path of ["src/app/m/payments/page.tsx", "src/app/m/rent/page.tsx"]) {
      v3 = false;
      const old = compile(baseline(path), mocks).default as Page, current = compile(source(path), mocks).default as Page;
      const props = { searchParams: Promise.resolve({ month: "2026-09", tab: "yours", error: "errors.generic" }) };
      const before = renderToStaticMarkup(await old(props)); const beforeReads = reads; reads = 0;
      assert.equal(renderToStaticMarkup(await current(props)), before); assert.equal(reads, beforeReads); reads = 0;
      v3 = true;
      trees.push(renderToStaticMarkup(await current(props)));
    }
    allowLegacy = true;
    for (const flag of [false, true]) {
      v3 = flag;
      const list = compile(source("src/app/m/payments/list/page.tsx"), mocks).default as Page;
      const html = renderToStaticMarkup(await list({ searchParams: Promise.resolve({ error: "errors.generic" }) }));
      assert.doesNotMatch(html, /money-v3/);
      if (!empty) {
        assert.match(html, /name="returnTo" value="\/m\/payments\/list"/);
        assert.match(html, /confirm-payment/); assert.match(html, /name="reason"/);
        if (perms.can({ ...session, role }, "pay.reverse")) assert.match(html, /reverse-form/);
        else assert.match(html, /reverse-disabled/);
      }
    }
    assert.equal(trees[0], trees[1]); assert.match(trees[0], /data-month="2026-09" data-tab="yours"/);
  }
});

test("v3 layout admits either reader only on the two exact money routes; OFF/nested route gates stay unchanged", async () => {
  type Layout = (p: { children: React.ReactNode }) => Promise<React.ReactNode>;
  for (const flag of [false, true]) for (const keys of [["stmt.view"], ["pay.record"], []] as perms.PermKey[][]) {
    const limited: Session = { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned: true, keys, photos: false, audit: false } };
    for (const path of ["/m/payments", "/m/rent", "/m/rent/monthly-preview", "/m/payments/list"]) {
      const stub = () => null;
      const Layout = compile(source("src/app/m/layout.tsx"), {
        "@/i18n/lanes/brand-v3": brand, "@/server/brand-v3": { brandV3EnabledForOrg: async () => flag },
        "@/server/nav-v3": { areasFor: () => [], tabsFor: () => [] }, "@/components/v3/shell/manager-shell": { ManagerShellV3: stub },
        "next/headers": { headers: async () => ({ get: () => path }), cookies: async () => ({ get: () => undefined }) },
        "next/navigation": { redirect: (href: string) => { throw new Error(href); } }, "@/build-info": { BUILD_SHA: "fixture" },
        "@/components/chrome": { Sidebar: stub, TaskPanel: stub }, "@/server/consent-gate": { requireCurrentConsent: async () => {} },
        "@/server/demo": { demoModeEnabled: () => false }, "@/server/perms": perms,
        "@/server/queries": { loadManagerChrome: async () => ({ flags: {}, firm: { name: "Company" }, badge: {} }) },
        "@/server/session": { getSession: async () => limited }, "@/server/b056-trial": { trialBannerFor: async () => null }, "@/components/b056-trial-banner": { TrialBanner: stub },
      }).default as Layout;
      const oldDenied = perms.noPermHref(path, limited);
      const allowed = flag && ["/m/payments", "/m/rent"].includes(path) && keys.length > 0 || !oldDenied;
      if (allowed) await Layout({ children: null });
      else await assert.rejects(() => Layout({ children: null }), /\/m\/noperm/);
    }
  }
});

test("visible report-to-bill conflicts fail closed, while paid precedence and off-page targets remain valid", async () => {
  for (const status of ["overdue", "due_today", "future", "reported", "paid"] as const) {
    const data = await model.readMoneyPage(session, {}, { ...deps, bills: async () => ({ ...bills, rows: [bill(status, "reported")] }) });
    assert.equal(data.reports.state, ["reported", "paid"].includes(status) ? "ready" : "unavailable");
    if (status === "paid") assert.match(render(data), /data-status="paid"/);
    else if (status !== "reported") assert.doesNotMatch(render(data), /confirm-payment/);
  }
  const offPage = await model.readMoneyPage(session, { tab: "yours" }, { ...deps, bills: async () => ({ ...bills, rows: [], nextCursor: "beyond" }) });
  assert.equal(offPage.reports.state, "ready");
  assert.equal((render(offPage).match(/data-testid="money-report-only"/g) ?? []).length, 2);
});

test("reported bills need an attached report only when the report list is complete; no invented buttons", async () => {
  for (const [tab, cursor, nextCursor, expected] of [
    ["all", undefined, null, "unavailable"], ["all", "bill-page-2", null, "unavailable"],
    ["all", undefined, "report-page-2", "ready"], ["yours", "report-page-2", null, "ready"],
  ] as const) {
    const data = await model.readMoneyPage(session, { tab, cursor }, { ...deps,
      reports: async () => ({ ...reports, attached: [], other: [], nextCursor }),
    });
    assert.equal(data.reports.state, expected); assert.doesNotMatch(render(data), /confirm-payment/);
    if (expected === "ready") assert.match(render(data), /v3-money-reported/);
    if (expected === "unavailable") { assert.doesNotMatch(render(data), /v3-money-reported/); assert.match(render(data), /class="v3-money-status">—<\/span>/); }
  }
});

test("輪到你 without report access falls back to 全部: no `reported` bill filter, no foreign cursor (Codex r2 I1)", async () => {
  const billOnly: Session = { ...session, customRole: { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned: true, keys: ["stmt.view"], photos: false, audit: false } };
  for (const [actor, reportsRead] of [[billOnly, undefined], [session, "forbidden"]] as const) {
    const billInputs: unknown[] = [];
    const data = await model.readMoneyPage(actor, { month: "2026-11", tab: "yours", cursor: "report-cursor" }, { ...deps,
      bills: async (_session, input) => { billInputs.push(input); return { ...bills, rows: [bill("paid")], nextCursor: null }; },
      reports: async () => { if (reportsRead === "forbidden") throw new FlowError("errors.forbidden"); return assert.fail("bill-only viewer must not read reports"); },
    });
    assert.deepEqual(billInputs, [{ month: "2026-11", status: undefined, cursor: undefined }]);
    assert.equal(data.tab, "all"); assert.equal(data.cursor, undefined); assert.equal(data.reports.state, "forbidden");
    assert.doesNotMatch(render(data), /money-tab-yours/);
  }
});
