// PR-029 (a), Ron 2026-11-16: tables the postgres role creates in public no longer get anon/PUBLIC grants by
// default. CI has no postgres role, so the test creates one inside a rolled-back transaction, re-creates
// Supabase's default grants for it, applies the migration and checks a new probe table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";

const SQL = readFileSync(new URL("../../supabase/migrations/20261116120000_pr029_default_privileges.sql", import.meta.url), "utf8");
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db.end(); });

const anonDefault = async () => (await db.query(`SELECT coalesce(bool_or(a.grantee = 'anon'::regrole), false) anon,
    coalesce(bool_or(a.grantee = 0), false) pub, coalesce(bool_or(a.grantee = 'authenticated'::regrole), false) auth,
    coalesce(bool_or(a.grantee = 'service_role'::regrole), false) svc
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'`)).rows[0];

async function probe(name: string) {
  await db.query("SET LOCAL ROLE postgres");
  await db.query(`CREATE TABLE public.${name} (id int)`);
  await db.query("RESET ROLE");
  return (await db.query(`SELECT has_table_privilege('anon', $1::regclass, 'SELECT') sel, has_table_privilege('anon', $1::regclass, 'INSERT') ins,
      has_table_privilege('anon', $1::regclass, 'DELETE') del, has_table_privilege('authenticated', $1::regclass, 'SELECT') auth,
      coalesce((SELECT bool_or(a.grantee = 0) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = $1::regclass), false) pub`,
    [`public.${name}`])).rows[0];
}

test("PR-029: with Supabase-style defaults, new postgres tables lose anon/PUBLIC grants after the migration; authenticated kept", async () => {
  await db.query("BEGIN");
  try {
    const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'postgres'")).rowCount;
    if (!exists) await db.query("CREATE ROLE postgres NOLOGIN");
    await db.query("GRANT CREATE ON SCHEMA public TO postgres");
    await db.query("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role, PUBLIC");
    assert.deepEqual(await probe("pr029_probe_before"), { sel: true, ins: true, del: true, auth: true, pub: true }, "simulation grants anon first");

    await db.query(SQL);
    assert.deepEqual(await anonDefault(), { anon: false, pub: false, auth: true, svc: true });
    assert.deepEqual(await probe("pr029_probe_after"), { sel: false, ins: false, del: false, auth: true, pub: false });
    await db.query("SAVEPOINT anon_probe");
    await db.query("SET LOCAL ROLE anon");
    await assert.rejects(db.query("SELECT 1 FROM public.pr029_probe_after"), (e: unknown) => (e as { code?: string }).code === "42501");
    await db.query("ROLLBACK TO SAVEPOINT anon_probe");
    await db.query("RESET ROLE");
    // Tables that existed before keep their grants: the migration only changes defaults.
    assert.equal((await db.query("SELECT has_table_privilege('anon', 'public.pr029_probe_before', 'SELECT') v")).rows[0].v, true);
    // Applying it twice is harmless.
    await db.query(SQL);
  } finally { await db.query("ROLLBACK"); }
});

test("PR-029: on a database without a postgres role the migration is a no-op and does not fail", async () => {
  await db.query("BEGIN");
  try {
    const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'postgres'")).rowCount;
    if (exists) return; // covered by the test above on Supabase-shaped databases
    const before = (await db.query("SELECT count(*)::int n FROM pg_default_acl")).rows[0].n;
    await db.query(SQL);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_default_acl")).rows[0].n, before);
  } finally { await db.query("ROLLBACK"); }
});
