/**
 * B-001 / PROP-US-v03-01 (CAP-P-28, Ron 2026-11-05 19:04 PT): two-level ID switches.
 * collect_id (master, default true) × require_id_before_sign (sub, default false).
 * Only master ∧ sub ON blocks signing; master OFF ∧ sub ON is an invalid setting and never blocks.
 * Verification duties (PRINCIPLES 11) and notices (PRINCIPLES 9) are unchanged by this switch.
 */
export type IdSignGateMode = "off" | "collect" | "block" | "invalid";
export type IdSignGate = { collectId: boolean; requireIdBeforeSign: boolean; mode: IdSignGateMode };

export function resolveIdSignGate(settings: unknown): IdSignGate {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Record<string, unknown> : {};
  // Defaults apply only to ABSENT keys. A present but non-boolean value is malformed and
  // fails closed: signing keeps requiring a ready ID check (same as the legacy gate).
  const malformed = ("collect_id" in s && typeof s.collect_id !== "boolean") ||
    ("require_id_before_sign" in s && typeof s.require_id_before_sign !== "boolean");
  if (malformed) return { collectId: true, requireIdBeforeSign: true, mode: "block" };
  const collectId = typeof s.collect_id === "boolean" ? s.collect_id : true;
  const requireIdBeforeSign = typeof s.require_id_before_sign === "boolean" ? s.require_id_before_sign : false;
  const mode: IdSignGateMode = !collectId ? (requireIdBeforeSign ? "invalid" : "off") : requireIdBeforeSign ? "block" : "collect";
  return { collectId, requireIdBeforeSign, mode };
}

/** Flag OFF keeps the legacy hard gate (ID always required before signing). */
export function signingRequiresIdentity(flagOn: boolean, gate: IdSignGate): boolean {
  return flagOn !== true ? true : gate.mode === "block";
}

export function idSignGateFlagOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== "object" || Array.isArray(global) || !flags || typeof flags !== "object" || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId) && f.id_sign_gate_v2 === true;
}
