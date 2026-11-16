// LPQ-21 / B-108, Ron 2026-11-16: anon/PUBLIC hold no privilege on public sequences, existing or new.
// CI has no postgres role, so the default-privilege half is proven inside a rolled-back transaction that creates
// one and re-creates Supabase's default sequence grants for it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";

const SQL = readFileSync(new URL("../../supabase/migrations/20261116150000_lpq21_sequence_grants.sql", import.meta.url), "utf8");
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db.end(); });

const seqPrivs = async (name: string) => (await db.query(`SELECT has_sequence_privilege('anon', $1::regclass, 'USAGE') usage,
    has_sequence_privilege('anon', $1::regclass, 'SELECT') sel, has_sequence_privilege('anon', $1::regclass, 'UPDATE') upd,
    has_sequence_privilege('authenticated', $1::regclass, 'USAGE') auth,
    coalesce((SELECT bool_or(a.grantee = 0) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = $1::regclass), false) pub`,
  [name])).rows[0];

test("LPQ-21: no public sequence grants anon or PUBLIC anything; anon nextval is refused", async () => {
  const seqs = (await db.query("SELECT format('%I.%I', n.nspname, c.relname) name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")).rows.map(r => r.name as string);
  for (const s of seqs) {
    const p = await seqPrivs(s);
    assert.deepEqual([p.usage, p.sel, p.upd, p.pub], [false, false, false, false], s);
  }
  if (seqs.length) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query("SELECT nextval($1::regclass)", [seqs[0]]), (e: unknown) => (e as { code?: string }).code === "42501");
    } finally { await db.query("ROLLBACK"); }
  }
});

test("LPQ-21: Supabase-style grants on an existing and a new postgres sequence are removed; authenticated kept; idempotent", async () => {
  await db.query("BEGIN");
  try {
    if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'postgres'")).rowCount) await db.query("CREATE ROLE postgres NOLOGIN");
    await db.query("GRANT CREATE ON SCHEMA public TO postgres");
    await db.query("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role, PUBLIC");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("CREATE SEQUENCE public.lpq21_existing");
    await db.query("RESET ROLE");
    assert.deepEqual(await seqPrivs("public.lpq21_existing"), { usage: true, sel: true, upd: true, auth: true, pub: true }, "simulation grants anon first");

    await db.query(SQL);
    assert.deepEqual(await seqPrivs("public.lpq21_existing"), { usage: false, sel: false, upd: false, auth: true, pub: false });
    await db.query("SET LOCAL ROLE postgres");
    await db.query("CREATE SEQUENCE public.lpq21_new");
    await db.query("RESET ROLE");
    assert.deepEqual(await seqPrivs("public.lpq21_new"), { usage: false, sel: false, upd: false, auth: true, pub: false });
    const dflt = (await db.query(`SELECT coalesce(bool_or(a.grantee = 'anon'::regrole), false) anon, coalesce(bool_or(a.grantee = 0), false) pub,
        coalesce(bool_or(a.grantee = 'authenticated'::regrole), false) auth
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'S'`)).rows[0];
    assert.deepEqual(dflt, { anon: false, pub: false, auth: true });
    await db.query(SQL);
  } finally { await db.query("ROLLBACK"); }
});
