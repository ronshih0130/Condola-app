import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  SAMPLE_LABEL,
  loadSampleRows,
  sampleIdMask,
  toE164,
  withSampleName,
  type SampleRow,
} from "./sandbox-data";

/**
 * Portfolio writes are a plugin. Properties, units and rooms are shared with a
 * parallel change; replace `portfolioSeedPlugin` if those tables move.
 * Firm setup (fee template, bank account, team invite) does not touch them.
 */
export type SeedResult = {
  properties: string[];
  units: string[];
  rooms: string[];
  owners: string[];
  tenants: string[];
  leases: string[];
  fees: string[];
  banks: string[];
  invites: string[];
};

export type SeedContext = {
  client: Client;
  orgId: string;
  actorUserId: string;
  memberId: string | null;
  jurisdictionId: string | null;
  currency: string;
  timezone: string;
  rows: SampleRow[];
  result: SeedResult;
  marks: { entity_table: string; entity_id: string }[];
};

export type SandboxSeedPlugin = {
  id: string;
  seed(ctx: SeedContext): Promise<void>;
};

export function emptySeedResult(): SeedResult {
  return {
    properties: [],
    units: [],
    rooms: [],
    owners: [],
    tenants: [],
    leases: [],
    fees: [],
    banks: [],
    invites: [],
  };
}

function remember(ctx: SeedContext, table: string, id: string) {
  ctx.marks.push({ entity_table: table, entity_id: id });
}

async function writeRows(client: Client, sql: string, rows: unknown[], params: unknown[] = []) {
  if (rows.length === 0) return;
  await client.query(sql, [JSON.stringify(rows), ...params]);
}

async function flushMarks(ctx: SeedContext) {
  await writeRows(
    ctx.client,
    `INSERT INTO sample_marks (org_id, entity_table, entity_id, label)
     SELECT $2, m.entity_table, m.entity_id, $3
       FROM jsonb_to_recordset($1::jsonb) AS m(entity_table text, entity_id uuid)
     ON CONFLICT DO NOTHING`,
    ctx.marks,
    [ctx.orgId, SAMPLE_LABEL],
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function minor(major: string) {
  if (!major.trim()) return 0;
  const value = Number(major);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function rentalMode(value: string) {
  return value === "整層" ? "whole_unit" : "by_room";
}

function roomType(value: string) {
  if (value === "套房") return "suite";
  if (value === "雅房") return "shared_bath";
  return "other";
}

function areaOf(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function seedPortfolio(ctx: SeedContext) {
  const ready = await ctx.client.query<{ properties: boolean; units: boolean; rooms: boolean }>(
    `SELECT to_regclass('public.properties') IS NOT NULL AS properties,
            to_regclass('public.units') IS NOT NULL AS units,
            to_regclass('public.rooms') IS NOT NULL AS rooms`,
  );
  const tables = ready.rows[0];
  if (!tables?.properties || !tables.units || !tables.rooms) return;

  const propertyIds = new Map<string, string>();
  const ownerIds = new Map<string, string>();
  const unitIds = new Map<string, string>();
  const tenantIds = new Map<string, string>();
  const properties: unknown[] = [];
  const contacts: unknown[] = [];
  const ownerLinks: unknown[] = [];
  const units: unknown[] = [];
  const rooms: unknown[] = [];
  const leases: unknown[] = [];
  const parties: unknown[] = [];
  const signatures: unknown[] = [];
  let tenantIndex = 0;

  for (const row of ctx.rows) {
    if (!row.property) continue;
    let propertyId = propertyIds.get(row.property);
    if (!propertyId) {
      propertyId = randomUUID();
      propertyIds.set(row.property, propertyId);
      properties.push({
        id: propertyId,
        name: withSampleName(row.property),
        address: { country: "TW", line: row.address },
        address_display: row.address,
        rental_mode: rentalMode(row.rentalMode),
      });
      remember(ctx, "properties", propertyId);
      ctx.result.properties.push(propertyId);

      const ownerKey = row.ownerEmail.toLowerCase();
      let ownerId = ownerIds.get(ownerKey);
      if (!ownerId) {
        ownerId = randomUUID();
        ownerIds.set(ownerKey, ownerId);
        contacts.push({
          id: ownerId,
          is_owner: true,
          is_tenant: false,
          display_name: withSampleName(row.ownerName),
          email: row.ownerEmail,
          phone_e164: null,
          notes: SAMPLE_LABEL,
        });
        remember(ctx, "contacts", ownerId);
        ctx.result.owners.push(ownerId);
      }
      const linkId = randomUUID();
      ownerLinks.push({ id: linkId, property_id: propertyId, owner_contact_id: ownerId });
      remember(ctx, "property_owners", linkId);
    }

    const mode = rentalMode(row.rentalMode);
    const floor = row.floor || "1";
    const unitKey = `${row.property}:${floor}`;
    let unitId = unitIds.get(unitKey);
    if (!unitId) {
      unitId = randomUUID();
      unitIds.set(unitKey, unitId);
      units.push({
        id: unitId,
        property_id: propertyId,
        label: withSampleName(floor),
        floor,
        rental_mode: mode,
        area_value: mode === "whole_unit" ? areaOf(row.area) : null,
        base_rent_minor: mode === "whole_unit" ? minor(row.rent) : null,
      });
      remember(ctx, "units", unitId);
      ctx.result.units.push(unitId);
    }

    let roomId: string | null = null;
    if (mode === "by_room" && row.room) {
      roomId = randomUUID();
      rooms.push({
        id: roomId,
        unit_id: unitId,
        label: withSampleName(row.room),
        room_type: roomType(row.roomType),
        area_value: areaOf(row.area),
        base_rent_minor: minor(row.rent),
      });
      remember(ctx, "rooms", roomId);
      ctx.result.rooms.push(roomId);
    }

    if (!row.tenantName || !row.start) continue;
    const emailKey = (row.tenantEmail || row.tenantName).toLowerCase();
    let tenantId = tenantIds.get(emailKey);
    if (!tenantId) {
      tenantIndex += 1;
      tenantId = randomUUID();
      tenantIds.set(emailKey, tenantId);
      contacts.push({
        id: tenantId,
        is_owner: false,
        is_tenant: true,
        display_name: withSampleName(row.tenantName),
        email: row.tenantEmail || null,
        phone_e164: toE164(row.tenantPhone),
        notes: `${SAMPLE_LABEL} 身分證 ${sampleIdMask(tenantIndex)}`,
      });
      remember(ctx, "contacts", tenantId);
      ctx.result.tenants.push(tenantId);
    }

    const leaseId = randomUUID();
    const rentMinor = minor(row.rent);
    const depositMinor = minor(row.deposit);
    const months = rentMinor > 0 ? Math.round((depositMinor / rentMinor) * 100) / 100 : 0;
    const hash = sha256(leaseId);
    leases.push({
      id: leaseId,
      property_id: propertyId,
      unit_id: unitId,
      target_unit_id: roomId ? null : unitId,
      target_room_id: roomId,
      start_date: row.start,
      end_date: row.end || null,
      rent_amount_minor: rentMinor,
      due_day: Number(row.dueDay) || 5,
      deposit_amount_minor: depositMinor,
      deposit_months: months,
      document_sha256: hash,
      notes: [row.note, row.utility].filter(Boolean).join(" · "),
    });
    parties.push({ lease_id: leaseId, contact_id: tenantId });
    signatures.push({
      lease_id: leaseId,
      signer_role: "tenant",
      contact_id: tenantId,
      member_id: null,
      signing_order: 1,
      signed_name: row.tenantName,
      document_sha256: hash,
    });
    if (ctx.memberId) {
      signatures.push({
        lease_id: leaseId,
        signer_role: "manager",
        contact_id: null,
        member_id: ctx.memberId,
        signing_order: 2,
        signed_name: "manager",
        document_sha256: hash,
      });
    }
    remember(ctx, "leases", leaseId);
    ctx.result.leases.push(leaseId);
  }

  await writeRows(
    ctx.client,
    `INSERT INTO properties (
       id, org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode
     )
     SELECT r.id, $2, r.name, r.address, r.address_display, 'TW', $3::uuid, $4, $5, r.rental_mode::rental_mode
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, name text, address jsonb, address_display text, rental_mode text)`,
    properties,
    [ctx.orgId, ctx.jurisdictionId, ctx.currency, ctx.timezone],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO contacts (id, org_id, user_id, is_owner, is_tenant, display_name, email, phone_e164, locale, notes)
     SELECT r.id, $2, NULL, r.is_owner, r.is_tenant, r.display_name, r.email, r.phone_e164, 'zh-TW', r.notes
       FROM jsonb_to_recordset($1::jsonb) AS r(
         id uuid, is_owner boolean, is_tenant boolean, display_name text, email text, phone_e164 text, notes text
       )`,
    contacts,
    [ctx.orgId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO property_owners (id, org_id, property_id, owner_contact_id, is_primary)
     SELECT r.id, $2, r.property_id, r.owner_contact_id, true
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, property_id uuid, owner_contact_id uuid)`,
    ownerLinks,
    [ctx.orgId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO units (id, org_id, property_id, label, floor, rental_mode, area_value, area_unit, base_rent_minor)
     SELECT r.id, $2, r.property_id, r.label, r.floor, r.rental_mode::rental_mode, r.area_value, 'ping', r.base_rent_minor
       FROM jsonb_to_recordset($1::jsonb) AS r(
         id uuid, property_id uuid, label text, floor text, rental_mode text, area_value numeric, base_rent_minor bigint
       )`,
    units,
    [ctx.orgId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO rooms (id, org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor)
     SELECT r.id, $2, r.unit_id, r.label, r.room_type::room_type, r.area_value, 'ping', r.base_rent_minor
       FROM jsonb_to_recordset($1::jsonb) AS r(
         id uuid, unit_id uuid, label text, room_type text, area_value numeric, base_rent_minor bigint
       )`,
    rooms,
    [ctx.orgId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO leases (
       id, org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
       start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
       deposit_amount_minor, deposit_months, document_sha256, signed_at, notes, created_by
     )
     SELECT r.id, $2, r.property_id, r.unit_id, r.target_unit_id, r.target_room_id, 'active', 'fully_signed',
            r.start_date, r.end_date, $3, r.rent_amount_minor, r.due_day, false,
            r.deposit_amount_minor, r.deposit_months, r.document_sha256, now(), r.notes, $4
       FROM jsonb_to_recordset($1::jsonb) AS r(
         id uuid, property_id uuid, unit_id uuid, target_unit_id uuid, target_room_id uuid,
         start_date date, end_date date, rent_amount_minor bigint, due_day int,
         deposit_amount_minor bigint, deposit_months numeric, document_sha256 text, notes text
       )`,
    leases,
    [ctx.orgId, ctx.currency, ctx.actorUserId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO lease_parties (org_id, lease_id, contact_id, role)
     SELECT $2, r.lease_id, r.contact_id, 'primary'
       FROM jsonb_to_recordset($1::jsonb) AS r(lease_id uuid, contact_id uuid)`,
    parties,
    [ctx.orgId],
  );
  await writeRows(
    ctx.client,
    `INSERT INTO lease_signatures (
       org_id, lease_id, signer_role, contact_id, member_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at
     )
     SELECT $2, r.lease_id, r.signer_role::signer_role, r.contact_id, r.member_id, 'signed', r.signing_order,
            r.signed_name, r.document_sha256, 'lease.consent', now()
       FROM jsonb_to_recordset($1::jsonb) AS r(
         lease_id uuid, signer_role text, contact_id uuid, member_id uuid, signing_order int, signed_name text, document_sha256 text
       )`,
    signatures,
    [ctx.orgId],
  );
}

export async function seedFirmSetup(ctx: SeedContext) {
  const feeId = randomUUID();
  await ctx.client.query(
    `INSERT INTO fee_rules (id, org_id, name, purpose, kind, basis, currency, percent_bp)
     VALUES ($1,$2,$3,'management_fee','percent','collected_rent',$4,800)`,
    [feeId, ctx.orgId, withSampleName("管理費 8%"), ctx.currency],
  );
  remember(ctx, "fee_rules", feeId);
  ctx.result.fees.push(feeId);

  if (ctx.result.owners[0]) {
    const agreementId = randomUUID();
    await ctx.client.query(
      `INSERT INTO management_agreements (id, org_id, owner_contact_id, fee_rule_id, effective_from)
       VALUES ($1,$2,$3,$4, current_date)`,
      [agreementId, ctx.orgId, ctx.result.owners[0], feeId],
    );
    remember(ctx, "management_agreements", agreementId);
  }

  const bankId = randomUUID();
  await ctx.client.query(
    `INSERT INTO bank_accounts (id, org_id, nickname, bank_name, bank_code, account_last5, currency, show_to_tenants)
     VALUES ($1,$2,$3,'臺灣銀行','004','13579',$4,true)`,
    [bankId, ctx.orgId, withSampleName("範例帳戶"), ctx.currency],
  );
  remember(ctx, "bank_accounts", bankId);
  ctx.result.banks.push(bankId);

  const inviteId = randomUUID();
  await ctx.client.query(
    `INSERT INTO invitations (id, org_id, kind, role, email, code_hash, status, expires_at, invited_by)
     VALUES ($1,$2,'team_member','manager',$3,$4,'pending', now() + interval '14 days', $5)`,
    [inviteId, ctx.orgId, "sandbox.staff@example.com", sha256(randomUUID()), ctx.actorUserId],
  );
  remember(ctx, "invitations", inviteId);
  ctx.result.invites.push(inviteId);
}

export const portfolioSeedPlugin: SandboxSeedPlugin = { id: "portfolio", seed: seedPortfolio };
export const firmSetupSeedPlugin: SandboxSeedPlugin = { id: "firm-setup", seed: seedFirmSetup };
export const defaultSandboxPlugins: SandboxSeedPlugin[] = [portfolioSeedPlugin, firmSetupSeedPlugin];

export async function runSandboxSeed(
  client: Client,
  input: { orgId: string; actorUserId: string; rows?: SampleRow[]; plugins?: SandboxSeedPlugin[] },
) {
  const org = await client.query<{ jurisdiction_id: string | null; currency: string; timezone: string }>(
    `SELECT jurisdiction_id::text, default_currency AS currency, timezone FROM organizations WHERE id = $1`,
    [input.orgId],
  );
  const firm = org.rows[0];
  if (!firm) throw new Error("sandbox seed missing organization");
  const member = await client.query<{ id: string }>(
    `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [input.orgId, input.actorUserId],
  );
  const ctx: SeedContext = {
    client,
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    memberId: member.rows[0]?.id ?? null,
    jurisdictionId: firm.jurisdiction_id,
    currency: firm.currency.trim(),
    timezone: firm.timezone,
    rows: input.rows ?? loadSampleRows(),
    result: emptySeedResult(),
    marks: [],
  };
  for (const plugin of input.plugins ?? defaultSandboxPlugins) {
    await plugin.seed(ctx);
  }
  await flushMarks(ctx);
  return ctx.result;
}
