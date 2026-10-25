import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { signedMoneyLabel } from "./format";
import {
  attributeMinor,
  defaultPaidOn,
  inCivilMonth,
  instantSettlementMonth,
  managementFeeExact,
  minorToAmountText,
  monthWindow,
  civilPeriodLabel,
  closingBalance,
  dueDayAllowed,
  parseAmountToMinor,
  parseCivilDate,
  previousPeriod,
  projectMonth,
  rentPeriodLabel,
  rentSettlementEnabled,
  settlementCsv,
  taipeiCalendarDate,
  type FeeRuleExact,
} from "./rent-settlement-math";

const PERCENT_8: FeeRuleExact = {
  kind: "percent",
  hybridMode: null,
  percentBp: BigInt(800),
  fixedMinor: BigInt(0),
  minimumMinor: BigInt(0),
};

const BANNED = ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司"];

test("the flag is on only for the sample company and beta orgs", () => {
  assert.equal(rentSettlementEnabled({ environment: "sandbox", planTier: "free", featureFlags: { rent_settlement: true } }), true);
  assert.equal(rentSettlementEnabled({ environment: "live", planTier: "beta", featureFlags: { rent_settlement: true } }), true);
  assert.equal(rentSettlementEnabled({ environment: "live", planTier: "free", featureFlags: { rent_settlement: true } }), false);
  assert.equal(rentSettlementEnabled({ environment: "live", planTier: "pro", featureFlags: { rent_settlement: true } }), false);
  assert.equal(rentSettlementEnabled({ environment: "live", planTier: "business", featureFlags: { rent_settlement: true } }), false);
  assert.equal(rentSettlementEnabled({ environment: "sandbox", planTier: "beta", featureFlags: {} }), false);
  assert.equal(rentSettlementEnabled({ environment: "live", planTier: "beta", featureFlags: { rent_settlement: false } }), false);
  assert.equal(rentSettlementEnabled({ environment: "sandbox", planTier: "free", featureFlags: { rent_settlement: "true" } }), false);
});

test("sample company creation and the beta seed store the flag", () => {
  const sandbox = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");
  const seed = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");
  assert.match(sandbox, /rent_settlement": true/);
  assert.match(seed, /rent_settlement": true/);
  const migration = readFileSync(new URL("../../supabase/migrations/20261030160000_rent_settlement.sql", import.meta.url), "utf8");
  assert.match(migration, /-- Version 20261030160000\./);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /app\.is_member\(org_id\)/);
  assert.match(migration, /feature_flags ->> 'rent_settlement'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS payment_corrections/);
  assert.match(migration, /DROP POLICY IF EXISTS/);
  assert.match(migration, /DROP TRIGGER IF EXISTS/);
  assert.doesNotMatch(migration, /ALTER TABLE (?!payment_corrections\b)/);
  assert.doesNotMatch(migration, /ALTER TABLE payment_corrections[\s\S]*NOT NULL/);
  assert.equal(existsSync(new URL("../../supabase/migrations/20261029120000_rent_settlement.sql", import.meta.url)), false);
});

test("payment rules migration is additive and sorts after the release privilege files", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const rent = "20261030160000_rent_settlement.sql";
  const rulesName = "20261030170000_payment_settlement_rules.sql";
  const releaseTail = "20261030150000_revoke_id_photo_lease_close_execute.sql";
  assert.equal(names.includes(rent), true);
  assert.equal(names.includes(rulesName), true);
  assert.equal(names.includes("20261029180000_rent_settlement.sql"), false);
  assert.equal(names.includes("20261029190000_payment_settlement_rules.sql"), false);
  assert.equal(names.includes("20261029120000_rent_settlement.sql"), false);
  assert.equal(names.includes("20261029130000_payment_settlement_rules.sql"), false);
  assert.equal(names.includes("20261030140000_rent_settlement.sql"), false);
  assert.equal(names.includes("20261030140000_payment_settlement_rules.sql"), false);
  assert.deepEqual(
    names.filter((name) => name > releaseTail),
    [rent, rulesName],
  );
  const rules = readFileSync(new URL(rulesName, dir), "utf8");
  assert.match(rules, /-- Version 20261030170000\./);
  assert.match(rules, /ADD COLUMN IF NOT EXISTS/);
  assert.match(rules, /CREATE TABLE IF NOT EXISTS statement_change_log/);
  assert.match(rules, /CREATE TABLE IF NOT EXISTS owner_payouts/);
  assert.match(rules, /DROP POLICY IF EXISTS/);
  assert.match(rules, /DROP TRIGGER IF EXISTS/);
  assert.doesNotMatch(rules, /ADD COLUMN (?!IF NOT EXISTS)/);
  assert.doesNotMatch(rules, /ALTER TABLE (payments|owner_statements|properties|leases)[^;]*NOT NULL/);
  assert.doesNotMatch(rules, /ADD CONSTRAINT/);
  assert.doesNotMatch(rules, /SECURITY DEFINER/);
  assert.doesNotMatch(rules, /fn_invoice_recalc|fn_invoice_lines_changed|fn_payment_status_changed|fn_id_photo_drop_wm|fn_lease_close_end_date/);
  assert.doesNotMatch(rules, /GRANT\s+(?:ALL|EXECUTE)[^;]*\b(?:PUBLIC|anon)\b/);
  const rentSql = readFileSync(new URL(rent, dir), "utf8");
  assert.doesNotMatch(rentSql, /CREATE (?:OR REPLACE )?FUNCTION/);
  assert.doesNotMatch(rentSql, /ALTER TABLE (?!payment_corrections\b)/);
  const blocks = [...rules.matchAll(/CREATE OR REPLACE FUNCTION [\s\S]*?(?=CREATE OR REPLACE FUNCTION |$)/g)].map((match) => match[0]);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.match(block, /REVOKE EXECUTE ON FUNCTION post_reversal\([\s\S]*FROM PUBLIC, anon;/);
    assert.match(block, /GRANT EXECUTE ON FUNCTION post_reversal\([\s\S]*TO authenticated, service_role;/);
    assert.match(block, /app\.reversal_target_exists\(p_txn\)/);
    assert.match(block, /app\.is_member\(t\.org_id\)/);
    assert.match(block, /app\.active_org_id/);
    assert.match(block, /ERRCODE = '42501'/);
    assert.match(block, /transaction org mismatch/);
    assert.match(block, /SET search_path = pg_catalog, public, pg_temp/);
    assert.doesNotMatch(block, /SECURITY DEFINER/);
  }
});

test("after every migration in order, post_reversal stays the org-scoped body and anon stays closed", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ordered = names.map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
  const twoArg = [...ordered.matchAll(/CREATE OR REPLACE FUNCTION post_reversal\(p_txn uuid, p_reason text\)/g)];
  const threeArg = [...ordered.matchAll(/CREATE OR REPLACE FUNCTION post_reversal\(p_txn uuid, p_reason text, p_invoice uuid\)/g)];
  assert.ok(twoArg.length >= 1);
  assert.ok(threeArg.length >= 1);
  const lastTwo = ordered.slice(twoArg[twoArg.length - 1].index ?? 0);
  const lastThree = ordered.slice(threeArg[threeArg.length - 1].index ?? 0);
  for (const body of [lastTwo, lastThree]) {
    assert.match(body, /app\.reversal_target_exists\(p_txn\)/);
    assert.match(body, /app\.is_member\(t\.org_id\)/);
    assert.match(body, /current_setting\('app\.active_org_id', true\)/);
    assert.match(body, /ERRCODE = '42501'/);
    assert.doesNotMatch(body.slice(0, body.indexOf("END $$;")), /SECURITY DEFINER/);
  }
  assert.match(lastTwo, /REVOKE EXECUTE ON FUNCTION post_reversal\(uuid, text\) FROM PUBLIC, anon;/);
  assert.match(lastTwo, /GRANT EXECUTE ON FUNCTION post_reversal\(uuid, text\) TO authenticated, service_role;/);
  assert.match(lastThree, /REVOKE EXECUTE ON FUNCTION post_reversal\(uuid, text, uuid\) FROM PUBLIC, anon;/);
  assert.match(lastThree, /GRANT EXECUTE ON FUNCTION post_reversal\(uuid, text, uuid\) TO authenticated, service_role;/);
  const check = readFileSync(new URL("../../e2e-evidence/pr52/post-reversal-after-migrations.sql", import.meta.url), "utf8");
  assert.match(check, /anon executable public functions/);
  assert.match(check, /anon_count <> 0/);
  assert.match(check, /has_function_privilege\('anon'/);
  assert.match(check, /SET LOCAL ROLE authenticated/);
  assert.match(check, /PERFORM post_reversal\(txn, 'cross-org check'\)/);
  assert.match(check, /PERFORM post_reversal\(txn, 'cross-org check', NULL::uuid\)/);
  assert.match(check, /SQLSTATE <> '42501'/);
  assert.match(check, /org mismatch/);
  assert.match(check, /ROLLBACK;/);
});

test("TWD amounts are whole NT$ minor units, with no float parsing", () => {
  assert.equal(parseAmountToMinor("4000", "TWD"), BigInt(400_000));
  assert.equal(parseAmountToMinor("4,000", "TWD"), BigInt(400_000));
  assert.equal(parseAmountToMinor("NT$4000", " TWD "), BigInt(400_000));
  assert.equal(parseAmountToMinor("0", "TWD"), null);
  assert.equal(parseAmountToMinor("12.5", "TWD"), null);
  assert.equal(parseAmountToMinor("4000.00", "TWD"), null);
  assert.equal(parseAmountToMinor("1e3", "TWD"), null);
  assert.equal(parseAmountToMinor("", "TWD"), null);
  assert.equal(parseAmountToMinor("10.5", "USD"), BigInt(1_050));
  assert.equal(parseAmountToMinor("10.505", "USD"), null);
  assert.equal(minorToAmountText(BigInt(400_000), "TWD"), "4000");
  assert.equal(minorToAmountText(BigInt(32_000), "TWD"), "320");
  assert.equal(minorToAmountText(BigInt(-460_000), "TWD"), "-4600");
  assert.equal(minorToAmountText(BigInt(1_050), "USD"), "10.50");
});

test("Taipei month boundaries keep the last evening of March out of April", () => {
  assert.equal(monthWindow("2026-03").end, "2026-03-31");
  assert.equal(monthWindow("2024-02").end, "2024-02-29");
  assert.equal(monthWindow("2026-02").end, "2026-02-28");
  assert.equal(parseCivilDate("2023-02-29"), null);
  assert.equal(inCivilMonth("2026-03-31", "2026-03"), true);
  assert.equal(inCivilMonth("2026-04-01", "2026-03"), false);
  assert.equal(inCivilMonth("2026-03-31", "2026-04"), false);
  assert.equal(inCivilMonth("2024-02-29", "2024-02"), true);
  assert.equal(taipeiCalendarDate(new Date("2026-03-31T15:59:59.000Z")), "2026-03-31");
  assert.equal(taipeiCalendarDate(new Date("2026-03-31T16:00:00.000Z")), "2026-04-01");
  assert.equal(instantSettlementMonth("2026-03-31T15:59:59.000Z"), "2026-03");
  assert.equal(instantSettlementMonth("2026-03-31T16:00:00.000Z"), "2026-04");
  assert.equal(instantSettlementMonth("2025-12-31T16:00:00.000Z"), "2026-01");
  assert.equal(instantSettlementMonth("2026-03-31T16:00:00+08:00"), "2026-03");
  assert.equal(defaultPaidOn("2099-01", "2026-10-22"), "2099-01-15");
  assert.equal(defaultPaidOn("2026-10", "2026-10-22"), "2026-10-22");
});

test("partial payments, reversals, and one fee on the month total stay exact", () => {
  const rent = [{ charge_type: "rent", amount_minor: BigInt(1_200_000), description: "rent" }];
  const partial = attributeMinor(rent, BigInt(400_000));
  assert.deepEqual(partial, { rent: BigInt(400_000), utility: BigInt(0), deposit: BigInt(0), other: BigInt(0) });
  const mixed = attributeMinor(
    [
      { charge_type: "rent", amount_minor: BigInt(100_000), description: "rent" },
      { charge_type: "utility", amount_minor: BigInt(50_000), description: "power" },
      { charge_type: "deposit", amount_minor: BigInt(200_000), description: "deposit" },
    ],
    BigInt(120_000),
  );
  assert.equal(mixed.rent, BigInt(100_000));
  assert.equal(mixed.utility, BigInt(20_000));
  assert.equal(mixed.deposit, BigInt(0));
  const credit = attributeMinor(
    [
      { charge_type: "utility", amount_minor: BigInt(50_000), description: "power" },
      { charge_type: "credit", amount_minor: BigInt(-20_000), description: "沖銷電費" },
    ],
    BigInt(40_000),
  );
  assert.equal(credit.utility, BigInt(30_000));

  const month = projectMonth(
    [
      { status: "confirmed", paidOn: "2026-03-31", rentMinor: BigInt(400_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) },
      { status: "confirmed", paidOn: "2026-03-02", rentMinor: BigInt(100_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) },
      { status: "reversed", paidOn: "2026-03-15", rentMinor: BigInt(900_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) },
      { status: "confirmed", paidOn: "2026-04-01", rentMinor: BigInt(500_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) },
      { status: "submitted", paidOn: "2026-03-20", rentMinor: BigInt(50_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) },
    ],
    "2026-03",
    PERCENT_8,
    BigInt(0),
  );
  assert.equal(month.rentMinor, BigInt(500_000));
  assert.equal(month.feeMinor, BigInt(40_000));
  assert.equal(month.netMinor, BigInt(460_000));
  assert.equal(month.payableMinor, BigInt(460_000));
  assert.equal(month.owesMinor, BigInt(0));

  const april = projectMonth(
    [{ status: "confirmed", paidOn: "2026-04-01", rentMinor: BigInt(500_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) }],
    "2026-04",
    PERCENT_8,
    BigInt(0),
  );
  assert.equal(april.rentMinor, BigInt(500_000));
  assert.equal(april.feeMinor, BigInt(40_000));

  const owes = projectMonth(
    [{ status: "confirmed", paidOn: "2026-03-01", rentMinor: BigInt(100_000), utilityMinor: BigInt(0), otherMinor: BigInt(0), depositMinor: BigInt(0) }],
    "2026-03",
    PERCENT_8,
    BigInt(200_000),
  );
  assert.equal(owes.netMinor, BigInt(100_000) - BigInt(8_000) - BigInt(200_000));
  assert.equal(owes.payableMinor, BigInt(0));
  assert.equal(owes.owesMinor, BigInt(108_000));

  assert.equal(
    managementFeeExact({ kind: "percent", hybridMode: null, percentBp: BigInt(5_000), fixedMinor: BigInt(0), minimumMinor: BigInt(0) }, BigInt(3)),
    BigInt(2),
  );
  assert.equal(managementFeeExact(PERCENT_8, BigInt(400_000)), BigInt(32_000));
  assert.equal(
    managementFeeExact(
      { kind: "hybrid", hybridMode: "greater_of", percentBp: BigInt(800), fixedMinor: BigInt(50_000), minimumMinor: BigInt(0) },
      BigInt(400_000),
    ),
    BigInt(50_000),
  );
});

test("closing balance is opening plus firm rent minus costs minus payouts", () => {
  assert.equal(civilPeriodLabel("2026-10"), "2026年10月");
  assert.equal(rentPeriodLabel("2026-10"), "2026年10月 租金");
  assert.equal(previousPeriod("2026-01"), "2025-12");
  assert.equal(dueDayAllowed(5), true);
  assert.equal(dueDayAllowed(28), true);
  assert.equal(dueDayAllowed(29), false);
  assert.equal(
    closingBalance(BigInt(200_000), BigInt(1_550_000), BigInt(755_000), BigInt(900_000)),
    BigInt(95_000),
  );
  assert.equal(
    closingBalance(BigInt(200_000), BigInt(1_550_000), BigInt(935_000), BigInt(900_000)),
    BigInt(-85_000),
  );
  assert.equal(signedMoneyLabel(-330_000, "TWD", "zh-TW"), "\u2212NT$3,300");
  assert.equal(signedMoneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(signedMoneyLabel(-330_000, "TWD", "zh-TW").includes("-NT$"), false);
});

test("settlement copy uses 屋主, 未繳租金, 已繳, and 款項到帳", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  const keys = Object.keys(zh).filter((key) => key.startsWith("i_settle_"));
  assert.ok(keys.length >= 20);
  for (const key of keys) {
    assert.equal(typeof en[key], "string", key);
    for (const word of BANNED) {
      assert.equal(zh[key].includes(word), false, `${key} ${word}`);
      assert.equal(en[key].includes(word), false, `${key} ${word}`);
    }
  }
  assert.equal(zh.i_settle_lead, "租金由租客直接付給屋主。{brand} 只記錄款項到帳，不經手任何款項。");
  assert.equal(zh.i_settle_direct, "款項到帳後，租金仍由租客直接付給屋主。");
  assert.equal(zh.i_settle_unpaid, "未繳租金");
  assert.equal(zh.i_settle_paid, "已繳");
  assert.equal(zh.i_settle_rent, "已繳租金");
  assert.match(zh.i_settle_lead, /租客直接付給屋主/);
  assert.equal(zh.i_settle_lead.includes("代"), false);
  const t = makeT("zh-TW");
  assert.equal(t("i_settle_lead", { brand: "租多啦" }), "租金由租客直接付給屋主。租多啦 只記錄款項到帳，不經手任何款項。");
  const csv = settlementCsv(
    [{ ownerName: '陳"建宏', month: "2099-01", currency: "TWD", rentMinor: BigInt(500_000), feeMinor: BigInt(40_000), netMinor: BigInt(460_000) }],
    { owner: zh.i_owner, month: zh.i_month, currency: zh.i_settle_currency, rent: zh.i_settle_rent, fee: zh.i_settle_fee, net: zh.i_settle_net },
  );
  assert.match(csv, /已繳租金/);
  assert.match(csv, /5000/);
  assert.match(csv, /400/);
  assert.match(csv, /4600/);
  assert.match(csv, /陳""建宏/);
  assert.equal(csv.includes("."), false);
});
