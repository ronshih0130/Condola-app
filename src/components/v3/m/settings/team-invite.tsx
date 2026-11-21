import React from "react";
import { makeT, type Locale } from "@/i18n";
import { TeamInviteForm } from "@/components/team-invite-form";
import { actionInvite } from "@/server/auth-actions";
import type { TeamInvites } from "@/server/b073-team";

/**
 * 「新增同事」 with room left opens TODAY's invite flow (R5-ADD is a later slice): the live link form
 * (TeamInviteForm) or, in sandbox, the legacy form, under the same staff-invite gate the B-040 page uses
 * (`TEAM_INVITES_ENABLED` + per-org allowlist). Nothing is mailed. With the gate closed there is no form and
 * no disabled button: only today's 「即將開放」 line.
 */
export function TeamInviteFlow({ locale, invites }: { locale: Locale; invites: TeamInvites }) {
  const t = makeT(locale);
  if (invites === "live") return <TeamInviteForm />;
  if (invites === "closed") return <div className="card pad" data-testid="team-invite-closed"><p>{t("i_team_invites_soon")}</p></div>;
  return <form className="card pad" action={actionInvite}>
    <h3>{t("s_f320582")}</h3>
    <div className="fg">
      <label className="f" htmlFor="v3-team-invite-email">{t("i_invite_email")}</label>
      <input className="inp" id="v3-team-invite-email" name="email" type="email" data-testid="invite-email" placeholder={t("i_ph_email")} />
    </div>
    <div className="fg">
      <label className="f" htmlFor="v3-team-invite-name">{t("i_name")}</label>
      <input className="inp" id="v3-team-invite-name" name="name" data-testid="invite-name" />
    </div>
    <div className="fg">
      <label className="f" htmlFor="v3-team-invite-role">{t("i_role_label")}</label>
      <select className="inp" id="v3-team-invite-role" name="role" defaultValue="manager" data-testid="invite-role">
        <option value="manager">{t("i_role_manager")}</option>
        <option value="accountant">{t("i_role_accountant")}</option>
        <option value="maintenance">{t("i_role_maintenance")}</option>
        <option value="admin">{t("i_role_admin")}</option>
      </select>
      <div className="hint">{t("i_role_hint")}</div>
    </div>
    <button className="btn pri" type="submit">{t("s_1af94ab")}</button>
  </form>;
}
