// PR-026 (a), Ron 2026-11-15 20:44 PT: anon/PUBLIC hold no table privileges on the nine auth-related tables,
// and an anon request is refused outright (not just filtered by RLS).
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";

const TABLES = ["auth_challenges", "auth_login_attempts", "auth_password_resets", "auth_sessions", "lease_signed_pdfs",
  "listing_terms", "month_closes", "sample_marks", "user_mfa"];
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db.end(); });

test("PR-026: anon and PUBLIC hold no privileges on the nine tables; RLS stays on", async () => {
  for (const t of TABLES) {
    const row = (await db.query(`SELECT c.relrowsecurity rls,
      has_table_privilege('anon', c.oid, 'SELECT') sel, has_table_privilege('anon', c.oid, 'INSERT') ins,
      has_table_privilege('anon', c.oid, 'UPDATE') upd, has_table_privilege('anon', c.oid, 'DELETE') del,
      has_table_privilege('anon', c.oid, 'TRUNCATE') trn, has_table_privilege('anon', c.oid, 'REFERENCES') ref,
      has_table_privilege('anon', c.oid, 'TRIGGER') trg,
      coalesce((SELECT bool_or(a.grantee = 0) FROM aclexplode(c.relacl) a), false) public_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`, [t])).rows[0];
    assert.ok(row, t);
    assert.deepEqual(row, { rls: true, sel: false, ins: false, upd: false, del: false, trn: false, ref: false, trg: false, public_grant: false }, t);
  }
});

test("PR-026: an anon request to each table is refused with 42501 (privilege, before RLS)", async () => {
  for (const t of TABLES) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query(`SELECT 1 FROM public.${t} LIMIT 1`), (e: unknown) => (e as { code?: string }).code === "42501", t);
    } finally { await db.query("ROLLBACK"); }
  }
});

test("PR-026: re-granting the Supabase defaults then applying the migration removes them (staging drift simulation)", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../../supabase/migrations/20261115190000_pr026_revoke_default_auth_grants.sql", import.meta.url), "utf8");
  await db.query("BEGIN");
  try {
    await db.query(`GRANT ALL ON TABLE ${TABLES.map(t => `public.${t}`).join(", ")} TO anon`);
    assert.equal((await db.query("SELECT has_table_privilege('anon','public.auth_sessions','SELECT') v")).rows[0].v, true);
    await db.query(sql);
    for (const t of TABLES)
      assert.equal((await db.query("SELECT has_table_privilege('anon', $1::regclass, 'SELECT') v", [`public.${t}`])).rows[0].v, false, t);
  } finally { await db.query("ROLLBACK"); }
});
