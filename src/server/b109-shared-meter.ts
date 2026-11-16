import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { normalizeReading, READING, SPLIT_METHODS, type SplitMethod } from "../lib/shared-meter";

/**
 * B-109 ADV-METER (GS-53 = A; MGT-90-AC4…AC6), 物件 › 進階設定 › 公用電表. One gateway call per read or save:
 * app.b109_shared_meter_view / _save repeat their own admission (env/live tuple, live session, native admin or
 * manager, shared_meter flag, property of this org). brand_v3 gates the presentation. The per-kWh price is not
 * here (money-flow 電費規則, MGT-90-AC5). Saves take effect from the next period; issued bills never change.
 */
export { SPLIT_METHODS, type SplitMethod };
export type MeterSpace = { id: string; kind: "room" | "whole_unit"; unitLabel: string; label: string | null };
export type MeterConfig = { revision: number; spaceIds: string[]; method: SplitMethod; startReading: string; effectiveFrom: string };
export type SharedMeterView =
  | { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; property: string; nextEffectiveFrom: string; spaces: MeterSpace[]; config: MeterConfig | null };
export type SharedMeterInput = { propertyId: string; requestId: string; spaceIds: string[]; method: string; startReading: string };
export type SharedMeterResult =
  | { ok: true; revision: number; effectiveFrom: string; spaceCount: number; method: SplitMethod; replayed: boolean }
  | { ok: false; reason: "off" | "forbidden" | "invalid" | "conflict" | "failed" };
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };

const str = (value: unknown): value is string => typeof value === "string";
const uuid = (value: unknown): value is string => str(value) && isUuid(value);
const day = (value: unknown): value is string => str(value) && /^\d{4}-\d{2}-01$/.test(value);

function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}
const denied = (error: unknown) => sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden");

export function parseSharedMeterView(value: unknown): Omit<Extract<SharedMeterView, { state: "ready" }>, "state"> | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || !str(v.property) || !day(v.nextEffectiveFrom) || !Array.isArray(v.spaces)) throw new Error("Invalid shared meter view");
  const ids = new Set<string>();
  for (const s of v.spaces as Record<string, unknown>[]) {
    if (!s || !uuid(s.id) || !["room", "whole_unit"].includes(s.kind as string) || !str(s.unitLabel)
      || !(s.label === null || str(s.label)) || (s.kind === "room") !== str(s.label)) throw new Error("Invalid shared meter space");
    ids.add(s.id);
  }
  const c = v.config as Record<string, unknown> | null;
  if (c !== null && (!c || !Number.isInteger(c.revision) || (c.revision as number) < 1 || !Array.isArray(c.spaceIds)
    || !(c.spaceIds as unknown[]).every(uuid) || !(c.spaceIds as unknown[]).length || !SPLIT_METHODS.includes(c.method as SplitMethod)
    || !str(c.startReading) || !/^[0-9]{1,11}(?:\.[0-9]{1,3})?$/.test(c.startReading) || !day(c.effectiveFrom))) throw new Error("Invalid shared meter config");
  return v as Omit<Extract<SharedMeterView, { state: "ready" }>, "state">;
}

async function admit(input: Session, deps: Deps): Promise<Session | { state: "off" | "forbidden" }> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  // props.edit is admin + manager (GS-06: accountants and maintenance never see the entry).
  const session = await guardEffectiveSession(input, "props.edit");
  assertPerm(session, "props.edit");
  const native = session.customRole?.nativeRole ?? session.role;
  if (session.kind !== "staff" || !native || !["admin", "manager"].includes(native) || !uuid(session.orgId) || !uuid(session.liveOrgId)
    || !uuid(session.sessionId) || !["live", "sandbox"].includes(session.environment)) return { state: "forbidden" };
  return session;
}

/** The page's read: spaces, the latest saved revision (form prefill) and the next effective month. */
export async function sharedMeterView(input: Session, propertyId: string, deps: Deps = {}): Promise<SharedMeterView> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    if (!uuid(propertyId)) return { state: "forbidden" };
    const view = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b109_shared_meter_view($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, propertyId])).rows[0];
      if (!row) throw new Error("Missing shared meter snapshot");
      return parseSharedMeterView(row.result);
    }, { isolation: "repeatable read" });
    return view ? { state: "ready", ...view } : { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b109_shared_meter_view", error);
    return { state: "unavailable" };
  }
}

/** MGT-90-AC4/AC6: rooms (at least one), a split method and a starting reading; effective from the next period. */
export async function saveSharedMeter(input: Session, form: SharedMeterInput, deps: Deps = {}): Promise<SharedMeterResult> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return { ok: false, reason: session.state };
    const reading = str(form?.startReading) ? normalizeReading(form.startReading) : "";
    if (!form || !uuid(form.propertyId) || !uuid(form.requestId) || !Array.isArray(form.spaceIds) || !form.spaceIds.length
      || form.spaceIds.length > 500 || !form.spaceIds.every(uuid) || new Set(form.spaceIds).size !== form.spaceIds.length
      || !SPLIT_METHODS.includes(form.method as SplitMethod) || !READING.test(reading)) return { ok: false, reason: "invalid" };
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      return (await client.query<{ result: Record<string, unknown> | null }>(
        "SELECT app.b109_shared_meter_save($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid[],$8::text,$9::numeric) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, form.requestId, form.propertyId, form.spaceIds, form.method, reading],
      )).rows[0]?.result ?? null;
    });
    const status = result?.status;
    if (status === "saved" && Number.isInteger(result?.revision) && day(result?.effectiveFrom) && Number.isInteger(result?.spaceCount)
      && SPLIT_METHODS.includes(result?.method as SplitMethod) && typeof result?.replayed === "boolean")
      return { ok: true, revision: result.revision as number, effectiveFrom: result.effectiveFrom as string,
        spaceCount: result.spaceCount as number, method: result.method as SplitMethod, replayed: result.replayed as boolean };
    if (status === "disabled") return { ok: false, reason: "off" };
    if (status === "invalid") return { ok: false, reason: "invalid" };
    if (status === "conflict") return { ok: false, reason: "conflict" };
    logServerError("b109_shared_meter_save", new Error(`Unexpected shared meter result ${String(status)}`));
    return { ok: false, reason: "failed" };
  } catch (error) {
    if (denied(error)) return { ok: false, reason: "forbidden" };
    logServerError("b109_shared_meter_save", error);
    return { ok: false, reason: "failed" };
  }
}

export type SplitRow = { id: string; kind: "room" | "whole_unit"; unitLabel: string; label: string | null; weight: string; kwh: string; amountMinor: string | null };
export type SharedMeterSplit =
  | { state: "off" | "forbidden" | "unavailable" | "none" }
  | { state: "not_ready"; reason: "ambiguous_meters" | "missing_readings" | "estimated_readings"; spaceIds: string[] }
  | { state: "ready"; period: string; revision: number; method: SplitMethod; kwh: string; amountMinor: string | null; rows: SplitRow[] };
export type SplitInput = { propertyId: string; period: string; kwh: string; amountMinor?: string | null };
const KWH = /^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,3})?$/;
const MINOR = /^(?:0|[1-9][0-9]{0,15})$/;

export function parseSharedMeterSplit(value: unknown): Exclude<SharedMeterSplit, { state: "off" | "forbidden" | "unavailable" }> | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (v.status === "none") return { state: "none" };
  if (v.status === "ambiguous_meters" || v.status === "missing_readings" || v.status === "estimated_readings") {
    if (!Array.isArray(v.spaces) || !v.spaces.length || !v.spaces.every(uuid)) throw new Error("Invalid split status");
    return { state: "not_ready", reason: v.status, spaceIds: v.spaces as string[] };
  }
  if (v.status !== "ready" || !day(v.period) || !Number.isInteger(v.revision) || !SPLIT_METHODS.includes(v.method as SplitMethod)
    || !str(v.kwh) || !KWH.test(v.kwh) || !(v.amountMinor === null || (str(v.amountMinor) && MINOR.test(v.amountMinor)))
    || !Array.isArray(v.rows) || !v.rows.length) throw new Error("Invalid split");
  let milli = 0, amount = 0;
  for (const r of v.rows as Record<string, unknown>[]) {
    if (!r || !uuid(r.id) || !["room", "whole_unit"].includes(r.kind as string) || !str(r.unitLabel) || !(r.label === null || str(r.label))
      || !str(r.weight) || !str(r.kwh) || !KWH.test(r.kwh) || (v.amountMinor === null ? r.amountMinor !== null : !(str(r.amountMinor) && MINOR.test(r.amountMinor))))
      throw new Error("Invalid split row");
    milli += Math.round(Number(r.kwh) * 1000);
    if (str(r.amountMinor)) amount += Number(r.amountMinor);
  }
  // The shares add up exactly to the totals (remainder to the first space).
  if (milli !== Math.round(Number(v.kwh) * 1000) || (str(v.amountMinor) && amount !== Number(v.amountMinor))) throw new Error("Split does not add up");
  return { state: "ready", period: v.period as string, revision: v.revision as number, method: v.method as SplitMethod,
    kwh: v.kwh as string, amountMinor: v.amountMinor as string | null, rows: v.rows as SplitRow[] };
}

/**
 * The next-period split preview (MGT-90-AC4/AC5) for a later billing caller: the same admission as the page,
 * and the gateway repeats its own. Input mirrors the gateway: a month's first day, kWh with ≤3 decimals,
 * an optional amount in minor units. No UI shows it yet (not in the approved frame).
 */
export async function sharedMeterSplit(input: Session, split: SplitInput, deps: Deps = {}): Promise<SharedMeterSplit> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    const amount = split?.amountMinor ?? null;
    if (!split || !uuid(split.propertyId) || !day(split.period) || !str(split.kwh) || !KWH.test(split.kwh)
      || !(amount === null || (str(amount) && MINOR.test(amount) && BigInt(amount) <= BigInt("1000000000000000")))) return { state: "unavailable" };
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b109_shared_meter_split($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::date,$7::numeric,$8::bigint) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, split.propertyId, split.period, split.kwh, amount])).rows[0];
      if (!row) throw new Error("Missing shared meter split");
      return parseSharedMeterSplit(row.result);
    }, { isolation: "repeatable read" });
    return result ?? { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b109_shared_meter_split", error);
    return { state: "unavailable" };
  }
}
