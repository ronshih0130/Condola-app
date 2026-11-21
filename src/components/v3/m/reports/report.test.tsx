import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IncomeReportView, ReportSkeleton, reportHref } from "./report";
import { incomeReportCopy } from "../../../../i18n/lanes/brand-v3-report";
import type { IncomeReportReady } from "../../../../server/b3-income-report";
import type { Session } from "../../../../server/types";
Object.assign(globalThis, { React });
const s: Session = { orgId: "org", userId: "user", sessionId: "session", liveOrgId: "org", environment: "live", kind: "staff", role: "accountant",
  name: "Synthetic", email: "", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const data: IncomeReportReady = { state: "ready", period: { mode: "month", month: "2030-05", start: "2030-05-01", end: "2030-05-31" }, timezone: "UTC", count: 1,
  totals: [{ currency: "TWD", incomeMinor: "10000", expenseMinor: "3000", netMinor: "7000", depositMinor: "500", earlyRentMinor: "0", prepaymentMinor: "0" },
    { currency: "USD", incomeMinor: "100", expenseMinor: "300", netMinor: "-200", depositMinor: "0", earlyRentMinor: "0", prepaymentMinor: "0" }],
  rows: [{ key: "row", date: "2030-05-01", kind: "income", item: "Synthetic rent", property: "Synthetic property", propertyId: "prop", owner: "Synthetic owner", ownerId: "owner",
    paidOn: "2030-05-01", serviceMonthStart: "2030-05-01", leaseId: "lease", currency: "TWD", amountMinor: "10000", sourceAmountMinor: "10500", sourceId: "payment-source", invoiceId: "invoice", allocationId: "allocation" }],
  nextCursor: "cursor", choices: { properties: [{ id: "prop", name: "Synthetic property" }], owners: [{ id: "owner", name: "Synthetic owner" }] } };

test("per-currency lead, sole solid CSV primary, separate prepayment sections and no annual flow, source disclosure", () => {
  const html = renderToStaticMarkup(<IncomeReportView session={s} input={{ property: "prop", owner: "owner" }} data={data} />);
  assert.ok(html.includes("2030-05 收入 NT$100，支出 NT$30，淨額 NT$70。"));
  assert.ok(html.includes("淨額 −USD 2.00")); assert.ok(html.includes(incomeReportCopy("zh-TW").tax));
  assert.equal((html.match(/class="btn"/g) ?? []).length, 1); assert.ok(html.includes("report-export"));
  assert.ok(html.includes("payment-source")); assert.ok(html.includes("NT$105")); assert.ok(html.includes("<summary>查來源</summary>"));
  assert.ok(!html.includes("年度收支匯出")); assert.ok(!html.includes("/m/payments"));
  assert.ok(html.includes("property=prop&amp;owner=owner"));
  assert.ok(html.includes("只算已確認的。押金和預付另外列，不算收入。"));
  const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
  assert.ok(aside.includes("另外列")); assert.ok(aside.includes("押金 NT$5"));
  assert.ok(aside.includes("預付")); assert.ok(aside.includes("另外列：預收租金"));
});
test("view-only hides export and write destinations; empty drawing 14 and shipped sentence, no export", () => {
  const viewer: Session = { ...s, customRole: { orgId: s.orgId, userId: s.userId, sessionId: s.sessionId, nativeRole: s.role, keys: ["stmt.view"], photos: false, audit: false } };
  const html = renderToStaticMarkup(<IncomeReportView session={viewer} input={{}} data={data} />);
  assert.ok(!html.includes("report-export")); assert.ok(!html.includes("/m/expenses/"));
  const empty = renderToStaticMarkup(<IncomeReportView session={s} input={{}} data={{ ...data, count: 0, rows: [], totals: [], nextCursor: null }} />);
  assert.ok(empty.includes('data-v3-illustration="14"')); assert.ok(empty.includes("這個範圍沒有物件。"));
  assert.ok(!empty.includes("report-export")); assert.ok(!empty.includes("NT$0"));
});
test("failure preserves all filters/cursor and no fabricated zero; skeleton contains no amounts", () => {
  const input = { mode: "range", from: "2030-05-02", to: "2030-05-20", property: "prop", owner: "owner", cursor: "cursor" };
  const html = renderToStaticMarkup(<IncomeReportView session={s} input={input} data={{ state: "unavailable" }} />);
  for (const text of ["資料載入失敗", "再試一次", 'value="prop"', 'value="owner"', 'value="2030-05-02"', "cursor=cursor"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("NT$0")); assert.ok(!html.includes("report-export"));
  assert.ok(!renderToStaticMarkup(<ReportSkeleton />).includes("NT$"));
  const url = reportHref(input, "next"); assert.ok(url.includes("cursor=next")); assert.ok(!reportHref(input, undefined, true).includes("cursor="));
});

test("early rent and unallocated payments appear only in separate sections with service/lease/source", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const c = incomeReportCopy(locale);
    const html = renderToStaticMarkup(<IncomeReportView session={{ ...s, locale }} input={{}} data={{ ...data, rows: [
      { ...data.rows[0], kind: "earlyRent", key: "early", serviceMonthStart: "2030-06-01", item: "EARLY-RENT" },
      { ...data.rows[0], kind: "prepayment", key: "unused", serviceMonthStart: null, item: "UNALLOCATED", amountMinor: "500" },
    ] }} />);
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    assert.ok(!table.includes("EARLY-RENT")); assert.ok(!table.includes("UNALLOCATED"));
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    for (const text of ["EARLY-RENT", "UNALLOCATED", c.earlyRentHeading, c.prepayment, c.serviceMonthHint, "lease", "payment-source"])
      assert.ok(aside.includes(text), text);
    assert.ok(html.includes(c.hint));
  }
});
