import { guardEffectiveSession } from "./b017-custom-role-governance";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-059 / DO-3 單位分派（僅維修人員） (MGT-118-AC1…AC8; GS-24, GS-46; Round 7 frames 「設定・單位分派」 and
 * 「負責的單位・{名字}」). One service-only gateway call per read or save: app.b059_assign_view / _save repeat their
 * own admission (env/live tuple, live session, maint_unit_assign, native admin or manager, the target is a
 * maintenance member or a pending maintenance invitation of this organization). brand_v3 and maint_unit_assign gate
 * the pages and the API (404 for every role while OFF). Ticket visibility (AC3/AC4/AC5) is not here: it is the
 * RESTRICTIVE policy b059_maint_unit_scope on maintenance_tickets, so every existing ticket reader keeps its query
 * text byte for byte. Nothing here sends anything.
 */
export type AssignPersonKind = "member" | "invite";
export type AssignPerson = { id: string; kind: AssignPersonKind; name: string; units: number };
export type AssignUnit = { id: string; property: string; label: string; checked: boolean };
export type AssignList =
  | { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; people: AssignPerson[] };
export type AssignEdit =
  | { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; person: Omit<AssignPerson, "units">; units: AssignUnit[] };
/** POST /api/maint-unit-assign answers this as its HTTP status (409 = the request id was reused for another payload). */
export type AssignSaveResult =
  | { ok: true; status: "saved" | "unchanged"; units: number; replayed: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500 };
export const ASSIGN_MAX_UNITS = 2000;
/** The API body cap: 2,000 unit ids (39 bytes each in JSON) plus the envelope. */
export const ASSIGN_BODY_LIMIT = 96 * 1024;

type Deps = { transaction?: typeof svc };

const str = (value: unknown): value is string => typeof value === "string";
const uuid = (value: unknown): value is string => str(value) && isUuid(value);
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The gateways' predicate (org override + platform enabled + allowlist). A failed read THROWS. */
export async function maintUnitAssignFlagOn(orgId: string): Promise<boolean> {
  if (!uuid(orgId)) return false;
  return svc(null, async client => (await client.query<{ on: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='maint_unit_assign'
       WHERE o.id=$1 AND o.feature_flags->'maint_unit_assign'='true'::jsonb
         AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
         AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS on`, [orgId])).rows[0]?.on === true);
}

/** Pages, the API and the nav: fail closed (a lookup failure is OFF, so the route is a 404 and the row is hidden). */
export async function maintUnitAssignEnabledForOrg(orgId: string | null | undefined,
  lookup: (orgId: string) => Promise<boolean> = maintUnitAssignFlagOn): Promise<boolean> {
  if (!orgId) return false;
  try {
    return (await lookup(orgId)) === true;
  } catch {
    return false;
  }
}

/** props.edit is admin + manager; then the native role must be admin or manager (MGT-118-AC1; accountants and
 *  maintenance are refused, AC7). Throws errors.forbidden for a custom role without props.edit; null otherwise. */
async function admit(input: Session): Promise<Session | null> {
  const session = await guardEffectiveSession(input, "props.edit");
  assertPerm(session, "props.edit");
  const native = session.customRole?.nativeRole ?? session.role;
  if (session.kind !== "staff" || !native || !["admin", "manager"].includes(native) || !uuid(session.orgId)
    || !uuid(session.liveOrgId) || !uuid(session.sessionId) || !["live", "sandbox"].includes(session.environment)) return null;
  return session;
}

/** The API's 403 check before the body (never reads the body or any assignment data). */
export async function authorizeAssign(input: Session): Promise<Session | null> {
  try {
    return await admit(input);
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return null;
    throw error;
  }
}

function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}
const denied = (error: unknown) => sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden");

export function parseAssignList(value: unknown): AssignPerson[] | null {
  if (value === null || value === undefined) return null;
  const v = value as { people?: unknown };
  if (!v || typeof v !== "object" || !Array.isArray(v.people)) throw new Error("Invalid unit assignment list");
  return v.people.map(p => {
    const row = p as Record<string, unknown>;
    if (!row || !uuid(row.id) || !["member", "invite"].includes(row.kind as string) || !str(row.name) || !count(row.units))
      throw new Error("Invalid unit assignment person");
    return { id: row.id, kind: row.kind as AssignPersonKind, name: row.name, units: row.units };
  });
}

export function parseAssignEdit(value: unknown): Omit<Extract<AssignEdit, { state: "ready" }>, "state"> | null {
  if (value === null || value === undefined) return null;
  const v = value as { person?: Record<string, unknown>; units?: unknown };
  const p = v?.person;
  if (!v || typeof v !== "object" || !p || !uuid(p.id) || !["member", "invite"].includes(p.kind as string) || !str(p.name)
    || !Array.isArray(v.units)) throw new Error("Invalid unit assignment person");
  const units = v.units.map(u => {
    const row = u as Record<string, unknown>;
    if (!row || !uuid(row.id) || !str(row.property) || !str(row.label) || typeof row.checked !== "boolean") throw new Error("Invalid unit assignment unit");
    return { id: row.id, property: row.property, label: row.label, checked: row.checked };
  });
  return { person: { id: p.id, kind: p.kind as AssignPersonKind, name: p.name }, units };
}

async function readView(session: Session, target: string | null, deps: Deps): Promise<unknown> {
  return (deps.transaction ?? svc)(session.userId, async client => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
    const row = (await client.query<{ result: unknown }>(
      "SELECT app.b059_assign_view($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result",
      [session.orgId, session.liveOrgId, session.environment, session.sessionId, target])).rows[0];
    if (!row) throw new Error("Missing unit assignment snapshot");
    return row.result;
  }, { isolation: "repeatable read" });
}

/** 設定 › 單位分派: one row per maintenance person with 「已分派 {n} 個單位」 (MGT-118-AC1, AC6 when empty). */
export async function assignList(input: Session, deps: Deps = {}): Promise<AssignList> {
  try {
    const session = await admit(input);
    if (!session) return { state: "forbidden" };
    const people = parseAssignList(await readView(session, null, deps));
    return people ? { state: "ready", people } : { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b059_assign_list", error);
    return { state: "unavailable" };
  }
}

/** 負責的單位・{名字}: every unit of the organization, checked when assigned (MGT-118-AC1). Unknown or not a
 *  maintenance person of this organization (AC2) is forbidden, never a different person's page. */
export async function assignEdit(input: Session, target: string, deps: Deps = {}): Promise<AssignEdit> {
  try {
    const session = await admit(input);
    if (!session) return { state: "forbidden" };
    if (!uuid(target)) return { state: "forbidden" };
    const edit = parseAssignEdit(await readView(session, target, deps));
    return edit ? { state: "ready", ...edit } : { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b059_assign_edit", error);
    return { state: "unavailable" };
  }
}

/** The JSON body `{ requestId, target, units }`; anything else is 400 before the database. */
export function parseAssignBody(value: unknown): { requestId: string; target: string; units: string[] } | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.join(",") !== "requestId,target,units") return null;
  if (!uuid(v.requestId) || !uuid(v.target) || !Array.isArray(v.units) || v.units.length > ASSIGN_MAX_UNITS || !v.units.every(uuid)
    || new Set(v.units).size !== v.units.length) return null;
  return { requestId: v.requestId, target: v.target, units: v.units as string[] };
}

/** MGT-118-AC1 save (AC8: the page keeps the user's checks on any failure). Admission is repeated here (the route
 *  already answered 403 before reading the body), then the gateway repeats it on locked rows. */
export async function saveAssign(input: Session, value: unknown, deps: Deps = {}): Promise<AssignSaveResult> {
  try {
    const session = await admit(input);
    if (!session) return { ok: false, status: 403 };
    const body = parseAssignBody(value);
    if (!body) return { ok: false, status: 400 };
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      return (await client.query<{ result: Record<string, unknown> | null }>(
        "SELECT app.b059_assign_save($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid[]) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, body.requestId, body.target, body.units],
      )).rows[0]?.result ?? null;
    });
    const status = result?.status;
    if ((status === "saved" || status === "unchanged") && count(result?.units) && typeof result?.replayed === "boolean")
      return { ok: true, status, units: result.units as number, replayed: result.replayed as boolean };
    if (status === "disabled") return { ok: false, status: 404 };
    if (status === "invalid") return { ok: false, status: 400 };
    if (status === "conflict") return { ok: false, status: 409 };
    logServerError("b059_assign_save", new Error(`Unexpected unit assignment result ${String(status)}`));
    return { ok: false, status: 500 };
  } catch (error) {
    if (denied(error)) return { ok: false, status: 403 };
    logServerError("b059_assign_save", error);
    return { ok: false, status: 500 };
  }
}
