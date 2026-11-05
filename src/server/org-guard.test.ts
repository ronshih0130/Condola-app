import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("requireOrgScope rejects missing, empty, and whitespace-only org IDs", () => {
  for (const orgId of [undefined, "", "   "]) {
    const invalid = { ...session("staff"), orgId } as Session;
    assert.throws(() => requireOrgScope(invalid), forbidden);
  }
});

test("requireOrgScope rejects missing and invalid environments", () => {
  for (const environment of ["", "prod", "LIVE", undefined]) {
    const invalid = { ...session("staff"), environment } as Session;
    assert.throws(() => requireOrgScope(invalid), forbidden);
  }
});

test("close and monthly preview request transactions use requireOrgScope", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    { path: "../app/m/close/page.tsx", calls: 1 },
    { path: "monthly-billing-plan.ts", calls: 2 },
    { path: "monthly-rent-preview.ts", calls: 1 },
  ];
  for (const file of files) {
    const source = readFileSync(resolve(here, file.path), "utf8");
    assert.ok(source.includes("requireOrgScope(session)"), file.path);
    assert.equal(
      [...source.matchAll(/\btx\(session\.userId\b/g)].length,
      file.calls,
      `${file.path}: expected request transactions`,
    );
    assert.equal(
      [...source.matchAll(/,\s*requireOrgScope\(session\)\s*[,)]/g)].length,
      file.calls,
      `${file.path}: every request transaction must pass the guard as its scope`,
    );
  }
});
