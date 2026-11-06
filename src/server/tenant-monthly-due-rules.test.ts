import assert from "node:assert/strict";
import test from "node:test";
import { monthlyDuePeriods, type DueSourceLine } from "./tenant-monthly-due-rules";

const line = (over: Partial<DueSourceLine>): DueSourceLine => ({
  invoiceId: "i1", invoiceNumber: "INV-1", periodStart: "2028-01-01", dueOn: "2028-01-05", currency: "TWD",
  invoicePaidMinor: "0", lineNo: 1, chargeType: "rent", amountMinor: "1000000", description: null, ...over,
});

test("rent + utilities − 代墊 offset − paid = 應繳總額, each component sourced to an invoice line", () => {
  const [p] = monthlyDuePeriods([
    line({ lineNo: 1 }),
    line({ lineNo: 2, chargeType: "utility", amountMinor: "85000", description: "電費" }),
    line({ lineNo: 3, chargeType: "credit", amountMinor: "-30000", description: "代墊修繕抵扣" }),
    line({ invoicePaidMinor: "200000", lineNo: 4, chargeType: "late_fee", amountMinor: "5000" }),
  ]);
  assert.equal(p.periodYm, "2028-01");
  assert.equal(p.grossMinor, "1090000");
  assert.equal(p.offsetMinor, "30000");
  assert.equal(p.paidMinor, "200000");
  assert.equal(p.dueMinor, "860000");
  assert.equal(p.carryMinor, "0");
  assert.deepEqual(p.payments, [{ invoiceNumber: "INV-1", paidMinor: "200000" }]);
  assert.deepEqual(p.components.map((c) => c.key), ["rent", "utility", "offset", "other"]);
  assert.deepEqual(p.components[2].source, { kind: "invoice_line", invoiceNumber: "INV-1", lineNo: 3, chargeType: "credit" });
});

test("offsets larger than charges show 0 due plus carry, never a negative claim", () => {
  const [p] = monthlyDuePeriods([line({ amountMinor: "1000" }), line({ lineNo: 2, chargeType: "credit", amountMinor: "-1500" })]);
  assert.equal(p.dueMinor, "0");
  assert.equal(p.carryMinor, "500");
});

test("periods are separated by billing month and stay exact beyond 2^53", () => {
  const periods = monthlyDuePeriods([
    line({ invoiceId: "a", invoiceNumber: "A", amountMinor: "9007199254740993" }),
    line({ invoiceId: "b", invoiceNumber: "B", periodStart: null, dueOn: "2028-02-05", amountMinor: "7" }),
  ]);
  assert.deepEqual(periods.map((p) => [p.periodYm, p.dueMinor]), [["2028-01", "9007199254740993"], ["2028-02", "7"]]);
});

test("rejects non-integer amounts and mixed currencies", () => {
  assert.throws(() => monthlyDuePeriods([line({ amountMinor: "10.5" })]));
  assert.throws(() => monthlyDuePeriods([line({}), line({ lineNo: 2, currency: "USD" })]));
});

test("confirmed payments keep their per-invoice source", () => {
  const [p] = monthlyDuePeriods([
    line({ invoiceId: "a", invoiceNumber: "A", invoicePaidMinor: "100" }),
    line({ invoiceId: "b", invoiceNumber: "B", invoicePaidMinor: "200", lineNo: 1 }),
  ]);
  assert.equal(p.paidMinor, "300");
  assert.deepEqual(p.payments, [{ invoiceNumber: "A", paidMinor: "100" }, { invoiceNumber: "B", paidMinor: "200" }]);
});
