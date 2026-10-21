import assert from "node:assert/strict";
import test from "node:test";
import { confirmDeposit, confirmSpace, formatMajor } from "./lease-confirm";

test("the lease confirmation names the room and writes rent and deposit with units", () => {
  assert.equal(formatMajor(20000, "TWD", "zh-TW"), "NT$20,000");
  assert.equal(confirmSpace({ propertyName: "信義松仁", unitLabel: "3F", label: "C" }), "信義松仁 · 3F C");
  assert.equal(confirmDeposit("2", "20000", "TWD", "zh-TW"), "2 個月（NT$40,000）");
  assert.equal(confirmDeposit("1", "1500", "USD", "en"), "1 month ($1,500.00)");
});
