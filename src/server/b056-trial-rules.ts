// B-056 trial engine — pure rules (no IO). Design note: condola-hub 20-build/specs/B-056-design.md.
// Stories: MGT-96-AC1…AC4, MGT-97-AC1/AC2, MGT-99-AC1 (state only; read-only and pause are PR-3/PR-4).
//
// The effective plan is a pure function of the stored B-056 facts and the statement time
// (`as_of` from app.b056_plan_facts). Legacy settings.plan / plan_tier are NOT proof of payment
// while pricing_trial is ON (design decision 7): only a B-056 paid record makes an org paid.

export type TrialPlan = "standard" | "pro";
export type EffectiveTier = "free" | TrialPlan;

export type PlanFacts = {
  asOf: Date;
  trialPlan: string | null;
  trialEndsAt: Date | null;
  paidPlan: string | null;
};

export type EffectivePlan = {
  kind: "free" | "trial" | "free_after_trial" | "paid";
  tier: EffectiveTier;
  trial: { plan: TrialPlan; endsAt: Date } | null;
  seatLimit: number | null;
};

/** MGT-97-AC2 (Ron 2026-11-13 01:30 PT): Standard = 5 managers including the company admin. */
export const B056_STANDARD_SEATS = 5;
/** Free = 1 seat (the original admin), unchanged from billing.seatLimit("free"). */
export const B056_FREE_SEATS = 1;

const isPlan = (value: unknown): value is TrialPlan => value === "standard" || value === "pro";

export function b056SeatLimit(tier: EffectiveTier): number | null {
  if (tier === "free") return B056_FREE_SEATS;
  if (tier === "standard") return B056_STANDARD_SEATS;
  return null; // Premium (pro): no seat cap
}

/**
 * Paid wins over trial; a trial is in force strictly before trial_ends_at (00:00 Asia/Taipei of
 * the end date, MGT-99-AC1) and returns the org to Free from that instant. Malformed facts fail
 * closed to the least-privileged state (Free).
 */
export function resolveEffectivePlan(facts: PlanFacts): EffectivePlan {
  if (isPlan(facts.paidPlan)) {
    return { kind: "paid", tier: facts.paidPlan, trial: null, seatLimit: b056SeatLimit(facts.paidPlan) };
  }
  if (isPlan(facts.trialPlan) && facts.trialEndsAt instanceof Date && !Number.isNaN(facts.trialEndsAt.getTime())) {
    const trial = { plan: facts.trialPlan, endsAt: facts.trialEndsAt };
    if (facts.asOf.getTime() < facts.trialEndsAt.getTime()) {
      return { kind: "trial", tier: facts.trialPlan, trial, seatLimit: b056SeatLimit(facts.trialPlan) };
    }
    return { kind: "free_after_trial", tier: "free", trial, seatLimit: B056_FREE_SEATS };
  }
  if (facts.trialPlan != null) {
    // Trial recorded but unreadable: never grant more than Free, and never offer a new trial.
    return { kind: "free_after_trial", tier: "free", trial: null, seatLimit: B056_FREE_SEATS };
  }
  return { kind: "free", tier: "free", trial: null, seatLimit: B056_FREE_SEATS };
}

/** MGT-96-AC4: a trial may be offered only to an org that has never trialled and is not paid. */
export function canOfferTrial(plan: EffectivePlan): boolean {
  return plan.kind === "free";
}

/** Form / query value → plan. "premium" is the public label for the pro key (OQ-B056-16). */
export function parseTrialPlan(raw: unknown): TrialPlan | null {
  if (raw === "standard") return "standard";
  if (raw === "pro" || raw === "premium") return "pro";
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Per-org admission, fail closed, same rule as the SQL twin app.b056_enabled: the platform
 * setting must be an object with enabled === true and an all-string allowed_org_ids array that
 * contains the org, and the org's own feature_flags.pricing_trial must be boolean true.
 */
export function pricingTrialOn(global: unknown, flags: unknown, orgId: string | null | undefined): boolean {
  if (typeof orgId !== "string" || orgId.length === 0) return false;
  if (!isPlainObject(global) || !isPlainObject(flags)) return false;
  if (global.enabled !== true) return false;
  const allowed = global.allowed_org_ids;
  if (!Array.isArray(allowed) || !allowed.every((id) => typeof id === "string") || !allowed.includes(orgId)) return false;
  return flags.pricing_trial === true;
}
