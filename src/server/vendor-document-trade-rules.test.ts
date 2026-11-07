import assert from "node:assert/strict";
import test from "node:test";
import { tradeLineItems, tradeTotal } from "./vendor-document-trade-rules";
import { validateDocumentTotals } from "./vendor-receipt-rules";
const row = { name: "Work", quantity: "1", unit: "hour", unit_price_minor: "1", category: "labor" };

test("trade quantities: exact decimals and explicit per-line half-up rounding", () => {
  const cases = [["0.499999", "10", "5"], ["0.05", "10", "1"], ["2.5", "480", "1200"], ["1.000001", "1000000", "1000001"], ["1", "9007199254740993", "9007199254740993"]];
  for (const [quantity, unit_price_minor, expected] of cases) {
    const lines = tradeLineItems([{ ...row, quantity, unit_price_minor }]);
    assert.equal(lines[0].amount_minor, expected);
    assert.equal(tradeTotal(lines).toString(), expected);
  }
  const lines = tradeLineItems([{ ...row, quantity: "0.5" }, { ...row, quantity: "0.5" }]);
  assert.equal(tradeTotal(lines), BigInt(2)); // round each line, then sum
  assert.equal(validateDocumentTotals(lines, 2, 2), 2);
  assert.throws(() => validateDocumentTotals(lines, 1, 1));
  assert.throws(() => validateDocumentTotals([{ ...lines[0], amount_minor: "99" }], 99, 99));
});

test("trade quantities reject floats, exponent notation, unbounded units and overflow", () => {
  for (const quantity of [0.5, "0", "-1", "01", "1e2", ".5", "1.", "1.0000001", "9999999999999"]) assert.throws(() => tradeLineItems([{ ...row, quantity }]));
  for (const unit_price_minor of [1, "1.1", "-1", "9223372036854775808"]) assert.throws(() => tradeLineItems([{ ...row, unit_price_minor }]));
  for (const unit of ["", " ", "x".repeat(25), "a\nb"]) assert.throws(() => tradeLineItems([{ ...row, unit }]));
  assert.throws(() => tradeLineItems([{ ...row, quantity: "0.1" }]));
  assert.throws(() => tradeLineItems([{ ...row, quantity: "2", unit_price_minor: "9223372036854775807" }]));
  assert.throws(() => tradeTotal(tradeLineItems([{ ...row, unit_price_minor: "9223372036854775807" }, row])));
  assert.throws(() => tradeLineItems([]));
});
