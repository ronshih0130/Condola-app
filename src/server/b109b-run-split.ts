import type { Client } from "pg";
import { FlowError } from "./errors";
import { kwhMilli } from "./utility-post";

/**
 * B-109b (PR-036 = a; GS-53 = A; MGT-90-AC4…AC6): the B-109 shared-meter split applied inside a utility run of ONE
 * by-room unit. With shared_meter ON and a revision in effect at the period start naming rooms of this unit only,
 * the unit's shared kWh (total minus the room meters) is split among the selected rooms by the revision's method
 * with app.b109_split_shares (exact div(), remainder to the first room) and added to those rooms' lines before
 * pricing at the run's typed rate. This replaces PUBLIC_POWER_RULE for that kWh. Anything else is unchanged; with
 * the flag OFF (org or platform) nothing here runs (no gateway call, no lock).
 */
export type RunSharedConfig =
  | null
  | { status: "none"; revision?: number }
  | { status: "multi_unit" | "whole_unit"; revision: number }
  | { status: "applies"; revision: number; method: "even" | "days_occupied" | "sub_meter"; effectiveFrom: string; spaceIds: string[];
      startReading: string; firstPeriod: boolean; mainReading: { value: string; estimated: boolean; readOn: string } | null };
export type SharedRecord = {
  revision: number; method: string; roomIds: string[]; weights: string[]; sharesMilli: number[]; kwhMilli: number;
  seededTotalMilli: number | null;
};

/** Run `fn` as service_role inside the caller's transaction, then return to the caller's role. */
async function asService<T>(client: Pick<Client, "query">, fn: () => Promise<T>): Promise<T> {
  const role = (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0].role;
  await client.query("SET LOCAL ROLE service_role");
  try { return await fn(); } finally {
    // Both roles are fixed identifiers, never derived from request data.
    if (role === "authenticated") await client.query("SET LOCAL ROLE authenticated");
    else if (role !== "service_role") await client.query("RESET ROLE");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseRunSharedConfig(value: unknown): RunSharedConfig {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (v.status === "none") return { status: "none" };
  if ((v.status === "multi_unit" || v.status === "whole_unit") && Number.isInteger(v.revision)) return { status: v.status, revision: v.revision as number };
  const main = v.mainReading as Record<string, unknown> | null;
  if (v.status !== "applies" || !Number.isInteger(v.revision) || !["even", "days_occupied", "sub_meter"].includes(v.method as string)
    || !Array.isArray(v.spaceIds) || !v.spaceIds.length || !v.spaceIds.every(x => typeof x === "string" && UUID.test(x))
    || typeof v.startReading !== "string" || !/^[0-9]{1,11}(?:\.[0-9]{1,3})?$/.test(v.startReading) || typeof v.firstPeriod !== "boolean"
    || typeof v.effectiveFrom !== "string" || !(main === null || (typeof main?.value === "string" && typeof main.estimated === "boolean" && typeof main.readOn === "string")))
    throw new Error("Invalid shared meter run config");
  return v as RunSharedConfig;
}

/**
 * The run's shared-meter decision. The flag (org and platform) is checked first without any lock; only when it is on does the
 * gateway run (it locks what it reads, then re-admits). Same transaction as the run, pinned to the session's org.
 */
/** Only the ids the gateway re-admits; the caller (prepareUtilityRun) has already applied its own guards. */
export type RunScope = { orgId: string; liveOrgId: string; environment: string; sessionId: string };
export async function readRunSharedConfig(client: Pick<Client, "query">, session: RunScope, unitId: string, periodStart: string, periodEnd: string): Promise<RunSharedConfig> {
  return asService(client, async () => {
    // The whole flag predicate (org flag AND platform setting enabled for this org), read without a lock: OFF in any
    // part means no gateway call, no lock and no wait. The gateway re-checks it after its locks.
    const on = (await client.query<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='shared_meter'
      WHERE o.id=$1 AND o.feature_flags->'shared_meter'='true'::jsonb AND f.value->'enabled'='true'::jsonb
        AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS on`, [session.orgId])).rows[0]?.on === true;
    if (!on) return null;
    const row = (await client.query<{ r: unknown }>("SELECT app.b109b_run_config($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::date,$7::date) AS r",
      [session.orgId, session.liveOrgId, session.environment, session.sessionId, unitId, periodStart, periodEnd])).rows[0];
    return parseRunSharedConfig(row?.r ?? null);
  });
}

/** The one split rule (app.b109_split_shares): shares of `totalMilli` by weight, exact, remainder to the first. */
export async function splitSharesMilli(client: Pick<Client, "query">, weights: { id: string; weight: number }[], totalMilli: number): Promise<number[]> {
  if (!Number.isSafeInteger(totalMilli) || totalMilli < 0) throw new FlowError("errors.amount");
  const rows = await asService(client, async () => (await client.query<{ r: { id: string; milli: string }[] }>(
    "SELECT app.b109_split_shares($1::jsonb,$2::bigint,NULL) AS r", [JSON.stringify(weights), totalMilli])).rows[0].r);
  if (!Array.isArray(rows) || rows.length !== weights.length || rows.some((r, i) => r.id !== weights[i].id || !/^[0-9]+$/.test(r.milli)))
    throw new Error("Invalid split shares");
  const shares = rows.map(r => Number(r.milli));
  if (shares.reduce((a, b) => a + b, 0) !== totalMilli) throw new Error("Split does not add up");
  return shares;
}

/**
 * The first period of a revision without a typed total: the unit main meter's in-period reading minus the
 * revision's starting reading. Missing or estimated stops posting (never guessed). Later periods need the typed total.
 */
export function seededTotalMilli(config: Extract<RunSharedConfig, { status: "applies" }>, typedTotalKwh: number | null): number | null {
  if (typedTotalKwh != null) return null;
  if (!config.firstPeriod || !config.mainReading) throw new FlowError("errors.sharedMeterReadings");
  if (config.mainReading.estimated) throw new FlowError("errors.sharedMeterReadings");
  const usage = Number(config.mainReading.value) - Number(config.startReading);
  const milli = kwhMilli(usage);
  if (Number.isNaN(milli)) throw new FlowError("errors.sharedMeterReadings");
  return milli;
}

/** Weights per selected room, in the revision's order. 依分表度數 uses the run's typed room readings. */
export function sharedWeights(method: "even" | "days_occupied" | "sub_meter", roomIds: string[],
  rooms: Map<string, { typedMilli: number | null; days: number; hasLine: boolean }>): { id: string; weight: number }[] {
  return roomIds.map(id => {
    const room = rooms.get(id);
    // A selected room with no line in this run (not a metered room here) cannot carry a share.
    if (!room || !room.hasLine) throw new FlowError("errors.sharedMeterReadings");
    if (method === "even") return { id, weight: 1 };
    if (method === "days_occupied") return { id, weight: room.days };
    if (room.typedMilli == null || !Number.isSafeInteger(room.typedMilli) || room.typedMilli < 0) throw new FlowError("errors.sharedMeterReadings");
    return { id, weight: room.typedMilli };
  });
}
