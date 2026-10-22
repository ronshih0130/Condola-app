import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allocateUtilityMinor,
  billAverageBelowRate,
  billGapExceedsWarning,
  billGapMinor,
  billMinorCeil,
  chargedRateExceedsBill,
  evenBillUsageMilli,
  evenSplitMinor,
  isPostableMethod,
  meterUsageKwh,
  normalizeRateMajor,
  prorateMilli,
  publicKwhMilli,
  rateMajorFromStored,
  rateMinorText,
  signedUsageAmountMinor,
  spreadCommonMilli,
  usageMilliFromText,
  utilityLineDescription,
} from "./utility-post";

test("tenant pay lists invoiced rent and electricity in NT$", () => {
  const page = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  assert.match(page, /data-testid="tenant-rent-line"/);
  assert.match(page, /data-testid="tenant-utility-line"/);
  assert.match(page, /moneyLabel\(/);
  assert.doesNotMatch(page, /formatMoney\(/);
  const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  assert.match(queries, /charge_type === "rent"/);
  assert.match(queries, /pending_signature/);
});

test("electricity registration copy uses 登記 and does not say 入帳", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_utility_open, "電費登記");
  assert.equal(zh.i_utility_title, "電費登記");
  assert.equal(zh.i_utility_confirm, "確認登記電費");
  assert.equal(zh.i_utility_posted, "電費已登記");
  assert.equal(zh.i_utility_repost, "這個月的電費已登記過");
  assert.equal(zh.i_utility_pending, "待重新登記");
  assert.equal(zh.i_utility_posted_locked, "這期電費已登記，新租約不會改動金額");
  assert.equal(zh.i_pay_hint, "預設帶入未結租金與已登記電費，不含押金。押金仍列在帳單上，由屋主保管。");
  assert.equal(zh.owner_owes_reason, "本月代墊費用與代管費（{cost}）高於已繳租金（{rent}），差額請屋主補繳，或依委託約定從下期租金扣抵。");
  const keys = Object.keys(zh).filter((key) => key.startsWith("i_utility_") || key === "i_even_sample" || key === "i_meter_sample");
  for (const key of keys) assert.equal(zh[key].includes("入帳"), false, key);
});

test("分表, 依電表度數, and 平均分攤 are posted", () => {
  assert.equal(isPostableMethod("submeter"), true);
  assert.equal(isPostableMethod("by_reading"), true);
  assert.equal(isPostableMethod("even"), true);
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

test("current minus previous is the room usage", () => {
  assert.equal(meterUsageKwh(1200, 1250), 50);
  assert.equal(meterUsageKwh(0, 0), 0);
  assert.equal(meterUsageKwh(10.25, 10.5), 0.25);
  assert.equal(Number.isNaN(meterUsageKwh(80, 79)), true);
  assert.equal(Number.isNaN(meterUsageKwh(Number.NaN, 10)), true);
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

test("the electricity migration fails closed on posted duplicates and unknown methods", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261028130000_utility_charge_posting.sql", import.meta.url), "utf8");
  assert.equal(sql.includes("SET electricity_method = NULL"), false);
  assert.match(sql, /cannot merge allocation runs: a meter period has more than one approved or posted run/);
  assert.match(sql, /cannot merge meters: an approved or posted allocation run would have to be voided/);
  assert.match(sql, /AND r\.status = 'draft'/);
  assert.match(sql, /ADD VALUE IF NOT EXISTS 'pending_repost'/);
  assert.match(sql, /owner_statement_id/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION post_reversal\(p_txn uuid, p_reason text, p_invoice uuid\)/);
  assert.equal(sql.includes("p_invoice uuid DEFAULT"), false);
  assert.equal(sql.includes("DROP FUNCTION IF EXISTS post_reversal(uuid, text)"), false);
  assert.equal(sql.includes("\nCREATE FUNCTION post_reversal"), false);
  const postedLineDrop = sql.indexOf("DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_line_fk");
  const orgUniqDrop = sql.indexOf("DROP CONSTRAINT IF EXISTS invoice_lines_org_uniq");
  assert.ok(postedLineDrop >= 0 && orgUniqDrop > postedLineDrop);
  assert.match(sql, /utility_allocation_runs_unit_period_excl/);
  assert.match(sql, /daterange\(period_start, period_end, '\[\]'\)/);
  assert.match(sql, /DROP TABLE IF EXISTS utility_meter_dupes/);
  assert.match(sql, /posted audit already recorded for this run/);
  assert.match(sql, /reposted audit already recorded for this run/);
  assert.match(sql, /a\.occurred_at >= v_computed/);
  assert.match(sql, /COALESCE\(p_invoice, invoice_id\)/);
  assert.equal(sql.includes("osl.ledger_transaction_id = i.ledger_transaction_id"), false);
  assert.match(sql, /k\.key NOT IN \('runId', 'lines', 'reversed'\)/);
  const posting = readFileSync(new URL("./utility-posting.ts", import.meta.url), "utf8");
  const moveIn = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  const numbers = readFileSync(new URL("./invoice-number.ts", import.meta.url), "utf8");
  assert.match(posting, /reserveInvoiceNumbers/);
  assert.match(moveIn, /nextInvoiceNumber/);
  assert.match(numbers, /::bigint/);
  assert.match(posting, /period_start <= \$4::date AND r\.period_end >= \$3::date/);
  assert.match(posting, /jsonb_to_recordset/);
  assert.equal(posting.includes("readingBySpace.get(space.space_id) ?? 0"), false);
  assert.equal(posting.includes("osl.ledger_transaction_id"), false);
  assertAllocationRunWritesUnitId(posting);
  assertAllocationRunWritesUnitId(moveIn);
});

test("a missing allocation unit is filled from the meter before the rate-cap trigger", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/20261028140000_utility_runs_unit_id_default.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.utility_runs_fill_unit_id\(\)/);
  assert.match(sql, /IF NEW\.unit_id IS NULL/);
  assert.match(sql, /FROM meters m/);
  assert.match(sql, /WHERE m\.id = NEW\.meter_id/);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_utility_runs_fill_unit_id ON utility_allocation_runs/);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_a_fill_unit_id ON utility_allocation_runs/);
  assert.match(sql, /CREATE TRIGGER trg_a_fill_unit_id/);
  assert.match(sql, /BEFORE INSERT ON utility_allocation_runs/);
  assert.match(sql, /EXECUTE FUNCTION public\.utility_runs_fill_unit_id\(\)/);
  assert.equal(sql.includes("CREATE TRIGGER trg_utility_runs_fill_unit_id"), false);
  assert.ok("trg_a_fill_unit_id" < "trg_allocation_rate_cap");
  assert.ok("trg_allocation_rate_cap" < "trg_b_reuse_open_period");
});

test("an older draft insert reuses the open period without relaxing the unique index", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/20261028160000_utility_run_draft_reuse.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.utility_runs_reuse_open_period\(\)/);
  assert.match(sql, /CREATE TRIGGER trg_b_reuse_open_period/);
  assert.match(sql, /BEFORE INSERT ON utility_allocation_runs/);
  assert.match(sql, /status <> 'void'/);
  assert.match(sql, /NEW\.status := 'void'/);
  assert.match(sql, /post_reversal\(ledger_id, '作廢空房電費'\)/);
  assert.equal(sql.includes("DROP INDEX"), false);
  assert.equal(sql.includes("DROP CONSTRAINT"), false);
  assert.equal(sql.includes("status IN ('approved'"), false);
});

function assertAllocationRunWritesUnitId(source: string) {
  const writes = source.match(/INSERT INTO utility_allocation_runs \([\s\S]*?\)\s*VALUES|UPDATE utility_allocation_runs SET[\s\S]*?WHERE id = \$1/g);
  assert.ok(writes && writes.length > 0);
  for (const write of writes) assert.match(write, /\bunit_id\b/);
}

test("the synthetic bill average is at least the charged rate", () => {
  const milli = 151000;
  const rate = 4;
  const bill = billMinorCeil(milli, rate);
  assert.equal(bill, 60400);
  assert.equal(chargedRateExceedsBill(milli, rate, bill), false);
  assert.equal(chargedRateExceedsBill(milli, rate, bill - 1), true);
  assert.equal(billMinorCeil(0, rate), 0);
});

test("公共用電 is total kWh minus room meters and stays with the owner amount", () => {
  assert.equal(publicKwhMilli(600000, 570000), 30000);
  assert.equal(publicKwhMilli(600000, 640000), -40000);
  assert.equal(signedUsageAmountMinor("TWD", 5, 30000), 15000);
  assert.equal(signedUsageAmountMinor("TWD", 5, -40000), -20000);
});

test("電費（帳單差額） is bill minus rate × total kWh and warns above 5%", () => {
  const bill = 300000;
  const matched = billGapMinor("TWD", 5, 600000, bill);
  assert.equal(matched, 0);
  assert.equal(billGapExceedsWarning(bill, matched), false);
  const higher = billGapMinor("TWD", 5, 500000, bill);
  assert.equal(higher, 50000);
  assert.equal(billGapExceedsWarning(bill, higher), true);
  const lower = billGapMinor("TWD", 5, 700000, bill);
  assert.equal(lower, -50000);
  assert.equal(billGapExceedsWarning(bill, lower), true);
});

test("平均分攤 divides the bill across every room and leaves the remainder", () => {
  assert.deepEqual(evenSplitMinor("TWD", 300000, 3), { shareMinor: 100000, remainderMinor: 0 });
  assert.deepEqual(evenSplitMinor("TWD", 100000, 3), { shareMinor: 33300, remainderMinor: 100 });
  assert.equal(evenSplitMinor("TWD", 100, 0), null);
});

test("a blank even-split total still stores a positive bill usage at least the rate", () => {
  assert.equal(evenBillUsageMilli(300000, 5), 600000);
  assert.equal(billAverageBelowRate(300000, 600000, 5), false);
  assert.equal(evenBillUsageMilli(0, 5), 1);
  assert.equal(billAverageBelowRate(0, 1, 5), true);
});
