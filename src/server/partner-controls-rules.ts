/** Partner terms use elapsed UTC days and [startsAt, expiresAt). */
export const PARTNER_TERM_MS = 30 * 24 * 60 * 60 * 1000;
export const PARTNER_MAX_UNITS = 10000;
export type PartnerOverrideKind = "pricing_hide" | "unit_override";
export type PartnerOverride = {
  kind: PartnerOverrideKind;
  unitLimit: number | null;
  startsAt: string;
  expiresAt: string;
  revoked: boolean;
  revision: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function partnerControlEnabled(platform: unknown, flags: unknown, orgId: string, kind: PartnerOverrideKind): boolean {
  const key = `partner_${kind}`;
  return object(platform) && platform.enabled === true
    && Array.isArray(platform.allowed_org_ids)
    && platform.allowed_org_ids.every((id) => typeof id === "string" && uuid.test(id))
    && platform.allowed_org_ids.includes(orgId)
    && object(flags) && flags[key] === true;
}
export function validPartnerTerm(startsAt: string, expiresAt: string): boolean {
  if (typeof startsAt !== "string" || typeof expiresAt !== "string") return false;
  const start = Date.parse(startsAt), end = Date.parse(expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= PARTNER_TERM_MS;
}
export function validPartnerUnits(limit: unknown): limit is number {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= PARTNER_MAX_UNITS;
}
export function effectivePartnerOverride(input: {
  platform: unknown; flags: unknown; orgId: string; kind: PartnerOverrideKind;
  override: PartnerOverride | null; now: Date;
}): PartnerOverride | null {
  const o = input.override, t = input.now.getTime();
  if (!partnerControlEnabled(input.platform, input.flags, input.orgId, input.kind)
      || !o || o.kind !== input.kind || o.revoked !== false || !Number.isInteger(o.revision) || o.revision < 1
      || !validPartnerTerm(o.startsAt, o.expiresAt) || !Number.isFinite(t)
      || t < Date.parse(o.startsAt) || t >= Date.parse(o.expiresAt)
      || (o.kind === "unit_override" ? !validPartnerUnits(o.unitLimit) : o.unitLimit !== null)) return null;
  return o;
}
/** Renewal replaces the current term, never stacks days onto the old expiry. */
export function partnerRenewalTerm(now: Date, days: number) {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1 || days > 30) return null;
  return { startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86400000).toISOString() };
}
