// FILE: src/server/pricing-interim.ts
// B-045 (pricing_interim) — DB-backed, fail-closed per-org admission helper.
// R11: fail closed on missing/malformed rows and any query error.
// Q-C: anonymous / no-org callers stay on the old /pricing (no query, no
// admission) until a separate public GO. UI-only; never touches billing.ts
// constants, never writes platform_settings or feature_flags, no outbound.
// B-045 / C3: isPricingInterimGloballyEnabled remains the raw enabled===true
// primitive (org-independent public kill switch) — it does NOT decide apply
// access. /pricing/apply GET and actionSubmitPricingApply must use
// canAccessPricingApply, because enabled:true with an allowlist
// (internal-only ON) must NOT expose anonymous apply. Public mode is
// enabled===true AND public===true. C3: do not set public:true without Ron's
// own-words GO. All helpers fail closed to false (404 / reject) on any error,
// missing row, or malform.
import { query } from "./db";
import { readSession } from "./session";
import {
  pricingInterimAdmitted,
  pricingInterimGloballyEnabled,
  pricingInterimPublicEnabled,
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
 * B-045 / C3 raw enabled===true primitive for the pricing_interim platform
 * setting. Org-independent: unlike isPricingInterimEnabled, anonymous / no-org
 * callers ARE allowed to query this. Reads only the platform_settings row (no
 * organizations join). Fails closed (returns false) on any query error, a
 * missing row, or a malformed value. NOTE: enabled:true alone does NOT grant
 * anonymous apply access (internal-only ON has an allowlist) — apply routes
 * must gate on canAccessPricingApply, not this. Never writes platform_settings
 * or feature_flags, no outbound.
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

/**
 * B-045 apply-gate boundary (C3 / Q-C / PLT-30 / R11): decide whether a caller
 * may access /pricing/apply (GET render and actionSubmitPricingApply). Testable
 * core — all I/O is injected. Fail-closed: any throw => false.
 *
 * 1. Public mode (enabled===true AND public===true) opens anonymous GET/POST:
 *    read the global setting and, if pricingInterimPublicEnabled, admit
 *    immediately without reading the session.
 * 2. Otherwise the setting is OFF or internal-only ON (allowlist). Read the
 *    session and require a staff live org: kind==="staff" with a non-empty
 *    string liveOrgId. Anonymous, tenant/owner, or missing liveOrgId => false.
 * 3. Defer to the per-org gate for that staff live org. isOrgEnabled is never
 *    called with a null/empty orgId.
 */
export async function runCanAccessPricingApply(deps: {
  readGlobal: () => Promise<unknown>;
  isOrgEnabled: (orgId: string) => Promise<boolean>;
  readSession: () => Promise<{ kind: string; liveOrgId?: string | null } | null>;
}): Promise<boolean> {
  try {
    const global = await deps.readGlobal();
    if (pricingInterimPublicEnabled(global)) return true;

    const session = await deps.readSession();
    if (
      !session ||
      session.kind !== "staff" ||
      typeof session.liveOrgId !== "string" ||
      session.liveOrgId.length === 0
    ) {
      return false;
    }

    return await deps.isOrgEnabled(session.liveOrgId);
  } catch {
    return false;
  }
}

/**
 * Production wrapper: wires runCanAccessPricingApply to the real platform
 * settings row, the per-org gate, and the request session. Fails closed.
 */
export async function canAccessPricingApply(): Promise<boolean> {
  async function readGlobal(): Promise<unknown> {
    try {
      const result = await query(
        `SELECT value FROM platform_settings WHERE key='pricing_interim'`,
        [],
      );
      const row = result.rows[0] as { value: unknown } | undefined;
      return row ? row.value : undefined;
    } catch {
      return undefined;
    }
  }

  return runCanAccessPricingApply({
    readGlobal,
    isOrgEnabled: isPricingInterimEnabled,
    readSession,
  });
}
