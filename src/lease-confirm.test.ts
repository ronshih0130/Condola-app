import assert from "node:assert/strict";
import test from "node:test";
import { confirmDeposit, confirmSpace, depositAmountMinor, depositMonthsOnHalfStep, formatMajor, twdRentIsWhole } from "./lease-confirm";

test("the lease confirmation names the room and writes rent and deposit with units", () => {
  assert.equal(formatMajor(12000, "TWD", "zh-TW"), "$12,000");
  assert.equal(formatMajor(20000, "TWD", "en"), "$20,000");
  assert.equal(confirmSpace({ propertyName: "信義松仁", unitLabel: "3F", label: "C" }), "信義松仁 · 3F C");
  assert.equal(confirmDeposit("1.5", "12000", "TWD", "zh-TW"), "1.5 個月（$18,000）");
  assert.equal(confirmDeposit("2", "12000", "TWD", "zh-TW"), "2 個月（$24,000）");
  assert.equal(confirmDeposit("1", "1500", "USD", "en"), "1 month ($1,500.00)");
  assert.equal(confirmDeposit("2", "12000", "TWD", "en"), "2 months ($24,000)");
  assert.equal(twdRentIsWhole("TWD", 20000), true);
  assert.equal(twdRentIsWhole("TWD", 10000.5), false);
  assert.equal(twdRentIsWhole("USD", 10.5), true);
  assert.equal(depositMonthsOnHalfStep(0), true);
  assert.equal(depositMonthsOnHalfStep(0.5), true);
  assert.equal(depositMonthsOnHalfStep(1.5), true);
  assert.equal(depositMonthsOnHalfStep(2), true);
  assert.equal(depositMonthsOnHalfStep(2.5), true);
  assert.equal(depositMonthsOnHalfStep(1.3), false);
  assert.equal(depositMonthsOnHalfStep(1.25), false);
  assert.equal(depositMonthsOnHalfStep(-0.5), false);
  assert.equal(depositAmountMinor("TWD", 12000, 1.5), 1_800_000);
  assert.equal(depositAmountMinor("TWD", 10001, 1.5), 1_500_200);
  assert.equal(depositAmountMinor("TWD", 12000, 0), 0);
});
