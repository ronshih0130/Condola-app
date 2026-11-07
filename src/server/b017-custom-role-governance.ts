/** Trusted DB-backed B017 authority. Never accept permissions from request bodies. */
import type { Client } from "pg";
import { svc, svcOn, withClient } from "./db";
import { FlowError } from "./errors";
import { b017ManagementEnabled, validateB017Keys } from "./b017-custom-role-policy";
import { can, type PermKey } from "./perms";
import { assertSeatAvailableOn, lockSeatOrganization } from "./seats";
import type { Session } from "./types";

export type B017Authority = { orgId: string; userId: string; sessionId: string; nativeRole: Session["role"]; assigned?: boolean; keys: readonly PermKey[] | null; photos: boolean; audit: boolean };

import { customRolesAdmitted } from "./b017-admission";
export { customRolesAdmitted } from "./b017-admission";

export async function customRolesEnabledOn(client: Client, orgId: string) {
  const row = (await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT f.value,o.feature_flags FROM organizations o JOIN platform_settings f ON f.key='custom_roles' WHERE o.id=$1`, [orgId],
  )).rows[0];
  return b017ManagementEnabled(orgId, {
    platformSettings: { custom_roles: row?.value }, organizationFlags: row?.feature_flags,
  });
}

/** Called on each authenticated request; OFF returns the original object unchanged. */
export async function resolveCustomRoleSessionOn(client: Client, session: Session): Promise<Session> {
  if (session.kind !== "staff" || !customRolesAdmitted(session.liveOrgId ?? session.orgId) || !await customRolesEnabledOn(client, session.liveOrgId ?? session.orgId)) {
    if (!session.customRole) return session;
    const { customRole: _old, ...native } = session; void _old;
    const current = await svcOn(client, session.userId, async c => (await c.query<{authority:{enabled:boolean;nativeRole:Session["role"]}}>(
      "SELECT public.b017_resolve($1,$2,$3) AS authority", [session.liveOrgId ?? session.orgId,session.userId,session.sessionId])).rows[0].authority);
    if (current.enabled) throw new FlowError("errors.forbidden");
    return {...native,role:current.nativeRole ?? null};
  }
  const result = await svcOn(client, session.userId, async c => (await c.query<{
    authority: { enabled: boolean; keys: PermKey[] | null; photos?: boolean; audit?: boolean; assigned?: boolean; nativeRole?: Session["role"] };
  }>(`SELECT public.b017_resolve($1,$2,$3) AS authority`, [session.liveOrgId ?? session.orgId, session.userId, session.sessionId])).rows[0].authority);
  // If the flag switched OFF between reads, discard any previously resolved policy.
  if (!result.enabled) { const { customRole: _old, ...native } = session; void _old; return { ...native, role: result.nativeRole ?? null }; }
  return { ...session, role: result.nativeRole ?? session.role,
    customRole: { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId, nativeRole: result.nativeRole ?? session.role, assigned: result.assigned, keys: result.keys, photos: result.photos === true, audit: result.audit === true } };
}
export function resolveCustomRoleSession(session: Session) {
  if (!customRolesAdmitted(session.liveOrgId ?? session.orgId) && !session.customRole) return Promise.resolve(session);
  return withClient(client => resolveCustomRoleSessionOn(client, session));
}

type Command =
  | { operation: "create"; grants: unknown; requestId: string }
  | { operation: "revise"; roleId: string; grants: unknown; requestId: string }
  | { operation: "retire"; roleId: string; requestId: string }
  | { operation: "assign"; roleId: string; memberId: string; requestId: string }
  | { operation: "unassign"; memberId: string; requestId: string };
export type GovernanceResult = { roleId: string | null; revision: number | null; operation: Command["operation"] };

export async function governCustomRole(session: Session, input: Command): Promise<GovernanceResult> {
  const actor = await resolveCustomRoleSession(session);
  if (actor.kind !== "staff" || actor.role !== "admin" || !actor.customRole || !can(actor, "team.manage")) {
    throw new FlowError("errors.forbidden");
  }
  // Static input shape cannot invalidate a successful receipt. Current ceilings
  // and target lifecycle must only be checked by SQL after authorized replay.
  if ("grants" in input && !validateB017Keys(input.grants).ok) throw new FlowError("errors.forbidden");
  // Assign/unassign ceilings use locked current role/member authority inside SQL.
  const args: unknown[] = [actor.orgId, actor.userId, actor.sessionId, input.requestId];
  let sql: string;
  switch (input.operation) {
    case "create": args.push(input.grants); sql = "SELECT public.b017_create_role($1,$2,$3,$4,$5) AS result"; break;
    case "revise": args.push(input.roleId, input.grants); sql = "SELECT public.b017_revise_role($1,$2,$3,$4,$5,$6) AS result"; break;
    case "retire": args.push(input.roleId); sql = "SELECT public.b017_retire_role($1,$2,$3,$4,$5) AS result"; break;
    case "assign": args.push(input.roleId, input.memberId); sql = "SELECT public.b017_assign_role($1,$2,$3,$4,$5,$6) AS result"; break;
    case "unassign": args.push(input.memberId); sql = "SELECT public.b017_unassign_role($1,$2,$3,$4,$5) AS result"; break;
  }
  return svc(actor.userId, async client => {
    try {
      return (await client.query<{ result: GovernanceResult }>(sql, args)).rows[0].result;
    } catch (error) { return governanceError(error); }
  });
}

function governanceError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === "42501" && String(error).includes("B017 cross-base grants deferred")) throw new FlowError("errors.customRoleNativeCeiling");
  if (code === "42501" || code === "22023" || code === "55P03") throw new FlowError("errors.forbidden");
  throw error;
}

/** Legacy OFF caller returns false, leaving its original statements intact. */
export async function changeCustomRoleMember(session: Session, memberId: string, change: { role?: Session["role"]; active?: boolean }) {
  const actor = await resolveCustomRoleSession(session);
  if (!actor.customRole) return false;
  if (actor.kind !== "staff" || actor.role !== "admin" || !can(actor, "team.manage")) throw new FlowError("errors.forbidden");
  await svc(actor.userId, async client => {
    try {
      // Flag admission precedes the seat/org lock, then SQL takes the remaining locks.
      await client.query("SELECT 1 FROM platform_settings WHERE key='custom_roles' FOR SHARE");
      const org = await lockSeatOrganization(client, actor.orgId);
      if (change.active === true) {
        const current = (await client.query<{ status: string }>("SELECT status::text FROM org_members WHERE org_id=$1 AND id=$2", [actor.orgId, memberId])).rows[0];
        if (current && current.status !== "active") await assertSeatAvailableOn(client, actor.orgId, org, false);
      }
      await client.query("SELECT public.b017_change_member($1,$2,$3,$4,$5,$6)",
        [actor.orgId,actor.userId,actor.sessionId,memberId,change.role ?? null,change.active === undefined ? null : change.active ? "active" : "suspended"]);
    } catch (error) { governanceError(error); }
  });
  return true;
}

/** Existing transaction only: no BEGIN/COMMIT and no cached permission decision.
 * SQL locks durable authority through the caller's commit. Native OFF is a no-op.
 */
export async function requireEffectivePerm(client: Pick<Client, "query">, session: Pick<Session, "kind" | "orgId" | "userId" | "sessionId" | "customRole" | "liveOrgId">, key: PermKey | null, photos = false) {
  if (session.kind !== "staff" || (!session.customRole && !customRolesAdmitted(session.liveOrgId ?? session.orgId))) return;
  if (!session.customRole && !await customRolesEnabledOn(client as Client, session.liveOrgId ?? session.orgId)) return;
  const role = (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0].role;
  try {
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SELECT public.b017_authorize($1,$2,$3,$4,$5)",
      [session.liveOrgId ?? session.orgId, session.userId, session.sessionId, key, photos]);
  } catch (error) { governanceError(error); }
  // Both roles are fixed identifiers, never derived from request data.
  if (role === "authenticated") await client.query("SET LOCAL ROLE authenticated");
  else if (role !== "service_role") await client.query("RESET ROLE");
}

export const assertCustomAuthorityOn = requireEffectivePerm;

/** Revalidate a native-role-only reader in its existing read snapshot. */
export async function customAuthorityAllowsOn(client: Client, session: Session, key: PermKey | null): Promise<boolean> {
  if (session.kind !== "staff" || (!session.customRole && !customRolesAdmitted(session.liveOrgId ?? session.orgId))) return true;
  const role = (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0].role;
  await client.query("SET LOCAL ROLE service_role");
  const authority = (await client.query<{ authority: { enabled: boolean; assigned?: boolean; keys: PermKey[] | null; nativeRole?: Session["role"] } }>(
    "SELECT public.b017_resolve($1,$2,$3) AS authority", [session.liveOrgId ?? session.orgId,session.userId,session.sessionId])).rows[0].authority;
  if (role === "authenticated") await client.query("SET LOCAL ROLE authenticated");
  else if (role !== "service_role") await client.query("RESET ROLE");
  return key === null ? authority.keys !== null && authority.assigned !== true : can(authority.nativeRole, key) && authority.keys?.includes(key) === true;
}

/** Every request entry supplies a key. null deliberately denies unmapped staff
 * operations when custom roles are enabled; portal authority stays native. */
export async function guardEffectiveSession<T extends Session | null | undefined>(session: T, key: PermKey | null): Promise<T> {
  if (!session || session.kind !== "staff" || (!session.customRole && !customRolesAdmitted(session.liveOrgId ?? session.orgId))) return session;
  const current = await resolveCustomRoleSession(session);
  if (current.customRole || session.customRole) {
    if (key === null ? !!current.customRole && current.customRole.assigned !== false : !can(current, key)) throw new FlowError("errors.forbidden");
  }
  return current as T;
}

/** The caller owns BEGIN/COMMIT. Validate after all business waits and before
 * returning either a receipt or new data; SQL retains authority until COMMIT.
 * A changed authority rolls back every write in this transaction. */
export async function withEffectiveAuthority<T>(client: import("pg").Client, session: Session, key: PermKey | null, operation: () => Promise<T>, contactData = false): Promise<T> {
  const result = await operation();
  if (session.kind === "staff" && (session.customRole || customRolesAdmitted(session.liveOrgId ?? session.orgId))) {
    if (!session.customRole && !await customRolesEnabledOn(client, session.liveOrgId ?? session.orgId)) return result;
    const readOnly = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
    if (readOnly) {
      if (!await customAuthorityAllowsOn(client, session, key)) throw new FlowError("errors.forbidden");
    } else await requireEffectivePerm(client, session, key);
    if (contactData && !await customAuthorityAllowsOn(client, session, "tenants.contact")) return maskContactFields(result);
  }
  return result;
}

/** Fixed DTO fields only; never search results after pagination. Search predicates
 * are gated separately before SQL evaluates counts and page membership. */
export function maskContactFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(maskContactFields) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(email|phone|phone_e164|tenant_phone|owner_phone|owner_email|line_user_id)$/.test(key) ? null : maskContactFields(item)])) as T;
  }
  return value;
}

/** Reader-only transaction: establish one snapshot before its first business query.
 * OFF executes the original callback with no extra statement or changed BEGIN.
 */
export async function withEffectiveReadAuthority<T>(client: Client, session: Session, key: PermKey | null, operation: () => Promise<T>, contactData = false): Promise<T> {
  if (session.kind !== "staff" || (!session.customRole && !customRolesAdmitted(session.liveOrgId))) return operation();
  await client.query("SET TRANSACTION READ ONLY");
  if (!await customAuthorityAllowsOn(client, session, key)) throw new FlowError("errors.forbidden");
  const result = await operation();
  return contactData && !await customAuthorityAllowsOn(client, session, "tenants.contact") ? maskContactFields(result) : result;
}

export function effectiveReadOptions(session: Session) {
  return session.customRole ? { isolation: "repeatable read" as const, readOnly: true } : undefined;
}
