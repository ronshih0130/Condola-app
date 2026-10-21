import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import { STATEMENT_EXPENSE_SQL } from "./expenses";
import { reportCsv, reportPeriod, type ReportRow } from "./income-expense";

const labels = {
  property: "物件",
  owner: "屋主",
  currency: "幣別",
  income: "收入",
  expense: "支出",
  net: "淨額",
  total: "合計",
};

test("a month fills the calendar, and a custom range needs both dates", () => {
  const month = reportPeriod({ mode: "month", month: "2026-02" }, "2026-10-21");
  assert.deepEqual(month, { mode: "month", month: "2026-02", start: "2026-02-01", end: "2026-02-28" });
  const current = reportPeriod({}, "2026-10-21");
  assert.equal(current.month, "2026-10");
  assert.equal(current.start, "2026-10-01");
  assert.equal(current.end, "2026-10-31");
  const range = reportPeriod({ mode: "range", from: "2026-01-03", to: "2026-11-02" }, "2026-10-21");
  assert.equal(range.start, "2026-01-03");
  assert.equal(range.end, "2026-11-02");
  assert.throws(() => reportPeriod({ mode: "range", from: "2026-05-01", to: "" }), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.reportRange");
    return true;
  });
  assert.throws(() => reportPeriod({ mode: "range", from: "2026-05-02", to: "2026-05-01" }), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.reportRange");
    return true;
  });
});

test("csv quotes fields and keeps the totals the query already returned", () => {
  const rows: ReportRow[] = [
    {
      property_id: "10000000-0000-4000-8000-000000000001",
      property_name: '信義, "松仁"',
      owner_name: "陳建宏",
      currency: "TWD",
      income_minor: "1000000",
      expense_minor: "280000",
      net_minor: "720000",
    },
  ];
  const csv = reportCsv(rows, labels);
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /"信義, ""松仁"""/);
  assert.match(csv, /"10000.00"/);
  assert.match(csv, /"2800.00"/);
  assert.match(csv, /"7200.00"/);
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
  assert.equal(lines.length, 2);
  const withTotal = reportCsv(
    [
      ...rows,
      {
        property_id: null,
        property_name: null,
        owner_name: null,
        currency: "TWD",
        income_minor: "1000000",
        expense_minor: "280000",
        net_minor: "720000",
      },
    ],
    labels,
  );
  assert.match(withTotal, /"合計"/);
  assert.equal(withTotal.replace(/^\uFEFF/, "").trim().split("\n").length, 3);
});

test("the report migration is SQL, shares the statement predicate, and sorts after the expense migration", () => {
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const reportName = names.find((name) => name.startsWith("20261023170000"));
  assert.ok(reportName);
  assert.ok(reportName > "20261023160000");
  assert.ok(reportName > "20261023090000");
  const sql = readFileSync(new URL(`../../supabase/migrations/${reportName}`, import.meta.url), "utf8");
  assert.match(sql, /-- Version 20261023170000\./);
  assert.ok(sql.includes(STATEMENT_EXPENSE_SQL));
  assert.match(sql, /SECURITY INVOKER/);
  const src = readFileSync(new URL("./income-expense.ts", import.meta.url), "utf8");
  assert.match(src, /app\.income_expense_report/);
  assert.equal(src.includes("attributePayment"), false);
  assert.equal(src.includes(".reduce("), false);
});
