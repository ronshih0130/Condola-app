import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-093 / OWN-35-AC1…AC3 (RO-DECIDED, 更多 › 核准紀錄). One admitted SQL snapshot per read:
 * the gateways repeat B-013 owner admission and the PR-015 current-owner rule themselves.
 */
export const DECISIONS = ["approved", "rejected", "more_information"] as const;
export type Decision = (typeof DECISIONS)[number];
export type DecidedCursor = { decidedAt: string; versionId: string };
export type DecidedLine = {
  ticketId: string; versionId: string; property: string; item: string;
  currency: string; minorUnit: number; amountMinor: string; decision: Decision; decidedAt: string; decidedOn: string;
};
export type DecidedVersion = {
  versionId: string; versionNo: string; currency: string; minorUnit: number; amountMinor: string;
  workScope: string; decision: Decision; reason: string | null; decidedAt: string; decidedOn: string;
};
export type DecidedTicket = { ticketId: string; property: string; item: string; status: string; versions: DecidedVersion[] };
type Closed = { state: "off" | "unavailable" | "forbidden" };
export type OwnerDecidedList = Closed | { state: "ready"; rows: DecidedLine[]; next: DecidedCursor | null };
export type OwnerDecidedTicket = Closed | { state: "ready"; detail: DecidedTicket };
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };

const PAGE = 20;
const day = /^\d{4}-\d{2}-\d{2}$/;
const str = (value: unknown): value is string => typeof value === "string";
const uuid = (value: unknown): value is string => str(value) && isUuid(value);
const instant = (value: unknown): value is string => str(value) && Number.isFinite(Date.parse(value));
const money = (row: Record<string, unknown>) => str(row.currency) && /^[A-Z]{3}$/.test(row.currency)
  && Number.isInteger(row.minorUnit) && (row.minorUnit as number) >= 0 && (row.minorUnit as number) <= 4
  && str(row.amountMinor) && /^[0-9]+$/.test(row.amountMinor);
const decided = (row: Record<string, unknown>) => DECISIONS.includes(row.decision as Decision)
  && instant(row.decidedAt) && str(row.decidedOn) && day.test(row.decidedOn);

/** svc rethrows DB errors through mapDbError, which keeps the SQLSTATE in `cause.code`. */
function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}

export function validCursor(value: unknown): value is DecidedCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return Object.keys(cursor).sort().join(",") === "decidedAt,versionId" && instant(cursor.decidedAt) && uuid(cursor.versionId);
}
/** `?after=` is `<ISO instant>_<version uuid>`: no person data in the URL. */
export function parseCursor(raw: unknown): DecidedCursor | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("_");
  const cursor = { decidedAt: raw.slice(0, at), versionId: raw.slice(at + 1) };
  return at > 0 && validCursor(cursor) ? cursor : null;
}
export const cursorParam = (cursor: DecidedCursor) => `${cursor.decidedAt}_${cursor.versionId}`;

function parseList(value: unknown): { rows: DecidedLine[]; next: DecidedCursor | null } {
  const result = value as { rows?: unknown; next?: unknown } | null;
  if (!result || !Array.isArray(result.rows) || (result.next !== null && !validCursor(result.next))) throw new Error("Invalid decided page");
  for (const row of result.rows as Record<string, unknown>[]) {
    if (!row || !uuid(row.ticketId) || !uuid(row.versionId) || !str(row.property) || !str(row.item) || !money(row) || !decided(row))
      throw new Error("Invalid decided line");
  }
  return { rows: result.rows as DecidedLine[], next: result.next as DecidedCursor | null };
}
function parseTicket(value: unknown, ticketId: string): DecidedTicket | null {
  if (value === null) return null;
  const detail = value as Record<string, unknown> | null;
  if (!detail || detail.ticketId !== ticketId || !str(detail.property) || !str(detail.item) || !str(detail.status)
    || !Array.isArray(detail.versions) || !detail.versions.length) throw new Error("Invalid decided ticket");
  for (const row of detail.versions as Record<string, unknown>[]) {
    if (!row || !uuid(row.versionId) || !str(row.versionNo) || !/^[1-9][0-9]*$/.test(row.versionNo) || !money(row)
      || !str(row.workScope) || !(row.reason === null || str(row.reason)) || !decided(row)) throw new Error("Invalid decided version");
  }
  return detail as DecidedTicket;
}

async function admit(input: Session, deps: Deps): Promise<Session | Closed> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  const session = await guardEffectiveSession(input, null);
  if (session.kind !== "owner" || !uuid(session.orgId) || !uuid(session.liveOrgId) || !uuid(session.sessionId)
    || !["live", "sandbox"].includes(session.environment)) return { state: "forbidden" };
  return session;
}

/** OWN-35-AC1: newest first, keyset paged; pending estimates never appear. */
export async function ownerDecidedList(input: Session, options: { after?: DecidedCursor | null; limit?: number } = {}, deps: Deps = {}): Promise<OwnerDecidedList> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    if (options.after === null || (options.after !== undefined && !validCursor(options.after))) throw new FlowError("errors.required");
    const limit = Math.max(1, Math.min(50, Math.trunc(Number.isFinite(options.limit) ? options.limit! : PAGE)));
    return await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b093_owner_decided($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::integer) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, options.after ?? null, limit],
      )).rows[0];
      return { state: "ready" as const, ...parseList(row?.result) };
    }, { isolation: "repeatable read" });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.required") throw error;
    if (sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden")) return { state: "forbidden" };
    logServerError("b093_owner_decided", error);
    return { state: "unavailable" };
  }
}

/** OWN-35-AC2/AC3: read-only view; another owner's or company's ticket is 403, never a partial view. */
export async function ownerDecidedTicket(input: Session, ticketId: string, deps: Deps = {}): Promise<OwnerDecidedTicket> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    if (!uuid(ticketId)) return { state: "forbidden" };
    const detail = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b093_owner_decided_ticket($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, ticketId],
      )).rows[0];
      if (!row) throw new Error("Missing decided ticket snapshot");
      return parseTicket(row.result, ticketId);
    }, { isolation: "repeatable read" });
    return detail ? { state: "ready", detail } : { state: "forbidden" };
  } catch (error) {
    if (sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden")) return { state: "forbidden" };
    logServerError("b093_owner_decided_ticket", error);
    return { state: "unavailable" };
  }
}
