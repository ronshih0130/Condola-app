// FILE: src/server/pricing-interim.ts
// B-045 (pricing_interim) — DB-backed, fail-closed per-org admission helper.
// R11: fail closed on missing/malformed rows and any query error.
// Q-C: anonymous / no-org callers stay on the old /pricing (no query, no
// admission) until a separate public GO. UI-only; never touches billing.ts
// constants, never writes platform_settings or feature_flags, no outbound.
import { query } from "./db";
import { pricingInterimAdmitted } from "./b045-pricing-interim-rules";

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
