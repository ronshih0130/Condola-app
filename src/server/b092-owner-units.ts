import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-092 OWN-UNITS (OWN-33-AC1/AC4, RO-UNITS; OQ-095). One admitted SQL snapshot per read: the gateway repeats
 * B-013 owner admission and the PR-015 org-local current-owner rule per property itself. brand_v3 gates the
 * presentation. The tenant name is null when the company hides names (MGT-138); phones are never returned.
 */
export const UNIT_STATUSES = ["paid", "partial", "overdue", "vacant", "none"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
export type OwnerUnitRow = {
  propertyId: string; property: string; unitId: string; roomId: string | null; space: string;
  tenant: string | null; rentMinor: string | null; currency: string | null; status: UnitStatus;
  remainingMinor: string | null; vacantDays: number | null;
};
export type OwnerUnits = { state: "off" | "forbidden" | "unavailable" } | { state: "ready"; rows: OwnerUnitRow[] };
export type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };

const str = (v: unknown): v is string => typeof v === "string";
const uuid = (v: unknown): v is string => str(v) && isUuid(v);
const minor = (v: unknown) => v === null || (str(v) && /^(0|[1-9][0-9]{0,18})$/.test(v));
export function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}

/** Strict parse: any unexpected shape is a read failure, never a guessed row. */
export function parseOwnerUnits(value: unknown): OwnerUnitRow[] {
  const v = value as { rows?: unknown } | null;
  if (!v || !Array.isArray(v.rows)) throw new Error("Invalid owner units");
  const keys = ["currency", "property", "propertyId", "remainingMinor", "rentMinor", "roomId", "space", "status", "tenant", "unitId", "vacantDays"];
  for (const r of v.rows as Record<string, unknown>[]) {
    // Exact key set: an extra field (a phone, say) is a read failure, never passed through.
    if (!r || typeof r !== "object" || Object.keys(r).sort().join() !== keys.join()) throw new Error("Invalid owner unit row");
    const status = r.status as UnitStatus;
    const vacant = status === "vacant";
    if (!r || !uuid(r.propertyId) || !str(r.property) || !uuid(r.unitId) || !(r.roomId === null || uuid(r.roomId)) || !str(r.space)
      || !UNIT_STATUSES.includes(status) || !(r.tenant === null || str(r.tenant)) || !minor(r.rentMinor) || !minor(r.remainingMinor)
      || !(r.currency === null || (str(r.currency) && /^[A-Z]{3}$/.test(r.currency)))
      || (vacant ? !(Number.isInteger(r.vacantDays) && (r.vacantDays as number) >= 0) || r.rentMinor !== null || r.tenant !== null : r.vacantDays !== null || r.rentMinor === null || r.currency === null)
      || ((status === "partial") !== (r.remainingMinor !== null)) || r.remainingMinor === "0")
      throw new Error("Invalid owner unit row");
  }
  return v.rows as OwnerUnitRow[];
}

export async function admit(input: Session, deps: Deps): Promise<Session | { state: "off" | "forbidden" }> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  const session = await guardEffectiveSession(input, null);
  if (session.kind !== "owner" || !uuid(session.orgId) || !uuid(session.liveOrgId) || !uuid(session.sessionId)
    || !["live", "sandbox"].includes(session.environment)) return { state: "forbidden" };
  return session;
}

/** OWN-33-AC1/AC4: one line per authorised unit or room; unauthorised spaces are absent. */
export async function ownerUnits(input: Session, deps: Deps = {}): Promise<OwnerUnits> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    return await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b092_owner_units($1::uuid,$2::uuid,$3::text,$4::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId])).rows[0];
      return { state: "ready" as const, rows: parseOwnerUnits(row?.result) };
    }, { isolation: "repeatable read" });
  } catch (error) {
    if (sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden")) return { state: "forbidden" };
    logServerError("b092_owner_units", error);
    return { state: "unavailable" };
  }
}
