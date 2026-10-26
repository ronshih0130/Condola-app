import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Client } from "pg";
import { buildStoredConsent, consentCoversCurrent } from "./consent";
import { withClient } from "./db";

const migration = readFileSync(new URL("../../supabase/migrations/20261030150100_consents.sql", import.meta.url), "utf8");
const backfill = readFileSync(new URL("../../supabase/ops/consents_backfill.sql", import.meta.url), "utf8");
const current = buildStoredConsent("signup", new Date("2026-10-25T00:00:00Z"));
const stale = { ...current, terms_version: "old", privacy_version: "old" };

test("consents enforce RLS, append-only evidence, cascading user deletion and idempotent backfill", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const ids: string[] = [];
      async function user(app: unknown, meta: unknown = {}) {
        const id = randomUUID();
        await client.query(
          "INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data) VALUES ($1, $2, $3, $4)",
          [id, id + "@consents.example.com", JSON.stringify(app), JSON.stringify(meta)],
        );
        ids.push(id);
        return id;
      }
      const own = await user({ consent: current });
      const other = await user({ consent: stale });
      await user({}, { consent: current });
      await user({}, { terms_accepted_at: current.accepted_at, terms_version: current.terms_version, privacy_version: current.privacy_version });
      for (const bad of [
        null, [], "current", { ...current, accepted_at: "bad-date" },
        { ...current, accepted_at: "" }, { ...current, terms_version: " " },
        { ...current, privacy_version: 12 }, { ...current, source: "client" },
        ...["now", "tomorrow", "infinity", "2026-13-01T00:00:00Z",
          "2026-10-25T00:00:00", "2026-10-25"]
          .map((accepted_at) => ({ ...current, accepted_at })),
      ]) await user({ consent: bad });
      // Run both actual files twice, including migration DDL and privilege resets.
      for (let attempt = 0; attempt < 2; attempt++) {
        await client.query(migration);
        assert.equal((await client.query("SHOW lock_timeout")).rows[0].lock_timeout, "5s");
        assert.equal((await client.query("SHOW statement_timeout")).rows[0].statement_timeout, "30s");
        await client.query(backfill);
        const rows = await client.query<{ user_id: string; terms_version: string }>(
          "SELECT user_id::text, terms_version FROM public.consents WHERE user_id = ANY($1::uuid[]) ORDER BY user_id", [ids]);
        assert.equal(rows.rowCount, 2);
        assert.equal(rows.rows.find((row) => row.user_id === own)?.terms_version, current.terms_version);
        assert.equal(rows.rows.find((row) => row.user_id === other)?.terms_version, "old");
      }
      async function asRole<T>(role: "authenticated" | "anon" | "service_role", id: string, run: (db: Client) => Promise<T>) {
        await client.query("SAVEPOINT role_check");
        try {
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [id]);
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role })]);
          return await run(client);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT role_check");
          await client.query("RELEASE SAVEPOINT role_check");
        }
      }
      const ownRows = await asRole("authenticated", own, (db) => db.query(
        "SELECT user_id::text FROM public.consents WHERE user_id = ANY($1::uuid[])", [ids]));
      assert.deepEqual(ownRows.rows, [{ user_id: own }]);
      await assert.rejects(asRole("anon", own, (db) => db.query("SELECT * FROM public.consents")), /permission denied/i);
      const insert = "INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source) VALUES ($1, now(), 'new', 'new', 'portal') RETURNING user_id::text";
      for (const sql of [
        insert, "UPDATE public.consents SET terms_version = 'forged' WHERE user_id = $1",
        "DELETE FROM public.consents WHERE user_id = $1",
      ]) {
        await assert.rejects(asRole("authenticated", own, (db) => db.query(sql, [own])), /permission denied/i);
      }
      await asRole("service_role", own, async (db) => {
        assert.equal((await db.query(insert, [own])).rows[0].user_id, own);
        assert.equal((await db.query("SELECT * FROM public.consents WHERE user_id = $1", [own])).rowCount, 2);
      });
      for (const sql of [
        "UPDATE public.consents SET terms_version = 'forged'",
        "DELETE FROM public.consents", "TRUNCATE public.consents",
      ]) {
        await assert.rejects(asRole("service_role", own, (db) => db.query(sql)), /permission denied/i);
        // Owner/superuser has grants and bypasses RLS: these must hit the triggers.
        await client.query("SAVEPOINT trigger_check");
        await assert.rejects(client.query(sql), /consents are append-only/i);
        await client.query("ROLLBACK TO SAVEPOINT trigger_check");
        await client.query("RELEASE SAVEPOINT trigger_check");
      }
      const privileges = await client.query<{ role: string; allowed: boolean }>(
        "SELECT role, has_function_privilege(role, 'public.consents_append_only()', 'EXECUTE') AS allowed FROM unnest(ARRAY['anon','authenticated','service_role']) AS role");
      assert.ok(privileges.rows.every((row) => row.allowed === false));
      const publicGrant = await client.query(
        "SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = 'public.consents_append_only()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'");
      assert.equal(publicGrant.rowCount, 0);
      // An older matching row cannot override a later stale acceptance.
      await client.query(
        "INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source, recorded_at) VALUES ($1, now(), 'old', 'old', 'reconsent', now() + interval '1 second')", [own]);
      const latest = await client.query<typeof current>(
        "SELECT accepted_at::text, terms_version, privacy_version, source FROM public.consents WHERE user_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1", [own]);
      assert.equal(consentCoversCurrent(latest.rows[0]), false);
      await client.query("DELETE FROM auth.users WHERE id = $1", [own]);
      assert.equal((await client.query("SELECT 1 FROM public.consents WHERE user_id = $1", [own])).rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("both backfills skip a candidate whose parent disappeared and continue", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const missing = randomUUID();
      const surviving = randomUUID();
      await client.query(
        "INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ($1, $2, $3)",
        [surviving, surviving + "@consents.example.com", JSON.stringify({ consent: current })],
      );
      // Inject the stale snapshot row deterministically. Its INSERT must hit
      // the real FK, and the following valid candidate must still be inserted.
      for (const file of [migration, backfill]) {
        await client.query("SAVEPOINT backfill_file");
        try {
          const sql = file.replace(
            "SELECT id, raw_app_meta_data -> 'consent' AS value FROM auth.users",
            `SELECT id, value FROM (
               SELECT '${missing}'::uuid AS id, '${JSON.stringify(current)}'::jsonb AS value, 0 AS position
               UNION ALL
               SELECT id, raw_app_meta_data -> 'consent', 1 FROM auth.users
             ) candidates ORDER BY position`,
          );
          assert.notEqual(sql, file);
          for (let attempt = 0; attempt < 2; attempt++) {
            await client.query(sql);
            assert.equal((await client.query(
              "SELECT 1 FROM public.consents WHERE user_id = $1", [missing])).rowCount, 0);
            assert.equal((await client.query(
              "SELECT 1 FROM public.consents WHERE user_id = $1", [surviving])).rowCount, 1);
          }
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT backfill_file");
          await client.query("RELEASE SAVEPOINT backfill_file");
        }
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
