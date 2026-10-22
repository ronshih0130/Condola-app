import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COPY,
  depositDecreaseHint,
  depositIncreaseHint,
  dueDayLabel,
  formatStamp,
  leaseInExpiryWindow,
  leaseLifecycleEnabled,
  moveOutRentSpan,
  moveOutTooEarly,
  oldLeaseNote,
  overrideNote,
  overrideStamp,
  periodRentLabel,
  prorateRentMajor,
  renewalSuccess,
  rentFormula,
  settleAmounts,
  shortfallBody,
  unpaidRentLabel,
} from "./lease-lifecycle-rules";

const BANNED = ["房東", "房客", "收款", "收租", "入帳", "欠租", "已收", "代收", "本公司"];

test("the lifecycle flag is on only for the sample company and beta orgs", () => {
  assert.equal(leaseLifecycleEnabled({ environment: "sandbox", planTier: "free" }), true);
  assert.equal(leaseLifecycleEnabled({ environment: "sandbox", planTier: "pro" }), true);
  assert.equal(leaseLifecycleEnabled({ environment: "live", planTier: "beta" }), true);
  assert.equal(leaseLifecycleEnabled({ environment: "live", planTier: "free" }), false);
  assert.equal(leaseLifecycleEnabled({ environment: "live", planTier: "pro" }), false);
  assert.equal(leaseLifecycleEnabled({ environment: "live", planTier: "business" }), false);
});

test("the expiry list covers today through 90 days", () => {
  assert.equal(leaseInExpiryWindow({ status: "active", endDate: "2026-10-22", today: "2026-10-22" }), true);
  assert.equal(leaseInExpiryWindow({ status: "active", endDate: "2027-01-20", today: "2026-10-22" }), true);
  assert.equal(leaseInExpiryWindow({ status: "active", endDate: "2027-01-21", today: "2026-10-22" }), false);
  assert.equal(leaseInExpiryWindow({ status: "active", endDate: "2026-10-21", today: "2026-10-22" }), false);
  assert.equal(leaseInExpiryWindow({ status: "ended", endDate: "2026-11-01", today: "2026-10-22" }), false);
});

test("move-out rent counts the last day and rounds to a whole NT$", () => {
  const span = moveOutRentSpan("2026-01-01", "2026-11-17");
  assert.deepEqual(span && { days: span.days, startDay: span.startDay, endDay: span.endDay }, { days: 17, startDay: 1, endDay: 17 });
  assert.equal(prorateRentMajor(21_000, 17), 11_900);
  assert.equal(rentFormula(21_000, 17, 11_900), "NT$21,000 ÷ 30 × 17 天 ＝ NT$11,900");
  const laterStart = moveOutRentSpan("2026-11-10", "2026-11-17");
  assert.equal(laterStart?.days, 8);
  assert.equal(prorateRentMajor(10_000, 17), 5_667);
  assert.equal(moveOutRentSpan("2026-11-18", "2026-11-17"), null);
  assert.equal(moveOutTooEarly("2026-11-01"), "無法排定退租：退租日早於租約開始日（2026-11-01）。");
});

test("an override replaces the calculated rent and a shortfall is what the tenant still pays the owner", () => {
  assert.equal(overrideNote(11_900, 10_000), "原金額 NT$11,900，已改為 NT$10,000");
  assert.equal(formatStamp(new Date("2026-10-22T09:30:00Z")), "2026-10-22 17:30");
  assert.equal(overrideStamp("林雅婷", new Date("2026-10-22T09:30:00Z")), "已手動修改（林雅婷・2026-10-22 17:30）");
  const settled = settleAmounts(4_200_000, 1_000_000 + 300_000 + 86_000);
  assert.equal(settled?.refundMinor, 2_814_000);
  assert.equal(settled?.shortfallMinor, 0);
  const short = settleAmounts(4_200_000, 4_820_000);
  assert.equal(short?.refundMinor, 0);
  assert.equal(short?.shortfallMinor, 620_000);
  assert.equal(shortfallBody(6_200), "扣款超過押金，租客還需補付 NT$6,200");
  assert.equal(COPY.shortfallTitle, "押金不足扣抵");
  assert.equal(unpaidRentLabel("2026-11-17", 1, 17), "未繳租金 2026年11月（1–17 日）");
  assert.equal(periodRentLabel("2026-11-17"), "2026年11月 租金");
});

test("renewal and deposit copy matches the locked sentences", () => {
  assert.equal(dueDayLabel(5), "每月 5 日繳租");
  assert.equal(renewalSuccess("2026-12-01"), "新租約已建立，2026年12月 起的帳單會依新租金產生。");
  assert.equal(oldLeaseNote("2026-12-31"), "2026-12-31 結束後保留為歷史紀錄");
  assert.equal(depositIncreaseHint("NT$2,000"), "押金差額 NT$2,000，款項到帳後請在繳租紀錄登記為「押金」。");
  assert.equal(depositDecreaseHint("NT$12,000"), "押金減少 NT$12,000，由屋主直接退給租客。");
  assert.equal(COPY.disclaimer, "Condola 只提供管理軟體，不經手任何款項。");
  assert.equal(COPY.emptyTitle, "90 天內沒有到期的租約");
  assert.equal(COPY.emptyBody, "租約到期前 90 天會出現在這裡。");
  const source = readFileSync(new URL("./lease-lifecycle-rules.ts", import.meta.url), "utf8");
  for (const word of BANNED) assert.equal(source.includes(word), false, word);
  const sql = readFileSync(new URL("../../supabase/migrations/20261029170000_lease_lifecycle.sql", import.meta.url), "utf8");
  assert.equal(/DROP\s+(TABLE|COLUMN)|TRUNCATE/i.test(sql), false);
  assert.equal(/leases_closed_end_date_chk/.test(sql), false);
  assert.match(sql, /lease_moveouts/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.fn_sync_lease_lifecycle_flag\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.fn_lease_close_end_date\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION app\.lease_lifecycle_on\(uuid\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.lease_lifecycle_on\(uuid\) TO authenticated, service_role/);
  const allow = readFileSync(new URL("../../supabase/rpc-allowlist.txt", import.meta.url), "utf8");
  assert.match(allow, /^app\.lease_lifecycle_on\(p_org uuid\)$/m);
  assert.equal(/fn_sync_lease_lifecycle_flag|fn_lease_close_end_date/.test(allow), false);
});
