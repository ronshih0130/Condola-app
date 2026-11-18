import React from "react";
import { makeT } from "@/i18n";
import { ErrorBanner } from "@/components/ui";
import { demoModeEnabled } from "@/server/demo";
import { FREE_UNITS } from "@/server/billing";
import { upgradeGate } from "@/server/upgrade-gate";
import { teamRead, teamRowActions, type TeamInvites } from "@/server/b073-team";
import type { Session } from "@/server/types";
import { TeamError, TeamView } from "./team";
import { TeamRowActionsCell } from "./team-actions";
import { TeamInviteFlow } from "./team-invite";
import { TeamSecuritySwitch } from "./team-security-switch";

export type TeamQuery = { add?: string; perms?: string; error?: string; token?: string };

/**
 * R5-TEAM body (brand_v3 only; the route renders TeamLoading while this reads). `?add=1` is 「新增同事」: with
 * room left it opens today's invite flow; at the limit the R5-FULL panel (MGT-133-AC5), decided here on the
 * server from the same seat count, so nothing can be invited from a full team. `?perms=1` opens the matrix
 * (the old 角色權限 route lands here).
 */
export async function TeamV3Section({ session, invites, query }: { session: Session; invites: TeamInvites; query: TeamQuery }) {
  const read = await teamRead(session);
  // The route already requires team.manage; a forbidden read here (authority changed mid-request) shows nothing.
  if (read.state === "forbidden") return null;
  if (read.state !== "ready") return <TeamError locale={session.locale} />;
  const t = makeT(session.locale);
  const panel = query.add === "1" ? (read.full ? "full" : "add") : "none";
  // 「看方案」 goes to the plan screen unless partner controls confirm pricing is hidden (the same gate the upgrade
  // route applies). A failed lookup is not "hidden": the page shows the read error with 「再試一次」 instead.
  let plans = true;
  if (panel === "full") {
    try { plans = !(await upgradeGate(session, FREE_UNITS)).redirectTo; } catch { return <TeamError locale={session.locale} />; }
  }
  return <TeamView locale={session.locale} rows={read.rows} seats={read.seats} panel={panel} permsOpen={query.perms === "1"} plans={plans}
    rowActions={row => <TeamRowActionsCell locale={session.locale} row={row} actions={teamRowActions(row, { invites, full: read.full })} />}
    invite={panel === "add" ? <TeamInviteFlow locale={session.locale} invites={invites} /> : null}
    security={read.security ? <TeamSecuritySwitch locale={session.locale} required={read.security.required} /> : null}
    notice={<>
      <ErrorBanner t={t} error={query.error} />
      {query.token && demoModeEnabled() ? <div className="alert info" data-testid="invite-link">{t("i_invite_link", { path: `/join#t=${query.token}` })}</div> : null}
    </>} />;
}
