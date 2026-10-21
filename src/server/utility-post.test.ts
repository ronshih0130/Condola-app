import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateUtilityMinor,
  billMinorCeil,
  chargedRateExceedsBill,
  isPostableMethod,
  normalizeRateMajor,
  prorateMilli,
  rateMajorFromStored,
  rateMinorText,
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

test("the rate is stored at four decimal places", () => {
  assert.equal(normalizeRateMajor(1.23456), 1.2346);
  assert.equal(rateMinorText(1.23456), "123.460000");
  assert.equal(rateMajorFromStored("123.460000"), 1.2346);
  assert.equal(utilityLineDescription(1000, normalizeRateMajor(1.23456)!), "電費 1 度 × 1.2346 元");
  assert.equal(normalizeRateMajor(0), null);
  assert.equal(normalizeRateMajor(10000.01), null);
  assert.equal(normalizeRateMajor(Number.POSITIVE_INFINITY), null);
});

test("turnover splits one reading by occupancy days", () => {
  assert.deepEqual(prorateMilli([{ key: "only", days: 3 }], 1000), [{ key: "only", kwhMilli: 1000 }]);
  const split = prorateMilli(
    [
      { key: "b", days: 1 },
      { key: "a", days: 1 },
    ],
    3,
  );
  assert.deepEqual(split, [
    { key: "b", kwhMilli: 1 },
    { key: "a", kwhMilli: 2 },
  ]);
  assert.equal(prorateMilli([{ key: "a", days: 0 }, { key: "b", days: 0 }], 10), null);
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
