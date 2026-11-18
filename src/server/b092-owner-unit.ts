import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { isUuid } from "./repair-rules";
import { admit, sqlDenied, type Deps } from "./b092-owner-units";
import type { Session } from "./types";

/**
 * B-092 RO-UNIT (OWN-33-AC2/AC4; frame 「總覽・我的物件・信義路 2 樓」). One admitted SQL snapshot of ONE authorised
 * space: the gateway repeats B-013 owner admission and the PR-015 org-local current-owner rule and refuses a space
 * the owner is not authorised for (42501 → forbidden). brand_v3 gates the presentation. The tenant name is null when
 * the company hides names (MGT-138); the phone is null unless the company phone switch AND the owner's own
 * property_owners row both allow it (the legacy owner page rule). Never an email.
 */
export const MONTH_STATUSES = ["paid", "partial", "overdue", "none"] as const;
export type MonthStatus = (typeof MONTH_STATUSES)[number];
/** Open ticket statuses only: the gateway never returns resolved, closed or cancelled repairs. */
export const OPEN_REPAIR_STATUSES = ["open", "triaged", "assigned", "in_progress", "on_hold"] as const;
export type OpenRepairStatus = (typeof OPEN_REPAIR_STATUSES)[number];
export type OwnerUnitMonth = { month: string; status: MonthStatus; remainingMinor: string | null };
export type OwnerUnitRepair = { id: string; title: string; status: OpenRepairStatus };
export type OwnerUnitDetail = {
  property: string; space: string; vacant: boolean; tenant: string | null; phone: string | null;
  startDate: string | null; endDate: string | null; rentMinor: string | null; currency: string | null;
  months: OwnerUnitMonth[]; repairs: OwnerUnitRepair[];
};
export type OwnerUnit = { state: "off" | "forbidden" | "unavailable" } | { state: "ready"; unit: OwnerUnitDetail };

const str = (v: unknown): v is string => typeof v === "string";
const minor = (v: unknown): v is string => str(v) && /^(0|[1-9][0-9]{0,18})$/.test(v);
const date = (v: unknown): v is string => str(v) && /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const KEYS = ["currency", "endDate", "months", "phone", "property", "rentMinor", "repairs", "space", "startDate", "tenant", "vacant"];
const bad = (): never => { throw new Error("Invalid owner unit"); };

/** Strict parse: exact key sets everywhere; any unexpected shape is a read failure, never passed through. */
export function parseOwnerUnit(value: unknown): OwnerUnitDetail {
  if (!exact(value, KEYS)) return bad();
  const v = value;
  if (!str(v.property) || !str(v.space) || typeof v.vacant !== "boolean" || !Array.isArray(v.months) || !Array.isArray(v.repairs)) return bad();
  if (!(v.tenant === null || str(v.tenant)) || !(v.phone === null || (str(v.phone) && /^\+[1-9][0-9]{6,14}$/.test(v.phone)))) return bad();
  if (v.vacant) {
    if ([v.tenant, v.phone, v.startDate, v.endDate, v.rentMinor, v.currency].some(x => x !== null) || v.months.length || v.repairs.length) return bad();
  } else if (!date(v.startDate) || !(v.endDate === null || date(v.endDate)) || !minor(v.rentMinor)
    || !(str(v.currency) && /^[A-Z]{3}$/.test(v.currency))) return bad();
  if (v.months.length > 6 || v.repairs.length > 5) return bad();
  const seen = new Set<string>();
  for (const m of v.months as unknown[]) {
    if (!exact(m, ["month", "remainingMinor", "status"]) || !str(m.month) || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(m.month) || seen.has(m.month)
      || !MONTH_STATUSES.includes(m.status as MonthStatus)
      || ((m.status === "partial") !== (m.remainingMinor !== null)) || !(m.remainingMinor === null || (minor(m.remainingMinor) && m.remainingMinor !== "0")))
      return bad();
    seen.add(m.month);
  }
  for (const r of v.repairs as unknown[])
    if (!exact(r, ["id", "status", "title"]) || !(str(r.id) && isUuid(r.id)) || !str(r.title)
      || !OPEN_REPAIR_STATUSES.includes(r.status as OpenRepairStatus)) return bad();
  return v as unknown as OwnerUnitDetail;
}

/** OWN-33-AC2/AC4: one authorised space; another owner's or an unknown space is forbidden (403). */
export async function ownerUnit(input: Session, unitId: unknown, roomId: unknown, deps: Deps = {}): Promise<OwnerUnit> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    if (!(str(unitId) && isUuid(unitId)) || !(roomId === null || (str(roomId) && isUuid(roomId)))) return { state: "forbidden" };
    return await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b092_owner_unit($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, unitId, roomId])).rows[0];
      return { state: "ready" as const, unit: parseOwnerUnit(row?.result) };
    }, { isolation: "repeatable read" });
  } catch (error) {
    if (sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden")) return { state: "forbidden" };
    logServerError("b092_owner_unit", error);
    return { state: "unavailable" };
  }
}
