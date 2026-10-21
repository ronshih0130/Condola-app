import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import {
  APPROVABLE_EXPENSE_STATUSES,
  STATEMENT_EXPENSE_SQL,
  STATEMENT_EXPENSE_STATUSES,
  expenseCanBeApproved,
  expenseCountsOnStatement,
  majorInput,
  monthIsClosed,
  normalizeExpense,
  parseAmountMajor,
} from "./expenses";

test("owner statements include only approved and posted expenses billed to the owner", () => {
  for (const status of ["draft", "submitted", "approved", "rejected", "posted", "void"]) {
    const counts = expenseCountsOnStatement(status, "owner");
    assert.equal(counts, (STATEMENT_EXPENSE_STATUSES as readonly string[]).includes(status));
    assert.equal(STATEMENT_EXPENSE_SQL.includes(`'${status}'`), counts);
    assert.equal(expenseCountsOnStatement(status, "tenant"), false);
    assert.equal(expenseCountsOnStatement(status, "manager"), false);
  }
  assert.equal(STATEMENT_EXPENSE_SQL, "status IN ('approved','posted') AND bill_to = 'owner'");
});

test("the statement query uses the shared status predicate", () => {
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  assert.match(domain, /\$\{STATEMENT_EXPENSE_SQL\}/);
  assert.doesNotMatch(domain, /status IN \('approved','posted'\)/);
  const migration = readFileSync(new URL("../../supabase/migrations/20261023160000_expense_statement_index.sql", import.meta.url), "utf8");
  assert.match(migration, /-- Version 20261023160000\./);
  assert.ok(migration.includes(STATEMENT_EXPENSE_SQL));
  assert.match(migration, /fn_expense_locks/);
  assert.match(migration, /month is closed/);
  assert.match(migration, /expense is on an issued statement/);
  assert.match(migration, /timezone\('Asia\/Taipei', now\(\)\)/);
  assert.doesNotMatch(migration, /current_date/);
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(names.some((name) => name.startsWith("20261023100000")), false);
  const expense = names.find((name) => name.startsWith("20261023160000"));
  const prior = names.filter((name) => name < (expense ?? ""));
  assert.ok(prior.some((name) => name.startsWith("20261023090000")));
});

test("a closed month blocks that month and every earlier one", () => {
  assert.equal(monthIsClosed("2026-03-15", null), false);
  assert.equal(monthIsClosed("2026-03-15", "2026-03-01"), true);
  assert.equal(monthIsClosed("2026-01-01", "2026-03-01"), true);
  assert.equal(monthIsClosed("2026-04-01", "2026-03-01"), false);
});

test("expense amounts and dates are checked before they are saved", () => {
  assert.equal(parseAmountMajor("1,500"), 1500);
  assert.equal(parseAmountMajor(" 1500.5 "), 1500.5);
  assert.equal(Number.isNaN(parseAmountMajor("1e5")), true);
  assert.equal(Number.isNaN(parseAmountMajor("0x10")), true);
  assert.equal(Number.isNaN(parseAmountMajor("-5")), true);
  assert.equal(majorInput(280000), "2800");
  assert.equal(majorInput(150050), "1500.50");
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const saved = normalizeExpense({
    propertyId,
    category: "cleaning",
    amountMajor: 1500,
    incurredOn: "2099-06-15",
    vendorName: "  老張水電  ",
    description: " 水管 ",
    receiptName: "",
  });
  assert.equal(saved.amount, 150000);
  assert.equal(saved.vendorName, "老張水電");
  assert.equal(saved.description, "水管");
  assert.equal(saved.receiptName, "");
  assert.equal(saved.incurredOn, "2099-06-15");
  assert.throws(() => normalizeExpense({ propertyId, category: "nope", amountMajor: 1, incurredOn: "2099-06-15" }), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.required");
    return true;
  });
  assert.throws(() => normalizeExpense({ propertyId, category: "repair", amountMajor: 0, incurredOn: "2099-06-15" }), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.expenseAmount");
    return true;
  });
  assert.throws(
    () => normalizeExpense({ propertyId, category: "repair", amountMajor: parseAmountMajor("1e5"), incurredOn: "2099-06-15" }),
    (error: unknown) => {
      assert.ok(error instanceof FlowError);
      assert.equal(error.key, "errors.expenseAmount");
      return true;
    },
  );
  const kept = normalizeExpense(
    { propertyId, category: "custom_trade", amountMajor: 10, incurredOn: "2099-06-15" },
    "custom_trade",
  );
  assert.equal(kept.category, "custom_trade");
});

test("approving a draft posts it and leaves the repair ticket link alone", () => {
  assert.deepEqual(APPROVABLE_EXPENSE_STATUSES, ["draft", "submitted", "rejected"]);
  assert.equal(expenseCanBeApproved("draft"), true);
  assert.equal(expenseCanBeApproved("submitted"), true);
  assert.equal(expenseCanBeApproved("rejected"), true);
  assert.equal(expenseCanBeApproved("approved"), false);
  assert.equal(expenseCanBeApproved("posted"), false);
  assert.equal(expenseCanBeApproved("void"), false);
  const src = readFileSync(new URL("./expenses.ts", import.meta.url), "utf8");
  const load = src.slice(src.indexOf("async function loadStored"), src.indexOf("export async function updateExpense"));
  const approve = src.slice(src.indexOf("export async function approveExpense"), src.indexOf("export async function addExpense"));
  const update = src.slice(src.indexOf("export async function updateExpense"), src.indexOf("export async function voidExpense"));
  const voided = src.slice(src.indexOf("export async function voidExpense"), src.indexOf("async function releaseRepairLink"));
  assert.match(load, /FOR UPDATE/);
  assert.match(approve, /loadStored/);
  assert.match(update, /loadStored/);
  assert.match(voided, /loadStored/);
  assert.match(approve, /status = 'posted'/);
  assert.match(approve, /current\.bill_to === "owner"/);
  assert.match(update, /current\.bill_to === "owner"/);
  assert.match(voided, /current\.bill_to === "owner"/);
  assert.match(voided, /ticket_id = NULL/);
  assert.doesNotMatch(approve, /ticket_id\s*=/);
  assert.doesNotMatch(update, /ticket_id\s*=/);
  const page = readFileSync(new URL("../app/m/expenses/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /expense-approve/);
  assert.match(page, /expenseCanBeApproved/);
  assert.match(page, /expense-ticket/);
  assert.match(page, /editable && !row\.on_issued/);
  const zh = readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8");
  assert.match(zh, /也不能作廢/);
  assert.doesNotMatch(zh, /作廢後再建/);
});
