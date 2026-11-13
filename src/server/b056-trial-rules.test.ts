import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { seatLimit } from "./billing";
import {
  B056_FREE_SEATS,
  B056_STANDARD_SEATS,
  b056SeatLimit,
  canOfferTrial,
  parseTrialPlan,
  pricingTrialOn,
  resolveEffectivePlan,
} from "./b056-trial-rules";

const ORG = "11111111-1111-1111-1111-111111111111";
const END = new Date("2027-02-28T00:00:00+08:00");
const at = (iso: string) => new Date(iso);

test("MGT-97-AC1: a trial is in force strictly before 00:00 Asia/Taipei of its end date", () => {
  const facts = { trialPlan: "standard", trialEndsAt: END, paidPlan: null };
  const before = resolveEffectivePlan({ ...facts, asOf: at("2027-02-27T23:59:59.999+08:00") });
  assert.deepEqual(before, { kind: "trial", tier: "standard", trial: { plan: "standard", endsAt: END }, seatLimit: 5 });
  const exact = resolveEffectivePlan({ ...facts, asOf: END });
  assert.deepEqual([exact.kind, exact.tier, exact.seatLimit], ["free_after_trial", "free", 1]);
  assert.deepEqual(exact.trial, { plan: "standard", endsAt: END });
  const pro = resolveEffectivePlan({ trialPlan: "pro", trialEndsAt: END, paidPlan: null, asOf: at("2026-12-01T00:00:00Z") });
  assert.deepEqual([pro.kind, pro.tier, pro.seatLimit], ["trial", "pro", null]);
});

test("MGT-96-AC4: paid wins over any trial; only a never-trialled, unpaid org may be offered a trial", () => {
  const paid = resolveEffectivePlan({ trialPlan: "pro", trialEndsAt: END, paidPlan: "standard", asOf: at("2026-12-01T00:00:00Z") });
  assert.deepEqual([paid.kind, paid.tier, paid.seatLimit, paid.trial], ["paid", "standard", 5, null]);
  const never = resolveEffectivePlan({ trialPlan: null, trialEndsAt: null, paidPlan: null, asOf: at("2026-12-01T00:00:00Z") });
  assert.deepEqual([never.kind, never.tier, never.seatLimit], ["free", "free", 1]);
  assert.equal(canOfferTrial(never), true);
  assert.equal(canOfferTrial(paid), false);
  assert.equal(canOfferTrial(resolveEffectivePlan({ trialPlan: "standard", trialEndsAt: END, paidPlan: null, asOf: END })), false);
  assert.equal(canOfferTrial(resolveEffectivePlan({ trialPlan: "standard", trialEndsAt: END, paidPlan: null, asOf: at("2026-12-01T00:00:00Z") })), false);
});

test("malformed facts fail closed to Free and never re-offer a trial", () => {
  for (const facts of [
    { trialPlan: "premium", trialEndsAt: END, paidPlan: null },
    { trialPlan: "standard", trialEndsAt: null, paidPlan: null },
    { trialPlan: "standard", trialEndsAt: new Date("not a date"), paidPlan: null },
  ]) {
    const plan = resolveEffectivePlan({ ...facts, asOf: at("2026-12-01T00:00:00Z") });
    assert.deepEqual([plan.tier, plan.seatLimit], ["free", 1], JSON.stringify(facts));
    assert.equal(canOfferTrial(plan), false);
  }
  const badPaid = resolveEffectivePlan({ trialPlan: null, trialEndsAt: null, paidPlan: "business", asOf: at("2026-12-01T00:00:00Z") });
  assert.deepEqual([badPaid.kind, badPaid.tier], ["free", "free"]);
});

test("MGT-97-AC2 (Ron 01:30 PT): Standard = 5 incl. admin, Premium unlimited, Free 1 — same as billing.seatLimit", () => {
  assert.equal(B056_STANDARD_SEATS, 5);
  assert.equal(B056_FREE_SEATS, 1);
  for (const tier of ["free", "standard", "pro"] as const) assert.equal(b056SeatLimit(tier), seatLimit(tier), tier);
});

test("parseTrialPlan accepts standard / pro / premium only", () => {
  assert.equal(parseTrialPlan("standard"), "standard");
  assert.equal(parseTrialPlan("pro"), "pro");
  assert.equal(parseTrialPlan("premium"), "pro");
  for (const bad of [null, undefined, "", "Standard", "business", "free", 1, ["pro"]]) assert.equal(parseTrialPlan(bad), null);
});

test("pricingTrialOn is strict and fail-closed, matching app.b056_enabled", () => {
  const on = { enabled: true, allowed_org_ids: [ORG] };
  assert.equal(pricingTrialOn(on, { pricing_trial: true }, ORG), true);
  assert.equal(pricingTrialOn(on, { pricing_trial: "true" }, ORG), false);
  assert.equal(pricingTrialOn(on, { pricing_trial: 1 }, ORG), false);
  assert.equal(pricingTrialOn(on, {}, ORG), false);
  assert.equal(pricingTrialOn(on, null, ORG), false);
  assert.equal(pricingTrialOn({ ...on, enabled: "true" }, { pricing_trial: true }, ORG), false);
  assert.equal(pricingTrialOn({ enabled: true, allowed_org_ids: [] }, { pricing_trial: true }, ORG), false);
  assert.equal(pricingTrialOn({ enabled: true, allowed_org_ids: [ORG, 1] }, { pricing_trial: true }, ORG), false);
  assert.equal(pricingTrialOn({ enabled: true, allowed_org_ids: ORG }, { pricing_trial: true }, ORG), false);
  assert.equal(pricingTrialOn([on], { pricing_trial: true }, ORG), false);
  assert.equal(pricingTrialOn(on, { pricing_trial: true }, ""), false);
  assert.equal(pricingTrialOn(on, { pricing_trial: true }, null), false);
  assert.equal(pricingTrialOn({ enabled: false, allowed_org_ids: [ORG] }, { pricing_trial: true }, ORG), false);
});

test("OQ-B056-13 zero outbound (static): B-056 modules import no mail, LINE, reminder, notification, signup or GoTrue code and call no fetch", () => {
  const files = ["./b056-trial-rules.ts", "./b056-trial.ts", "./b056-trial-actions.ts"];
  const banned = /from\s+["'][^"']*(mail|staff-email|signup|gotrue|\/line\/|line-|reminder|notification|sms|twilio)[^"']*["']/i;
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, banned, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
  }
});
