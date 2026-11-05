import assert from "node:assert/strict";
import test from "node:test";
import {
  planVendorAttribution,
  type VendorAttributionSource,
} from "./vendor-attribution";
import type { VendorIdentityResolution } from "./vendor-identity";
import type { VendorLinkCapability } from "./vendor-link-rules";

const now = new Date("2026-11-05T12:00:00Z");
const resolution: VendorIdentityResolution = Object.freeze({
  kind: "vendor",
  jobId: "job-a",
  orgId: "org-a",
  ticketId: "ticket-a",
  capability: "write",
  tokenHash: "a".repeat(64),
  linkable: true,
});
const sources: VendorAttributionSource[] = [
  "first_temp", "emergency", "existing_open", "unspecified",
];

test("gate, linkability and user presence follow the exact precedence matrix", () => {
  const capabilities: VendorLinkCapability[] = ["write", "read_only", "invalid"];
  const resolutions: Array<VendorIdentityResolution | null> = [
    null,
    ...capabilities.flatMap((capability) =>
      [false, true].map((linkable) => ({ ...resolution, capability, linkable })),
    ),
  ];
  for (const candidate of resolutions) {
    for (const userId of [null, "", "user-a"]) {
      for (const gateOn of [false, true]) {
        for (const source of sources) {
          const plan = planVendorAttribution(candidate, userId, now, gateOn, source);
          const label = JSON.stringify({ candidate, userId, gateOn, source });
          if (!gateOn) {
            assert.deepEqual(plan, { status: "gated" }, label);
          } else if (candidate === null || !candidate.linkable) {
            assert.deepEqual(plan, { status: "not_linkable" }, label);
          } else if (userId === null || userId === "") {
            assert.deepEqual(plan, { status: "no_user" }, label);
          } else {
            assert.deepEqual(plan, {
              status: "attributable",
              record: {
                jobId: candidate.jobId,
                orgId: candidate.orgId,
                ticketId: candidate.ticketId,
                userId,
                tokenHash: candidate.tokenHash,
                capabilityAtWrite: candidate.capability,
                linkableAtWrite: candidate.linkable,
                plannedAt: now,
                source,
              },
            }, label);
          }
        }
      }
    }
  }
});

test("default source and copied fields do not mutate inputs or expose Session fields", () => {
  const before = { ...resolution };
  const timestamp = now.getTime();
  const plan = planVendorAttribution(resolution, "user-a", now, true);
  assert.equal(plan.status, "attributable");
  if (plan.status !== "attributable") assert.fail("Expected an attribution record");
  assert.equal(plan.record.source, "unspecified");
  assert.equal(plan.record.plannedAt, now);
  assert.deepEqual(Object.keys(plan).sort(), ["record", "status"]);
  // userId and orgId are intentional record fields; no Session shape is returned.
  assert.deepEqual(Object.keys(plan.record).sort(), [
    "capabilityAtWrite", "jobId", "linkableAtWrite", "orgId", "plannedAt",
    "source", "ticketId", "tokenHash", "userId",
  ]);
  assert.deepEqual(resolution, before);
  assert.equal(now.getTime(), timestamp);
  assert.deepEqual(planVendorAttribution(resolution, "user-a", now, true), plan);
});

test("coexisting tokens retain their own hashes and explicit sources", () => {
  const candidates = sources.slice(0, 3).map((source, index) => ({
    source,
    resolution: { ...resolution, tokenHash: String(index + 1).repeat(64) },
  }));
  const plans = candidates.map((candidate) =>
    planVendorAttribution(candidate.resolution, "user-a", now, true, candidate.source),
  );
  for (const [index, plan] of plans.entries()) {
    assert.equal(plan.status, "attributable");
    if (plan.status !== "attributable") assert.fail("Expected an attribution record");
    assert.equal(plan.record.tokenHash, candidates[index].resolution.tokenHash);
    assert.equal(plan.record.source, candidates[index].source);
    assert.equal(plan.record.jobId, resolution.jobId);
    assert.equal(plan.record.orgId, resolution.orgId);
    assert.equal(plan.record.ticketId, resolution.ticketId);
  }
});
