import assert from "node:assert/strict";
import test from "node:test";
import { confirmDeposit, confirmSpace, formatMajor, twdAmountsAreWhole } from "./lease-confirm";

test("the lease confirmation names the room and writes rent and deposit with units", () => {
  assert.equal(formatMajor(12000, "TWD", "zh-TW"), "$12,000");
  assert.equal(formatMajor(20000, "TWD", "en"), "$20,000");
  assert.equal(confirmSpace({ propertyName: "信義松仁", unitLabel: "3F", label: "C" }), "信義松仁 · 3F C");
  assert.equal(confirmDeposit("2", "12000", "TWD", "zh-TW"), "2 個月");
  assert.equal(confirmDeposit("2", "20000", "TWD", "zh-TW"), "2 個月");
  assert.equal(confirmDeposit("1", "1500", "USD", "en"), "1 month ($1,500.00)");
  assert.equal(confirmDeposit("2", "12000", "TWD", "en"), "2 months ($24,000)");
  assert.equal(twdAmountsAreWhole("TWD", 20000, 2), true);
  assert.equal(twdAmountsAreWhole("TWD", 20000, 1.5), true);
  assert.equal(twdAmountsAreWhole("TWD", 10000.5, 2), false);
  assert.equal(twdAmountsAreWhole("TWD", 10001, 1.5), false);
  assert.equal(twdAmountsAreWhole("USD", 10.5, 1.25), true);
});
