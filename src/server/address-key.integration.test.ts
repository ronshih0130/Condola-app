import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Client } from "pg";
import { withClient } from "./db";
import { ORG_ID } from "./ids";
import { addressKey } from "./owner-import";

const syncSql = readFileSync(
  new URL("../../supabase/migrations/20261029120000_sync_address_key_errors.sql", import.meta.url),
  "utf8",
);
const bulkSql = readFileSync(
  new URL("../../supabase/migrations/20261026130000_bulk_import.sql", import.meta.url),
  "utf8",
);

function stamp() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function applySync(client: Client) {
  await client.query(syncSql);
}

async function qaProperty(client: Client, name: string, display: string) {
  const jurisdiction = await client.query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
  const property = await client.query<{ id: string; address_key: string }>(
    `INSERT INTO properties (org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone)
     VALUES ($1, $2, '{}'::jsonb, $3, 'TW', $4, 'TWD', 'Asia/Taipei')
     RETURNING id::text, address_key`,
    [ORG_ID, name, display, jurisdiction.rows[0].id],
  );
  const unit = await client.query<{ id: string; import_address_key: string }>(
    `INSERT INTO units (org_id, property_id, label, floor, rental_mode)
     VALUES ($1, $2, '5F', '5', 'whole_unit')
     RETURNING id::text, import_address_key`,
    [ORG_ID, property.rows[0].id],
  );
  return { propertyId: property.rows[0].id, unitId: unit.rows[0].id, unitKey: unit.rows[0].import_address_key };
}

async function dropQaGuards(client: Client) {
  await client.query(`DROP TRIGGER IF EXISTS qa_block_unit_address_key ON public.units`);
  await client.query(`DROP FUNCTION IF EXISTS public.qa_block_unit_address_key()`);
  await client.query(`DROP TRIGGER IF EXISTS qa_block_sync_error_log ON public.condola_sync_errors`);
  await client.query(`DROP FUNCTION IF EXISTS public.qa_block_sync_error_log()`);
}

async function cleanup(client: Client, propertyIds: string[]) {
  await dropQaGuards(client);
  if (propertyIds.length === 0) return;
  await client.query(`DELETE FROM public.condola_sync_errors WHERE row_id = ANY($1::uuid[])`, [propertyIds]);
  await client.query(`DELETE FROM units WHERE property_id = ANY($1::uuid[])`, [propertyIds]);
  await client.query(`DELETE FROM properties WHERE id = ANY($1::uuid[])`, [propertyIds]);
}

describe("address-key sync errors", { concurrency: false }, () => {
test("a failed unit-key sync is logged and the property write still commits", async () => {
  const id = stamp();
  const name = `QA同步物件${id}`;
  const first = `台北市大安區QA同步路${id}號`;
  const next = `台北市大安區QA同步巷${id}號`;
  const propertyIds: string[] = [];
  await withClient(async (client) => {
    try {
      await applySync(client);
      const created = await qaProperty(client, name, first);
      propertyIds.push(created.propertyId);
      assert.equal(created.unitKey, addressKey(first));

      await client.query(`
        CREATE OR REPLACE FUNCTION public.qa_block_unit_address_key()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          IF NEW.import_address_key IS DISTINCT FROM OLD.import_address_key THEN
            RAISE EXCEPTION 'qa block unit key' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await client.query(`
        CREATE TRIGGER qa_block_unit_address_key
          BEFORE UPDATE ON public.units
          FOR EACH ROW
          EXECUTE FUNCTION public.qa_block_unit_address_key()
      `);

      await client.query(`UPDATE properties SET address_display = $2 WHERE id = $1`, [created.propertyId, next]);
      const stored = await client.query<{ address_key: string; import_address_key: string }>(
        `SELECT p.address_key, u.import_address_key
           FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.id = $1`,
        [created.unitId],
      );
      assert.equal(stored.rows[0].address_key, addressKey(next));
      assert.equal(stored.rows[0].import_address_key, addressKey(first));
      const logged = await client.query<{ sqlstate: string; message: string; source: string }>(
        `SELECT source, sqlstate, message
           FROM public.condola_sync_errors
          WHERE row_id = $1 AND source = 'condola_sync_unit_address_keys'`,
        [created.propertyId],
      );
      assert.equal(logged.rows.length, 1);
      assert.equal(logged.rows[0].sqlstate, "23514");
      assert.match(logged.rows[0].message, /qa block unit key/);

      await dropQaGuards(client);
      const repaired = `台北市大安區QA同步街${id}號`;
      await client.query(`UPDATE properties SET address_display = $2 WHERE id = $1`, [created.propertyId, repaired]);
      const followed = await client.query<{ address_key: string; import_address_key: string; errors: string }>(
        `SELECT p.address_key, u.import_address_key,
                (SELECT count(*)::text FROM public.condola_sync_errors e WHERE e.row_id = p.id) AS errors
           FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.id = $1`,
        [created.unitId],
      );
      assert.equal(followed.rows[0].address_key, addressKey(repaired));
      assert.equal(followed.rows[0].import_address_key, addressKey(repaired));
      assert.equal(followed.rows[0].errors, "1");
    } finally {
      await cleanup(client, propertyIds);
    }
  });
});

test("a sync log failure warns and still keeps the property write", async () => {
  const id = stamp();
  const name = `QA同步失敗${id}`;
  const first = `台北市大安區QA失敗路${id}號`;
  const next = `台北市大安區QA失敗巷${id}號`;
  const propertyIds: string[] = [];
  await withClient(async (client) => {
    const notices: string[] = [];
    client.on("notice", (notice: { message?: string }) => {
      notices.push(notice.message ?? "");
    });
    try {
      await applySync(client);
      const created = await qaProperty(client, name, first);
      propertyIds.push(created.propertyId);
      await client.query(`
        CREATE OR REPLACE FUNCTION public.qa_block_unit_address_key()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.import_address_key IS DISTINCT FROM OLD.import_address_key THEN
            RAISE EXCEPTION 'qa block unit key' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await client.query(`
        CREATE TRIGGER qa_block_unit_address_key
          BEFORE UPDATE ON public.units
          FOR EACH ROW EXECUTE FUNCTION public.qa_block_unit_address_key()
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION public.qa_block_sync_error_log()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'qa block error log' USING ERRCODE = 'check_violation';
        END
        $fn$
      `);
      await client.query(`
        CREATE TRIGGER qa_block_sync_error_log
          BEFORE INSERT ON public.condola_sync_errors
          FOR EACH ROW EXECUTE FUNCTION public.qa_block_sync_error_log()
      `);
      await client.query(`UPDATE properties SET address_display = $2 WHERE id = $1`, [created.propertyId, next]);
      const stored = await client.query<{ address_key: string; import_address_key: string; errors: string }>(
        `SELECT p.address_key, u.import_address_key,
                (SELECT count(*)::text FROM public.condola_sync_errors e WHERE e.row_id = p.id) AS errors
           FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.id = $1`,
        [created.unitId],
      );
      assert.equal(stored.rows[0].address_key, addressKey(next));
      assert.equal(stored.rows[0].import_address_key, addressKey(first));
      assert.equal(stored.rows[0].errors, "0");
      assert.ok(notices.some((message) => message.includes("condola_sync_unit_address_keys could not log")));
    } finally {
      await cleanup(client, propertyIds);
    }
  });
});

test("replacing the bulk import function restores error logging", async () => {
  const id = stamp();
  const name = `QA同步重套${id}`;
  const first = `台北市大安區QA重套路${id}號`;
  const next = `台北市大安區QA重套巷${id}號`;
  const propertyIds: string[] = [];
  await withClient(async (client) => {
    try {
      await client.query(bulkSql);
      await applySync(client);
      const created = await qaProperty(client, name, first);
      propertyIds.push(created.propertyId);
      await client.query(`
        CREATE OR REPLACE FUNCTION public.qa_block_unit_address_key()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.import_address_key IS DISTINCT FROM OLD.import_address_key THEN
            RAISE EXCEPTION 'qa block unit key' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await client.query(`
        CREATE TRIGGER qa_block_unit_address_key
          BEFORE UPDATE ON public.units
          FOR EACH ROW EXECUTE FUNCTION public.qa_block_unit_address_key()
      `);
      await client.query(`UPDATE properties SET address_display = $2 WHERE id = $1`, [created.propertyId, next]);
      const logged = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.condola_sync_errors
          WHERE row_id = $1 AND sqlstate = '23514'`,
        [created.propertyId],
      );
      assert.equal(logged.rows[0].n, "1");
      const privileges = await client.query<{ anon_select: boolean; auth_insert: boolean; service_insert: boolean; auth_execute: boolean }>(
        `SELECT has_table_privilege('anon', 'public.condola_sync_errors', 'SELECT') AS anon_select,
                has_table_privilege('authenticated', 'public.condola_sync_errors', 'INSERT') AS auth_insert,
                has_table_privilege('service_role', 'public.condola_sync_errors', 'INSERT') AS service_insert,
                has_function_privilege('authenticated', 'public.condola_sync_unit_address_keys()', 'EXECUTE') AS auth_execute`,
      );
      assert.equal(privileges.rows[0].anon_select, false);
      assert.equal(privileges.rows[0].auth_insert, false);
      assert.equal(privileges.rows[0].service_insert, true);
      assert.equal(privileges.rows[0].auth_execute, false);
    } finally {
      await applySync(client);
      await cleanup(client, propertyIds);
    }
  });
});
});
