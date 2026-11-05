import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
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

test("ROLLBACK clears transaction-local org settings on the same connection", {
  skip: enabled ? false : "Requires CONDOLA_RLS_DISPOSABLE=YES and a disposable DATABASE_URL",
}, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const orgId = randomUUID();
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.active_org_id', $1, true), set_config('app.env', $2, true)",
      [orgId, "live"],
    );
    const pinned = await client.query<{
      org_id: string | null;
      environment: string | null;
    }>(`
      SELECT current_setting('app.active_org_id', true) AS org_id,
             current_setting('app.env', true) AS environment
    `);
    assert.deepEqual(pinned.rows[0], { org_id: orgId, environment: "live" });

    await client.query("ROLLBACK");

    const cleared = await client.query<{
      org_id: string | null;
      environment: string | null;
    }>(`
      SELECT current_setting('app.active_org_id', true) AS org_id,
             current_setting('app.env', true) AS environment
    `);
    assert.ok(cleared.rows[0].org_id === null || cleared.rows[0].org_id === "");
    assert.ok(
      cleared.rows[0].environment === null || cleared.rows[0].environment === "",
    );
  } finally {
    await client.end();
  }
});

test("an org-A session cannot read an org-B membership row", {
  skip: enabled ? false : "Requires CONDOLA_RLS_DISPOSABLE=YES and a disposable DATABASE_URL",
}, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const sessionA: Session = {
    userId: userA,
    sessionId: randomUUID(),
    email: `${userA}@example.test`,
    name: "Org A manager",
    kind: "staff",
    role: "manager",
    orgId: orgA,
    liveOrgId: orgA,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };

  try {
    await client.connect();
    // Owner inserts use autocommit so txForSession can see the fixtures.
    for (const id of [userA, userB]) {
      await client.query(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)",
        [id, `${id}@example.test`],
      );
    }
    for (const id of [orgA, orgB]) {
      await client.query(
        "INSERT INTO organizations (id, name, country_code, default_currency) VALUES ($1, $2, 'TW', 'TWD')",
        [id, id],
      );
    }
    await client.query(
      "INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active'), ($3, $4, 'manager', 'active')",
      [orgA, userA, orgB, userB],
    );

    const otherMembership = await client.query(
      "SELECT org_id FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgB, userB],
    );
    assert.equal(otherMembership.rowCount, 1, "owner must see the committed org-B membership");

    await txForSession(sessionA, async (scopedClient) => {
      const ownMembership = await scopedClient.query(
        "SELECT org_id FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgA, userA],
      );
      assert.equal(ownMembership.rowCount, 1, "org-A session must see its own membership");

      const foreignMembership = await scopedClient.query(
        "SELECT org_id FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgB, userB],
      );
      assert.equal(foreignMembership.rowCount, 0, "org-A session must not see org-B membership");
    }, { readOnly: true });
  } finally {
    try {
      await client.query(
        "DELETE FROM org_members WHERE org_id IN ($1, $2)",
        [orgA, orgB],
      );
      await client.query(
        "DELETE FROM organizations WHERE id IN ($1, $2)",
        [orgA, orgB],
      );
      await client.query(
        "DELETE FROM auth.users WHERE id IN ($1, $2)",
        [userA, userB],
      );
    } finally {
      await client.end();
    }
  }
});
