import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { electricityMonthLabel, moneyLabel } from "./format";
import { tenantBillDueMinor, tenantBillLines, rentUtilityDueMinor } from "./money";
import { unsignedRentNoteKey } from "./pay-note";
import { expenseDescriptionToWrite, LEGACY_VACANT_ELECTRICITY_DESCRIPTION, VACANT_ELECTRICITY_DESCRIPTION } from "./utility-expense";
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

test("an empty pending bill list is replaced by the unsigned note, and a signed lease keeps the list", () => {
  assert.equal(unsignedRentNoteKey("pending_signature", true), "i_pay_unsigned_bill");
  assert.equal(unsignedRentNoteKey("pending_signature", false), null);
  for (const status of ["active", "ended", "draft", "terminated", "cancelled"]) {
    assert.equal(unsignedRentNoteKey(status, true), null, status);
    assert.equal(unsignedRentNoteKey(status, false), null, status);
  }
  const page = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  assert.match(page, /unsignedRentNoteKey\(money\.lease\.status, billEmpty\)/);
  assert.match(page, /rentLines\.length === 0 &&/);
  assert.match(page, /depositLines\.length === 0 &&/);
  assert.match(page, /utilityLines\.length === 0 &&/);
  assert.match(page, /otherLines\.length === 0/);
  assert.match(page, /noteKey \? \([\s\S]*data-testid="unsigned-rent-note"[\s\S]*\) : \([\s\S]*data-testid="tenant-bill"/);
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_pay_unsigned_bill, "租約還沒完成簽署，租金和電費帳單會在雙方簽署後產生。");
  assert.equal(en.i_pay_unsigned_bill, "The lease is not fully signed yet. Rent and electricity bills are created after both parties sign.");
  const posting = readFileSync(new URL("./utility-posting.ts", import.meta.url), "utf8");
  assert.equal(posting.includes("pending_signature"), false);
  assert.match(posting, /AND l\.status = 'active'/);
});

test("tenant pay lists invoiced rent and electricity in NT$", () => {
  const page = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  assert.match(page, /data-testid="tenant-rent-line"/);
  assert.match(page, /data-testid="tenant-deposit-line"/);
  assert.match(page, /data-testid="tenant-utility-line"/);
  assert.match(page, /data-testid="tenant-other-line"/);
  const rentAt = page.indexOf('data-testid="tenant-rent-line"');
  const depositAt = page.indexOf('data-testid="tenant-deposit-line"');
  const utilityAt = page.indexOf('data-testid="tenant-utility-line"');
  assert.ok(rentAt < depositAt && depositAt < utilityAt);
  assert.match(page, /t\("i_charge_deposit"\)/);
  assert.match(page, /t\("i_pay_total"\)/);
  assert.match(page, /moneyLabel\(/);
  assert.doesNotMatch(page, /formatMoney\(/);
  const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  assert.match(queries, /chargeType === "rent"/);
  assert.match(queries, /chargeType === "deposit"/);
  assert.match(queries, /pending_signature/);
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_charge_deposit, "押金");
  assert.equal(zh.i_pay_total, "應繳合計");
  assert.equal(en.i_pay_total, "Amount due");
  assert.equal(zh.i_pay_hint_tenant.includes("不含押金"), false);
});

const MOVE_IN_LINES = [
  { charge_type: "rent", amount_minor: 1_200_000, description: "租金" },
  { charge_type: "deposit", amount_minor: 2_400_000, description: "押金" },
  { charge_type: "utility", amount_minor: 100_000, description: "電費 2026-10" },
];

test("a move-in bill keeps the deposit and the rows add up to the open balance", () => {
  const rows = tenantBillLines(MOVE_IN_LINES, 0);
  assert.deepEqual(
    rows.map((row) => [row.chargeType, row.amountMinor]),
    [
      ["rent", 1_200_000],
      ["deposit", 2_400_000],
      ["utility", 100_000],
    ],
  );
  assert.equal(tenantBillDueMinor(MOVE_IN_LINES, 0), 3_700_000);
  assert.equal(rows.reduce((sum, row) => sum + row.amountMinor, 0), 3_700_000);
  assert.equal(moneyLabel(3_700_000, "TWD", "zh-TW"), "NT$37,000");
  assert.equal(moneyLabel(1_200_000, "TWD", "zh-TW"), "NT$12,000");
  assert.equal(moneyLabel(2_400_000, "TWD", "zh-TW"), "NT$24,000");
  assert.equal(moneyLabel(100_000, "TWD", "zh-TW"), "NT$1,000");
  assert.equal(rentUtilityDueMinor(MOVE_IN_LINES, 0), 1_300_000);

  const rentPaid = tenantBillLines(MOVE_IN_LINES, 1_200_000);
  assert.deepEqual(
    rentPaid.map((row) => [row.chargeType, row.amountMinor]),
    [
      ["deposit", 2_400_000],
      ["utility", 100_000],
    ],
  );
  assert.equal(tenantBillDueMinor(MOVE_IN_LINES, 1_200_000), 2_500_000);

  const rentAndPowerPaid = tenantBillLines(MOVE_IN_LINES, 1_300_000);
  assert.deepEqual(rentAndPowerPaid.map((row) => [row.chargeType, row.amountMinor]), [["deposit", 2_400_000]]);
  const depositPartlyPaid = tenantBillLines(MOVE_IN_LINES, 1_400_000);
  assert.equal(depositPartlyPaid.find((row) => row.chargeType === "deposit")?.amountMinor, 2_300_000);
  assert.equal(tenantBillDueMinor(MOVE_IN_LINES, 1_400_000), 2_300_000);
});

test("a charge type that is not rent, deposit, or electricity is still a row", () => {
  const lines = [
    ...MOVE_IN_LINES,
    { charge_type: "late_fee", amount_minor: 50_000, description: "逾期費用" },
  ];
  const rows = tenantBillLines(lines, 0);
  assert.deepEqual(
    rows.map((row) => row.chargeType),
    ["rent", "deposit", "utility", "late_fee"],
  );
  assert.equal(tenantBillDueMinor(lines, 0), 3_750_000);
  assert.equal(rows.reduce((sum, row) => sum + row.amountMinor, 0), tenantBillDueMinor(lines, 0));
  const afterRent = tenantBillLines(lines, 1_200_000);
  assert.equal(afterRent.find((row) => row.chargeType === "late_fee")?.amountMinor, 50_000);
  const intoLateFee = tenantBillLines(lines, 1_220_000);
  assert.equal(intoLateFee.find((row) => row.chargeType === "late_fee")?.amountMinor, 30_000);
  assert.equal(intoLateFee.find((row) => row.chargeType === "utility")?.amountMinor, 100_000);
  assert.equal(intoLateFee.find((row) => row.chargeType === "deposit")?.amountMinor, 2_400_000);

  const withCredit = [
    ...MOVE_IN_LINES,
    { charge_type: "credit", amount_minor: -20_000, description: "折抵" },
  ];
  assert.equal(tenantBillDueMinor(withCredit, 0), 3_680_000);
  assert.equal(tenantBillLines(withCredit, 0).some((row) => row.chargeType === "credit" && row.amountMinor === -20_000), true);

  const withOffset = [
    { charge_type: "rent", amount_minor: 1_200_000, description: "租金" },
    { charge_type: "utility", amount_minor: 100_000, description: "電費 2026-10" },
    { charge_type: "credit", amount_minor: -20_000, description: "沖銷電費 2026-10" },
  ];
  const offsetRows = tenantBillLines(withOffset, 0);
  assert.equal(offsetRows.find((row) => row.chargeType === "utility")?.amountMinor, 80_000);
  assert.equal(offsetRows.some((row) => row.chargeType === "credit"), false);
  assert.equal(tenantBillDueMinor(withOffset, 0), 1_280_000);
});

test("a pending tenant home shows the unsigned note instead of the rent-due card", () => {
  const home = readFileSync(new URL("../app/t/page.tsx", import.meta.url), "utf8");
  assert.match(home, /pending_signature/);
  assert.match(home, /pendingUnsigned \? \([\s\S]*data-testid="unsigned-rent-note"[\s\S]*i_pay_unsigned_bill[\s\S]*\) : \([\s\S]*data-testid="rent-due-notice"/);
  assert.match(home, /moneyLabel\(dueMinor, currency, session\.locale\)/);
  assert.match(home, /moneyLabel\(rentMinor, currency, session\.locale\)/);
  assert.match(home, /moneyLabel\(depositMinor, currency, session\.locale\)/);
  const totalAt = home.indexOf('t("i_pay_total")');
  const rentAt = home.indexOf('data-testid="rent-due-rent"');
  const depositAt = home.indexOf('data-testid="rent-due-deposit"');
  assert.ok(totalAt >= 0 && totalAt < rentAt && rentAt < depositAt);
  assert.doesNotMatch(home, /formatMoney\(/);
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_pay_unsigned_bill, "租約還沒完成簽署，租金和電費帳單會在雙方簽署後產生。");
  assert.equal(zh.i_pay_total, "應繳合計");
  assert.equal(zh.s_23c9d54, "租金即將到期");
});

test("electricity lines are prefixed with the billing month", () => {
  assert.equal(electricityMonthLabel("2026-11-01", "電費"), "2026年11月 電費");
  assert.equal(electricityMonthLabel("2026-10-01", "電費 12 度 × 5 元"), "2026年10月 電費 12 度 × 5 元");
  assert.equal(electricityMonthLabel("2026-03-01", "電費"), "2026年3月 電費");
  assert.equal(electricityMonthLabel("2026-11-01", "2026年11月 電費"), "2026年11月 電費");
  assert.equal(electricityMonthLabel("2026-03-15", "2026年3月 電費"), "2026年3月 電費");
  assert.equal(electricityMonthLabel(null, "電費"), "電費");
  assert.equal(electricityMonthLabel("2026-00-01", "電費"), "電費");
  const pay = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  const utilities = readFileSync(new URL("../app/m/rent/utilities/page.tsx", import.meta.url), "utf8");
  assert.match(pay, /electricityMonthLabel\(line\.periodStart/);
  assert.match(utilities, /electricityMonthLabel\(detail\.run\.period_start, line\.description\)/);
  assert.match(utilities, /resultUnit\.unit_id/);
  assert.match(utilities, /units\.get\(resultUnit\.unit_id\)/);
  assert.match(utilities, /UtilityUnitSelect/);
  assert.match(utilities, /selectedId=\{selected\?\.id \?\? ""\}/);
  const unitSelect = readFileSync(new URL("../components/utility-unit-select.tsx", import.meta.url), "utf8");
  assert.match(unitSelect, /setValue\(selectedId\)/);
  assert.match(unitSelect, /\[selectedId\]/);
});

test("new vacant electricity expenses use 電費（空房／未簽約） and existing rows keep 電費（空房）", () => {
  assert.equal(VACANT_ELECTRICITY_DESCRIPTION, "電費（空房／未簽約）");
  assert.equal(LEGACY_VACANT_ELECTRICITY_DESCRIPTION, "電費（空房）");
  assert.equal(expenseDescriptionToWrite(VACANT_ELECTRICITY_DESCRIPTION, null), "電費（空房／未簽約）");
  assert.equal(expenseDescriptionToWrite(VACANT_ELECTRICITY_DESCRIPTION, "電費（空房）"), "電費（空房）");
  assert.equal(expenseDescriptionToWrite(VACANT_ELECTRICITY_DESCRIPTION, "電費（空房／未簽約）"), "電費（空房／未簽約）");
  assert.equal(expenseDescriptionToWrite("公共用電", null), "公共用電");
  assert.equal(expenseDescriptionToWrite("公共用電", "公共用電"), "公共用電");
  const source = readFileSync(new URL("./utility-expense.ts", import.meta.url), "utf8");
  assert.match(source, /LEGACY_VACANT_ELECTRICITY_DESCRIPTION/);
  assert.match(source, /expenseDescriptionToWrite\(description, existing\?\.description \?\? null\)/);
  assert.match(source, /description = ANY\(\$3::text\[\]\)/);
  const migration = readFileSync(new URL("../../supabase/migrations/20261028180000_utility_owner_lines.sql", import.meta.url), "utf8");
  assert.match(migration, /電費（空房）/);
  assert.equal(migration.includes("電費（空房／未簽約）"), false);
  assert.doesNotMatch(migration, /UPDATE\s+expenses/i);
});

test("electricity registration copy uses 登記 and does not say 入帳", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_utility_owner_vacant, "電費（空房／未簽約）");
  assert.equal(en.i_utility_owner_vacant, "Electricity (vacant / unsigned)");
  const oldVacantLabel = "屋主" + "（空房）";
  assert.equal(zh.i_utility_owner_vacant.includes(oldVacantLabel), false);
  const utilities = readFileSync(new URL("../app/m/rent/utilities/page.tsx", import.meta.url), "utf8");
  const postingE2e = readFileSync(new URL("../../e2e/utility-posting.spec.ts", import.meta.url), "utf8");
  assert.match(utilities, /t\("i_utility_owner_vacant"\)/);
  assert.equal(utilities.includes(oldVacantLabel), false);
  assert.equal(postingE2e.includes(oldVacantLabel), false);
  assert.match(postingE2e, /電費（空房／未簽約）/);
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

test("reversal and audit stay inside the caller's active organization", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261030120000_org_scoped_reversal_audit.sql", import.meta.url), "utf8");
  assert.equal(sql.includes("DROP FUNCTION"), false);
  assert.match(sql, /CREATE OR REPLACE FUNCTION post_reversal\(p_txn uuid, p_reason text\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION post_reversal\(p_txn uuid, p_reason text, p_invoice uuid\)/);
  assert.match(sql, /app\.active_org_id/);
  assert.match(sql, /app\.is_member\(t\.org_id\)/);
  assert.match(sql, /ERRCODE = '42501'/);
  assert.match(sql, /current_user IN \('authenticated', 'anon'\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /app\.reversal_target_exists\(p_txn\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.reversal_target_exists\(uuid\) FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.reversal_target_exists\(uuid\) TO authenticated, service_role/);
  assert.match(sql, /v_org := v_active::uuid/);
  assert.match(sql, /p_org IS DISTINCT FROM v_org/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /SET search_path = pg_catalog, public, pg_temp/);
  assert.match(sql, /REVOKE ALL ON FUNCTION post_reversal\(uuid, text\) FROM PUBLIC, anon/);
  assert.match(sql, /REVOKE ALL ON FUNCTION post_reversal\(uuid, text, uuid\) FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION post_reversal\(uuid, text\) TO authenticated, service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION post_reversal\(uuid, text, uuid\) TO authenticated, service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.audit_event\(uuid, text, jsonb\) FROM PUBLIC, anon, service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.audit_event\(uuid, text, jsonb\) TO authenticated/);
  assert.equal(sql.includes("入帳"), false);
  assert.equal(sql.includes("收租"), false);
  assert.equal(sql.includes("收款"), false);
  assert.equal(sql.includes("欠租"), false);
  assert.equal(sql.includes("已收"), false);
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
