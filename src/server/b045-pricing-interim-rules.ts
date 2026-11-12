// FILE: src/server/b045-pricing-interim-rules.ts
// B-045 (pricing_interim) — fail-closed admission + flag-ON display/calculator
// math + apply-form validation + trial CTA routing for the B-045 UI.
// Stories: PLT-26..30 (display rates / calculator / apply form), MGT-53,
// decisions C1–C4 (C1 rev 23:37 — trial CTA always shown, no pricing_trial* gate).
// These display rates are UI-only and MUST NOT invoice: billing.ts constants
// stay 30/40/4. Dependency-free: no db, no react, no next, no billing.ts import.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Per-org admission, fail-closed: the platform allowlist must admit the org and
 * the org's own feature flag must opt in, both as strict booleans. Anything
 * else (null, array, "true", 1, missing, empty orgId) => false.
 */
export function pricingInterimOn(
  global: unknown,
  flags: unknown,
  orgId: string,
): boolean {
  if (!isPlainObject(global) || !isPlainObject(flags)) return false;
  if (global.enabled !== true) return false;
  if (
    !Array.isArray(global.allowed_org_ids) ||
    !global.allowed_org_ids.includes(orgId)
  ) {
    return false;
  }
  return flags.pricing_interim === true;
}

/**
 * Caller-facing guard: anonymous / missing org can never be admitted. Returns
 * false unless orgId is a non-empty string, else defers to pricingInterimOn.
 */
export function pricingInterimAdmitted(
  global: unknown,
  flags: unknown,
  orgId: string | null | undefined,
): boolean {
  if (typeof orgId !== "string" || orgId.length === 0) return false;
  return pricingInterimOn(global, flags, orgId);
}

// Flag-scoped display rates. ONLY for flag-ON UI; never used to invoice.
// Internal plan key for Premium remains "pro"; public label is "Premium" /「進階」.
export const INTERIM_FREE_UNITS = 5;
export const INTERIM_LIST_STANDARD = 39;
export const INTERIM_LIST_PREMIUM = 59;

export type InterimPaidTier = "standard" | "pro";

/**
 * PLT-26-AC2: monthly = max(0, floor(units) - 5) * rate; yearly = monthly * 11.
 * Non-finite units is invalid — parseInterimUnits should run first.
 */
export function quoteInterim(
  units: number,
  tier: InterimPaidTier,
): { monthly: number; yearly: number; rate: number } {
  if (!Number.isFinite(units)) {
    throw new RangeError("units must be a finite number");
  }
  const rate = tier === "pro" ? INTERIM_LIST_PREMIUM : INTERIM_LIST_STANDARD;
  const billable = Math.max(0, Math.floor(units) - INTERIM_FREE_UNITS);
  const monthly = billable * rate;
  return { monthly, yearly: monthly * 11, rate };
}

/**
 * PLT-30 units parser. Accepts "0" and base-10 non-negative integers after
 * trim, including leading zeros ("08" => 8). Rejects "1.5", "", "-", "-1",
 * "1e2", whitespace-only.
 */
export function parseInterimUnits(
  raw: string,
): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: Number(trimmed) };
}

// PLT-30 apply form. null / "unsure" render as「還不確定」; "pro" is Premium.
export type ApplyPlan = "standard" | "pro" | "unsure" | null;
export type ApplyInput = {
  companyName: string;
  phone: string;
  units: string;
  plan?: string | null;
  note?: string | null;
};
export type ApplyErrors = {
  companyName?: true;
  phone?: true;
  units?: true;
};
export type ApplyParsed = {
  companyName: string;
  phone: string;
  units: number;
  plan: ApplyPlan;
  note: string | null;
};

function normalizeApplyPlan(plan: string | null | undefined): ApplyPlan {
  if (typeof plan !== "string") return null;
  const v = plan.trim().toLowerCase();
  if (v === "standard") return "standard";
  if (v === "pro" || v === "premium") return "pro";
  if (v === "unsure") return "unsure";
  return null;
}

/**
 * PLT-30-AC2. companyName/phone: trimmed nonempty (no ID/tax format check).
 * units: parseInterimUnits. plan maps premium -> "pro"; unknown plan -> null
 * (never fails the form). first = companyName, then phone, then units so the UI
 * focuses the first invalid field. Does not send/queue anything.
 */
export function validateApplyInput(
  input: ApplyInput,
):
  | { ok: true; value: ApplyParsed }
  | { ok: false; errors: ApplyErrors; first: "companyName" | "phone" | "units" } {
  const errors: ApplyErrors = {};
  const companyName =
    typeof input.companyName === "string" ? input.companyName.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const unitsResult = parseInterimUnits(
    typeof input.units === "string" ? input.units : "",
  );

  const companyNameInvalid = companyName.length === 0;
  const phoneInvalid = phone.length === 0;
  if (companyNameInvalid) errors.companyName = true;
  if (phoneInvalid) errors.phone = true;
  if (!unitsResult.ok) errors.units = true;

  if (companyNameInvalid || phoneInvalid || !unitsResult.ok) {
    const first = companyNameInvalid
      ? "companyName"
      : phoneInvalid
        ? "phone"
        : "units";
    return { ok: false, errors, first };
  }

  const note = typeof input.note === "string" ? input.note.trim() : "";
  return {
    ok: true,
    value: {
      companyName,
      phone,
      units: unitsResult.value,
      plan: normalizeApplyPlan(input.plan),
      note: note.length === 0 ? null : note,
    },
  };
}

// Public query token: internal "pro" is surfaced as "premium" in URLs.
function publicTierToken(tier: InterimPaidTier): "standard" | "premium" {
  return tier === "pro" ? "premium" : "standard";
}

/**
 * C1 (rev 23:37): trial CTA is always shown, no pricing_trial* gate.
 * - Logged-out => /signup trial start.
 * - Logged-in Admin => /m/settings trial confirm (PLT-39-AC3; B-056 adds the
 *   confirm UI later, B-045 only routes here).
 * - Logged-in non-admin (manager/owner) cannot perform a trial start, so route
 *   them to the paid apply form rather than a trial they cannot complete.
 */
export function trialCtaHref(args: {
  plan: InterimPaidTier;
  signedIn: boolean;
  isAdmin?: boolean;
}): string {
  const token = publicTierToken(args.plan);
  if (!args.signedIn) return `/signup?trial=${token}`;
  if (args.isAdmin === true) return `/m/settings?trial=${token}`;
  return paidApplyHref(args.plan);
}

export function paidApplyHref(plan?: InterimPaidTier | "unsure"): string {
  if (plan === undefined) return "/pricing/apply";
  const token = plan === "unsure" ? "unsure" : publicTierToken(plan);
  return `/pricing/apply?plan=${token}`;
}

/** Mirrors billing.formatNt presentation without importing billing.ts. */
export function formatNtInterim(amount: number): string {
  return `NT$${Math.round(amount).toLocaleString("en-US")}`;
}
