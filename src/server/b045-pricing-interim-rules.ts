// FILE: src/server/b045-pricing-interim-rules.ts
// B-045 (pricing_interim) — fail-closed admission + flag-ON display/calculator
// math + apply-form validation + trial CTA routing for the B-045 UI.
// Stories: PLT-26..30 (display rates / calculator / apply form), MGT-53,
// decisions C1–C4 (C1 rev 23:37 — trial CTA always shown, no pricing_trial* gate).
// These display rates are UI-only and MUST NOT invoice: billing.ts constants
// stay 30/40 with FREE_UNITS = 5 (C4, Ron 2026-11-13; billing.test.ts keeps INTERIM_FREE_UNITS equal
// to FREE_UNITS). Dependency-free: no db, no react, no next, no billing.ts import.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True only for a clean allowlist: an array whose every element is a string.
 * A non-array, or any non-string element (number, null, object, boolean,
 * undefined, or a mixed array like ["org", 1]) => false. Used so membership
 * cannot be satisfied by a string element living inside a mixed-type array.
 */
function isStringAllowlist(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((el) => typeof el === "string");
}

/**
 * Fail-closed parse of a stored pricing_interim setting. Strings are JSON.parsed
 * and the parsed value returned as { ok: true, value }; any JSON.parse throw =>
 * { ok: false }. Non-string input is passed through untouched as
 * { ok: true, value: raw } (objects, null, numbers, etc.), since callers already
 * fail-closed on bad shapes. A successful parse of JSON null/false/[] is a
 * successful parse — only a thrown JSON.parse is ok:false. Never throws.
 */
export function parsePricingInterimSetting(
  raw: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw === "string") {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: raw };
}

/**
 * Per-org admission, fail-closed: the platform allowlist must admit the org and
 * the org's own feature flag must opt in, both as strict booleans. Anything
 * else (null, array, "true", 1, missing, empty orgId) => false.
 *
 * Allowlist membership requires allowed_org_ids to be an array whose every
 * element is a string AND to contain orgId. A mixed-type array (e.g.
 * ["org", 1]) is rejected wholesale and denies even if orgId appears as a
 * string element — a bare includes() must not admit from a dirty allowlist.
 */
export function pricingInterimOn(
  global: unknown,
  flags: unknown,
  orgId: string,
): boolean {
  if (!isPlainObject(global) || !isPlainObject(flags)) return false;
  if (global.enabled !== true) return false;
  if (
    !isStringAllowlist(global.allowed_org_ids) ||
    !global.allowed_org_ids.includes(orgId)
  ) {
    return false;
  }
  return flags.pricing_interim === true;
}

/**
 * Raw global `enabled === true` kill-switch primitive ONLY. True when `global`
 * is a plain object (not null, not array) AND `global.enabled === true` (strict
 * boolean). Missing / malformed / "true" / 1 / null / undefined / [] => false.
 * Does NOT require allowed_org_ids — that per-org opt-in belongs to
 * pricingInterimOn.
 *
 * This is NOT the /pricing/apply admission gate. `enabled:true` alone must not
 * open the anonymous form/submit: an internal-only ON (enabled:true,
 * allowed_org_ids = internal orgs) would wrongly expose the public page. The
 * apply boundary is pricingInterimPublicEnabled (standalone public GO) +
 * pricingApplyAccessAllowed (public OR allowlisted staff org).
 */
export function pricingInterimGloballyEnabled(global: unknown): boolean {
  if (!isPlainObject(global)) return false;
  return global.enabled === true;
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

/**
 * Standalone public GO for the logged-out /pricing/apply form + submit
 * (design-note §5; Q-C / §11 steps 5–6; C3). True IFF `global` is a plain
 * object AND `global.enabled === true` AND `global.public === true`, both strict
 * booleans. `public` defaults to false (CEO confirmed the field name
 * 2026-11-12 05:26 PST): a missing `public` field, a non-boolean `public` value,
 * or a JSON parse failure of the setting (see parsePricingInterimSetting) is
 * treated as public=false. Missing / malformed / "true" / 1 / absent /
 * public:false => false.
 *
 * Empty allowed_org_ids is NOT public mode: the default seed is
 * { enabled:false, allowed_org_ids:[] } and pricingInterimOn requires allowlist
 * membership, so clearing the allowlist must never be the path to going public.
 * `enabled !== true` => false even if public:true (kill switch wins).
 */
export function pricingInterimPublicEnabled(global: unknown): boolean {
  if (!isPlainObject(global)) return false;
  if (global.enabled !== true) return false;
  return global.public === true;
}

/**
 * /pricing/apply admission boundary (PLT-30-AC1/AC2, PLT-28-AC1, R11
 * fail-closed). When the public GO is on, anyone — including anonymous /
 * missing org — is allowed. Otherwise defer to pricingInterimAdmitted, so a
 * live staff org must be allowlisted AND carry the org flag. The kill switch
 * (`enabled !== true`) closes both paths because each underlying primitive
 * requires enabled === true.
 */
export function pricingApplyAccessAllowed(args: {
  global: unknown;
  flags: unknown;
  orgId: string | null | undefined;
}): boolean {
  if (pricingInterimPublicEnabled(args.global)) return true;
  return pricingInterimAdmitted(args.global, args.flags, args.orgId);
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
 * "1e2", whitespace-only. Also enforces the PostgreSQL `integer` bound of
 * pricing_apply_requests.units (integer NOT NULL CHECK (units >= 0)): after
 * Number(trimmed) the value must be a finite Number.isSafeInteger and
 * <= 2147483647, else field-level { ok: false } ("2147483648" and huge digit
 * strings that overflow/become Infinity are rejected; "2147483647" stays ok).
 */
export function parseInterimUnits(
  raw: string,
): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > 2147483647) {
    return { ok: false };
  }
  return { ok: true, value };
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

const PAID_RECEIVED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real calendar date in strict YYYY-MM-DD form, validated via
 * UTC components so impossible dates (2026-02-31, 2026-13-01, 2026-04-31) are
 * rejected before they reach SQL. Empty / loose / rolled-over values are false.
 */
export function isPricingPaidReceivedDate(value: string): boolean {
  if (!PAID_RECEIVED_DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
