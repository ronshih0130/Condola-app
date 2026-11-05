import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { txForSession } from "./org-guard";
import type { Session } from "./types";

const enabled = process.env.CONDOLA_RLS_DISPOSABLE === "YES";

test("txForSession pins the session org and environment for staff and portal sessions", {
  skip: enabled ? false : "Requires CONDOLA_RLS_DISPOSABLE=YES and a disposable DATABASE_URL",
}, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");

  // Synthetic UUIDs suffice: this checks transaction settings only, reads no
  // protected rows, and requires no seed users or organizations.
  const liveOrgId = randomUUID();
  const sandboxOrgId = randomUUID();
  const cases = [
    { kind: "staff", environment: "live", orgId: liveOrgId },
    { kind: "staff", environment: "sandbox", orgId: sandboxOrgId },
    { kind: "tenant", environment: "live", orgId: liveOrgId },
    { kind: "owner", environment: "live", orgId: liveOrgId },
  ] as const;

  for (const fixture of cases) {
    const session: Session = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      email: "person@example.test",
      name: "Test person",
      kind: fixture.kind,
      role: fixture.kind === "staff" ? "manager" : null,
      orgId: fixture.orgId,
      liveOrgId,
      environment: fixture.environment,
      locale: "zh-TW",
      calendar: "gregorian",
      leaseId: null,
    };
    const pinned = await txForSession(session, async (client) => {
      const result = await client.query<{ org_id: string; environment: string }>(`
        SELECT current_setting('app.active_org_id', true) AS org_id,
               current_setting('app.env', true) AS environment
      `);
      return result.rows[0];
    }, { readOnly: true });

    assert.deepEqual(pinned, {
      org_id: session.orgId,
      environment: session.environment,
    }, `${fixture.kind} ${fixture.environment} must use the session scope`);
  }
});
