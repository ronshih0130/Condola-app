import { cloneTestDatabase } from "./test-database-clone";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const target = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let FRESH_URL = target.href;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
const ADMIN_URL = withDatabase(target, "postgres");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const STUB = path.join(ROOT, "supabase/stub/supabase_stub.sql");
const UPGRADE_FILE = "20261022200000_tenant_id_check_upgrade.sql";
const OLD_FILE = "20261022180000_tenant_id_check.sql";
const SHOWN_SHA_FILE = "20261027120000_id_consent_shown_sha.sql";
const ANON_REVOKE_FILE = "20261027140000_id_anon_revoke.sql";
const CLOSED_EXECUTE = [
  "dedupe_live_identity_documents",
  "fn_id_access_log_guard",
  "fn_id_document_allow_log_delete",
  "fn_id_number_masked",
  "id_document_keep_days",
  "id_number_stored_mask",
] as const;
const PURGE_REVOKE_FILE = "20261021150000_revoke_purge_execute.sql";
const DEFINER = [
  "purge_due_identity_documents",
  "id_document_delete_after",
  "fn_link_orphan_id_document",
  "fn_id_document_delete_after",
  "fn_lease_refresh_id_delete_after",
] as const;

async function createScratchDb() {
  const name = `condola_id_${randomUUID().replaceAll("-", "")}`;
  const url = withDatabase(target, name);
  await withDb(ADMIN_URL, (client) => client.query(`CREATE DATABASE ${name}`));
  let created = true;
  return {
    url,
    async cleanup() {
      if (!created) return;
      await withDb(ADMIN_URL, (client) => client.query(`DROP DATABASE ${name}`));
      created = false;
    },
  };
}

function psql(databaseUrl: string, file: string) {
  execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function applyWatermarkMigrations() {
  psql(FRESH_URL, path.join(MIGRATIONS, "20261029150000_id_watermark_copy.sql"));
  psql(FRESH_URL, path.join(MIGRATIONS, "20261029160000_lease_close_end_date.sql"));
}

test.before(async () => {
  clone = await cloneTestDatabase();
  FRESH_URL = clone.url;
  applyWatermarkMigrations();
});

test.after(async () => {
  if (!clone) return;
  try {
    applyWatermarkMigrations();
  } finally {
    await clone.cleanup();
  }
});

async function withDb<T>(databaseUrl: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function assertShownNoticeColumns(databaseUrl: string) {
  await withDb(databaseUrl, async (client) => {
    const cols = await client.query<{ attname: string; attnotnull: boolean; typname: string; def: string | null }>(
      `SELECT a.attname, a.attnotnull, t.typname, pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'identity_documents'::regclass
          AND a.attname IN ('consent_full_text_sha256', 'consent_upload_text_sha256')
          AND NOT a.attisdropped
        ORDER BY a.attname`,
    );
    assert.deepEqual(
      cols.rows.map((row) => row.attname),
      ["consent_full_text_sha256", "consent_upload_text_sha256"],
    );
    for (const row of cols.rows) {
      assert.equal(row.attnotnull, false, row.attname);
      assert.equal(row.typname, "text", row.attname);
      assert.equal(row.def, null, row.attname);
    }
    const checks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'identity_documents'::regclass
          AND pg_get_constraintdef(oid) ~ 'consent_(full_text|upload_text)_sha256'`,
    );
    assert.equal(checks.rows.length, 0);
  });
}

async function assertAnonIdGrants(client: Client) {
    const tables = await client.query<{ relname: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; ref: boolean; trig: boolean }>(
      `SELECT c.relname,
              has_table_privilege('anon', c.oid, 'SELECT') AS sel,
              has_table_privilege('anon', c.oid, 'INSERT') AS ins,
              has_table_privilege('anon', c.oid, 'UPDATE') AS upd,
              has_table_privilege('anon', c.oid, 'DELETE') AS del,
              has_table_privilege('anon', c.oid, 'TRUNCATE') AS trunc,
              has_table_privilege('anon', c.oid, 'REFERENCES') AS ref,
              has_table_privilege('anon', c.oid, 'TRIGGER') AS trig
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('id_document_objects', 'id_document_wm_objects', 'identity_document_photos')
        ORDER BY c.relname`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.relname),
      ["id_document_objects", "id_document_wm_objects", "identity_document_photos"],
    );
    for (const row of tables.rows) {
      assert.equal(row.sel, false, row.relname);
      assert.equal(row.ins, false, row.relname);
      assert.equal(row.upd, false, row.relname);
      assert.equal(row.del, false, row.relname);
      assert.equal(row.trunc, false, row.relname);
      assert.equal(row.ref, false, row.relname);
      assert.equal(row.trig, false, row.relname);
    }
    const photos = await client.query<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('authenticated', 'identity_document_photos', 'SELECT') AS sel,
              has_table_privilege('authenticated', 'identity_document_photos', 'INSERT') AS ins,
              has_table_privilege('authenticated', 'identity_document_photos', 'UPDATE') AS upd,
              has_table_privilege('authenticated', 'identity_document_photos', 'DELETE') AS del`,
    );
    assert.equal(photos.rows[0]?.sel, true);
    assert.equal(photos.rows[0]?.ins, false);
    assert.equal(photos.rows[0]?.upd, false);
    assert.equal(photos.rows[0]?.del, false);
    const fns = await client.query<{ proname: string; anon: boolean; authn: boolean; pub: boolean; svc: boolean }>(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS authn,
              has_function_privilege('public', p.oid, 'execute') AS pub,
              has_function_privilege('service_role', p.oid, 'execute') AS svc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [["dedupe_live_identity_documents", "id_number_stored_mask"]],
    );
    assert.equal(fns.rows.length, 2);
    for (const row of fns.rows) {
      assert.equal(row.anon, false, row.proname);
      assert.equal(row.authn, false, row.proname);
      assert.equal(row.pub, false, row.proname);
      assert.equal(row.svc, true, row.proname);
    }
}

async function assertIdPhotoPrivileges(client: Client) {
  const tables = [
    "identity_documents",
    "identity_document_photos",
    "identity_document_access_log",
    "id_document_objects",
    "id_document_wm_objects",
    "id_upload_slots",
  ];
  const priv = await client.query<{
    relname: string;
    auth_sel: boolean;
    auth_ins: boolean;
    auth_upd: boolean;
    auth_del: boolean;
    anon_upd: boolean;
    anon_del: boolean;
    pub_upd: boolean;
    pub_del: boolean;
    svc_sel: boolean;
    svc_ins: boolean;
    svc_upd: boolean;
    svc_del: boolean;
  }>(
    `SELECT c.relname,
            has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_sel,
            has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_ins,
            has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_upd,
            has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_del,
            has_table_privilege('anon', c.oid, 'UPDATE') AS anon_upd,
            has_table_privilege('anon', c.oid, 'DELETE') AS anon_del,
            has_table_privilege('public', c.oid, 'UPDATE') AS pub_upd,
            has_table_privilege('public', c.oid, 'DELETE') AS pub_del,
            has_table_privilege('service_role', c.oid, 'SELECT') AS svc_sel,
            has_table_privilege('service_role', c.oid, 'INSERT') AS svc_ins,
            has_table_privilege('service_role', c.oid, 'UPDATE') AS svc_upd,
            has_table_privilege('service_role', c.oid, 'DELETE') AS svc_del
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  const byName = Object.fromEntries(priv.rows.map((row) => [row.relname, row]));
  for (const name of tables) {
    const row = byName[name];
    assert.ok(row, name);
    assert.equal(row.auth_upd, false, `${name} update`);
    assert.equal(row.auth_del, false, `${name} delete`);
    assert.equal(row.anon_upd, false, name);
    assert.equal(row.anon_del, false, name);
    assert.equal(row.pub_upd, false, name);
    assert.equal(row.pub_del, false, name);
    assert.equal(row.svc_sel, true, name);
    assert.equal(row.svc_ins, true, name);
    assert.equal(row.svc_upd, true, name);
    assert.equal(row.svc_del, true, name);
  }
  assert.equal(byName.identity_documents.auth_sel, true);
  assert.equal(byName.identity_documents.auth_ins, true);
  assert.equal(byName.identity_document_photos.auth_sel, true);
  assert.equal(byName.identity_document_photos.auth_ins, false);
  assert.equal(byName.identity_document_access_log.auth_sel, true);
  assert.equal(byName.identity_document_access_log.auth_ins, false);
  assert.equal(byName.id_document_objects.auth_sel, false);
  assert.equal(byName.id_document_wm_objects.auth_sel, false);
  assert.equal(byName.id_upload_slots.auth_sel, false);
  const policies = await client.query<{ polname: string; polcmd: string }>(
    `SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.identity_documents'::regclass`,
  );
  assert.equal(policies.rows.some((row) => row.polname === "iddoc_team"), false);
  assert.equal(policies.rows.find((row) => row.polname === "iddoc_team_select")?.polcmd, "r");
  const fns = await client.query<{ proname: string; pub: boolean; anon: boolean; authn: boolean; svc: boolean; proconfig: string[] | null }>(
    `SELECT p.proname,
            has_function_privilege('public', p.oid, 'execute') AS pub,
            has_function_privilege('anon', p.oid, 'execute') AS anon,
            has_function_privilege('authenticated', p.oid, 'execute') AS authn,
            has_function_privilege('service_role', p.oid, 'execute') AS svc,
            p.proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
      ORDER BY p.proname`,
    [["id_photo_gate", "id_photo_open", "id_photo_record"]],
  );
  assert.deepEqual(
    fns.rows.map((row) => row.proname),
    ["id_photo_gate", "id_photo_open", "id_photo_record"],
  );
  for (const row of fns.rows) {
    assert.equal(row.pub, false, row.proname);
    assert.equal(row.anon, false, row.proname);
    assert.equal(row.authn, false, row.proname);
    assert.equal(row.svc, true, row.proname);
    assert.match((row.proconfig ?? []).join(" "), /search_path=pg_catalog, public/);
  }
}

async function assertCurrentSchema(databaseUrl: string) {
  await assertShownNoticeColumns(databaseUrl);
  await withDb(databaseUrl, async (client) => {
    await assertAnonIdGrants(client);
    const fns = await client.query<{
      proname: string;
      args: number;
      definer: boolean;
      anon: boolean;
      authn: boolean;
      pub: boolean;
      svc: boolean;
    }>(
      `SELECT p.proname,
              p.pronargs AS args,
              p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS authn,
              has_function_privilege('public', p.oid, 'execute') AS pub,
              has_function_privilege('service_role', p.oid, 'execute') AS svc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [DEFINER],
    );
    assert.equal(fns.rows.length, DEFINER.length);
    for (const row of fns.rows) {
      assert.equal(row.definer, true, row.proname);
      assert.equal(row.anon, false, row.proname);
      assert.equal(row.authn, false, row.proname);
      assert.equal(row.pub, false, row.proname);
      assert.equal(row.svc, true, row.proname);
    }
    const signatures = fns.rows.filter((row) => row.proname === "id_document_delete_after");
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0]?.args, 3);

    const mask = await client.query<{ short: string; long: string }>(
      `SELECT id_number_stored_mask('AB12CD7') AS short, id_number_stored_mask('A123456789') AS long`,
    );
    assert.equal(mask.rows[0]?.short, "A****D7");
    assert.equal(mask.rows[0]?.long, "A******789");

    const column = await client.query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute
        WHERE attrelid = 'identity_documents'::regclass AND attname = 'delete_after'`,
    );
    assert.equal(column.rows[0]?.attnotnull, true);

    const photo = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'identity_document_photos_size_bytes_check'`,
    );
    assert.match(photo.rows[0]?.def ?? "", /819200/);
    const object = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'id_document_objects_byte_size_check'`,
    );
    assert.match(object.rows[0]?.def ?? "", /819228/);
    const fk = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'id_document_objects'
          AND c.contype = 'f'
          AND pg_get_constraintdef(c.oid) ILIKE '%identity_document_photos%'`,
    );
    assert.match(fk.rows[0]?.def ?? "", /identity_document_photos/);
    assert.match(fk.rows[0]?.def ?? "", /ON DELETE CASCADE/);
    assert.equal(fk.rows.length, 1);
    const del = await client.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_class ref ON ref.oid = c.confrelid
        WHERE t.relname = 'id_document_objects'
          AND ref.relname = 'identity_document_photos'
          AND c.contype = 'f'`,
    );
    assert.deepEqual(
      del.rows.map((row) => row.confdeltype),
      ["c"],
    );
    const bodies = await client.query<{ proname: string; def: string }>(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])`,
      [["purge_due_identity_documents", "fn_id_access_log_guard", "fn_id_document_allow_log_delete", "id_document_delete_after", "id_document_keep_days"]],
    );
    const body = (name: string) => bodies.rows.find((row) => row.proname === name)?.def ?? "";
    assert.match(body("purge_due_identity_documents"), /FOR UPDATE OF d SKIP LOCKED/);
    assert.match(body("purge_due_identity_documents"), /deleted_at IS NOT NULL/);
    assert.match(body("fn_id_access_log_guard"), /OLD\.document_id::text = ANY \(allowed\)/);
    assert.match(body("fn_id_access_log_guard"), /NOT EXISTS \(SELECT 1 FROM public\.identity_documents d WHERE d\.id = OLD\.document_id\)/);
    assert.match(body("fn_id_access_log_guard"), /SECURITY DEFINER/);
    assert.match(body("fn_id_access_log_guard"), /search_path (TO|=) '?pg_catalog'?, '?public'?/);
    assert.match(body("fn_id_document_allow_log_delete"), /array_append/);
    assert.match(body("id_document_delete_after"), /l\.status IN \('active', 'ended', 'terminated'\)/);
    assert.match(body("id_document_delete_after"), /voided/);
    // Historical upgrade replay restores SELECT 90; the current tail uses config.
    assert.match(body("id_document_keep_days"), /SELECT (?:90|public\.platform_max_id_retention_days\(\))/);
    const keep = await client.query<{ days: number }>(`SELECT id_document_keep_days() AS days`);
    assert.equal(keep.rows[0]?.days, 90);
    const closed = await client.query<{ proname: string; anon: boolean; authn: boolean; pub: boolean; svc: boolean }>(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS authn,
              has_function_privilege('public', p.oid, 'execute') AS pub,
              has_function_privilege('service_role', p.oid, 'execute') AS svc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [[...CLOSED_EXECUTE]],
    );
    assert.deepEqual(
      closed.rows.map((row) => row.proname),
      [...CLOSED_EXECUTE].slice().sort(),
    );
    for (const row of closed.rows) {
      assert.equal(row.anon, false, row.proname);
      assert.equal(row.authn, false, row.proname);
      assert.equal(row.pub, false, row.proname);
      assert.equal(row.svc, true, row.proname);
    }
    const guardConfig = await client.query<{ proconfig: string[] | null }>(
      `SELECT proconfig FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'fn_id_access_log_guard'`,
    );
    assert.match((guardConfig.rows[0]?.proconfig ?? []).join(" "), /search_path=pg_catalog, public/);
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE service_role");
      const asService = await client.query<{ days: number; masked: string }>(
        `SELECT id_document_keep_days() AS days, id_number_stored_mask('A123456789') AS masked`,
      );
      assert.equal(asService.rows[0]?.days, 90);
      assert.equal(asService.rows[0]?.masked, "A******789");
      await assert.rejects(
        client.query(`SELECT fn_id_number_masked()`),
        /trigger functions can only be called as triggers/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE anon");
      await assert.rejects(client.query(`SELECT id_document_keep_days()`), /permission denied/);
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE anon");
      await assert.rejects(client.query(`SELECT id_number_stored_mask('A123456789')`), /permission denied/);
    } finally {
      await client.query("ROLLBACK");
    }
    const rejected = await client.query(
      `SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'fn_id_photo_reject_back'`,
    );
    assert.equal(rejected.rows.length, 0);

    const truncate = await client.query<{ relname: string; anon: boolean; authn: boolean }>(
      `SELECT c.relname,
              has_table_privilege('anon', c.oid, 'TRUNCATE') AS anon,
              has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS authn
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    assert.ok(truncate.rows.length > 0);
    for (const row of truncate.rows) {
      assert.equal(row.anon, false, row.relname);
      assert.equal(row.authn, false, row.relname);
    }

    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, country_code, default_currency) VALUES ('權限', 'TW', 'TWD') RETURNING id::text`,
    );
    const orgId = org.rows[0]?.id ?? "";
    try {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        const due = await client.query<{ due: string }>(
          `SELECT id_document_delete_after(NULL::uuid, $1::uuid, now())::text AS due`,
          [orgId],
        );
        assert.match(due.rows[0]?.due ?? "", /^\d{4}-\d{2}-\d{2}$/);
      } finally {
        await client.query("ROLLBACK");
      }

      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE anon");
        await assert.rejects(
          () => client.query(`SELECT id_document_delete_after(NULL::uuid, $1::uuid, now())`, [orgId]),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
      }

      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await assert.rejects(
          () => client.query(`SELECT purge_due_identity_documents(1)`),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }
    await assertIdPhotoPrivileges(client);
  });
}

test("shown-notice hash columns stay nullable and an older insert still works", async () => {
  const file = path.join(MIGRATIONS, SHOWN_SHA_FILE);
  psql(FRESH_URL, file);
  psql(FRESH_URL, file);
  await assertShownNoticeColumns(FRESH_URL);
  await withDb(FRESH_URL, async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, country_code, default_currency) VALUES ('舊欄', 'TW', 'TWD') RETURNING id::text`,
    );
    const orgId = org.rows[0]?.id ?? "";
    try {
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, '舊寫入') RETURNING id::text`,
        [orgId],
      );
      await client.query("BEGIN");
      try {
        const omitted = await client.query<{ consent_full_text_sha256: string | null; consent_upload_text_sha256: string | null }>(
          `INSERT INTO identity_documents (
             org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref
           ) VALUES ($1, $2, 'passport', 'A***CD', $3, 'env:ID_DOC_ENCRYPTION_KEY')
           RETURNING consent_full_text_sha256, consent_upload_text_sha256`,
          [orgId, contact.rows[0]?.id, `${orgId}/old-insert/front`],
        );
        assert.equal(omitted.rows[0]?.consent_full_text_sha256, null);
        assert.equal(omitted.rows[0]?.consent_upload_text_sha256, null);
        const named = await client.query<{ consent_full_text_sha256: string | null; consent_upload_text_sha256: string | null }>(
          `UPDATE identity_documents
              SET consent_full_text_sha256 = $2, consent_upload_text_sha256 = $3
            WHERE org_id = $1
          RETURNING consent_full_text_sha256, consent_upload_text_sha256`,
          [orgId, "a".repeat(64), "b".repeat(64)],
        );
        assert.equal(named.rows[0]?.consent_full_text_sha256, "a".repeat(64));
        assert.equal(named.rows[0]?.consent_upload_text_sha256, "b".repeat(64));
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }
  });
});

test("anon table grants and anon or authenticated execute on the mask helpers are removed", async () => {
  const file = path.join(MIGRATIONS, ANON_REVOKE_FILE);
  psql(FRESH_URL, file);
  psql(FRESH_URL, file);
  await withDb(FRESH_URL, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `GRANT ALL ON identity_document_photos, id_document_objects TO anon;
         GRANT EXECUTE ON FUNCTION id_number_stored_mask(text), dedupe_live_identity_documents() TO anon, authenticated`,
      );
      const granted = await client.query<{ sel: boolean; exec: boolean }>(
        `SELECT has_table_privilege('anon', 'id_document_objects', 'INSERT') AS sel,
                has_function_privilege('authenticated', 'id_number_stored_mask(text)', 'EXECUTE') AS exec`,
      );
      assert.equal(granted.rows[0]?.sel, true);
      assert.equal(granted.rows[0]?.exec, true);
      await client.query(readFileSync(file, "utf8"));
      await assertAnonIdGrants(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  await withDb(FRESH_URL, assertAnonIdGrants);
});

test("the purge execute revoke can run twice and removes anon, authenticated, and public", async () => {
  const file = path.join(MIGRATIONS, PURGE_REVOKE_FILE);
  psql(FRESH_URL, file);
  psql(FRESH_URL, file);
  await withDb(FRESH_URL, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `GRANT EXECUTE ON FUNCTION purge_due_identity_documents(integer) TO PUBLIC, anon, authenticated`,
      );
      const opened = await client.query<{ anon: boolean; authn: boolean; pub: boolean }>(
        `SELECT has_function_privilege('anon', 'purge_due_identity_documents(integer)', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'purge_due_identity_documents(integer)', 'EXECUTE') AS authn,
                has_function_privilege('public', 'purge_due_identity_documents(integer)', 'EXECUTE') AS pub`,
      );
      assert.equal(opened.rows[0]?.anon, true);
      assert.equal(opened.rows[0]?.authn, true);
      assert.equal(opened.rows[0]?.pub, true);
      await client.query(readFileSync(file, "utf8"));
      const closed = await client.query<{ anon: boolean; authn: boolean; pub: boolean; svc: boolean }>(
        `SELECT has_function_privilege('anon', 'purge_due_identity_documents(integer)', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'purge_due_identity_documents(integer)', 'EXECUTE') AS authn,
                has_function_privilege('public', 'purge_due_identity_documents(integer)', 'EXECUTE') AS pub,
                has_function_privilege('service_role', 'purge_due_identity_documents(integer)', 'EXECUTE') AS svc`,
      );
      assert.equal(closed.rows[0]?.anon, false);
      assert.equal(closed.rows[0]?.authn, false);
      assert.equal(closed.rows[0]?.pub, false);
      assert.equal(closed.rows[0]?.svc, true);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("a fresh database that already ran the current ID migration accepts the upgrade unchanged", async () => {
  psql(FRESH_URL, path.join(MIGRATIONS, "20261024100000_revoke_truncate.sql"));
  psql(FRESH_URL, path.join(MIGRATIONS, UPGRADE_FILE));
  psql(FRESH_URL, path.join(MIGRATIONS, UPGRADE_FILE));
  // The upgrade file drops and recreates id_document_delete_after. The consent
  // migration is the clock that has to remain on this database.
  psql(FRESH_URL, path.join(MIGRATIONS, "20261028120000_id_delete_after_consent.sql"));
  psql(FRESH_URL, path.join(MIGRATIONS, "20261029130000_id_no_direct_mutate.sql"));
  await assertCurrentSchema(FRESH_URL);
  await withDb(FRESH_URL, async (client) => {
    const body = await client.query<{ def: string }>(
      `SELECT pg_get_functiondef('id_document_delete_after(uuid,uuid,timestamptz)'::regprocedure) AS def`,
    );
    assert.match(body.rows[0]?.def ?? "", /9999-12-31/);
  });
});

test("provided PR9e privilege variant upgrades and preserves ordinary records", async () => {
  const fixture = path.join(ROOT, "src/server/fixtures/id-migration/20261022180000_tenant_id_check.pr9e-variant.sql");
  assert.equal(createHash("sha256").update(readFileSync(fixture)).digest("hex"), "9b2295f0140e3b06e3f585ccf564816d98f7e00efbf0bea7f02d3147b69363b9");
  const database = await createScratchDb();
  try {
    psql(database.url, STUB);
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name < OLD_FILE).sort()) {
      psql(database.url, path.join(MIGRATIONS, file));
    }
    psql(database.url, fixture);
    const inspect = async () => withDb(database.url, async (client) => {
      const result = await client.query<{ proname: string; pub: boolean; anon: boolean; authn: boolean; svc: boolean }>(
        `SELECT p.proname,
                has_function_privilege('public', p.oid, 'execute') AS pub,
                has_function_privilege('anon', p.oid, 'execute') AS anon,
                has_function_privilege('authenticated', p.oid, 'execute') AS authn,
                has_function_privilege('service_role', p.oid, 'execute') AS svc
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
        [[...CLOSED_EXECUTE]],
      );
      assert.deepEqual(result.rows.map((row) => row.proname), [...CLOSED_EXECUTE].sort());
      return result.rows;
    });
    const before = await inspect();
    assert.ok(before.some((row) => row.pub || row.anon || row.authn), "PR9e must expose at least one prior helper grant");
    const saved = await withDb(database.url, async (client) => {
      const org = await client.query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency) VALUES ('PR9e fixture', 'TW', 'TWD') RETURNING id::text`);
      const contact = await client.query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, 'Fixture') RETURNING id::text`, [org.rows[0].id]);
      const doc = await client.query<{ id: string; delete_after: string }>(
        `INSERT INTO identity_documents (org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref)
         VALUES ($1, $2, 'passport', 'A***CD', $3, 'fixture-key-ref') RETURNING id::text, delete_after::text`,
        [org.rows[0].id, contact.rows[0].id, `${org.rows[0].id}/fixture/front`],
      );
      await client.query(`INSERT INTO identity_document_photos (org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256)
        VALUES ($1, $2, 'front', 'id-documents-private', $3, 'image/jpeg', 1200, $4)`,
        [org.rows[0].id, doc.rows[0].id, `${org.rows[0].id}/fixture/photo`, "a".repeat(64)]);
      return doc.rows[0];
    });
    for (let replay = 0; replay < 2; replay += 1) {
      psql(database.url, path.join(MIGRATIONS, UPGRADE_FILE));
      const after = await inspect();
      for (const row of after) {
        assert.equal(row.pub, false, row.proname);
        assert.equal(row.anon, false, row.proname);
        assert.equal(row.authn, false, row.proname);
        assert.equal(row.svc, true, row.proname);
      }
      await withDb(database.url, async (client) => {
        const record = await client.query<{ delete_after: string; photos: string }>(
          `SELECT d.delete_after::text, (SELECT count(*)::text FROM identity_document_photos p WHERE p.document_id = d.id) AS photos FROM identity_documents d WHERE d.id = $1`, [saved.id]);
        assert.equal(record.rows[0]?.delete_after, saved.delete_after);
        assert.equal(record.rows[0]?.photos, "1");
      });
    }
  } finally {
    await database.cleanup();
  }
});

test("a database with the older 20261022180000 upgrades forward, then accepts the same file again", async () => {
  const fixture = path.join(ROOT, "src/server/fixtures/id-migration/20261022180000_tenant_id_check.b888ccd.sql");
  const bytes = readFileSync(fixture);
  assert.equal(
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    "c9da3e9eecff356fd3d1bf107dcc8a3994e4f4f3",
  );
  const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  const database = await createScratchDb();
  const upgradeUrl = database.url;
  const upgradeFile = path.join(MIGRATIONS, UPGRADE_FILE);
  try {
    psql(upgradeUrl, STUB);
    // Reproduce history before the upgrade; later migrations require its shape.
    for (const file of migrations.filter((name) => name < UPGRADE_FILE)) {
      psql(upgradeUrl, file === OLD_FILE ? fixture : path.join(MIGRATIONS, file));
    }
    const seeded = await withDb(upgradeUrl, async (client) => {
      const predecessor = await client.query<{ not_null: boolean; keep_days: number }>(
        `SELECT attnotnull AS not_null, id_document_keep_days() AS keep_days
           FROM pg_attribute
          WHERE attrelid = 'identity_documents'::regclass AND attname = 'delete_after'`,
      );
      assert.deepEqual(predecessor.rows, [{ not_null: false, keep_days: 365 }]);
      const sizeChecks = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'identity_document_photos'::regclass
            AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%size_bytes%'`,
      );
      // The genuine fixture has a 5MB limit, but no post-upgrade 819200 cap.
      assert.equal(sizeChecks.rows.length, 1);
      assert.match(sizeChecks.rows[0].def, /size_bytes > 0/);
      assert.match(sizeChecks.rows[0].def, /size_bytes <= 5000000/);
      assert.doesNotMatch(sizeChecks.rows[0].def, /819200/);
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, country_code, default_currency) VALUES ('升級', 'TW', 'TWD') RETURNING id::text`,
      );
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, '舊護照') RETURNING id::text`,
        [org.rows[0]?.id],
      );
      const doc = await client.query<{ id: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref
         ) VALUES ($1, $2, 'passport', 'A***CD', $3, 'env:ID_DOC_ENCRYPTION_KEY')
         RETURNING id::text`,
        [org.rows[0]?.id, contact.rows[0]?.id, `${org.rows[0]?.id}/old/front`],
      );
      await client.query(`UPDATE identity_documents SET delete_after = NULL WHERE id = $1`, [doc.rows[0]?.id]);
      const contact2 = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, '過大') RETURNING id::text`,
        [org.rows[0]?.id],
      );
      const fat = await client.query<{ id: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref
         ) VALUES ($1, $2, 'passport', 'A***CD7', $3, 'env:ID_DOC_ENCRYPTION_KEY')
         RETURNING id::text`,
        [org.rows[0]?.id, contact2.rows[0]?.id, `${org.rows[0]?.id}/fat/front`],
      );
      const photoPath = `${org.rows[0]?.id}/fat/object`;
      await client.query(
        `INSERT INTO identity_document_photos (
           org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
         ) VALUES ($1, $2, 'front', 'id-documents-private', $3, 'image/jpeg', 2000000, $4)`,
        [org.rows[0]?.id, fat.rows[0]?.id, photoPath, "a".repeat(64)],
      );
      const backPath = `${org.rows[0]?.id}/old/back`;
      await client.query(
        `INSERT INTO identity_document_photos (
           org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
         ) VALUES ($1, $2, 'back', 'id-documents-private', $3, 'image/jpeg', 1200, $4)`,
        [org.rows[0]?.id, doc.rows[0]?.id, backPath, "c".repeat(64)],
      );
      const violated = await client.query<{ delete_after: string | null; size_bytes: string }>(
        `SELECT d.delete_after::text,
                (SELECT p.size_bytes::text FROM identity_document_photos p WHERE p.document_id = $2) AS size_bytes
           FROM identity_documents d WHERE d.id = $1`,
        [doc.rows[0]?.id, fat.rows[0]?.id],
      );
      assert.equal(violated.rows[0]?.delete_after, null);
      assert.equal(violated.rows[0]?.size_bytes, "2000000");
      return { documentId: doc.rows[0]?.id ?? "", fatId: fat.rows[0]?.id ?? "", photoPath, orgId: org.rows[0]?.id ?? "" };
    });

    const readOutcome = () => withDb(upgradeUrl, async (client) => {
      const due = await client.query<{ delete_after: string; expected: string; not_null: boolean }>(
        `SELECT d.delete_after::text,
                ((d.created_at AT TIME ZONE 'Asia/Taipei')::date
                  + LEAST(o.id_doc_retention_days, platform_max_id_retention_days()))::text AS expected,
                a.attnotnull AS not_null
           FROM identity_documents d
           JOIN organizations o ON o.id = d.org_id
           JOIN pg_attribute a ON a.attrelid = 'identity_documents'::regclass AND a.attname = 'delete_after'
          WHERE d.id = $1`,
        [seeded.documentId],
      );
      const fat = await client.query<{ gone: boolean; storage_path: string; photos: string }>(
        `SELECT d.deleted_at IS NOT NULL AS gone, d.storage_path,
                (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos
           FROM identity_documents d WHERE d.id = $1`,
        [seeded.fatId],
      );
      const kept = await client.query<{ size_bytes: string }>(
        `SELECT size_bytes::text FROM identity_document_photos WHERE document_id = $1 AND slot = 'back'`,
        [seeded.documentId],
      );
      const cap = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'identity_document_photos_size_bytes_check'`,
      );
      return {
        deleteAfter: due.rows[0]?.delete_after ?? null,
        expected: due.rows[0]?.expected ?? null,
        notNull: due.rows[0]?.not_null ?? false,
        gone: fat.rows[0]?.gone ?? false,
        storagePath: fat.rows[0]?.storage_path ?? "",
        photos: fat.rows[0]?.photos ?? "",
        keptBytes: kept.rows[0]?.size_bytes ?? "",
        cap: cap.rows[0]?.def ?? "",
      };
    });

    psql(upgradeUrl, upgradeFile);
    const first = await readOutcome();
    assert.equal(first.deleteAfter, first.expected);
    assert.ok(first.deleteAfter);
    assert.equal(first.notNull, true);
    assert.equal(first.gone, true);
    assert.match(first.storagePath, /^purged\//);
    assert.equal(first.photos, "0");
    assert.equal(first.keptBytes, "1200");
    assert.match(first.cap, /819200/);

    psql(upgradeUrl, upgradeFile);
    const second = await readOutcome();
    assert.deepEqual(second, first);
    await withDb(upgradeUrl, async (client) => {
      await assert.rejects(
        client.query(`UPDATE identity_documents SET delete_after = NULL WHERE id = $1`, [seeded.documentId]),
        (error: unknown) => (error as { code?: string }).code === "23502",
      );
      await assert.rejects(
        client.query(
          `INSERT INTO identity_document_photos (
             org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
           ) VALUES ($1, $2, 'front', 'id-documents-private', $3, 'image/jpeg', 2000000, $4)`,
          [seeded.orgId, seeded.documentId, `${seeded.orgId}/rejected`, "d".repeat(64)],
        ),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
    });
    // Check upgrade replay before later migrations replace its retention clock.
    for (const file of migrations.filter((name) => name > UPGRADE_FILE)) {
      psql(upgradeUrl, path.join(MIGRATIONS, file));
    }
    await assertCurrentSchema(upgradeUrl);
  } finally {
    await database.cleanup();
  }
});

test("anon and authenticated cannot truncate public tables, including tables created later", async () => {
  const file = path.join(MIGRATIONS, "20261024100000_revoke_truncate.sql");
  psql(FRESH_URL, file);
  psql(FRESH_URL, file);
  await withDb(FRESH_URL, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await assert.rejects(() => client.query("TRUNCATE TABLE identity_document_access_log"), /permission denied/);
    } finally {
      await client.query("ROLLBACK");
    }

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE anon");
      await assert.rejects(() => client.query("TRUNCATE TABLE identity_documents"), /permission denied/);
    } finally {
      await client.query("ROLLBACK");
    }

    await client.query("BEGIN");
    try {
      await client.query(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated",
      );
      await client.query(readFileSync(file, "utf8"));
      await client.query("CREATE TABLE public.truncate_revoke_probe (id integer)");
      const probe = await client.query<{ anon_trunc: boolean; auth_trunc: boolean; auth_select: boolean }>(
        `SELECT has_table_privilege('anon', 'public.truncate_revoke_probe', 'TRUNCATE') AS anon_trunc,
                has_table_privilege('authenticated', 'public.truncate_revoke_probe', 'TRUNCATE') AS auth_trunc,
                has_table_privilege('authenticated', 'public.truncate_revoke_probe', 'SELECT') AS auth_select`,
      );
      assert.equal(probe.rows[0]?.anon_trunc, false);
      assert.equal(probe.rows[0]?.auth_trunc, false);
      assert.equal(probe.rows[0]?.auth_select, true);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("the direct-mutate migration applies twice and keeps photo helpers on service_role", async () => {
  const file = path.join(MIGRATIONS, "20261029130000_id_no_direct_mutate.sql");
  psql(FRESH_URL, file);
  psql(FRESH_URL, file);
  await withDb(FRESH_URL, assertIdPhotoPrivileges);
});
