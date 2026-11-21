import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageCard } from "../components/usage-card";
import { b056TrialCopy } from "../i18n/b056-trial";
import { formatTrialDate, previewTrialEnd, resolveEffectivePlan, safeReturnPath, taipeiDay, trialBannerKind, trialDaysLeft, type TrialPlan } from "./b056-trial-rules";

const monthCases: [TrialPlan, string, string][] = [
  ["standard", "2026-11-30T01:00:00+08:00", "2027-02-28"],
  ["pro", "2026-08-31T12:00:00+08:00", "2027-02-28"],
  ["standard", "2027-11-30T09:00:00+08:00", "2028-02-29"],
  ["standard", "2026-11-30T23:30:00+08:00", "2027-02-28"],
  ["standard", "2026-11-30T16:30:00Z", "2027-03-01"],
  ["pro", "2026-01-15T00:00:00+08:00", "2026-07-15"],
];
test("MGT-96-AC2: preview matches SQL calendar-month clamping and Taipei midnight", () => {
  for (const [plan, start, day] of monthCases) {
    const result = previewTrialEnd(plan, new Date(start));
    assert.equal(result.toISOString(), new Date(`${day}T00:00:00+08:00`).toISOString());
    assert.equal(taipeiDay(result), day);
    assert.equal(formatTrialDate(result), day.replace(/-/g, "/"));
  }
  assert.equal(taipeiDay(new Date("2026-11-30T16:30:00Z")), "2026-12-01");
});

test("MGT-98-AC1: calendar days and all reminder thresholds, paid/free excluded", () => {
  const endsAt = new Date("2027-02-28T00:00:00+08:00");
  const now = new Date("2027-02-14T23:59:59+08:00");
  const trial = resolveEffectivePlan({ asOf: now, trialPlan: "pro", trialEndsAt: endsAt, paidPlan: null });
  for (const [days, kind] of [[15, null], [14, "d14"], [4, "d14"], [3, "d3"], [2, "d3"], [1, "d1"], [0, "d1"]] as const) {
    for (const time of ["00:00:00", "12:30:00", "23:59:59"]) {
      const at = new Date(`2027-02-${String(28 - days).padStart(2, "0")}T${time}+08:00`);
      assert.equal(trialDaysLeft(endsAt, at), days);
      assert.equal(trialBannerKind(trial, at), kind);
    }
  }
  for (const paidPlan of [null, "standard", "pro"]) {
    assert.equal(trialBannerKind(resolveEffectivePlan({ asOf: now, trialPlan: null, trialEndsAt: null, paidPlan }), now), null);
  }
  assert.equal(trialBannerKind(resolveEffectivePlan({ asOf: endsAt, trialPlan: "pro", trialEndsAt: endsAt, paidPlan: null }), endsAt), null);
});

test("dismissal return paths stay under /m", () => {
  for (const raw of ["/m", "/m/settings?x=1", "/m#plan", "/m?x=1", `/m/${"a".repeat(509)}`]) assert.equal(safeReturnPath(raw), raw);
  for (const raw of ["//evil.com", "/m//x", "https://x", "/mx", "/m\\x", "/m/\nnext", "/m/\u007f", `/m/${"a".repeat(510)}`, null, undefined, 1, {}, new FormData()]) {
    assert.equal(safeReturnPath(raw), "/m");
  }
});

test("approved zh-TW copy is verbatim; English keys and locale fallback match", () => {
  const copy = b056TrialCopy("zh-TW");
  const date = "2027/05/11";
  const rest = "到期後自動回到免費方案，資料都會保留；依生效租約起始日最早的 5 戶仍可編輯，其餘改為唯讀。多出來的管理者帳號會保留，但後台權限暫停，升級後恢復；租客端完全不受影響。";
  assert.deepEqual({
    ...copy,
    confirm_body_pro: copy.confirm_body_pro(date), confirm_body_std: copy.confirm_body_std(date),
    plan_trial_pro: copy.plan_trial_pro(date), plan_trial_std: copy.plan_trial_std(date),
    days_left: copy.days_left(3), banner_pro: copy.banner_pro(3, date), banner_std: copy.banner_std(3, date),
  }, {
    btn_trial_pro: "免費試用進階方案 6 個月", btn_trial_std: "免費試用標準方案 3 個月",
    note_admin: "只有公司管理員能開始試用，每家公司限試用一次（標準或進階擇一）。", note_non_admin: "請公司管理員開始試用",
    confirm_title_pro: "開始進階方案免費試用？", confirm_title_std: "開始標準方案免費試用？",
    confirm_body_pro: `試用 6 個月，到 ${date} 結束，期間不收費。開始後就不能再試用標準。${rest}`,
    confirm_body_std: `試用 3 個月，到 ${date} 結束，期間不收費。開始後就不能再試用進階。${rest}`,
    cancel: "取消", confirm: "開始試用",
    plan_trial_pro: `目前方案：進階（免費試用中，到 ${date}）`, plan_trial_std: `目前方案：標準（免費試用中，到 ${date}）`,
    days_left: "試用還有 3 天",
    banner_pro: `進階試用將在 3 天後（${date}）結束。結束後超過 5 戶的部分會改為唯讀。`,
    banner_std: `標準試用將在 3 天後（${date}）結束。結束後超過 5 戶的部分會改為唯讀。`,
    apply_cta: "申請付費方案", dismiss_label: "關閉提醒",
  });
  assert.deepEqual(Object.keys(b056TrialCopy("en")).sort(), Object.keys(copy).sort());
  assert.equal(b056TrialCopy("unknown"), copy);
  for (const locale of ["zh-TW", "en"]) {
    assert.ok(b056TrialCopy(locale).confirm_body_pro(date).includes(date));
    assert.ok(b056TrialCopy(locale).confirm_body_std(date).includes(date));
  }
});

test("MGT-53 / MGT-96 / MGT-97: legacy usage markup, offers and trial units", () => {
  Object.assign(globalThis, { React });
  const render = (props: Parameters<typeof UsageCard>[0]) => renderToStaticMarkup(React.createElement(UsageCard, props));
  const base = { locale: "zh-TW", plan: "free" as const, units: 3 };
  const legacy = render(base);
  assert.equal(render({ ...base, trial: null, offer: null }), legacy);
  assert.match(legacy, /3 \/ 5 戶/);
  assert.match(legacy, /interim-bar/);
  assert.doesNotMatch(legacy, /trial-start|trial-note|trial-days-left/);
  const admin = render({ ...base, offer: "admin" });
  assert.match(admin, /href="\/m\/settings\?trial=premium"/);
  assert.match(admin, /href="\/m\/settings\?trial=standard"/);
  assert.ok(admin.includes(b056TrialCopy("zh-TW").note_admin));
  const manager = render({ ...base, offer: "non_admin" });
  assert.match(manager, /請公司管理員開始試用/);
  assert.doesNotMatch(manager, /trial-start/);
  for (const plan of ["standard", "pro"] as const) {
    const trial = render({ ...base, units: 12, trial: { plan, endsOn: "2027/05/11", daysLeft: 3 } });
    assert.match(trial, /免費試用中，到 2027\/05\/11/);
    assert.match(trial, /試用還有 3 天/);
    assert.match(trial, /12 戶/);
    assert.doesNotMatch(trial, /interim-bar|\/ 5|trial-start/);
  }
});
