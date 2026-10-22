import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { preambleSql } from "./hyperdrive";
import { ORG2_ID, ORG_ID, USERS } from "./ids";

test("condola_hyperdrive is not superuser and RLS filters leases by org", async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    const role = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin, rolinherit
         FROM pg_roles
        WHERE rolname = 'condola_hyperdrive'`,
    );
    const row = role.rows[0];
    assert.ok(row, "condola_hyperdrive exists");
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolbypassrls, false);
    assert.equal(row.rolcreatedb, false);
    assert.equal(row.rolcreaterole, false);
    assert.equal(row.rolreplication, false);
    assert.equal(row.rolcanlogin, true);
    assert.equal(row.rolinherit, false);

    const tables = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM information_schema.role_table_grants
        WHERE grantee = 'condola_hyperdrive'`,
    );
    assert.equal(tables.rows[0]?.n, "0");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE condola_hyperdrive");
    await assert.rejects(
      () => client.query("SELECT org_id::text FROM leases LIMIT 1"),
      (error: { code?: string }) => error.code === "42501",
    );
    await client.query("ROLLBACK");

    async function leaseCount(orgId: string) {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM leases WHERE org_id = $1`, [orgId]);
      return Number(result.rows[0]?.n ?? 0);
    }

    async function asOrg(userId: string, orgId: string) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE condola_hyperdrive");
      const claim = preambleSql({
        userId,
        role: "authenticated",
        pin: { orgId, environment: "live" },
        begin: false,
      });
      assert.match(claim, /set_config\('request\.jwt\.claim\.sub', '[^']+', true\)/);
      assert.match(claim, /set_config\('app\.active_org_id', '[^']+', true\)/);
      assert.match(claim, /SET LOCAL ROLE authenticated/);
      await client.query(claim);
    }

    await asOrg(USERS.admin, ORG_ID);
    assert.ok(await leaseCount(ORG_ID) > 0);
    assert.equal(await leaseCount(ORG2_ID), 0);
    await client.query("ROLLBACK");

    await asOrg(USERS.coastAdmin, ORG2_ID);
    assert.ok(await leaseCount(ORG2_ID) > 0);
    assert.equal(await leaseCount(ORG_ID), 0);
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }
});
