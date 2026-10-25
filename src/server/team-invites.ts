import { FlowError } from "./errors";

/**
 * Team member invites stay off until an invited person can sign in.
 * upsertInvitedUser writes auth.users rows that GoTrue cannot see.
 * Change this to true to turn invites back on. Do not add it to wrangler.jsonc.
 */
export const TEAM_INVITES_ENABLED = false;

export function assertTeamInvitesEnabled() {
  if (!TEAM_INVITES_ENABLED) throw new FlowError("errors.teamInvitesSoon");
}
