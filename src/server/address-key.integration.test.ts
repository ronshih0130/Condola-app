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
const moveSql = readFileSync(
  new URL("../../supabase/migrations/20261029130000_unit_import_key_on_move.sql", import.meta.url),
  "utf8",
);
const backfillSql = readFileSync(
  new URL("../../scripts/backfill-unit-import-address-keys.sql", import.meta.url),
  "utf8",
);

function stamp() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function applySync(client: Client) {
  await client.query(syncSql);
}

async function applyMove(client: Client) {
  await client.query(moveSql);
}

function noticeCount(notices: string[]) {
  const matches = notices
    .map((message) => message.match(/backfill-unit-import-address-keys updated (\d+)/))
    .filter((match): match is RegExpMatchArray => match !== null);
  assert.ok(matches.length > 0);
  return Number(matches[matches.length - 1][1]);
}

async function qaProperty(client: Client, name: string, display: string, unitLabel: string | null = "5F") {
  const jurisdiction = await client.query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
  const property = await client.query<{ id: string; address_key: string }>(
    `INSERT INTO properties (org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone)
     VALUES ($1, $2, '{}'::jsonb, $3, 'TW', $4, 'TWD', 'Asia/Taipei')
     RETURNING id::text, address_key`,
    [ORG_ID, name, display, jurisdiction.rows[0].id],
  );
  if (!unitLabel) return { propertyId: property.rows[0].id, unitId: "", unitKey: property.rows[0].address_key };
  const unit = await client.query<{ id: string; import_address_key: string }>(
    `INSERT INTO units (org_id, property_id, label, floor, rental_mode)
     VALUES ($1, $2, $3, '5', 'whole_unit')
     RETURNING id::text, import_address_key`,
    [ORG_ID, property.rows[0].id, unitLabel],
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
      await applyMove(client);
      await cleanup(client, propertyIds);
    }
  });
});

test("moving a unit refreshes its key and the backfill script is idempotent", async () => {
  const id = stamp();
  const originName = `QA搬移物件${id}`;
  const destinationName = `QA搬移目的${id}`;
  const originAddress = `台北市大安區QA搬移路${id}號`;
  const destinationAddress = `台北市大安區QA目的路${id}號`;
  const staleKey = `qa-stale-${id}`;
  const explicitKey = `qa-explicit-${id}`;
  const propertyIds: string[] = [];
  await withClient(async (client) => {
    const notices: string[] = [];
    client.on("notice", (notice: { message?: string }) => {
      notices.push(notice.message ?? "");
    });
    try {
      await applyMove(client);
      await client.query(`SET client_min_messages TO notice`);
      const origin = await qaProperty(client, originName, originAddress);
      const destination = await qaProperty(client, destinationName, destinationAddress, null);
      propertyIds.push(origin.propertyId, destination.propertyId);
      assert.equal(origin.unitKey, addressKey(originAddress));

      await client.query(`UPDATE units SET property_id = $2 WHERE id = $1`, [origin.unitId, destination.propertyId]);
      const moved = await client.query<{ import_address_key: string }>(
        `SELECT import_address_key FROM units WHERE id = $1`,
        [origin.unitId],
      );
      assert.equal(moved.rows[0].import_address_key, addressKey(destinationAddress));

      await client.query(`UPDATE units SET import_address_key = $2 WHERE id = $1`, [origin.unitId, staleKey]);
      const kept = await client.query<{ import_address_key: string }>(
        `SELECT import_address_key FROM units WHERE id = $1`,
        [origin.unitId],
      );
      assert.equal(kept.rows[0].import_address_key, staleKey);

      const explicit = await client.query<{ import_address_key: string }>(
        `INSERT INTO units (org_id, property_id, label, floor, rental_mode, import_address_key)
         VALUES ($1, $2, '6F', '6', 'whole_unit', $3)
         RETURNING import_address_key`,
        [ORG_ID, origin.propertyId, explicitKey],
      );
      assert.equal(explicit.rows[0].import_address_key, explicitKey);
      const explicitId = (
        await client.query<{ id: string }>(
          `SELECT id::text FROM units WHERE property_id = $1 AND label = '6F'`,
          [origin.propertyId],
        )
      ).rows[0].id;
      await client.query(`UPDATE units SET property_id = $2 WHERE id = $1`, [explicitId, destination.propertyId]);
      const explicitMoved = await client.query<{ import_address_key: string }>(
        `SELECT import_address_key FROM units WHERE id = $1`,
        [explicitId],
      );
      assert.equal(explicitMoved.rows[0].import_address_key, addressKey(destinationAddress));

      await client.query(backfillSql);
      const repaired = await client.query<{ import_address_key: string }>(
        `SELECT import_address_key FROM units WHERE id = $1`,
        [origin.unitId],
      );
      assert.equal(repaired.rows[0].import_address_key, addressKey(destinationAddress));
      assert.ok(noticeCount(notices) >= 1);

      notices.length = 0;
      await client.query(backfillSql);
      assert.equal(noticeCount(notices), 0);
      const stable = await client.query<{ import_address_key: string }>(
        `SELECT import_address_key FROM units WHERE id = $1`,
        [origin.unitId],
      );
      assert.equal(stable.rows[0].import_address_key, addressKey(destinationAddress));
    } finally {
      await client.query(`ALTER TABLE public.units ENABLE TRIGGER trg_units_updated_at`);
      await cleanup(client, propertyIds);
    }
  });
});
});
