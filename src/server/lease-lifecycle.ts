import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, query, tx } from "./db";
import { FlowError } from "./errors";
import { deliveryPlan } from "./outbound";
import { taipeiToday } from "./money";
import {
  COPY,
  dueDayOk,
  endReasonLabel,
  leaseInExpiryWindow,
  leaseLifecycleEnabled,
  majorOf,
  moneyMajor,
  moveOutDateOk,
  moveOutRentSpan,
  nextRenewalTerm,
  prorateRentMajor,
  renewalDatesOk,
  renewalSuccess,
  repairLabel,
  settleAmounts,
  unpaidRentLabel,
  type EndReason,
} from "./lease-lifecycle-rules";
import { assertStaff, type Session } from "./types";

function scopeOf(session: Session) {
  return { orgId: session.orgId, environment: session.environment };
}

async function assertLifecycle(client: Client, orgId: string) {
  const org = await maybe<{ environment: string; plan_tier: string }>(
    client,
    `SELECT environment::text, plan_tier::text FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw new FlowError("errors.notFound");
  if (!leaseLifecycleEnabled({ environment: org.environment, planTier: org.plan_tier })) {
    throw new FlowError("errors.lifecycleOff");
  }
}

export async function lifecycleEnabledFor(session: Session) {
  const org = await query<{ environment: string; plan_tier: string }>(
    `SELECT environment::text, plan_tier::text FROM organizations WHERE id = $1`,
    [session.orgId],
  );
  const row = org.rows[0];
  if (!row) return false;
  return leaseLifecycleEnabled({ environment: row.environment, planTier: row.plan_tier });
}

export type ExpiryStatus = "undecided" | "renewing" | "scheduled";

export type ExpiryRow = {
  id: string;
  tenant: string;
  place: string;
  endDate: string;
  days: number;
  status: ExpiryStatus;
  successorPending: boolean;
};

function expiryStatus(row: { moveout_id: string | null; successor_id: string | null }): ExpiryStatus {
  if (row.moveout_id) return "scheduled";
  if (row.successor_id) return "renewing";
  return "undecided";
}

export async function listExpiring(session: Session, status: ExpiryStatus | "all"): Promise<ExpiryRow[]> {
  assertStaff(session, ["admin", "manager", "accountant"]);
  const today = taipeiToday();
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const rows = await client.query<{
      id: string;
      tenant: string;
      place: string;
      end_date: string;
      successor_id: string | null;
      successor_status: string | null;
      moveout_id: string | null;
    }>(
      `SELECT l.id::text, c.display_name AS tenant,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              l.end_date::text,
              s.id::text AS successor_id, s.status::text AS successor_status,
              m.id::text AS moveout_id
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
         LEFT JOIN leases s ON s.org_id = l.org_id AND s.renewed_from_id = l.id AND s.status <> 'cancelled'
         LEFT JOIN lease_moveouts m ON m.org_id = l.org_id AND m.lease_id = l.id AND m.status = 'scheduled'
        WHERE l.org_id = $1
          AND l.status = 'active'
          AND l.end_date IS NOT NULL
          AND l.end_date >= $2::date
          AND l.end_date <= $2::date + 90
        ORDER BY l.end_date, c.display_name`,
      [session.orgId, today],
    );
    return rows.rows
      .map((row) => {
        const kind = expiryStatus(row);
        return {
          id: row.id,
          tenant: row.tenant,
          place: row.place,
          endDate: row.end_date,
          days: Math.round((Date.parse(`${row.end_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
          status: kind,
          successorPending: row.successor_status === "pending_signature" || row.successor_status === "draft",
        };
      })
      .filter((row) => status === "all" || row.status === status);
  }, scopeOf(session));
}

type LeaseCore = {
  id: string;
  status: string;
  start_date: string;
  end_date: string | null;
  currency: string;
  rent: string;
  deposit: string;
  due_day: number;
  tenant: string;
  contact_id: string;
  user_id: string | null;
  email: string | null;
  unit_id: string;
  target_unit_id: string | null;
  target_room_id: string | null;
  prorate: boolean;
};

async function loadLease(client: Client, orgId: string, leaseId: string) {
  return maybe<LeaseCore>(
    client,
    `SELECT l.id::text, l.status::text, l.start_date::text, l.end_date::text, l.currency,
            l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.due_day,
            l.unit_id::text, l.target_unit_id::text, l.target_room_id::text, l.prorate_first_period AS prorate,
            c.display_name AS tenant, c.id::text AS contact_id, c.user_id::text, c.email
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
      WHERE l.id = $1 AND l.org_id = $2
      FOR UPDATE OF l`,
    [leaseId, orgId],
  );
}

export async function renewalContext(session: Session, leaseId: string) {
  assertStaff(session, ["admin", "manager"]);
  const today = taipeiToday();
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const lease = await loadLease(client, session.orgId, leaseId);
    if (!lease || !leaseInExpiryWindow({ status: lease.status, endDate: lease.end_date, today })) return null;
    const successor = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM leases WHERE org_id = $1 AND renewed_from_id = $2 AND status <> 'cancelled' LIMIT 1`,
      [session.orgId, leaseId],
    );
    const currency = lease.currency.trim();
    const term = nextRenewalTerm(lease.start_date, lease.end_date as string);
    return {
      tenant: lease.tenant,
      endDate: lease.end_date as string,
      currency,
      rentMajor: majorOf(Number(lease.rent), currency),
      depositMajor: majorOf(Number(lease.deposit), currency),
      start: term.start,
      end: term.end,
      alreadyRenewed: Boolean(successor),
    };
  }, scopeOf(session));
}

async function queueRenewalNotice(
  client: Client,
  input: { orgId: string; leaseId: string; environment: string; text: string; contactId: string; userId: string | null; email: string | null },
) {
  const plan = deliveryPlan(input.environment === "sandbox" ? "sandbox" : "live");
  const notice = await one<{ id: string }>(
    client,
    `INSERT INTO notifications (
       org_id, event_type, template_key, recipient_contact_id, recipient_user_id, lease_id, locale, payload, dedupe_key, status
     ) VALUES (
       $1, 'lease_renewal', 'notifications.lease_renewal', $2, $3, $4, 'zh-TW', $5::jsonb, $6, 'queued'
     ) RETURNING id`,
    [
      input.orgId,
      input.contactId,
      input.userId,
      input.leaseId,
      JSON.stringify({ subject: input.text, text: input.text }),
      `lease_renewal:${input.leaseId}`,
    ],
  );
  await client.query(`SET LOCAL ROLE service_role`);
  await client.query(
    `INSERT INTO deliveries (
       org_id, notification_id, channel, recipient_contact_id, recipient_user_id, address, status, provider, counts_toward_quota, error
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9)`,
    [
      input.orgId,
      notice.id,
      input.email ? "email" : "in_app",
      input.contactId,
      input.userId,
      input.email,
      plan.status,
      plan.provider,
      plan.error,
    ],
  );
  await client.query(`SET LOCAL ROLE authenticated`);
}

export async function renewLease(
  session: Session,
  input: { leaseId: string; rentMajor: number; depositMajor: number; startDate: string; endDate: string; dueDay: number; depositReason: string },
) {
  assertStaff(session, ["admin", "manager"]);
  const today = taipeiToday();
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`renew:${input.leaseId}`]);
    const lease = await loadLease(client, session.orgId, input.leaseId);
    if (!lease) throw new FlowError("errors.notFound");
    if (!leaseInExpiryWindow({ status: lease.status, endDate: lease.end_date, today })) throw new FlowError("errors.notExpiring");
    const oldEnd = lease.end_date as string;
    if (!renewalDatesOk(oldEnd, input.startDate, input.endDate)) throw new FlowError("errors.renewDates");
    if (!dueDayOk(input.dueDay)) throw new FlowError("errors.amount");
    const currency = lease.currency.trim();
    const rentMinor = moneyMajor(input.rentMajor, currency);
    const depositMinor = moneyMajor(input.depositMajor, currency);
    if (rentMinor == null || depositMinor == null || input.rentMajor <= 0) throw new FlowError("errors.amount");
    const months = Math.round((input.depositMajor / input.rentMajor) * 100) / 100;
    const reason = input.depositReason.trim();
    if (months > 2 && !reason) throw new FlowError("errors.depositCap");
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM leases WHERE org_id = $1 AND renewed_from_id = $2 AND status <> 'cancelled' LIMIT 1`,
      [session.orgId, input.leaseId],
    );
    if (existing) throw new FlowError("errors.alreadyRenewed");
    const hash = randomUUID().replace(/-/g, "");
    const created = await one<{ id: string }>(
      client,
      `INSERT INTO leases (
         org_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
         deposit_amount_minor, deposit_months, deposit_override_reason, deposit_overridden_by, deposit_overridden_at,
         document_sha256, previous_lease_id, renewed_from_id, renewal_status, created_by
       ) VALUES (
         $1,$2,$3,$4,'pending_signature','sent',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,'none',$18
       ) RETURNING id`,
      [
        session.orgId,
        lease.unit_id,
        lease.target_unit_id,
        lease.target_room_id,
        input.startDate,
        input.endDate,
        currency,
        rentMinor,
        input.dueDay,
        lease.prorate,
        depositMinor,
        months,
        months > 2 ? reason : null,
        months > 2 ? session.userId : null,
        months > 2 ? new Date().toISOString() : null,
        hash,
        input.leaseId,
        session.userId,
      ],
    );
    await client.query(
      `INSERT INTO lease_parties (org_id, lease_id, contact_id, role, rent_share_bp)
       SELECT org_id, $2, contact_id, role, rent_share_bp FROM lease_parties WHERE lease_id = $1 AND org_id = $3`,
      [input.leaseId, created.id, session.orgId],
    );
    const member = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [session.orgId, session.userId],
    );
    if (member) {
      const tenantSig = await one<{ id: string }>(
        client,
        `INSERT INTO lease_signatures (org_id, lease_id, signer_role, contact_id, status, signing_order, consent_text_key)
         VALUES ($1,$2,'tenant',$3,'pending',1,'lease.consent') RETURNING id`,
        [session.orgId, created.id, lease.contact_id],
      );
      const managerSig = await one<{ id: string }>(
        client,
        `INSERT INTO lease_signatures (org_id, lease_id, signer_role, member_id, status, signing_order, consent_text_key)
         VALUES ($1,$2,'manager',$3,'pending',2,'lease.consent') RETURNING id`,
        [session.orgId, created.id, member.id],
      );
      await client.query(
        `INSERT INTO lease_signature_events (org_id, signature_id, event, actor_user_id, document_sha256)
         VALUES ($1,$2,'sent',$3,$4), ($1,$5,'sent',$3,$4)`,
        [session.orgId, tenantSig.id, session.userId, hash, managerSig.id],
      );
    }
    const text = renewalSuccess(input.startDate);
    await queueRenewalNotice(client, {
      orgId: session.orgId,
      leaseId: created.id,
      environment: session.environment,
      text,
      contactId: lease.contact_id,
      userId: lease.user_id,
      email: lease.email,
    });
    return { leaseId: created.id, previousLeaseId: input.leaseId, previousEnd: oldEnd, text };
  }, scopeOf(session));
}

export type MoveOutContext = {
  tenant: string;
  startDate: string;
  endDate: string;
  currency: string;
  rentMajor: number;
  scheduled: null | {
    moveOutOn: string;
    reason: EndReason;
    handoverAt: string | null;
    days: number;
    defaultMajor: number;
    finalMajor: number;
    overridden: boolean;
    overriddenAt: string | null;
    actor: string | null;
  };
};

export async function moveOutContext(session: Session, leaseId: string): Promise<MoveOutContext | null> {
  assertStaff(session, ["admin", "manager"]);
  const today = taipeiToday();
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const lease = await maybe<LeaseCore>(
      client,
      `SELECT l.id::text, l.status::text, l.start_date::text, l.end_date::text, l.currency,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.due_day,
              l.unit_id::text, l.target_unit_id::text, l.target_room_id::text, l.prorate_first_period AS prorate,
              c.display_name AS tenant, c.id::text AS contact_id, c.user_id::text, c.email
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND l.org_id = $2`,
      [leaseId, session.orgId],
    );
    if (!lease || !leaseInExpiryWindow({ status: lease.status, endDate: lease.end_date, today })) return null;
    const currency = lease.currency.trim();
    const scheduled = await maybe<{
      move_out_on: string;
      end_reason: EndReason;
      handover_at: Date | null;
      prorated_days: number;
      prorated_default_minor: string;
      final_rent_minor: string;
      override_minor: string | null;
      overridden_at: Date | null;
      actor: string | null;
    }>(
      client,
      `SELECT m.move_out_on::text, m.end_reason, m.handover_at, m.prorated_days,
              m.prorated_default_minor::text, m.final_rent_minor::text, m.override_minor::text, m.overridden_at,
              p.display_name AS actor
         FROM lease_moveouts m
         LEFT JOIN profiles p ON p.id = m.overridden_by
        WHERE m.lease_id = $1 AND m.org_id = $2`,
      [leaseId, session.orgId],
    );
    return {
      tenant: lease.tenant,
      startDate: lease.start_date,
      endDate: lease.end_date as string,
      currency,
      rentMajor: majorOf(Number(lease.rent), currency),
      scheduled: scheduled
        ? {
            moveOutOn: scheduled.move_out_on,
            reason: scheduled.end_reason,
            handoverAt: scheduled.handover_at ? scheduled.handover_at.toISOString() : null,
            days: scheduled.prorated_days,
            defaultMajor: majorOf(Number(scheduled.prorated_default_minor), currency),
            finalMajor: majorOf(Number(scheduled.final_rent_minor), currency),
            overridden: scheduled.override_minor != null,
            overriddenAt: scheduled.overridden_at ? scheduled.overridden_at.toISOString() : null,
            actor: scheduled.actor,
          }
        : null,
    };
  }, scopeOf(session));
}

function taipeiTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  return `${value}:00+08`;
}

async function syncOpenRent(client: Client, input: { orgId: string; leaseId: string; finalMinor: number; label: string; periodStart: string; moveOutOn: string }) {
  await client.query(`SET LOCAL ROLE service_role`);
  const updated = await client.query<{ invoice_id: string; old_amount: string; new_amount: string }>(
    `WITH targets AS (
       SELECT DISTINCT ON (i.id) line.id, line.amount_minor AS old_amount
         FROM invoices i
         JOIN invoice_lines line ON line.invoice_id = i.id AND line.charge_type = 'rent'
        WHERE i.lease_id = $4 AND i.org_id = $5 AND i.status = 'open' AND i.paid_minor = 0
          AND i.period_start <= $6::date
          AND coalesce(i.period_end, i.period_start) >= $7::date
        ORDER BY i.id, line.line_no
     )
     UPDATE invoice_lines il
        SET amount_minor = $1::bigint, unit_amount_minor = $2::numeric, description = $3
       FROM targets
      WHERE il.id = targets.id
      RETURNING il.invoice_id::text, targets.old_amount::text, il.amount_minor::text AS new_amount`,
    [input.finalMinor, input.finalMinor, input.label, input.leaseId, input.orgId, input.moveOutOn, input.periodStart],
  );
  for (const row of updated.rows) {
    const delta = Number(row.new_amount) - Number(row.old_amount);
    if (delta === 0) continue;
    const booked = await maybe<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM ledger_entries WHERE invoice_id = $1 AND account = 'tenant_receivable'`,
      [row.invoice_id],
    );
    if (!booked || booked.n === "0") continue;
    const txn = await one<{ id: string }>(
      client,
      `INSERT INTO ledger_transactions (
         org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, reason, created_by
       )
       SELECT org_id, property_id, lease_id, 'adjustment', currency, current_date, $2, 'invoices', id, 'moveout_rent', auth.uid()
         FROM invoices WHERE id = $1
       RETURNING id::text`,
      [row.invoice_id, input.label],
    );
    const invoice = await one<{ org_id: string; currency: string; property_id: string; lease_id: string; contact_id: string }>(
      client,
      `SELECT org_id::text, currency, property_id::text, lease_id::text, bill_to_contact_id::text AS contact_id
         FROM invoices WHERE id = $1`,
      [row.invoice_id],
    );
    await client.query(
      `INSERT INTO ledger_entries (
         org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo
       ) VALUES
         ($1,$2,'tenant_receivable',$3,$4,$5,$6,$7,$8,'moveout_rent'),
         ($1,$2,'rental_income',$9,$4,$5,$6,$7,$8,'moveout_rent')`,
      [invoice.org_id, txn.id, delta, invoice.currency, invoice.contact_id, invoice.property_id, invoice.lease_id, row.invoice_id, -delta],
    );
  }
  await client.query(`SET LOCAL ROLE authenticated`);
}

async function recomputeSettlement(client: Client, orgId: string, settlementId: string) {
  await client.query(
    `UPDATE lease_settlements s
        SET deductions_minor = totals.deductions,
            refund_minor = greatest(s.deposit_minor - totals.deductions, 0),
            shortfall_minor = greatest(totals.deductions - s.deposit_minor, 0)
       FROM (
         SELECT coalesce(sum(amount_minor), 0)::bigint AS deductions
           FROM lease_settlement_lines
          WHERE settlement_id = $1 AND org_id = $2
       ) totals
      WHERE s.id = $1 AND s.org_id = $2 AND s.status = 'draft'`,
    [settlementId, orgId],
  );
}

export async function scheduleMoveOut(
  session: Session,
  input: { leaseId: string; moveOutOn: string; reason: EndReason; handover: string; overrideMajor: number | null },
) {
  assertStaff(session, ["admin", "manager"]);
  const today = taipeiToday();
  if (input.reason !== "expired" && input.reason !== "early" && input.reason !== "other") throw new FlowError("errors.amount");
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`moveout:${input.leaseId}`]);
    const lease = await loadLease(client, session.orgId, input.leaseId);
    if (!lease) throw new FlowError("errors.notFound");
    if (!leaseInExpiryWindow({ status: lease.status, endDate: lease.end_date, today })) throw new FlowError("errors.alreadyClosed");
    if (!moveOutDateOk(lease.start_date, input.moveOutOn)) throw new FlowError("errors.moveOutDate");
    const span = moveOutRentSpan(lease.start_date, input.moveOutOn);
    if (!span) throw new FlowError("errors.moveOutDate");
    const currency = lease.currency.trim();
    const rentMajor = majorOf(Number(lease.rent), currency);
    const defaultMajor = prorateRentMajor(rentMajor, span.days);
    if (defaultMajor == null) throw new FlowError("errors.amount");
    const defaultMinor = moneyMajor(defaultMajor, currency);
    if (defaultMinor == null) throw new FlowError("errors.amount");
    const handover = taipeiTimestamp(input.handover);
    if (!handover) throw new FlowError("errors.date");
    let overrideMinor: number | null = null;
    if (input.overrideMajor != null && input.overrideMajor !== defaultMajor) {
      overrideMinor = moneyMajor(input.overrideMajor, currency);
      if (overrideMinor == null) throw new FlowError("errors.amount");
    }
    const finalMinor = overrideMinor ?? defaultMinor;
    const existing = await maybe<{ id: string; status: string }>(
      client,
      `SELECT id::text, status FROM lease_moveouts WHERE lease_id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId],
    );
    if (existing?.status === "settled") throw new FlowError("errors.alreadyClosed");
    const overriddenAt = overrideMinor == null ? null : new Date().toISOString();
    const overriddenBy = overrideMinor == null ? null : session.userId;
    let moveoutId = existing?.id;
    if (existing) {
      await client.query(
        `UPDATE lease_moveouts
            SET move_out_on = $3, end_reason = $4, handover_at = $5,
                monthly_rent_minor = $6, period_start = $7, period_end = $8, prorated_days = $9,
                prorated_default_minor = $10, override_minor = $11, final_rent_minor = $12,
                overridden_by = $13, overridden_at = $14, currency = $15
          WHERE id = $1 AND org_id = $2`,
        [
          existing.id, session.orgId, input.moveOutOn, input.reason, handover,
          Number(lease.rent), span.start, span.end, span.days, defaultMinor, overrideMinor, finalMinor,
          overriddenBy, overriddenAt, currency,
        ],
      );
    } else {
      const inserted = await one<{ id: string }>(
        client,
        `INSERT INTO lease_moveouts (
           org_id, lease_id, move_out_on, end_reason, handover_at, monthly_rent_minor, period_start, period_end,
           prorated_days, prorated_default_minor, override_minor, final_rent_minor, overridden_by, overridden_at,
           currency, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          session.orgId, input.leaseId, input.moveOutOn, input.reason, handover, Number(lease.rent),
          span.start, span.end, span.days, defaultMinor, overrideMinor, finalMinor, overriddenBy, overriddenAt,
          currency, session.userId,
        ],
      );
      moveoutId = inserted.id;
    }
    await client.query(
      `UPDATE leases
          SET end_reason = $3, moveout_on = $4::date, handover_at = $5, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId, input.reason, input.moveOutOn, handover],
    );
    const label = unpaidRentLabel(input.moveOutOn, span.startDay, span.endDay);
    let settlement = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM lease_settlements WHERE lease_id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId],
    );
    if (!settlement) {
      settlement = await one<{ id: string }>(
        client,
        `INSERT INTO lease_settlements (
           org_id, lease_id, moveout_id, deposit_minor, deductions_minor, refund_minor, shortfall_minor, currency, created_by
         ) VALUES ($1,$2,$3,$4,0,$4,0,$5,$6) RETURNING id`,
        [session.orgId, input.leaseId, moveoutId, Number(lease.deposit), currency, session.userId],
      );
    }
    const line = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM lease_settlement_lines WHERE settlement_id = $1 AND kind = 'unpaid_rent'`,
      [settlement.id],
    );
    if (line) {
      await client.query(
        `UPDATE lease_settlement_lines
            SET amount_minor = $2, day_start = $3, day_end = $4, item = $5
          WHERE id = $1`,
        [line.id, finalMinor, span.startDay, span.endDay, label],
      );
    } else {
      await client.query(
        `INSERT INTO lease_settlement_lines (
           org_id, settlement_id, lease_id, line_no, kind, amount_minor, item, day_start, day_end, photo_count
         ) VALUES ($1,$2,$3,1,'unpaid_rent',$4,$5,$6,$7,0)`,
        [session.orgId, settlement.id, input.leaseId, finalMinor, label, span.startDay, span.endDay],
      );
    }
    await recomputeSettlement(client, session.orgId, settlement.id);
    await syncOpenRent(client, {
      orgId: session.orgId,
      leaseId: input.leaseId,
      finalMinor,
      label,
      periodStart: span.start,
      moveOutOn: input.moveOutOn,
    });
    if (overrideMinor != null) {
      await client.query(`SET LOCAL ROLE service_role`);
      await writeAudit(session.orgId, session.userId, "moveout_rent_override", {
        leaseId: input.leaseId,
        beforeMinor: defaultMinor,
        afterMinor: overrideMinor,
        actor: session.name,
      }, client);
      await client.query(`SET LOCAL ROLE authenticated`);
    }
    return { leaseId: input.leaseId, finalMinor, defaultMinor, days: span.days, reason: endReasonLabel(input.reason) };
  }, scopeOf(session));
}

export type SettlementLine = {
  id: string;
  kind: "unpaid_rent" | "repair" | "electricity";
  amountMinor: number;
  label: string;
  photos: number;
};

export type SettlementView = {
  tenant: string;
  currency: string;
  moveOutOn: string;
  depositMinor: number;
  deductionsMinor: number;
  refundMinor: number;
  shortfallMinor: number;
  status: "draft" | "confirmed";
  refundOn: string | null;
  finalRentMinor: number;
  defaultMinor: number;
  days: number;
  monthlyMinor: number;
  overridden: boolean;
  overriddenAt: string | null;
  actor: string | null;
  startDay: number;
  endDay: number;
  lines: SettlementLine[];
};

function lineLabel(row: { kind: string; item: string | null; amount_minor: string; day_start: number | null; day_end: number | null; photo_count: number; move_out_on: string }) {
  if (row.kind === "unpaid_rent") return unpaidRentLabel(row.move_out_on, row.day_start ?? 1, row.day_end ?? 1);
  if (row.kind === "repair") return repairLabel(row.item || "", row.photo_count);
  return COPY.electricity;
}

export async function settlementContext(session: Session, leaseId: string): Promise<SettlementView | null> {
  assertStaff(session, ["admin", "manager", "accountant"]);
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const row = await maybe<{
      tenant: string;
      currency: string;
      move_out_on: string;
      deposit_minor: string;
      deductions_minor: string;
      refund_minor: string;
      shortfall_minor: string;
      status: "draft" | "confirmed";
      refund_on: string | null;
      final_rent_minor: string;
      prorated_default_minor: string;
      prorated_days: number;
      monthly_rent_minor: string;
      override_minor: string | null;
      overridden_at: Date | null;
      actor: string | null;
      period_start: string;
    }>(
      client,
      `SELECT c.display_name AS tenant, m.currency, m.move_out_on::text, s.deposit_minor::text, s.deductions_minor::text,
              s.refund_minor::text, s.shortfall_minor::text, s.status, s.refund_on::text,
              m.final_rent_minor::text, m.prorated_default_minor::text, m.prorated_days, m.monthly_rent_minor::text,
              m.override_minor::text, m.overridden_at, p.display_name AS actor, m.period_start::text
         FROM lease_settlements s
         JOIN lease_moveouts m ON m.id = s.moveout_id
         JOIN leases l ON l.id = s.lease_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
         LEFT JOIN profiles p ON p.id = m.overridden_by
        WHERE s.lease_id = $1 AND s.org_id = $2`,
      [leaseId, session.orgId],
    );
    if (!row) return null;
    const lines = await client.query<{
      id: string;
      kind: "unpaid_rent" | "repair" | "electricity";
      amount_minor: string;
      item: string | null;
      day_start: number | null;
      day_end: number | null;
      photo_count: number;
    }>(
      `SELECT id::text, kind, amount_minor::text, item, day_start, day_end, photo_count
         FROM lease_settlement_lines
        WHERE settlement_id = (SELECT id FROM lease_settlements WHERE lease_id = $1 AND org_id = $2)
        ORDER BY line_no`,
      [leaseId, session.orgId],
    );
    return {
      tenant: row.tenant,
      currency: row.currency.trim(),
      moveOutOn: row.move_out_on,
      depositMinor: Number(row.deposit_minor),
      deductionsMinor: Number(row.deductions_minor),
      refundMinor: Number(row.refund_minor),
      shortfallMinor: Number(row.shortfall_minor),
      status: row.status,
      refundOn: row.refund_on,
      finalRentMinor: Number(row.final_rent_minor),
      defaultMinor: Number(row.prorated_default_minor),
      days: row.prorated_days,
      monthlyMinor: Number(row.monthly_rent_minor),
      overridden: row.override_minor != null,
      overriddenAt: row.overridden_at ? row.overridden_at.toISOString() : null,
      actor: row.actor,
      startDay: Number(row.period_start.slice(8, 10)),
      endDay: Number(row.move_out_on.slice(8, 10)),
      lines: lines.rows.map((line) => ({
        id: line.id,
        kind: line.kind,
        amountMinor: Number(line.amount_minor),
        photos: line.photo_count,
        label: lineLabel({ ...line, move_out_on: row.move_out_on }),
      })),
    };
  }, scopeOf(session));
}

export async function addDeduction(
  session: Session,
  input: { leaseId: string; kind: "repair" | "electricity"; amountMajor: number; item: string; photos: number },
) {
  assertStaff(session, ["admin", "manager"]);
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const settlement = await maybe<{ id: string; status: string; currency: string }>(
      client,
      `SELECT id::text, status, currency FROM lease_settlements WHERE lease_id = $1 AND org_id = $2 FOR UPDATE`,
      [input.leaseId, session.orgId],
    );
    if (!settlement || settlement.status !== "draft") throw new FlowError("errors.alreadyClosed");
    const currency = settlement.currency.trim();
    const amount = moneyMajor(input.amountMajor, currency);
    if (amount == null || input.amountMajor <= 0) throw new FlowError("errors.amount");
    const item = input.kind === "repair" ? input.item.trim() : "";
    if (input.kind === "repair" && !item) throw new FlowError("errors.amount");
    const photos = input.kind === "repair" ? Math.max(0, Math.floor(input.photos)) : 0;
    const next = await one<{ line_no: number }>(
      client,
      `SELECT coalesce(max(line_no), 0) + 1 AS line_no FROM lease_settlement_lines WHERE settlement_id = $1`,
      [settlement.id],
    );
    await client.query(
      `INSERT INTO lease_settlement_lines (
         org_id, settlement_id, lease_id, line_no, kind, amount_minor, item, photo_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [session.orgId, settlement.id, input.leaseId, next.line_no, input.kind, amount, item || null, photos],
    );
    await recomputeSettlement(client, session.orgId, settlement.id);
    return { leaseId: input.leaseId };
  }, scopeOf(session));
}

export async function removeDeduction(session: Session, input: { leaseId: string; lineId: string }) {
  assertStaff(session, ["admin", "manager"]);
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const settlement = await maybe<{ id: string; status: string }>(
      client,
      `SELECT id::text, status FROM lease_settlements WHERE lease_id = $1 AND org_id = $2 FOR UPDATE`,
      [input.leaseId, session.orgId],
    );
    if (!settlement || settlement.status !== "draft") throw new FlowError("errors.alreadyClosed");
    const removed = await client.query(
      `DELETE FROM lease_settlement_lines
        WHERE id = $1 AND settlement_id = $2 AND org_id = $3 AND kind <> 'unpaid_rent'`,
      [input.lineId, settlement.id, session.orgId],
    );
    if (removed.rowCount !== 1) throw new FlowError("errors.notFound");
    await recomputeSettlement(client, session.orgId, settlement.id);
    return { leaseId: input.leaseId };
  }, scopeOf(session));
}

export async function confirmSettlement(session: Session, input: { leaseId: string; refundOn: string }) {
  assertStaff(session, ["admin", "manager"]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.refundOn)) throw new FlowError("errors.date");
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settle:${input.leaseId}`]);
    const settlement = await maybe<{ id: string; status: string; move_out_on: string; end_reason: string }>(
      client,
      `SELECT s.id::text, s.status, m.move_out_on::text, m.end_reason
         FROM lease_settlements s
         JOIN lease_moveouts m ON m.id = s.moveout_id
        WHERE s.lease_id = $1 AND s.org_id = $2
        FOR UPDATE OF s`,
      [input.leaseId, session.orgId],
    );
    if (!settlement || settlement.status !== "draft") throw new FlowError("errors.alreadyClosed");
    const lease = await maybe<{ start_date: string; status: string }>(
      client,
      `SELECT start_date::text, status::text FROM leases WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [input.leaseId, session.orgId],
    );
    if (!lease || lease.status !== "active") throw new FlowError("errors.alreadyClosed");
    if (!moveOutDateOk(lease.start_date, settlement.move_out_on)) throw new FlowError("errors.moveOutDate");
    await client.query(
      `UPDATE lease_settlements
          SET status = 'confirmed', refund_on = $3::date, confirmed_at = now()
        WHERE id = $1 AND org_id = $2 AND status = 'draft'`,
      [settlement.id, session.orgId, input.refundOn],
    );
    await client.query(
      `UPDATE lease_moveouts SET status = 'settled' WHERE lease_id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId],
    );
    const closed = await client.query(
      `UPDATE leases
          SET status = 'ended',
              end_date = $3::date,
              terminated_on = $3::date,
              termination_reason = $4,
              end_reason = $4,
              moveout_on = $3::date,
              deposit_settled_at = coalesce(deposit_settled_at, now()),
              updated_at = now()
        WHERE id = $1 AND org_id = $2 AND status = 'active'`,
      [input.leaseId, session.orgId, settlement.move_out_on, settlement.end_reason],
    );
    if (closed.rowCount !== 1) throw new FlowError("errors.alreadyClosed");
    const stored = await one<{ end_date: string | null }>(
      client,
      `SELECT end_date::text FROM leases WHERE id = $1 AND org_id = $2`,
      [input.leaseId, session.orgId],
    );
    if (!stored.end_date) throw new FlowError("errors.moveOutDate");
    return { leaseId: input.leaseId, endDate: stored.end_date };
  }, scopeOf(session));
}

export async function cancelLease(session: Session, leaseId: string) {
  assertStaff(session, ["admin", "manager"]);
  const today = taipeiToday();
  return tx(session.userId, async (client) => {
    await assertLifecycle(client, session.orgId);
    const lease = await maybe<{ status: string; start_date: string }>(
      client,
      `SELECT status::text, start_date::text FROM leases WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [leaseId, session.orgId],
    );
    if (!lease) throw new FlowError("errors.notFound");
    if (lease.status !== "draft" && lease.status !== "pending_signature") throw new FlowError("errors.alreadyClosed");
    const endDate = today < lease.start_date ? lease.start_date : today;
    await client.query(
      `UPDATE leases
          SET status = 'cancelled', end_date = $3::date, terminated_on = $3::date, termination_reason = 'cancelled', updated_at = now()
        WHERE id = $1 AND org_id = $2 AND status IN ('draft','pending_signature')`,
      [leaseId, session.orgId, endDate],
    );
    const stored = await one<{ end_date: string | null }>(
      client,
      `SELECT end_date::text FROM leases WHERE id = $1 AND org_id = $2`,
      [leaseId, session.orgId],
    );
    if (!stored.end_date) throw new FlowError("errors.moveOutDate");
    return { leaseId, endDate: stored.end_date };
  }, scopeOf(session));
}
