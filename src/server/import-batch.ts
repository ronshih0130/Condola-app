import { recordUsage, usageDedupeKey } from './usage-events';
import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { one, tx } from "./db";
import { FlowError } from "./errors";
import { depositExceedsCap } from "./lease-rules";
import {
  IMPORT_DRY_BATCH,
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_BATCH,
  addressKey,
  coerceImportRows,
  emptyIndex,
  indexTenantPhone,
  phoneMatchKeys,
  planRows,
  totalsFromPlans,
  validateImportRows,
  unitKey,
  type ImportIssue,
  type ImportResult,
  type ParsedImportRow,
  type RowPlan,
  type SpaceKind,
} from "./owner-import";
import { assertPerm } from "./perms";
import { admitArchiveBatch } from "./record-archive-admission";
import { assertCurrentArchiveCaller } from "./record-archive-caller";
import { isUuid } from "./repair-rules";
import type { ArchiveRef } from "@/lib/record-archive";
import { loadImportRegion } from "./import-region-context";
import type { ImportRegion } from "./import-region";
import type { Session } from "./types";
import { requireOrgScope } from "./org-guard";

export type { ImportResult };

/**
 * Reject uploads before JSON.parse. Counted from the stream, not Content-Length.
 * One commit carries every confirmed row, so 500 rows of JSON must fit.
 */
export const IMPORT_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Rows per INSERT inside the single commit transaction. A 500-row statement
 * was cancelled at the staging statement timeout (~10s) and saved nothing.
 * Smaller statements stay under that limit; the transaction still commits
 * once, or rolls every statement back.
 */
export const IMPORT_WRITE_CHUNK = 100;

export type ImportProgress = (done: number, total: number) => void;

/**
 * Staging's authenticated role cancels statements at about 8s. Commit used to
 * raise that to 60s and preview did not, so the preview check died while save
 * still ran. Every mode raises it. The units lookup no longer normalizes
 * every address in SQL: that expression could not use the address indexes and
 * was the ~40s before the first progress event.
 */
async function relaxStatementTimeout(client: Client) {
  await client.query(`SELECT set_config('statement_timeout', '60s', true)`);
}

export async function readImportBody(request: Request): Promise<{ mode: "dry" | "preview" | "commit"; fileName: string; rows: unknown }> {
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
  if (record.mode !== "dry" && record.mode !== "preview" && record.mode !== "commit") throw new FlowError("im_bad_mode");
  const fileName = typeof record.fileName === "string" ? record.fileName : "";
  if (fileName.length > 200) throw new FlowError("im_e_len", { f: "file", max: 200 });
  return { mode: record.mode, fileName, rows: record.rows };
}

/** Validated JSON only. File bytes stay in the browser. */
export async function dryRunImport(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportResult> {
  session = await guardEffectiveSession(session, "props.edit");
  const started = performance.now();
  let counted = 0;
  try {
    assertImport(session);
    const rows = coerceImportRows(input.rows, IMPORT_DRY_BATCH);
    counted = rows.length;
    const fileName = cleanName(input.fileName);
    if (!rows.length) return totalsFromPlans([], fileName, true);
    return await tx(session.userId, async (client) => withEffectiveAuthority(client, session, "props.edit", async () => {
      const region = await loadImportRegion(client, session.orgId);
      const parsed = validateImportRows(rows, undefined, region);
      await relaxStatementTimeout(client);
      const index = await loadIndex(client, session.orgId, parsed);
      await checkTargetRegions(client, session.orgId, parsed, index, region);
      return totalsFromPlans(planRows(parsed, index), fileName, true);
    }), scope(session));
  } finally {
    logImportTiming("dry", counted, started);
  }
}

/**
 * Same plan as commit, read only. Issues include phone conflicts and rows that
 * already exist, so the preview does not mark them ready to insert.
 */
export async function previewImport(session: Session, input: { fileName: string; rows: unknown }): Promise<ImportIssue[]> {
  session = await guardEffectiveSession(session, "props.edit");
  const started = performance.now();
  let counted = 0;
  try {
    assertImport(session);
    const rows = coerceImportRows(input.rows, IMPORT_PREVIEW_BATCH);
    counted = rows.length;
    if (!rows.length) return [];
    return await tx(session.userId, async (client) => withEffectiveAuthority(client, session, "props.edit", async () => {
      const region = await loadImportRegion(client, session.orgId);
      const parsed = validateImportRows(rows, undefined, region);
      await relaxStatementTimeout(client);
      const index = await loadIndex(client, session.orgId, parsed);
      await checkTargetRegions(client, session.orgId, parsed, index, region);
      return previewIssues(planRows(parsed, index));
    }), scope(session));
  } finally {
    logImportTiming("preview", counted, started);
  }
}

function previewIssues(plans: RowPlan[]) {
  const issues: ImportIssue[] = [];
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === "error" || issue.key === "im_row_exists") issues.push(issue);
    }
  }
  return issues;
}

/**
 * One transaction for the whole confirmed file. Inserts are chunked statements
 * on that connection. Progress is reported after each chunk, and a failure
 * rolls every statement back. A chunk is not its own commit.
 */
export async function commitImportBatch(
  session: Session,
  input: { fileName: string; rows: unknown },
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  session = await guardEffectiveSession(session, "props.edit");
  const started = performance.now();
  let counted = 0;
  try {
    assertImport(session);
    const rows = coerceImportRows(input.rows, IMPORT_MAX_ROWS);
    counted = rows.length;
    const fileName = cleanName(input.fileName);
    if (!rows.length) return totalsFromPlans([], fileName, false);
    let reported = 0;
    const progress: ImportProgress = (done, total) => {
      if (done <= reported) return;
      reported = done;
      onProgress?.(done, total);
    };
    const result = await tx(session.userId, async (client) => withEffectiveAuthority(client, session, "props.edit", async () => {
      const region = await loadImportRegion(client, session.orgId);
      const parsed = validateImportRows(rows, undefined, region);
      if (!parsed.length) return { totals: totalsFromPlans([], fileName, false), saved: false };
      if (parsed.length > 0) progress(1, parsed.length);
      await relaxStatementTimeout(client);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`import:${session.orgId}`]);
      const before = await loadIndex(client, session.orgId, parsed, progress);
      const refs = reusedArchiveRefs(planRows(parsed, before));
      await admitArchiveBatch(client, session.orgId, refs);
      await assertCurrentArchiveCaller(client,session);
      const index = await loadIndex(client, session.orgId, parsed);
      const checkIndex = await loadIndex(client, session.orgId, parsed);
      const rechecked = reusedArchiveRefs(planRows(parsed, checkIndex));
      if (JSON.stringify(refs) !== JSON.stringify(rechecked)) throw new FlowError("errors.notFound");
      await checkTargetRegions(client, session.orgId, parsed, index, region);
      const jurisdiction = region ? { id: region.jurisdictionId } : await one<{ id: string }>(client, `SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
      const plans = await persistPlans(client, session, parsed, index, jurisdiction.id, progress, region);
      await assertCurrentArchiveCaller(client,session);
      const totals = totalsFromPlans(plans, fileName, false);
      const rejected = plans.some((plan) => plan.blocked);
      if (!rejected) {
        await client.query(
          `INSERT INTO import_jobs (
             org_id, entity, column_map, status, rows_total, rows_ok, rows_failed, error_report, requested_by, finished_at
           ) VALUES ($1, 'portfolio', $2::jsonb, 'succeeded', $3, $3, 0, '[]'::jsonb, $4, now())`,
          [session.orgId, JSON.stringify({ fileName, kind: "bulk" }), plans.length, session.userId],
        );
      }
      await assertCurrentArchiveCaller(client,session);
      return { totals, saved: !rejected };
    }), scope(session));
    if (result.saved) {
      try {
        await writeAudit(session.orgId, session.userId, "import_batch", {
          fileName,
          rows: rows.length,
          created: result.totals.created,
          reused: result.totals.reused,
          errors: result.totals.errors.length,
          environment: session.environment,
        });
      } catch (error) {
        console.error("import audit failed", error);
      }
    }
    return result.totals;
  } finally {
    logImportTiming("commit", counted, started);
  }
}

function reusedArchiveRefs(plans:RowPlan[]):ArchiveRef[] {
  const refs=new Map<string,ArchiveRef>();
  for(const p of plans) for(const [kind,id] of [["property",p.propertyId],["unit",p.unitId],["room",p.roomId]] as const) {
    if(id && isUuid(id)) refs.set(`${kind}:${id}`,{kind,id});
  }
  return [...refs.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function assertImport(session: Session) {
  assertPerm(session, "props.edit");
  assertPerm(session, "leases.edit");
}

function scope(session: Session) { return requireOrgScope(session); }

function cleanName(value: string) {
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || "import";
}

async function loadIndex(client: Client, orgId: string, rows: ParsedImportRow[], onProgress?: ImportProgress) {
  const index = emptyIndex();
  const names = unique(rows.map((row) => row.propertyName).filter(Boolean));
  const keys = unique(rows.map((row) => row.addressKey).filter(Boolean));
  const emails = unique(rows.map((row) => row.ownerEmail).filter((value): value is string => Boolean(value)));
  const ownerNames = unique(rows.map((row) => row.ownerName).filter(Boolean));
  const phones = unique(rows.map((row) => row.phoneE164).filter((value): value is string => Boolean(value)));
  const total = rows.length;
  // Leave the rest of the counter for the writes. These ticks are the phase that
  // used to sit at 0 while the address scan ran.
  const budget = Math.max(1, Math.round(total * 0.05));
  const tick = (fraction: number) => {
    if (!onProgress || total === 0) return;
    onProgress(Math.max(1, Math.min(budget, Math.round(budget * fraction))), total);
  };

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
  tick(0.34);

  if (keys.length || names.length) {
    const units = await client.query<{
      id: string;
      property_id: string;
      label: string;
      rental_mode: string;
      address_key: string;
      address_display: string | null;
    }>(
      `SELECT u.id::text, u.property_id::text, u.label, u.rental_mode::text AS rental_mode,
              coalesce(u.import_address_key, p.address_key, '') AS address_key,
              p.address_display
         FROM units u
         JOIN properties p ON p.id = u.property_id
        WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
          AND u.import_address_key = ANY($2::text[])
       UNION
       SELECT u.id::text, u.property_id::text, u.label, u.rental_mode::text AS rental_mode,
              coalesce(u.import_address_key, p.address_key, '') AS address_key,
              p.address_display
         FROM units u
         JOIN properties p ON p.id = u.property_id
        WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
          AND p.address_key = ANY($2::text[])
       UNION
       SELECT u.id::text, u.property_id::text, u.label, u.rental_mode::text AS rental_mode,
              coalesce(u.import_address_key, p.address_key, '') AS address_key,
              p.address_display
         FROM units u
         JOIN properties p ON p.id = u.property_id
        WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
          AND p.name = ANY($3::text[])`,
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
  }
  tick(0.7);

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
      tenant_id: string;
      rent: string;
      deposit: string;
      due_day: number;
    }>(
      `SELECT l.unit_id::text, r.label AS room_label, l.target_unit_id::text AS target_unit,
              l.start_date::text AS start, coalesce(l.end_date::text, '9999-12-31') AS end,
              c.phone_e164 AS phone, lp.contact_id::text AS tenant_id,
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
        start: isoDate(lease.start),
        end: isoDate(lease.end),
        phone: lease.phone,
        idHash: null,
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
  if (phones.length) {
    // Same org the session is pinned to (live or that firm's sandbox). RLS hides the other environment.
    // Match +8869xxxxxxxx and the trunk-zero form +88609xxxxxxxx. Both pass the E.164 check.
    const phoneKeys = unique(phones.flatMap((phone) => phoneMatchKeys(phone)));
    const tenants = await client.query<{ id: string; phone_e164: string | null; display_name: string }>(
      `SELECT id::text, phone_e164, display_name
         FROM contacts
        WHERE org_id = $1 AND is_tenant AND archived_at IS NULL
          AND phone_e164 = ANY($2::text[])`,
      [orgId, phoneKeys],
    );
    for (const tenant of tenants.rows) {
      indexTenantPhone(index.tenantsByPhone, tenant.phone_e164, { id: tenant.id, name: tenant.display_name });
    }
  }
  tick(1);
  return index;
}

async function checkTargetRegions(
  client: Client, orgId: string, rows: ParsedImportRow[], index: ReturnType<typeof emptyIndex>, region: ImportRegion | null,
) {
  if (!region) return;
  const ids = [...new Set([...index.properties.values()].map(property => property.id)
    .concat([...index.units.values()].map(unit => unit.propertyId)))];
  if (!ids.length) return;
  const properties = await client.query<{ id: string; country_code: string; jurisdiction_id: string | null; currency: string; timezone: string }>(
    `SELECT id::text, country_code, jurisdiction_id::text, currency, timezone FROM properties
      WHERE org_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`, [orgId, ids]);
  const compatible = new Set(properties.rows.filter(property => property.country_code === region.country
    && property.jurisdiction_id === region.jurisdictionId && property.currency === region.currency
    && property.timezone === region.timezone).map(property => property.id));
  for (const row of rows) {
    const propertyId = index.units.get(unitKey(row.address, row.unitLabel))?.propertyId
      ?? index.properties.get(row.propertyName)?.id;
    if (propertyId && !compatible.has(propertyId)) row.issues.push({ line: row.line, severity: "error",
      key: "im_region_conflict", fields: ["propertyName", "address"] });
  }
}

function isoDate(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
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

function logImportTiming(mode: "dry" | "preview" | "commit", rows: number, started: number) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`[import] ${mode} ${rows} rows in ${Math.round(performance.now() - started)}ms`);
}

async function persistPlans(
  client: Client,
  session: Session,
  parsed: ParsedImportRow[],
  index: ReturnType<typeof emptyIndex>,
  jurisdictionId: string,
  onProgress?: ImportProgress,
  region?: ImportRegion | null,
) {
  const planned = planRows(parsed, index);
  if (planned.length === 0 || planned.some((plan) => plan.blocked)) return planned;
  await bulkWrite(client, session, planned, jurisdictionId, onProgress, region);
  return planned;
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

async function bulkWrite(client: Client, session: Session, plans: RowPlan[], jurisdictionId: string, onProgress?: ImportProgress, region?: ImportRegion | null) {
  const live = plans.filter((plan) => !plan.blocked);
  materializeIds(live);
  const total = live.length;
  const steps = 8;
  for (let offset = 0; offset < total; offset += IMPORT_WRITE_CHUNK) {
    const chunk = live.slice(offset, offset + IMPORT_WRITE_CHUNK);
    let step = 0;
    const tick = async (work: Promise<unknown>) => {
      await work;
      step += 1;
      onProgress?.(offset + Math.ceil((chunk.length * step) / steps), total);
    };
    await tick(insertProperties(client, session, chunk, jurisdictionId, region));
    await tick(insertPeople(client, session, chunk));
    await tick(insertPropertyOwners(client, session, chunk));
    await tick(insertUnits(client, session, chunk));
    await tick(insertRooms(client, session, chunk));
    const leaseIds = new Map<RowPlan, string>();
    await tick(insertLeases(client, session, chunk, leaseIds, region));
    await tick(insertParties(client, session, chunk, leaseIds));
    await tick(upsertListingsBulk(client, session.orgId, chunk));
  }
}

async function insertProperties(client: Client, session: Session, plans: RowPlan[], jurisdictionId: string, region?: ImportRegion | null) {
  const rows = uniquePlans(plans.filter((plan) => plan.createProperty && plan.propertyId), (plan) => plan.propertyId ?? "");
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO properties (
       id, org_id, name, address, address_display, address_key, country_code, jurisdiction_id, currency, timezone, default_rental_mode
     )
     SELECT t.id, $1, t.name, t.address::jsonb, t.address_display, t.address_key, $9, $2, $10, $11, t.mode::rental_mode
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS t(id, name, address, address_display, address_key, mode)`,
    [
      session.orgId,
      jurisdictionId,
      rows.map((plan) => plan.propertyId),
      rows.map((plan) => plan.row.propertyName),
      rows.map((plan) => JSON.stringify({ country: region?.country ?? "TW", line: plan.row.address })),
      rows.map((plan) => plan.row.address),
      rows.map((plan) => plan.row.addressKey),
      rows.map((plan) => dbMode(plan.row.kind)),
      region?.country ?? "TW", region?.currency ?? "TWD", region?.timezone ?? "Asia/Taipei",
    ],
  );
}

async function insertPeople(client: Client, session: Session, plans: RowPlan[]) {
  const people: { id: string; owner: boolean; tenant: boolean; name: string; email: string; phone: string }[] = [];
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
      });
    }
  }
  if (people.length === 0) return;
  await client.query(
    `INSERT INTO contacts (id, org_id, is_owner, is_tenant, display_name, email, phone_e164, locale)
     SELECT t.id, $1, t.is_owner, t.is_tenant, t.display_name, NULLIF(t.email, ''), NULLIF(t.phone, ''), $2
       FROM unnest($3::uuid[], $4::bool[], $5::bool[], $6::text[], $7::text[], $8::text[])
         AS t(id, is_owner, is_tenant, display_name, email, phone)`,
    [
      session.orgId,
      session.locale,
      people.map((person) => person.id),
      people.map((person) => person.owner),
      people.map((person) => person.tenant),
      people.map((person) => person.name),
      people.map((person) => person.email),
      people.map((person) => person.phone),
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
  for (const plan of rows) await recordUsage(client, { orgId: session.orgId, dimension: 'units', quantity: BigInt(1), occurredAt: new Date(),
    sourceTable: 'units', sourceId: plan.unitId!, dedupeKey: usageDedupeKey('units', 'units', plan.unitId!) });
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

async function insertLeases(client: Client, session: Session, plans: RowPlan[], leaseIds: Map<RowPlan, string>, region?: ImportRegion | null) {
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
              'active', 'imported', t.start_date::date, t.end_date::date, coalesce($18::char(3), 'TWD'::char(3)), t.rent, t.due_day::smallint, false,
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
        region?.currency ?? null,
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

function dbMode(kind: SpaceKind) {
  return kind === "room" ? "by_room" : "whole_unit";
}

function unique(values: string[]) {
  return [...new Set(values)];
}
