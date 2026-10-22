import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
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
  assert.match(roleSql, /NOBYPASSRLS/);
  assert.match(roleSql, /NOINHERIT/);
  assert.match(roleSql, /NOSUPERUSER/);
  assert.match(roleSql, /GRANT authenticated TO condola_hyperdrive/);
  assert.equal(/GRANT\s+service_role/i.test(roleSql), false);
  assert.equal(/password/i.test(roleSql), false);
  assert.equal(roleSql.includes("postgres://"), false);
  assert.equal(/NOT NULL|ADD CONSTRAINT|ALTER TABLE|DROP |DELETE FROM|TRUNCATE/i.test(roleSql), false);
  const migrate = readFileSync(new URL("../../scripts/db-migrate.sh", import.meta.url), "utf8");
  assert.match(migrate, /supabase\/migrations\/\*\.sql/);
  assert.equal(migrate.includes("supabase/ops"), false);
});
