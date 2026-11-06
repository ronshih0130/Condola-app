import assert from "node:assert/strict";
import test from "node:test";
import { effectivePartnerOverride, partnerControlEnabled, partnerRenewalTerm, validPartnerTerm, type PartnerOverride } from "./partner-controls-rules";
import { quoteMonthly } from "./billing";
const orgId = "11111111-1111-1111-1111-111111111111";
const platform = { enabled: true, allowed_org_ids: [orgId] };
const flags = { partner_unit_override: true };
const override: PartnerOverride = { kind: "unit_override", unitLimit: 20, startsAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", revision: 1, revoked: false };
const evaluate = (now: string, patch = {}) => effectivePartnerOverride({ orgId, platform, flags, override, kind: "unit_override", now: new Date(now), ...patch });

test("partner half-open term includes start and excludes exact expiry", () => {
  assert.equal(evaluate("2026-10-31T23:59:59.999Z"), null);
  assert.deepEqual(evaluate(override.startsAt), override);
  assert.deepEqual(evaluate("2026-11-30T23:59:59.999Z"), override);
  assert.equal(evaluate(override.expiresAt), null);
  assert.equal(evaluate("2026-12-01T00:00:00.001Z"), null);
});
test("kill, opt-out and malformed rollout config are OFF", () => {
  for (const value of [null, true, "on", [], {}, { enabled: "true", allowed_org_ids: [orgId] },
    { enabled: false, allowed_org_ids: [orgId] }, { enabled: true }, { enabled: true, allowed_org_ids: orgId },
    { enabled: true, allowed_org_ids: [orgId, null] }, { enabled: true, allowed_org_ids: [orgId, "bad"] },
    { enabled: true, allowed_org_ids: [] }]) {
    assert.equal(partnerControlEnabled(value, flags, orgId, "unit_override"), false);
    assert.equal(evaluate(override.startsAt, { platform: value }), null);
  }
  for (const value of [null, [], true, {}, { partner_unit_override: "true" }, { partner_unit_override: false }])
    assert.equal(evaluate(override.startsAt, { flags: value }), null);
});
test("malformed terms, revoked overrides and invalid bounds cannot be effective", () => {
  for (const patch of [{ revoked: true }, { revision: 0 }, { startsAt: "bad" }, { expiresAt: "infinity" },
    { expiresAt: override.startsAt }, { expiresAt: "2026-12-01T00:00:00.001Z" },
    { unitLimit: 0 }, { unitLimit: 10001 }, { unitLimit: 1.2 }, { unitLimit: null }])
    assert.equal(evaluate(override.startsAt, { override: { ...override, ...patch } }), null);
});
test("renewals allow at most 30 elapsed days including a DST boundary", () => {
  const now = new Date("2026-11-01T00:00:00-07:00");
  for (const days of [0, -1, 31, 1.5, NaN, Infinity]) assert.equal(partnerRenewalTerm(now, days), null);
  const term = partnerRenewalTerm(now, 30)!;
  assert.equal(Date.parse(term.expiresAt) - now.getTime(), 30 * 86400000);
  assert.equal(validPartnerTerm(term.startsAt, term.expiresAt), true);
});
test("billing keeps legacy quote byte-for-byte OFF and reverts at expiry", () => {
  const input = { units: 25, tier: "standard" as const, cycle: "month" as const, now: new Date(override.startsAt) };
  const old = quoteMonthly(input);
  assert.equal(JSON.stringify(quoteMonthly({ ...input, unitOverride: null })), JSON.stringify(old));
  assert.equal(quoteMonthly({ ...input, unitOverride: override }).monthly, 150);
  assert.deepEqual(quoteMonthly({ ...input, now: new Date(override.expiresAt), unitOverride: override }), old);
});
