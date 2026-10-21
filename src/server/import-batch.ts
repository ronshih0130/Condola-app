import { createHash } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, tx } from "./db";
import { FlowError } from "./errors";
import { DEPOSIT_CAP_MONTHS, depositExceedsCap } from "./lease-rules";
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_MAX_ROWS,
  addressKey,
  coerceImportRows,
  emptyIndex,
  planOne,
  planRows,
  rememberPlan,
  totalsFromPlans,
  validateImportRows,
  type ImportIssue,
  type ImportResult,
  type ParsedImportRow,
  type RowPlan,
  type SpaceKind,
} from "./owner-import";
import { assertPerm } from "./perms";
import type { Session } from "./types";

export type { ImportResult };

/** Validated JSON only. File bytes stay in the browser. */
export async function dryRunImport(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportResult> {
  assertImport(session);
  const rows = coerceImportRows(input.rows);
  if (rows.length > IMPORT_MAX_ROWS) throw new FlowError("im_too_many", { n: rows.length, max: IMPORT_MAX_ROWS });
  const parsed = stampHashes(validateImportRows(rows));
  const fileName = cleanName(input.fileName);
  if (parsed.length === 0) return totalsFromPlans([], fileName, true);
  return tx(session.userId, async (client) => {
    const index = await loadIndex(client, session.orgId, parsed);
    return totalsFromPlans(planRows(parsed, index), fileName, true);
  }, scope(session));
}

/** One audit row for this batch. Callers send at most IMPORT_COMMIT_BATCH rows. */
export async function commitImportBatch(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportResult> {
  assertImport(session);
  const rows = coerceImportRows(input.rows);
  if (rows.length > IMPORT_COMMIT_BATCH) throw new FlowError("im_too_many", { n: rows.length, max: IMPORT_COMMIT_BATCH });
  const parsed = stampHashes(validateImportRows(rows));
  const fileName = cleanName(input.fileName);
  if (parsed.length === 0) return totalsFromPlans([], fileName, false);
  const result = await tx(session.userId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`import:${session.orgId}`]);
    const index = await loadIndex(client, session.orgId, parsed);
    const jurisdiction = await one<{ id: string }>(client, `SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
    const member = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.orgId, session.userId],
    );
    const plans: RowPlan[] = [];
    for (const row of parsed) {
      const plan = planOne(row, index);
      if (plan.blocked) {
        plans.push(plan);
        continue;
      }
      if (plan.createLease && !member) {
        fail(plan, { line: row.line, severity: "error", key: "errors.generic" });
        plans.push(plan);
        continue;
      }
      await client.query("SAVEPOINT import_row");
      try {
        await writeRow(client, session, plan, jurisdiction.id, member?.id ?? null);
        await client.query("RELEASE SAVEPOINT import_row");
        rememberPlan(index, plan);
        plans.push(plan);
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT import_row");
        await client.query("RELEASE SAVEPOINT import_row");
        fail(plan, issueFromDb(row.line, error));
        plans.push(plan);
      }
    }
    const totals = totalsFromPlans(plans, fileName, false);
    const failed = plans.filter((plan) => plan.blocked).length;
    await client.query(
      `INSERT INTO import_jobs (
         org_id, entity, column_map, status, rows_total, rows_ok, rows_failed, error_report, requested_by, finished_at
       ) VALUES ($1, 'bulk', $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, now())`,
      [
        session.orgId,
        JSON.stringify({ fileName }),
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

function stampHashes(rows: ParsedImportRow[]) {
  for (const row of rows) {
    if (!row.tenantId) continue;
    const normal = row.tenantId.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
    row.tenantIdHash = createHash("sha256").update(normal).digest("hex");
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
            coalesce(u.import_address_key, p.address_key, '') AS address_key, p.address_display
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.org_id = $1 AND u.archived_at IS NULL
        AND (
          u.import_address_key = ANY($2::text[])
          OR p.address_key = ANY($2::text[])
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
    }>(
      `SELECT l.unit_id::text, r.label AS room_label, l.target_unit_id::text AS target_unit,
              l.start_date::text AS start, coalesce(l.end_date::text, '9999-12-31') AS end,
              c.phone_e164 AS phone, c.id_number_hash AS id_hash
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
    const tenants = await client.query<{ id: string; phone_e164: string | null; id_number_hash: string | null }>(
      `SELECT id::text, phone_e164, id_number_hash
         FROM contacts
        WHERE org_id = $1 AND is_tenant AND archived_at IS NULL
          AND (phone_e164 = ANY($2::text[]) OR id_number_hash = ANY($3::text[]))`,
      [orgId, phones, hashes],
    );
    for (const tenant of tenants.rows) {
      if (tenant.phone_e164) index.tenantsByPhone.set(tenant.phone_e164, tenant.id);
      if (tenant.id_number_hash) index.tenantsByHash.set(tenant.id_number_hash, tenant.id);
    }
  }
  return index;
}

async function writeRow(client: Client, session: Session, plan: RowPlan, jurisdictionId: string, memberId: string | null) {
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
         electricity_method, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'ping',$7,$8,$9,$10,$11,$12,$13,$14
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
        row.kind === "whole_unit" ? row.electricity : null,
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
         electricity_method, rate_per_kwh, taipower_kwh, taipower_amount_minor, rate_cap_reason, notes
       ) VALUES ($1,$2,$3,$4::room_type,$5,'ping',$6,$7,$8,$9,$10,$11,$12)
       RETURNING id::text`,
      [
        session.orgId,
        plan.unitId,
        row.roomLabel,
        row.roomType,
        row.area,
        row.rentMinor,
        row.electricity,
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
  if (plan.createLease && plan.tenantId && row.startDate && row.endDate && row.dueDay !== null && memberId) {
    const over = depositExceedsCap(row.depositMonths);
    const reason = over ? row.depositReason : null;
    if (reason) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reason]);
    const documentHash = createHash("sha256")
      .update(JSON.stringify({ space: plan.roomId ?? plan.unitId, rent: row.rentMinor, deposit: row.depositMinor, start: row.startDate, end: row.endDate }))
      .digest("hex");
    const lease = await one<{ id: string }>(
      client,
      `INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
         deposit_amount_minor, deposit_months, deposit_override_reason, deposit_overridden_by, deposit_overridden_at,
         document_sha256, signed_at, notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,'active','fully_signed',$6,$7,'TWD',$8,$9,false,$10,$11,$12,$13,$14,$15,now(),$16,$17
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
        documentHash,
        row.notes,
        session.userId,
      ],
    );
    if (reason) await client.query(`SELECT set_config('app.change_reason', '', true)`);
    await client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
      [session.orgId, lease.id, plan.tenantId],
    );
    await client.query(
      `INSERT INTO lease_signatures (
         org_id, lease_id, signer_role, contact_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at
       ) VALUES ($1,$2,'tenant',$3,'signed',1,$4,$5,'lease.consent', now())`,
      [session.orgId, lease.id, plan.tenantId, row.tenantName, documentHash],
    );
    await client.query(
      `INSERT INTO lease_signatures (
         org_id, lease_id, signer_role, member_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at
       ) VALUES ($1,$2,'manager',$3,'signed',2,$4,$5,'lease.consent', now())`,
      [session.orgId, lease.id, memberId, session.name, documentHash],
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
      ? `SELECT id::text FROM listing_terms WHERE room_id = $1`
      : `SELECT id::text FROM listing_terms WHERE unit_id = $1`,
    [roomId ?? unitId],
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
          SET tenant_name = $2, tenant_phone = $3, tenant_email = $4, lease_start = $5, lease_end = $6,
              deposit_minor = $7, rent_due_day = $8, deposit_cap_reason = $9, opening_arrears_minor = $10, updated_at = now()
        WHERE id = $1`,
      [existing.id, ...params],
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
