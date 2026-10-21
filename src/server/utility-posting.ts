import type { Client } from "pg";
import { maybe, many, one, tx } from "./db";
import { FlowError } from "./errors";
import { inclusiveDays, monthBounds, taipeiToday, toMinor } from "./money";
import { assertStaff, type Session } from "./types";
import {
  allocateUtilityMinor,
  billMinorCeil,
  chargedRateExceedsBill,
  isPostableMethod,
  kwhMilli,
  normalizeRateMajor,
  prorateMilli,
  rateMajorFromStored,
  rateMinorText,
  spreadCommonMilli,
  usageMilliFromText,
  utilityLineDescription,
} from "./utility-post";

/**
 * One request, one transaction, one unit. The worker only rounds the rooms in front of it
 * and lets Postgres post the invoice line. Nothing here scans the firm or waits on a job.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_PAGE = 48;
const MAX_READINGS = 100;
const MAX_BILL_MAJOR = 1_000_000_000;

type SpaceRow = {
  space_id: string;
  label: string;
  method: string | null;
};

type Occupant = {
  leaseId: string;
  contactId: string;
  tenant: string;
  days: number;
};

type Share = {
  spaceId: string;
  label: string;
  leaseId: string;
  contactId: string;
  roomId: string | null;
  method: "submeter" | "by_reading";
  rawMilli: number;
  kwhMilli: number;
  amountMinor: number;
  days: number;
};

export type UtilityRunInput = {
  unitId: string;
  periodStart: string;
  periodEnd: string;
  rateMajor: number;
  totalKwh: number | null;
  readings: { spaceId: string; kwh: number }[];
  billTotalMajor: number | null;
  overrideReason: string;
};

function scope(session: Session) {
  return { orgId: session.orgId, environment: session.environment };
}

function milliText(milli: number) {
  const abs = Math.abs(milli);
  return `${milli < 0 ? "-" : ""}${Math.trunc(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

function assertPeriod(start: string, end: string) {
  if (!DATE.test(start) || !DATE.test(end) || end <= start) throw new FlowError("errors.required", { field: "i_period" });
}

function uniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

export function currentUtilityPeriod(today = taipeiToday()) {
  return monthBounds(today.slice(0, 7));
}

export async function listUtilityBoard(session: Session, periodStart: string, periodEnd: string, page = 1) {
  assertPeriod(periodStart, periodEnd);
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  return tx(session.userId, async (client) => {
    const spaces = await many<{
      unit_id: string;
      property_name: string;
      unit_label: string;
      currency: string;
      space_id: string;
      space_label: string;
      method: string | null;
      rate: string | null;
      lease_id: string | null;
      tenant: string | null;
    }>(
      client,
      `SELECT u.id::text AS unit_id, p.name AS property_name, u.label AS unit_label, p.currency,
              coalesce(r.id::text, u.id::text) AS space_id,
              CASE WHEN r.id IS NULL THEN u.label ELSE r.label END AS space_label,
              coalesce(r.electricity_method, u.electricity_method) AS method,
              coalesce(r.rate_per_kwh, u.rate_per_kwh)::text AS rate,
              lease.id::text AS lease_id, lease.tenant
         FROM units u
         JOIN properties p ON p.id = u.property_id
         LEFT JOIN rooms r ON r.unit_id = u.id AND r.archived_at IS NULL AND u.rental_mode = 'by_room'
         JOIN LATERAL (
           SELECT l.id, c.display_name AS tenant
             FROM leases l
             JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
             JOIN contacts c ON c.id = lp.contact_id
            WHERE l.org_id = u.org_id
              AND l.status IN ('pending_signature','active')
              AND l.start_date <= $3::date
              AND coalesce(l.end_date, DATE '9999-12-31') >= $2::date
              AND ((r.id IS NOT NULL AND l.target_room_id = r.id) OR (r.id IS NULL AND l.target_unit_id = u.id))
            ORDER BY l.start_date DESC
            LIMIT 1
         ) lease ON true
        WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
          AND (u.rental_mode = 'whole_unit' OR r.id IS NOT NULL)
          AND coalesce(r.electricity_method, u.electricity_method) IN ('submeter', 'by_reading')
        ORDER BY p.name, u.label, space_label
        LIMIT $4 OFFSET $5`,
      [session.orgId, periodStart, periodEnd, BOARD_PAGE + 1, (safePage - 1) * BOARD_PAGE],
    );
    const runs = await many<{
      id: string;
      status: string;
      period_start: string;
      period_end: string;
      unit_label: string;
      property_name: string;
      total: string;
      usage: string;
    }>(
      client,
      `SELECT r.id::text, r.status::text, r.period_start::text, r.period_end::text,
              u.label AS unit_label, p.name AS property_name,
              r.total_amount_minor::text AS total, r.total_usage::text AS usage
         FROM utility_allocation_runs r
         JOIN meters m ON m.id = r.meter_id
         JOIN units u ON u.id = m.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE r.org_id = $1
        ORDER BY r.computed_at DESC
        LIMIT 20`,
      [session.orgId],
    );
    return {
      spaces: spaces.slice(0, BOARD_PAGE),
      runs,
      page: safePage,
      hasMore: spaces.length > BOARD_PAGE,
    };
  }, scope(session));
}

export async function utilityRunDetail(session: Session, runId: string) {
  return tx(session.userId, async (client) => loadRun(client, session.orgId, runId), scope(session));
}

async function loadRun(client: Client, orgId: string, runId: string) {
  const run = await maybe<{
    id: string;
    status: string;
    unit_id: string;
    property_name: string;
    unit_label: string;
    currency: string;
    period_start: string;
    period_end: string;
    rate: string;
    usage: string;
    total: string;
    void_reason: string | null;
  }>(
    client,
    `SELECT r.id::text, r.status::text, u.id::text AS unit_id, p.name AS property_name, u.label AS unit_label,
            r.currency, r.period_start::text, r.period_end::text,
            r.rate_minor_per_unit::text AS rate, r.total_usage::text AS usage, r.total_amount_minor::text AS total,
            r.void_reason
       FROM utility_allocation_runs r
       JOIN meters m ON m.id = r.meter_id
       JOIN units u ON u.id = m.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE r.id = $1 AND r.org_id = $2`,
    [runId, orgId],
  );
  if (!run) return null;
  const lines = await many<{
    id: string;
    lease_id: string | null;
    room_id: string | null;
    space_label: string;
    tenant: string | null;
    usage: string;
    amount: string;
    posted_amount: string | null;
    method: string | null;
  }>(
    client,
    `SELECT l.id::text, l.lease_id::text, l.room_id::text, coalesce(room.label, u.label) AS space_label,
            c.display_name AS tenant, l.allocated_usage::text AS usage, l.amount_minor::text AS amount,
            l.posted_amount_minor::text AS posted_amount,
            coalesce(room.electricity_method, u.electricity_method) AS method
       FROM utility_allocation_lines l
       JOIN utility_allocation_runs r ON r.id = l.run_id
       JOIN meters m ON m.id = r.meter_id
       JOIN units u ON u.id = m.unit_id
       LEFT JOIN rooms room ON room.id = l.room_id
       LEFT JOIN contacts c ON c.id = (
         SELECT lp.contact_id FROM lease_parties lp WHERE lp.lease_id = l.lease_id AND lp.role = 'primary' LIMIT 1
       )
      WHERE l.run_id = $1
      ORDER BY space_label`,
    [runId],
  );
  const rateMajor = rateMajorFromStored(run.rate);
  return {
    run,
    rateMajor,
    lines: lines.map((line) => ({
      ...line,
      description: utilityLineDescription(usageMilliFromText(line.usage), rateMajor),
    })),
  };
}

export async function prepareUtilityRun(session: Session, input: UtilityRunInput) {
  assertStaff(session, ["admin", "manager"]);
  assertPeriod(input.periodStart, input.periodEnd);
  const rateMajor = normalizeRateMajor(input.rateMajor);
  if (!input.unitId || rateMajor == null) throw new FlowError("errors.amount", { field: "i_rate" });
  if (input.readings.length > MAX_READINGS) throw new FlowError("errors.amount", { field: "i_usage" });
  const readingBySpace = new Map<string, number>();
  for (const reading of input.readings) {
    if (!Number.isFinite(reading.kwh) || reading.kwh < 0 || reading.kwh > 1_000_000) {
      throw new FlowError("errors.amount", { field: "i_usage" });
    }
    readingBySpace.set(reading.spaceId, reading.kwh);
  }
  if (input.totalKwh != null && (!Number.isFinite(input.totalKwh) || input.totalKwh < 0 || input.totalKwh > 1_000_000)) {
    throw new FlowError("errors.amount", { field: "i_usage" });
  }
  if (input.billTotalMajor != null && (!Number.isFinite(input.billTotalMajor) || input.billTotalMajor < 0 || input.billTotalMajor > MAX_BILL_MAJOR)) {
    throw new FlowError("errors.amount", { field: "i_bill_total" });
  }

  return tx(session.userId, async (client) => {
    const unit = await maybe<{
      id: string;
      property_id: string;
      label: string;
      rental_mode: string;
      method: string | null;
      currency: string;
    }>(
      client,
      `SELECT u.id::text, u.property_id::text, u.label, u.rental_mode::text, u.electricity_method AS method, p.currency
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1 AND u.org_id = $2 AND u.archived_at IS NULL`,
      [input.unitId, session.orgId],
    );
    if (!unit) throw new FlowError("errors.notFound");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      session.orgId,
      `${unit.id}|${input.periodStart}|${input.periodEnd}`,
    ]);
    const spaces = await loadSpaces(client, unit);
    const occupants = await loadOccupants(client, session.orgId, unit.id, input.periodStart, input.periodEnd);
    const occupied = spaces
      .filter((space) => isPostableMethod(space.method))
      .map((space) => ({ space, people: occupants.get(space.space_id) ?? [] }))
      .filter((row) => row.people.length > 0);
    if (occupied.length === 0) throw new FlowError("errors.utilityMethod");

    const submeter = occupied.filter((row) => row.space.method === "submeter");
    const byReading = occupied.filter((row) => row.space.method === "by_reading");
    const rawOf = (space: SpaceRow) => kwhMilli(readingBySpace.get(space.space_id) ?? 0);
    if ([...submeter, ...byReading].some((row) => Number.isNaN(rawOf(row.space)))) {
      throw new FlowError("errors.amount", { field: "i_usage" });
    }
    const subRaw = submeter.map((row) => ({ key: row.space.space_id, kwhMilli: rawOf(row.space) }));
    const subSum = subRaw.reduce((total, part) => total + part.kwhMilli, 0);
    const subTotal = input.totalKwh == null ? subSum : kwhMilli(input.totalKwh);
    if (Number.isNaN(subTotal) || (submeter.length > 0 && subTotal < subSum)) throw new FlowError("errors.meter");
    const spread = submeter.length ? spreadCommonMilli(subRaw, subTotal) : [];
    if (submeter.length && !spread) throw new FlowError("errors.meter");
    const spreadBySpace = new Map((spread ?? []).map((part) => [part.key, part.kwhMilli]));

    const expanded: {
      key: string;
      space: SpaceRow;
      person: Occupant;
      method: "submeter" | "by_reading";
      rawMilli: number;
      kwhMilli: number;
    }[] = [];
    const pushShares = (
      rows: { space: SpaceRow; people: Occupant[] }[],
      method: "submeter" | "by_reading",
      milliFor: (spaceId: string, rawMilli: number) => number,
    ) => {
      for (const row of rows) {
        const rawMilli = rawOf(row.space);
        const milli = milliFor(row.space.space_id, rawMilli);
        const parts = row.people.map((person) => ({ key: person.leaseId, days: person.days }));
        const split = prorateMilli(parts, milli);
        if (!split) throw new FlowError("errors.meter");
        for (const part of split) {
          const person = row.people.find((item) => item.leaseId === part.key);
          if (!person) continue;
          expanded.push({
            key: `${row.space.space_id}:${person.leaseId}`,
            space: row.space,
            person,
            method,
            rawMilli,
            kwhMilli: part.kwhMilli,
          });
        }
      }
    };
    pushShares(submeter, "submeter", (spaceId) => spreadBySpace.get(spaceId) ?? 0);
    pushShares(byReading, "by_reading", (_spaceId, rawMilli) => rawMilli);

    const splitShares = allocateUtilityMinor({
      currency: unit.currency,
      rateMajor,
      mode: "split",
      parts: expanded.filter((row) => row.method === "submeter").map((row) => ({ key: row.key, kwhMilli: row.kwhMilli })),
    });
    const eachShares = allocateUtilityMinor({
      currency: unit.currency,
      rateMajor,
      mode: "each",
      parts: expanded.filter((row) => row.method === "by_reading").map((row) => ({ key: row.key, kwhMilli: row.kwhMilli })),
    });
    const byKey = new Map(expanded.map((row) => [row.key, row]));
    const shares: Share[] = [...splitShares, ...eachShares].map((share) => {
      const row = byKey.get(share.key)!;
      return {
        spaceId: row.space.space_id,
        label: row.space.label,
        leaseId: row.person.leaseId,
        contactId: row.person.contactId,
        roomId: row.space.space_id === unit.id ? null : row.space.space_id,
        method: row.method,
        rawMilli: row.rawMilli,
        kwhMilli: share.kwhMilli,
        amountMinor: share.amountMinor,
        days: row.person.days,
      };
    });
    const usageMilli = (submeter.length ? subTotal : 0) + byReading.reduce((total, row) => total + rawOf(row.space), 0);
    if (
      shares.some((share) => !Number.isSafeInteger(share.amountMinor) || !Number.isSafeInteger(share.kwhMilli)) ||
      (unit.currency === "TWD" && shares.some((share) => share.amountMinor % 100 !== 0))
    ) {
      throw new FlowError("errors.amount");
    }

    const meterSplit = submeter.length ? "sub_meter" : "none";
    const ratePerUnit = rateMinorText(rateMajor);
    let meter = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM meters
        WHERE unit_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [unit.id],
    );
    if (!meter) {
      meter = await one<{ id: string }>(
        client,
        `INSERT INTO meters (
           org_id, property_id, unit_id, utility, usage_unit, label, payer, split_method, rate_source, rate_minor_per_unit
         ) VALUES ($1,$2,$3,'electricity','kWh','main','tenant',$4::split_method,'fixed_rate',$5)
         ON CONFLICT (unit_id) WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
         DO UPDATE SET split_method = EXCLUDED.split_method, rate_source = 'fixed_rate', rate_minor_per_unit = EXCLUDED.rate_minor_per_unit
         RETURNING id::text`,
        [session.orgId, unit.property_id, unit.id, meterSplit, ratePerUnit],
      );
    } else {
      await client.query(
        `UPDATE meters SET split_method = $2::split_method, rate_source = 'fixed_rate', rate_minor_per_unit = $3 WHERE id = $1`,
        [meter.id, meterSplit, ratePerUnit],
      );
    }

    const existing = await maybe<{ id: string; status: string; utility_bill_id: string | null }>(
      client,
      `SELECT id::text, status::text, utility_bill_id::text
         FROM utility_allocation_runs
        WHERE meter_id = $1 AND period_start = $2::date AND period_end = $3::date AND status <> 'void'
        ORDER BY computed_at DESC
        LIMIT 1
        FOR UPDATE`,
      [meter.id, input.periodStart, input.periodEnd],
    );
    if (usageMilli <= 0 && !existing) throw new FlowError("errors.amount", { field: "i_usage" });

    let billId = existing?.utility_bill_id ?? null;
    let exceeds = false;
    if (usageMilli > 0) {
      const synthetic = billMinorCeil(usageMilli, rateMajor);
      const billMinor = input.billTotalMajor == null ? synthetic : toMinor(input.billTotalMajor);
      if (!Number.isSafeInteger(billMinor) || billMinor < 0) throw new FlowError("errors.amount", { field: "i_bill_total" });
      const usageKwh = milliText(usageMilli);
      exceeds = chargedRateExceedsBill(usageMilli, rateMajor, billMinor);
      if (exceeds && !input.overrideReason.trim()) throw new FlowError("errors.capReason");
      const saved = await one<{ id: string }>(
        client,
        `INSERT INTO utility_bills (
           org_id, meter_id, provider, period_start, period_end, currency, total_amount_minor, total_usage, entered_by
         ) VALUES ($1,$2,'meter',$3::date,$4::date,$5,$6,$7,$8)
         ON CONFLICT (meter_id, period_start, period_end) DO UPDATE
           SET total_amount_minor = EXCLUDED.total_amount_minor,
               total_usage = EXCLUDED.total_usage
         RETURNING id::text`,
        [session.orgId, meter.id, input.periodStart, input.periodEnd, unit.currency, billMinor, usageKwh, session.userId],
      );
      billId = saved.id;
    }

    const totalMinor = shares.reduce((total, share) => total + share.amountMinor, 0);
    if (!Number.isSafeInteger(totalMinor)) throw new FlowError("errors.amount");
    const commonMilli = submeter.length ? Math.max(0, subTotal - subSum) : 0;
    const inputs = {
      version: "whole-ntd-v1",
      rate: rateMajor,
      totalKwh: usageMilli / 1000,
      readings: shares.map((share) => ({
        spaceId: share.spaceId,
        kwh: share.rawMilli / 1000,
        method: share.method,
        leaseId: share.leaseId,
        days: share.days,
      })),
    };
    if (exceeds) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [input.overrideReason.trim()]);
    const runId = existing
      ? existing.id
      : (
          await one<{ id: string }>(
            client,
            `INSERT INTO utility_allocation_runs (
               org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
               total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
               cap_override_reason, cap_overridden_by, total_amount_minor, inputs, algorithm_version, status, computed_by
             ) VALUES (
               $1,$2,$3,$4::date,$5::date,$6::split_method,'fixed_rate',$7,
               $8,$9,'split_evenly',$10,$11,$12,$13,$14::jsonb,'whole-ntd-v1','draft',$15
             ) RETURNING id::text`,
            [
              session.orgId,
              meter.id,
              billId,
              input.periodStart,
              input.periodEnd,
              meterSplit,
              unit.currency,
              milliText(usageMilli),
              milliText(commonMilli),
              ratePerUnit,
              exceeds ? input.overrideReason.trim() : null,
              exceeds ? session.userId : null,
              totalMinor,
              JSON.stringify(inputs),
              session.userId,
            ],
          )
        ).id;
    if (existing) {
      await client.query(
        `UPDATE utility_allocation_runs SET
           utility_bill_id = $2, split_method = $3::split_method, rate_source = 'fixed_rate', currency = $4,
           total_usage = $5, common_area_usage = $6, rate_minor_per_unit = $7,
           cap_override_reason = $8, cap_overridden_by = $9,
           total_amount_minor = $10, inputs = $11::jsonb, algorithm_version = 'whole-ntd-v1',
           status = CASE WHEN status IN ('posted', 'approved') THEN status ELSE 'draft' END,
           computed_by = $12, computed_at = now()
         WHERE id = $1`,
        [
          runId,
          billId,
          meterSplit,
          unit.currency,
          milliText(usageMilli),
          milliText(commonMilli),
          ratePerUnit,
          exceeds ? input.overrideReason.trim() : null,
          exceeds ? session.userId : null,
          totalMinor,
          JSON.stringify(inputs),
          session.userId,
        ],
      );
    }

    const prior = await many<{ id: string; lease_id: string | null; room_id: string | null; posted_ledger_transaction_id: string | null }>(
      client,
      `SELECT id::text, lease_id::text, room_id::text, posted_ledger_transaction_id::text
         FROM utility_allocation_lines WHERE run_id = $1`,
      [runId],
    );
    const kept = new Set<string>();
    for (const share of shares) {
      const found = prior.find((row) => row.lease_id === share.leaseId && (row.room_id ?? null) === share.roomId);
      const ratio = totalMinor > 0 ? Math.min(1, Math.max(0, share.amountMinor / totalMinor)) : 0;
      const explanation = {
        kwh: share.kwhMilli / 1000,
        rate_minor_per_unit: Number(ratePerUnit),
        method: share.method,
        room: share.label,
        days: share.days,
      };
      if (found) {
        kept.add(found.id);
        await client.query(
          `UPDATE utility_allocation_lines SET
             days_occupied = $2, sub_meter_usage = $3, share_ratio = $4,
             allocated_usage = $5, amount_minor = $6, bearer = 'tenant', explanation = $7::jsonb
           WHERE id = $1`,
          [
            found.id,
            share.days,
            share.method === "submeter" ? milliText(share.rawMilli) : null,
            ratio.toFixed(10),
            milliText(share.kwhMilli),
            share.amountMinor,
            JSON.stringify(explanation),
          ],
        );
      } else {
        await client.query(
          `INSERT INTO utility_allocation_lines (
             org_id, run_id, lease_id, room_id, days_occupied, sub_meter_usage, share_ratio, allocated_usage, amount_minor, bearer, explanation
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tenant',$10::jsonb)`,
          [
            session.orgId,
            runId,
            share.leaseId,
            share.roomId,
            share.days,
            share.method === "submeter" ? milliText(share.rawMilli) : null,
            ratio.toFixed(10),
            milliText(share.kwhMilli),
            share.amountMinor,
            JSON.stringify(explanation),
          ],
        );
      }
    }
    for (const row of prior) {
      if (kept.has(row.id)) continue;
      if (row.posted_ledger_transaction_id) {
        await client.query(
          `UPDATE utility_allocation_lines SET amount_minor = 0, allocated_usage = 0, share_ratio = 0 WHERE id = $1`,
          [row.id],
        );
      } else {
        await client.query(`DELETE FROM utility_allocation_lines WHERE id = $1`, [row.id]);
      }
    }
    return { runId };
  }, scope(session));
}

type PostedLine = {
  id: string;
  lease_id: string | null;
  amount_minor: string;
  allocated_usage: string;
  bearer: string;
  posted_amount_minor: string | null;
  posted_invoice_id: string | null;
  posted_invoice_line_id: string | null;
  posted_ledger_transaction_id: string | null;
  posted_description: string | null;
  method: string | null;
  currency: string | null;
  property_id: string | null;
  contact_id: string | null;
  period_start: string;
  period_end: string;
  rate: string;
};

const POSTED_LINE_SQL = `SELECT l.id::text, l.lease_id::text, l.amount_minor::text, l.allocated_usage::text, l.bearer::text,
            l.posted_amount_minor::text, l.posted_invoice_id::text, l.posted_invoice_line_id::text,
            l.posted_ledger_transaction_id::text, l.posted_description,
            coalesce(room.electricity_method, u.electricity_method) AS method,
            ls.currency, ls.property_id::text, lp.contact_id::text,
            r.period_start::text, r.period_end::text, r.rate_minor_per_unit::text AS rate
       FROM utility_allocation_lines l
       JOIN utility_allocation_runs r ON r.id = l.run_id
       JOIN meters m ON m.id = r.meter_id
       JOIN units u ON u.id = m.unit_id
       LEFT JOIN rooms room ON room.id = l.room_id
       LEFT JOIN leases ls ON ls.id = l.lease_id
       LEFT JOIN lease_parties lp ON lp.lease_id = l.lease_id AND lp.role = 'primary'`;

export async function confirmUtilityRun(session: Session, runId: string) {
  assertStaff(session, ["admin", "manager"]);
  if (!runId) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`utility-post:${runId}`]);
    const run = await maybe<{ id: string; status: string; utility_bill_id: string | null }>(
      client,
      `SELECT id::text, status::text, utility_bill_id::text
         FROM utility_allocation_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [runId, session.orgId],
    );
    if (!run) throw new FlowError("errors.notFound");
    if (run.status === "void") throw new FlowError("errors.utilityState");
    if (!run.utility_bill_id) throw new FlowError("errors.amount", { field: "i_usage" });
    await client.query(`SELECT set_config('app.change_reason', '確認電費入帳', true)`);
    const lines = await many<PostedLine>(client, `${POSTED_LINE_SQL} WHERE l.run_id = $1 ORDER BY l.id`, [runId]);
    let changed = 0;
    let reversed = 0;
    for (const line of lines) {
      const rateMajor = rateMajorFromStored(line.rate);
      const description = utilityLineDescription(usageMilliFromText(line.allocated_usage), rateMajor);
      const postable = Boolean(line.lease_id) && line.bearer === "tenant" && isPostableMethod(line.method);
      const desired = postable ? Number(line.amount_minor) : 0;
      if (!Number.isSafeInteger(desired) || desired < 0) throw new FlowError("errors.amount");
      const postedLineId = line.posted_invoice_line_id;
      const same =
        Boolean(line.posted_ledger_transaction_id) &&
        postedLineId != null &&
        Number(line.posted_amount_minor) === desired &&
        line.posted_description === description &&
        desired > 0 &&
        (await invoiceLineExists(client, postedLineId));
      if (same) continue;
      if (desired > 0 && (!line.contact_id || !line.property_id || !line.currency || !line.lease_id)) {
        throw new FlowError("errors.notFound");
      }
      let target: { invoiceId: string | null; linkAllocation: boolean } = { invoiceId: null, linkAllocation: true };
      if (line.posted_ledger_transaction_id) {
        target = await reversePostedLine(client, session, line, "更正電費入帳");
        reversed += 1;
        changed += 1;
      }
      if (desired > 0 && line.lease_id && line.property_id && line.currency && line.contact_id) {
        await postLine(client, session, line, desired, description, target.invoiceId, target.linkAllocation);
        changed += 1;
      }
    }
    await client.query(
      `UPDATE utility_allocation_runs
          SET status = 'posted', approved_by = $2, approved_at = coalesce(approved_at, now())
        WHERE id = $1`,
      [runId, session.userId],
    );
    if (changed > 0) {
      await client.query(`SELECT app.audit_event($1::uuid, $2, $3::jsonb)`, [
        session.orgId,
        reversed > 0 ? "utility_charge_reposted" : "utility_charge_posted",
        JSON.stringify({ runId, lines: lines.length, reversed }),
      ]);
    }
    return { runId, changed, reversed };
  }, scope(session));
}

export async function voidUtilityRun(session: Session, runId: string, reason: string) {
  assertStaff(session, ["admin", "manager"]);
  const note = reason.trim();
  if (!runId || !note) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`utility-post:${runId}`]);
    const run = await maybe<{ id: string; status: string }>(
      client,
      `SELECT id::text, status::text FROM utility_allocation_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [runId, session.orgId],
    );
    if (!run) throw new FlowError("errors.notFound");
    if (run.status === "void") return { runId, reversed: 0 };
    await client.query(`SELECT set_config('app.change_reason', '作廢電費入帳', true)`);
    const lines = await many<PostedLine>(
      client,
      `${POSTED_LINE_SQL} WHERE l.run_id = $1 AND l.posted_ledger_transaction_id IS NOT NULL`,
      [runId],
    );
    for (const line of lines) await reversePostedLine(client, session, line, "作廢電費入帳");
    await client.query(
      `UPDATE utility_allocation_runs
          SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now()
        WHERE id = $1`,
      [runId, note, session.userId],
    );
    await client.query(`SELECT app.audit_event($1::uuid, $2, $3::jsonb)`, [
      session.orgId,
      "utility_charge_voided",
      JSON.stringify({ runId, reversed: lines.length }),
    ]);
    return { runId, reversed: lines.length };
  }, scope(session));
}

async function loadSpaces(client: Client, unit: { id: string; rental_mode: string; method: string | null }) {
  if (unit.rental_mode === "whole_unit") {
    return many<SpaceRow>(
      client,
      `SELECT u.id::text AS space_id, u.label, u.electricity_method AS method
         FROM units u WHERE u.id = $1`,
      [unit.id],
    );
  }
  return many<SpaceRow>(
    client,
    `SELECT r.id::text AS space_id, r.label, coalesce(r.electricity_method, $2) AS method
       FROM rooms r
      WHERE r.unit_id = $1 AND r.archived_at IS NULL
      ORDER BY r.label`,
    [unit.id, unit.method],
  );
}

async function loadOccupants(client: Client, orgId: string, unitId: string, periodStart: string, periodEnd: string) {
  const rows = await many<{
    space_id: string;
    lease_id: string;
    contact_id: string;
    tenant: string;
    status: string;
    start_date: string;
    end_date: string;
  }>(
    client,
    `SELECT CASE WHEN l.target_room_id IS NULL THEN l.target_unit_id::text ELSE l.target_room_id::text END AS space_id,
            l.id::text AS lease_id, c.id::text AS contact_id, c.display_name AS tenant, l.status::text,
            l.start_date::text, coalesce(l.end_date, DATE '9999-12-31')::text AS end_date
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
      WHERE l.org_id = $1 AND l.unit_id = $2
        AND l.status IN ('pending_signature','active')
        AND l.start_date <= $4::date
        AND coalesce(l.end_date, DATE '9999-12-31') >= $3::date`,
    [orgId, unitId, periodStart, periodEnd],
  );
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.space_id) ?? [];
    list.push(row);
    grouped.set(row.space_id, list);
  }
  const occupants = new Map<string, Occupant[]>();
  for (const [spaceId, list] of grouped) {
    const active = list.filter((row) => row.status === "active");
    const chosen = active.length > 0 ? active : list.filter((row) => row.status === "pending_signature");
    const people = chosen
      .map((row) => ({
        leaseId: row.lease_id,
        contactId: row.contact_id,
        tenant: row.tenant,
        days: inclusiveDays(row.start_date, row.end_date, periodStart, periodEnd),
      }))
      .filter((row) => row.days > 0);
    if (people.length) occupants.set(spaceId, people);
  }
  return occupants;
}

async function invoiceLineExists(client: Client, lineId: string) {
  const row = await maybe<{ id: string }>(client, `SELECT id::text FROM invoice_lines WHERE id = $1`, [lineId]);
  return Boolean(row);
}

async function nextLineNo(client: Client, invoiceId: string) {
  await one<{ id: string }>(client, `SELECT id::text FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  const lineNo = await one<{ n: string }>(
    client,
    `SELECT (coalesce(max(line_no), 0) + 1)::text AS n FROM invoice_lines WHERE invoice_id = $1`,
    [invoiceId],
  );
  return Number(lineNo.n);
}

async function invoiceFrozen(client: Client, invoiceId: string) {
  const row = await maybe<{
    status: string;
    paid_minor: string;
    einvoice_status: string;
    on_statement: boolean;
  }>(
    client,
    `SELECT i.status::text, i.paid_minor::text, i.einvoice_status::text,
            (
              EXISTS (
                SELECT 1
                  FROM payment_allocations a
                  JOIN payments pay ON pay.id = a.payment_id AND pay.status = 'confirmed'
                  JOIN leases l ON l.id = i.lease_id
                  JOIN property_owners po ON po.property_id = l.property_id
                  JOIN owner_statements s ON s.owner_contact_id = po.owner_contact_id
                   AND s.org_id = i.org_id AND s.status = 'issued'
                   AND pay.paid_on >= s.period_start AND pay.paid_on <= s.period_end
                 WHERE a.invoice_id = i.id
              )
              OR EXISTS (
                SELECT 1
                  FROM owner_statement_lines osl
                  JOIN owner_statements s ON s.id = osl.statement_id AND s.status = 'issued'
                 WHERE i.ledger_transaction_id IS NOT NULL
                   AND osl.ledger_transaction_id = i.ledger_transaction_id
              )
            ) AS on_statement
       FROM invoices i
      WHERE i.id = $1
      FOR UPDATE`,
    [invoiceId],
  );
  if (!row) return true;
  const openUnpaid = row.status === "open" && Number(row.paid_minor) === 0 && row.einvoice_status !== "issued" && row.einvoice_status !== "allowance_issued";
  return !openUnpaid || row.on_statement;
}

async function clearReversedPointer(client: Client, invoiceId: string, ledgerId: string) {
  await client.query(
    `UPDATE invoices SET ledger_transaction_id = NULL WHERE id = $1 AND ledger_transaction_id = $2`,
    [invoiceId, ledgerId],
  );
}

async function attachLedger(client: Client, invoiceId: string, ledgerId: string) {
  await client.query(
    `UPDATE invoices SET ledger_transaction_id = $2
      WHERE id = $1
        AND (
          ledger_transaction_id IS NULL
          OR EXISTS (
            SELECT 1 FROM ledger_transactions rev WHERE rev.reverses_transaction_id = invoices.ledger_transaction_id
          )
        )`,
    [invoiceId, ledgerId],
  );
}

async function insertCredit(client: Client, session: Session, invoiceId: string, amountMinor: number, description: string) {
  const lineNo = await nextLineNo(client, invoiceId);
  await client.query(
    `INSERT INTO invoice_lines (
       org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor
     ) VALUES ($1,$2,$3,'credit',$4,1,$5::numeric,$5::bigint)`,
    [session.orgId, invoiceId, lineNo, description, amountMinor],
  );
}

async function reversePostedLine(client: Client, session: Session, line: PostedLine, reason: string) {
  const ledgerId = line.posted_ledger_transaction_id;
  const invoiceLineId = line.posted_invoice_line_id;
  const invoiceId = line.posted_invoice_id;
  if (!ledgerId) return { invoiceId: null as string | null, linkAllocation: true };
  await client.query(
    `UPDATE utility_allocation_lines
        SET posted_invoice_id = NULL, posted_invoice_line_id = NULL, posted_ledger_transaction_id = NULL,
            posted_amount_minor = NULL, posted_description = NULL
      WHERE id = $1`,
    [line.id],
  );
  const creditAmount = -Number(line.posted_amount_minor ?? 0);
  const creditDescription = `沖銷${line.posted_description ?? "電費"}`;
  const frozen = invoiceId ? await invoiceFrozen(client, invoiceId) : true;
  const lineStillThere = invoiceLineId ? await invoiceLineExists(client, invoiceLineId) : false;
  if (!frozen && invoiceId && lineStillThere) {
    await client.query(`UPDATE invoice_lines SET allocation_line_id = NULL WHERE id = $1`, [invoiceLineId]);
  }
  await client.query(`SELECT post_reversal($1::uuid, $2)`, [ledgerId, reason]);
  if (invoiceId) await clearReversedPointer(client, invoiceId, ledgerId);
  if (!frozen && invoiceId && creditAmount < 0) {
    await insertCredit(client, session, invoiceId, creditAmount, creditDescription);
    return { invoiceId, linkAllocation: true };
  }
  if (frozen && creditAmount < 0 && line.lease_id && line.property_id && line.currency && line.contact_id) {
    const created = await createUtilityInvoice(client, session, line);
    await insertCredit(client, session, created, creditAmount, creditDescription);
    return { invoiceId: created, linkAllocation: false };
  }
  return { invoiceId: null as string | null, linkAllocation: !lineStillThere || !frozen };
}

async function postLine(
  client: Client,
  session: Session,
  line: PostedLine,
  amountMinor: number,
  description: string,
  targetInvoiceId: string | null,
  linkAllocation: boolean,
) {
  const invoiceId = targetInvoiceId ?? (await ensureRentInvoice(client, session, line));
  const lineNo = await nextLineNo(client, invoiceId);
  const kwh = Number(line.allocated_usage);
  const rateMinor = Number(line.rate);
  const inserted = await one<{ id: string }>(
    client,
    `INSERT INTO invoice_lines (
       org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor, allocation_line_id
     ) VALUES ($1,$2,$3,'utility',$4,$5,$6,$7,$8)
     RETURNING id::text`,
    [session.orgId, invoiceId, lineNo, description, kwh, rateMinor, amountMinor, linkAllocation ? line.id : null],
  );
  const today = taipeiToday();
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (
       org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by
     ) VALUES ($1,$2,$3,'invoice',$4,$5::date,$6,'utility_allocation_lines',$7,$8)
     RETURNING id::text`,
    [session.orgId, line.property_id, line.lease_id, line.currency, today, description, line.id, session.userId],
  );
  await client.query(
    `INSERT INTO ledger_entries (
       org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo
     ) VALUES
       ($1,$2,'tenant_receivable',$3,$4,$5,$6,$7,$8,'電費'),
       ($1,$2,'other_income',$9,$4,$5,$6,$7,$8,'電費')`,
    [
      session.orgId,
      txn.id,
      amountMinor,
      line.currency,
      line.contact_id,
      line.property_id,
      line.lease_id,
      invoiceId,
      -amountMinor,
    ],
  );
  await attachLedger(client, invoiceId, txn.id);
  await client.query(
    `UPDATE utility_allocation_lines
        SET posted_invoice_id = $2, posted_invoice_line_id = $3, posted_ledger_transaction_id = $4,
            posted_amount_minor = $5, posted_description = $6
      WHERE id = $1`,
    [line.id, invoiceId, inserted.id, txn.id, amountMinor, description],
  );
}

async function ensureRentInvoice(client: Client, session: Session, line: PostedLine) {
  const found = await maybe<{ id: string }>(
    client,
    `SELECT i.id::text FROM invoices i
      WHERE i.org_id = $1 AND i.lease_id = $2
        AND i.status = 'open' AND i.paid_minor = 0
        AND i.einvoice_status NOT IN ('issued', 'allowance_issued')
        AND i.source IN ('recurring', 'utility')
        AND i.period_start <= $4::date AND i.period_end >= $3::date
        AND NOT EXISTS (
          SELECT 1
            FROM payment_allocations a
            JOIN payments pay ON pay.id = a.payment_id AND pay.status = 'confirmed'
            JOIN leases l ON l.id = i.lease_id
            JOIN property_owners po ON po.property_id = l.property_id
            JOIN owner_statements s ON s.owner_contact_id = po.owner_contact_id
             AND s.org_id = i.org_id AND s.status = 'issued'
             AND pay.paid_on >= s.period_start AND pay.paid_on <= s.period_end
           WHERE a.invoice_id = i.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM owner_statement_lines osl
            JOIN owner_statements s ON s.id = osl.statement_id AND s.status = 'issued'
           WHERE i.ledger_transaction_id IS NOT NULL
             AND osl.ledger_transaction_id = i.ledger_transaction_id
        )
      ORDER BY (i.period_start = $3::date AND i.period_end = $4::date) DESC, i.period_start DESC
      LIMIT 1
      FOR UPDATE`,
    [session.orgId, line.lease_id, line.period_start, line.period_end],
  );
  if (found) return found.id;
  return createUtilityInvoice(client, session, line);
}

async function createUtilityInvoice(client: Client, session: Session, line: PostedLine) {
  if (!line.lease_id || !line.property_id || !line.currency || !line.contact_id) throw new FlowError("errors.notFound");
  const today = taipeiToday();
  const ym = `${today.slice(0, 4)}${today.slice(5, 7)}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('invoice-seq'), hashtext($1))`, [session.orgId]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const count = await one<{ n: string }>(client, `SELECT count(*)::text AS n FROM invoices WHERE org_id = $1`, [session.orgId]);
    const number = `INV-${ym}-${String(Number(count.n) + 1 + attempt).padStart(4, "0")}`;
    await client.query("SAVEPOINT utility_invoice");
    try {
      const created = await one<{ id: string }>(
        client,
        `INSERT INTO invoices (
           org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency, issue_date, due_date,
           period_start, period_end, status, source, created_by, einvoice_status
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7::date, GREATEST($8::date, $7::date), $9::date, $8::date, 'open', 'utility', $10, 'not_applicable'
         ) RETURNING id::text`,
        [
          session.orgId,
          line.property_id,
          line.lease_id,
          line.contact_id,
          number,
          line.currency,
          today,
          line.period_end,
          line.period_start,
          session.userId,
        ],
      );
      await client.query("RELEASE SAVEPOINT utility_invoice");
      return created.id;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT utility_invoice");
      if (!uniqueViolation(error)) throw error;
    }
  }
  throw new FlowError("errors.generic");
}
