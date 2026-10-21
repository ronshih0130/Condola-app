import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateUtilityMinor,
  billMinorCeil,
  chargedRateExceedsBill,
  isPostableMethod,
  spreadCommonMilli,
  usageMilliFromText,
  utilityLineDescription,
} from "./utility-post";

test("only 分表 and 依電表度數 are posted", () => {
  assert.equal(isPostableMethod("submeter"), true);
  assert.equal(isPostableMethod("by_reading"), true);
  assert.equal(isPostableMethod("shared"), false);
  assert.equal(isPostableMethod("tenant_direct"), false);
  assert.equal(isPostableMethod(null), false);
  assert.equal(isPostableMethod(""), false);
});

test("kWh text keeps three decimal places", () => {
  assert.equal(usageMilliFromText("100.333"), 100333);
  assert.equal(usageMilliFromText("100"), 100000);
  assert.equal(usageMilliFromText("0.001"), 1);
  assert.equal(usageMilliFromText("100.3339"), 100334);
  assert.equal(Number.isNaN(usageMilliFromText("nope")), true);
});

test("common-area kWh splits evenly and the leftover milli goes to the first key", () => {
  const spread = spreadCommonMilli(
    [
      { key: "b", kwhMilli: 1000 },
      { key: "a", kwhMilli: 1000 },
    ],
    3001,
  );
  assert.deepEqual(spread, [
    { key: "b", kwhMilli: 1500 },
    { key: "a", kwhMilli: 1501 },
  ]);
  assert.equal(spreadCommonMilli([{ key: "a", kwhMilli: 5 }], 4), null);
  assert.equal(spreadCommonMilli([], 1), null);
});

test("分表 rounds the unit total half-up and gives leftover NT$1 by largest fraction, then key", () => {
  const tied = allocateUtilityMinor({
    currency: "TWD",
    rateMajor: 1.3333,
    mode: "split",
    parts: [
      { key: "b", kwhMilli: 1000 },
      { key: "a", kwhMilli: 1000 },
    ],
  });
  assert.deepEqual(
    tied.map((row) => [row.key, row.amountMinor]),
    [
      ["b", 100],
      ["a", 200],
    ],
  );
  assert.equal(
    tied.reduce((sum, row) => sum + row.amountMinor, 0) % 100,
    0,
  );
  const again = allocateUtilityMinor({
    currency: "TWD",
    rateMajor: 1.3333,
    mode: "split",
    parts: [
      { key: "b", kwhMilli: 1000 },
      { key: "a", kwhMilli: 1000 },
    ],
  });
  assert.deepEqual(again, tied);

  const exact = allocateUtilityMinor({
    currency: "TWD",
    rateMajor: 4,
    mode: "split",
    parts: [
      { key: "A", kwhMilli: 100000 },
      { key: "B", kwhMilli: 50000 },
    ],
  });
  assert.deepEqual(
    exact.map((row) => row.amountMinor),
    [40000, 20000],
  );
});

test("依電表度數 rounds each meter on its own", () => {
  const each = allocateUtilityMinor({
    currency: "TWD",
    rateMajor: 1.5,
    mode: "each",
    parts: [
      { key: "A", kwhMilli: 1000 },
      { key: "B", kwhMilli: 1000 },
    ],
  });
  assert.deepEqual(
    each.map((row) => row.amountMinor),
    [200, 200],
  );
  const split = allocateUtilityMinor({
    currency: "TWD",
    rateMajor: 1.5,
    mode: "split",
    parts: [
      { key: "A", kwhMilli: 1000 },
      { key: "B", kwhMilli: 1000 },
    ],
  });
  assert.equal(
    split.reduce((sum, row) => sum + row.amountMinor, 0),
    300,
  );
});

test("other currencies round to cents", () => {
  const rows = allocateUtilityMinor({
    currency: "USD",
    rateMajor: 0.15,
    mode: "each",
    parts: [{ key: "A", kwhMilli: 1000 }],
  });
  assert.equal(rows[0]?.amountMinor, 15);
});

test("the invoice line names the kWh and the rate in Traditional Chinese", () => {
  assert.equal(utilityLineDescription(100500, 4.5), "電費 100.5 度 × 4.5 元");
  assert.equal(utilityLineDescription(100000, 4), "電費 100 度 × 4 元");
});

test("the synthetic bill average is at least the charged rate", () => {
  const milli = 151000;
  const rate = 4;
  const bill = billMinorCeil(milli, rate);
  assert.equal(bill, 60400);
  assert.equal(chargedRateExceedsBill(milli, rate, bill), false);
  assert.equal(chargedRateExceedsBill(milli, rate, bill - 1), true);
  assert.equal(billMinorCeil(0, rate), 0);
});
