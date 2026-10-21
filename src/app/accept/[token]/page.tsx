import { headers } from "next/headers";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { PasswordFields } from "@/components/password-field";
import { actionAccept } from "@/server/auth-actions";
import { describeInvite } from "@/server/auth";
import { lineLoginEnabled } from "@/server/demo";
import { mintedLoginEmail } from "@/server/portal-invite";
import { requestPrefs } from "@/server/session";

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
  const portal = invite.kind !== "team_member";
  const roleKey: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const stateMessage = portal
    ? t("i_portal_invite_invalid")
    : invite.state === "used"
      ? t("i_invite_used")
      : invite.state === "revoked"
        ? t("i_invite_revoked")
        : invite.state === "expired"
          ? t("i_invite_expired")
          : invite.state === "invalid"
            ? t("i_invite_invalid")
            : "";
  const error =
    query.error === "weak" ? t("i_pw_weak") : query.error === "mismatch" ? t("i_pw_mismatch") : !portal && query.error === "used" ? t("i_invite_used") : "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <form className="card pad" action={actionAccept}>
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
              <input className="inp" name="email" type="email" value={invite.email} readOnly data-testid="portal-email" autoComplete="username" />
              {mintedLoginEmail(invite.email) ? <p className="small muted">{t("i_portal_minted_email")}</p> : null}
            </div>
            <PasswordFields />
            <button className="btn pri block" type="submit" data-testid="portal-submit">
              {t("i_portal_set_password")}
            </button>
          </>
        ) : invite.kind === "team_member" ? (
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
            <button className="btn pri block" type="submit" data-testid="accept-submit">
              {t("i_accept")}
            </button>
            <button className="btn line block" type="button" disabled={!lineLoginEnabled()} title={t("i_line_login_todo")}>
              LINE Login
            </button>
          </>
        ) : null}
      </form>
    </div>
  );
}
