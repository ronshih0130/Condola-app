import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-076a (narrow first slice of B-076) / mgr-history-direct, Round 7 batch 4 (MGT-76-AC3/AC12):
 * 物件與租客 › {租客} › 改號紀錄 for direct staff edits. One admitted SQL snapshot per page through
 * app.b076a_phone_history, which repeats its own admission (env/live tuple, live session, native
 * admin/manager, tenant_directory_edit, tenant contact) and masks every number before it leaves the DB.
 * OPEN: only B-015 staff edits are listed; tenant self-edit, imports and future OTP changes need their
 * own mapping later.
 */
export type PhoneHistoryRow = {
  id: string; occurredAt: string; at: string; status: "direct";
  actorRole: "admin" | "manager"; actorName: string | null; oldMasked: string | null; newMasked: string | null;
};
export type PhoneHistory =
  | { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; tenant: string; place: string | null; rows: PhoneHistoryRow[]; next: string | null };
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };

const PAGE = 20;
const str = (value: unknown): value is string => typeof value === "string";
const BIGINT_MAX = BigInt("9223372036854775807");
/** A positive signed-bigint audit row id; anything out of range is not an id. */
const id = (value: unknown): value is string => str(value) && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX;
/**
 * A masked number, exactly the gateway's three shapes: 09xx‑•••‑xxx (Taiwan mobile), •••‑•••‑xxx (other numbers
 * with at least 8 digits) or •••‑•••‑••• (anything shorter). A full number can never render.
 */
export const MASKED = /^(?:09[0-9]{2}‑•••‑[0-9]{3}|•••‑•••‑(?:[0-9]{3}|•••))$/;
const masked = (value: unknown) => value === null || (str(value) && MASKED.test(value));

function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}

/** `?after=` is an audit row id (a positive signed bigint); anything else, out of range included, falls back to the first page. */
export function parseAfter(raw: unknown): string | undefined {
  return id(raw) ? raw : undefined;
}

export function parsePhoneHistory(value: unknown): Omit<Extract<PhoneHistory, { state: "ready" }>, "state"> | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || !str(v.tenant) || !(v.place === null || str(v.place)) || !Array.isArray(v.rows)
    || !(v.next === null || id(v.next))) throw new Error("Invalid phone history");
  for (const row of v.rows as Record<string, unknown>[]) {
    if (!row || !id(row.id) || !str(row.occurredAt) || !Number.isFinite(Date.parse(row.occurredAt))
      || !str(row.at) || !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(row.at) || row.status !== "direct"
      || !["admin", "manager"].includes(row.actorRole as string) || !(row.actorName === null || str(row.actorName))
      || !masked(row.oldMasked) || !masked(row.newMasked) || Object.keys(row).length !== 8) throw new Error("Invalid phone history row");
  }
  return v as Omit<Extract<PhoneHistory, { state: "ready" }>, "state">;
}

/** MGT-76-AC3/AC12: newest first, keyset paged; P-ACC, P-MNT, other orgs, archived and non-tenant contacts are 403. */
export async function phoneHistory(input: Session, contactId: string, options: { after?: string } = {}, deps: Deps = {}): Promise<PhoneHistory> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
    // The tenant page's own gate (props.view), plus contact access for the numbers (tenants.contact).
    const session = await guardEffectiveSession(input, "props.view");
    assertPerm(session, "props.view");
    assertPerm(session, "tenants.contact");
    const native = session.customRole?.nativeRole ?? session.role;
    if (session.kind !== "staff" || !native || !["admin", "manager"].includes(native) || session.needsSandbox
      || !isUuid(contactId) || !isUuid(session.orgId) || !isUuid(session.liveOrgId) || !isUuid(session.sessionId)
      || !["live", "sandbox"].includes(session.environment)) return { state: "forbidden" };
    const after = options.after === undefined ? null : parseAfter(options.after) ?? null;
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b076a_phone_history($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::bigint,$7::integer) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, contactId, after, PAGE],
      )).rows[0];
      if (!row) throw new Error("Missing phone history snapshot");
      return parsePhoneHistory(row.result);
    }, { isolation: "repeatable read" });
    return result ? { state: "ready", ...result } : { state: "off" };
  } catch (error) {
    if (sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden")) return { state: "forbidden" };
    logServerError("b076a_phone_history", error);
    return { state: "unavailable" };
  }
}
