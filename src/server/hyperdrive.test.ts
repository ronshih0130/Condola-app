import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import type { Client } from "pg";
import { resetHyperdriveCache, setDbClientFactoryForTests, tx, useHyperdriveForTests } from "./db";
import { preambleSql, selectConnectionString, SET_ROLE_SQL } from "./hyperdrive";

const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
const db = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
const roleSql = readFileSync(new URL("../../supabase/migrations/20261029130000_condola_hyperdrive_role.sql", import.meta.url), "utf8");

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return source.slice(from, to);
}

test("reads use Hyperdrive only when the binding is present", () => {
  const pooled = "postgres://condola_hyperdrive@hyperdrive.local/postgres";
  const direct = "postgres://condola@127.0.0.1:5432/condola";
  assert.equal(selectConnectionString("read", direct, pooled), pooled);
  assert.equal(selectConnectionString("read", direct, "  "), direct);
  assert.equal(selectConnectionString("read", direct, undefined), direct);
  assert.equal(selectConnectionString("primary", direct, pooled), direct);
  assert.throws(() => selectConnectionString("read", "  ", undefined), /both unset/);
  assert.throws(() => selectConnectionString("primary", undefined, pooled), /DATABASE_URL is not set/);
});

test("session claims are one simple-protocol batch of quoted literals", () => {
  const org = "10000000-0000-4000-8000-000000000001";
  const user = "20000000-0000-4000-8000-000000000001";
  const claim = preambleSql({ userId: user, role: "authenticated", pin: { orgId: org, environment: "live" }, begin: true });
  assert.match(claim, /^BEGIN; SELECT set_config\('request\.jwt\.claim\.role', 'authenticated', true\)/);
  assert.match(claim, new RegExp(`set_config\\('request\\.jwt\\.claim\\.sub', '${user}', true\\)`));
  assert.match(claim, new RegExp(`set_config\\('app\\.active_org_id', '${org}', true\\)`));
  assert.match(claim, /set_config\('app\.env', 'live', true\)/);
  assert.match(claim, /SET LOCAL ROLE authenticated;$/);
  assert.equal(claim.includes("$1"), false);
  assert.equal(SET_ROLE_SQL.authenticated, "SET LOCAL ROLE authenticated");
  assert.equal(SET_ROLE_SQL.service_role, "SET LOCAL ROLE service_role");
  const service = preambleSql({ userId: null, role: "service_role", begin: false });
  assert.equal(service.startsWith("BEGIN"), false);
  assert.match(service, /SET LOCAL ROLE service_role;$/);
  assert.throws(() => preambleSql({ userId: "not-a-uuid'; drop table leases;--", role: "authenticated", begin: true }), /session claim/);
  assert.throws(
    () => preambleSql({ userId: user, role: "authenticated", pin: { orgId: org, environment: "staging" }, begin: true }),
    /environment/,
  );
});

test("authenticated reads can use Hyperdrive and service_role stays on DATABASE_URL", () => {
  assert.match(db, /hyperdriveConnectionString/);
  assert.match(db, /preambleSql/);
  assert.match(db, /return hyperdriveTx/);
  assert.match(db, /return legacyTx/);
  const hyperdrive = between(db, "async function hyperdriveTx", "export async function tx");
  assert.match(hyperdrive, /"read"/);
  assert.match(hyperdrive, /role: "authenticated"/);
  const legacy = between(db, "async function legacyTx", "async function lookupPin");
  assert.match(legacy, /SET LOCAL ROLE authenticated/);
  assert.equal(legacy.includes('"read"'), false);
  const svc = db.slice(db.indexOf("export async function svc"));
  assert.equal(svc.includes('"read"'), false);
  assert.match(svc, /service_role/);
  assert.match(queries, /export async function searchLeases/);
  assert.match(queries, /tx\(/);
  assert.equal(queries.includes("hyperdrive"), false);
  assert.equal(queries.includes("pagedListSql"), false);
});

test("the Hyperdrive login migration is additive and is not granted service_role", () => {
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const roleName = "20261029130000_condola_hyperdrive_role.sql";
  assert.equal(names.includes(roleName), true);
  assert.equal(roleName.startsWith("20261026130000"), false);
  assert.ok(names.includes("20261027130000_lease_idempotency_key.sql"));
  assert.ok(roleName > "20261027130000_lease_idempotency_key.sql");
  const flags = ["NOSUPERUSER", "NOBYPASSRLS", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION", "LOGIN", "NOINHERIT"];
  const create = between(roleSql, "CREATE ROLE condola_hyperdrive", "ELSE");
  const alter = between(roleSql, "ALTER ROLE condola_hyperdrive", "END IF");
  for (const branch of [create, alter]) {
    for (const flag of flags) assert.match(branch, new RegExp(`\\b${flag}\\b`));
    assert.equal(/\bSUPERUSER\b/.test(branch), false);
    assert.equal(/\bBYPASSRLS\b/.test(branch), false);
    assert.equal(/\bCREATEDB\b/.test(branch), false);
    assert.equal(/\bCREATEROLE\b/.test(branch), false);
    assert.equal(/\bREPLICATION\b/.test(branch), false);
    assert.equal(/\bINHERIT\b/.test(branch), false);
  }
  assert.match(roleSql, /GRANT CONNECT ON DATABASE %I TO condola_hyperdrive/);
  assert.match(roleSql, /GRANT USAGE ON SCHEMA public TO condola_hyperdrive/);
  assert.match(roleSql, /GRANT authenticated TO condola_hyperdrive/);
  assert.equal(/GRANT\s+service_role/i.test(roleSql), false);
  assert.equal(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL|TRUNCATE|REFERENCES|TRIGGER)\b/i.test(roleSql), false);
  assert.equal(/ON TABLE/i.test(roleSql), false);
  assert.equal(/password/i.test(roleSql), false);
  assert.equal(roleSql.includes("postgres://"), false);
  assert.equal(/NOT NULL|ADD CONSTRAINT|ALTER TABLE|DROP |DELETE FROM|TRUNCATE/i.test(roleSql), false);
  const migrate = readFileSync(new URL("../../scripts/db-migrate.sh", import.meta.url), "utf8");
  assert.match(migrate, /supabase\/migrations\/\*\.sql/);
  assert.equal(migrate.includes("supabase/ops"), false);

  const probe = readFileSync(new URL("./hyperdrive-role.integration.test.ts", import.meta.url), "utf8");
  assert.match(probe, /rolsuper/);
  assert.match(probe, /rolbypassrls/);
  assert.match(probe, /SET LOCAL ROLE condola_hyperdrive/);
  assert.match(probe, /SET LOCAL ROLE authenticated/);
  assert.match(probe, /ORG_ID/);
  assert.match(probe, /ORG2_ID/);
  assert.match(probe, /leaseCount\(ORG2_ID\), 0/);
  assert.match(probe, /leaseCount\(ORG_ID\), 0/);
});

test("a reused Hyperdrive connection drops the previous user's transaction settings", async () => {
  const userA = "20000000-0000-4000-8000-000000000001";
  const userB = "20000000-0000-4000-8000-000000000009";
  const orgA = "10000000-0000-4000-8000-000000000001";
  const orgB = "10000000-0000-4000-8000-000000000002";
  const session = new Map<string, { value: string; local: boolean }>();
  let role: string | null = null;
  let inTx = false;
  const queries: string[] = [];

  function clearLocal() {
    for (const [key, entry] of session) {
      if (entry.local) session.delete(key);
    }
    role = null;
    inTx = false;
  }

  function apply(sql: string) {
    for (const part of sql.split(";").map((statement) => statement.trim()).filter(Boolean)) {
      if (/^BEGIN\b/i.test(part)) {
        if (inTx) throw new Error("BEGIN inside an open transaction");
        inTx = true;
        continue;
      }
      if (/^COMMIT\b/i.test(part) || /^ROLLBACK\b/i.test(part)) {
        if (!inTx) throw new Error("COMMIT outside a transaction");
        clearLocal();
        continue;
      }
      const roleMatch = /^SET LOCAL ROLE\s+(\S+)/i.exec(part);
      if (roleMatch) {
        if (!inTx) throw new Error("SET LOCAL ROLE outside a transaction");
        role = roleMatch[1];
        continue;
      }
      const configs = [...part.matchAll(/set_config\('([^']+)', '([^']*)', (true|false)\)/gi)];
      if (configs.length === 0) continue;
      if (!inTx) throw new Error("set_config outside a transaction");
      for (const config of configs) {
        session.set(config[1], { value: config[2], local: config[3] === "true" });
      }
    }
  }

  const client = {
    async query(sql: string) {
      queries.push(sql);
      apply(sql);
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  } as unknown as Client;
  useHyperdriveForTests("postgres://condola_hyperdrive@hyperdrive.local/postgres");
  setDbClientFactoryForTests(async () => client);
  try {
    const first = await tx(
      userA,
      async () => ({
        sub: session.get("request.jwt.claim.sub")?.value,
        org: session.get("app.active_org_id")?.value,
        roleClaim: session.get("request.jwt.claim.role")?.value,
        env: session.get("app.env")?.value,
        local: [...session.values()].every((entry) => entry.local),
        role,
      }),
      { orgId: orgA, environment: "live" },
    );
    assert.equal(first.sub, userA);
    assert.equal(first.org, orgA);
    assert.equal(first.roleClaim, "authenticated");
    assert.equal(first.env, "live");
    assert.equal(first.local, true);
    assert.equal(first.role, "authenticated");
    assert.equal(session.size, 0);
    assert.equal(role, null);

    const second = await tx(
      userB,
      async () => ({
        sub: session.get("request.jwt.claim.sub")?.value,
        org: session.get("app.active_org_id")?.value,
        role,
        leakedUser: [...session.values()].some((entry) => entry.value === userA),
        leakedOrg: [...session.values()].some((entry) => entry.value === orgA),
      }),
      { orgId: orgB, environment: "sandbox" },
    );
    assert.equal(second.sub, userB);
    assert.equal(second.org, orgB);
    assert.equal(second.role, "authenticated");
    assert.equal(second.leakedUser, false);
    assert.equal(second.leakedOrg, false);

    const preambles = queries.filter((sql) => sql.startsWith("BEGIN"));
    assert.equal(preambles.length, 2);
    assert.match(preambles[0], new RegExp(`set_config\\('request\\.jwt\\.claim\\.sub', '${userA}', true\\)`));
    assert.match(preambles[0], /set_config\('request\.jwt\.claim\.role', 'authenticated', true\)/);
    assert.match(preambles[0], new RegExp(`set_config\\('app\\.active_org_id', '${orgA}', true\\)`));
    assert.match(preambles[0], /set_config\('app\.env', 'live', true\)/);
    assert.match(preambles[0], /SET LOCAL ROLE authenticated/);
    assert.equal(preambles[0].includes(userB), false);
    assert.match(preambles[1], new RegExp(`set_config\\('request\\.jwt\\.claim\\.sub', '${userB}', true\\)`));
    assert.match(preambles[1], new RegExp(`set_config\\('app\\.active_org_id', '${orgB}', true\\)`));
    assert.match(preambles[1], /set_config\('app\.env', 'sandbox', true\)/);
    assert.match(preambles[1], /SET LOCAL ROLE authenticated/);
    assert.equal(preambles[1].includes(userA), false);
    assert.equal(preambles[1].includes(orgA), false);
    const commitAt = queries.indexOf("COMMIT");
    const secondAt = queries.indexOf(preambles[1]);
    assert.ok(commitAt > queries.indexOf(preambles[0]) && commitAt < secondAt);
  } finally {
    resetHyperdriveCache();
  }
});
