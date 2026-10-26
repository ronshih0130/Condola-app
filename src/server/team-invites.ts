import { FlowError } from "./errors";

/**
 * The global rollout switch stays this source constant, with no env override.
 * The server-config allowlist is a CEO-approved per-org exception.
 * Sandbox twins have different org ids and are NOT implied by an allowed org.
 * Do not add this to wrangler.jsonc.
 */
export const TEAM_INVITES_ENABLED = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InviteEnv = Readonly<Record<string, string | undefined>>;

export function parseTeamInviteOrgAllowlist(raw: string | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const id = entry.trim();
    if (!id) continue;
    if (!UUID.test(id)) return new Set<string>();
    result.add(id.toLowerCase());
  }
  return result;
}

export function teamInviteAllowlistConfigured(env: InviteEnv = process.env): boolean {
  return TEAM_INVITES_ENABLED || parseTeamInviteOrgAllowlist(env.TEAM_INVITES_ORG_ALLOWLIST).size > 0;
}

export function teamInvitesAllowedForOrg(
  orgId: string | null | undefined,
  env: InviteEnv = process.env,
): boolean {
  return TEAM_INVITES_ENABLED || (
    typeof orgId === "string" &&
    UUID.test(orgId) &&
    parseTeamInviteOrgAllowlist(env.TEAM_INVITES_ORG_ALLOWLIST).has(orgId.toLowerCase())
  );
}

export function assertTeamInvitesAllowed(orgId: string | null | undefined, env?: InviteEnv) {
  if (!teamInvitesAllowedForOrg(orgId, env)) throw new FlowError("errors.teamInvitesSoon");
}

/** Token-state failures deliberately share one public message. */
export function inviteStateMessageKey(kind: string, state: string, enabled: boolean): string {
  if (kind === "team_member") {
    return state === "ready" && enabled ? "" : "i_team_invite_unavailable";
  }
  if (state === "timeout") return "i_portal_timeout";
  if (state === "locked") return "i_portal_invite_locked";
  return "i_portal_invite_invalid";
}
