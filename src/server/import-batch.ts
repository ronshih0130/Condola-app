import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, tx } from "./db";
import { FlowError } from "./errors";
import { hashIdNumber } from "./id-hash";
import { DEPOSIT_CAP_MONTHS, depositExceedsCap } from "./lease-rules";
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_DRY_BATCH,
  addTenantKey,
  addressKey,
  coerceImportRows,
  emptyIndex,
  planOne,
  planRows,
  rememberPlan,
  totalsFromPlans,
  validateImportRows,
  type ImportIssue,
  type ImportRequestRow,
  type ImportResult,
  type ParsedImportRow,
  type RowPlan,
  type SpaceKind,
} from "./owner-import";
import { assertPerm } from "./perms";
import type { Session } from "./types";

export type { ImportResult };

/** Reject uploads before JSON.parse. Counted from the stream, not Content-Length. */
export const IMPORT_BODY_MAX_BYTES = 512 * 1024;

/** Same normalization as addressKey(), evaluated in Postgres for units that have no stored key. */
const COMPUTED_ADDRESS_KEY = `NULLIF(lower(regexp_replace(normalize(coalesce(p.address_display, ''), NFKC), '\\s+', '', 'g')), '')`;

export async function readImportBody(request: Request): Promise<{ mode: "dry" | "commit"; fileName: string; rows: unknown }> {
  const text = await readCappedText(request, IMPORT_BODY_MAX_BYTES);
  if (!text.trim()) throw new FlowError("im_body");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FlowError("im_body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FlowError("im_body");
  const record = body as { mode?: unknown; fileName?: unknown; rows?: unknown };
  if (record.mode !== "dry" && record.mode !== "commit") throw new FlowError("im_bad_mode");
  const fileName = typeof record.fileName === "string" ? record.fileName : "";
  if (fileName.length > 200) throw new FlowError("im_e_len", { f: "file", max: 200 });
  return { mode: record.mode, fileName, rows: record.rows };
}

/** Validated JSON only. File bytes stay in the browser. */
export async function dryRunImport(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportResult> {
  const started = performance.now();
  let counted = 0;
  try {
    assertImport(session);
    const rows = coerceImportRows(input.rows, IMPORT_DRY_BATCH);
    counted = rows.length;
    const parsed = stampHashes(validateImportRows(rows), session.orgId);
    forgetRawIds(rows);
    const fileName = cleanName(input.fileName);
    if (parsed.length === 0) return totalsFromPlans([], fileName, true);
    return await tx(session.userId, async (client) => {
      const index = await loadIndex(client, session.orgId, parsed);
      return totalsFromPlans(planRows(parsed, index), fileName, true);
    }, scope(session));
  } finally {
    logImportTiming("dry", counted, started);
  }
}

/** One audit row for this batch. Callers send at most IMPORT_COMMIT_BATCH rows. */
export async function commitImportBatch(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportResult> {
  const started = performance.now();
  let counted = 0;
  try {
    assertImport(session);
    const rows = coerceImportRows(input.rows, IMPORT_COMMIT_BATCH);
    counted = rows.length;
    const parsed = stampHashes(validateImportRows(rows), session.orgId);
    forgetRawIds(rows);
    const fileName = cleanName(input.fileName);
    if (parsed.length === 0) return totalsFromPlans([], fileName, false);
    const result = await tx(session.userId, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`import:${session.orgId}`]);
      const index = await loadIndex(client, session.orgId, parsed);
      const jurisdiction = await one<{ id: string }>(client, `SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
      const plans = await persistPlans(client, session, parsed, index, jurisdiction.id);
      const totals = totalsFromPlans(plans, fileName, false);
      const failed = plans.filter((plan) => plan.blocked).length;
      await client.query(
        `INSERT INTO import_jobs (
           org_id, entity, column_map, status, rows_total, rows_ok, rows_failed, error_report, requested_by, finished_at
         ) VALUES ($1, 'portfolio', $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, now())`,
        [
          session.orgId,
          JSON.stringify({ fileName, kind: "bulk" }),
          failed > 0 && failed === plans.length ? "failed" : "succeeded",
          plans.length,
          plans.length - failed,
          failed,
          JSON.stringify(totals.errors.map((issue) => ({ line: issue.line, key: issue.key }))),
          session.userId,
        ],
      );
      return totals;
    }, scope(session));
    await writeAudit(session.orgId, session.userId, "import_batch", {
      fileName,
      rows: parsed.length,
      created: result.created,
      reused: result.reused,
      errors: result.errors.length,
      environment: session.environment,
    });
    return result;
  } finally {
    logImportTiming("commit", counted, started);
  }
}

function assertImport(session: Session) {
  assertPerm(session, "props.edit");
  assertPerm(session, "leases.edit");
}

function scope(session: Session) {
  return { orgId: session.orgId, environment: session.environment };
}

function cleanName(value: string) {
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || "import";
}

function forgetRawIds(rows: ImportRequestRow[]) {
  for (const row of rows) row.tenantId = "";
}

function stampHashes(rows: ParsedImportRow[], orgId: string) {
  for (const row of rows) {
    const raw = row.tenantId;
    row.tenantId = null;
    if (!raw) continue;
    try {
      row.tenantIdHash = hashIdNumber(raw, orgId);
    } catch {
      throw new FlowError("im_e_idkey");
    }
  }
  return rows;
}

function fail(plan: RowPlan, issue: ImportIssue) {
  plan.blocked = true;
  plan.createProperty = false;
  plan.createUnit = false;
  plan.createRoom = false;
  plan.createOwner = false;
  plan.createTenant = false;
  plan.createLease = false;
  plan.reuseUnit = false;
  plan.reuseTenant = false;
  plan.reuseLease = false;
  plan.vacant = false;
  plan.issues.push(issue);
}

function issueFromDb(line: number, error: unknown): ImportIssue {
  if (error instanceof FlowError) return { line, severity: "error", key: error.key, vars: error.vars };
  const message = error instanceof Error ? error.message : String(error);
  if (/deposit of/i.test(message)) return { line, severity: "error", key: "im_e_dep", vars: { v: "?", cap: DEPOSIT_CAP_MONTHS } };
  if (/exclusion|overlaps lease|duplicate key/i.test(message)) return { line, severity: "error", key: "im_e_occupied" };
  return { line, severity: "error", key: "errors.generic" };
}

async function loadIndex(client: Client, orgId: string, rows: ParsedImportRow[]) {
  const index = emptyIndex();
  const names = unique(rows.map((row) => row.propertyName).filter(Boolean));
  const keys = unique(rows.map((row) => row.addressKey).filter(Boolean));
  const emails = unique(rows.map((row) => row.ownerEmail).filter((value): value is string => Boolean(value)));
  const ownerNames = unique(rows.map((row) => row.ownerName).filter(Boolean));
  const phones = unique(rows.map((row) => row.phoneE164).filter((value): value is string => Boolean(value)));
  const hashes = unique(rows.map((row) => row.tenantIdHash).filter((value): value is string => Boolean(value)));

  if (names.length) {
    const properties = await client.query<{ id: string; name: string; address_key: string; address_display: string | null }>(
      `SELECT id::text, name, coalesce(address_key, '') AS address_key, address_display
         FROM properties
        WHERE org_id = $1 AND archived_at IS NULL AND name = ANY($2::text[])`,
      [orgId, names],
    );
    for (const property of properties.rows) {
      const key = property.address_key || addressKey(property.address_display ?? "");
      index.properties.set(property.name, { id: property.id, addressKey: key });
    }
  }

  const units = await client.query<{
    id: string;
    property_id: string;
    label: string;
    rental_mode: string;
    address_key: string;
    address_display: string | null;
  }>(
    `SELECT u.id::text, u.property_id::text, u.label, u.rental_mode::text AS rental_mode,
            coalesce(u.import_address_key, p.address_key, ${COMPUTED_ADDRESS_KEY}, '') AS address_key,
            p.address_display
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.org_id = $1 AND u.archived_at IS NULL
        AND (
          u.import_address_key = ANY($2::text[])
          OR p.address_key = ANY($2::text[])
          OR ${COMPUTED_ADDRESS_KEY} = ANY($2::text[])
          OR p.name = ANY($3::text[])
        )`,
    [orgId, keys, names],
  );
  for (const unit of units.rows) {
    const key = unit.address_key || addressKey(unit.address_display ?? "");
    if (!key) continue;
    index.units.set(`${key}\n${unit.label.normalize("NFKC").trim()}`, {
      id: unit.id,
      propertyId: unit.property_id,
      mode: unit.rental_mode === "by_room" ? "room" : "whole_unit",
    });
  }

  const unitIds = [...new Set([...index.units.values()].map((unit) => unit.id).filter((id) => !id.startsWith("new-")))];
  if (unitIds.length) {
    const rooms = await client.query<{ id: string; unit_id: string; label: string }>(
      `SELECT id::text, unit_id::text, label FROM rooms
        WHERE org_id = $1 AND archived_at IS NULL AND unit_id = ANY($2::uuid[])`,
      [orgId, unitIds],
    );
    for (const room of rooms.rows) index.rooms.set(`${room.unit_id}\n${room.label}`, { id: room.id, unitId: room.unit_id });
    const leases = await client.query<{
      unit_id: string;
      room_label: string | null;
      target_unit: string | null;
      start: string;
      end: string;
      phone: string | null;
      id_hash: string | null;
      tenant_id: string;
      rent: string;
      deposit: string;
      due_day: number;
    }>(
      `SELECT l.unit_id::text, r.label AS room_label, l.target_unit_id::text AS target_unit,
              l.start_date::text AS start, coalesce(l.end_date::text, '9999-12-31') AS end,
              c.phone_e164 AS phone, c.id_number_hash AS id_hash, lp.contact_id::text AS tenant_id,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.due_day
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
        WHERE l.org_id = $1 AND l.status IN ('pending_signature', 'active')
          AND l.unit_id = ANY($2::uuid[])`,
      [orgId, unitIds],
    );
    for (const lease of leases.rows) {
      index.leases.push({
        spaceKey: lease.room_label ? `room:${lease.unit_id}:${lease.room_label}` : `unit:${lease.target_unit ?? lease.unit_id}`,
        start: lease.start,
        end: lease.end,
        phone: lease.phone,
        idHash: lease.id_hash,
        tenantId: lease.tenant_id,
        rentMinor: Number(lease.rent),
        depositMinor: Number(lease.deposit),
        dueDay: Number(lease.due_day),
      });
    }
  }

  if (emails.length || ownerNames.length) {
    const owners = await client.query<{ id: string; email: string | null; display_name: string }>(
      `SELECT id::text, lower(email::text) AS email, display_name
         FROM contacts
        WHERE org_id = $1 AND is_owner AND archived_at IS NULL
          AND (lower(email::text) = ANY($2::text[]) OR display_name = ANY($3::text[]))`,
      [orgId, emails, ownerNames],
    );
    for (const owner of owners.rows) {
      if (owner.email) index.ownersByEmail.set(owner.email, owner.id);
      index.ownersByName.set(owner.display_name, owner.id);
    }
  }
  if (phones.length || hashes.length) {
    const tenants = await client.query<{ id: string; phone_e164: string | null; id_number_hash: string | null; display_name: string }>(
      `SELECT id::text, phone_e164, id_number_hash, display_name
         FROM contacts
        WHERE org_id = $1 AND is_tenant AND archived_at IS NULL
          AND (phone_e164 = ANY($2::text[]) OR id_number_hash = ANY($3::text[]))`,
      [orgId, phones, hashes],
    );
    for (const tenant of tenants.rows) {
      const ref = { id: tenant.id, name: tenant.display_name };
      addTenantKey(index.tenantsByPhone, tenant.phone_e164, ref);
      addTenantKey(index.tenantsByHash, tenant.id_number_hash, ref);
    }
  }
  return index;
}

async function readCappedText(request: Request, maxBytes: number) {
  const stream = request.body;
  if (!stream) throw new FlowError("im_body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new FlowError("im_body");
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or the caller cancelled it.
    }
  }
  if (total === 0) throw new FlowError("im_body");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function logImportTiming(mode: "dry" | "commit", rows: number, started: number) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`[import] ${mode} ${rows} rows in ${Math.round(performance.now() - started)}ms`);
}

async function persistPlans(client: Client, session: Session, parsed: ParsedImportRow[], index: ReturnType<typeof emptyIndex>, jurisdictionId: string) {
  const planned = planRows(parsed, index);
  if (!planned.some((plan) => !plan.blocked)) return planned;
  try {
    await client.query("SAVEPOINT import_bulk");
    await bulkWrite(client, session, planned, jurisdictionId);
    await client.query("RELEASE SAVEPOINT import_bulk");
    return planned;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT import_bulk");
    await client.query("RELEASE SAVEPOINT import_bulk");
    if (process.env.NODE_ENV !== "production") {
      console.error("import bulk insert fell back", error instanceof Error ? error.message : error);
    }
    return writePlansPerRow(client, session, parsed, jurisdictionId);
  }
}

async function writePlansPerRow(client: Client, session: Session, parsed: ParsedImportRow[], jurisdictionId: string) {
  const index = await loadIndex(client, session.orgId, parsed);
  const plans: RowPlan[] = [];
  for (const row of parsed) {
    const plan = planOne(row, index);
    if (!plan.blocked) {
      await client.query("SAVEPOINT import_row");
      try {
        await writeRow(client, session, plan, jurisdictionId);
        await client.query("RELEASE SAVEPOINT import_row");
        rememberPlan(index, plan);
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT import_row");
        await client.query("RELEASE SAVEPOINT import_row");
        fail(plan, issueFromDb(row.line, error));
      }
    }
    plans.push(plan);
  }
  return plans;
}

function materializeIds(plans: RowPlan[]) {
  const ids = new Map<string, string>();
  const real = (id: string | null) => {
    if (!id || !id.startsWith("new-")) return id;
    let next = ids.get(id);
    if (!next) {
      next = randomUUID();
      ids.set(id, next);
    }
    return next;
  };
  for (const plan of plans) {
    plan.propertyId = real(plan.propertyId);
    plan.unitId = real(plan.unitId);
    plan.roomId = real(plan.roomId);
    plan.ownerId = real(plan.ownerId);
    plan.tenantId = real(plan.tenantId);
  }
}

async function bulkWrite(client: Client, session: Session, plans: RowPlan[], jurisdictionId: string) {
  const live = plans.filter((plan) => !plan.blocked);
  materializeIds(live);
  await insertProperties(client, session, live, jurisdictionId);
  await insertPeople(client, session, live);
  await insertPropertyOwners(client, session, live);
  await insertUnits(client, session, live);
  await insertRooms(client, session, live);
  const leaseIds = new Map<RowPlan, string>();
  await insertLeases(client, session, live, leaseIds);
  await insertParties(client, session, live, leaseIds);
  await upsertListingsBulk(client, session.orgId, live);
}

async function insertProperties(client: Client, session: Session, plans: RowPlan[], jurisdictionId: string) {
  const rows = uniquePlans(plans.filter((plan) => plan.createProperty && plan.propertyId), (plan) => plan.propertyId ?? "");
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO properties (
       id, org_id, name, address, address_display, address_key, country_code, jurisdiction_id, currency, timezone, default_rental_mode
     )
     SELECT t.id, $1, t.name, t.address::jsonb, t.address_display, t.address_key, 'TW', $2, 'TWD', 'Asia/Taipei', t.mode::rental_mode
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS t(id, name, address, address_display, address_key, mode)`,
    [
      session.orgId,
      jurisdictionId,
      rows.map((plan) => plan.propertyId),
      rows.map((plan) => plan.row.propertyName),
      rows.map((plan) => JSON.stringify({ country: "TW", line: plan.row.address })),
      rows.map((plan) => plan.row.address),
      rows.map((plan) => plan.row.addressKey),
      rows.map((plan) => dbMode(plan.row.kind)),
    ],
  );
}

async function insertPeople(client: Client, session: Session, plans: RowPlan[]) {
  const people: { id: string; owner: boolean; tenant: boolean; name: string; email: string; phone: string; hash: string }[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    if (plan.createOwner && plan.ownerId && !seen.has(plan.ownerId)) {
      seen.add(plan.ownerId);
      people.push({
        id: plan.ownerId,
        owner: true,
        tenant: false,
        name: plan.row.ownerName,
        email: plan.row.ownerEmail ?? "",
        phone: "",
        hash: "",
      });
    }
    if (plan.createTenant && plan.tenantId && !seen.has(plan.tenantId)) {
      seen.add(plan.tenantId);
      people.push({
        id: plan.tenantId,
        owner: false,
        tenant: true,
        name: plan.row.tenantName ?? "",
        email: plan.row.tenantEmail ?? "",
        phone: plan.row.phoneE164 ?? "",
        hash: plan.row.tenantIdHash ?? "",
      });
    }
  }
  if (people.length === 0) return;
  await client.query(
    `INSERT INTO contacts (id, org_id, is_owner, is_tenant, display_name, email, phone_e164, id_number_hash, locale)
     SELECT t.id, $1, t.is_owner, t.is_tenant, t.display_name, NULLIF(t.email, ''), NULLIF(t.phone, ''), NULLIF(t.hash, ''), $2
       FROM unnest($3::uuid[], $4::bool[], $5::bool[], $6::text[], $7::text[], $8::text[], $9::text[])
         AS t(id, is_owner, is_tenant, display_name, email, phone, hash)`,
    [
      session.orgId,
      session.locale,
      people.map((person) => person.id),
      people.map((person) => person.owner),
      people.map((person) => person.tenant),
      people.map((person) => person.name),
      people.map((person) => person.email),
      people.map((person) => person.phone),
      people.map((person) => person.hash),
    ],
  );
}

async function insertPropertyOwners(client: Client, session: Session, plans: RowPlan[]) {
  const links = uniquePlans(
    plans.filter((plan) => plan.propertyId && plan.ownerId),
    (plan) => `${plan.propertyId}:${plan.ownerId}`,
  );
  if (links.length === 0) return;
  await client.query(
    `WITH incoming AS (
       SELECT DISTINCT property_id, owner_id
         FROM unnest($2::uuid[], $3::uuid[]) AS t(property_id, owner_id)
     ), ranked AS (
       SELECT property_id, owner_id, row_number() OVER (PARTITION BY property_id ORDER BY owner_id) AS n
         FROM incoming
     )
     INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
     SELECT $1, r.property_id, r.owner_id,
            r.n = 1 AND NOT EXISTS (SELECT 1 FROM property_owners po WHERE po.property_id = r.property_id)
       FROM ranked r
      WHERE NOT EXISTS (
        SELECT 1 FROM property_owners po
         WHERE po.property_id = r.property_id AND po.owner_contact_id = r.owner_id
      )`,
    [session.orgId, links.map((plan) => plan.propertyId), links.map((plan) => plan.ownerId)],
  );
}

/** 'included' is not in the existing electricity_method check. Store it on the nullable flag. */
function electricityStored(method: string | null | undefined) {
  if (method === "included") return { method: "", included: true };
  return { method: method ?? "", included: false };
}

async function insertUnits(client: Client, session: Session, plans: RowPlan[]) {
  const rows = uniquePlans(plans.filter((plan) => plan.createUnit && plan.unitId && plan.propertyId), (plan) => plan.unitId ?? "");
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO units (
       id, org_id, property_id, label, floor, rental_mode, area_value, area_unit, base_rent_minor, import_address_key,
       electricity_method, electricity_included, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
     )
     SELECT t.id, $1, t.property_id, t.label, t.floor, t.mode::rental_mode, t.area, 'ping', t.rent, t.address_key,
            NULLIF(t.electricity, ''), t.included, t.rate, t.kwh, t.bill, NULLIF(t.rate_reason, ''), NULLIF(t.notes, '')
       FROM unnest(
         $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[],
         $7::numeric[], $8::bigint[], $9::text[],
         $10::text[], $11::boolean[], $12::numeric[], $13::numeric[], $14::bigint[], $15::text[], $16::text[]
       ) AS t(id, property_id, label, floor, mode, area, rent, address_key, electricity, included, rate, kwh, bill, rate_reason, notes)`,
    [
      session.orgId,
      rows.map((plan) => plan.unitId),
      rows.map((plan) => plan.propertyId),
      rows.map((plan) => plan.row.unitLabel),
      rows.map((plan) => plan.row.unitLabel),
      rows.map((plan) => dbMode(plan.row.kind)),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.area : null)),
      rows.map((plan) => plan.row.rentMinor),
      rows.map((plan) => plan.row.addressKey),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? electricityStored(plan.row.electricity).method : "")),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? electricityStored(plan.row.electricity).included : false)),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.rate : null)),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.billKwh : null)),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.billAmountMinor : null)),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.rateReason ?? "" : "")),
      rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.row.notes ?? "" : "")),
    ],
  );
}

async function insertRooms(client: Client, session: Session, plans: RowPlan[]) {
  const rows = uniquePlans(
    plans.filter((plan) => plan.createRoom && plan.roomId && plan.unitId && plan.row.roomLabel),
    (plan) => plan.roomId ?? "",
  );
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO rooms (
       id, org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor,
       electricity_method, electricity_included, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
     )
     SELECT t.id, $1, t.unit_id, t.label, t.room_type::room_type, t.area, 'ping', t.rent,
            NULLIF(t.electricity, ''), t.included, t.rate, t.kwh, t.bill, NULLIF(t.rate_reason, ''), NULLIF(t.notes, '')
       FROM unnest(
         $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::numeric[], $7::bigint[],
         $8::text[], $9::boolean[], $10::numeric[], $11::numeric[], $12::bigint[], $13::text[], $14::text[]
       ) AS t(id, unit_id, label, room_type, area, rent, electricity, included, rate, kwh, bill, rate_reason, notes)`,
    [
      session.orgId,
      rows.map((plan) => plan.roomId),
      rows.map((plan) => plan.unitId),
      rows.map((plan) => plan.row.roomLabel),
      rows.map((plan) => plan.row.roomType),
      rows.map((plan) => plan.row.area),
      rows.map((plan) => plan.row.rentMinor),
      rows.map((plan) => electricityStored(plan.row.electricity).method),
      rows.map((plan) => electricityStored(plan.row.electricity).included),
      rows.map((plan) => plan.row.rate),
      rows.map((plan) => plan.row.billKwh),
      rows.map((plan) => plan.row.billAmountMinor),
      rows.map((plan) => plan.row.rateReason ?? ""),
      rows.map((plan) => plan.row.notes ?? ""),
    ],
  );
}

function leaseRows(plans: RowPlan[]) {
  return plans.filter(
    (plan) => plan.createLease && plan.tenantId && plan.propertyId && plan.unitId && plan.row.startDate && plan.row.endDate && plan.row.dueDay !== null,
  );
}

async function insertLeases(client: Client, session: Session, plans: RowPlan[], leaseIds: Map<RowPlan, string>) {
  const rows = leaseRows(plans);
  if (rows.length === 0) return;
  for (const plan of rows) if (!leaseIds.has(plan)) leaseIds.set(plan, randomUUID());
  const reasons = [...new Set(rows.map((plan) => plan.row.depositReason).filter((reason): reason is string => Boolean(reason)))];
  if (reasons.length === 1) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reasons[0]]);
  try {
    await client.query(
      `INSERT INTO leases (
         id, org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
         deposit_amount_minor, deposit_months, deposit_override_reason, deposit_overridden_by, deposit_overridden_at,
         notes, created_by
       )
       SELECT t.id, $1, t.property_id, t.unit_id, NULLIF(t.target_unit, '')::uuid, NULLIF(t.target_room, '')::uuid,
              'active', 'imported', t.start_date::date, t.end_date::date, 'TWD', t.rent, t.due_day::smallint, false,
              t.deposit, t.months, NULLIF(t.reason, ''), NULLIF(t.by_user, '')::uuid, NULLIF(t.at, '')::timestamptz,
              NULLIF(t.notes, ''), $2
         FROM unnest(
           $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::bigint[], $11::text[], $12::bigint[], $13::numeric[],
           $14::text[], $15::text[], $16::text[], $17::text[]
         ) AS t(id, property_id, unit_id, target_unit, target_room, start_date, end_date, rent, due_day, deposit, months, reason, by_user, at, notes)`,
      [
        session.orgId,
        session.userId,
        rows.map((plan) => leaseIds.get(plan)),
        rows.map((plan) => plan.propertyId),
        rows.map((plan) => plan.unitId),
        rows.map((plan) => (plan.row.kind === "whole_unit" ? plan.unitId : "")),
        rows.map((plan) => (plan.row.kind === "room" ? plan.roomId ?? "" : "")),
        rows.map((plan) => plan.row.startDate),
        rows.map((plan) => plan.row.endDate),
        rows.map((plan) => plan.row.rentMinor),
        rows.map((plan) => String(plan.row.dueDay)),
        rows.map((plan) => plan.row.depositMinor),
        rows.map((plan) => plan.row.depositMonths),
        rows.map((plan) => (depositExceedsCap(plan.row.depositMonths) ? plan.row.depositReason ?? "" : "")),
        rows.map((plan) => (depositExceedsCap(plan.row.depositMonths) && plan.row.depositReason ? session.userId : "")),
        rows.map((plan) => (depositExceedsCap(plan.row.depositMonths) && plan.row.depositReason ? new Date().toISOString() : "")),
        rows.map((plan) => plan.row.notes ?? ""),
      ],
    );
  } finally {
    if (reasons.length === 1) await client.query(`SELECT set_config('app.change_reason', '', true)`);
  }
}

async function insertParties(client: Client, session: Session, plans: RowPlan[], leaseIds: Map<RowPlan, string>) {
  const rows = leaseRows(plans);
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO lease_parties (org_id, lease_id, contact_id, role)
     SELECT $1, t.lease_id, t.contact_id, 'primary'
       FROM unnest($2::uuid[], $3::uuid[]) AS t(lease_id, contact_id)`,
    [session.orgId, rows.map((plan) => leaseIds.get(plan)), rows.map((plan) => plan.tenantId)],
  );
}

async function upsertListingsBulk(client: Client, orgId: string, plans: RowPlan[]) {
  const wanted = plans.filter((plan) => plan.createLease || plan.createUnit || plan.createRoom);
  const units = new Map<string, RowPlan>();
  const rooms = new Map<string, RowPlan>();
  for (const plan of wanted) {
    if (plan.row.kind === "room" && plan.roomId) rooms.set(plan.roomId, plan);
    else if (plan.unitId) units.set(plan.unitId, plan);
  }
  await upsertListingGroup(client, orgId, [...units.values()], "unit");
  await upsertListingGroup(client, orgId, [...rooms.values()], "room");
}

async function upsertListingGroup(client: Client, orgId: string, plans: RowPlan[], kind: "unit" | "room") {
  if (plans.length === 0) return;
  const conflict = kind === "unit" ? "(unit_id) WHERE unit_id IS NOT NULL" : "(room_id) WHERE room_id IS NOT NULL";
  await client.query(
    `INSERT INTO listing_terms (
       org_id, unit_id, room_id, tenant_name, tenant_phone, tenant_email, lease_start, lease_end,
       deposit_minor, rent_due_day, deposit_cap_reason, opening_arrears_minor
     )
     SELECT $1, NULLIF(t.unit_id, '')::uuid, NULLIF(t.room_id, '')::uuid, NULLIF(t.tenant_name, ''), NULLIF(t.phone, ''),
            NULLIF(t.email, ''), NULLIF(t.lease_start, '')::date, NULLIF(t.lease_end, '')::date,
            NULLIF(t.deposit, '')::bigint, NULLIF(t.due_day, '')::smallint, NULLIF(t.reason, ''), t.opening
       FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::bigint[]
       ) AS t(unit_id, room_id, tenant_name, phone, email, lease_start, lease_end, deposit, due_day, reason, opening)
     ON CONFLICT ${conflict}
     DO UPDATE SET
       tenant_name = EXCLUDED.tenant_name,
       tenant_phone = EXCLUDED.tenant_phone,
       tenant_email = EXCLUDED.tenant_email,
       lease_start = EXCLUDED.lease_start,
       lease_end = EXCLUDED.lease_end,
       deposit_minor = EXCLUDED.deposit_minor,
       rent_due_day = EXCLUDED.rent_due_day,
       deposit_cap_reason = EXCLUDED.deposit_cap_reason,
       opening_arrears_minor = EXCLUDED.opening_arrears_minor,
       updated_at = now()`,
    [
      orgId,
      plans.map((plan) => (kind === "unit" ? plan.unitId ?? "" : "")),
      plans.map((plan) => (kind === "room" ? plan.roomId ?? "" : "")),
      plans.map((plan) => plan.row.tenantName ?? ""),
      plans.map((plan) => plan.row.phoneE164 ?? ""),
      plans.map((plan) => plan.row.tenantEmail ?? ""),
      plans.map((plan) => (plan.row.lease ? plan.row.startDate ?? "" : "")),
      plans.map((plan) => (plan.row.lease ? plan.row.endDate ?? "" : "")),
      plans.map((plan) => (plan.row.lease ? String(plan.row.depositMinor) : "")),
      plans.map((plan) => (plan.row.dueDay === null ? "" : String(plan.row.dueDay))),
      plans.map((plan) => plan.row.depositReason ?? ""),
      plans.map((plan) => plan.row.openingMinor),
    ],
  );
}

function uniquePlans(plans: RowPlan[], key: (plan: RowPlan) => string) {
  const seen = new Set<string>();
  const out: RowPlan[] = [];
  for (const plan of plans) {
    const id = key(plan);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(plan);
  }
  return out;
}

async function writeRow(client: Client, session: Session, plan: RowPlan, jurisdictionId: string) {
  const row = plan.row;
  if (plan.createProperty) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO properties (
         org_id, name, address, address_display, address_key, country_code, jurisdiction_id, currency, timezone, default_rental_mode
       ) VALUES ($1,$2,$3::jsonb,$4,$5,'TW',$6,'TWD','Asia/Taipei',$7)
       RETURNING id::text`,
      [
        session.orgId,
        row.propertyName,
        JSON.stringify({ country: "TW", line: row.address }),
        row.address,
        row.addressKey,
        jurisdictionId,
        dbMode(row.kind),
      ],
    );
    plan.propertyId = created.id;
  }
  if (!plan.propertyId || plan.propertyId.startsWith("new-")) throw new FlowError("errors.generic");
  if (plan.createOwner) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       VALUES ($1, true, $2, $3, $4) RETURNING id::text`,
      [session.orgId, row.ownerName, row.ownerEmail, session.locale],
    );
    plan.ownerId = created.id;
  }
  if (plan.ownerId && !plan.ownerId.startsWith("new-")) {
    await client.query(
      `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
       SELECT $1, $2, $3, NOT EXISTS (SELECT 1 FROM property_owners WHERE property_id = $2)
        WHERE NOT EXISTS (
          SELECT 1 FROM property_owners WHERE property_id = $2 AND owner_contact_id = $3
        )`,
      [session.orgId, plan.propertyId, plan.ownerId],
    );
  }
  if (plan.createUnit) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO units (
         org_id, property_id, label, floor, rental_mode, area_value, area_unit, base_rent_minor, import_address_key,
         electricity_method, electricity_included, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'ping',$7,$8,$9,$10,$11,$12,$13,$14,$15
       ) RETURNING id::text`,
      [
        session.orgId,
        plan.propertyId,
        row.unitLabel,
        row.unitLabel,
        dbMode(row.kind),
        row.kind === "whole_unit" ? row.area : null,
        row.rentMinor,
        row.addressKey,
        row.kind === "whole_unit" ? electricityStored(row.electricity).method || null : null,
        row.kind === "whole_unit" ? electricityStored(row.electricity).included : false,
        row.kind === "whole_unit" ? row.rate : null,
        row.kind === "whole_unit" ? row.billKwh : null,
        row.kind === "whole_unit" ? row.billAmountMinor : null,
        row.kind === "whole_unit" ? row.rateReason : null,
        row.kind === "whole_unit" ? row.notes : null,
      ],
    );
    plan.unitId = created.id;
  }
  if (!plan.unitId || plan.unitId.startsWith("new-")) throw new FlowError("errors.generic");
  if (plan.createRoom && row.roomLabel) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO rooms (
         org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor,
         electricity_method, electricity_included, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
       ) VALUES ($1,$2,$3,$4::room_type,$5,'ping',$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id::text`,
      [
        session.orgId,
        plan.unitId,
        row.roomLabel,
        row.roomType,
        row.area,
        row.rentMinor,
        electricityStored(row.electricity).method || null,
        electricityStored(row.electricity).included,
        row.rate,
        row.billKwh,
        row.billAmountMinor,
        row.rateReason,
        row.notes,
      ],
    );
    plan.roomId = created.id;
  }
  if (plan.createTenant) {
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO contacts (org_id, is_tenant, display_name, email, phone_e164, id_number_hash, locale)
       VALUES ($1, true, $2, $3, $4, $5, $6) RETURNING id::text`,
      [session.orgId, row.tenantName, row.tenantEmail, row.phoneE164, row.tenantIdHash, session.locale],
    );
    plan.tenantId = created.id;
  }
  if (plan.createLease && plan.tenantId && row.startDate && row.endDate && row.dueDay !== null) {
    const over = depositExceedsCap(row.depositMonths);
    const reason = over ? row.depositReason : null;
    if (reason) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reason]);
    const lease = await one<{ id: string }>(
      client,
      `INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
         deposit_amount_minor, deposit_months, deposit_override_reason, deposit_overridden_by, deposit_overridden_at,
         notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,'active','imported',$6,$7,'TWD',$8,$9,false,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING id::text`,
      [
        session.orgId,
        plan.propertyId,
        plan.unitId,
        row.kind === "whole_unit" ? plan.unitId : null,
        row.kind === "room" ? plan.roomId : null,
        row.startDate,
        row.endDate,
        row.rentMinor,
        row.dueDay,
        row.depositMinor,
        row.depositMonths,
        reason,
        reason ? session.userId : null,
        reason ? new Date() : null,
        row.notes,
        session.userId,
      ],
    );
    if (reason) await client.query(`SELECT set_config('app.change_reason', '', true)`);
    await client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
      [session.orgId, lease.id, plan.tenantId],
    );
    await upsertListing(client, session.orgId, plan);
  } else if (plan.createUnit || plan.createRoom) {
    await upsertListing(client, session.orgId, plan);
  }
}

async function upsertListing(client: Client, orgId: string, plan: RowPlan) {
  const row = plan.row;
  const roomId = row.kind === "room" ? plan.roomId : null;
  const unitId = row.kind === "whole_unit" ? plan.unitId : null;
  if (!roomId && !unitId) return;
  const existing = await maybe<{ id: string }>(
    client,
    roomId
      ? `SELECT id::text FROM listing_terms WHERE org_id = $1 AND room_id = $2`
      : `SELECT id::text FROM listing_terms WHERE org_id = $1 AND unit_id = $2`,
    [orgId, roomId ?? unitId],
  );
  const params = [
    row.tenantName,
    row.phoneE164,
    row.tenantEmail,
    row.lease ? row.startDate : null,
    row.lease ? row.endDate : null,
    row.lease ? row.depositMinor : null,
    row.dueDay,
    row.depositReason,
    row.openingMinor,
  ];
  if (existing) {
    await client.query(
      `UPDATE listing_terms
          SET tenant_name = $3, tenant_phone = $4, tenant_email = $5, lease_start = $6, lease_end = $7,
              deposit_minor = $8, rent_due_day = $9, deposit_cap_reason = $10, opening_arrears_minor = $11, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [existing.id, orgId, ...params],
    );
    return;
  }
  await client.query(
    `INSERT INTO listing_terms (
       org_id, unit_id, room_id, tenant_name, tenant_phone, tenant_email, lease_start, lease_end,
       deposit_minor, rent_due_day, deposit_cap_reason, opening_arrears_minor
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [orgId, unitId, roomId, ...params],
  );
}

function dbMode(kind: SpaceKind) {
  return kind === "room" ? "by_room" : "whole_unit";
}

function unique(values: string[]) {
  return [...new Set(values)];
}
