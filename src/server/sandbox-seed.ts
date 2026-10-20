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

async function tableExists(client: Client, name: string) {
  const found = await client.query<{ rel: string | null }>(`SELECT to_regclass($1) AS rel`, [`public.${name}`]);
  return Boolean(found.rows[0]?.rel);
}

async function mark(client: Client, orgId: string, table: string, id: string) {
  await client.query(
    `INSERT INTO sample_marks (org_id, entity_table, entity_id, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [orgId, table, id, SAMPLE_LABEL],
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
  const ready = await tableExists(ctx.client, "properties");
  const unitsReady = await tableExists(ctx.client, "units");
  const roomsReady = await tableExists(ctx.client, "rooms");
  if (!ready || !unitsReady || !roomsReady) return;

  const properties = new Map<string, string>();
  const owners = new Map<string, string>();
  const units = new Map<string, string>();
  const tenants = new Map<string, string>();
  let tenantIndex = 0;

  for (const row of ctx.rows) {
    if (!row.property) continue;
    let propertyId = properties.get(row.property);
    if (!propertyId) {
      propertyId = randomUUID();
      properties.set(row.property, propertyId);
      await ctx.client.query(
        `INSERT INTO properties (
           id, org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode
         ) VALUES ($1,$2,$3,$4::jsonb,$5,'TW',$6,$7,$8,$9::rental_mode)`,
        [
          propertyId,
          ctx.orgId,
          withSampleName(row.property),
          JSON.stringify({ country: "TW", line: row.address }),
          row.address,
          ctx.jurisdictionId,
          ctx.currency,
          ctx.timezone,
          rentalMode(row.rentalMode),
        ],
      );
      await mark(ctx.client, ctx.orgId, "properties", propertyId);
      ctx.result.properties.push(propertyId);

      const ownerKey = row.ownerEmail.toLowerCase();
      let ownerId = owners.get(ownerKey);
      if (!ownerId) {
        ownerId = randomUUID();
        owners.set(ownerKey, ownerId);
        await ctx.client.query(
          `INSERT INTO contacts (id, org_id, is_owner, is_tenant, display_name, email, locale, notes)
           VALUES ($1,$2,true,false,$3,$4,'zh-TW',$5)`,
          [ownerId, ctx.orgId, withSampleName(row.ownerName), row.ownerEmail, SAMPLE_LABEL],
        );
        await mark(ctx.client, ctx.orgId, "contacts", ownerId);
        ctx.result.owners.push(ownerId);
      }
      const ownerLink = await ctx.client.query<{ id: string }>(
        `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
         VALUES ($1,$2,$3,true)
         RETURNING id::text`,
        [ctx.orgId, propertyId, ownerId],
      );
      await mark(ctx.client, ctx.orgId, "property_owners", ownerLink.rows[0].id);
    }

    const mode = rentalMode(row.rentalMode);
    const floor = row.floor || "1";
    const unitKey = `${row.property}:${floor}`;
    let unitId = units.get(unitKey);
    if (!unitId) {
      unitId = randomUUID();
      units.set(unitKey, unitId);
      await ctx.client.query(
        `INSERT INTO units (id, org_id, property_id, label, floor, rental_mode, area_value, area_unit, base_rent_minor)
         VALUES ($1,$2,$3,$4,$5,$6::rental_mode,$7,'ping',$8)`,
        [
          unitId,
          ctx.orgId,
          propertyId,
          withSampleName(floor),
          floor,
          mode,
          mode === "whole_unit" ? areaOf(row.area) : null,
          mode === "whole_unit" ? minor(row.rent) : null,
        ],
      );
      await mark(ctx.client, ctx.orgId, "units", unitId);
      ctx.result.units.push(unitId);
    }

    let roomId: string | null = null;
    if (mode === "by_room" && row.room) {
      roomId = randomUUID();
      await ctx.client.query(
        `INSERT INTO rooms (id, org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor)
         VALUES ($1,$2,$3,$4,$5::room_type,$6,'ping',$7)`,
        [roomId, ctx.orgId, unitId, withSampleName(row.room), roomType(row.roomType), areaOf(row.area), minor(row.rent)],
      );
      await mark(ctx.client, ctx.orgId, "rooms", roomId);
      ctx.result.rooms.push(roomId);
    }

    if (!row.tenantName || !row.start) continue;
    const emailKey = (row.tenantEmail || row.tenantName).toLowerCase();
    let tenantId = tenants.get(emailKey);
    if (!tenantId) {
      tenantIndex += 1;
      tenantId = randomUUID();
      tenants.set(emailKey, tenantId);
      await ctx.client.query(
        `INSERT INTO contacts (id, org_id, user_id, is_owner, is_tenant, display_name, email, phone_e164, locale, notes)
         VALUES ($1,$2,NULL,false,true,$3,$4,$5,'zh-TW',$6)`,
        [
          tenantId,
          ctx.orgId,
          withSampleName(row.tenantName),
          row.tenantEmail || null,
          toE164(row.tenantPhone),
          `${SAMPLE_LABEL} 身分證 ${sampleIdMask(tenantIndex)}`,
        ],
      );
      await mark(ctx.client, ctx.orgId, "contacts", tenantId);
      ctx.result.tenants.push(tenantId);
    }

    const leaseId = randomUUID();
    const rentMinor = minor(row.rent);
    const depositMinor = minor(row.deposit);
    const months = rentMinor > 0 ? Math.round((depositMinor / rentMinor) * 100) / 100 : 0;
    const hash = sha256(leaseId);
    await ctx.client.query(
      `INSERT INTO leases (
         id, org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
         deposit_amount_minor, deposit_months, document_sha256, signed_at, notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'active','fully_signed',$7,$8,$9,$10,$11,false,$12,$13,$14, now(), $15, $16
       )`,
      [
        leaseId,
        ctx.orgId,
        propertyId,
        unitId,
        roomId ? null : unitId,
        roomId,
        row.start,
        row.end || null,
        ctx.currency,
        rentMinor,
        Number(row.dueDay) || 5,
        depositMinor,
        months,
        hash,
        [row.note, row.utility].filter(Boolean).join(" · "),
        ctx.actorUserId,
      ],
    );
    await ctx.client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
      [ctx.orgId, leaseId, tenantId],
    );
    await ctx.client.query(
      `INSERT INTO lease_signatures (
         org_id, lease_id, signer_role, contact_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at
       ) VALUES ($1,$2,'tenant',$3,'signed',1,$4,$5,'lease.consent', now())`,
      [ctx.orgId, leaseId, tenantId, row.tenantName, hash],
    );
    if (ctx.memberId) {
      await ctx.client.query(
        `INSERT INTO lease_signatures (
           org_id, lease_id, signer_role, member_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at
         ) VALUES ($1,$2,'manager',$3,'signed',2,'manager',$4,'lease.consent', now())`,
        [ctx.orgId, leaseId, ctx.memberId, hash],
      );
    }
    await mark(ctx.client, ctx.orgId, "leases", leaseId);
    ctx.result.leases.push(leaseId);
  }
}

export async function seedFirmSetup(ctx: SeedContext) {
  const feeId = randomUUID();
  await ctx.client.query(
    `INSERT INTO fee_rules (id, org_id, name, purpose, kind, basis, currency, percent_bp)
     VALUES ($1,$2,$3,'management_fee','percent','collected_rent',$4,800)`,
    [feeId, ctx.orgId, withSampleName("管理費 8%"), ctx.currency],
  );
  await mark(ctx.client, ctx.orgId, "fee_rules", feeId);
  ctx.result.fees.push(feeId);

  if (ctx.result.owners[0]) {
    const agreement = await ctx.client.query<{ id: string }>(
      `INSERT INTO management_agreements (org_id, owner_contact_id, fee_rule_id, effective_from)
       VALUES ($1,$2,$3, current_date)
       RETURNING id::text`,
      [ctx.orgId, ctx.result.owners[0], feeId],
    );
    await mark(ctx.client, ctx.orgId, "management_agreements", agreement.rows[0].id);
  }

  const bank = await ctx.client.query<{ id: string }>(
    `INSERT INTO bank_accounts (org_id, nickname, bank_name, bank_code, account_last5, currency, show_to_tenants)
     VALUES ($1,$2,'臺灣銀行','004','13579',$3,true)
     RETURNING id::text`,
    [ctx.orgId, withSampleName("範例帳戶"), ctx.currency],
  );
  await mark(ctx.client, ctx.orgId, "bank_accounts", bank.rows[0].id);
  ctx.result.banks.push(bank.rows[0].id);

  const invite = await ctx.client.query<{ id: string }>(
    `INSERT INTO invitations (org_id, kind, role, email, code_hash, status, expires_at, invited_by)
     VALUES ($1,'team_member','manager',$2,$3,'pending', now() + interval '14 days', $4)
     RETURNING id::text`,
    [ctx.orgId, "sandbox.staff@example.com", sha256(randomUUID()), ctx.actorUserId],
  );
  await mark(ctx.client, ctx.orgId, "invitations", invite.rows[0].id);
  ctx.result.invites.push(invite.rows[0].id);
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
  };
  for (const plugin of input.plugins ?? defaultSandboxPlugins) {
    await plugin.seed(ctx);
  }
  return ctx.result;
}
