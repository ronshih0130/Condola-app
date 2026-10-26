import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { ConfirmDeactivate } from "@/components/confirm-deactivate";
import { actionInvite, actionMemberActive, actionMemberRole, actionResendInvite, actionRevokeInvite } from "@/server/auth-actions";
import { formatTaipei, formatTaipeiDate } from "@/server/time";
import { mfaStatus } from "@/server/auth";
import { demoModeEnabled } from "@/server/demo";
import { seatLimit } from "@/server/billing";
import { listTeam } from "@/server/queries";
import { commercialTier, seatUsage } from "@/server/seats";
import { getSession } from "@/server/session";
import { teamInvitesAllowedForOrg } from "@/server/team-invites";
import type { OrgRole } from "@/server/types";

export const dynamic = "force-dynamic";

const ROLES: OrgRole[] = ["admin", "manager", "accountant", "maintenance"];

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; token?: string; invited?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const invitesOpen = teamInvitesAllowedForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  const [team, factor, usage, tier] = await Promise.all([
    listTeam(session),
    mfaStatus(session.userId),
    seatUsage(session.orgId),
    commercialTier(session.orgId),
  ]);
  const seatCap = session.environment === "sandbox" ? null : seatLimit(tier);
  const seatBlocked = seatCap != null && usage.used >= seatCap;
  const activeAdmins = team.filter((member) => member.role === "admin" && member.status === "active").length;
  const roleKey: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const statusKey: Record<string, string> = {
    active: "i_status_active",
    invited: "i_status_invited",
    pending: "i_status_invited",
    suspended: "i_status_disabled",
    revoked: "i_status_revoked",
    removed: "i_status_revoked",
  };
  const requireNote = t("i_mfa_needed");
  return (
    <>
      <PageHeader title={t("s_1091b77")} />
      <ErrorBanner t={t} error={params.error} />
      {params.token && demoModeEnabled() ? (
        <div className="alert info" data-testid="invite-link">
          {t("i_invite_link", { path: `/accept/${params.token}` })}
        </div>
      ) : null}
      <div className="col">
        <div className="card">
          <table className="t rf" data-testid="team-table">
            <thead>
              <tr>
                <th>{t("i_name")}</th>
                <th>{t("i_invite_email")}</th>
                <th>{t("i_role_label")}</th>
                <th>{t("i_status")}</th>
                <th>{t("i_mfa")}</th>
                <th>{t("i_last_sign_in")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {team.map((member) => {
                const self = member.user_id === session.userId;
                const lastAdmin = member.role === "admin" && member.status === "active" && activeAdmins <= 1;
                const locked = self || lastAdmin;
                return (
                  <tr key={member.member_id ?? member.invitation_id ?? member.email}>
                    <td>{member.name || member.email}</td>
                    <td className="small" data-label={t("i_invite_email")}>
                      {member.email}
                    </td>
                    <td data-label={t("i_role_label")}>
                      {member.member_id && member.status === "active" ? (
                        <form action={actionMemberRole}>
                          <input type="hidden" name="memberId" value={member.member_id} />
                          <select className="inp" name="role" defaultValue={member.role} disabled={locked} aria-disabled={locked} data-testid={`role-${member.email}`}>
                            {ROLES.map((role) => (
                              <option key={role} value={role}>
                                {t(roleKey[role])}
                              </option>
                            ))}
                          </select>
                          {locked ? <div className="tiny muted">{self ? t("i_own_role") : t("i_last_admin")}</div> : (
                            <button className="btn sm" type="submit">
                              {t("i_save")}
                            </button>
                          )}
                        </form>
                      ) : (
                        <span className="chip pri">{t(roleKey[member.role] ?? "i_role_label")}</span>
                      )}
                    </td>
                    <td data-label={t("i_status")}>
                      {t(statusKey[member.status] ?? "i_status")}
                      {member.expires_at && member.status === "pending" ? (
                        <div className="tiny muted" data-testid={`invite-expiry-${member.email ?? member.invitation_id}`}>
                          {t("i_invite_expiry", { d: formatTaipeiDate(member.expires_at) })}
                        </div>
                      ) : null}
                    </td>
                    <td data-label={t("i_mfa")}>
                      {member.user_id ? (member.mfa ? t("i_on") : factor.required ? requireNote : t("i_mfa_off")) : "—"}
                    </td>
                    <td className="small" data-label={t("i_last_sign_in")} data-testid={`last-sign-in-${member.email ?? member.member_id}`}>
                      {member.last_sign_in ? formatTaipei(member.last_sign_in) : "—"}
                    </td>
                    <td className="r">
                      {member.invitation_id && member.status === "pending" ? (
                        <div className="col">
                          {invitesOpen ? (
                            <form action={actionResendInvite}>
                              <input type="hidden" name="invitationId" value={member.invitation_id} />
                              <button className="btn sm" type="submit" data-testid={`resend-${member.email}`}>
                                {t("i_resend")}
                              </button>
                            </form>
                          ) : (
                            <button className="btn sm" type="button" disabled aria-disabled="true" data-testid={`resend-${member.email}`}>
                              {t("i_resend")}
                            </button>
                          )}
                          <form action={actionRevokeInvite}>
                            <input type="hidden" name="invitationId" value={member.invitation_id} />
                            <button className="btn sm danger" type="submit">
                              {t("i_revoke")}
                            </button>
                          </form>
                        </div>
                      ) : null}
                      {member.member_id && member.status === "active" && !locked ? (
                        <ConfirmDeactivate
                          memberId={member.member_id}
                          email={member.email ?? ""}
                          label={t("i_deactivate")}
                          confirmLabel={t("i_deactivate_confirm")}
                          cancelLabel={t("i_cancel")}
                          note={t("i_deactivate_note")}
                        />
                      ) : null}
                      {member.member_id && member.status === "suspended" && !seatBlocked ? (
                        <form action={actionMemberActive}>
                          <input type="hidden" name="memberId" value={member.member_id} />
                          <input type="hidden" name="active" value="1" />
                          <button className="btn sm" type="submit">
                            {t("i_reactivate")}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card pad" data-testid="seat-meter">
          {session.environment === "sandbox" ? <p>{t("i_seat_test")}</p> : null}
          <p>
            {seatCap == null ? t("i_seat_unlimited", { used: usage.used }) : t("i_seat_meter", { used: usage.used, limit: seatCap })}
          </p>
          <p className="small">{t("i_price_pending", { n: usage.pending })}</p>
        </div>
        {!invitesOpen ? (
          <div className="card pad" data-testid="team-invite-card">
            <button className="btn" type="button" disabled aria-disabled="true" data-testid="team-invite-soon">
              {t("i_team_invites_soon")}
            </button>
          </div>
        ) : seatBlocked && seatCap != null ? (
          <p data-testid="seat-limit">{t("i_seat_upsell", { n: seatCap })}</p>
        ) : (
        <form className="card pad" action={actionInvite}>
          <h3>{t("s_f320582")}</h3>
          <div className="fg">
            <label className="f">{t("i_invite_email")}</label>
            <input className="inp" name="email" type="email" data-testid="invite-email" placeholder={t("i_ph_email")} />
          </div>
          <div className="fg">
            <label className="f">{t("i_name")}</label>
            <input className="inp" name="name" data-testid="invite-name" />
          </div>
          <div className="fg">
            <label className="f">{t("i_role_label")}</label>
            <select className="inp" name="role" defaultValue="manager" data-testid="invite-role">
              <option value="manager">{t("i_role_manager")}</option>
              <option value="accountant">{t("i_role_accountant")}</option>
              <option value="maintenance">{t("i_role_maintenance")}</option>
              <option value="admin">{t("i_role_admin")}</option>
            </select>
            <div className="hint">{t("i_role_hint")}</div>
          </div>
          <button className="btn pri" type="submit">
            {t("s_1af94ab")}
          </button>
        </form>
        )}
      </div>
    </>
  );
}
