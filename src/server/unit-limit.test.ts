import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DAYS90,
  applyUnitCount,
  graceDaysLeft,
  keptSpaceIds,
  limitPhase,
  mutationAllowed,
  periodEndOn,
  trialEnd,
  trialMode,
} from "./unit-limit";

const spaces = [
  { id: "b", createdAt: "2025-04-01T00:00:00.000Z" },
  { id: "a", createdAt: "2025-03-01T00:00:00.000Z" },
  { id: "e", createdAt: "2025-07-01T00:00:00.000Z" },
  { id: "c", createdAt: "2025-05-01T00:00:00.000Z" },
  { id: "d", createdAt: "2025-06-01T00:00:00.000Z" },
];

test("trial mode defaults to calendar months and days90 is the other mode", () => {
  const previous = process.env.TRIAL_MODE;
  delete process.env.TRIAL_MODE;
  assert.equal(trialMode(), "calendar_months");
  assert.equal(trialMode("weeks"), "calendar_months");
  assert.equal(trialMode("days90"), "days90");
  if (previous === undefined) delete process.env.TRIAL_MODE;
  else process.env.TRIAL_MODE = previous;
});

test("trial length follows the mode instead of a fixed number of months", () => {
  const start = new Date("2026-01-31T00:00:00.000Z");
  assert.equal(trialEnd(start, 3, "calendar_months").toISOString(), "2026-04-30T00:00:00.000Z");
  const days = trialEnd(start, 3, "days90");
  assert.equal(days.toISOString(), new Date(start.getTime() + DAYS90 * 24 * 60 * 60 * 1000).toISOString());
  assert.notEqual(days.toISOString(), trialEnd(start, 3, "calendar_months").toISOString());
});

test("grace keeps every unit editable, and the lock starts the day grace ends", () => {
  const trialUntil = "2026-01-01T00:00:00.000Z";
  const base = {
    environment: "live" as const,
    tier: "free",
    trialUntil,
    spaceCount: 7,
  };
  assert.equal(limitPhase({ ...base, now: new Date("2025-12-01T00:00:00.000Z") }), "trial");
  assert.equal(limitPhase({ ...base, now: new Date("2026-01-15T00:00:00.000Z") }), "grace");
  assert.equal(graceDaysLeft(trialUntil, new Date("2026-01-01T00:00:00.000Z")), 30);
  assert.equal(graceDaysLeft(trialUntil, new Date("2026-01-15T00:00:00.000Z")), 16);
  assert.equal(limitPhase({ ...base, now: new Date("2026-01-31T00:00:00.000Z") }), "locked");
  assert.equal(graceDaysLeft(trialUntil, new Date("2026-02-01T00:00:00.000Z")), 0);
  assert.equal(limitPhase({ ...base, now: new Date("2026-02-01T00:00:00.000Z"), spaceCount: 4 }), "open");
  assert.equal(limitPhase({ ...base, environment: "sandbox", now: new Date("2026-03-01T00:00:00.000Z") }), "open");
  assert.equal(limitPhase({ ...base, tier: "pro", now: new Date("2026-03-01T00:00:00.000Z") }), "open");
  assert.equal(limitPhase({ ...base, trialUntil: null, now: new Date("2026-03-01T00:00:00.000Z") }), "open");
});

test("the default pick is the four earliest units, and a later pick replaces it", () => {
  assert.deepEqual(keptSpaceIds(spaces, null), ["a", "b", "c", "d"]);
  assert.deepEqual(keptSpaceIds(spaces, []), ["a", "b", "c", "d"]);
  assert.deepEqual(keptSpaceIds(spaces, ["e", "d", "missing"]), ["e", "d"]);
  assert.deepEqual(keptSpaceIds(spaces, ["c", "a", "e", "b"]), ["c", "a", "e", "b"]);
});

test("a read-only unit can still record and reverse payments", () => {
  assert.equal(mutationAllowed("unit", false), false);
  assert.equal(mutationAllowed("lease", false), false);
  assert.equal(mutationAllowed("payment_record", false), true);
  assert.equal(mutationAllowed("payment_reverse", false), true);
  assert.equal(mutationAllowed("lease", true), true);
});

test("a unit-count change waits until the next billing period", () => {
  const opened = applyUnitCount({
    active: 6,
    billed: null,
    pending: null,
    periodEnd: null,
    today: "2026-10-22",
    cycle: "month",
  });
  assert.equal(opened.billed, 6);
  assert.equal(opened.pending, null);
  assert.equal(opened.periodEnd, "2026-10-31");

  const raised = applyUnitCount({
    active: 10,
    billed: opened.billed,
    pending: opened.pending,
    periodEnd: opened.periodEnd,
    today: "2026-10-22",
    cycle: "month",
  });
  assert.equal(raised.billed, 6);
  assert.equal(raised.pending, 10);
  assert.equal(raised.periodEnd, "2026-10-31");

  const sameDay = applyUnitCount({
    active: 6,
    billed: raised.billed,
    pending: raised.pending,
    periodEnd: raised.periodEnd,
    today: "2026-10-31",
    cycle: "month",
  });
  assert.equal(sameDay.billed, 6);
  assert.equal(sameDay.pending, null);

  const next = applyUnitCount({
    active: 10,
    billed: 6,
    pending: 10,
    periodEnd: "2026-10-31",
    today: "2026-11-01",
    cycle: "month",
  });
  assert.equal(next.billed, 10);
  assert.equal(next.pending, null);
  assert.equal(next.periodEnd, "2026-11-30");

  const yearly = applyUnitCount({
    active: 8,
    billed: 6,
    pending: null,
    periodEnd: "2027-10-21",
    today: "2026-10-22",
    cycle: "year",
  });
  assert.equal(yearly.billed, 6);
  assert.equal(yearly.pending, 8);
  assert.equal(periodEndOn("2026-10-22", "year"), "2027-10-21");
});

const S16 =
  "寬限期已結束。只有你選的 4 戶可以編輯；其他戶唯讀，可以查看，仍可登記和撤銷付款，但不能編輯物件、租約、帳單和提醒。已排定的帳單照常寄出，租客端不受影響。";

test("plan screens reuse the approved S12, S15, S16, and S17 sentences", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_plan_s16_banner, S16);
  assert.equal(zh.i_price_a2, S16);
  assert.equal(zh.i_plan_s16_pick, "選擇保留的 4 戶");
  assert.equal(zh.i_plan_s16_upgrade, "選擇付費方案");
  assert.equal(zh.i_plan_s16_editable, "可編輯");
  assert.equal(zh.i_plan_s16_readonly, "唯讀");
  assert.equal(zh.i_plan_s17_title, "選擇保留可編輯的 4 戶");
  assert.equal(zh.i_plan_s17_lead, "預設為最早建立的 4 戶，管理員可以隨時更改。已選 {n} / 4");
  assert.equal(zh.i_plan_s17_created, "建立於 {d}");
  assert.equal(zh.i_plan_s17_note, "沒有選的戶會是唯讀。只有管理員可以操作。");
  assert.equal(zh.i_plan_s15_banner, "目前 {n} 戶，超過免費方案的 4 戶。寬限期剩 {left} 天，之後只有你選的 4 戶可以編輯。");
  assert.equal(zh.i_plan_s12_after, "30 天寬限期，之後只有你選的 4 戶可以編輯，其他 {n} 戶唯讀；資料不會刪除");
  assert.equal(zh.i_plan_s12_next, "下期生效");
  assert.equal(zh.i_readonly_edit_pending, "唯讀戶不能編輯");
  assert.equal(zh.i_readonly_unit, "這一戶目前唯讀：仍可登記和撤銷付款，但不能編輯物件。想編輯這一戶，請升級方案或改選可編輯的 4 戶。");
  assert.equal(zh.i_readonly_lease, "這一戶目前唯讀：仍可登記和撤銷付款，但不能編輯租約。想編輯這一戶，請升級方案或改選可編輯的 4 戶。");
  assert.equal(zh.i_readonly_plans, "查看方案");
  assert.equal(en.i_readonly_edit_pending, "Read-only units can't be edited.");
  assert.equal(en.i_plan_s16_banner, en.i_price_a2);
  assert.notEqual(en.i_plan_s16_banner, "");
});
