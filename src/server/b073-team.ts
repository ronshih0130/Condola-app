import { guardEffectiveSession } from "./b017-custom-role-governance";
import { FlowError, logServerError } from "./errors";
import { assertPerm, can, PERMS, ROLE_KEYS, type PermKey } from "./perms";
import type { OrgRole, Session } from "./types";

/**
 * B-073 / R5-TEAM + R5-FULL (設定 › 團隊, MGT-133 AC1, AC3–AC8). Today's data only: the B-040 team list
 * (`listTeam`), seats as `seats.ts` counts them (active members + unexpired pending invitations), the plan's seat
 * limit as the B-040 page computes it (none in sandbox), the B-056 trial pause (`app.b056_member_paused`, constant
 * false while pricing_trial is OFF) and the existing company 2FA rule (`organizations.settings.require_2fa`, the
 * same value `setRequireMfa` writes). Admin only (`team.manage`); the 2FA card also needs `settings.edit`, as on
 * 我的帳號 today. Nothing here sends anything.
 */
export type TeamStatus = "active" | "invited" | "paused" | "disabled";
export type TeamRowV3 = {
  key: string;
  memberId: string | null;
  invitationId: string | null;
  name: string;
  /** Shown under the name; null when the name already is the address (invitations carry no separate name). */
  contact: string | null;
  role: OrgRole;
  status: TeamStatus;
  /** A pending invitation that has not expired (the only kind 重寄邀請 can rotate). */
  inviteLive: boolean;
  self: boolean;
  lastAdmin: boolean;
};
export type TeamSeats = { used: number; limit: number | null };
/** How invitations work for this session today (the B-040 page's gate, passed in by the route). */
export type TeamInvites = "live" | "legacy" | "closed";
export type TeamRead =
  | { state: "forbidden" | "unavailable" }
  | { state: "ready"; rows: TeamRowV3[]; seats: TeamSeats; full: boolean; security: { required: boolean } | null };

type ListedMember = { member_id: string | null; invitation_id: string | null; name: string; email: string | null; role: string; status: string; expires_at: string | null; user_id: string | null };
type Deps = {
  list?: (session: Session) => Promise<ListedMember[]>;
  usage?: (orgId: string) => Promise<{ used: number }>;
  tier?: (orgId: string) => Promise<string>;
  limit?: (tier: string) => number | null;
  paused?: (orgId: string) => Promise<ReadonlySet<string>>;
  require2fa?: (orgId: string) => Promise<boolean>;
  now?: () => number;
};

/** Active members whom the B-056 trial pause keeps out (MGT-99-AC5). Owning login, as `resolveStaffOrg` calls it. */
async function readPaused(orgId: string): Promise<ReadonlySet<string>> {
  const { query } = await import("./db");
  const rows = await query<{ user_id: string }>(
    `SELECT m.user_id::text AS user_id FROM org_members m
      WHERE m.org_id = $1 AND m.status = 'active' AND app.b056_member_paused(m.org_id, m.user_id)`,
    [orgId],
  );
  return new Set(rows.rows.map(row => row.user_id));
}
/** This company's own rule (not `firmRequiresMfa`, which is about the signed-in person across companies). */
async function readRequire2fa(orgId: string): Promise<boolean> {
  const { query } = await import("./db");
  const row = await query<{ required: boolean }>(
    `SELECT coalesce(settings->>'require_2fa', 'false') = 'true' AS required FROM organizations WHERE id = $1`, [orgId]);
  if (!row.rows[0]) throw new Error("organization not found");
  return row.rows[0].required === true;
}
const ROLES = new Set<string>(ROLE_KEYS);

/** Pure: today's rows → R5-TEAM rows. Revoked/removed invitations are not colleagues and are left out. */
export function teamRows(listed: readonly ListedMember[], session: Pick<Session, "userId">, paused: ReadonlySet<string>, now: number): TeamRowV3[] {
  const activeAdmins = listed.filter(member => member.member_id && member.role === "admin" && member.status === "active").length;
  return listed.flatMap((member): TeamRowV3[] => {
    if (!ROLES.has(member.role)) return [];
    const role = member.role as OrgRole;
    let status: TeamStatus;
    if (member.member_id && member.status === "active") status = member.user_id && paused.has(member.user_id) ? "paused" : "active";
    else if (member.member_id && member.status === "suspended") status = "disabled";
    else if (member.invitation_id && member.status === "pending") status = "invited";
    else return [];
    const email = member.email?.trim() || null;
    const name = member.name?.trim() || email || "";
    return [{
      key: member.member_id ?? member.invitation_id ?? name,
      memberId: member.member_id, invitationId: member.invitation_id,
      name, contact: email && email !== name ? email : null, role, status,
      inviteLive: status === "invited" && !!member.expires_at && new Date(member.expires_at).getTime() > now,
      self: !!member.user_id && member.user_id === session.userId,
      lastAdmin: member.member_id !== null && role === "admin" && member.status === "active" && activeAdmins <= 1,
    }];
  });
}

/** The B-040 page's seat cap: none in sandbox, else the plan's limit (Free 1, Standard 5, Premium none). */
export function teamSeats(used: number, limit: number | null, environment: Session["environment"]): TeamSeats {
  return { used, limit: environment === "sandbox" ? null : limit };
}
export const seatsFull = (seats: TeamSeats) => seats.limit !== null && seats.used >= seats.limit;

const forbidden = (error: unknown) => (error instanceof FlowError && error.key === "errors.forbidden")
  || ((error as { code?: string } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code) === "42501";

export async function teamRead(session: Session, deps: Deps = {}): Promise<TeamRead> {
  try {
    session = await guardEffectiveSession(session, "team.manage");
    assertPerm(session, "team.manage");
    const security = can(session, "settings.edit");
    const [listed, usage, tier, paused, required] = await Promise.all([
      deps.list ? deps.list(session) : import("./queries").then(m => m.listTeam(session)),
      deps.usage ? deps.usage(session.orgId) : import("./seats").then(m => m.seatUsage(session.orgId)),
      deps.tier ? deps.tier(session.orgId) : import("./seats").then(m => m.commercialTier(session.orgId)),
      (deps.paused ?? readPaused)(session.orgId),
      security ? (deps.require2fa ?? readRequire2fa)(session.orgId) : Promise.resolve(false),
    ]);
    const limit = deps.limit ?? (await import("./billing")).seatLimit;
    const seats = teamSeats(usage.used, limit(tier), session.environment);
    return {
      state: "ready", rows: teamRows(listed, session, paused, (deps.now ?? Date.now)()), seats, full: seatsFull(seats),
      security: security ? { required } : null,
    };
  } catch (error) {
    if (forbidden(error)) return { state: "forbidden" };
    logServerError("b073_team_read", error);
    return { state: "unavailable" };
  }
}

/** What each row offers. `primary` is the visible text action; `more` lists what 「更多」 opens (today's B-040 actions). */
export type TeamRowAction = "role" | "deactivate" | "reactivate" | "revoke" | "locked-self" | "locked-last-admin";
export type TeamRowActions = { primary: "resend-link" | "resend-legacy" | null; more: TeamRowAction[] };
export function teamRowActions(row: TeamRowV3, context: { invites: TeamInvites; full: boolean }): TeamRowActions {
  if (row.status === "invited") {
    // 重寄邀請 rotates the link only where today's page can (live link button or legacy resend); never sends mail.
    const primary = !row.inviteLive || context.invites === "closed" ? null : context.invites === "live" ? "resend-link" : "resend-legacy";
    return { primary, more: ["revoke"] };
  }
  if (row.status === "disabled") return { primary: null, more: context.full ? [] : ["reactivate"] };
  if (row.self) return { primary: null, more: ["locked-self"] };
  if (row.lastAdmin) return { primary: null, more: ["locked-last-admin"] };
  // MGT-133-AC6: a paused row has nothing that would bypass the plan (no role change); 停用 frees a seat.
  return { primary: null, more: row.status === "paused" ? ["deactivate"] : ["role", "deactivate"] };
}

/** MGT-133-AC3: the read-only four roles × permissions table, generated from `perms.ts` (never hand-written). */
export type TeamMatrixRow = { key: PermKey; label: string; roles: Record<OrgRole, boolean> };
export function teamPermissionMatrix(): TeamMatrixRow[] {
  return PERMS.map(([key, label, roles]) => ({
    key, label,
    roles: Object.fromEntries(ROLE_KEYS.map(role => [role, (roles as readonly string[]).includes(role)])) as Record<OrgRole, boolean>,
  }));
}

/** POST /api/team-security answers this as its HTTP status. 403 = not allowed (MGT-133-AC8); 400 = bad input. */
export type TeamSecuritySaveResult = { ok: true; required: boolean } | { ok: false; status: 400 | 403 | 500 };
type SaveDeps = { write?: (session: Session, required: boolean) => Promise<void>; read?: (orgId: string) => Promise<boolean> };
/**
 * MGT-133-AC7: the company 2FA rule with its existing behaviour — `setRequireMfa` (settings.edit guard, the same
 * settings key and its `require_2fa` audit row), then the stored value is read back for the switch.
 */
export async function saveTeamSecurity(session: Session, input: unknown, deps: SaveDeps = {}): Promise<TeamSecuritySaveResult> {
  const value = input as { required?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.required !== "boolean")
    return { ok: false, status: 400 };
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    assertPerm(session, "settings.edit");
    await (deps.write ?? (await import("./auth")).setRequireMfa)(session, value.required);
    return { ok: true, required: await (deps.read ?? readRequire2fa)(session.orgId) };
  } catch (error) {
    if (forbidden(error)) return { ok: false, status: 403 };
    logServerError("b073_team_security_save", error);
    return { ok: false, status: 500 };
  }
}
