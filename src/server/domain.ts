import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, many, one, svc, tx } from "./db";
import { FlowError } from "./errors";
import { deliveryPlan, outboundNote, SANDBOX_NOT_SENT } from "./outbound";
import {
  attributePayment,
  inclusiveDays,
  managementFeeMinor,
  monthBounds,
  round3,
  scoreMatch,
  splitWeighted,
  taipeiToday,
  toMinor,
} from "./money";
import { depositAmountMinor, depositMonthsOnHalfStep, twdRentIsWhole } from "@/lease-confirm";
import { claimIdempotentSubmit, idempotencyLockKey, stableStringify } from "@/idempotency";
import { typedAddressDisplay } from "@/property-address";
import { STATEMENT_EXPENSE_SQL } from "./expenses";
import { syncVacantOwnerExpense } from "./utility-expense";
import { nextInvoiceNumber } from "./invoice-number";
import { depositMinorForFrequency, depositPolicyState, resolveDepositPolicy, type DepositPolicy } from "./deposit-rules";
import { depositCapSaveAllowed, depositReasonOk, depositWarnFlag, isSignedPdf, leaseTermsEditable, normalizeIdempotencyKey, normalizeLineId, normalizePhone, signedPdfName } from "./lease-rules";
import { addressKey } from "./owner-import";
import { assertPerm } from "./perms";
import { leaseIdentityReady } from "./id-docs";
import { authEmailTaken, portalLoginEmail } from "./portal-login";
import { hashInviteToken, newInviteToken, PORTAL_INVITE_DAYS, savePortalInviteSecret } from "./portal-invite";
import { assertTicketStatus } from "./repair-rules";
import { assertTeamInvitesAllowed } from "./team-invites";
import { assertStaff, type OrgRole, type Session } from "./types";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanPhone(phone: string, where?: { field: string; step: number }) {
  if (!phone.trim()) return null;
  const value = normalizePhone(phone);
  if (!value) throw new FlowError("errors.phone", where);
  return value;
}

function cleanEmail(email: string, where?: { field: string; step: number }) {
  const value = email.trim().toLowerCase();
  if (!value) return null;
  if (!value.includes("@")) throw new FlowError("errors.email", where);
  return value;
}

function assertLeaseMoney(currency: string, rentMajor: number, depositMonths: number) {
  if (!depositMonthsOnHalfStep(depositMonths)) throw new FlowError("errors.depositStep");
  if (!twdRentIsWhole(currency, rentMajor)) throw new FlowError("errors.amount", { field: "i_base_rent" });
}

/** Insert the portal user on the caller's transaction so a later failure rolls it back. */
async function insertPortalUser(client: Client, input: { name: string; email: string | null; phone: string | null }) {
  const email = input.email ?? `portal-${randomUUID()}@demo.condola.local`;
  await client.query(`SET LOCAL ROLE service_role`);
  try {
    const user = await one<{ id: string }>(
      client,
      `SELECT app.provision_portal_user($1, $2, $3) AS id`,
      [email, input.name, input.phone],
    );
    return user.id;
  } finally {
    await client.query(`SET LOCAL ROLE authenticated`);
  }
}

export async function markTryout(orgId: string, key: "property" | "lease" | "statement" | "repair") {
  try {
    await svc(null, async (client) => {
      await client.query(
        `UPDATE organizations
            SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb), '{tryout}',
              (CASE WHEN jsonb_typeof(settings->'tryout') = 'object'
                    THEN settings->'tryout' ELSE '{}'::jsonb END)
                || jsonb_build_object($2::text, true), true)
          WHERE id = $1`,
        [orgId, key],
      );
    });
  } catch (error) {
    console.error("tryout flag", error);
  }
}

export type PropertyInput = {
  name: string;
  city: string;
  district: string;
  street: string;
  currency: "TWD" | "USD";
  ownerMode: "new" | string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  canViewTenantPhone: boolean;
  unitLabel: string;
  floor: string;
  doorSupplement?: string;
  rentalMode: "whole_unit" | "by_room";
  rooms: { label: string; roomType: string; baseRentMajor: number }[];
  extraUnits?: { label: string; floor: string; door: string; rooms: { label: string; roomType: string; baseRentMajor: number }[] }[];
  electric?: {
    split: "even" | "sub" | "owner" | "reading" | "days";
    rateMajor: number | null;
    openings: (number | null)[];
  } | null;
  submitToken?: string;
};

const PROPERTY_ROOM_TYPES = new Set(["whole_home", "studio", "suite", "shared_bath"]);

const ROOM_TYPE_LABELS: Record<string, string> = {
  套房: "suite",
  雅房: "shared_bath",
  獨立套房: "studio",
};

function storedRoomType(raw: string) {
  const value = raw.trim();
  if (PROPERTY_ROOM_TYPES.has(value)) return value;
  return ROOM_TYPE_LABELS[value] ?? value;
}

function withStoredRoomTypes<T extends { roomType: string }>(rooms: T[]) {
  return rooms.map((room) => ({ ...room, roomType: storedRoomType(room.roomType) }));
}

function assertPropertyRoomTypes(rooms: { roomType: string }[]) {
  if (rooms.some((room) => !PROPERTY_ROOM_TYPES.has(room.roomType))) {
    throw new FlowError("errors.required", { field: "i_room_type", step: 3 });
  }
}

function uniqueUnitLabel(label: string, floor: string, door: string, used: Set<string>) {
  const base = label.trim() || [floor.trim(), door.trim()].filter(Boolean).join(" ") || "1";
  let next = base;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(next);
  return next;
}

async function insertPropertyUnit(
  client: Client,
  input: {
    orgId: string;
    propertyId: string;
    label: string;
    floor: string | null;
    door: string;
    rentalMode: "whole_unit" | "by_room";
    areaUnit: string;
    baseRentMinor: number | null;
    importAddressKey: string;
    rooms: { label: string; roomType: string; baseRentMajor: number }[];
  },
) {
  const door = input.door.trim();
  const addressKeyValue = input.importAddressKey || null;
  const unit = door
    ? await one<{ id: string }>(
        client,
        `INSERT INTO units (org_id, property_id, label, floor, door_supplement, rental_mode, area_unit, base_rent_minor, import_address_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [input.orgId, input.propertyId, input.label, input.floor, door, input.rentalMode, input.areaUnit, input.baseRentMinor, addressKeyValue],
      )
    : await one<{ id: string }>(
        client,
        `INSERT INTO units (org_id, property_id, label, floor, rental_mode, area_unit, base_rent_minor, import_address_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.orgId, input.propertyId, input.label, input.floor, input.rentalMode, input.areaUnit, input.baseRentMinor, addressKeyValue],
      );
  const roomIds: string[] = [];
  for (const room of input.rooms) {
    const inserted = await one<{ id: string }>(
      client,
      `INSERT INTO rooms (org_id, unit_id, label, room_type, base_rent_minor, area_unit)
       VALUES ($1,$2,$3,$4::room_type,$5,$6) RETURNING id`,
      [input.orgId, unit.id, room.label.trim(), room.roomType, toMinor(room.baseRentMajor || 0), input.areaUnit],
    );
    roomIds.push(inserted.id);
  }
  return { unitId: unit.id, roomIds };
}

async function insertPropertyElectric(
  client: Client,
  session: Session,
  propertyId: string,
  unitId: string,
  roomIds: string[],
  electric: NonNullable<PropertyInput["electric"]>,
) {
  const rateMinor = electric.rateMajor == null ? null : toMinor(electric.rateMajor);
  const ownerPays = electric.split === "owner";
  const payer = ownerPays ? "owner" : "tenant";
  const choice =
    electric.split === "even"
      ? { meterSplit: "even", method: "even" }
      : electric.split === "sub"
        ? { meterSplit: "sub_meter", method: "submeter" }
        : electric.split === "reading"
          ? { meterSplit: "none", method: "by_reading" }
          : electric.split === "days"
            ? { meterSplit: "days_occupied", method: "by_reading" }
            : { meterSplit: "none", method: "shared" };
  const rateSource = ownerPays && rateMinor == null ? "fixed_rate" : rateMinor == null ? "bill_average" : "fixed_rate";
  const meter = await one<{ id: string }>(
    client,
    `INSERT INTO meters (
       org_id, property_id, unit_id, utility, usage_unit, label, payer, split_method, rate_source, rate_minor_per_unit
     ) VALUES ($1,$2,$3,'electricity','kWh','main',$4,$5::split_method,$6::rate_source,$7) RETURNING id`,
    [session.orgId, propertyId, unitId, payer, choice.meterSplit, rateSource, rateMinor],
  );
  const appliedRate = ownerPays ? null : electric.rateMajor;
  await client.query(
    `UPDATE units SET electricity_method = $2, rate_per_kwh = $3, updated_at = now() WHERE id = $1`,
    [unitId, choice.method, appliedRate],
  );
  await client.query(
    `UPDATE rooms SET electricity_method = $2, rate_per_kwh = $3, updated_at = now() WHERE unit_id = $1 AND archived_at IS NULL`,
    [unitId, choice.method, appliedRate],
  );
  if (electric.split !== "sub") return;
  for (let index = 0; index < roomIds.length; index += 1) {
    const opening = electric.openings[index];
    if (opening == null || !Number.isFinite(opening)) continue;
    const sub = await one<{ id: string }>(
      client,
      `INSERT INTO meters (
         org_id, property_id, unit_id, room_id, parent_meter_id, utility, usage_unit, label,
         payer, split_method, rate_source, rate_minor_per_unit
       ) VALUES ($1,$2,$3,$4,$5,'electricity','kWh',$6,'tenant','none'::split_method,$7::rate_source,$8) RETURNING id`,
      [session.orgId, propertyId, unitId, roomIds[index], meter.id, `sub-${index + 1}`, rateSource, rateMinor],
    );
    await client.query(
      `INSERT INTO meter_readings (org_id, meter_id, read_on, value, read_by) VALUES ($1,$2,$3,$4,$5)`,
      [session.orgId, sub.id, taipeiToday(), opening, session.userId],
    );
  }
}

function propertySubmitPayload(input: PropertyInput) {
  return {
    name: input.name.trim(),
    city: input.city.trim(),
    district: input.district.trim(),
    street: input.street.trim(),
    currency: input.currency,
    ownerMode: input.ownerMode,
    ownerName: input.ownerName.trim(),
    ownerPhone: input.ownerPhone.trim(),
    ownerEmail: input.ownerEmail.trim(),
    canViewTenantPhone: input.canViewTenantPhone,
    unitLabel: input.unitLabel.trim(),
    floor: input.floor.trim(),
    door: (input.doorSupplement ?? "").trim(),
    rentalMode: input.rentalMode,
    rooms: input.rooms.map((room) => ({
      label: room.label.trim(),
      roomType: room.roomType,
      baseRentMajor: room.baseRentMajor,
    })),
    extraUnits: (input.extraUnits ?? []).map((unit) => ({
      label: unit.label.trim(),
      floor: unit.floor.trim(),
      door: unit.door.trim(),
      rooms: unit.rooms.map((room) => ({
        label: room.label.trim(),
        roomType: room.roomType,
        baseRentMajor: room.baseRentMajor,
      })),
    })),
    electric: input.electric ?? null,
  };
}

export async function createProperty(session: Session, input: PropertyInput) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.name.trim()) throw new FlowError("errors.required", { field: "i_property_name", step: 1 });
  if (!input.city.trim()) throw new FlowError("errors.required", { field: "i_city", step: 1 });
  if (!input.street.trim()) throw new FlowError("errors.required", { field: "i_address", step: 1 });
  if (!input.unitLabel.trim() && !input.floor.trim()) throw new FlowError("errors.required", { field: "i_floor", step: 3 });
  const wholeUnit = input.rentalMode === "whole_unit";
  const posted = wholeUnit ? input.rooms.slice(0, 1) : input.rooms;
  const rooms = withStoredRoomTypes(posted.filter((room) => room.label.trim() || room.baseRentMajor > 0));
  if (rooms.some((room) => !room.label.trim())) throw new FlowError("errors.required", { field: "s_8569bc8", step: 3 });
  if (wholeUnit && rooms.length !== 1) throw new FlowError("errors.required", { field: "s_8569bc8", step: 3 });
  if (input.rentalMode === "by_room" && rooms.length < 1) throw new FlowError("errors.required", { field: "s_8569bc8", step: 3 });
  if (input.rentalMode === "by_room") assertPropertyRoomTypes(rooms);
  if (rooms.some((room) => room.roomType === "whole_home") && rooms.length !== 1) {
    throw new FlowError("errors.required", { field: "s_8569bc8", step: 3 });
  }
  for (const extra of input.rentalMode === "by_room" ? (input.extraUnits ?? []) : []) {
    const extraRooms = withStoredRoomTypes(extra.rooms.filter((room) => room.label.trim() || room.baseRentMajor > 0));
    if (!extra.floor.trim() && !extra.label.trim() && extraRooms.length === 0) continue;
    assertPropertyRoomTypes(extraRooms);
  }
  if (input.electric?.rateMajor != null && (!Number.isFinite(input.electric.rateMajor) || input.electric.rateMajor < 0)) {
    throw new FlowError("errors.amount", { field: "i_rate", step: 4 });
  }

  const ownerPhone = cleanPhone(input.ownerPhone, { field: "i_phone_label", step: 1 });
  const ownerEmail = cleanEmail(input.ownerEmail, { field: "i_email_label", step: 1 });
  if (input.ownerMode === "new" && !input.ownerName.trim()) throw new FlowError("errors.required", { field: "s_0c5acea", step: 1 });

  const created = await tx(session.userId, async (client) => {
    const submitToken = (input.submitToken || "").trim().slice(0, 80);
    const submitHash = submitToken ? sha256(stableStringify(propertySubmitPayload(input))) : "";
    if (submitToken) {
      // One indexed lookup, not a scan under RLS. Permissive property policies
      // call tenant/owner functions per row, and that scan is what stretched
      // a create from about two seconds into the tens. service_role skips
      // those policies; org_id keeps the read inside this firm.
      await client.query(`SET LOCAL ROLE service_role`);
      let prior: { id: string } | null = null;
      try {
        prior = await maybe<{ id: string }>(
          client,
          `WITH locked AS (
             SELECT pg_advisory_xact_lock(hashtext($1))
           )
           SELECT id::text
             FROM properties, locked
            WHERE org_id = $2
              AND address->>'submitUser' = $3
              AND address->>'submitToken' = $4
              AND address->>'submitHash' = $5
            ORDER BY created_at DESC
            LIMIT 1`,
          [
            idempotencyLockKey("property", session.orgId, session.userId, submitToken),
            session.orgId,
            session.userId,
            submitToken,
            submitHash,
          ],
        );
      } finally {
        await client.query(`SET LOCAL ROLE authenticated`);
      }
      const claim = claimIdempotentSubmit(
        prior ? [{ id: prior.id, orgId: session.orgId, userId: session.userId, token: submitToken, hash: submitHash }] : [],
        { orgId: session.orgId, userId: session.userId, token: submitToken, hash: submitHash },
      );
      if (claim.action === "replay") {
        return { propertyId: claim.id, ownerContactId: "", roomIds: [] as string[], inviteCode: null as string | null };
      }
    } else {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`property:${session.userId}:${input.name.trim()}`]);
      const recent = await maybe<{ id: string }>(
        client,
        `SELECT id FROM properties
          WHERE org_id = $1 AND name = $2 AND created_at > now() - interval '20 seconds'
          ORDER BY created_at DESC LIMIT 1`,
        [session.orgId, input.name.trim()],
      );
      if (recent) return { propertyId: recent.id, ownerContactId: "", roomIds: [] as string[], inviteCode: null as string | null };
    }
    const country = input.currency === "USD" ? "US" : "TW";
    const jurisdiction = await one<{ id: string }>(
      client,
      `SELECT id FROM jurisdictions WHERE code = $1`,
      [input.currency === "USD" ? "US-CA" : "TW"],
    );
    const address = {
      country,
      city: input.city.trim(),
      district: input.district.trim(),
      street: input.street.trim(),
      ...(submitToken ? { submitToken, submitUser: session.userId, submitHash } : {}),
    };
    const display =
      country === "TW"
        ? typedAddressDisplay(address.city, address.district, address.street)
        : [address.street, address.city, address.district].filter(Boolean).join(", ");
    const property = await one<{ id: string }>(
      client,
      `INSERT INTO properties (org_id, name, address, address_display, address_key, country_code, jurisdiction_id, currency, timezone, default_rental_mode)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        session.orgId,
        input.name.trim(),
        JSON.stringify(address),
        display,
        addressKey(display),
        country,
        jurisdiction.id,
        input.currency,
        country === "TW" ? "Asia/Taipei" : "America/Los_Angeles",
        input.rentalMode,
      ],
    );

    let ownerContactId = input.ownerMode === "new" ? "" : input.ownerMode;
    if (input.ownerMode === "new") {
      const contact = await one<{ id: string }>(
        client,
        `INSERT INTO contacts (org_id, is_owner, display_name, email, phone_e164, locale, preferred_channel)
         VALUES ($1,true,$2,$3,$4,$5,'email') RETURNING id`,
        [session.orgId, input.ownerName.trim(), ownerEmail, ownerPhone, session.locale],
      );
      ownerContactId = contact.id;
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`portal-invite:${ownerContactId}`]);
      const token = newInviteToken();
      const invite = await one<{ id: string }>(
        client,
        `INSERT INTO invitations (org_id, kind, contact_id, email, phone_e164, code_hash, expires_at, invited_by)
         VALUES ($1,'owner',$2,$3,$4,$5, now() + make_interval(days => $6), $7)
         RETURNING id::text`,
        [session.orgId, ownerContactId, ownerEmail, ownerPhone, hashInviteToken(token), PORTAL_INVITE_DAYS, session.userId],
      );
      await savePortalInviteSecret(client, invite.id, token);
    }
    if (!ownerContactId) throw new FlowError("errors.required");

    await client.query(
      `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary, can_view_tenant_phone)
       VALUES ($1,$2,$3,true,$4)`,
      [session.orgId, property.id, ownerContactId, input.canViewTenantPhone],
    );

    const rule = await maybe<{ id: string }>(
      client,
      `SELECT id FROM fee_rules
        WHERE org_id = $1 AND purpose = 'management_fee' AND currency = $2 AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [session.orgId, input.currency],
    );
    if (rule) {
      const agreement = await maybe<{ id: string }>(
        client,
        `SELECT id FROM management_agreements
          WHERE org_id = $1 AND owner_contact_id = $2
            AND (property_id IS NULL OR property_id = $3)
            AND (effective_to IS NULL OR effective_to > current_date)
          LIMIT 1`,
        [session.orgId, ownerContactId, property.id],
      );
      if (!agreement) {
        await client.query(
          `INSERT INTO management_agreements (org_id, owner_contact_id, property_id, fee_rule_id, effective_from)
           VALUES ($1,$2,$3,$4,current_date)`,
          [session.orgId, ownerContactId, property.id, rule.id],
        );
      }
    }

    const areaUnit = country === "TW" ? "ping" : "sqft";
    const usedLabels = new Set<string>();
    const importAddressKey = addressKey(display);
    const roomIds: string[] = [];
    const first = await insertPropertyUnit(client, {
      orgId: session.orgId,
      propertyId: property.id,
      label: uniqueUnitLabel(wholeUnit ? rooms[0].label : input.unitLabel, input.floor, input.doorSupplement ?? "", usedLabels),
      floor: input.floor.trim() || null,
      door: input.doorSupplement ?? "",
      rentalMode: input.rentalMode,
      areaUnit,
      baseRentMinor: wholeUnit ? toMinor(rooms[0]?.baseRentMajor || 0) : null,
      importAddressKey,
      rooms: wholeUnit ? [] : rooms,
    });
    roomIds.push(...first.roomIds);
    for (const extra of wholeUnit ? [] : (input.extraUnits ?? [])) {
      const extraRooms = withStoredRoomTypes(extra.rooms.filter((room) => room.label.trim() || room.baseRentMajor > 0));
      if (!extra.floor.trim() && !extra.label.trim() && extraRooms.length === 0) continue;
      if (!extra.floor.trim() && !extra.label.trim()) throw new FlowError("errors.required", { field: "i_floor", step: 3 });
      if (extraRooms.some((room) => room.roomType === "whole_home") && extraRooms.length !== 1) {
        throw new FlowError("errors.required", { field: "s_8569bc8", step: 3 });
      }
      const inserted = await insertPropertyUnit(client, {
        orgId: session.orgId,
        propertyId: property.id,
        label: uniqueUnitLabel(extra.label, extra.floor, extra.door, usedLabels),
        floor: extra.floor.trim() || null,
        door: extra.door,
        rentalMode: "by_room",
        areaUnit,
        baseRentMinor: null,
        importAddressKey,
        rooms: extraRooms,
      });
      roomIds.push(...inserted.roomIds);
    }
    if (input.electric?.split) {
      const openings =
        input.rentalMode === "whole_unit"
          ? []
          : input.rooms.flatMap((room, index) =>
              room.label.trim() || room.baseRentMajor > 0 ? [input.electric?.openings[index] ?? null] : [],
            );
      await insertPropertyElectric(client, session, property.id, first.unitId, first.roomIds, {
        ...input.electric,
        openings,
      });
    }
    return { propertyId: property.id, ownerContactId, roomIds, inviteCode: null as string | null };
  }, { orgId: session.orgId, environment: session.environment });

  if (input.rentalMode === "by_room" && created.roomIds.length >= 3) await markTryout(session.orgId, "property");
  return created;
}

export async function setMeterSerial(session: Session, propertyId: string, serial: string) {
  assertStaff(session, ["admin", "manager"]);
  const value = serial.trim();
  if (!value) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const unit = await maybe<{ id: string }>(
      client,
      `SELECT id FROM units WHERE property_id = $1 AND org_id = $2 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [propertyId, session.orgId],
    );
    if (!unit) throw new FlowError("errors.notFound");
    const meter = await maybe<{ id: string }>(
      client,
      `SELECT id FROM meters
        WHERE property_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [propertyId],
    );
    if (meter) {
      await client.query(`UPDATE meters SET serial_number = $2 WHERE id = $1 AND org_id = $3`, [meter.id, value, session.orgId]);
      return;
    }
    await client.query(
      `INSERT INTO meters (
         org_id, property_id, unit_id, utility, usage_unit, label, serial_number, payer, split_method, rate_source
       ) VALUES ($1,$2,$3,'electricity','kWh','main',$4,'tenant','even','bill_average')
       ON CONFLICT (unit_id) WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
       DO UPDATE SET serial_number = EXCLUDED.serial_number`,
      [session.orgId, propertyId, unit.id, value],
    );
  });
}

export async function setOwnerPhoneVisibility(session: Session, propertyOwnerId: string, canView: boolean) {
  assertPerm(session, "settings.edit");
  await tx(session.userId, async (client) => {
    const updated = await client.query(
      `UPDATE property_owners SET can_view_tenant_phone = $2 WHERE id = $1 AND org_id = $3`,
      [propertyOwnerId, canView, session.orgId],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
  });
}

export type LeaseInput = {
  roomId: string;
  tenantName: string;
  tenantPhone: string;
  tenantEmail: string;
  /** Empty or "new" creates a contact. A contact id reuses that 租客 in this firm. */
  tenantContactId?: string;
  lineUserId: string;
  startDate: string;
  endDate: string;
  rentMajor: number | string | null;
  depositMonths: number | string | null;
  depositReason: string;
  dueDay: number | null;
  splitMethod: "even" | "days_occupied" | "sub_meter";
  periodStart: string;
  periodEnd: string;
  billTotalMajor: number | null;
  usageKwh: number | null;
  rateMajor: number | null;
  rateSource: "fixed_rate" | "bill_average";
  overrideReason: string;
  subUsages: { roomId: string; kwh: number }[];
  /** Client UUID for this create attempt. A retry with the same key returns the first lease. */
  idempotencyKey?: string | null;
};

function finiteNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

/** JSON bodies may send "3" rather than 3. Blank stays empty; anything else must be numeric. */
function coerceNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return Number(trimmed);
  }
  return Number.NaN;
}

/** Never write an empty app.change_reason. A blank setting would be stored as an empty audit reason. */
async function noteChange(client: Client, reason: string | null) {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return;
  await client.query(`SELECT set_config('app.change_reason', $1, true)`, [trimmed]);
}

function leaseDepositOverride(
  policy: DepositPolicy,
  depositMonths: number,
  reason: string,
  userId: string,
  rentMinor: number,
  existing?: { reason: string | null; by: string | null; at: Date | string | null; months: string | number | null; rent_minor: string | number },
) {
  const trimmed = reason.trim();
  const state = depositPolicyState(policy, depositMonths);
  if (state === "block" || (state === "reason" && !trimmed)) throw new FlowError("errors.depositCap");
  if (state === "reason") {
    if (existing?.reason === trimmed && existing.by && existing.at && Number(existing.months) === depositMonths && Number(existing.rent_minor) === rentMinor) {
      return { reason: existing.reason, by: existing.by, at: existing.at, kept: true };
    }
    return { reason: trimmed, by: userId, at: new Date() as Date | string | null, kept: false };
  }
  if (existing?.reason?.trim() && existing.by && existing.at) {
    return { reason: existing.reason, by: existing.by, at: existing.at, kept: true };
  }
  return { reason: null, by: null, at: null as Date | string | null, kept: false };
}

async function savedDepositWarn(client: Client, leaseId: string, depositMonths: number, reasonOk: boolean, policy: DepositPolicy) {
  const depositCheck = await maybe<{ outcome: string }>(
    client,
    `SELECT c.outcome::text
       FROM rule_check_results c
       JOIN jurisdiction_rules r ON r.id = c.rule_id
      WHERE c.entity_table = 'leases'
        AND c.entity_id = $1
        AND r.rule_key = 'deposit.max_months'
      ORDER BY c.checked_at DESC
      LIMIT 1`,
    [leaseId],
  );
  const outcome = depositCheck?.outcome ?? null;
  if (policy.regionalEnabled) return outcome === "warn";
  if (!depositCapSaveAllowed(depositMonths, outcome, reasonOk)) throw new FlowError("errors.depositCap");
  return depositWarnFlag(depositMonths, outcome);
}

/** Blank electricity is optional. A partial bill still needs a positive usage; a missing rate uses the bill average. */
function readElectricity(input: LeaseInput) {
  const bill = input.billTotalMajor;
  const usage = input.usageKwh;
  const rate = input.rateMajor;
  const billOk = finiteNumber(bill);
  const usageOk = finiteNumber(usage);
  const rateOk = finiteNumber(rate);
  if (!billOk && !usageOk && !rateOk) return null;
  if (billOk && usageOk && rateOk && bill === 0 && usage === 0 && rate === 0) return null;
  if ((bill != null && !Number.isFinite(bill)) || (usage != null && !Number.isFinite(usage)) || (rate != null && !Number.isFinite(rate))) {
    const field = bill != null && !Number.isFinite(bill) ? "i_bill_total" : usage != null && !Number.isFinite(usage) ? "i_usage" : "i_rate";
    throw new FlowError("errors.amount", { field });
  }
  if (!billOk || bill < 0) throw new FlowError("errors.amount", { field: "i_bill_total" });
  if (!usageOk || usage <= 0) throw new FlowError("errors.amount", { field: "i_usage" });
  if (rateOk && rate < 0) throw new FlowError("errors.amount", { field: "i_rate" });
  return { billMajor: bill, usageKwh: usage, rateMajor: rateOk ? rate : null };
}

function isIdempotencyConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: string; constraint?: string; message?: string };
  if (row.code !== "23505") return false;
  return row.constraint === "leases_org_idempotency_key_uidx" || (row.message ?? "").includes("leases_org_idempotency_key_uidx");
}

async function leaseForIdempotencyKey(client: Client, orgId: string, key: string) {
  return maybe<{ id: string; tenantUserId: string | null }>(
    client,
    `SELECT l.id::text, c.user_id::text AS "tenantUserId"
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
      WHERE l.org_id = $1 AND l.idempotency_key = $2
      LIMIT 1`,
    [orgId, key],
  );
}

const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function existingTenantId(value: string | undefined) {
  const id = (value ?? "").trim();
  if (!id || id === "new") return "";
  if (!CONTACT_ID.test(id)) throw new FlowError("errors.notFound");
  return id;
}

type TenantContactRow = {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone_e164: string | null;
};

/**
 * Reuse a 租客 already in this firm, or insert one.
 * The lookup is org-scoped in SQL and runs as the signed-in member, so RLS
 * (app.is_member) hides every other firm's contacts. A miss is notFound.
 */
async function linkTenant(
  client: Client,
  session: Session,
  input: {
    tenantContactId: string;
    name: string;
    email: string | null;
    phone: string | null;
    lineId: string | null;
  },
) {
  if (input.tenantContactId) {
    const found = await maybe<TenantContactRow>(
      client,
      `SELECT id::text, user_id::text AS user_id, display_name, email::text AS email, phone_e164
         FROM contacts
        WHERE id = $1 AND org_id = $2 AND is_tenant AND archived_at IS NULL
        FOR UPDATE`,
      [input.tenantContactId, session.orgId],
    );
    if (!found) throw new FlowError("errors.notFound");
    const tenantUserId = found.user_id ?? (await attachPortalUser(client, session, found));
    return { contactId: found.id, tenantUserId };
  }
  if (input.email) {
    const duplicate = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM contacts
        WHERE org_id = $1 AND is_tenant AND archived_at IS NULL AND email = $2
        LIMIT 1`,
      [session.orgId, input.email],
    );
    if (duplicate) throw new FlowError("errors.tenantExists");
  }
  const tenantUserId = input.email
    ? await insertPortalUserUnlessEmailTaken(client, { name: input.name, email: input.email, phone: input.phone })
    : await insertPortalUser(client, { name: input.name, email: null, phone: input.phone });
  const contact = await one<{ id: string }>(
    client,
    `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, line_user_id, locale, preferred_channel)
     VALUES ($1,$2,true,$3,$4,$5,$6,$7,'line') RETURNING id`,
    [session.orgId, tenantUserId, input.name, input.email, input.phone, input.lineId, session.locale],
  );
  return { contactId: contact.id, tenantUserId };
}

/**
 * A 租客 row with no portal login yet keeps that row and gains a new user.
 * Sandbox firms, and any email that already has a login, get a synthetic
 * portal address. This never looks up auth.users by email and never attaches
 * that existing login.
 */
async function attachPortalUser(client: Client, session: Session, contact: TenantContactRow) {
  const loginEmail = portalLoginEmail({
    environment: session.environment,
    contactEmail: contact.email,
    emailTaken: false,
  });
  const tenantUserId = loginEmail
    ? await insertPortalUserUnlessEmailTaken(client, {
        name: contact.display_name,
        email: loginEmail,
        phone: contact.phone_e164,
      })
    : await insertPortalUser(client, {
        name: contact.display_name,
        email: null,
        phone: contact.phone_e164,
      });
  const updated = await maybe<{ id: string }>(
    client,
    `UPDATE contacts SET user_id = $2, updated_at = now()
      WHERE id = $1 AND org_id = $3 AND user_id IS NULL
      RETURNING id::text`,
    [contact.id, tenantUserId, session.orgId],
  );
  if (updated) return tenantUserId;
  const again = await one<{ user_id: string }>(
    client,
    `SELECT user_id::text AS user_id FROM contacts WHERE id = $1 AND org_id = $2 AND user_id IS NOT NULL`,
    [contact.id, session.orgId],
  );
  return again.user_id;
}

/**
 * Try the contact email. On a taken auth email, roll back only that insert and
 * mint a new login. The first statement in the catch must be the savepoint
 * rollback: the transaction is aborted, so a role change cannot run before it.
 */
async function insertPortalUserUnlessEmailTaken(
  client: Client,
  input: { name: string; email: string; phone: string | null },
) {
  await client.query(`SAVEPOINT attach_portal_login`);
  try {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = await one<{ id: string }>(
      client,
      `SELECT app.provision_portal_user($1, $2, $3) AS id`,
      [input.email, input.name, input.phone],
    );
    await client.query(`RELEASE SAVEPOINT attach_portal_login`);
    await client.query(`SET LOCAL ROLE authenticated`);
    return user.id;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT attach_portal_login`);
    if (!authEmailTaken(error)) throw error;
    return insertPortalUser(client, { name: input.name, email: null, phone: input.phone });
  }
}

export async function createLease(session: Session, input: LeaseInput) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.roomId || !input.startDate || !input.endDate) throw new FlowError("errors.required", { field: "s_8569bc8" });
  const tenantContactId = existingTenantId(input.tenantContactId);
  if (!tenantContactId && !input.tenantName.trim()) throw new FlowError("errors.required", { field: "s_0c5acea" });
  const dueDay = input.dueDay;
  if (!finiteNumber(dueDay) || dueDay < 1 || dueDay > 31 || Math.floor(dueDay) !== dueDay) {
    throw new FlowError("errors.required", { field: "s_aa47e23" });
  }
  const rentMajor = coerceNumber(input.rentMajor);
  const depositMonths = coerceNumber(input.depositMonths);
  if (!finiteNumber(rentMajor) || rentMajor < 0) throw new FlowError("errors.amount", { field: "i_base_rent" });
  if (!finiteNumber(depositMonths) || depositMonths < 0) throw new FlowError("errors.amount", { field: "s_8ed103e" });
  if (input.periodEnd <= input.periodStart || input.endDate < input.startDate) throw new FlowError("errors.required");
  const lineId = normalizeLineId(input.lineUserId ?? "");
  if (!lineId.ok) throw new FlowError("errors.lineId");
  const phone = tenantContactId ? null : cleanPhone(input.tenantPhone);
  if (!tenantContactId && !phone) throw new FlowError("errors.required", { field: "s_522cf12" });
  const email = tenantContactId ? null : cleanEmail(input.tenantEmail);
  const electricity = readElectricity(input);
  const billMinor = electricity ? toMinor(electricity.billMajor) : 0;
  const average = electricity ? Math.round((billMinor / electricity.usageKwh) * 1e6) / 1e6 : 0;
  const rateSource = !electricity || electricity.rateMajor == null ? "bill_average" : input.rateSource;
  const rateMinor = !electricity
    ? 0
    : rateSource === "bill_average"
      ? average
      : Math.round(electricity.rateMajor! * 100 * 1e6) / 1e6;
  if (electricity && (!Number.isFinite(billMinor) || !Number.isFinite(rateMinor))) {
    throw new FlowError("errors.amount", { field: "i_bill_total" });
  }
  const exceeds = Boolean(electricity) && rateSource === "fixed_rate" && rateMinor > average + 1e-9;
  if (exceeds && !input.overrideReason.trim()) throw new FlowError("errors.capReason");
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey.ok) throw new FlowError("errors.leaseFailed");
  let result;
  try {
    result = await tx(session.userId, async (client) => {
    if (idempotencyKey.value) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lease-key:${session.orgId}:${idempotencyKey.value}`]);
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lease:${input.roomId}`]);
    const replay = idempotencyKey.value ? await leaseForIdempotencyKey(client, session.orgId, idempotencyKey.value) : null;
    if (replay?.tenantUserId) {
      return {
        leaseId: replay.id,
        tenantUserId: replay.tenantUserId,
        depositWarn: false,
        exceeds,
        average,
        tenantAmount: 0,
        reused: true,
      };
    }
    const already = idempotencyKey.value
      ? null
      : await maybe<{ id: string; tenantUserId: string }>(
      client,
      `SELECT l.id::text, c.user_id::text AS "tenantUserId"
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE (l.target_room_id = $1 OR l.target_unit_id = $1) AND l.org_id = $2
          AND l.status = 'pending_signature'
          AND l.created_at > now() - interval '2 minutes'
          AND daterange(l.start_date, coalesce(l.end_date, l.start_date), '[]') && daterange($3::date, $4::date, '[]')
        ORDER BY l.created_at DESC
        LIMIT 1`,
      [input.roomId, session.orgId, input.startDate, input.endDate],
    );
    if (already?.tenantUserId) {
      return {
        leaseId: already.id,
        tenantUserId: already.tenantUserId,
        depositWarn: false,
        exceeds,
        average,
        tenantAmount: 0,
        reused: true,
        utilityKept: false,
        billKept: false,
      };
    }
    const space = await one<{
      id: string;
      unit_id: string;
      property_id: string;
      currency: string;
      kind: string;
      label: string;
    }>(
      client,
      `SELECT id, unit_id, property_id, currency, kind, label
         FROM (
           SELECT r.id, r.unit_id, u.property_id, p.currency, 'room'::text AS kind, r.label, 0 AS rank
             FROM rooms r
             JOIN units u ON u.id = r.unit_id
             JOIN properties p ON p.id = u.property_id
            WHERE r.id = $1 AND r.org_id = $2 AND r.archived_at IS NULL
              AND u.rental_mode = 'by_room'
           UNION ALL
           SELECT u.id, u.id, u.property_id, p.currency, 'whole_unit'::text, u.label, 1
             FROM units u
             JOIN properties p ON p.id = u.property_id
            WHERE u.id = $1 AND u.org_id = $2 AND u.archived_at IS NULL
              AND u.rental_mode = 'whole_unit'
         ) spaces
        ORDER BY rank
        LIMIT 1`,
      [input.roomId, session.orgId],
    );
    assertLeaseMoney(space.currency, rentMajor, depositMonths);
    const depositPolicy = await resolveDepositPolicy(client, session.orgId, space.property_id, input.startDate);
    const override = leaseDepositOverride(depositPolicy, depositMonths, input.depositReason ?? "", session.userId, toMinor(rentMajor));
    const clash = await maybe<{ start_date: string; end_date: string }>(
      client,
      `SELECT l.start_date::text AS start_date, coalesce(l.end_date, l.start_date)::text AS end_date
         FROM leases l
        WHERE l.org_id = $1
          AND l.status IN ('pending_signature','active')
          AND daterange(l.start_date, coalesce(l.end_date, l.start_date), '[]') && daterange($2::date, $3::date, '[]')
          AND (
            ($4 = 'room' AND (l.target_room_id = $5::uuid OR l.target_unit_id = $6::uuid))
            OR ($4 = 'whole_unit' AND (l.target_unit_id = $5::uuid OR (l.unit_id = $6::uuid AND l.target_room_id IS NOT NULL)))
          )
        ORDER BY l.start_date, l.id
        LIMIT 1`,
      [session.orgId, input.startDate, input.endDate, space.kind, space.id, space.unit_id],
    );
    if (clash) throw new FlowError("errors.roomLease", { start: clash.start_date, end: clash.end_date });
    const linked = await linkTenant(client, session, {
      tenantContactId,
      name: input.tenantName.trim(),
      email,
      phone,
      lineId: lineId.value,
    });
    const tenantUserId = linked.tenantUserId;
    const contact = { id: linked.contactId };
    const rentMinor = toMinor(rentMajor);
    const depositMinor = depositAmountMinor(space.currency, rentMajor, depositMonths);
    const documentHash = sha256(
      JSON.stringify({
        room: space.id,
        rentMinor,
        depositMinor,
        start: input.startDate,
        end: input.endDate,
      }),
    );
    await noteChange(client, override.reason);
    await client.query("SAVEPOINT lease_idempotency");
    let lease: { id: string };
    try {
      lease = await one<{ id: string }>(
        client,
        `INSERT INTO leases (
           org_id, unit_id, target_unit_id, target_room_id, status, esign_status, start_date, end_date, currency,
           rent_amount_minor, due_day, prorate_first_period, deposit_amount_minor, deposit_months,
           deposit_override_reason, deposit_overridden_by, deposit_overridden_at,
           document_sha256, idempotency_key, created_by
         ) VALUES (
           $1,$2,$3,$4,'pending_signature','sent',$5,$6,$7,$8,$9,false,$10,$11,$12,$13,$14,$15,$16,$17
         ) RETURNING id`,
        [
          session.orgId,
          space.unit_id,
          space.kind === "whole_unit" ? space.id : null,
          space.kind === "room" ? space.id : null,
          input.startDate,
          input.endDate,
          space.currency,
          rentMinor,
          dueDay,
          depositMinor,
          depositMonths,
          override.reason,
          override.by,
          override.at,
          documentHash,
          idempotencyKey.value,
          session.userId,
        ],
      );
      await client.query("RELEASE SAVEPOINT lease_idempotency");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT lease_idempotency");
      if (!isIdempotencyConflict(error) || !idempotencyKey.value) throw error;
      const existing = await leaseForIdempotencyKey(client, session.orgId, idempotencyKey.value);
      if (!existing?.tenantUserId) throw error;
      return {
        leaseId: existing.id,
        tenantUserId: existing.tenantUserId,
        depositWarn: false,
        exceeds,
        average,
        tenantAmount: 0,
        reused: true,
      };
    }
    await client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
      [session.orgId, lease.id, contact.id],
    );
    const member = await one<{ id: string }>(
      client,
      `SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.orgId, session.userId],
    );
    const tenantSig = await one<{ id: string }>(
      client,
      `INSERT INTO lease_signatures (org_id, lease_id, signer_role, contact_id, status, signing_order, consent_text_key)
       VALUES ($1,$2,'tenant',$3,'pending',1,'lease.consent') RETURNING id`,
      [session.orgId, lease.id, contact.id],
    );
    const managerSig = await one<{ id: string }>(
      client,
      `INSERT INTO lease_signatures (org_id, lease_id, signer_role, member_id, status, signing_order, consent_text_key)
       VALUES ($1,$2,'manager',$3,'pending',2,'lease.consent') RETURNING id`,
      [session.orgId, lease.id, member.id],
    );
    await client.query(
      `INSERT INTO lease_signature_events (org_id, signature_id, event, actor_user_id, document_sha256)
       VALUES ($1,$2,'sent',$3,$4), ($1,$5,'sent',$3,$4)`,
      [session.orgId, tenantSig.id, session.userId, documentHash, managerSig.id],
    );

    let tenantAmount = 0;
    let utilityKept = false;
    let billKept = false;
    if (electricity) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      session.orgId,
      `${space.unit_id}|${input.periodStart}|${input.periodEnd}`,
    ]);
    let meter = await maybe<{ id: string }>(
      client,
      `SELECT id FROM meters WHERE unit_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL LIMIT 1`,
      [space.unit_id],
    );
    if (!meter) {
      meter = await one<{ id: string }>(
        client,
        `INSERT INTO meters (
           org_id, property_id, unit_id, utility, usage_unit, label, payer, split_method, rate_source, rate_minor_per_unit, billing_cycle_months
         ) VALUES ($1,$2,$3,'electricity','kWh','main','tenant',$4::split_method,$5::rate_source,$6,2)
         ON CONFLICT (unit_id) WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
         DO UPDATE SET label = COALESCE(meters.label, EXCLUDED.label)
         RETURNING id`,
        [session.orgId, space.property_id, space.unit_id, input.splitMethod, rateSource, rateMinor],
      );
    }

    const insertedBill = await maybe<{ id: string; avg: string }>(
      client,
      `INSERT INTO utility_bills (
         org_id, meter_id, provider, period_start, period_end, currency, total_amount_minor, total_usage, entered_by
       ) VALUES ($1,$2,'Taipower',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (meter_id, period_start, period_end) DO NOTHING
       RETURNING id, avg_price_minor_per_unit::text AS avg`,
      [session.orgId, meter.id, input.periodStart, input.periodEnd, space.currency, billMinor, electricity.usageKwh, session.userId],
    );
    let bill: { id: string; avg: string };
    if (insertedBill) {
      bill = insertedBill;
    } else {
      const existingBill = await one<{ id: string; avg: string; amount: string; usage: string }>(
        client,
        `SELECT id, avg_price_minor_per_unit::text AS avg,
                total_amount_minor::text AS amount, total_usage::text AS usage
           FROM utility_bills
          WHERE meter_id = $1 AND period_start = $2 AND period_end = $3`,
        [meter.id, input.periodStart, input.periodEnd],
      );
      bill = existingBill;
      billKept = Number(existingBill.amount) !== billMinor || Math.abs(Number(existingBill.usage) - electricity.usageKwh) > 0.001;
    }

    const unitRooms = await many<{ id: string; label: string }>(
      client,
      `SELECT r.id, r.label FROM rooms r
         JOIN units u ON u.id = r.unit_id
        WHERE r.unit_id = $1 AND r.archived_at IS NULL AND u.rental_mode = 'by_room'
        ORDER BY r.label`,
      [space.unit_id],
    );
    const others = await many<{ id: string; target_room_id: string; start_date: string; end_date: string }>(
      client,
      `SELECT id::text, target_room_id::text, start_date::text, end_date::text
         FROM leases
        WHERE unit_id = $1 AND id <> $2 AND status = 'active'
          AND daterange(start_date, coalesce(end_date, start_date), '[]') && daterange($3::date, $4::date, '[]')`,
      [space.unit_id, lease.id, input.periodStart, input.periodEnd],
    );

    const usageByRoom = new Map(input.subUsages.map((row) => [row.roomId, row.kwh]));
    const subTotal = unitRooms.reduce((sum, item) => sum + (usageByRoom.get(item.id) ?? 0), 0);
    if (input.splitMethod === "sub_meter" && subTotal - electricity.usageKwh > 0.001) throw new FlowError("errors.meter");
    const common = input.splitMethod === "sub_meter" ? round3(Math.max(0, electricity.usageKwh - subTotal)) : 0;
    const parts = unitRooms.map((item) => {
      // This lease is still pending_signature, so its room is vacant until both parties sign.
      const linked = others.find((row) => row.target_room_id === item.id);
      const days = linked
        ? inclusiveDays(linked.start_date, linked.end_date, input.periodStart, input.periodEnd)
        : 0;
      const sub = usageByRoom.get(item.id) ?? 0;
      const weight =
        input.splitMethod === "days_occupied"
          ? days
          : input.splitMethod === "sub_meter"
            ? sub + common / unitRooms.length
            : 1;
      return { key: item.id, roomId: item.id as string | null, label: item.label, leaseId: linked?.id ?? null, weight, days, sub };
    });
    if (parts.length === 0) {
      const days = inclusiveDays(input.startDate, input.endDate, input.periodStart, input.periodEnd);
      parts.push({
        key: space.id,
        roomId: null,
        label: space.label,
        leaseId: null,
        weight: input.splitMethod === "days_occupied" ? days : input.splitMethod === "sub_meter" ? electricity.usageKwh : 1,
        days,
        sub: input.splitMethod === "sub_meter" ? electricity.usageKwh : 0,
      });
    }
    const totalAmount = Math.round(electricity.usageKwh * rateMinor);
    const shares = splitWeighted(electricity.usageKwh, totalAmount, parts);

    if (exceeds) await noteChange(client, input.overrideReason);
    const openRunSql = `SELECT id, status::text
         FROM utility_allocation_runs
        WHERE meter_id = $1 AND period_start = $2::date AND period_end = $3::date AND status <> 'void'
        ORDER BY computed_at DESC
        LIMIT 1`;
    const existingRun = await maybe<{ id: string; status: string }>(client, `${openRunSql} FOR UPDATE`, [
      meter.id,
      input.periodStart,
      input.periodEnd,
    ]);
    const runInputs = JSON.stringify({ rooms: parts.map((part) => ({ room: part.label, days: part.days, sub: part.sub })) });
    const replaceDraft = async (runId: string) => {
      await client.query(`SELECT id FROM utility_allocation_runs WHERE id = $1 AND status = 'draft' FOR UPDATE`, [runId]);
      await client.query(
        `UPDATE utility_allocation_runs SET
           utility_bill_id = $2, split_method = $3::split_method, rate_source = $4::rate_source, currency = $5,
           total_usage = $6, common_area_usage = $7, rate_minor_per_unit = $8,
           cap_override_reason = $9, cap_overridden_by = $10, total_amount_minor = $11, inputs = $12::jsonb,
           computed_by = $13, computed_at = now(), unit_id = $14
         WHERE id = $1 AND status = 'draft'`,
        [
          runId,
          bill.id,
          input.splitMethod,
          rateSource,
          space.currency,
          electricity.usageKwh,
          common,
          rateMinor,
          exceeds ? input.overrideReason.trim() : null,
          exceeds ? session.userId : null,
          totalAmount,
          runInputs,
          session.userId,
          space.unit_id,
        ],
      );
      await client.query(
        `DELETE FROM utility_allocation_lines WHERE run_id = $1 AND posted_ledger_transaction_id IS NULL`,
        [runId],
      );
    };
    let runId: string | null = null;
    if (existingRun && existingRun.status !== "draft") {
      utilityKept = true;
    } else if (existingRun) {
      runId = existingRun.id;
      await replaceDraft(runId);
    } else {
      const inserted = await maybe<{ id: string }>(
        client,
        `INSERT INTO utility_allocation_runs (
           org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
           total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
           cap_override_reason, cap_overridden_by, total_amount_minor, inputs, status, computed_by, unit_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6::split_method,$7::rate_source,$8,$9,$10,'split_evenly',$11,$12,$13,$14,$15::jsonb,'draft',$16,$17
         )
         ON CONFLICT (meter_id, period_start, period_end) WHERE status <> 'void' DO NOTHING
         RETURNING id`,
        [
          session.orgId,
          meter.id,
          bill.id,
          input.periodStart,
          input.periodEnd,
          input.splitMethod,
          rateSource,
          space.currency,
          electricity.usageKwh,
          common,
          rateMinor,
          exceeds ? input.overrideReason.trim() : null,
          exceeds ? session.userId : null,
          totalAmount,
          runInputs,
          session.userId,
          space.unit_id,
        ],
      );
      if (inserted) {
        runId = inserted.id;
      } else {
        const raced = await maybe<{ id: string; status: string }>(client, `${openRunSql} FOR UPDATE`, [
          meter.id,
          input.periodStart,
          input.periodEnd,
        ]);
        if (!raced || raced.status !== "draft") {
          utilityKept = true;
        } else {
          runId = raced.id;
          await replaceDraft(runId);
        }
      }
    }
    if (runId) {
      const run = { id: runId };
      for (let index = 0; index < shares.length; index += 1) {
        const share = shares[index];
        const part = parts[index];
        await client.query(
          `INSERT INTO utility_allocation_lines (
             org_id, run_id, lease_id, room_id, days_occupied, sub_meter_usage, share_ratio,
             allocated_usage, amount_minor, bearer, explanation
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::utility_payer,$11::jsonb)`,
          [
            session.orgId,
            run.id,
            part.leaseId,
            part.roomId,
            part.days,
            input.splitMethod === "sub_meter" ? part.sub : null,
            share.ratio,
            Math.max(0, share.usage),
            Math.max(0, share.amount),
            part.leaseId ? "tenant" : "owner",
            JSON.stringify({ kwh: share.usage, rate_minor_per_unit: rateMinor, method: input.splitMethod, room: part.label }),
          ],
        );
      }
      const ownerMinor = shares.reduce((sum, share, index) => {
        if (parts[index]?.leaseId) return sum;
        return sum + Math.max(0, share.amount);
      }, 0);
      await syncVacantOwnerExpense(client, session, {
        runId: run.id,
        propertyId: space.property_id,
        unitId: space.unit_id,
        currency: space.currency,
        incurredOn: input.periodEnd,
        amountMinor: ownerMinor,
      });
      tenantAmount = shares.find((share) => parts[shares.indexOf(share)]?.leaseId === lease.id)?.amount ?? 0;
    }
    }

    return {
      leaseId: lease.id,
      tenantUserId,
      depositWarn: await savedDepositWarn(client, lease.id, depositMonths, depositReasonOk(depositMonths, override.reason ?? ""), depositPolicy),
      exceeds,
      average,
      tenantAmount,
      reused: false,
      utilityKept,
      billKept,
    };
  }, { orgId: session.orgId, environment: session.environment });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.generic") throw new FlowError("errors.leaseFailed");
    throw error;
  }

  if (!result.reused) {
    await svc(session.userId, (client) => queueDemoNotice(client, result.leaseId, "lease_to_sign"));
  }
  return result;
}

/**
 * Edit rent and deposit only before anyone signs. document_sha256 is the hash of
 * the space, rent, deposit, and dates that a signature binds to. Active leases
 * and any lease with a signed party stay as signed: there is no amendment document.
 * Over two months of rent still needs a typed reason. Dropping back to two months
 * or less keeps that reason, who, and when.
 */
export async function updateLease(
  session: Session,
  input: {
    leaseId: string;
    rentMajor: number | string | null;
    depositMonths: number | string | null;
    depositReason: string;
    updatedAt: string;
  },
) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.leaseId) throw new FlowError("errors.required");
  const rentMajor = coerceNumber(input.rentMajor);
  const depositMonths = coerceNumber(input.depositMonths);
  if (!finiteNumber(rentMajor) || rentMajor < 0) throw new FlowError("errors.amount", { field: "i_base_rent" });
  if (!finiteNumber(depositMonths) || depositMonths < 0) throw new FlowError("errors.amount", { field: "s_8ed103e" });
  if (!input.updatedAt?.trim()) throw new FlowError("errors.required");
  return tx(
    session.userId,
    async (client) => {
      const existing = await maybe<{
        id: string;
        status: string;
        esign: string;
        signed_at: string | null;
        target_room_id: string | null;
        target_unit_id: string | null;
        start_date: string;
        end_date: string | null;
        currency: string;
        rent_frequency: "monthly" | "quarterly" | "yearly";
        property_id: string;
        months: string | null;
        rent_minor: string;
        reason: string | null;
        by: string | null;
        at: string | null;
        same_version: boolean;
        party_signed: boolean;
      }>(
        client,
        `SELECT l.id::text, l.status::text, l.esign_status::text AS esign, l.signed_at::text,
                l.target_room_id::text, l.target_unit_id::text, l.start_date::text, l.end_date::text, l.currency,
                l.property_id::text, l.deposit_months::text AS months, l.rent_amount_minor::text AS rent_minor, l.rent_frequency::text,
                l.deposit_override_reason AS reason, l.deposit_overridden_by::text AS by, l.deposit_overridden_at::text AS at,
                (l.updated_at = $3::timestamptz) AS same_version,
                EXISTS (
                  SELECT 1 FROM lease_signatures s WHERE s.lease_id = l.id AND s.status = 'signed'
                ) AS party_signed
           FROM leases l
          WHERE l.id = $1 AND l.org_id = $2
          FOR UPDATE`,
        [input.leaseId, session.orgId, input.updatedAt],
      );
      if (!existing) throw new FlowError("errors.notFound");
      if (!leaseTermsEditable({ status: existing.status, esign: existing.esign, signed: Boolean(existing.signed_at) || existing.party_signed })) {
        throw new FlowError("errors.leaseLocked");
      }
      if (!existing.same_version) throw new FlowError("errors.staleLease");
      assertLeaseMoney(existing.currency, rentMajor, depositMonths);
      const depositPolicy = await resolveDepositPolicy(client, session.orgId, existing.property_id, existing.start_date);
      const override = leaseDepositOverride(depositPolicy, depositMonths, input.depositReason ?? "", session.userId, toMinor(rentMajor), existing);
      await noteChange(client, override.reason);
      const rentMinor = toMinor(rentMajor);
      const depositMinor = depositMinorForFrequency(existing.currency, rentMinor, depositMonths, existing.rent_frequency);
      const documentHash = sha256(
        JSON.stringify({
          room: existing.target_room_id ?? existing.target_unit_id,
          rentMinor,
          depositMinor,
          start: existing.start_date,
          end: existing.end_date,
        }),
      );
      const updated = await client.query(
        `UPDATE leases
            SET rent_amount_minor = $2,
                deposit_amount_minor = $3,
                deposit_months = $4,
                deposit_override_reason = $5,
                deposit_overridden_by = $6,
                deposit_overridden_at = $7,
                document_sha256 = $8,
                updated_at = now()
          WHERE id = $1 AND org_id = $9 AND updated_at = $10::timestamptz`,
        [
          input.leaseId,
          rentMinor,
          depositMinor,
          depositMonths,
          override.reason,
          override.by,
          override.at,
          documentHash,
          session.orgId,
          input.updatedAt,
        ],
      );
      if (updated.rowCount !== 1) throw new FlowError("errors.staleLease");
      return {
        leaseId: input.leaseId,
        depositWarn: await savedDepositWarn(
          client,
          input.leaseId,
          depositMonths,
          depositReasonOk(depositMonths, override.reason ?? ""),
          depositPolicy,
        ),
      };
    },
    { orgId: session.orgId, environment: session.environment },
  );
}

async function queueDemoNotice(client: Client, leaseId: string, eventType: string) {
  const contact = await maybe<{ id: string; user_id: string | null; locale: string; org_id: string }>(
    client,
    `SELECT c.id, c.user_id, c.locale, l.org_id
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
      WHERE l.id = $1
      LIMIT 1`,
    [leaseId],
  );
  if (!contact) return;
  const dedupe = `${eventType}:${leaseId}:${randomUUID()}`;
  const org = await maybe<{ environment: string }>(
    client,
    `SELECT environment::text AS environment FROM organizations WHERE id = $1`,
    [contact.org_id],
  );
  const plan = deliveryPlan(org?.environment === "sandbox" ? "sandbox" : "live");
  const notice = await one<{ id: string }>(
    client,
    `INSERT INTO notifications (
       org_id, event_type, template_key, recipient_contact_id, recipient_user_id, lease_id, locale, payload, dedupe_key, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"demo":true}'::jsonb,$8,'queued')
     RETURNING id`,
    [contact.org_id, eventType, `notifications.${eventType}`, contact.id, contact.user_id, leaseId, contact.locale || "zh-TW", dedupe],
  );
  await client.query(
    `INSERT INTO deliveries (org_id, notification_id, channel, recipient_contact_id, recipient_user_id, status, provider, counts_toward_quota, error)
     VALUES ($1,$2,'line',$3,$4,$5,$6,false,$7)`,
    [contact.org_id, notice.id, contact.id, contact.user_id, plan.status, plan.provider, plan.error],
  );
  if (plan.error === SANDBOX_NOT_SENT) {
    await writeAudit(contact.org_id, contact.user_id, "notice_not_sent", {
      channel: "line",
      leaseId,
      note: plan.error,
    });
  }
}

export async function recordLeaseNotice(leaseId: string, eventType: string) {
  await svc(null, (client) => queueDemoNotice(client, leaseId, eventType));
}

export async function signLease(session: Session, input: { leaseId: string; signedName: string; consent: boolean }) {
  if (!input.consent) throw new FlowError("errors.consentRequired");
  if (!input.signedName.trim()) throw new FlowError("errors.required");

  const result = await svc(session.userId, async (client) => {
    const lease = await maybe<{ id: string; document_sha256: string; org_id: string; esign: string }>(
      client,
      `SELECT id, document_sha256, org_id, esign_status::text AS esign FROM leases WHERE id = $1`,
      [input.leaseId],
    );
    if (!lease || lease.org_id !== session.orgId) throw new FlowError("errors.notFound");
    if (lease.esign === "imported") throw new FlowError("errors.forbidden");
    const contact = await maybe<{ id: string }>(
      client,
      `SELECT c.id FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id
        WHERE lp.lease_id = $1 AND c.user_id = $2 LIMIT 1`,
      [input.leaseId, session.userId],
    );
    const member = await maybe<{ id: string; role: OrgRole }>(
      client,
      `SELECT id, role::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.orgId, session.userId],
    );
    const asTenant = Boolean(contact) && session.kind === "tenant";
    const asManager = Boolean(member) && (member?.role === "admin" || member?.role === "manager") && !asTenant;
    if (!asTenant && !asManager) throw new FlowError("errors.forbidden");
    if (!(await leaseIdentityReady(client, input.leaseId))) throw new FlowError("errors.idDocRequired");
    const role = asTenant ? "tenant" : "manager";
    const signature = await maybe<{ id: string }>(
      client,
      `SELECT id FROM lease_signatures
        WHERE lease_id = $1 AND signer_role = $2::signer_role AND status <> 'signed'
        ORDER BY signing_order LIMIT 1`,
      [input.leaseId, role],
    );
    if (!signature) throw new FlowError("errors.alreadySigned");
    await client.query(
      `UPDATE lease_signatures
          SET status = 'signed', signed_name = $2, document_sha256 = $3, consent_text_key = 'lease.consent',
              signed_at = now(), ip_address = '127.0.0.1', user_agent = 'condola-demo'
        WHERE id = $1`,
      [signature.id, input.signedName.trim(), lease.document_sha256],
    );
    await client.query(
      `INSERT INTO lease_signature_events (org_id, signature_id, event, actor_user_id, ip_address, user_agent, document_sha256)
       VALUES ($1,$2,'viewed_document',$3,'127.0.0.1','condola-demo',$4),
              ($1,$2,'consented',$3,'127.0.0.1','condola-demo',$4),
              ($1,$2,'signed',$3,'127.0.0.1','condola-demo',$4)`,
      [session.orgId, signature.id, session.userId, lease.document_sha256],
    );
    const remaining = await one<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM lease_signatures WHERE lease_id = $1 AND status <> 'signed'`,
      [input.leaseId],
    );
    if (Number(remaining.n) > 0) {
      await client.query(`UPDATE leases SET esign_status = 'partially_signed' WHERE id = $1`, [input.leaseId]);
      return { esign: "partially_signed" as const, invoiceId: null as string | null };
    }
    await client.query(
      `UPDATE leases SET status = 'active', esign_status = 'fully_signed', signed_at = now() WHERE id = $1`,
      [input.leaseId],
    );
    await ensureThread(client, input.leaseId);
    const invoiceId = await issueMoveInInvoice(client, input.leaseId);
    await queueDemoNotice(client, input.leaseId, "rent_due");
    return { esign: "fully_signed" as const, invoiceId };
  });
  if (result.esign === "fully_signed") await markTryout(session.orgId, "lease");
  return result;
}

/** Paper pilot: store the signed PDF in private per-firm storage and mark the lease executed. */
export async function uploadSignedLeasePdf(
  session: Session,
  leaseId: string,
  file: { bytes: Uint8Array; fileName: string; replaceReason?: unknown },
) {
  assertStaff(session, ["admin", "manager"]);
  if (!isSignedPdf(file.bytes)) throw new FlowError("errors.pdf");
  const fileName = signedPdfName(file.fileName);
  const hash = createHash("sha256").update(file.bytes).digest("hex");
  const result = await tx(session.userId, async (client) => {
    const lease = await maybe<{ id: string; status: string; esign: string }>(
      client,
      `SELECT id::text, status::text, esign_status::text AS esign FROM leases WHERE id = $1 AND org_id = $2`,
      [leaseId, session.orgId],
    );
    if (!lease) throw new FlowError("errors.notFound");
    const versions = await import("./paper-lease-versions");
    const paperVersion = await versions.preparePaperLeaseVersion(client, session, leaseId, file.replaceReason);
    const imported = lease.esign === "imported";
    if (!imported && !(await leaseIdentityReady(client, leaseId))) throw new FlowError("errors.idDocRequired");
    const path = `${session.orgId}/${leaseId}/${randomUUID()}.pdf`;
    const stored = await one<{ id: string }>(
      client,
      `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sha256, uploaded_by)
       VALUES ($1,'lease-documents-private',$2,$3,'application/pdf',$4,$5,$6) RETURNING id`,
      [session.orgId, path, fileName, file.bytes.length, hash, session.userId],
    );
    if (paperVersion.enabled) {
      await versions.insertPaperLeaseVersion(client, session, {
        leaseId,
        fileId: stored.id,
        path,
        content: file.bytes,
        version: paperVersion,
      });
    } else {
      await client.query(
        `INSERT INTO lease_signed_pdfs (org_id, lease_id, file_id, bucket, object_path, content)
       VALUES ($1,$2,$3,'lease-documents-private',$4,$5)`,
        [session.orgId, leaseId, stored.id, path, Buffer.from(file.bytes)],
      );
    }
    if (!imported) {
      await client.query(
        `UPDATE lease_signatures
            SET status = 'signed', signed_name = coalesce(signed_name, 'paper'), document_sha256 = $2,
                consent_text_key = 'lease.paper', signed_at = coalesce(signed_at, now())
          WHERE lease_id = $1 AND status <> 'signed'`,
        [leaseId, hash],
      );
      await client.query(
        `INSERT INTO lease_signature_events (org_id, signature_id, event, actor_user_id, document_sha256, details)
         SELECT org_id, id, 'signed', $2, $3, '{"medium":"paper"}'::jsonb
           FROM lease_signatures
          WHERE lease_id = $1 AND document_sha256 = $3 AND signed_at IS NOT NULL`,
        [leaseId, session.userId, hash],
      );
    }
    const activated = !imported && (lease.status === "draft" || lease.status === "pending_signature");
    await client.query(
      `UPDATE leases
          SET document_file_id = $2, document_sha256 = $3,
              esign_status = CASE WHEN esign_status = 'imported' THEN esign_status ELSE 'fully_signed'::esign_status END,
              status = CASE
                WHEN esign_status = 'imported' THEN status
                WHEN status IN ('draft','pending_signature') THEN 'active'::lease_status
                ELSE status
              END,
              signed_at = CASE WHEN esign_status = 'imported' THEN signed_at ELSE coalesce(signed_at, now()) END
        WHERE id = $1 AND org_id = $4`,
      [leaseId, stored.id, hash, session.orgId],
    );
    if (activated) {
      await ensureThread(client, leaseId);
      const invoiceId = await issueMoveInInvoice(client, leaseId);
      return { activated: true, invoiceId };
    }
    return { activated: false, invoiceId: null as string | null };
  });
  if (result.activated) {
    await svc(session.userId, (client) => queueDemoNotice(client, leaseId, "rent_due"));
    await markTryout(session.orgId, "lease");
  }
  return result;
}

/** Demo shortcut: sign the tenant side without switching personas. Both languages use the same action. */
export async function simulateTenantSignature(session: Session, leaseId: string) {
  assertStaff(session, ["admin", "manager"]);
  const tenant = await svc(session.userId, async (client) => {
    const row = await maybe<{ user_id: string | null; display_name: string; org_id: string }>(
      client,
      `SELECT c.user_id, c.display_name, l.org_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1`,
      [leaseId],
    );
    if (!row?.user_id || row.org_id !== session.orgId) throw new FlowError("errors.notFound");
    return row;
  });
  return signLease(
    { ...session, userId: tenant.user_id!, kind: "tenant", role: null, name: tenant.display_name },
    { leaseId, signedName: tenant.display_name, consent: true },
  );
}

async function ensureThread(client: Client, leaseId: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id FROM message_threads WHERE lease_id = $1 AND kind = 'lease'`,
    [leaseId],
  );
  if (existing) return existing.id;
  const lease = await one<{ org_id: string; property_id: string }>(
    client,
    `SELECT org_id, property_id FROM leases WHERE id = $1`,
    [leaseId],
  );
  const thread = await one<{ id: string }>(
    client,
    `INSERT INTO message_threads (org_id, kind, lease_id, property_id) VALUES ($1,'lease',$2,$3) RETURNING id`,
    [lease.org_id, leaseId, lease.property_id],
  );
  const contacts = await many<{ id: string }>(client, `SELECT contact_id AS id FROM lease_parties WHERE lease_id = $1`, [leaseId]);
  for (const contact of contacts) {
    await client.query(
      `INSERT INTO thread_participants (org_id, thread_id, contact_id) VALUES ($1,$2,$3)`,
      [lease.org_id, thread.id, contact.id],
    );
  }
  const members = await many<{ id: string }>(
    client,
    `SELECT id FROM org_members WHERE org_id = $1 AND status = 'active' AND role IN ('admin','manager')`,
    [lease.org_id],
  );
  for (const member of members) {
    await client.query(
      `INSERT INTO thread_participants (org_id, thread_id, member_id) VALUES ($1,$2,$3)`,
      [lease.org_id, thread.id, member.id],
    );
  }
  return thread.id;
}

async function issueMoveInInvoice(client: Client, leaseId: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id FROM invoices WHERE lease_id = $1 AND source = 'move_in' AND status <> 'void' LIMIT 1`,
    [leaseId],
  );
  if (existing) return existing.id;
  const lease = await one<{
    property_id: string;
    org_id: string;
    currency: string;
    rent_amount_minor: string;
    deposit_amount_minor: string;
    start_date: string;
    end_date: string;
  }>(
    client,
    `SELECT property_id::text, org_id::text, currency, rent_amount_minor::text, deposit_amount_minor::text, start_date::text, end_date::text
       FROM leases WHERE id = $1`,
    [leaseId],
  );
  const party = await one<{ contact_id: string }>(
    client,
    `SELECT contact_id FROM lease_parties WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
    [leaseId],
  );
  // A confirmed electricity split already has its own invoice line. Attaching that
  // allocation again violates invoice_lines_alloc_uniq and rolls the countersign back.
  const allocation = await maybe<{ id: string; amount_minor: string }>(
    client,
    `SELECT l.id, l.amount_minor::text
       FROM utility_allocation_lines l
      WHERE l.lease_id = $1 AND l.amount_minor > 0
        AND l.posted_invoice_line_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_lines il WHERE il.allocation_line_id = l.id
        )
      ORDER BY l.amount_minor DESC
      LIMIT 1`,
    [leaseId],
  );
  const approver = await maybe<{ user_id: string }>(
    client,
    `SELECT m.user_id FROM lease_signatures s JOIN org_members m ON m.id = s.member_id
      WHERE s.lease_id = $1 AND s.signer_role = 'manager' LIMIT 1`,
    [leaseId],
  );
  const actor =
    approver?.user_id ??
    (await one<{ id: string }>(client, `SELECT auth.uid() AS id`)).id;
  const number = await nextInvoiceNumber(client, lease.org_id);
  const invoice = await one<{ id: string }>(
    client,
    `INSERT INTO invoices (
       org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency, issue_date, due_date,
       period_start, period_end, status, source, created_by, einvoice_status
     ) VALUES ($1,$2,$3,$4,$5,$6,current_date, current_date + 7, $7, $8, 'open', 'move_in', $9, 'not_applicable')
     RETURNING id`,
    [lease.org_id, lease.property_id, leaseId, party.contact_id, number, lease.currency, lease.start_date, lease.end_date, actor],
  );
  const lines = [
    { type: "rent", amount: Number(lease.rent_amount_minor), allocationId: null as string | null },
    ...(Number(lease.deposit_amount_minor) > 0
      ? [{ type: "deposit", amount: Number(lease.deposit_amount_minor), allocationId: null as string | null }]
      : []),
    ...(allocation && Number(allocation.amount_minor) > 0
      ? [{ type: "utility", amount: Number(allocation.amount_minor), allocationId: allocation.id }]
      : []),
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(
      `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor, allocation_line_id)
       VALUES ($1,$2,$3,$4::charge_type,$5,1,$6,$7,$8)`,
      [lease.org_id, invoice.id, index + 1, line.type, line.type, line.amount, line.amount, line.allocationId],
    );
  }
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by)
     VALUES ($1,$2,$3,'invoice',$4,current_date,$5,'invoices',$6,$7) RETURNING id`,
    [lease.org_id, lease.property_id, leaseId, lease.currency, number, invoice.id, actor],
  );
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
     VALUES ($1,$2,'tenant_receivable',$3,$4,$5,$6,$7,$8,'invoice')`,
    [lease.org_id, txn.id, total, lease.currency, party.contact_id, lease.property_id, leaseId, invoice.id],
  );
  for (const line of lines) {
    const account = line.type === "rent" ? "rental_income" : line.type === "deposit" ? "deposits_held" : "other_income";
    await client.query(
      `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
       VALUES ($1,$2,$3::ledger_account,$4,$5,$6,$7,$8,$9,$10)`,
      [lease.org_id, txn.id, account, -line.amount, lease.currency, party.contact_id, lease.property_id, leaseId, invoice.id, line.type],
    );
  }
  await client.query(`UPDATE invoices SET ledger_transaction_id = $2 WHERE id = $1`, [invoice.id, txn.id]);
  if (allocation) {
    await client.query(
      `UPDATE utility_allocation_runs
          SET status = 'posted', approved_by = $2, approved_at = now()
        WHERE id = (SELECT run_id FROM utility_allocation_lines WHERE id = $1)`,
      [allocation.id, actor],
    );
  }
  return invoice.id;
}

async function openBalance(client: Client, leaseId: string) {
  const row = await one<{ balance: string }>(
    client,
    `SELECT coalesce(sum(balance_minor), 0)::text AS balance
       FROM invoices WHERE lease_id = $1 AND status IN ('open','partially_paid')`,
    [leaseId],
  );
  return Number(row.balance);
}

async function allocateAndLedger(
  client: Client,
  payment: { id: string; org_id: string; property_id: string; lease_id: string; currency: string; amount_minor: string; payer_contact_id: string | null },
  userId: string,
) {
  let left = Number(payment.amount_minor);
  const invoices = await many<{ id: string; balance_minor: string }>(
    client,
    `SELECT id, balance_minor::text FROM invoices
      WHERE lease_id = $1 AND status IN ('open','partially_paid') AND balance_minor > 0
      ORDER BY due_date, created_at`,
    [payment.lease_id],
  );
  if (invoices.length === 0) throw new FlowError("errors.noInvoice");
  for (const invoice of invoices) {
    if (left <= 0) break;
    const take = Math.min(left, Number(invoice.balance_minor));
    await client.query(
      `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [payment.org_id, payment.id, invoice.id, take, userId],
    );
    left -= take;
  }
  const applied = Number(payment.amount_minor) - left;
  if (applied <= 0) throw new FlowError("errors.noInvoice");
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by)
     VALUES ($1,$2,$3,'payment',$4,current_date,'payment','payments',$5,$6) RETURNING id`,
    [payment.org_id, payment.property_id, payment.lease_id, payment.currency, payment.id, userId],
  );
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, memo)
     VALUES ($1,$2,'cash_clearing',$3,$4,$5,$6,$7,'payment'),
            ($1,$2,'tenant_receivable',$8,$4,$5,$6,$7,'payment')`,
    [
      payment.org_id,
      txn.id,
      applied,
      payment.currency,
      payment.payer_contact_id,
      payment.property_id,
      payment.lease_id,
      -applied,
    ],
  );
  await client.query(`UPDATE payments SET ledger_transaction_id = $2 WHERE id = $1`, [payment.id, txn.id]);
}

export async function recordPayment(
  session: Session,
  input: { leaseId: string; amountMajor: number; paidOn: string; last5: string; reference: string },
) {
  const amount = toMinor(input.amountMajor);
  if (!(amount > 0) || !input.paidOn) throw new FlowError("errors.amount");

  if (session.kind === "tenant") {
    const paymentId = await tx(session.userId, async (client) => {
      const lease = await one<{ property_id: string; currency: string; org_id: string }>(
        client,
        `SELECT property_id::text, currency, org_id::text FROM leases WHERE id = $1`,
        [input.leaseId],
      );
      if (lease.currency === "TWD" && !/^\d{5}$/.test(input.last5)) throw new FlowError("errors.last5");
      const balance = await openBalance(client, input.leaseId);
      if (balance <= 0) throw new FlowError("errors.noInvoice");
      if (amount > balance) throw new FlowError("errors.amountTooHigh");
      const contact = await maybe<{ id: string }>(
        client,
        `SELECT c.id FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id
          WHERE lp.lease_id = $1 AND c.user_id = $2 LIMIT 1`,
        [input.leaseId, session.userId],
      );
      if (!contact) throw new FlowError("errors.forbidden");
      const payment = await one<{ id: string }>(
        client,
        `INSERT INTO payments (
           org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
           payer_account_last5, reference, status, source, submitted_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::payment_method,$9,$10,'submitted','tenant_portal',$11)
         RETURNING id`,
        [
          lease.org_id,
          lease.property_id,
          input.leaseId,
          contact.id,
          lease.currency,
          amount,
          input.paidOn,
          lease.currency === "USD" ? "zelle" : "bank_transfer",
          input.last5 || null,
          input.reference || null,
          session.userId,
        ],
      );
      return payment.id;
    });
    return { paymentId, status: "submitted" as const };
  }

  assertStaff(session, ["admin", "manager", "accountant"]);
  const paymentId = await tx(session.userId, async (client) => {
    const lease = await one<{ property_id: string; currency: string }>(
      client,
      `SELECT property_id::text, currency FROM leases WHERE id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId],
    );
    if (lease.currency === "TWD" && !/^\d{5}$/.test(input.last5)) throw new FlowError("errors.last5");
    const balance = await openBalance(client, input.leaseId);
    if (amount > balance) throw new FlowError("errors.amountTooHigh");
    const party = await one<{ contact_id: string }>(
      client,
      `SELECT contact_id FROM lease_parties WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
      [input.leaseId],
    );
    const payment = await one<{
      id: string;
      org_id: string;
      property_id: string;
      lease_id: string;
      currency: string;
      amount_minor: string;
      payer_contact_id: string | null;
    }>(
      client,
      `INSERT INTO payments (
         org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
         payer_account_last5, reference, status, source, submitted_by, confirmed_by, confirmed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::payment_method,$9,$10,'confirmed','manager_entry',$11,$11,now()
       ) RETURNING id, org_id::text, property_id::text, lease_id::text, currency, amount_minor::text, payer_contact_id::text`,
      [
        session.orgId,
        lease.property_id,
        input.leaseId,
        party.contact_id,
        lease.currency,
        amount,
        input.paidOn,
        lease.currency === "USD" ? "zelle" : "bank_transfer",
        input.last5 || null,
        input.reference || null,
        session.userId,
      ],
    );
    await allocateAndLedger(client, payment, session.userId);
    return payment.id;
  });
  await svc(session.userId, async (client) => queueDemoNotice(client, input.leaseId, "payment_confirmed"));
  return { paymentId, status: "confirmed" as const };
}

export async function confirmPayment(session: Session, paymentId: string) {
  assertStaff(session, ["admin", "manager", "accountant"]);
  const leaseId = await tx(session.userId, async (client) => {
    const payment = await maybe<{
      id: string;
      org_id: string;
      property_id: string;
      lease_id: string;
      currency: string;
      amount_minor: string;
      payer_contact_id: string | null;
      status: string;
    }>(
      client,
      `SELECT id, org_id::text, property_id::text, lease_id::text, currency, amount_minor::text, payer_contact_id::text, status::text
         FROM payments WHERE id = $1 AND org_id = $2`,
      [paymentId, session.orgId],
    );
    if (!payment) throw new FlowError("errors.notFound");
    if (payment.status === "confirmed") return payment.lease_id;
    if (payment.status !== "submitted") throw new FlowError("errors.paymentState");
    const balance = await openBalance(client, payment.lease_id);
    if (Number(payment.amount_minor) > balance) throw new FlowError("errors.amountTooHigh");
    await client.query(
      `UPDATE payments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [payment.id, session.userId],
    );
    await allocateAndLedger(client, payment, session.userId);
    return payment.lease_id;
  });
  await svc(session.userId, async (client) => queueDemoNotice(client, leaseId, "payment_confirmed"));
  return { paymentId, status: "confirmed" as const };
}

export async function rejectPayment(session: Session, paymentId: string, reason: string) {
  assertStaff(session, ["admin", "manager", "accountant"]);
  if (!reason.trim()) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const updated = await client.query(
      `UPDATE payments SET status = 'rejected', rejected_reason = $2 WHERE id = $1 AND org_id = $3 AND status = 'submitted'`,
      [paymentId, reason.trim(), session.orgId],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.paymentState");
  });
}

// Property and owner spreadsheets are parsed in the browser and committed by
// src/server/import-batch.ts. Column aliases, including the legacy headers, live in
// src/server/owner-import.ts. Bank CSV below is a separate importer.
export function parseCsv(text: string) {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsv(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index]?.trim() ?? "";
    });
    return row;
  });
}

function splitCsv(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function normalizeHeader(header: string) {
  const aliases: Record<string, string> = {
    date: "date",
    交易日期: "date",
    amount: "amount",
    存入金額: "amount",
    last5: "last5",
    帳號末五碼: "last5",
    memo: "memo",
    備註: "memo",
  };
  return aliases[header.trim()] ?? header.trim();
}

export function sampleCsv(payment: { paidOn: string; amountMinor: number; last5: string; currency: string }) {
  const major = Number(payment.amountMinor) / 100;
  const amount = payment.currency === "TWD" ? String(Math.round(major)) : major.toFixed(2);
  const decoy = payment.currency === "TWD" ? "1000" : "25.00";
  return `date,amount,last5,memo\n${payment.paidOn},${amount},${payment.last5},rent\n${payment.paidOn},${decoy},11111,other`;
}

export async function importBankCsv(session: Session, csv: string) {
  assertPerm(session, "bank.reconcile");
  const rows = parseCsv(csv).filter((row) => row.date && row.amount);
  if (rows.length === 0) throw new FlowError("errors.csv");
  return tx(session.userId, async (client) => {
    const account = await one<{ id: string; currency: string }>(
      client,
      `SELECT id, currency FROM bank_accounts WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [session.orgId],
    );
    const file = await one<{ id: string }>(
      client,
      `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,'bank-imports',$2,'statement.csv','text/csv',$3,$4) RETURNING id`,
      [session.orgId, `demo/${randomUUID()}.csv`, Buffer.byteLength(csv), session.userId],
    );
    let mapping = await maybe<{ id: string }>(
      client,
      `SELECT id FROM bank_csv_mappings WHERE bank_account_id = $1 LIMIT 1`,
      [account.id],
    );
    if (!mapping) {
      mapping = await one<{ id: string }>(
        client,
        `INSERT INTO bank_csv_mappings (org_id, bank_account_id, name, column_map)
         VALUES ($1,$2,'demo','{"date":"date","amount":"amount","last5":"last5","memo":"memo"}'::jsonb)
         RETURNING id`,
        [session.orgId, account.id],
      );
    }
    const imported = await one<{ id: string }>(
      client,
      `INSERT INTO bank_statement_imports (org_id, bank_account_id, mapping_id, file_id, status, uploaded_by)
       VALUES ($1,$2,$3,$4,'parsed',$5) RETURNING id`,
      [session.orgId, account.id, mapping.id, file.id, session.userId],
    );
    let suggestions = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const major = Number(String(row.amount).replace(/,/g, ""));
      if (!Number.isFinite(major)) throw new FlowError("errors.csv");
      const minor = toMinor(major);
      const last5 = /^\d{5}$/.test(row.last5 ?? "") ? row.last5 : null;
      const hash = sha256([account.id, row.date, minor, row.memo ?? "", index].join("|"));
      const txn = await one<{ id: string }>(
        client,
        `INSERT INTO bank_transactions (
           org_id, bank_account_id, import_id, row_number, posted_on, amount_minor, currency,
           description, counterparty_account_last5, raw, dedupe_hash, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'unmatched') RETURNING id`,
        [session.orgId, account.id, imported.id, index + 1, row.date, minor, account.currency, row.memo || null, last5, JSON.stringify(row), hash],
      );
      if (minor > 0) {
        suggestions += await suggestMatches(client, session.orgId, txn.id, { minor, last5, date: row.date, currency: account.currency });
      }
    }
    await client.query(
      `UPDATE bank_statement_imports SET row_count = $2, status = 'completed' WHERE id = $1`,
      [imported.id, rows.length],
    );
    return { importId: imported.id, rows: rows.length, suggestions };
  });
}

async function suggestMatches(
  client: Client,
  orgId: string,
  bankTransactionId: string,
  bank: { minor: number; last5: string | null; date: string; currency: string },
) {
  const payments = await many<{ id: string; amount_minor: string; payer_account_last5: string | null; paid_on: string }>(
    client,
    `SELECT id, amount_minor::text, payer_account_last5, paid_on::text
       FROM payments
      WHERE org_id = $1 AND currency = $2 AND bank_transaction_id IS NULL AND status IN ('submitted','confirmed')`,
    [orgId, bank.currency],
  );
  let count = 0;
  for (const payment of payments) {
    const scored = scoreMatch({
      payAmount: Number(payment.amount_minor),
      bankAmount: bank.minor,
      payLast5: payment.payer_account_last5,
      bankLast5: bank.last5,
      payDate: payment.paid_on,
      bankDate: bank.date,
    });
    if (scored.score < 0.5) continue;
    await client.query(
      `INSERT INTO bank_match_suggestions (org_id, bank_transaction_id, payment_id, score, reasons, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'suggested')`,
      [orgId, bankTransactionId, payment.id, scored.score, JSON.stringify(scored.reasons)],
    );
    count += 1;
  }
  if (count > 0) {
    await client.query(`UPDATE bank_transactions SET status = 'suggested' WHERE id = $1`, [bankTransactionId]);
  }
  return count;
}

export async function approveMatch(session: Session, suggestionId: string) {
  assertPerm(session, "bank.reconcile");
  const leaseId = await tx(session.userId, async (client) => {
    const suggestion = await maybe<{
      id: string;
      bank_transaction_id: string;
      payment_id: string | null;
      status: string;
    }>(
      client,
      `SELECT id, bank_transaction_id::text, payment_id::text, status::text
         FROM bank_match_suggestions WHERE id = $1 AND org_id = $2`,
      [suggestionId, session.orgId],
    );
    if (!suggestion || suggestion.status !== "suggested" || !suggestion.payment_id) {
      throw new FlowError("errors.matchState");
    }
    await client.query(
      `UPDATE bank_match_suggestions SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
      [suggestion.id, session.userId],
    );
    await client.query(
      `UPDATE bank_match_suggestions
          SET status = 'superseded', decided_by = $2, decided_at = now()
        WHERE bank_transaction_id = $1 AND id <> $3 AND status = 'suggested'`,
      [suggestion.bank_transaction_id, session.userId, suggestion.id],
    );
    await client.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1`, [suggestion.bank_transaction_id]);
    const payment = await one<{
      id: string;
      org_id: string;
      property_id: string;
      lease_id: string;
      currency: string;
      amount_minor: string;
      payer_contact_id: string | null;
      status: string;
    }>(
      client,
      `SELECT id, org_id::text, property_id::text, lease_id::text, currency, amount_minor::text, payer_contact_id::text, status::text
         FROM payments WHERE id = $1`,
      [suggestion.payment_id],
    );
    if (payment.status === "submitted") {
      await client.query(
        `UPDATE payments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), bank_transaction_id = $3 WHERE id = $1`,
        [payment.id, session.userId, suggestion.bank_transaction_id],
      );
      await allocateAndLedger(client, payment, session.userId);
    } else if (payment.status === "confirmed") {
      await client.query(`UPDATE payments SET bank_transaction_id = $2 WHERE id = $1`, [payment.id, suggestion.bank_transaction_id]);
    } else {
      throw new FlowError("errors.paymentState");
    }
    return payment.lease_id;
  });
  return { leaseId };
}

/** Point each paid invoice at the latest issued statement that includes its payment. The ledger pointer is not involved. */
async function linkStatementInvoices(client: Client, orgId: string, propertyIds: string[]) {
  if (propertyIds.length === 0) return;
  await client.query(
    `UPDATE invoices i
        SET owner_statement_id = picked.statement_id
       FROM (
         SELECT DISTINCT ON (inv.id) inv.id AS invoice_id, s.id AS statement_id
           FROM invoices inv
           JOIN payment_allocations a ON a.invoice_id = inv.id
           JOIN payments pay ON pay.id = a.payment_id AND pay.status = 'confirmed'
           JOIN leases l ON l.id = inv.lease_id
           JOIN property_owners po ON po.property_id = l.property_id
           JOIN owner_statements s ON s.owner_contact_id = po.owner_contact_id
            AND s.org_id = inv.org_id
            AND s.status = 'issued'
            AND pay.paid_on >= s.period_start
            AND pay.paid_on <= s.period_end
          WHERE inv.org_id = $1
            AND inv.property_id = ANY($2::uuid[])
          ORDER BY inv.id, s.period_end DESC, s.id DESC
       ) picked
      WHERE i.id = picked.invoice_id
        AND i.owner_statement_id IS DISTINCT FROM picked.statement_id`,
    [orgId, propertyIds],
  );
}

export async function generateStatement(session: Session, input: { ownerContactId: string; month: string }) {
  assertPerm(session, "stmt.generate");
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new FlowError("errors.required");
  const bounds = monthBounds(input.month);
  const statementId = await tx(session.userId, async (client) => {
    const properties = await many<{ property_id: string; currency: string; name: string }>(
      client,
      `SELECT po.property_id::text, p.currency, p.name
         FROM property_owners po JOIN properties p ON p.id = po.property_id
        WHERE po.org_id = $1 AND po.owner_contact_id = $2
          AND (po.effective_to IS NULL OR po.effective_to >= $3::date)`,
      [session.orgId, input.ownerContactId, bounds.start],
    );
    if (properties.length === 0) throw new FlowError("errors.notFound");
    const currencies = [...new Set(properties.map((property) => property.currency))];
    if (currencies.length !== 1) throw new FlowError("errors.currency");
    const currency = currencies[0];
    const propertyIds = properties.map((property) => property.property_id);
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT id FROM owner_statements
        WHERE owner_contact_id = $1 AND currency = $2 AND period_start = $3 AND status <> 'void'`,
      [input.ownerContactId, currency, bounds.start],
    );
    if (existing) {
      await linkStatementInvoices(client, session.orgId, propertyIds);
      const row = await one<{ rent: string; other: string }>(
        client,
        `SELECT rent_received_minor::text AS rent, other_income_minor::text AS other FROM owner_statements WHERE id = $1`,
        [existing.id],
      );
      return { id: existing.id, earned: Number(row.rent) + Number(row.other) > 0 };
    }

    const payments = await many<{ id: string; property_id: string; property_name: string }>(
      client,
      `SELECT p.id, l.property_id::text, pr.name AS property_name
         FROM payments p
         JOIN leases l ON l.id = p.lease_id
         JOIN properties pr ON pr.id = l.property_id
        WHERE p.org_id = $1 AND p.status = 'confirmed' AND p.currency = $2
          AND p.paid_on BETWEEN $3 AND $4 AND l.property_id = ANY($5::uuid[])`,
      [session.orgId, currency, bounds.start, bounds.end, propertyIds],
    );
    const rentByProperty = new Map<string, { name: string; rent: number; utility: number; other: number }>();
    for (const property of properties) rentByProperty.set(property.property_id, { name: property.name, rent: 0, utility: 0, other: 0 });
    for (const payment of payments) {
      const allocations = await many<{ amount_minor: string; invoice_id: string }>(
        client,
        `SELECT amount_minor::text, invoice_id::text FROM payment_allocations WHERE payment_id = $1`,
        [payment.id],
      );
      for (const allocation of allocations) {
        const lines = await many<{ charge_type: string; amount_minor: string; description: string }>(
          client,
          `SELECT charge_type::text, amount_minor::text, description FROM invoice_lines WHERE invoice_id = $1`,
          [allocation.invoice_id],
        );
        const buckets = attributePayment(
          lines.map((line) => ({
            charge_type: line.charge_type,
            amount_minor: Number(line.amount_minor),
            description: line.description,
          })),
          Number(allocation.amount_minor),
        );
        const bucket = rentByProperty.get(payment.property_id)!;
        bucket.rent += buckets.rent;
        bucket.utility += buckets.utility;
        bucket.other += buckets.other;
      }
    }
    const rent = [...rentByProperty.values()].reduce((sum, row) => sum + row.rent, 0);
    const other = [...rentByProperty.values()].reduce((sum, row) => sum + row.utility + row.other, 0);
    const expenses = await many<{ id: string; amount_minor: string; description: string | null; category: string; property_id: string }>(
      client,
      `SELECT id, amount_minor::text, description, category, property_id::text FROM expenses
        WHERE org_id = $1 AND property_id = ANY($2::uuid[]) AND ${STATEMENT_EXPENSE_SQL}
          AND app.repair_cost_on_statement(ticket_id, org_id)
          AND incurred_on BETWEEN $3 AND $4 AND currency = $5`,
      [session.orgId, propertyIds, bounds.start, bounds.end, currency],
    );
    const expenseTotal = expenses.reduce((sum, expense) => sum + Number(expense.amount_minor), 0);
    const rule = await maybe<{
      kind: string;
      hybrid_mode: string | null;
      percent_bp: number | null;
      fixed_amount_minor: string | null;
      minimum_minor: string | null;
      name: string;
    }>(
      client,
      `SELECT fr.kind::text, fr.hybrid_mode::text, fr.percent_bp, fr.fixed_amount_minor::text, fr.minimum_minor::text, fr.name
         FROM management_agreements ma JOIN fee_rules fr ON fr.id = ma.fee_rule_id
        WHERE ma.org_id = $1 AND ma.owner_contact_id = $2
          AND (ma.property_id IS NULL OR ma.property_id = ANY($3::uuid[]))
          AND ma.effective_from <= $4 AND (ma.effective_to IS NULL OR ma.effective_to > $4)
        ORDER BY ma.property_id NULLS LAST
        LIMIT 1`,
      [session.orgId, input.ownerContactId, propertyIds, bounds.end],
    );
    const fee = rule ? managementFeeMinor(rule, rent) : 0;
    const previous = await maybe<{ closing_balance_minor: string }>(
      client,
      `SELECT closing_balance_minor::text FROM owner_statements
        WHERE owner_contact_id = $1 AND currency = $2 AND status = 'issued' AND period_end < $3::date
        ORDER BY period_end DESC LIMIT 1`,
      [input.ownerContactId, currency, bounds.start],
    );
    const opening = Number(previous?.closing_balance_minor ?? 0);
    const closing = opening + rent + other - fee - expenseTotal;
    const statement = await one<{ id: string }>(
      client,
      `INSERT INTO owner_statements (
         org_id, owner_contact_id, currency, period_start, period_end, status,
         opening_balance_minor, rent_received_minor, other_income_minor, management_fee_minor,
         expenses_minor, payouts_minor, closing_balance_minor, fee_rule_snapshot, locale,
         einvoice_status, issued_at, issued_by
       ) VALUES (
         $1,$2,$3,$4,$5,'issued',$6,$7,$8,$9,$10,0,$11,$12::jsonb,$13,'not_applicable',now(),$14
       ) RETURNING id`,
      [
        session.orgId,
        input.ownerContactId,
        currency,
        bounds.start,
        bounds.end,
        opening,
        rent,
        other,
        fee,
        expenseTotal,
        closing,
        JSON.stringify(rule ?? { name: null }),
        session.locale,
        session.userId,
      ],
    );
    for (const [propertyId, bucket] of rentByProperty) {
      if (bucket.rent) {
        await client.query(
          `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor)
           VALUES ($1,$2,$3,'rent',$4,$5)`,
          [session.orgId, statement.id, propertyId, bucket.name, bucket.rent],
        );
      }
      if (bucket.utility) {
        await client.query(
          `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor)
           VALUES ($1,$2,$3,'other_income',$4,$5)`,
          [session.orgId, statement.id, propertyId, "電費", bucket.utility],
        );
      }
      if (bucket.other) {
        await client.query(
          `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor)
           VALUES ($1,$2,$3,'other_income',$4,$5)`,
          [session.orgId, statement.id, propertyId, bucket.name, bucket.other],
        );
      }
    }
    if (fee) {
      await client.query(
        `INSERT INTO owner_statement_lines (org_id, statement_id, line_type, description, amount_minor)
         VALUES ($1,$2,'management_fee',$3,$4)`,
        [session.orgId, statement.id, rule?.name ?? "fee", fee],
      );
    }
    for (const expense of expenses) {
      await client.query(
        `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor, expense_id)
         VALUES ($1,$2,$3,'expense',$4,$5,$6)`,
        [session.orgId, statement.id, expense.property_id, expense.description?.trim() || expense.category, Number(expense.amount_minor), expense.id],
      );
    }
    await linkStatementInvoices(client, session.orgId, propertyIds);
    return { id: statement.id, earned: rent + other > 0 };
  });
  if (statementId.earned) await markTryout(session.orgId, "statement");
  return { statementId: statementId.id };
}

async function nextTicketNumber(orgId: string) {
  return svc(null, async (client) => {
    const row = await one<{ n: string }>(
      client,
      `SELECT (coalesce(max(ticket_number), 1000) + 1)::text AS n FROM maintenance_tickets WHERE org_id = $1`,
      [orgId],
    );
    return Number(row.n);
  });
}

export async function createTicket(
  session: Session,
  input: { leaseId: string; category: string; title: string; description: string; priority?: string },
) {
  if (!input.title.trim()) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    const lease = await one<{ property_id: string; unit_id: string; target_room_id: string | null; org_id: string }>(
      client,
      `SELECT property_id::text, unit_id::text, target_room_id::text, org_id::text FROM leases WHERE id = $1`,
      [input.leaseId],
    );
    if (session.kind === "tenant") {
      const contact = await maybe<{ id: string }>(
        client,
        `SELECT c.id FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id
          WHERE lp.lease_id = $1 AND c.user_id = $2`,
        [input.leaseId, session.userId],
      );
      if (!contact) throw new FlowError("errors.forbidden");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tickets:${lease.org_id}`]);
      const ticketNumber = await nextTicketNumber(lease.org_id);
      await client.query(
        `INSERT INTO maintenance_tickets (
           org_id, ticket_number, property_id, unit_id, room_id, lease_id, category, priority, status,
           title, description, reported_by_user, reported_by_contact_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::ticket_category,$8::ticket_priority,'open',$9,$10,$11,$12)`,
        [
          lease.org_id,
          ticketNumber,
          lease.property_id,
          lease.unit_id,
          lease.target_room_id,
          input.leaseId,
          input.category || "other",
          input.priority || "normal",
          input.title.trim(),
          input.description.trim(),
          session.userId,
          contact.id,
        ],
      );
      // RETURNING is checked against SELECT policies before the new row is visible
      // to can_see_ticket(), so a tenant insert must be read back in a second statement.
      const ticket = await one<{ id: string }>(
        client,
        `SELECT id FROM maintenance_tickets WHERE org_id = $1 AND ticket_number = $2`,
        [lease.org_id, ticketNumber],
      );
      await client.query(`SELECT app.note_ticket_opened($1::uuid)`, [ticket.id]);
      await markTryout(lease.org_id, "repair");
      return ticket.id;
    }
    assertPerm(session, "tickets.update");
    const number = await one<{ n: string }>(
      client,
      `SELECT (coalesce(max(ticket_number), 1000) + 1)::text AS n FROM maintenance_tickets WHERE org_id = $1`,
      [session.orgId],
    );
    const ticket = await one<{ id: string }>(
      client,
      `INSERT INTO maintenance_tickets (
         org_id, ticket_number, property_id, unit_id, room_id, lease_id, category, priority, status, title, description, reported_by_user
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::ticket_category,$8::ticket_priority,'open',$9,$10,$11) RETURNING id`,
      [
        session.orgId,
        Number(number.n),
        lease.property_id,
        lease.unit_id,
        lease.target_room_id,
        input.leaseId,
        input.category || "other",
        input.priority || "normal",
        input.title.trim(),
        input.description.trim(),
        session.userId,
      ],
    );
    await client.query(`SELECT app.note_ticket_opened($1::uuid)`, [ticket.id]);
    return ticket.id;
  });
}

export async function updateTicket(
  session: Session,
  ticketId: string,
  patch: { status?: string; assigneeMemberId?: string; note?: string },
) {
  assertPerm(session, "tickets.update");
  if (patch.status) assertTicketStatus(patch.status);
  await tx(session.userId, async (client) => {
    const current = await maybe<{ status: string }>(
      client,
      `SELECT status::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`,
      [ticketId, session.orgId],
    );
    if (!current) throw new FlowError("errors.notFound");
    const statusChanged = Boolean(patch.status && patch.status !== current.status);
    if (statusChanged || patch.assigneeMemberId) {
      await client.query(
        `UPDATE maintenance_tickets
            SET status = coalesce($2::ticket_status, status),
                assigned_member_id = coalesce($3::uuid, assigned_member_id),
                resolved_at = CASE
                  WHEN $2::ticket_status IN ('resolved','closed') THEN coalesce(resolved_at, now())
                  ELSE resolved_at END,
                closed_at = CASE
                  WHEN $2::ticket_status = 'closed' THEN coalesce(closed_at, now())
                  ELSE closed_at END,
                completed_on = CASE
                  WHEN $2::ticket_status IN ('resolved','closed') THEN coalesce(completed_on, (timezone('Asia/Taipei', now()))::date)
                  ELSE completed_on END
          WHERE id = $1 AND org_id = $4`,
        [ticketId, statusChanged ? patch.status : null, patch.assigneeMemberId || null, session.orgId],
      );
    }
    const note = patch.note?.trim() || null;
    if (note || statusChanged) {
      await client.query(
        `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, body, status_from, status_to)
         VALUES ($1,$2,$3,$4,$5::ticket_status,$6::ticket_status)`,
        [session.orgId, ticketId, session.userId, note, statusChanged ? current.status : null, statusChanged ? patch.status : null],
      );
    }
  });
}

export async function postMessage(session: Session, threadId: string, body: string) {
  if (!body.trim()) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    if (session.kind === "tenant") {
      const contact = await maybe<{ id: string; org_id: string }>(
        client,
        `SELECT c.id, c.org_id::text
           FROM thread_participants tp
           JOIN contacts c ON c.id = tp.contact_id
          WHERE tp.thread_id = $1 AND c.user_id = $2 AND tp.left_at IS NULL
          LIMIT 1`,
        [threadId, session.userId],
      );
      if (!contact) throw new FlowError("errors.forbidden");
      await client.query(
        `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_contact_id, body, inbound_channel)
         VALUES ($1,$2,$3,$4,$5,'in_app')`,
        [contact.org_id, threadId, session.userId, contact.id, body.trim()],
      );
      return;
    }
    assertPerm(session, "messages.send");
    const member = await one<{ id: string }>(
      client,
      `SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.orgId, session.userId],
    );
    await client.query(
      `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_member_id, body, inbound_channel)
       VALUES ($1,$2,$3,$4,$5,'in_app')`,
      [session.orgId, threadId, session.userId, member.id, body.trim()],
    );
    await client.query(`UPDATE message_threads SET last_message_at = now() WHERE id = $1 AND org_id = $2`, [threadId, session.orgId]);
  });
}

export async function inviteTeammate(session: Session, input: { email: string; role: OrgRole }) {
  assertStaff(session, ["admin"]);
  assertTeamInvitesAllowed(session.orgId);
  const email = cleanEmail(input.email);
  if (!email) throw new FlowError("errors.required");
  const code = `CND-${randomUUID().slice(0, 8).toUpperCase()}`;
  await tx(session.userId, async (client) => {
    await client.query(
      `INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at, invited_by)
       VALUES ($1,'team_member',$2::org_role,$3,$4, now() + interval '7 days', $5)`,
      [session.orgId, input.role, email, sha256(code), session.userId],
    );
  });
  const note = outboundNote(session.environment);
  if (note) await writeAudit(session.orgId, session.userId, "invite", { email, role: input.role, note });
  return { code };
}

export { addExpense } from "./expenses";

export async function reversePayment(session: Session, paymentId: string, reason: string) {
  assertPerm(session, "pay.reverse");
  const note = reason.trim();
  if (!note) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const payment = await maybe<{ id: string; status: string; ledger_transaction_id: string | null }>(
      client,
      `SELECT id::text, status::text, ledger_transaction_id::text
         FROM payments WHERE id = $1 AND org_id = $2`,
      [paymentId, session.orgId],
    );
    if (!payment || payment.status !== "confirmed" || !payment.ledger_transaction_id) {
      throw new FlowError("errors.paymentState");
    }
    await client.query(`SELECT post_reversal($1::uuid, $2)`, [payment.ledger_transaction_id, note]);
    await client.query(`UPDATE payments SET status = 'reversed' WHERE id = $1 AND org_id = $2`, [payment.id, session.orgId]);
  }, { orgId: session.orgId, environment: session.environment });
}

export async function closeMonth(session: Session, month: string, note: string) {
  assertPerm(session, "month.close");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM month_closes WHERE org_id = $1 AND period_month = $2::date`,
      [session.orgId, `${month}-01`],
    );
    if (existing) throw new FlowError("errors.paymentState");
    await client.query(
      `INSERT INTO month_closes (org_id, period_month, closed_by, note) VALUES ($1, $2::date, $3, $4)`,
      [session.orgId, `${month}-01`, session.userId, note.trim() || null],
    );
  });
}
