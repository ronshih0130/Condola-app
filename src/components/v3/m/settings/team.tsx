import React from "react";
import { makeT, type Locale } from "../../../../i18n";
import { brandV3TeamCopy, fill } from "../../../../i18n/lanes/brand-v3-r5-team";
import { teamPermissionMatrix, type TeamRowV3, type TeamSeats } from "../../../../server/b073-team";
import { ROLE_KEYS } from "../../../../server/perms";
import type { OrgRole } from "../../../../server/types";
import { TeamFocus } from "./team-focus";
import { TEAM_ADD_ID, TEAM_CLOSE_HREF, TEAM_PANEL_ID } from "./team-focus-state";

/**
 * R5-TEAM + R5-FULL (設定 › 團隊, MGT-133). Presentation only (server-safe, no hooks): row actions, the existing
 * invite flow and the 2FA switch are passed in by the route section. 「新增同事」 is the only solid button, except
 * while the existing invite form is open (its own submit is then the solid one and 「新增同事」 is drawn as an
 * outline). It is never disabled: at the limit it opens the R5-FULL panel and nothing is invited.
 */
export const TEAM_HREF = "/m/team";
export const TEAM_ADD_HREF = "/m/team?add=1#v3-team-panel";
export const TEAM_PERMS_HREF = "/m/team?perms=1#v3-team-perms";
/** The in-app plan screen (the upgrade route only redirects here; screens never link that route, upgrade-gate rule). */
export const PLANS_HREF = "/m/settings";
export type TeamPanel = "none" | "add" | "full";

const ROLE_LABEL: Record<OrgRole, string> = { admin: "i_role_admin", manager: "i_role_manager", accountant: "i_role_accountant", maintenance: "i_role_maintenance" };
const ROLE_DESCRIPTION = { admin: "roleAdmin", manager: "roleManager", accountant: "roleAccountant", maintenance: "roleMaintenance" } as const;
export function roleLabel(locale: Locale, role: OrgRole) { return makeT(locale)(ROLE_LABEL[role]); }

/** MGT-133-AC4: 「團隊人數 {used}／{limit}」, or 「團隊人數 {used}」 when there is no limit. */
export function seatLead(locale: Locale, seats: TeamSeats) {
  const c = brandV3TeamCopy(locale);
  return seats.limit === null ? fill(c.leadNoLimit, { used: seats.used }) : fill(c.leadLimit, { used: seats.used, limit: seats.limit });
}

/** MGT-133-AC8 loading: skeletons hold the layout; no count, no buttons. */
export function TeamLoading({ locale }: { locale: Locale }) {
  return <section className="v3-team" aria-busy="true" aria-label={brandV3TeamCopy(locale).title} data-testid="team-loading">
    <div className="v3-team-lead" aria-hidden="true"><span className="v3-team-skeleton v3-team-skeleton-title" /><span className="v3-team-skeleton" /></div>
    <div className="v3-team-card" aria-hidden="true">{[0, 1, 2, 3].map(line => <span className="v3-team-skeleton" key={line} />)}</div>
  </section>;
}
/** MGT-133-AC8 read failure: the GS-02 sentence and 「再試一次」; no count, no list. */
export function TeamError({ locale }: { locale: Locale }) {
  const c = brandV3TeamCopy(locale);
  return <section className="v3-team" aria-label={c.title} data-testid="team-error">
    <div className="v3-team-card" role="alert"><p>{c.readFailed}</p><a className="btn" href={TEAM_HREF}>{c.retry}</a></div>
  </section>;
}

function StatusCell({ locale, row }: { locale: Locale; row: TeamRowV3 }) {
  const c = brandV3TeamCopy(locale);
  if (row.status === "paused") return <><span className="chip warn">{c.statusPaused}</span><span className="v3-team-sub">{c.pausedSub}</span></>;
  if (row.status === "invited") return <span className="chip info">{c.statusInvited}</span>;
  if (row.status === "disabled") return <span className="chip">{makeT(locale)("i_status_disabled")}</span>;
  return <span className="chip ok">{c.statusActive}</span>;
}

/** MGT-133-AC5 (R5-FULL): the two ways forward; nothing is invited. */
export function TeamFullPanel({ locale, seats, plans = true }: { locale: Locale; seats: TeamSeats; plans?: boolean }) {
  const c = brandV3TeamCopy(locale);
  return <section className="v3-team-card v3-team-panel" id={TEAM_PANEL_ID} tabIndex={-1} aria-labelledby="v3-team-full-title" data-testid="team-full">
    <h2 id="v3-team-full-title">{c.fullTitle}</h2>
    <p>{fill(c.fullBody, { used: seats.used, limit: seats.limit ?? "" })}</p>
    <div className="v3-team-row">{plans && <a className="btn" href={PLANS_HREF}>{c.plans}</a>}<a className="btn txt" href={TEAM_CLOSE_HREF}>{c.close}</a></div>
  </section>;
}

/** MGT-133-AC3: collapsed by default; read only; rows from perms.ts, the four approved role descriptions above. */
export function TeamPermissions({ locale, open = false }: { locale: Locale; open?: boolean }) {
  const c = brandV3TeamCopy(locale);
  const t = makeT(locale);
  return <details className="v3-team-perms" id="v3-team-perms" open={open || undefined} data-testid="team-perms">
    <summary className="btn txt">{c.perms}</summary>
    <dl className="v3-team-roles">{ROLE_KEYS.map(role => <div key={role} data-role={role}><dt>{t(ROLE_LABEL[role])}</dt><dd>{c[ROLE_DESCRIPTION[role]]}</dd></div>)}</dl>
    <div className="v3-team-scroll">
      <table className="v3-team-matrix" data-testid="team-matrix">
        <thead><tr><th scope="col">{t("i_permission")}</th>{ROLE_KEYS.map(role => <th scope="col" key={role}>{t(ROLE_LABEL[role])}</th>)}</tr></thead>
        <tbody>{teamPermissionMatrix().map(row => <tr key={row.key} data-perm={row.key}>
          <th scope="row">{t(row.label)}</th>
          {ROLE_KEYS.map(role => <td key={role}>{row.roles[role] ? "✓" : "—"}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </details>;
}

export function TeamView({ locale, rows, seats, panel, permsOpen = false, plans = true, rowActions, invite, security, notice }: {
  locale: Locale; rows: TeamRowV3[]; seats: TeamSeats; panel: TeamPanel; permsOpen?: boolean;
  /** False when partner controls hide pricing (upgrade-gate): 「看方案」 is then not offered. */
  plans?: boolean;
  rowActions: (row: TeamRowV3) => React.ReactNode;
  /** The existing invite flow, shown when 「新增同事」 is chosen with room left. */
  invite?: React.ReactNode;
  /** The 全公司的安全規則 switch (only for a session that may change company settings). */
  security?: React.ReactNode;
  notice?: React.ReactNode;
}) {
  const c = brandV3TeamCopy(locale);
  const side = panel === "full" ? <TeamFullPanel locale={locale} seats={seats} plans={plans} />
    : panel === "add" ? <section className="v3-team-panel" id={TEAM_PANEL_ID} tabIndex={-1} aria-label={c.add} data-testid="team-invite">
      {invite}<a className="btn txt" href={TEAM_CLOSE_HREF}>{c.cancel}</a>
    </section>
    : security ? <section className="v3-team-card" aria-labelledby="v3-team-security-title" data-testid="team-security">
      <h2 id="v3-team-security-title">{c.securityTitle}</h2>{security}
    </section> : null;
  return <section className="v3-team" aria-label={c.title} data-testid="team">
    <TeamFocus panel={panel} />
    {notice}
    <header className="v3-team-lead">
      <div><h1>{seatLead(locale, seats)}</h1><p>{c.leadNote}</p></div>
      <a className={panel === "add" ? "btn" : "btn pri"} href={TEAM_ADD_HREF} id={TEAM_ADD_ID} data-testid="team-add">{c.add}</a>
    </header>
    <div className={side ? "v3-team-two" : undefined}>
      <div className="v3-team-card v3-team-list-card">
        <div className="v3-team-scroll">
          <table className="v3-team-list" data-testid="team-list">
            <thead><tr><th scope="col">{c.colName}</th><th scope="col">{c.colRole}</th><th scope="col">{c.colStatus}</th><th scope="col"><span className="v3-team-sr">{c.more}</span></th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.key} data-status={row.status}>
              <td><b>{row.name}</b>{row.contact && <span className="v3-team-sub">{row.contact}</span>}</td>
              <td>{roleLabel(locale, row.role)}</td>
              <td><StatusCell locale={locale} row={row} /></td>
              <td className="v3-team-acts">{rowActions(row)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <TeamPermissions locale={locale} open={permsOpen} />
      </div>
      {side}
    </div>
  </section>;
}
