import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

test("payee settings labels use the validated org in a session transaction", () => {
  const source = readFileSync(new URL("./payee.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function payeeSettings(");
  const end = source.indexOf("export async function tenantPayee(", start);
  assert.ok(start >= 0 && end > start);
  const settings = source.slice(start, end);
  assert.match(settings, /requireOrgScope\(session\)/);
  assert.ok(settings.indexOf("requireOrgScope(session)") < settings.indexOf("SELECT l.id"));
  assert.match(settings, /txForSession\(session,/);
  assert.match(settings, /WHERE l\.org_id=\$1 AND l\.id=ANY\(\$2::uuid\[\]\)/);
  assert.match(settings, /\[orgId, data\.leases\.map\(lease => lease\.id\)\]/);
  assert.match(settings, /\{ readOnly: true \}/);
  assert.doesNotMatch(settings, /\[session\.orgId,/);
});

test("requireOrgScope preserves valid org and environment pins", () => {
  for (const environment of ["live", "sandbox"] as const) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as Session;
    assert.deepEqual(requireOrgScope(session), {
      orgId: session.orgId,
      environment,
    });
  }
});

test("requireOrgScope rejects empty orgs and invalid environments with FlowError", () => {
  for (const orgId of ["", " ", null, undefined]) {
    const session = { orgId, environment: "live" } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
  for (const environment of ["", "production", null, undefined]) {
    const session = { orgId: "10000000-0000-4000-8000-000000000001", environment } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
});
