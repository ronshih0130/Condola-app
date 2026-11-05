import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import { assertSameOrg, requireOrgScope } from "./org-guard";
import type { Session } from "./types";

function session(kind: Session["kind"], environment: Session["environment"] = "live"): Session {
  return {
    userId: "user",
    sessionId: "session",
    email: "person@example.test",
    name: "Test person",
    kind,
    role: kind === "staff" ? "manager" : null,
    orgId: environment === "sandbox" ? "sandbox-a" : "live-a",
    liveOrgId: "live-a",
    environment,
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

const fixtures = [
  { name: "staff live", value: session("staff"), orgId: "live-a", environment: "live" },
  { name: "staff sandbox", value: session("staff", "sandbox"), orgId: "sandbox-a", environment: "sandbox" },
  { name: "tenant", value: session("tenant"), orgId: "live-a", environment: "live" },
  { name: "owner", value: session("owner"), orgId: "live-a", environment: "live" },
] as const;

function forbidden(error: unknown): boolean {
  assert.ok(error instanceof FlowError);
  assert.equal(error.key, "errors.forbidden");
  assert.equal(error.message, "errors.forbidden");
  return true;
}

for (const fixture of fixtures) {
  test(`requireOrgScope maps ${fixture.name} to its session org and environment`, () => {
    assert.deepEqual(requireOrgScope(fixture.value), {
      orgId: fixture.orgId,
      environment: fixture.environment,
    });
  });

  test(`assertSameOrg accepts the same org for ${fixture.name}`, () => {
    assert.doesNotThrow(() => assertSameOrg(fixture.value, fixture.orgId));
  });

  test(`assertSameOrg rejects another org for ${fixture.name}`, () => {
    assert.throws(() => assertSameOrg(fixture.value, "foreign-org"), forbidden);
  });

  test(`assertSameOrg rejects missing orgs for ${fixture.name}`, () => {
    for (const orgId of [null, undefined, ""]) {
      assert.throws(() => assertSameOrg(fixture.value, orgId), forbidden);
    }
  });
}

test("assertSameOrg rejects the live firm when the session is in its sandbox", () => {
  const sandbox = session("staff", "sandbox");
  assert.throws(() => assertSameOrg(sandbox, sandbox.liveOrgId), forbidden);
});
