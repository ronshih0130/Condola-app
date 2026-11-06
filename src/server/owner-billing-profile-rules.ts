/** B-016 proposal contract only. No persistence, defaults, or runtime callers. */
export type Q1Policy = Readonly<{
  start: null; period: null; proration: null; basis: null; timing: null;
}>;
export type ProfileReferences = Readonly<{
  collectorAccountId: string | null;
  feeRuleId: string;
  feeRuleVersionId: string;
  prepayDrawdownRuleId: string | null;
}>;
export type BillingProfileVersion = Readonly<{
  orgId: string; ownerContactId: string; profileId: string; versionId: string;
  effectiveFrom: string; effectiveTo: string | null;
  references: ProfileReferences;
  depositHolder: string | null;
  q1: Q1Policy;
}>;
export type ProfileScope = Pick<BillingProfileVersion, "orgId" | "ownerContactId" | "profileId">;

function date(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("invalid_effective_date");
  }
}
function reference(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_reference");
}

/** Explicit projection also prevents unknown editable fields from entering snapshots. */
export function validateBillingProfile(input: BillingProfileVersion): BillingProfileVersion {
  for (const value of [input.orgId, input.ownerContactId, input.profileId, input.versionId,
    input.references.feeRuleId, input.references.feeRuleVersionId]) reference(value);
  for (const value of [input.references.collectorAccountId, input.references.prepayDrawdownRuleId, input.depositHolder]) {
    if (value !== null) reference(value);
  }
  date(input.effectiveFrom);
  if (input.effectiveTo !== null) {
    date(input.effectiveTo);
    if (input.effectiveTo <= input.effectiveFrom) throw new Error("invalid_effective_period");
  }
  if (!["start", "period", "proration", "basis", "timing"].every(key =>
    input.q1?.[key as keyof Q1Policy] === null)) throw new Error("unresolved_q1_required");
  return Object.freeze({
    orgId: input.orgId, ownerContactId: input.ownerContactId, profileId: input.profileId,
    versionId: input.versionId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
    references: Object.freeze({ collectorAccountId: input.references.collectorAccountId,
      feeRuleId: input.references.feeRuleId, feeRuleVersionId: input.references.feeRuleVersionId,
      prepayDrawdownRuleId: input.references.prepayDrawdownRuleId }),
    depositHolder: input.depositHolder,
    q1: Object.freeze({ start: input.q1.start, period: input.q1.period, proration: input.q1.proration,
      basis: input.q1.basis, timing: input.q1.timing }),
  });
}

/** [from, to); gaps return null, any overlap in the scoped timeline rejects. */
export function selectBillingProfile(versions: readonly BillingProfileVersion[], scope: ProfileScope, on: string): BillingProfileVersion | null {
  date(on);
  const scoped = versions.filter(v => v.orgId === scope.orgId && v.ownerContactId === scope.ownerContactId &&
    v.profileId === scope.profileId).map(validateBillingProfile).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const seen = new Set<string>();
  for (const [index, version] of scoped.entries()) {
    if (seen.has(version.versionId)) throw new Error("ambiguous_profile_version");
    seen.add(version.versionId);
    const previous = scoped[index - 1];
    if (previous && (previous.effectiveTo === null || previous.effectiveTo > version.effectiveFrom)) {
      throw new Error("ambiguous_profile_period");
    }
  }
  return scoped.find(v => v.effectiveFrom <= on && (v.effectiveTo === null || on < v.effectiveTo)) ?? null;
}

export function inheritBillingProfile(leaseId: string, versions: readonly BillingProfileVersion[], scope: ProfileScope, on: string) {
  reference(leaseId);
  const selected = selectBillingProfile(versions, scope, on);
  if (!selected) throw new Error("profile_unavailable");
  // A read-only issuance fact, not a per-lease editable profile/configuration.
  return Object.freeze({ leaseId, orgId: selected.orgId, ownerContactId: selected.ownerContactId,
    profileId: selected.profileId, profileVersionId: selected.versionId,
    snapshot: Object.freeze({ schema: "b016-inheritance-v1" as const, effectiveOn: on,
      references: selected.references, depositHolder: selected.depositHolder, q1: selected.q1 }) });
}

export type ExplicitPercentRule = Readonly<{
  ruleId: string; versionId: string; rateBasisPoints: bigint; rounding: "half_up";
}>;
function nonnegativeBigInt(value: bigint): void {
  if (typeof value !== "bigint" || value < BigInt(0)) throw new Error("invalid_minor_units_or_rate");
}

/** Synthetic explicit percentage calculation; does not resolve any Q1 policy. */
export function issueFeeSnapshot(rule: ExplicitPercentRule, basisMinor: bigint) {
  reference(rule.ruleId); reference(rule.versionId);
  nonnegativeBigInt(basisMinor); nonnegativeBigInt(rule.rateBasisPoints);
  if (rule.rounding !== "half_up") throw new Error("explicit_rounding_required");
  const amountMinor = (basisMinor * rule.rateBasisPoints + BigInt(5000)) / BigInt(10000);
  return Object.freeze({ schema: "b016-fee-v1" as const, ruleId: rule.ruleId, versionId: rule.versionId,
    basisMinor, rateBasisPoints: rule.rateBasisPoints, rounding: rule.rounding, amountMinor });
}

/** JSON boundary uses decimal strings, never lossy Number conversion. */
export function serializeFeeSnapshot(snapshot: ReturnType<typeof issueFeeSnapshot>): string {
  return JSON.stringify(snapshot, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
