import assert from "node:assert/strict";
import test from "node:test";
import { inheritBillingProfile, issueFeeSnapshot, selectBillingProfile, serializeFeeSnapshot,
  validateBillingProfile, type BillingProfileVersion, type ExplicitPercentRule } from "./owner-billing-profile-rules";

const scope = { orgId: "org", ownerContactId: "owner", profileId: "profile" };
function fixture(versionId = "v1", effectiveFrom = "2027-01-01", effectiveTo: string | null = "2027-02-01"): BillingProfileVersion {
  return { ...scope, versionId, effectiveFrom, effectiveTo,
    references: { collectorAccountId: `collector-${versionId}`, feeRuleId: "fee", feeRuleVersionId: `fee-${versionId}`,
      prepayDrawdownRuleId: `reserved-${versionId}` }, depositHolder: "owner",
    q1: { start: null, period: null, proration: null, basis: null, timing: null } };
}

test("adjacent versions switch only at the explicit half-open boundary, with scoped gaps", () => {
  const versions = [fixture("v2", "2027-02-01", null), fixture()];
  assert.equal(selectBillingProfile(versions, scope, "2026-12-31"), null);
  assert.equal(selectBillingProfile(versions, scope, "2027-01-01")?.versionId, "v1");
  assert.equal(selectBillingProfile(versions, scope, "2027-01-31")?.versionId, "v1");
  assert.equal(selectBillingProfile(versions, scope, "2027-02-01")?.versionId, "v2");
  assert.equal(selectBillingProfile([fixture()], scope, "2027-02-01"), null);
  for (const foreign of [{ orgId: "foreign" }, { ownerContactId: "foreign" }, { profileId: "foreign" }]) {
    assert.equal(selectBillingProfile(versions, { ...scope, ...foreign }, "2027-01-01"), null);
  }
});

test("overlap, duplicate versions and invalid periods fail closed", () => {
  assert.throws(() => selectBillingProfile([fixture(), fixture("v2", "2027-01-31", null)], scope, "2027-02-02"), /ambiguous/);
  assert.throws(() => selectBillingProfile([fixture("v1", "2027-01-01", null), fixture("v2", "2027-02-01", null)], scope, "2027-01-01"), /ambiguous/);
  assert.throws(() => selectBillingProfile([fixture(), fixture("v1", "2027-02-01", null)], scope, "2027-02-01"), /ambiguous/);
  for (const value of [fixture("v1", "2027-02-30", null), fixture("v1", "2027-02-01", "2027-02-01"), fixture("v1", "2027-02-01", "2027-01-01")]) {
    assert.throws(() => validateBillingProfile(value), /invalid_effective/);
  }
});

test("lease inheritance captures references and a detached immutable snapshot, without an editable profile", () => {
  const source = JSON.parse(JSON.stringify(fixture()));
  const a = inheritBillingProfile("lease-a", [source], scope, "2027-01-15");
  const before = JSON.stringify(a);
  const b = inheritBillingProfile("lease-b", [source, fixture("v2", "2027-02-01", null)], scope, "2027-02-01");
  source.references.collectorAccountId = "edited";
  source.references.feeRuleVersionId = "edited";
  source.references.prepayDrawdownRuleId = "edited";
  source.q1.basis = "flat";
  assert.equal(JSON.stringify(a), before);
  assert.equal(a.profileVersionId, "v1");
  assert.deepEqual(a.snapshot.references, fixture().references);
  assert.deepEqual(b.snapshot.references, fixture("v2").references);
  for (const value of [a, a.snapshot, a.snapshot.references, a.snapshot.q1]) assert.ok(Object.isFrozen(value));
  assert.equal(Reflect.set(a.snapshot.references, "collectorAccountId", "mutated"), false);
  assert.deepEqual(Object.keys(a).sort(), ["leaseId", "orgId", "ownerContactId", "profileId", "profileVersionId", "snapshot"].sort());
  assert.equal("profile" in a, false);
  assert.throws(() => inheritBillingProfile("lease", [], scope, "2027-01-01"), /unavailable/);
});

test("all five Q1 fields survive validation and JSON round-trip as null, without defaults", () => {
  const input = fixture();
  assert.deepEqual(validateBillingProfile(JSON.parse(JSON.stringify(validateBillingProfile(input)))).q1, input.q1);
  for (const key of Object.keys(input.q1)) {
    for (const value of [undefined, "flat", "monthly", false]) {
      const malformed = JSON.parse(JSON.stringify(input)); malformed.q1[key] = value;
      assert.throws(() => validateBillingProfile(malformed), /unresolved_q1/);
    }
  }
});

test("issued fee snapshot survives later rule edits using only bigint arithmetic", () => {
  const rule: { -readonly [K in keyof ExplicitPercentRule]: ExplicitPercentRule[K] } = {
    ruleId: "fee", versionId: "v1", rateBasisPoints: BigInt(1000), rounding: "half_up" };
  const january = issueFeeSnapshot(rule, BigInt(10000));
  const before = serializeFeeSnapshot(january);
  rule.versionId = "v2"; rule.rateBasisPoints = BigInt(1500);
  const february = issueFeeSnapshot(rule, BigInt(10000));
  assert.equal(january.amountMinor, BigInt(1000));
  assert.equal(february.amountMinor, BigInt(1500));
  assert.equal(serializeFeeSnapshot(january), before);
  assert.ok(Object.isFrozen(january));
  const huge = issueFeeSnapshot({ ...rule, rateBasisPoints: BigInt(10000) }, BigInt("9007199254740993"));
  assert.equal(huge.amountMinor, BigInt("9007199254740993"));
  assert.equal(JSON.parse(serializeFeeSnapshot(huge)).amountMinor, "9007199254740993");
  assert.equal(issueFeeSnapshot({ ...rule, rateBasisPoints: BigInt(5000) }, BigInt(1)).amountMinor, BigInt(1));
  assert.throws(() => issueFeeSnapshot(rule, BigInt(-1)), /invalid_minor/);
  assert.throws(() => issueFeeSnapshot({ ...rule, rateBasisPoints: 1500 as unknown as bigint }, BigInt(1)), /invalid_minor/);
  assert.throws(() => issueFeeSnapshot(rule, 100 as unknown as bigint), /invalid_minor/);
});
