import { headers } from "next/headers";
import { makeT } from "@/i18n";
import { AcceptForm, AcceptSubmit } from "@/components/accept-form";
import { LegalConsentCheckbox } from "@/components/consent-check";
import { AuthBrand } from "@/components/brand";
import { PasswordFields } from "@/components/password-field";
import { actionAccept } from "@/server/auth-actions";
import { describeInvite } from "@/server/auth";
import { lineLoginEnabled, showDemoLineCopy } from "@/server/demo";
import { TEAM_INVITES_ENABLED, inviteStateMessageKey } from "@/server/team-invites";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AcceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const headerList = await headers();
  const invite = await describeInvite(token, {
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || headerList.get("x-real-ip"),
  });
  const session = await readSession();
  const portal = invite.kind !== "team_member";
  const otherAccount =
    invite.state === "ready" &&
    (invite.kind === "owner" || invite.kind === "tenant") &&
    invite.email !== "" &&
    (session?.email ?? "").trim() !== "" &&
    (session?.email ?? "").trim().toLowerCase() !== invite.email.trim().toLowerCase();
  const roleKey: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const stateKey = inviteStateMessageKey(invite.kind, invite.state, TEAM_INVITES_ENABLED);
  const stateMessage = stateKey ? t(stateKey) : "";
  const error =
    query.error === "weak"
      ? t("i_pw_weak")
      : query.error === "mismatch"
        ? t("i_pw_mismatch")
          : query.error === "auth"
          ? t("i_portal_password_wrong")
          : query.error === "timeout"
            ? t("i_portal_timeout")
            : query.error === "bound"
              ? t("i_portal_bound")
              : query.error === "failed" || query.error === "account"
                ? t("i_portal_accept_failed")
                : query.error === "email" || query.error === "emailTaken"
                  ? t("i_portal_email_unusable")
                  : query.error === "consent"
                    ? t("i_reconsent_error")
                  : !portal && query.error === "used"
              ? t("i_invite_used")
              : "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      {invite.state === "ready" && (invite.kind === "owner" || invite.kind === "tenant") && otherAccount ? (
        <div className="card pad">
          <h1 data-testid="portal-invite-title">{t("i_portal_invite_title", { firm: invite.firm })}</h1>
          <div className="fg">
            <label className="f">{t("i_portal_login_email")}</label>
            <input className="inp" type="email" value={invite.email} readOnly data-testid="portal-email" autoComplete="off" />
          </div>
          <div className="alert info" data-testid="portal-other-account">
            {t("i_portal_signed_in_other", { current: session?.email ?? "", invite: invite.email })}
          </div>
          <form action={`/api/auth/sign-out?next=${encodeURIComponent(`/accept/${token}`)}`} method="post">
            <button className="btn pri block" type="submit" data-testid="portal-sign-out-continue">
              {t("i_portal_sign_out_continue")}
            </button>
          </form>
        </div>
      ) : (
      <AcceptForm action={actionAccept} requireConsent={needsTeamConsent(invite.state, invite.kind)}>
        {invite.state === "ready" && (invite.kind === "owner" || invite.kind === "tenant") ? (
          <h1 data-testid="portal-invite-title">{t("i_portal_invite_title", { firm: invite.firm })}</h1>
        ) : (
          <h1>{t("i_accept_title")}</h1>
        )}
        {invite.state !== "ready" ? (
          <div className="alert bad" data-testid="invite-state">
            {stateMessage}
          </div>
        ) : invite.kind === "owner" || invite.kind === "tenant" ? (
          <>
            {error ? <div className="alert bad">{error}</div> : null}
            <input type="hidden" name="token" value={token} />
            <div className="fg">
              <label className="f">{t("i_portal_login_email")}</label>
              {invite.collectEmail ? (
                <>
                  <input className="inp" name="email" type="email" defaultValue="" data-testid="portal-email" autoComplete="off" />
                  <p className="small muted">{t("i_portal_choose_email")}</p>
                </>
              ) : (
                <input className="inp" name="email" type="email" value={invite.email} readOnly data-testid="portal-email" autoComplete="off" />
              )}
            </div>
            <h2 data-testid="portal-password-title">{t("i_portal_set_password")}</h2>
            <div className="fg">
              <input className="inp" name="password" type="password" data-testid="new-password" autoComplete="current-password" />
            </div>
            <p className="small muted" data-testid="portal-password-help">{t("i_portal_password_help")}</p>
            <p className="small">
              <a href="/forgot" data-testid="portal-forgot">{t("i_portal_forgot")}</a>
            </p>
            <AcceptSubmit idle={t("i_continue")} pending={t("i_portal_working")} testId="portal-submit" />
          </>
        ) : invite.kind === "team_member" ? (
          !TEAM_INVITES_ENABLED ? (
            <button className="btn" type="button" disabled aria-disabled="true" data-testid="team-accept-soon">
              {t("i_team_invites_soon")}
            </button>
          ) : (
          <>
            <p>
              {invite.inviter} · {invite.firm} · {t(roleKey[invite.role] ?? "i_role_label")}
            </p>
            {error ? <div className="alert bad">{error}</div> : null}
            <input type="hidden" name="token" value={token} />
            <div className="fg">
              <label className="f">{t("i_name")}</label>
              <input className="inp" name="name" data-testid="accept-name" defaultValue="" />
            </div>
            <PasswordFields />
            <LegalConsentCheckbox
              variant="service"
              labelTestId="invite-consent-label"
              inputTestId="invite-consent"
              termsTestId="invite-terms"
              privacyTestId="invite-privacy"
              errorTestId="invite-consent-error"
              errorKey="i_reconsent_error"
            />
            <AcceptSubmit idle={t("i_accept")} pending={t("i_portal_working")} testId="accept-submit" />
            {showDemoLineCopy(null) && lineLoginEnabled() ? (
              <div data-demo-line="true">
                <button className="btn line block" type="button" data-testid="line-login">
                  LINE Login
                </button>
              </div>
            ) : null}
          </>
          )
        ) : null}
      </AcceptForm>
      )}
    </div>
  );
}

function needsTeamConsent(state: string, kind: string) {
  return state === "ready" && kind === "team_member";
}
