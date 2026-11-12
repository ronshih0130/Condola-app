// FILE: src/server/pricing-interim.ts
// B-045 (pricing_interim) — DB-backed, fail-closed per-org admission helper.
// R11: fail closed on missing/malformed rows and any query error.
// Q-C: anonymous / no-org callers stay on the old /pricing (no query, no
// admission) until a separate public GO. UI-only; never touches billing.ts
// constants, never writes platform_settings or feature_flags, no outbound.
// B-045 / C3: isPricingInterimGloballyEnabled is the org-independent public
// kill switch for /pricing/apply — anonymous callers MAY query it, and it
// fails closed to false (404 / reject) on any error, missing row, or malform.
import { query } from "./db";
import {
  pricingInterimAdmitted,
  pricingInterimGloballyEnabled,
} from "./b045-pricing-interim-rules";

/**
 * Effective per-org gate: the org must be admitted by both the platform
 * allowlist and its own feature flag. Fails closed (returns false) on empty
 * org context, a missing org row, or any query error. Q-C: anonymous callers
 * never query and are never admitted.
 */
export async function isPricingInterimEnabled(
  orgId: string | null | undefined,
): Promise<boolean> {
  if (typeof orgId !== "string" || orgId.length === 0) return false;
  try {
    const result = await query(
      `SELECT (SELECT value FROM platform_settings WHERE key='pricing_interim') AS value,
              feature_flags
         FROM organizations WHERE id=$1`,
      [orgId],
    );
    const row = result.rows[0] as
      | { value: unknown; feature_flags: unknown }
      | undefined;
    if (!row) return false;
    return pricingInterimAdmitted(row.value, row.feature_flags, orgId);
  } catch {
    return false;
  }
}

/**
 * B-045 / C3 public-page kill switch for the /pricing/apply GET render and
 * actionSubmitPricingApply (CEO 2026-11-12 03:45 PST: flag OFF => 404 / reject,
 * no insert). Org-independent: unlike isPricingInterimEnabled, anonymous /
 * no-org callers ARE allowed to query this. Reads only the platform_settings
 * row (no organizations join). Fails closed (returns false) on any query error,
 * a missing row, or a malformed value. Never writes platform_settings or
 * feature_flags, no outbound.
 */
export async function isPricingInterimGloballyEnabled(): Promise<boolean> {
  try {
    const result = await query(
      `SELECT value FROM platform_settings WHERE key='pricing_interim'`,
      [],
    );
    const row = result.rows[0] as { value: unknown } | undefined;
    if (!row) return false;
    return pricingInterimGloballyEnabled(row.value);
  } catch {
    return false;
  }
}
