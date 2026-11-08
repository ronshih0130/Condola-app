import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { requireEffectivePerm } from "./b017-custom-role-governance";
import type { Client } from "pg";
import { admitActiveArchiveAncestry, admitArchiveBatch, lockArchiveAncestry } from "./record-archive-admission";
import { assertCurrentArchiveCaller } from "./record-archive-caller";
import { recordArchiveEnabledFor } from "./record-archive";
import { maybe, many, one, tx } from "./db";
import { FlowError } from "./errors";
import { reserveInvoiceNumbers } from "./invoice-number";
import { inclusiveDays, monthBounds, taipeiToday, toMinor } from "./money";
import { assertStaff, type Session } from "./types";
import { syncVacantOwnerExpense } from "./utility-expense";
import { BILL_GAP_DESCRIPTION, PUBLIC_ELECTRICITY_DESCRIPTION } from "./utility-expense";
import { isUuid } from "./repair-rules";
import {
  allocateUtilityMinor,
  billGapExceedsWarning,
  billGapMinor,
  billMinorCeil,
  billAverageBelowRate,
  evenBillUsageMilli,
  evenSplitMinor,
  isPostableMethod,
  kwhMilli,
  normalizeRateMajor,
  prorateMilli,
  publicKwhMilli,
  rateMajorFromStored,
  rateMinorText,
  signedUsageAmountMinor,
  usageMilliFromText,
  utilityLineDescription,
} from "./utility-post";
import { requireOrgScope } from "./org-guard";

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
  leaseId: string | null;
  contactId: string | null;
  roomId: string | null;
  method: "submeter" | "by_reading" | "even";
  rawMilli: number;
  kwhMilli: number;
  amountMinor: number;
  days: number;
  bearer: "tenant" | "owner";
  previousKwh: number | null;
  currentKwh: number | null;
};

export type UtilityRunInput = {
  unitId: string;
  sourceRunId?: string;
  periodStart: string;
  periodEnd: string;
  rateMajor: number;
  totalKwh: number | null;
  readings: { spaceId: string; kwh: number; previousKwh?: number | null; currentKwh?: number | null }[];
  billTotalMajor: number | null;
  overrideReason: string;
};

function scope(session: Session) { return requireOrgScope(session); }

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

export async function listUtilityBoard(
  session: Session,
  periodStart: string,
  periodEnd: string,
  page = 1,
  pageSize = BOARD_PAGE,
  runPage = 1,
  historyUnit?: string,
) {
  session = await guardEffectiveSession(session, "stmt.view");
  assertPeriod(periodStart, periodEnd);
  if (!Number.isSafeInteger(runPage) || runPage < 1 || runPage > 100000 || (historyUnit !== undefined && !isUuid(historyUnit))) throw new FlowError("errors.notFound");
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safeSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= BOARD_PAGE ? pageSize : BOARD_PAGE;
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "stmt.view", async () => {
    const spaces = await many<{
      unit_id: string;
      property_id: string;
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
      `WITH occupied AS (
         SELECT u.id AS unit_id, p.id::text AS property_id, p.name AS property_name, u.label AS unit_label, p.currency,
                coalesce(r.id, u.id)::text AS space_id,
                CASE WHEN r.id IS NULL THEN u.label ELSE r.label END AS space_label,
                coalesce(r.electricity_method, u.electricity_method) AS method,
                coalesce(r.rate_per_kwh, u.rate_per_kwh)::text AS rate,
                lease.id::text AS lease_id, lease.tenant
           FROM units u
           JOIN properties p ON p.id = u.property_id
           LEFT JOIN rooms r ON r.unit_id = u.id AND r.archived_at IS NULL AND u.rental_mode = 'by_room'
           LEFT JOIN LATERAL (
             SELECT l.id, c.display_name AS tenant
               FROM leases l
               JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
               JOIN contacts c ON c.id = lp.contact_id
              WHERE l.org_id = u.org_id
                AND l.status = 'active'
                AND l.start_date <= $3::date
                AND coalesce(l.end_date, DATE '9999-12-31') >= $2::date
                AND ((r.id IS NOT NULL AND l.target_room_id = r.id) OR (r.id IS NULL AND l.target_unit_id = u.id))
              ORDER BY l.start_date DESC
              LIMIT 1
           ) lease ON true
          WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
            AND (u.rental_mode = 'whole_unit' OR r.id IS NOT NULL)
            AND coalesce(r.electricity_method, u.electricity_method) IN ('submeter', 'by_reading', 'even')
       ),
       ranked_units AS (
         SELECT unit_id, row_number() OVER (ORDER BY property_name, unit_label, unit_id) AS rn
           FROM (SELECT DISTINCT unit_id, property_name, unit_label FROM occupied) units
       )
       SELECT o.unit_id::text, o.property_id, o.property_name, o.unit_label, o.currency,
              o.space_id, o.space_label, o.method, o.rate, o.lease_id, o.tenant
         FROM occupied o
         JOIN ranked_units ru ON ru.unit_id = o.unit_id
        WHERE ru.rn > $5 AND ru.rn <= $5 + $4
        ORDER BY o.property_name, o.unit_label, o.space_label`,
      [session.orgId, periodStart, periodEnd, safeSize + 1, (safePage - 1) * safeSize],
    );
    const runs = await many<{
      id: string;
      status: string;
      period_start: string;
      period_end: string;
      unit_id: string;
      unit_label: string;
      property_name: string;
      total: string;
      usage: string;
    }>(
      client,
      `SELECT r.id::text, r.status::text, r.period_start::text, r.period_end::text,
              u.id::text AS unit_id, u.label AS unit_label, p.name AS property_name,
              r.total_amount_minor::text AS total, r.total_usage::text AS usage
         FROM utility_allocation_runs r
         JOIN meters m ON m.id = r.meter_id
         JOIN units u ON u.id = m.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE r.org_id = $1 AND ($2::uuid IS NULL OR u.id=$2::uuid)
        ORDER BY r.computed_at DESC,r.id DESC
        LIMIT 21 OFFSET $3`,
      [session.orgId, historyUnit ?? null, (runPage-1)*20],
    );
    const unitOrder: string[] = [];
    for (const space of spaces) {
      if (!unitOrder.includes(space.unit_id)) unitOrder.push(space.unit_id);
    }
    const hasMore = unitOrder.length > safeSize;
    const keep = new Set(unitOrder.slice(0, safeSize));
    return {
      spaces: spaces.filter((space) => keep.has(space.unit_id)),
      runs: runs.slice(0,20),
      runPage,
      runHasMore:runs.length>20,
      page: safePage,
      hasMore,
    };
  }), scope(session));
}

export async function utilityRunDetail(session: Session, runId: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "stmt.view", async () => loadRun(client, session.orgId, runId)), scope(session));
}

async function loadRun(client: Client, orgId: string, runId: string) {
  const run = await maybe<{
    id: string;
    status: string;
    unit_id: string;
    property_id: string;
    property_name: string;
    unit_label: string;
    currency: string;
    period_start: string;
    period_end: string;
    rate: string;
    usage: string;
    total: string;
    void_reason: string | null;
    inputs: unknown;
    bill_amount_minor:string|null;
  }>(
    client,
    `SELECT r.id::text, r.status::text, u.id::text AS unit_id, p.id::text AS property_id, p.name AS property_name, u.label AS unit_label,
            r.currency, r.period_start::text, r.period_end::text,
            r.rate_minor_per_unit::text AS rate, r.total_usage::text AS usage, r.total_amount_minor::text AS total,
            r.void_reason, r.inputs,b.total_amount_minor::text AS bill_amount_minor
       FROM utility_allocation_runs r
       JOIN meters m ON m.id = r.meter_id
       JOIN units u ON u.id = m.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN utility_bills b ON b.org_id=r.org_id AND b.id=r.utility_bill_id
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
    bearer: string;
    previous_kwh: string | null;
    current_kwh: string | null;
  }>(
    client,
    `SELECT l.id::text, l.lease_id::text, l.room_id::text, coalesce(room.label, u.label) AS space_label,
            c.display_name AS tenant, l.allocated_usage::text AS usage, l.amount_minor::text AS amount,
            l.posted_amount_minor::text AS posted_amount,
            coalesce(room.electricity_method, u.electricity_method) AS method,
            l.bearer::text AS bearer,
            l.explanation->>'previousKwh' AS previous_kwh,
            l.explanation->>'currentKwh' AS current_kwh
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
  const stored=run.inputs && typeof run.inputs==='object' && !Array.isArray(run.inputs) ? run.inputs as Record<string,unknown> : null;
  const sourceReadings=Array.isArray(stored?.readings)?stored.readings:null;
  const correctionSpaces:Array<{unit_id:string;property_id:string;property_name:string;unit_label:string;currency:string;space_id:string;space_label:string;method:string;rate:string|null;lease_id:string|null;tenant:string|null;kwh:number;previousKwh:number|null;currentKwh:number|null}>=[];
  let correctionAvailable=['posted','pending_repost'].includes(run.status) && Boolean(sourceReadings?.length);
  const seen=new Map<string,string>();
  for(const value of sourceReadings??[]) {
    if(!value||typeof value!=='object'||Array.isArray(value)){correctionAvailable=false;break;}
    const x=value as Record<string,unknown>,spaceId=x.spaceId,method=x.method,kwh=x.kwh,previous=x.previousKwh??null,current=x.currentKwh??null;
    const numeric=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000000;
    if(typeof spaceId!=='string'||!isUuid(spaceId)||!['submeter','by_reading','even'].includes(String(method))||!numeric(kwh)||!(previous===null||numeric(previous))||!(current===null||numeric(current))||((previous===null)!==(current===null))){correctionAvailable=false;break;}
    const signature=JSON.stringify([method,kwh,previous,current]),old=seen.get(spaceId);if(old!==undefined){if(old!==signature)correctionAvailable=false;continue;}seen.set(spaceId,signature);
    const line=lines.find(l=>(l.room_id??run.unit_id)===spaceId);if(!line||line.method!==method){correctionAvailable=false;break;}
    correctionSpaces.push({unit_id:run.unit_id,property_id:run.property_id,property_name:run.property_name,unit_label:run.unit_label,currency:run.currency,space_id:spaceId,space_label:line.space_label,method:String(method),rate:null,lease_id:line.lease_id,tenant:line.tenant,kwh:kwh as number,previousKwh:previous as number|null,currentKwh:current as number|null});
  }
  const total=stored?.totalKwh;
  if(total!==null && total!==undefined && (typeof total!=='number'||!Number.isFinite(total)||total<0||total>1000000))correctionAvailable=false;
  return {
    run,
    rateMajor,
    adjustments: ownerAdjustments(run.inputs),
    correctionAvailable,
    correctionSpaces:correctionAvailable?correctionSpaces:[],
    correctionBillMajor:run.bill_amount_minor===null?null:String(Number(run.bill_amount_minor)/100),
    correctionTotalKwh:typeof total==='number'?total:null,
    lines: lines.map((line) => ({
      ...line,
      description: line.method === "even" ? "電費（平均分攤）" : utilityLineDescription(usageMilliFromText(line.usage), rateMajor),
      previousKwh: readingNumber(line.previous_kwh),
      currentKwh: readingNumber(line.current_kwh),
    })),
  };
}

export async function prepareUtilityRun(session: Session, input: UtilityRunInput) {
  session = await guardEffectiveSession(session, "leases.edit");
  assertStaff(session, ["admin", "manager"], "leases.edit");
  assertPeriod(input.periodStart, input.periodEnd);
  const rateMajor = normalizeRateMajor(input.rateMajor);
  if (!input.unitId || rateMajor == null) throw new FlowError("errors.amount", { field: "i_rate" });
  if (input.readings.length > MAX_READINGS) throw new FlowError("errors.amount", { field: "i_usage" });
  const readingBySpace = new Map<string, { kwh: number; previousKwh: number | null; currentKwh: number | null }>();
  for (const reading of input.readings) {
    if (!Number.isFinite(reading.kwh) || reading.kwh < 0 || reading.kwh > 1_000_000) {
      throw new FlowError("errors.amount", { field: "i_usage" });
    }
    readingBySpace.set(reading.spaceId, {
      kwh: reading.kwh,
      previousKwh: reading.previousKwh ?? null,
      currentKwh: reading.currentKwh ?? null,
    });
  }
  if (input.totalKwh != null && (!Number.isFinite(input.totalKwh) || input.totalKwh < 0 || input.totalKwh > 1_000_000)) {
    throw new FlowError("errors.amount", { field: "i_usage" });
  }
  if (input.billTotalMajor != null && (!Number.isFinite(input.billTotalMajor) || input.billTotalMajor < 0 || input.billTotalMajor > MAX_BILL_MAJOR)) {
    throw new FlowError("errors.amount", { field: "i_bill_total" });
  }

  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
    // A posted run may be corrected using its exact stored unit, period and
    // active main meter. This is financial continuation, not a new run.
    await assertCurrentArchiveCaller(client, session);
    const prior = await maybe<{id:string;meter_id:string}>(client,`SELECT ur.id::text,ur.meter_id::text FROM utility_allocation_runs ur JOIN meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ur.org_id=$1 AND ur.unit_id=$2 AND ur.period_start=$3::date AND ur.period_end=$4::date AND ur.status IN ('posted','pending_repost') AND m.unit_id=$2 AND m.utility='electricity' AND m.room_id IS NULL AND m.archived_at IS NULL ORDER BY ur.computed_at DESC LIMIT 1`,[session.orgId,input.unitId,input.periodStart,input.periodEnd]);
    const ancestry = prior ? await lockArchiveAncestry(client,session.orgId,{kind:'unit',id:input.unitId},false) : await admitActiveArchiveAncestry(client, session.orgId, {kind:"unit",id:input.unitId});
    await assertCurrentArchiveCaller(client, session);
    if (input.sourceRunId && (!isUuid(input.sourceRunId) || input.sourceRunId !== prior?.id)) throw new FlowError('errors.notFound');
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
        WHERE u.id = $1 AND u.org_id = $2 AND (u.archived_at IS NULL OR $3::boolean)`,
      [input.unitId, session.orgId, Boolean(prior)],
    );
    if (!unit || unit.property_id!==ancestry.propertyId) throw new FlowError("errors.notFound");
    const sourceArchived = prior ? (await maybe<{archived:boolean}>(client,`SELECT EXISTS(SELECT 1 FROM utility_allocation_lines al JOIN rooms r ON r.org_id=al.org_id AND r.id=al.room_id WHERE al.org_id=$1 AND al.run_id=$2 AND r.archived_at IS NOT NULL) AS archived`,[session.orgId,prior.id]))?.archived === true : false;
    const archivedCorrection = ancestry.propertyArchived || ancestry.unitArchived || sourceArchived;
    if (archivedCorrection && !await recordArchiveEnabledFor(client,session.orgId)) throw new FlowError('errors.notFound');
    if (archivedCorrection && (!prior || input.sourceRunId !== prior.id)) throw new FlowError('errors.notFound');
    const rooms = unit.rental_mode === 'by_room' ? await many<{id:string}>(client,`SELECT r.id::text FROM rooms r WHERE r.org_id=$1 AND r.unit_id=$2 AND (($4::boolean AND EXISTS(SELECT 1 FROM utility_allocation_lines al WHERE al.org_id=r.org_id AND al.run_id=$3::uuid AND al.room_id=r.id)) OR (NOT $4::boolean AND (r.archived_at IS NULL OR EXISTS(SELECT 1 FROM utility_allocation_lines al WHERE al.org_id=r.org_id AND al.run_id=$3::uuid AND al.room_id=r.id)))) ORDER BY r.id`,[session.orgId,unit.id,prior?.id??null,archivedCorrection]) : [];
    await admitArchiveBatch(client,session.orgId,rooms.map(({id})=>({kind:'room',id})),Boolean(prior));
    await assertCurrentArchiveCaller(client, session);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [session.orgId, unit.id]);
    await assertCurrentArchiveCaller(client, session);
    if(archivedCorrection && prior){
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`utility-post:${prior.id}`]);
      await assertCurrentArchiveCaller(client,session);
        const locked=await maybe<{id:string}>(client,`SELECT id::text FROM utility_allocation_runs WHERE org_id=$1 AND id=$2 AND status='posted' AND currency=$3 AND unit_id=$4 FOR UPDATE`,[session.orgId,prior.id,unit.currency,unit.id]);
      if(!locked)throw new FlowError('errors.notFound');
    }
    if(prior){const same=await maybe<{id:string}>(client,`SELECT ur.id::text FROM utility_allocation_runs ur JOIN meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ur.org_id=$1 AND ur.id=$2 AND ur.unit_id=$3 AND ur.meter_id=$4 AND ur.period_start=$5::date AND ur.period_end=$6::date AND ur.status IN ('posted','pending_repost') AND m.unit_id=$3 AND m.utility='electricity' AND m.room_id IS NULL AND m.archived_at IS NULL`,[session.orgId,prior.id,unit.id,prior.meter_id,input.periodStart,input.periodEnd]);if(!same)throw new FlowError('errors.notFound');
      const shape=await maybe<{n:number;room_lines:number;whole_lines:number;moved:boolean;archived_source:boolean}>(client,`SELECT count(*)::int AS n,count(*) FILTER(WHERE al.room_id IS NOT NULL)::int AS room_lines,count(*) FILTER(WHERE al.room_id IS NULL)::int AS whole_lines,coalesce(bool_or((al.room_id IS NOT NULL AND r.unit_id IS DISTINCT FROM $3::uuid) OR (al.lease_id IS NOT NULL AND l.unit_id IS DISTINCT FROM $3::uuid)),false) AS moved,coalesce(bool_or(r.archived_at IS NOT NULL),false) AS archived_source FROM utility_allocation_lines al LEFT JOIN rooms r ON r.org_id=al.org_id AND r.id=al.room_id LEFT JOIN leases l ON l.org_id=al.org_id AND l.id=al.lease_id WHERE al.org_id=$1 AND al.run_id=$2`,[session.orgId,prior.id,unit.id]);
      if(ancestry.propertyArchived||ancestry.unitArchived||shape?.archived_source) {
        if (!archivedCorrection || input.sourceRunId !== prior.id) throw new FlowError('errors.notFound');
        if(!shape||shape.n===0||shape.moved||(unit.rental_mode==='whole_unit'&&shape.room_lines>0)||(unit.rental_mode==='by_room'&&shape.whole_lines>0))throw new FlowError('errors.notFound');
      }
    }
    await requireEffectivePerm(client, session, "leases.edit");
    const spaces = await loadSpaces(client, unit, prior?.id, archivedCorrection);
    if (unit.rental_mode === 'by_room' && JSON.stringify(spaces.map(s=>s.space_id).sort()) !== JSON.stringify(rooms.map(r=>r.id).sort())) throw new FlowError("errors.notFound");
    const occupants = archivedCorrection && prior
      ? await historicalUtilityOccupants(client,session.orgId,unit,prior.id,spaces)
      : await loadOccupants(client, session.orgId, unit.id, input.periodStart, input.periodEnd);
    const postable = spaces
      .filter((space) => isPostableMethod(space.method))
      .map((space) => ({ space, people: occupants.get(space.space_id) ?? [] }));
    if (postable.length === 0) throw new FlowError("errors.utilityMethod");
    const evenMode = postable.every((row) => row.space.method === "even");
    const meterRows = postable.filter((row) => row.space.method === "submeter" || row.space.method === "by_reading");
    if (!evenMode && meterRows.some((row) => !readingBySpace.has(row.space.space_id))) {
      throw new FlowError("errors.amount", { field: "i_usage" });
    }

    const submeter = postable.filter((row) => row.space.method === "submeter");
    const byReading = postable.filter((row) => row.space.method === "by_reading");
    const rawOf = (space: SpaceRow) => kwhMilli(readingBySpace.get(space.space_id)?.kwh as number);
    if (meterRows.some((row) => Number.isNaN(rawOf(row.space)))) {
      throw new FlowError("errors.amount", { field: "i_usage" });
    }
    const roomSum = meterRows.reduce((total, row) => total + rawOf(row.space), 0);
    const totalMilli = input.totalKwh == null ? roomSum : kwhMilli(input.totalKwh);
    if (Number.isNaN(totalMilli)) throw new FlowError("errors.amount", { field: "i_usage" });
    // PUBLIC_POWER_RULE: owner keeps total kWh − room meters. A negative result is a credit, not a tenant charge.
    const publicMilli = evenMode || input.totalKwh == null ? 0 : publicKwhMilli(totalMilli, roomSum);
    if (Number.isNaN(publicMilli)) throw new FlowError("errors.amount", { field: "i_usage" });

    const expanded: {
      key: string;
      space: SpaceRow;
      leaseId: string | null;
      contactId: string | null;
      method: "submeter" | "by_reading" | "even";
      rawMilli: number;
      kwhMilli: number;
      days: number;
      bearer: "tenant" | "owner";
      previousKwh: number | null;
      currentKwh: number | null;
    }[] = [];
    const pushMeter = (rows: { space: SpaceRow; people: Occupant[] }[], method: "submeter" | "by_reading") => {
      for (const row of rows) {
        const rawMilli = rawOf(row.space);
        const reading = readingBySpace.get(row.space.space_id);
        const ends = {
          previousKwh: reading?.previousKwh ?? null,
          currentKwh: reading?.currentKwh ?? null,
        };
        if (row.people.length === 0) {
          expanded.push({
            key: `${row.space.space_id}:owner`,
            space: row.space,
            leaseId: null,
            contactId: null,
            method,
            rawMilli,
            kwhMilli: rawMilli,
            days: 0,
            bearer: "owner",
            ...ends,
          });
          continue;
        }
        const parts = row.people.map((person) => ({ key: person.leaseId, days: person.days }));
        const split = prorateMilli(parts, rawMilli);
        if (!split) throw new FlowError("errors.meter");
        for (const part of split) {
          const person = row.people.find((item) => item.leaseId === part.key);
          if (!person) continue;
          expanded.push({
            key: `${row.space.space_id}:${person.leaseId}`,
            space: row.space,
            leaseId: person.leaseId,
            contactId: person.contactId,
            method,
            rawMilli,
            kwhMilli: part.kwhMilli,
            days: person.days,
            bearer: "tenant",
            ...ends,
          });
        }
      }
    };
    pushMeter(submeter, "submeter");
    pushMeter(byReading, "by_reading");

    let remainderMinor = 0;
    if (evenMode) {
      if (input.billTotalMajor == null) throw new FlowError("errors.amount", { field: "i_bill_total" });
      const billMinor = toMinor(input.billTotalMajor);
      const split = evenSplitMinor(unit.currency, billMinor, postable.length);
      if (!split) throw new FlowError("errors.amount", { field: "i_bill_total" });
      remainderMinor = split.remainderMinor;
      for (const row of postable) {
        const bearer = row.people.length === 0 ? "owner" : "tenant";
        const person = row.people[0];
        expanded.push({
          key: `${row.space.space_id}:${person?.leaseId ?? "owner"}`,
          space: row.space,
          leaseId: person?.leaseId ?? null,
          contactId: person?.contactId ?? null,
          method: "even",
          rawMilli: 0,
          kwhMilli: 0,
          days: person?.days ?? 0,
          bearer,
          previousKwh: null,
          currentKwh: null,
        });
      }
    }

    const priced = allocateUtilityMinor({
      currency: unit.currency,
      rateMajor,
      mode: "each",
      parts: expanded.filter((row) => row.method !== "even").map((row) => ({ key: row.key, kwhMilli: row.kwhMilli })),
    });
    const priceByKey = new Map(priced.map((row) => [row.key, row.amountMinor]));
    const evenShare = evenMode ? evenSplitMinor(unit.currency, toMinor(input.billTotalMajor ?? 0), postable.length) : null;
    const shares: Share[] = expanded.map((row) => ({
      spaceId: row.space.space_id,
      label: row.space.label,
      leaseId: row.leaseId,
      contactId: row.contactId,
      roomId: row.space.space_id === unit.id ? null : row.space.space_id,
      method: row.method,
      rawMilli: row.rawMilli,
      kwhMilli: row.kwhMilli,
      amountMinor: row.method === "even" ? (evenShare?.shareMinor ?? 0) : (priceByKey.get(row.key) ?? 0),
      days: row.days,
      bearer: row.bearer,
      previousKwh: row.previousKwh,
      currentKwh: row.currentKwh,
    }));
    const usageMilli = evenMode ? totalMilli : roomSum;
    const publicAmountMinor = evenMode ? 0 : signedUsageAmountMinor(unit.currency, rateMajor, publicMilli);
    if (
      shares.some((share) => !Number.isSafeInteger(share.amountMinor) || !Number.isSafeInteger(share.kwhMilli)) ||
      (unit.currency === "TWD" && shares.some((share) => share.amountMinor % 100 !== 0))
    ) {
      throw new FlowError("errors.amount");
    }
    if(archivedCorrection && prior){
      for(const share of shares)if(share.bearer==='tenant' && share.amountMinor===0){
        const source=await maybe<{id:string;posted:boolean}>(client,`SELECT id::text,posted_ledger_transaction_id IS NOT NULL AS posted FROM utility_allocation_lines WHERE org_id=$1 AND run_id=$2 AND lease_id=$3 AND room_id IS NOT DISTINCT FROM $4::uuid`,[session.orgId,prior.id,share.leaseId,share.roomId]);
        if(!source)throw new FlowError('errors.notFound');
        if(source.posted && !await canZeroUtilityPosting(client,session.orgId,source.id))throw new FlowError('errors.notFound');
      }
    }

    const meterSplit = evenMode ? "even" : submeter.length ? "sub_meter" : "none";
    if (!Number.isSafeInteger(publicAmountMinor)) throw new FlowError("errors.amount");
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

    await assertPeriodFree(client, session.orgId, unit.id, meter.id, input.periodStart, input.periodEnd);
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
    if(prior && (!existing || existing.id!==prior.id || meter.id!==prior.meter_id || !['posted','pending_repost'].includes(existing.status)))throw new FlowError('errors.notFound');
    if (usageMilli <= 0 && !evenMode && !existing) throw new FlowError("errors.amount", { field: "i_usage" });
    if (evenMode && usageMilli < 0) throw new FlowError("errors.amount", { field: "i_usage" });

    const enteredBill = input.billTotalMajor == null ? null : toMinor(input.billTotalMajor);
    if (enteredBill != null && (!Number.isSafeInteger(enteredBill) || enteredBill < 0)) {
      throw new FlowError("errors.amount", { field: "i_bill_total" });
    }
    const roomTotal = shares.reduce((total, share) => total + share.amountMinor, 0);
    // BILL_GAP_RULE: meter mode posts bill − (room charges + 公共用電) to the owner.
    // That equals bill − rate×total kWh, with whole-NT$ rounding dust kept on this owner line.
    let gapMinor = 0;
    let gapWarn = false;
    let pureGap = 0;
    if (!evenMode && enteredBill != null && input.totalKwh != null) {
      pureGap = billGapMinor(unit.currency, rateMajor, totalMilli, enteredBill);
      gapMinor = enteredBill - (roomTotal + publicAmountMinor);
      gapWarn = billGapExceedsWarning(enteredBill, pureGap);
    } else if (evenMode && enteredBill != null && input.totalKwh != null) {
      pureGap = billGapMinor(unit.currency, rateMajor, totalMilli, enteredBill);
      gapWarn = billGapExceedsWarning(enteredBill, pureGap);
    }
    if (!Number.isSafeInteger(gapMinor) || !Number.isSafeInteger(pureGap)) throw new FlowError("errors.amount");
    // A blank even-split total still needs a positive bill usage. That figure is not a reading.
    const storedUsageMilli =
      usageMilli > 0 ? usageMilli : evenMode && enteredBill != null ? evenBillUsageMilli(enteredBill, rateMajor) : 0;
    const averageBelow =
      evenMode &&
      enteredBill != null &&
      input.totalKwh == null &&
      billAverageBelowRate(enteredBill, storedUsageMilli, rateMajor);
    // The rate-cap trigger still blocks a line when the rate is above the bill average.
    // A lower bill is the owner credit 「電費（帳單差額）」, so record that reason and continue.
    const capReason = pureGap < 0 || averageBelow ? input.overrideReason.trim() || "帳單低於每度電價，差額記入屋主" : "";

    let billId = existing?.utility_bill_id ?? null;
    const exceeds = capReason !== "";
    if (exceeds) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [capReason]);
    if (storedUsageMilli > 0 && (usageMilli > 0 || enteredBill != null)) {
      const synthetic = usageMilli > 0 ? billMinorCeil(usageMilli, rateMajor) : 0;
      const billMinor = enteredBill ?? synthetic;
      const saved = await one<{ id: string }>(
        client,
        `INSERT INTO utility_bills (
           org_id, meter_id, provider, period_start, period_end, currency, total_amount_minor, total_usage, entered_by
         ) VALUES ($1,$2,'meter',$3::date,$4::date,$5,$6,$7,$8)
         ON CONFLICT (meter_id, period_start, period_end) DO UPDATE
           SET total_amount_minor = EXCLUDED.total_amount_minor,
               total_usage = EXCLUDED.total_usage
         RETURNING id::text`,
        [session.orgId, meter.id, input.periodStart, input.periodEnd, unit.currency, billMinor, milliText(storedUsageMilli), session.userId],
      );
      billId = saved.id;
    }

    const totalMinor = enteredBill ?? roomTotal + Math.max(0, publicAmountMinor);
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new FlowError("errors.amount");
    const commonMilli = publicMilli;
    const inputs = {
      version: "whole-ntd-v2",
      rate: rateMajor,
      totalKwh: evenMode && input.totalKwh == null ? null : totalMilli / 1000,
      publicKwhMilli: publicMilli,
      publicAmountMinor,
      billGapMinor: gapMinor,
      billGapWarn: gapWarn,
      remainderMinor,
      readings: shares.map((share) => ({
        spaceId: share.spaceId,
        kwh: share.rawMilli / 1000,
        method: share.method,
        leaseId: share.leaseId,
        days: share.days,
        previousKwh: share.previousKwh,
        currentKwh: share.currentKwh,
      })),
    };
    const runId = existing
      ? existing.id
      : (
          await one<{ id: string }>(
            client,
            `INSERT INTO utility_allocation_runs (
               org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
               total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
               cap_override_reason, cap_overridden_by, total_amount_minor, inputs, algorithm_version, status, computed_by, unit_id
             ) VALUES (
               $1,$2,$3,$4::date,$5::date,$6::split_method,'fixed_rate',$7,
               $8,$9,'split_evenly',$10,$11,$12,$13,$14::jsonb,'whole-ntd-v1','draft',$15,$16
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
              exceeds ? capReason : null,
              exceeds ? session.userId : null,
              totalMinor,
              JSON.stringify(inputs),
              session.userId,
              unit.id,
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
           status = (CASE WHEN status IN ('posted', 'approved', 'pending_repost') THEN 'pending_repost' ELSE 'draft' END)::allocation_status,
           computed_by = $12, computed_at = now(), unit_id = $13
         WHERE id = $1`,
        [
          runId,
          billId,
          meterSplit,
          unit.currency,
          milliText(usageMilli),
          milliText(commonMilli),
          ratePerUnit,
          exceeds ? capReason : null,
          exceeds ? session.userId : null,
          totalMinor,
          JSON.stringify(inputs),
          session.userId,
          unit.id,
        ],
      );
    }

    await writeShares(client, session.orgId, runId, shares, ratePerUnit, totalMinor);
    await assertCurrentArchiveCaller(client, session);
    return { runId };
  }), scope(session));
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
  session = await guardEffectiveSession(session, "leases.edit");
  assertStaff(session, ["admin", "manager"], "leases.edit");
  if (!runId) throw new FlowError("errors.required");
  const posted = await tx(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`utility-post:${runId}`]);
    const run = await maybe<{ id: string; status: string; utility_bill_id: string | null }>(
      client,
      `SELECT id::text, status::text, utility_bill_id::text
         FROM utility_allocation_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [runId, session.orgId],
    );
    await requireEffectivePerm(client, session, "leases.edit");
    if (!run) throw new FlowError("errors.notFound");
    if (run.status === "void") throw new FlowError("errors.utilityState");
    if (!run.utility_bill_id) throw new FlowError("errors.amount", { field: "i_usage" });
    await verifyArchivedUtilitySubjects(client,session.orgId,runId);
    await assertRunCoversOccupied(client, session.orgId, runId);
    const priorStatus = run.status;
    await client.query(`SELECT set_config('app.change_reason', '確認登記電費', true)`);
    const lines = await many<PostedLine>(client, `${POSTED_LINE_SQL} WHERE l.run_id = $1 ORDER BY l.id`, [runId]);
    const present = await existingInvoiceLineIds(
      client,
      lines.flatMap((line) => (line.posted_invoice_line_id ? [line.posted_invoice_line_id] : [])),
    );
    let changed = 0;
    let reversed = 0;
    const reverses: ReverseJob[] = [];
    const posts: PostJob[] = [];
    for (const line of lines) {
      const rateMajor = rateMajorFromStored(line.rate);
      const description =
        line.method === "even" ? "電費（平均分攤）" : utilityLineDescription(usageMilliFromText(line.allocated_usage), rateMajor);
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
        present.has(postedLineId);
      if (same) continue;
      if (desired > 0 && (!line.contact_id || !line.property_id || !line.currency || !line.lease_id)) {
        throw new FlowError("errors.notFound");
      }
      if (line.posted_ledger_transaction_id) {
        const creditAmount = -Number(line.posted_amount_minor ?? 0);
        if (!Number.isSafeInteger(creditAmount)) throw new FlowError("errors.amount");
        reverses.push({
          lineId: line.id,
          ledgerId: line.posted_ledger_transaction_id,
          invoiceId: line.posted_invoice_id,
          invoiceLineId: line.posted_invoice_line_id,
          creditAmount,
          creditDescription: `沖銷${line.posted_description ?? "電費"}`,
          leaseId: line.lease_id,
          propertyId: line.property_id,
          currency: line.currency?.trim() ?? null,
          contactId: line.contact_id,
          periodStart: line.period_start,
          periodEnd: line.period_end,
        });
        reversed += 1;
        changed += 1;
      }
      if (desired > 0 && line.lease_id && line.property_id && line.currency && line.contact_id) {
        posts.push({
          lineId: line.id,
          leaseId: line.lease_id,
          propertyId: line.property_id,
          currency: line.currency.trim(),
          contactId: line.contact_id,
          periodStart: line.period_start,
          periodEnd: line.period_end,
          amountMinor: desired,
          description,
          quantity: line.allocated_usage,
          rate: line.rate,
          targetInvoiceId: null,
          linkAllocation: true,
        });
        changed += 1;
      }
    }
    const targets = await reversePostedLines(client, session, reverses, "更正已登記電費");
    for (const post of posts) {
      const target = targets.get(post.lineId);
      if (!target) continue;
      post.targetInvoiceId = target.invoiceId;
      post.linkAllocation = target.linkAllocation;
    }
    await postChargeLines(client, session, posts);
    const ownerBase = await ownerExpenseInput(client, session.orgId, runId);
    const adjustments = ownerAdjustments(await runInputs(client, runId));
    const vacantExpense = await syncVacantOwnerExpense(client, session, {
      ...ownerBase,
      amountMinor: ownerBase.amountMinor + adjustments.remainderMinor,
    });
    const publicExpense = await syncVacantOwnerExpense(client, session, {
      ...ownerBase,
      amountMinor: adjustments.publicAmountMinor,
      description: PUBLIC_ELECTRICITY_DESCRIPTION,
    });
    const gapExpense = await syncVacantOwnerExpense(client, session, {
      ...ownerBase,
      amountMinor: adjustments.billGapMinor,
      description: BILL_GAP_DESCRIPTION,
    });
    await verifyArchivedUtilitySubjects(client,session.orgId,runId);
    if (vacantExpense.changed || publicExpense.changed || gapExpense.changed) changed += 1;
    await client.query(`SELECT set_config('app.change_reason', '確認登記電費', true)`);
    await client.query(
      `UPDATE utility_allocation_runs
          SET status = 'posted', approved_by = $2, approved_at = coalesce(approved_at, now())
        WHERE id = $1`,
      [runId, session.userId],
    );
    if (changed > 0 && priorStatus !== "posted") {
      const event = priorStatus === "pending_repost" || reversed > 0 ? "utility_charge_reposted" : "utility_charge_posted";
      await client.query(`SELECT app.audit_event($1::uuid, $2, $3::jsonb)`, [
        session.orgId,
        event,
        JSON.stringify({ runId, lines: lines.length, reversed }),
      ]);
    }
    return { runId, changed, reversed };
  }), scope(session));
  const visible = await tx(
    session.userId,
    async (client) =>
      withEffectiveAuthority(client, session, "leases.edit", async () => maybe<{ status: string }>(
        client,
        `SELECT status::text FROM utility_allocation_runs WHERE id = $1 AND org_id = $2`,
        [runId, session.orgId],
      )),
    scope(session),
  );
  if (visible?.status !== "posted") throw new FlowError("errors.generic");
  return posted;
}

export async function voidUtilityRun(session: Session, runId: string, reason: string) {
  session = await guardEffectiveSession(session, "leases.edit");
  assertStaff(session, ["admin", "manager"], "leases.edit");
  const note = reason.trim();
  if (!runId || !note) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`utility-post:${runId}`]);
    const run = await maybe<{ id: string; status: string }>(
      client,
      `SELECT id::text, status::text FROM utility_allocation_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [runId, session.orgId],
    );
    await requireEffectivePerm(client, session, "leases.edit");
    if (!run) throw new FlowError("errors.notFound");
    if (run.status === "void") return { runId, reversed: 0 };
    await client.query(`SELECT set_config('app.change_reason', '作廢電費登記', true)`);
    const lines = await many<PostedLine>(
      client,
      `${POSTED_LINE_SQL} WHERE l.run_id = $1 AND l.posted_ledger_transaction_id IS NOT NULL`,
      [runId],
    );
    await reversePostedLines(
      client,
      session,
      lines.flatMap((line) => {
        if (!line.posted_ledger_transaction_id) return [];
        const creditAmount = -Number(line.posted_amount_minor ?? 0);
        if (!Number.isSafeInteger(creditAmount)) throw new FlowError("errors.amount");
        return [
          {
            lineId: line.id,
            ledgerId: line.posted_ledger_transaction_id,
            invoiceId: line.posted_invoice_id,
            invoiceLineId: line.posted_invoice_line_id,
            creditAmount,
            creditDescription: `沖銷${line.posted_description ?? "電費"}`,
            leaseId: line.lease_id,
            propertyId: line.property_id,
            currency: line.currency?.trim() ?? null,
            contactId: line.contact_id,
            periodStart: line.period_start,
            periodEnd: line.period_end,
          },
        ];
      }),
      "作廢電費登記",
    );
    const cleared = await ownerExpenseInput(client, session.orgId, runId, 0);
    await syncVacantOwnerExpense(client, session, cleared);
    await syncVacantOwnerExpense(client, session, { ...cleared, description: PUBLIC_ELECTRICITY_DESCRIPTION });
    await syncVacantOwnerExpense(client, session, { ...cleared, description: BILL_GAP_DESCRIPTION });
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
  }), scope(session));
}

async function runInputs(client: Client, runId: string) {
  const row = await maybe<{ inputs: unknown }>(client, `SELECT inputs FROM utility_allocation_runs WHERE id = $1`, [runId]);
  return row?.inputs ?? null;
}

function ownerAdjustments(inputs: unknown) {
  const record = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>) : {};
  const num = (key: string) => {
    const value = record[key];
    return typeof value === "number" && Number.isInteger(value) ? value : 0;
  };
  return {
    publicKwhMilli: num("publicKwhMilli"),
    publicAmountMinor: num("publicAmountMinor"),
    billGapMinor: num("billGapMinor"),
    remainderMinor: num("remainderMinor"),
    billGapWarn: record.billGapWarn === true,
  };
}

function readingNumber(value: string | null) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ownerExpenseInput(client: Client, orgId: string, runId: string, amountOverride?: number) {
  const row = await one<{
    property_id: string;
    unit_id: string;
    currency: string;
    period_end: string;
    owner_minor: string;
  }>(
    client,
    `SELECT u.property_id::text, u.id::text AS unit_id, r.currency, r.period_end::text,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.bearer = 'owner'), 0)::text AS owner_minor
       FROM utility_allocation_runs r
       JOIN units u ON u.id = r.unit_id
       LEFT JOIN utility_allocation_lines l ON l.run_id = r.id
      WHERE r.id = $1 AND r.org_id = $2
      GROUP BY u.property_id, u.id, r.currency, r.period_end`,
    [runId, orgId],
  );
  const amountMinor = amountOverride ?? Number(row.owner_minor);
  return {
    runId,
    propertyId: row.property_id,
    unitId: row.unit_id,
    currency: row.currency,
    incurredOn: row.period_end.slice(0, 10),
    amountMinor,
  };
}

function recordedSpaceIds(inputs: unknown) {
  const readings =
    inputs && typeof inputs === "object" && "readings" in inputs ? (inputs as { readings?: unknown }).readings : null;
  const ids = new Set<string>();
  if (!Array.isArray(readings)) return ids;
  for (const reading of readings) {
    if (!reading || typeof reading !== "object" || !("spaceId" in reading)) continue;
    const spaceId = (reading as { spaceId?: unknown }).spaceId;
    if (typeof spaceId === "string" && spaceId) ids.add(spaceId);
  }
  return ids;
}

async function assertPeriodFree(
  client: Client,
  orgId: string,
  unitId: string,
  meterId: string,
  periodStart: string,
  periodEnd: string,
) {
  const overlap = await maybe<{ id: string }>(
    client,
    `SELECT r.id::text
       FROM utility_allocation_runs r
       JOIN meters m ON m.id = r.meter_id
      WHERE m.unit_id = $1 AND r.org_id = $2 AND r.status <> 'void'
        AND r.period_start <= $4::date AND r.period_end >= $3::date
        AND NOT (r.meter_id = $5 AND r.period_start = $3::date AND r.period_end = $4::date)
      LIMIT 1`,
    [unitId, orgId, periodStart, periodEnd, meterId],
  );
  if (overlap) throw new FlowError("errors.utilityOverlap");
}

async function assertRunCoversOccupied(client: Client, orgId: string, runId: string) {
  const run = await maybe<{
    unit_id: string;
    rental_mode: string;
    method: string | null;
    period_start: string;
    period_end: string;
    inputs: unknown;
    archived_source:boolean;
  }>(
    client,
    `SELECT u.id::text AS unit_id, u.rental_mode::text, u.electricity_method AS method,
            r.period_start::text, r.period_end::text, r.inputs,
            (p.archived_at IS NOT NULL OR u.archived_at IS NOT NULL OR EXISTS(SELECT 1 FROM utility_allocation_lines al JOIN rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id WHERE al.org_id=r.org_id AND al.run_id=r.id AND ar.archived_at IS NOT NULL)) AS archived_source
       FROM utility_allocation_runs r
       JOIN meters m ON m.id = r.meter_id
       JOIN units u ON u.id = m.unit_id
       JOIN properties p ON p.org_id=u.org_id AND p.id=u.property_id
      WHERE r.id = $1 AND r.org_id = $2`,
    [runId, orgId],
  );
  if (!run) throw new FlowError("errors.notFound");
  const spaces = await loadSpaces(client, { id: run.unit_id, rental_mode: run.rental_mode, method: run.method }, runId,run.archived_source);
  const recorded = recordedSpaceIds(run.inputs);
  const postable = spaces.filter((space) => isPostableMethod(space.method));
  if (postable.some((space) => !recorded.has(space.space_id))) {
    throw new FlowError("errors.amount", { field: "i_usage" });
  }
}

async function loadSpaces(client: Client, unit: { id: string; rental_mode: string; method: string | null }, priorRunId?:string, sourceOnly=false) {
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
      WHERE r.unit_id = $1 AND (($4::boolean AND EXISTS (SELECT 1 FROM utility_allocation_lines al WHERE al.org_id=r.org_id AND al.run_id=$3::uuid AND al.room_id=r.id)) OR (NOT $4::boolean AND (r.archived_at IS NULL OR EXISTS (SELECT 1 FROM utility_allocation_lines al WHERE al.org_id=r.org_id AND al.run_id=$3::uuid AND al.room_id=r.id))))
      ORDER BY r.label`,
    [unit.id, unit.method, priorRunId??null,sourceOnly],
  );
}

/** A zero reversal needs unambiguous durable history after live pointers are cleared. */
async function canZeroUtilityPosting(client:Client,orgId:string,lineId:string) {
  const result=await maybe<{ok:boolean}>(client,`SELECT EXISTS(SELECT 1 FROM utility_allocation_lines a JOIN ledger_transactions t ON t.org_id=a.org_id AND t.id=a.posted_ledger_transaction_id JOIN invoices i ON i.org_id=a.org_id AND i.id=a.posted_invoice_id
    WHERE a.org_id=$1 AND a.id=$2 AND a.posted_amount_minor>0
      AND (SELECT count(*) FROM ledger_transactions x WHERE x.org_id=a.org_id AND x.kind='invoice' AND x.source_table='utility_allocation_lines' AND x.source_id=a.id)=1
      AND (SELECT count(*) FROM invoice_lines x WHERE x.org_id=i.org_id AND x.invoice_id=i.id AND x.charge_type='utility' AND x.amount_minor=a.posted_amount_minor AND x.description=a.posted_description)=1
      AND NOT EXISTS(SELECT 1 FROM invoice_lines x WHERE x.org_id=i.org_id AND x.invoice_id=i.id AND x.charge_type='credit' AND x.amount_minor=-a.posted_amount_minor AND x.description='沖銷'||a.posted_description)) AS ok`,[orgId,lineId]);
  return result?.ok===true;
}

/** The immutable posting and its two legs must identify this exact allocation. */
async function utilityPostingProof(client:Client,orgId:string,lineId:string,contactId:string|null,unit:{id:string;property_id:string;currency:string}) {
  const result=await maybe<{ok:boolean}>(client,`SELECT EXISTS(SELECT 1 FROM utility_allocation_lines a WHERE a.org_id=$1 AND a.id=$2 AND (
    ($3::uuid IS NULL AND a.bearer='owner' AND a.lease_id IS NULL AND a.posted_invoice_id IS NULL AND a.posted_invoice_line_id IS NULL AND a.posted_ledger_transaction_id IS NULL AND a.posted_amount_minor IS NULL AND a.posted_description IS NULL)
    OR ($3::uuid IS NOT NULL AND a.bearer='tenant' AND a.lease_id IS NOT NULL AND (
      EXISTS(SELECT 1 FROM ledger_transactions t JOIN invoices i ON i.org_id=a.org_id AND i.id=a.posted_invoice_id
        JOIN invoice_lines il ON il.org_id=i.org_id AND il.invoice_id=i.id AND il.id=a.posted_invoice_line_id
        WHERE t.org_id=a.org_id AND t.id=a.posted_ledger_transaction_id AND t.kind='invoice' AND t.source_table='utility_allocation_lines' AND t.source_id=a.id AND t.lease_id=a.lease_id AND t.property_id=$4 AND t.currency=$5
          AND a.posted_amount_minor>0 AND t.description=a.posted_description AND i.lease_id=a.lease_id AND i.property_id=$4 AND i.currency=$5 AND i.bill_to_contact_id=$3
          AND il.charge_type='utility' AND il.amount_minor=a.posted_amount_minor AND il.description=a.posted_description
          AND (il.allocation_line_id=a.id OR (il.allocation_line_id IS NULL AND (SELECT count(*) FROM invoice_lines x WHERE x.org_id=i.org_id AND x.invoice_id=i.id AND x.charge_type='utility' AND x.amount_minor=a.posted_amount_minor AND x.description=a.posted_description)=1))
          AND NOT EXISTS(SELECT 1 FROM ledger_transactions rev WHERE rev.org_id=t.org_id AND rev.reverses_transaction_id=t.id)
          AND (SELECT count(*) FROM ledger_entries e WHERE e.org_id=t.org_id AND e.transaction_id=t.id)=2
          AND (SELECT count(*) FROM ledger_entries e WHERE e.org_id=t.org_id AND e.transaction_id=t.id AND e.currency=t.currency AND e.contact_id=$3 AND e.property_id=$4 AND e.lease_id=a.lease_id AND e.invoice_id=i.id AND ((e.account='tenant_receivable' AND e.amount_minor=a.posted_amount_minor) OR (e.account='other_income' AND e.amount_minor=-a.posted_amount_minor)))=2)
      OR (a.amount_minor=0 AND a.posted_invoice_id IS NULL AND a.posted_invoice_line_id IS NULL AND a.posted_ledger_transaction_id IS NULL AND a.posted_amount_minor IS NULL AND a.posted_description IS NULL
        AND (SELECT count(*) FROM ledger_transactions t WHERE t.org_id=a.org_id AND t.kind='invoice' AND t.source_table='utility_allocation_lines' AND t.source_id=a.id)=1
        AND EXISTS(SELECT 1 FROM ledger_transactions t JOIN ledger_transactions rev ON rev.org_id=t.org_id AND rev.reverses_transaction_id=t.id AND rev.kind='reversal' AND rev.source_table=t.source_table AND rev.source_id=t.source_id AND rev.lease_id=t.lease_id AND rev.property_id=t.property_id AND rev.currency=t.currency
          JOIN ledger_entries e ON e.org_id=t.org_id AND e.transaction_id=t.id AND e.account='tenant_receivable' AND e.amount_minor>0
          JOIN invoices i ON i.org_id=e.org_id AND i.id=e.invoice_id AND i.lease_id=a.lease_id AND i.property_id=$4 AND i.currency=$5 AND i.bill_to_contact_id=$3
          JOIN ledger_entries re ON re.org_id=rev.org_id AND re.transaction_id=rev.id AND re.account='tenant_receivable' AND re.amount_minor=-e.amount_minor
          JOIN invoices ci ON ci.org_id=re.org_id AND ci.id=re.invoice_id AND ci.lease_id=a.lease_id AND ci.property_id=$4 AND ci.currency=$5 AND ci.bill_to_contact_id=$3
          WHERE t.org_id=a.org_id AND t.kind='invoice' AND t.source_table='utility_allocation_lines' AND t.source_id=a.id AND t.lease_id=a.lease_id AND t.property_id=$4 AND t.currency=$5 AND e.contact_id=$3 AND e.lease_id=a.lease_id AND e.property_id=$4 AND e.currency=$5
            AND (SELECT count(*) FROM ledger_entries z WHERE z.org_id=t.org_id AND z.transaction_id=t.id)=2
            AND (SELECT count(*) FROM ledger_entries z WHERE z.org_id=t.org_id AND z.transaction_id=t.id AND z.currency=t.currency AND z.contact_id=$3 AND z.property_id=$4 AND z.lease_id=a.lease_id AND z.invoice_id=i.id AND ((z.account='tenant_receivable' AND z.amount_minor=e.amount_minor) OR (z.account='other_income' AND z.amount_minor=-e.amount_minor)))=2
            AND (SELECT count(*) FROM ledger_entries z WHERE z.org_id=rev.org_id AND z.transaction_id=rev.id)=2
            AND (SELECT count(*) FROM ledger_entries z WHERE z.org_id=rev.org_id AND z.transaction_id=rev.id AND z.currency=t.currency AND z.contact_id=$3 AND z.property_id=$4 AND z.lease_id=a.lease_id AND z.invoice_id=ci.id AND ((z.account='tenant_receivable' AND z.amount_minor=-e.amount_minor) OR (z.account='other_income' AND z.amount_minor=e.amount_minor)))=2
            AND (SELECT count(*) FROM invoice_lines x WHERE x.org_id=i.org_id AND x.invoice_id=i.id AND x.charge_type='utility' AND x.amount_minor=e.amount_minor AND x.description=t.description)=1
            AND (SELECT count(*) FROM invoice_lines x WHERE x.org_id=ci.org_id AND x.invoice_id=ci.id AND x.charge_type='credit' AND x.amount_minor=-e.amount_minor AND x.description='沖銷'||t.description)=1))
    )))) AS ok`,[orgId,lineId,contactId,unit.property_id,unit.currency]);
  return result?.ok===true;
}

/** Reconstruct only subjects actually recorded by a posted source; ambiguity is not vacancy. */
async function historicalUtilityOccupants(client:Client,orgId:string,unit:{id:string;property_id:string;currency:string},runId:string,spaces:SpaceRow[]) {
  const run=await maybe<{inputs:unknown}>(client,`SELECT inputs FROM utility_allocation_runs WHERE org_id=$1 AND id=$2 AND unit_id=$3 AND status IN ('posted','pending_repost')`,[orgId,runId,unit.id]);
  const inputs=run?.inputs && typeof run.inputs==='object' && !Array.isArray(run.inputs) ? run.inputs as Record<string,unknown> : null;
  const readings=Array.isArray(inputs?.readings)?inputs.readings:null;
  if(!readings?.length)throw new FlowError('errors.notFound');
  const lines=await many<{id:string;room_id:string|null;lease_id:string|null;bearer:string;days:number|null;contact_id:string|null;contact_count:number;invoice_contact:string|null;invoice_lease:string|null;invoice_property:string|null;invoice_currency:string|null;invoice_line:string|null;ledger_id:string|null;method:string|null;lease_unit:string|null;lease_room:string|null;lease_property:string|null;lease_currency:string|null}>(client,`SELECT al.id::text,al.room_id::text,al.lease_id::text,al.bearer::text,al.days_occupied AS days,
    (SELECT min(lp.contact_id::text) FROM lease_parties lp WHERE lp.org_id=al.org_id AND lp.lease_id=al.lease_id AND lp.role='primary') AS contact_id,
    (SELECT count(*)::int FROM lease_parties lp WHERE lp.org_id=al.org_id AND lp.lease_id=al.lease_id AND lp.role='primary') AS contact_count,
    i.bill_to_contact_id::text AS invoice_contact,i.lease_id::text AS invoice_lease,i.property_id::text AS invoice_property,i.currency::text AS invoice_currency,
    il.id::text AS invoice_line,al.posted_ledger_transaction_id::text AS ledger_id,al.explanation->>'method' AS method,
    l.unit_id::text AS lease_unit,l.target_room_id::text AS lease_room,l.property_id::text AS lease_property,l.currency::text AS lease_currency
    FROM utility_allocation_lines al LEFT JOIN leases l ON l.org_id=al.org_id AND l.id=al.lease_id
    LEFT JOIN invoices i ON i.org_id=al.org_id AND i.id=al.posted_invoice_id
    LEFT JOIN invoice_lines il ON il.org_id=al.org_id AND il.invoice_id=i.id AND il.id=al.posted_invoice_line_id
    WHERE al.org_id=$1 AND al.run_id=$2`,[orgId,runId]);
  if(lines.length!==readings.length)throw new FlowError('errors.notFound');
  const subjects=new Map<string,Occupant[]>(),seen=new Set<string>();
  for(const line of lines){
    const spaceId=line.room_id??unit.id,space=spaces.find(s=>s.space_id===spaceId),key=`${spaceId}:${line.lease_id??''}`;
    if(!space||seen.has(key)||!line.method||space.method!==line.method||!Number.isInteger(line.days)||line.days===null||line.days<0)throw new FlowError('errors.notFound');
    seen.add(key);
    const matched=readings.filter(x=>x && typeof x==='object' && !Array.isArray(x) && (x as Record<string,unknown>).spaceId===spaceId && ((x as Record<string,unknown>).leaseId??null)===line.lease_id && (x as Record<string,unknown>).method===line.method && (x as Record<string,unknown>).days===line.days);
    if(matched.length!==1)throw new FlowError('errors.notFound');
    if(line.bearer==='owner' && line.lease_id===null && line.days===0){if(subjects.has(spaceId)||!await utilityPostingProof(client,orgId,line.id,null,unit))throw new FlowError('errors.notFound');subjects.set(spaceId,[]);continue;}
    if(line.bearer!=='tenant'||!line.lease_id||line.days<=0||line.contact_count!==1||!line.contact_id||line.lease_unit!==unit.id||line.lease_room!==line.room_id||line.lease_property!==unit.property_id||line.lease_currency?.trim()!==unit.currency.trim()||!await utilityPostingProof(client,orgId,line.id,line.contact_id,unit))throw new FlowError('errors.notFound');
    const people=subjects.get(spaceId);if(people?.length===0)throw new FlowError('errors.notFound');
    subjects.set(spaceId,[...(people??[]),{leaseId:line.lease_id,contactId:line.contact_id,tenant:'',days:line.days}]);
  }
  if(spaces.some(space=>isPostableMethod(space.method)&&!subjects.has(space.space_id)))throw new FlowError('errors.notFound');
  return subjects;
}

async function verifyArchivedUtilitySubjects(client:Client,orgId:string,runId:string) {
  const row=await maybe<{id:string;property_id:string;currency:string;run_currency:string;rental_mode:string;method:string|null;archived:boolean}>(client,`SELECT u.id::text,u.property_id::text,p.currency::text,r.currency::text AS run_currency,u.rental_mode::text,u.electricity_method AS method,
    (p.archived_at IS NOT NULL OR u.archived_at IS NOT NULL OR EXISTS(SELECT 1 FROM utility_allocation_lines al JOIN rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id WHERE al.org_id=r.org_id AND al.run_id=r.id AND ar.archived_at IS NOT NULL)) AS archived
    FROM utility_allocation_runs r JOIN units u ON u.org_id=r.org_id AND u.id=r.unit_id JOIN properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE r.org_id=$1 AND r.id=$2`,[orgId,runId]);
  if(!row)throw new FlowError('errors.notFound');
  if(!row.archived)return;
  if(!await recordArchiveEnabledFor(client,orgId))throw new FlowError('errors.notFound');
  if(row.run_currency.trim()!==row.currency.trim())throw new FlowError('errors.notFound');
  const spaces=await loadSpaces(client,row,runId,true);
  await historicalUtilityOccupants(client,orgId,row,runId,spaces);
}

/** A room is billed only to a fully signed lease. Any other lease is vacant and stays on the owner. */
async function loadOccupants(client: Client, orgId: string, unitId: string, periodStart: string, periodEnd: string) {
  const rows = await many<{
    space_id: string;
    lease_id: string;
    contact_id: string;
    tenant: string;
    start_date: string;
    end_date: string;
  }>(
    client,
    `SELECT CASE WHEN l.target_room_id IS NULL THEN l.target_unit_id::text ELSE l.target_room_id::text END AS space_id,
            l.id::text AS lease_id, c.id::text AS contact_id, c.display_name AS tenant,
            l.start_date::text, coalesce(l.end_date, DATE '9999-12-31')::text AS end_date
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
      WHERE l.org_id = $1 AND l.unit_id = $2
        AND l.status = 'active'
        AND l.start_date <= $4::date
        AND coalesce(l.end_date, DATE '9999-12-31') >= $3::date`,
    [orgId, unitId, periodStart, periodEnd],
  );
  const occupants = new Map<string, Occupant[]>();
  for (const row of rows) {
    const days = inclusiveDays(row.start_date, row.end_date, periodStart, periodEnd);
    if (days <= 0) continue;
    const people = occupants.get(row.space_id) ?? [];
    people.push({
      leaseId: row.lease_id,
      contactId: row.contact_id,
      tenant: row.tenant,
      days,
    });
    occupants.set(row.space_id, people);
  }
  return occupants;
}

async function writeShares(
  client: Client,
  orgId: string,
  runId: string,
  shares: Share[],
  ratePerUnit: string,
  totalMinor: number,
) {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const share of shares) {
    const ratio = totalMinor > 0 ? Math.min(1, Math.max(0, share.amountMinor / totalMinor)) : 0;
    byKey.set(`${share.leaseId ?? ""}:${share.roomId ?? ""}`, {
      lease_id: share.leaseId,
      room_id: share.roomId,
      days: share.days,
      sub_meter_usage: share.method === "submeter" ? milliText(share.rawMilli) : null,
      share_ratio: ratio.toFixed(10),
      allocated_usage: milliText(share.kwhMilli),
      amount_minor: share.amountMinor,
      bearer: share.bearer,
      explanation: {
        kwh: share.kwhMilli / 1000,
        rate_minor_per_unit: Number(ratePerUnit),
        method: share.method,
        room: share.label,
        days: share.days,
        previousKwh: share.previousKwh,
        currentKwh: share.currentKwh,
      },
    });
  }
  const payload = JSON.stringify([...byKey.values()]);
  const shareRows = `jsonb_to_recordset($2::jsonb) AS s(
         lease_id uuid, room_id uuid, days integer, sub_meter_usage numeric,
         share_ratio numeric, allocated_usage numeric, amount_minor bigint, bearer text, explanation jsonb
       )`;
  await client.query(
    `UPDATE utility_allocation_lines AS l
        SET days_occupied = s.days, sub_meter_usage = s.sub_meter_usage, share_ratio = s.share_ratio,
            allocated_usage = s.allocated_usage, amount_minor = s.amount_minor, bearer = s.bearer::utility_payer,
            explanation = s.explanation
       FROM ${shareRows}
      WHERE l.run_id = $1::uuid
        AND l.lease_id IS NOT DISTINCT FROM s.lease_id
        AND l.room_id IS NOT DISTINCT FROM s.room_id`,
    [runId, payload],
  );
  await client.query(
    `INSERT INTO utility_allocation_lines (
       org_id, run_id, lease_id, room_id, days_occupied, sub_meter_usage, share_ratio,
       allocated_usage, amount_minor, bearer, explanation
     )
     SELECT $1::uuid, $2::uuid, s.lease_id, s.room_id, s.days, s.sub_meter_usage, s.share_ratio,
            s.allocated_usage, s.amount_minor, s.bearer::utility_payer, s.explanation
       FROM jsonb_to_recordset($3::jsonb) AS s(
         lease_id uuid, room_id uuid, days integer, sub_meter_usage numeric,
         share_ratio numeric, allocated_usage numeric, amount_minor bigint, bearer text, explanation jsonb
       )
      WHERE NOT EXISTS (
        SELECT 1 FROM utility_allocation_lines l
         WHERE l.run_id = $2::uuid
           AND l.lease_id IS NOT DISTINCT FROM s.lease_id
           AND l.room_id IS NOT DISTINCT FROM s.room_id
      )`,
    [orgId, runId, payload],
  );
  const kept = `jsonb_to_recordset($2::jsonb) AS s(lease_id uuid, room_id uuid)`;
  await client.query(
    `UPDATE utility_allocation_lines AS l
        SET amount_minor = 0, allocated_usage = 0, share_ratio = 0
      WHERE l.run_id = $1::uuid
        AND l.posted_ledger_transaction_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${kept}
           WHERE l.lease_id IS NOT DISTINCT FROM s.lease_id
             AND l.room_id IS NOT DISTINCT FROM s.room_id
        )`,
    [runId, payload],
  );
  await client.query(
    `DELETE FROM utility_allocation_lines AS l
      WHERE l.run_id = $1::uuid
        AND l.posted_ledger_transaction_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${kept}
           WHERE l.lease_id IS NOT DISTINCT FROM s.lease_id
             AND l.room_id IS NOT DISTINCT FROM s.room_id
        )`,
    [runId, payload],
  );
}

type ReverseJob = {
  lineId: string;
  ledgerId: string;
  invoiceId: string | null;
  invoiceLineId: string | null;
  creditAmount: number;
  creditDescription: string;
  leaseId: string | null;
  propertyId: string | null;
  currency: string | null;
  contactId: string | null;
  periodStart: string;
  periodEnd: string;
};

type PostJob = {
  lineId: string;
  leaseId: string;
  propertyId: string;
  currency: string;
  contactId: string;
  periodStart: string;
  periodEnd: string;
  amountMinor: number;
  description: string;
  quantity: string;
  rate: string;
  targetInvoiceId: string | null;
  linkAllocation: boolean;
};

type InvoiceTarget = { invoiceId: string | null; linkAllocation: boolean };

async function existingInvoiceLineIds(client: Client, ids: string[]) {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  const rows = await many<{ id: string }>(client, `SELECT id::text FROM invoice_lines WHERE id = ANY($1::uuid[])`, [ids]);
  for (const row of rows) found.add(row.id);
  return found;
}

const FROZEN_INVOICE_SQL = `
  i.status::text, i.paid_minor::text, i.einvoice_status::text,
  (
    EXISTS (
      SELECT 1 FROM owner_statements s
       WHERE s.id = i.owner_statement_id AND s.org_id = i.org_id AND s.status = 'issued'
    )
    OR EXISTS (
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
  ) AS on_statement`;

function frozenRow(row: { status: string; paid_minor: string; einvoice_status: string; on_statement: boolean } | null) {
  if (!row) return true;
  const openUnpaid =
    row.status === "open" &&
    Number(row.paid_minor) === 0 &&
    row.einvoice_status !== "issued" &&
    row.einvoice_status !== "allowance_issued";
  return !openUnpaid || row.on_statement;
}

async function reversePostedLines(client: Client, session: Session, jobs: ReverseJob[], reason: string) {
  const targets = new Map<string, InvoiceTarget>();
  if (jobs.length === 0) return targets;
  const present = await existingInvoiceLineIds(
    client,
    jobs.flatMap((job) => (job.invoiceLineId ? [job.invoiceLineId] : [])),
  );
  await client.query(
    `UPDATE utility_allocation_lines
        SET posted_invoice_id = NULL, posted_invoice_line_id = NULL, posted_ledger_transaction_id = NULL,
            posted_amount_minor = NULL, posted_description = NULL
      WHERE id = ANY($1::uuid[])`,
    [jobs.map((job) => job.lineId)],
  );
  const invoiceIds = [...new Set(jobs.flatMap((job) => (job.invoiceId ? [job.invoiceId] : [])))];
  const frozenById = new Map<string, boolean>();
  if (invoiceIds.length > 0) {
    const rows = await many<{ id: string; status: string; paid_minor: string; einvoice_status: string; on_statement: boolean }>(
      client,
      `SELECT i.id::text, ${FROZEN_INVOICE_SQL}
         FROM invoices i
        WHERE i.id = ANY($1::uuid[])
        ORDER BY i.id FOR UPDATE`,
      [invoiceIds],
    );
    for (const row of rows) frozenById.set(row.id, frozenRow(row));
  }
  const frozenOf = (job: ReverseJob) => (job.invoiceId ? (frozenById.get(job.invoiceId) ?? true) : true);
  const open: ReverseJob[] = [];
  const frozen: ReverseJob[] = [];
  const fallback: ReverseJob[] = [];
  for (const job of jobs) {
    const isFrozen = frozenOf(job);
    const still = job.invoiceLineId != null && present.has(job.invoiceLineId);
    const canCredit = job.creditAmount < 0;
    if (!isFrozen && job.invoiceId && canCredit) {
      open.push(job);
      targets.set(job.lineId, { invoiceId: job.invoiceId, linkAllocation: true });
    } else if (isFrozen && canCredit && job.leaseId && job.propertyId && job.currency && job.contactId) {
      frozen.push(job);
    } else {
      fallback.push(job);
      targets.set(job.lineId, { invoiceId: null, linkAllocation: !still || !isFrozen });
    }
  }
  const unlink = jobs.flatMap((job) => (!frozenOf(job) && job.invoiceLineId && present.has(job.invoiceLineId) ? [job.invoiceLineId] : []));
  if (unlink.length > 0) {
    await client.query(`UPDATE invoice_lines SET allocation_line_id = NULL WHERE id = ANY($1::uuid[])`, [unlink]);
  }
  if (open.length > 0) await creditAndReverse(client, session.orgId, open, reason, null);
  if (frozen.length > 0) {
    const created = await createUtilityInvoices(
      client,
      session,
      frozen.map((job) => ({
        key: job.lineId,
        leaseId: job.leaseId!,
        propertyId: job.propertyId!,
        contactId: job.contactId!,
        currency: job.currency!,
        periodStart: job.periodStart,
        periodEnd: job.periodEnd,
      })),
    );
    const credited = frozen.map((job) => {
      const invoiceId = created.get(job.lineId);
      if (!invoiceId) throw new FlowError("errors.generic");
      targets.set(job.lineId, { invoiceId, linkAllocation: false });
      return { ...job, invoiceId };
    });
    await creditAndReverse(client, session.orgId, credited, reason, "credit");
  }
  if (fallback.length > 0) await reverseWithoutCredit(client, fallback, reason, frozenOf);
  return targets;
}

async function creditAndReverse(
  client: Client,
  orgId: string,
  jobs: ReverseJob[],
  reason: string,
  retarget: "credit" | null,
) {
  const payload = JSON.stringify(
    jobs.map((job) => ({
      line_id: job.lineId,
      ledger_id: job.ledgerId,
      invoice_id: job.invoiceId,
      credit_amount: job.creditAmount,
      credit_description: job.creditDescription,
    })),
  );
  const credits = await client.query<{ credits: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS s(
         line_id uuid, ledger_id uuid, invoice_id uuid, credit_amount bigint, credit_description text
       )
     ),
     locked AS (
       SELECT i.id FROM invoices i WHERE i.id IN (SELECT invoice_id FROM input) ORDER BY i.id FOR UPDATE
     ),
     numbered AS (
       SELECT s.*,
              coalesce(m.max_no, 0) + row_number() OVER (PARTITION BY s.invoice_id ORDER BY s.line_id) AS line_no
         FROM input s
         JOIN locked l ON l.id = s.invoice_id
         LEFT JOIN LATERAL (
           SELECT max(il.line_no) AS max_no FROM invoice_lines il WHERE il.invoice_id = s.invoice_id
         ) m ON true
     ),
     inserted AS (
       INSERT INTO invoice_lines (
         org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor
       )
       SELECT $1::uuid, n.invoice_id, n.line_no::smallint, 'credit', n.credit_description, 1,
              n.credit_amount::numeric, n.credit_amount
         FROM numbered n
       RETURNING id
     )
     SELECT count(*)::text AS credits FROM inserted`,
    [orgId, payload],
  );
  if (Number(credits.rows[0]?.credits) !== jobs.length) throw new FlowError("errors.generic");
  const reversalInvoice = retarget === "credit" ? "s.invoice_id" : "NULL::uuid";
  const pointed = await client.query<{ reversals: string; pointed: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(ledger_id uuid, invoice_id uuid)
     ),
     reversals AS (
       SELECT s.ledger_id, s.invoice_id, post_reversal(s.ledger_id, $2, ${reversalInvoice}) AS rev_id
         FROM input s
     ),
     pointed AS (
       UPDATE invoices i
          SET ledger_transaction_id = ${retarget === "credit" ? "r.rev_id" : "NULL"}
         FROM reversals r
        WHERE i.id = r.invoice_id
          AND ${retarget === "credit" ? "i.ledger_transaction_id IS NULL" : "i.ledger_transaction_id = r.ledger_id"}
       RETURNING i.id
     )
     SELECT (SELECT count(*) FROM reversals)::text AS reversals,
            (SELECT count(*) FROM pointed)::text AS pointed`,
    [payload, reason],
  );
  if (Number(pointed.rows[0]?.reversals) !== jobs.length) throw new FlowError("errors.generic");
  if (retarget === "credit" && Number(pointed.rows[0]?.pointed) !== jobs.length) throw new FlowError("errors.generic");
}

async function reverseWithoutCredit(
  client: Client,
  jobs: ReverseJob[],
  reason: string,
  frozenOf: (job: ReverseJob) => boolean,
) {
  const payload = JSON.stringify(
    jobs.map((job) => ({
      ledger_id: job.ledgerId,
      invoice_id: job.invoiceId,
      clear: Boolean(job.invoiceId) && !frozenOf(job),
    })),
  );
  const result = await client.query<{ reversals: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(ledger_id uuid, invoice_id uuid, clear boolean)
     ),
     reversals AS (
       SELECT s.ledger_id, s.invoice_id, s.clear, post_reversal(s.ledger_id, $2, NULL::uuid) AS rev_id
         FROM input s
     ),
     cleared AS (
       UPDATE invoices i
          SET ledger_transaction_id = NULL
         FROM reversals r
        WHERE r.clear AND i.id = r.invoice_id AND i.ledger_transaction_id = r.ledger_id
       RETURNING i.id
     )
     SELECT (SELECT count(*) FROM reversals)::text AS reversals,
            (SELECT count(*) FROM cleared)::text AS cleared`,
    [payload, reason],
  );
  if (Number(result.rows[0]?.reversals) !== jobs.length) throw new FlowError("errors.generic");
}

async function postChargeLines(client: Client, session: Session, posts: PostJob[]) {
  if (posts.length === 0) return;
  const needing = posts.filter((post) => !post.targetInvoiceId);
  const found = await findOpenInvoices(client, session.orgId, needing);
  for (const post of needing) {
    const invoiceId = found.get(post.leaseId);
    if (invoiceId) post.targetInvoiceId = invoiceId;
  }
  const missing = posts.filter((post) => !post.targetInvoiceId);
  const created = await createUtilityInvoices(
    client,
    session,
    missing.map((post) => ({
      key: post.lineId,
      leaseId: post.leaseId,
      propertyId: post.propertyId,
      contactId: post.contactId,
      currency: post.currency,
      periodStart: post.periodStart,
      periodEnd: post.periodEnd,
    })),
  );
  for (const post of missing) {
    const invoiceId = created.get(post.lineId);
    if (!invoiceId) throw new FlowError("errors.notFound");
    post.targetInvoiceId = invoiceId;
  }
  const payload = JSON.stringify(
    posts.map((post) => ({
      line_id: post.lineId,
      invoice_id: post.targetInvoiceId,
      lease_id: post.leaseId,
      property_id: post.propertyId,
      contact_id: post.contactId,
      currency: post.currency,
      amount_minor: post.amountMinor,
      description: post.description,
      quantity: post.quantity,
      rate: post.rate,
      link_allocation: post.linkAllocation,
    })),
  );
  const today = taipeiToday();
  const result = await client.query<{ posted: string; entries: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($4::jsonb) AS s(
         line_id uuid, invoice_id uuid, lease_id uuid, property_id uuid, contact_id uuid, currency text,
         amount_minor bigint, description text, quantity numeric, rate numeric, link_allocation boolean
       )
     ),
     locked AS (
       SELECT i.id FROM invoices i WHERE i.id IN (SELECT invoice_id FROM input) ORDER BY i.id FOR UPDATE
     ),
     numbered AS (
       SELECT s.*,
              coalesce(m.max_no, 0) + row_number() OVER (PARTITION BY s.invoice_id ORDER BY s.line_id) AS line_no
         FROM input s
         JOIN locked l ON l.id = s.invoice_id
         LEFT JOIN LATERAL (
           SELECT max(il.line_no) AS max_no FROM invoice_lines il WHERE il.invoice_id = s.invoice_id
         ) m ON true
     ),
     new_lines AS (
       INSERT INTO invoice_lines (
         org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor, allocation_line_id
       )
       SELECT $1::uuid, n.invoice_id, n.line_no::smallint, 'utility', n.description, n.quantity, n.rate, n.amount_minor,
              CASE WHEN n.link_allocation THEN n.line_id ELSE NULL END
         FROM numbered n
       RETURNING id, invoice_id, line_no
     ),
     txns AS (
       INSERT INTO ledger_transactions (
         org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by
       )
       SELECT $1::uuid, n.property_id, n.lease_id, 'invoice', n.currency::char(3), $3::date, n.description,
              'utility_allocation_lines', n.line_id, $2::uuid
         FROM numbered n
       RETURNING id, source_id
     ),
     entries AS (
       INSERT INTO ledger_entries (
         org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo
       )
       SELECT $1::uuid, t.id, x.account, x.amount_minor, n.currency::char(3), n.contact_id, n.property_id, n.lease_id,
              n.invoice_id, '電費'
         FROM txns t
         JOIN numbered n ON n.line_id = t.source_id
         CROSS JOIN LATERAL (
           VALUES ('tenant_receivable'::ledger_account, n.amount_minor),
                  ('other_income'::ledger_account, -n.amount_minor)
         ) AS x(account, amount_minor)
       RETURNING id
     ),
     posted AS (
       UPDATE utility_allocation_lines l
          SET posted_invoice_id = n.invoice_id,
              posted_invoice_line_id = nl.id,
              posted_ledger_transaction_id = t.id,
              posted_amount_minor = n.amount_minor,
              posted_description = n.description
         FROM numbered n
         JOIN new_lines nl ON nl.invoice_id = n.invoice_id AND nl.line_no = n.line_no::smallint
         JOIN txns t ON t.source_id = n.line_id
        WHERE l.id = n.line_id
       RETURNING l.id
     )
     SELECT (SELECT count(*) FROM posted)::text AS posted,
            (SELECT count(*) FROM entries)::text AS entries`,
    [session.orgId, session.userId, today, payload],
  );
  if (Number(result.rows[0]?.posted) !== posts.length || Number(result.rows[0]?.entries) !== posts.length * 2) {
    throw new FlowError("errors.generic");
  }
  await client.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(line_id uuid)
     ),
     picked AS (
       SELECT DISTINCT ON (l.posted_invoice_id)
              l.posted_invoice_id AS invoice_id,
              l.posted_ledger_transaction_id AS txn_id
         FROM input s
         JOIN utility_allocation_lines l ON l.id = s.line_id
        WHERE l.posted_invoice_id IS NOT NULL AND l.posted_ledger_transaction_id IS NOT NULL
        ORDER BY l.posted_invoice_id, l.id
     )
     UPDATE invoices i
        SET ledger_transaction_id = picked.txn_id
       FROM picked
      WHERE i.id = picked.invoice_id
        AND (
          i.ledger_transaction_id IS NULL
          OR EXISTS (
            SELECT 1 FROM ledger_transactions rev WHERE rev.reverses_transaction_id = i.ledger_transaction_id
          )
        )`,
    [JSON.stringify(posts.map((post) => ({ line_id: post.lineId })))],
  );
}

async function findOpenInvoices(client: Client, orgId: string, posts: PostJob[]) {
  const found = new Map<string, string>();
  if (posts.length === 0) return found;
  const payload = JSON.stringify(
    posts.map((post) => ({ lease_id: post.leaseId, period_start: post.periodStart, period_end: post.periodEnd })),
  );
  const rows = await many<{ lease_id: string; id: string }>(
    client,
    `WITH chosen AS (
       SELECT DISTINCT ON (s.lease_id) s.lease_id, i.id
         FROM jsonb_to_recordset($2::jsonb) AS s(lease_id uuid, period_start date, period_end date)
         JOIN invoices i ON i.org_id = $1 AND i.lease_id = s.lease_id
          AND i.status = 'open' AND i.paid_minor = 0
          AND i.einvoice_status NOT IN ('issued', 'allowance_issued')
          AND i.source IN ('recurring', 'utility')
          AND i.period_start <= s.period_end AND i.period_end >= s.period_start
          AND NOT (
            EXISTS (
              SELECT 1 FROM owner_statements os
               WHERE os.id = i.owner_statement_id AND os.org_id = i.org_id AND os.status = 'issued'
            )
            OR EXISTS (
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
          )
        ORDER BY s.lease_id, (i.period_start = s.period_start AND i.period_end = s.period_end) DESC, i.period_start DESC
     )
     SELECT c.lease_id::text, i.id::text
       FROM chosen c
       JOIN invoices i ON i.id = c.id
      ORDER BY i.id FOR UPDATE OF i`,
    [orgId, payload],
  );
  // The chosen CTE uses the statement's snapshot. A payment can commit while
  // FOR UPDATE waits, so recheck the locked IDs in a new READ COMMITTED
  // statement before the caller can append any utility lines.
  if (rows.length > 0) {
    const checked = await many<{ id: string; status: string; paid_minor: string; einvoice_status: string; on_statement: boolean; isolation: string }>(
      client,
      `SELECT i.id::text, current_setting('transaction_isolation') AS isolation, ${FROZEN_INVOICE_SQL}
         FROM invoices i
         JOIN jsonb_to_recordset($2::jsonb) AS selected(lease_id uuid,id uuid)
           ON selected.id=i.id AND selected.lease_id=i.lease_id
        WHERE i.org_id=$1 AND i.source IN ('recurring','utility')
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS requested(lease_id uuid,period_start date,period_end date)
            WHERE requested.lease_id=i.lease_id AND i.period_start<=requested.period_end AND i.period_end>=requested.period_start)`,
      [orgId, JSON.stringify(rows), payload],
    );
    if (checked.length !== rows.length || checked.some((row) => row.isolation !== "read committed" || frozenRow(row))) throw new FlowError("errors.generic");
  }
  for (const row of rows) found.set(row.lease_id, row.id);
  return found;
}

async function createUtilityInvoices(
  client: Client,
  session: Session,
  rows: Array<{
    key: string;
    leaseId: string;
    propertyId: string;
    contactId: string;
    currency: string;
    periodStart: string;
    periodEnd: string;
  }>,
) {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;
  const today = taipeiToday();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const numbers = await reserveInvoiceNumbers(client, session.orgId, rows.length, attempt);
    const payload = JSON.stringify(
      rows.map((row, index) => ({
        key: row.key,
        property_id: row.propertyId,
        lease_id: row.leaseId,
        contact_id: row.contactId,
        currency: row.currency,
        period_start: row.periodStart,
        period_end: row.periodEnd,
        invoice_number: numbers[index],
      })),
    );
    await client.query("SAVEPOINT utility_invoices");
    try {
      const inserted = await client.query<{ id: string; invoice_number: string }>(
        `INSERT INTO invoices (
           org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency, issue_date, due_date,
           period_start, period_end, status, source, created_by, einvoice_status
         )
         SELECT $1::uuid, s.property_id, s.lease_id, s.contact_id, s.invoice_number, s.currency::char(3),
                $2::date, GREATEST(s.period_end, $2::date), s.period_start, s.period_end, 'open', 'utility', $3::uuid,
                'not_applicable'
           FROM jsonb_to_recordset($4::jsonb) AS s(
             key text, property_id uuid, lease_id uuid, contact_id uuid, invoice_number text, currency text,
             period_start date, period_end date
           )
         RETURNING id::text, invoice_number`,
        [session.orgId, today, session.userId, payload],
      );
      await client.query("RELEASE SAVEPOINT utility_invoices");
      const keyByNumber = new Map(rows.map((row, index) => [numbers[index], row.key]));
      if (inserted.rows.length !== rows.length) throw new FlowError("errors.generic");
      for (const row of inserted.rows) {
        const key = keyByNumber.get(row.invoice_number);
        if (!key) throw new FlowError("errors.generic");
        map.set(key, row.id);
      }
      return map;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT utility_invoices");
      if (!uniqueViolation(error) && !(error instanceof FlowError)) throw error;
      if (error instanceof FlowError) throw error;
    }
  }
  throw new FlowError("errors.generic");
}
