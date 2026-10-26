import { FlowError } from "./errors";

/**
 * Shipped off pending rollout. Enable only by changing this source constant.
 * Do not add an environment override or add this to wrangler.jsonc.
 */
export const TEAM_INVITES_ENABLED = false;

export function assertTeamInvitesEnabled() {
  if (!TEAM_INVITES_ENABLED) throw new FlowError("errors.teamInvitesSoon");
}

/** Accept-page state copy; explicit enabled input also covers the unreleased flow. */
export function inviteStateMessageKey(kind: string, state: string, enabled: boolean): string {
  if (kind === "team_member" && !enabled) return "i_team_invites_soon";
  if (state === "timeout") return "i_portal_timeout";
  if (state === "locked") return "i_portal_invite_locked";
  if (kind !== "team_member") return "i_portal_invite_invalid";
  switch (state) {
    case "used": return "i_invite_used";
    case "revoked": return "i_invite_revoked";
    case "expired": return "i_invite_expired";
    case "invalid": return "i_invite_invalid";
    default: return "";
  }
}
