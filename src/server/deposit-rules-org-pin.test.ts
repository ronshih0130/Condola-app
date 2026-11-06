import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

test("deposit policy action uses validated org and environment pins", () => {
  const source = readFileSync(new URL("./deposit-rules-actions.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function actionDepositPolicy(");
  assert.ok(start >= 0);
  const action = source.slice(start);
  assert.match(source, /import\s*\{\s*requireOrgScope\s*\}\s*from\s*"\.\/org-guard"/);
  assert.match(action, /const scope = requireOrgScope\(session\)/);
  const pin = action.indexOf("requireOrgScope(session)");
  const transaction = action.indexOf("tx(");
  assert.ok(transaction > pin);
  const beforePin = action.slice(0, pin);
  assert.match(beforePin, /if \(session\.kind !== "staff" \|\| !can\(session, "leases\.edit"\) \|\| session\.needsSandbox\) return null;/);
  assert.ok(beforePin.includes("if (!uuid.test(id)) return null;"));
  assert.match(beforePin, /if \(!input\.leaseId && .*\.test\(input\.startDate \?\? ""\)\) return null;/);
  const afterPin = action.slice(pin);
  assert.match(afterPin, /tx\(session\.userId,\s*async \(client\) =>/);
  assert.match(afterPin, /\[id,\s*scope\.orgId\]/);
  assert.match(afterPin, /\[id,\s*scope\.orgId,\s*input\.startDate\]/);
  assert.match(afterPin, /resolveDepositPolicy\(client,\s*scope\.orgId,\s*row\.rows\[0\]\.property_id,\s*row\.rows\[0\]\.on_date\)/);
  assert.match(afterPin, /\{\s*orgId:\s*scope\.orgId,\s*environment:\s*scope\.environment\s*\}/);
  assert.doesNotMatch(afterPin, /\bsession\.(?:orgId|environment)\b/);
  assert.doesNotMatch(action, /\bcatch\b/);
});

test("requireOrgScope preserves valid org and environment pins for deposit policy", () => {
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

test("requireOrgScope rejects invalid deposit policy scope with FlowError", () => {
  for (const orgId of ["", " ", null, undefined]) {
    const session = { orgId, environment: "live" } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
  for (const environment of ["", "production", null, undefined]) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
});
