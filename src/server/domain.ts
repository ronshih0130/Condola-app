import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { maybe, many, one, svc, tx } from "./db";
import { FlowError } from "./errors";
import { ORG_ID } from "./ids";
import {
  attributePayment,
  inclusiveDays,
  managementFeeMinor,
  monthBounds,
  round3,
  scoreMatch,
  splitWeighted,
  toMinor,
} from "./money";
import { assertStaff, type OrgRole, type Session } from "./types";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanPhone(phone: string) {
  const value = phone.trim();
  if (!value) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(value)) throw new FlowError("errors.phone");
  return value;
}

function cleanEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (!value) return null;
  if (!value.includes("@")) throw new FlowError("errors.email");
  return value;
}

async function provisionUser(input: { name: string; email: string | null; phone: string | null }) {
  return svc(null, async (client) => {
    const email = input.email ?? `portal-${randomUUID()}@demo.condola.local`;
    const user = await one<{ id: string }>(
      client,
      `INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at)
       VALUES ($1, $2::jsonb, now()) RETURNING id`,
      [email, JSON.stringify({ name: input.name })],
    );
    await client.query(
      `INSERT INTO profiles (id, display_name, email, phone_e164, locale) VALUES ($1,$2,$3,$4,'zh-TW')`,
      [user.id, input.name, email, input.phone],
    );
    return user.id;
  });
}

export async function markTryout(key: "property" | "lease" | "statement" | "repair") {
  try {
    await svc(null, async (client) => {
      await client.query(
        `UPDATE organizations
            SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), ARRAY['tryout', $2]::text[], 'true'::jsonb, true)
          WHERE id = $1`,
        [ORG_ID, key],
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
  rentalMode: "whole_unit" | "by_room";
  rooms: { label: string; roomType: string; baseRentMajor: number }[];
};

export async function createProperty(session: Session, input: PropertyInput) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.name.trim() || !input.city.trim() || !input.street.trim() || !input.unitLabel.trim()) {
    throw new FlowError("errors.required");
  }
  const rooms = input.rooms.filter((room) => room.label.trim());
  if (input.rentalMode === "by_room" && rooms.length < 2) throw new FlowError("errors.needRooms");

  let ownerUserId: string | null = null;
  let inviteCode: string | null = null;
  const ownerPhone = cleanPhone(input.ownerPhone);
  const ownerEmail = cleanEmail(input.ownerEmail);
  if (input.ownerMode === "new") {
    if (!input.ownerName.trim() || !ownerPhone) throw new FlowError("errors.required");
    ownerUserId = await provisionUser({ name: input.ownerName.trim(), email: ownerEmail, phone: ownerPhone });
    inviteCode = `CND-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  const created = await tx(session.userId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`property:${session.userId}:${input.name.trim()}`]);
    const recent = await maybe<{ id: string }>(
      client,
      `SELECT id FROM properties
        WHERE org_id = $1 AND name = $2 AND created_at > now() - interval '20 seconds'
        ORDER BY created_at DESC LIMIT 1`,
      [ORG_ID, input.name.trim()],
    );
    if (recent) return { propertyId: recent.id, ownerContactId: "", roomIds: [] as string[] };
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
    };
    const display =
      country === "TW"
        ? `${address.city}${address.district}${address.street}`
        : [address.street, address.city, address.district].filter(Boolean).join(", ");
    const property = await one<{ id: string }>(
      client,
      `INSERT INTO properties (org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        ORG_ID,
        input.name.trim(),
        JSON.stringify(address),
        display,
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
        `INSERT INTO contacts (org_id, user_id, is_owner, display_name, email, phone_e164, locale, preferred_channel)
         VALUES ($1,$2,true,$3,$4,$5,$6,'email') RETURNING id`,
        [ORG_ID, ownerUserId, input.ownerName.trim(), ownerEmail, ownerPhone, session.locale],
      );
      ownerContactId = contact.id;
      await client.query(
        `INSERT INTO invitations (org_id, kind, contact_id, email, phone_e164, code_hash, invited_by)
         VALUES ($1,'owner',$2,$3,$4,$5,$6)`,
        [ORG_ID, ownerContactId, ownerEmail, ownerPhone, sha256(inviteCode!), session.userId],
      );
    }
    if (!ownerContactId) throw new FlowError("errors.required");

    await client.query(
      `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary, can_view_tenant_phone)
       VALUES ($1,$2,$3,true,$4)`,
      [ORG_ID, property.id, ownerContactId, input.canViewTenantPhone],
    );

    const rule = await maybe<{ id: string }>(
      client,
      `SELECT id FROM fee_rules
        WHERE org_id = $1 AND purpose = 'management_fee' AND currency = $2 AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [ORG_ID, input.currency],
    );
    if (rule) {
      const agreement = await maybe<{ id: string }>(
        client,
        `SELECT id FROM management_agreements
          WHERE org_id = $1 AND owner_contact_id = $2
            AND (property_id IS NULL OR property_id = $3)
            AND (effective_to IS NULL OR effective_to > current_date)
          LIMIT 1`,
        [ORG_ID, ownerContactId, property.id],
      );
      if (!agreement) {
        await client.query(
          `INSERT INTO management_agreements (org_id, owner_contact_id, property_id, fee_rule_id, effective_from)
           VALUES ($1,$2,$3,$4,current_date)`,
          [ORG_ID, ownerContactId, property.id, rule.id],
        );
      }
    }

    const unit = await one<{ id: string }>(
      client,
      `INSERT INTO units (org_id, property_id, label, floor, rental_mode, area_unit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ORG_ID, property.id, input.unitLabel.trim(), input.floor.trim() || null, input.rentalMode, country === "TW" ? "ping" : "sqft"],
    );
    const roomIds: string[] = [];
    for (const room of rooms) {
      const inserted = await one<{ id: string }>(
        client,
        `INSERT INTO rooms (org_id, unit_id, label, room_type, base_rent_minor, area_unit)
         VALUES ($1,$2,$3,$4::room_type,$5,$6) RETURNING id`,
        [ORG_ID, unit.id, room.label.trim(), room.roomType || "suite", toMinor(room.baseRentMajor || 0), country === "TW" ? "ping" : "sqft"],
      );
      roomIds.push(inserted.id);
    }
    return { propertyId: property.id, ownerContactId, roomIds };
  });

  if (input.rentalMode === "by_room" && created.roomIds.length >= 3) await markTryout("property");
  return { ...created, inviteCode };
}

export async function setMeterSerial(session: Session, propertyId: string, serial: string) {
  assertStaff(session, ["admin", "manager"]);
  const value = serial.trim();
  if (!value) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const unit = await maybe<{ id: string }>(
      client,
      `SELECT id FROM units WHERE property_id = $1 AND org_id = $2 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [propertyId, ORG_ID],
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
      await client.query(`UPDATE meters SET serial_number = $2 WHERE id = $1 AND org_id = $3`, [meter.id, value, ORG_ID]);
      return;
    }
    await client.query(
      `INSERT INTO meters (
         org_id, property_id, unit_id, utility, usage_unit, label, serial_number, payer, split_method, rate_source
       ) VALUES ($1,$2,$3,'electricity','kWh','main',$4,'tenant','even','bill_average')`,
      [ORG_ID, propertyId, unit.id, value],
    );
  });
}

export async function setOwnerPhoneVisibility(session: Session, propertyOwnerId: string, canView: boolean) {
  assertStaff(session, ["admin", "manager"]);
  await tx(session.userId, async (client) => {
    const updated = await client.query(
      `UPDATE property_owners SET can_view_tenant_phone = $2 WHERE id = $1 AND org_id = $3`,
      [propertyOwnerId, canView, ORG_ID],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
  });
}

export type LeaseInput = {
  roomId: string;
  tenantName: string;
  tenantPhone: string;
  tenantEmail: string;
  startDate: string;
  endDate: string;
  rentMajor: number;
  depositMonths: number;
  dueDay: number;
  splitMethod: "even" | "days_occupied" | "sub_meter";
  periodStart: string;
  periodEnd: string;
  billTotalMajor: number;
  usageKwh: number;
  rateMajor: number;
  rateSource: "fixed_rate" | "bill_average";
  overrideReason: string;
  subUsages: { roomId: string; kwh: number }[];
};

export async function createLease(session: Session, input: LeaseInput) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.tenantName.trim() || !input.roomId || !input.startDate || !input.endDate) {
    throw new FlowError("errors.required");
  }
  if (!(input.dueDay >= 1 && input.dueDay <= 31)) throw new FlowError("errors.required");
  if (!(input.rentMajor > 0) || !(input.usageKwh > 0) || !(input.billTotalMajor >= 0)) {
    throw new FlowError("errors.amount");
  }
  if (input.periodEnd <= input.periodStart || input.endDate < input.startDate) throw new FlowError("errors.required");
  const phone = cleanPhone(input.tenantPhone);
  if (!phone) throw new FlowError("errors.required");
  const email = cleanEmail(input.tenantEmail);
  const tenantUserId = await provisionUser({ name: input.tenantName.trim(), email, phone });

  const billMinor = toMinor(input.billTotalMajor);
  const average = Math.round((billMinor / input.usageKwh) * 1e6) / 1e6;
  const rateMinor = input.rateSource === "bill_average" ? average : Math.round(input.rateMajor * 100 * 1e6) / 1e6;
  const exceeds = input.rateSource === "fixed_rate" && rateMinor > average + 1e-9;
  if (exceeds && !input.overrideReason.trim()) throw new FlowError("errors.capReason");

  const result = await tx(session.userId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lease:${input.roomId}`]);
    const already = await maybe<{ id: string; tenantUserId: string }>(
      client,
      `SELECT l.id::text, c.user_id::text AS "tenantUserId"
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.target_room_id = $1 AND l.org_id = $2
          AND l.status = 'pending_signature'
          AND l.created_at > now() - interval '2 minutes'
        ORDER BY l.created_at DESC
        LIMIT 1`,
      [input.roomId, ORG_ID],
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
      };
    }
    const room = await one<{ id: string; unit_id: string; property_id: string; currency: string }>(
      client,
      `SELECT r.id, r.unit_id, u.property_id, p.currency
         FROM rooms r JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
        WHERE r.id = $1 AND r.org_id = $2`,
      [input.roomId, ORG_ID],
    );
    const contact = await one<{ id: string }>(
      client,
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale, preferred_channel)
       VALUES ($1,$2,true,$3,$4,$5,$6,'line') RETURNING id`,
      [ORG_ID, tenantUserId, input.tenantName.trim(), email, phone, session.locale],
    );
    const rentMinor = toMinor(input.rentMajor);
    const depositMinor = Math.round(rentMinor * input.depositMonths);
    const documentHash = sha256(
      JSON.stringify({
        room: room.id,
        rentMinor,
        depositMinor,
        start: input.startDate,
        end: input.endDate,
      }),
    );
    const lease = await one<{ id: string }>(
      client,
      `INSERT INTO leases (
         org_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency,
         rent_amount_minor, due_day, prorate_first_period, deposit_amount_minor, deposit_months,
         document_sha256, created_by
       ) VALUES (
         $1,$2,$3,'pending_signature','sent',$4,$5,$6,$7,$8,false,$9,$10,$11,$12
       ) RETURNING id`,
      [
        ORG_ID,
        room.unit_id,
        room.id,
        input.startDate,
        input.endDate,
        room.currency,
        rentMinor,
        input.dueDay,
        depositMinor,
        input.depositMonths,
        documentHash,
        session.userId,
      ],
    );
    await client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
      [ORG_ID, lease.id, contact.id],
    );
    const member = await one<{ id: string }>(
      client,
      `SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [ORG_ID, session.userId],
    );
    const tenantSig = await one<{ id: string }>(
      client,
      `INSERT INTO lease_signatures (org_id, lease_id, signer_role, contact_id, status, signing_order, consent_text_key)
       VALUES ($1,$2,'tenant',$3,'pending',1,'lease.consent') RETURNING id`,
      [ORG_ID, lease.id, contact.id],
    );
    const managerSig = await one<{ id: string }>(
      client,
      `INSERT INTO lease_signatures (org_id, lease_id, signer_role, member_id, status, signing_order, consent_text_key)
       VALUES ($1,$2,'manager',$3,'pending',2,'lease.consent') RETURNING id`,
      [ORG_ID, lease.id, member.id],
    );
    await client.query(
      `INSERT INTO lease_signature_events (org_id, signature_id, event, actor_user_id, document_sha256)
       VALUES ($1,$2,'sent',$3,$4), ($1,$5,'sent',$3,$4)`,
      [ORG_ID, tenantSig.id, session.userId, documentHash, managerSig.id],
    );

    let meter = await maybe<{ id: string }>(
      client,
      `SELECT id FROM meters WHERE unit_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL LIMIT 1`,
      [room.unit_id],
    );
    if (!meter) {
      meter = await one<{ id: string }>(
        client,
        `INSERT INTO meters (
           org_id, unit_id, utility, usage_unit, label, payer, split_method, rate_source, rate_minor_per_unit, billing_cycle_months
         ) VALUES ($1,$2,'electricity','kWh','main','tenant',$3::split_method,$4::rate_source,$5,2)
         RETURNING id`,
        [ORG_ID, room.unit_id, input.splitMethod, input.rateSource, rateMinor],
      );
    }

    const bill = await one<{ id: string; avg: string }>(
      client,
      `INSERT INTO utility_bills (
         org_id, meter_id, provider, period_start, period_end, currency, total_amount_minor, total_usage, entered_by
       ) VALUES ($1,$2,'Taipower',$3,$4,$5,$6,$7,$8)
       RETURNING id, avg_price_minor_per_unit::text AS avg`,
      [ORG_ID, meter.id, input.periodStart, input.periodEnd, room.currency, billMinor, input.usageKwh, session.userId],
    );

    const unitRooms = await many<{ id: string; label: string }>(
      client,
      `SELECT id, label FROM rooms WHERE unit_id = $1 AND archived_at IS NULL ORDER BY label`,
      [room.unit_id],
    );
    const others = await many<{ id: string; target_room_id: string; start_date: string; end_date: string }>(
      client,
      `SELECT id::text, target_room_id::text, start_date::text, end_date::text
         FROM leases
        WHERE unit_id = $1 AND id <> $2 AND status IN ('pending_signature','active')
          AND daterange(start_date, coalesce(end_date, start_date), '[]') && daterange($3::date, $4::date, '[]')`,
      [room.unit_id, lease.id, input.periodStart, input.periodEnd],
    );

    const usageByRoom = new Map(input.subUsages.map((row) => [row.roomId, row.kwh]));
    const subTotal = unitRooms.reduce((sum, item) => sum + (usageByRoom.get(item.id) ?? 0), 0);
    if (input.splitMethod === "sub_meter" && subTotal - input.usageKwh > 0.001) throw new FlowError("errors.meter");
    const common = input.splitMethod === "sub_meter" ? round3(Math.max(0, input.usageKwh - subTotal)) : 0;
    const parts = unitRooms.map((item) => {
      const linked =
        item.id === room.id
          ? { id: lease.id, start_date: input.startDate, end_date: input.endDate }
          : others.find((row) => row.target_room_id === item.id);
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
      return { key: item.id, label: item.label, leaseId: linked?.id ?? null, weight, days, sub };
    });
    const totalAmount = Math.round(input.usageKwh * rateMinor);
    const shares = splitWeighted(input.usageKwh, totalAmount, parts);

    if (exceeds) {
      await client.query(`SELECT set_config('app.change_reason', $1, true)`, [input.overrideReason.trim()]);
    }
    const run = await one<{ id: string }>(
      client,
      `INSERT INTO utility_allocation_runs (
         org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
         total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
         cap_override_reason, cap_overridden_by, total_amount_minor, inputs, status, computed_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6::split_method,$7::rate_source,$8,$9,$10,'split_evenly',$11,$12,$13,$14,$15::jsonb,'draft',$16
       ) RETURNING id`,
      [
        ORG_ID,
        meter.id,
        bill.id,
        input.periodStart,
        input.periodEnd,
        input.splitMethod,
        input.rateSource,
        room.currency,
        input.usageKwh,
        common,
        rateMinor,
        exceeds ? input.overrideReason.trim() : null,
        exceeds ? session.userId : null,
        totalAmount,
        JSON.stringify({ rooms: parts.map((part) => ({ room: part.label, days: part.days, sub: part.sub })) }),
        session.userId,
      ],
    );

    for (let index = 0; index < shares.length; index += 1) {
      const share = shares[index];
      const part = parts[index];
      await client.query(
        `INSERT INTO utility_allocation_lines (
           org_id, run_id, lease_id, room_id, days_occupied, sub_meter_usage, share_ratio,
           allocated_usage, amount_minor, bearer, explanation
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::utility_payer,$11::jsonb)`,
        [
          ORG_ID,
          run.id,
          part.leaseId,
          part.key,
          part.days,
          input.splitMethod === "sub_meter" ? part.sub : null,
          share.ratio,
          share.usage,
          share.amount,
          part.leaseId ? "tenant" : "owner",
          JSON.stringify({ kwh: share.usage, rate_minor_per_unit: rateMinor, method: input.splitMethod, room: part.label }),
        ],
      );
    }

    const depositCheck = await maybe<{ outcome: string }>(
      client,
      `SELECT outcome::text FROM rule_check_results
        WHERE entity_table = 'leases' AND entity_id = $1
        ORDER BY checked_at DESC LIMIT 1`,
      [lease.id],
    );
    return {
      leaseId: lease.id,
      tenantUserId,
      depositWarn: depositCheck?.outcome === "warn",
      exceeds,
      average,
      tenantAmount: shares.find((share) => parts[shares.indexOf(share)]?.leaseId === lease.id)?.amount ?? 0,
      reused: false,
    };
  });

  if (!result.reused) {
    await svc(session.userId, (client) => queueDemoNotice(client, result.leaseId, "lease_to_sign"));
  }
  return result;
}

async function queueDemoNotice(client: PoolClient, leaseId: string, eventType: string) {
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
     VALUES ($1,$2,'line',$3,$4,'skipped','demo_line',false,'demo_not_sent')`,
    [contact.org_id, notice.id, contact.id, contact.user_id],
  );
}

export async function signLease(session: Session, input: { leaseId: string; signedName: string; consent: boolean }) {
  if (!input.consent) throw new FlowError("errors.consentRequired");
  if (!input.signedName.trim()) throw new FlowError("errors.required");

  const result = await svc(session.userId, async (client) => {
    const lease = await maybe<{ id: string; document_sha256: string; org_id: string }>(
      client,
      `SELECT id, document_sha256, org_id FROM leases WHERE id = $1`,
      [input.leaseId],
    );
    if (!lease || lease.org_id !== ORG_ID) throw new FlowError("errors.notFound");
    const contact = await maybe<{ id: string }>(
      client,
      `SELECT c.id FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id
        WHERE lp.lease_id = $1 AND c.user_id = $2 LIMIT 1`,
      [input.leaseId, session.userId],
    );
    const member = await maybe<{ id: string; role: OrgRole }>(
      client,
      `SELECT id, role::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [ORG_ID, session.userId],
    );
    const asTenant = Boolean(contact) && session.kind === "tenant";
    const asManager = Boolean(member) && (member?.role === "admin" || member?.role === "manager") && !asTenant;
    if (!asTenant && !asManager) throw new FlowError("errors.forbidden");
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
      [ORG_ID, signature.id, session.userId, lease.document_sha256],
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
  if (result.esign === "fully_signed") await markTryout("lease");
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
    if (!row?.user_id || row.org_id !== ORG_ID) throw new FlowError("errors.notFound");
    return row;
  });
  return signLease(
    { ...session, userId: tenant.user_id!, kind: "tenant", role: null, name: tenant.display_name },
    { leaseId, signedName: tenant.display_name, consent: true },
  );
}

async function ensureThread(client: PoolClient, leaseId: string) {
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

async function issueMoveInInvoice(client: PoolClient, leaseId: string) {
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
  const allocation = await maybe<{ id: string; amount_minor: string }>(
    client,
    `SELECT id, amount_minor::text FROM utility_allocation_lines
      WHERE lease_id = $1 AND amount_minor > 0
      ORDER BY amount_minor DESC LIMIT 1`,
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
  const count = await one<{ n: string }>(client, `SELECT count(*)::text AS n FROM invoices WHERE org_id = $1`, [lease.org_id]);
  const now = new Date();
  const number = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(Number(count.n) + 1).padStart(4, "0")}`;
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

async function openBalance(client: PoolClient, leaseId: string) {
  const row = await one<{ balance: string }>(
    client,
    `SELECT coalesce(sum(balance_minor), 0)::text AS balance
       FROM invoices WHERE lease_id = $1 AND status IN ('open','partially_paid')`,
    [leaseId],
  );
  return Number(row.balance);
}

async function allocateAndLedger(
  client: PoolClient,
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
      [input.leaseId, ORG_ID],
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
        ORG_ID,
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
      [paymentId, ORG_ID],
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
      [paymentId, reason.trim(), ORG_ID],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.paymentState");
  });
}

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
  assertStaff(session, ["admin", "manager", "accountant"]);
  const rows = parseCsv(csv).filter((row) => row.date && row.amount);
  if (rows.length === 0) throw new FlowError("errors.csv");
  return tx(session.userId, async (client) => {
    const account = await one<{ id: string; currency: string }>(
      client,
      `SELECT id, currency FROM bank_accounts WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [ORG_ID],
    );
    const file = await one<{ id: string }>(
      client,
      `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,'bank-imports',$2,'statement.csv','text/csv',$3,$4) RETURNING id`,
      [ORG_ID, `demo/${randomUUID()}.csv`, Buffer.byteLength(csv), session.userId],
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
        [ORG_ID, account.id],
      );
    }
    const imported = await one<{ id: string }>(
      client,
      `INSERT INTO bank_statement_imports (org_id, bank_account_id, mapping_id, file_id, status, uploaded_by)
       VALUES ($1,$2,$3,$4,'parsed',$5) RETURNING id`,
      [ORG_ID, account.id, mapping.id, file.id, session.userId],
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
        [ORG_ID, account.id, imported.id, index + 1, row.date, minor, account.currency, row.memo || null, last5, JSON.stringify(row), hash],
      );
      if (minor > 0) suggestions += await suggestMatches(client, txn.id, { minor, last5, date: row.date, currency: account.currency });
    }
    await client.query(
      `UPDATE bank_statement_imports SET row_count = $2, status = 'completed' WHERE id = $1`,
      [imported.id, rows.length],
    );
    return { importId: imported.id, rows: rows.length, suggestions };
  });
}

async function suggestMatches(
  client: PoolClient,
  bankTransactionId: string,
  bank: { minor: number; last5: string | null; date: string; currency: string },
) {
  const payments = await many<{ id: string; amount_minor: string; payer_account_last5: string | null; paid_on: string }>(
    client,
    `SELECT id, amount_minor::text, payer_account_last5, paid_on::text
       FROM payments
      WHERE org_id = $1 AND currency = $2 AND bank_transaction_id IS NULL AND status IN ('submitted','confirmed')`,
    [ORG_ID, bank.currency],
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
      [ORG_ID, bankTransactionId, payment.id, scored.score, JSON.stringify(scored.reasons)],
    );
    count += 1;
  }
  if (count > 0) {
    await client.query(`UPDATE bank_transactions SET status = 'suggested' WHERE id = $1`, [bankTransactionId]);
  }
  return count;
}

export async function approveMatch(session: Session, suggestionId: string) {
  assertStaff(session, ["admin", "manager", "accountant"]);
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
      [suggestionId, ORG_ID],
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

export async function generateStatement(session: Session, input: { ownerContactId: string; month: string }) {
  assertStaff(session, ["admin", "manager", "accountant"]);
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new FlowError("errors.required");
  const bounds = monthBounds(input.month);
  const statementId = await tx(session.userId, async (client) => {
    const properties = await many<{ property_id: string; currency: string; name: string }>(
      client,
      `SELECT po.property_id::text, p.currency, p.name
         FROM property_owners po JOIN properties p ON p.id = po.property_id
        WHERE po.org_id = $1 AND po.owner_contact_id = $2
          AND (po.effective_to IS NULL OR po.effective_to >= $3::date)`,
      [ORG_ID, input.ownerContactId, bounds.start],
    );
    if (properties.length === 0) throw new FlowError("errors.notFound");
    const currencies = [...new Set(properties.map((property) => property.currency))];
    if (currencies.length !== 1) throw new FlowError("errors.currency");
    const currency = currencies[0];
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT id FROM owner_statements
        WHERE owner_contact_id = $1 AND currency = $2 AND period_start = $3 AND status <> 'void'`,
      [input.ownerContactId, currency, bounds.start],
    );
    if (existing) {
      const row = await one<{ rent: string; other: string }>(
        client,
        `SELECT rent_received_minor::text AS rent, other_income_minor::text AS other FROM owner_statements WHERE id = $1`,
        [existing.id],
      );
      return { id: existing.id, earned: Number(row.rent) + Number(row.other) > 0 };
    }

    const propertyIds = properties.map((property) => property.property_id);
    const payments = await many<{ id: string; property_id: string; property_name: string }>(
      client,
      `SELECT p.id, l.property_id::text, pr.name AS property_name
         FROM payments p
         JOIN leases l ON l.id = p.lease_id
         JOIN properties pr ON pr.id = l.property_id
        WHERE p.org_id = $1 AND p.status = 'confirmed' AND p.currency = $2
          AND p.paid_on BETWEEN $3 AND $4 AND l.property_id = ANY($5::uuid[])`,
      [ORG_ID, currency, bounds.start, bounds.end, propertyIds],
    );
    const rentByProperty = new Map<string, { name: string; rent: number; other: number }>();
    for (const property of properties) rentByProperty.set(property.property_id, { name: property.name, rent: 0, other: 0 });
    for (const payment of payments) {
      const allocations = await many<{ amount_minor: string; invoice_id: string }>(
        client,
        `SELECT amount_minor::text, invoice_id::text FROM payment_allocations WHERE payment_id = $1`,
        [payment.id],
      );
      for (const allocation of allocations) {
        const lines = await many<{ charge_type: string; amount_minor: string }>(
          client,
          `SELECT charge_type::text, amount_minor::text FROM invoice_lines WHERE invoice_id = $1`,
          [allocation.invoice_id],
        );
        const buckets = attributePayment(
          lines.map((line) => ({ charge_type: line.charge_type, amount_minor: Number(line.amount_minor) })),
          Number(allocation.amount_minor),
        );
        const bucket = rentByProperty.get(payment.property_id)!;
        bucket.rent += buckets.rent;
        bucket.other += buckets.utility + buckets.other;
      }
    }
    const rent = [...rentByProperty.values()].reduce((sum, row) => sum + row.rent, 0);
    const other = [...rentByProperty.values()].reduce((sum, row) => sum + row.other, 0);
    const expenses = await many<{ id: string; amount_minor: string; description: string | null; property_id: string }>(
      client,
      `SELECT id, amount_minor::text, description, property_id::text FROM expenses
        WHERE org_id = $1 AND property_id = ANY($2::uuid[]) AND status IN ('approved','posted')
          AND incurred_on BETWEEN $3 AND $4 AND currency = $5 AND bill_to = 'owner'`,
      [ORG_ID, propertyIds, bounds.start, bounds.end, currency],
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
      [ORG_ID, input.ownerContactId, propertyIds, bounds.end],
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
        ORG_ID,
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
          [ORG_ID, statement.id, propertyId, bucket.name, bucket.rent],
        );
      }
      if (bucket.other) {
        await client.query(
          `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor)
           VALUES ($1,$2,$3,'other_income',$4,$5)`,
          [ORG_ID, statement.id, propertyId, bucket.name, bucket.other],
        );
      }
    }
    if (fee) {
      await client.query(
        `INSERT INTO owner_statement_lines (org_id, statement_id, line_type, description, amount_minor)
         VALUES ($1,$2,'management_fee',$3,$4)`,
        [ORG_ID, statement.id, rule?.name ?? "fee", fee],
      );
    }
    for (const expense of expenses) {
      await client.query(
        `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor, expense_id)
         VALUES ($1,$2,$3,'expense',$4,$5,$6)`,
        [ORG_ID, statement.id, expense.property_id, expense.description || "expense", Number(expense.amount_minor), expense.id],
      );
    }
    return { id: statement.id, earned: rent + other > 0 };
  });
  if (statementId.earned) await markTryout("statement");
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
      await markTryout("repair");
      return ticket.id;
    }
    assertStaff(session, ["admin", "manager", "maintenance"]);
    const number = await one<{ n: string }>(
      client,
      `SELECT (coalesce(max(ticket_number), 1000) + 1)::text AS n FROM maintenance_tickets WHERE org_id = $1`,
      [ORG_ID],
    );
    const ticket = await one<{ id: string }>(
      client,
      `INSERT INTO maintenance_tickets (
         org_id, ticket_number, property_id, unit_id, room_id, lease_id, category, priority, status, title, description, reported_by_user
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::ticket_category,$8::ticket_priority,'open',$9,$10,$11) RETURNING id`,
      [
        ORG_ID,
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
    return ticket.id;
  });
}

export async function updateTicket(
  session: Session,
  ticketId: string,
  patch: { status?: string; assigneeMemberId?: string; note?: string },
) {
  assertStaff(session, ["admin", "manager", "maintenance"]);
  await tx(session.userId, async (client) => {
    const current = await maybe<{ status: string }>(
      client,
      `SELECT status::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`,
      [ticketId, ORG_ID],
    );
    if (!current) throw new FlowError("errors.notFound");
    if (patch.status || patch.assigneeMemberId) {
      await client.query(
        `UPDATE maintenance_tickets
            SET status = coalesce($2::ticket_status, status),
                assigned_member_id = coalesce($3::uuid, assigned_member_id)
          WHERE id = $1`,
        [ticketId, patch.status || null, patch.assigneeMemberId || null],
      );
    }
    if (patch.note?.trim() || patch.status) {
      await client.query(
        `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, body, status_from, status_to)
         VALUES ($1,$2,$3,$4,$5::ticket_status,$6::ticket_status)`,
        [ORG_ID, ticketId, session.userId, patch.note?.trim() || null, current.status, patch.status || null],
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
    assertStaff(session, ["admin", "manager", "accountant", "maintenance"]);
    const member = await one<{ id: string }>(
      client,
      `SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [ORG_ID, session.userId],
    );
    await client.query(
      `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_member_id, body, inbound_channel)
       VALUES ($1,$2,$3,$4,$5,'in_app')`,
      [ORG_ID, threadId, session.userId, member.id, body.trim()],
    );
    await client.query(`UPDATE message_threads SET last_message_at = now() WHERE id = $1 AND org_id = $2`, [threadId, ORG_ID]);
  });
}

export async function inviteTeammate(session: Session, input: { email: string; role: OrgRole }) {
  assertStaff(session, ["admin"]);
  const email = cleanEmail(input.email);
  if (!email) throw new FlowError("errors.required");
  const code = `CND-${randomUUID().slice(0, 8).toUpperCase()}`;
  await tx(session.userId, async (client) => {
    await client.query(
      `INSERT INTO invitations (org_id, kind, role, email, code_hash, invited_by)
       VALUES ($1,'team_member',$2::org_role,$3,$4,$5)`,
      [ORG_ID, input.role, email, sha256(code), session.userId],
    );
  });
  return { code };
}
