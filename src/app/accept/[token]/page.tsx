import { makeT } from "@/i18n";
import { PasswordFields } from "@/components/password-field";
import { actionAccept } from "@/server/auth-actions";
import { describeInvite } from "@/server/auth";
import { lineLoginEnabled } from "@/server/demo";
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
  const invite = await describeInvite(token);
  const roleKey: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const stateMessage =
    invite.state === "used"
      ? t("i_invite_used")
      : invite.state === "revoked"
        ? t("i_invite_revoked")
        : invite.state === "expired"
          ? t("i_invite_expired")
          : invite.state === "invalid"
            ? t("i_invite_invalid")
            : "";
  const error =
    query.error === "weak" ? t("i_pw_weak") : query.error === "mismatch" ? t("i_pw_mismatch") : query.error === "used" ? t("i_invite_used") : "";
  return (
    <div className="auth-wrap">
      <form className="card pad" action={actionAccept}>
        <h1>{t("i_accept_title")}</h1>
        {invite.state !== "ready" ? (
          <div className="alert bad" data-testid="invite-state">
            {stateMessage}
          </div>
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
            <button className="btn pri block" type="submit" data-testid="accept-submit">
              {t("i_accept")}
            </button>
            <button className="btn line block" type="button" disabled={!lineLoginEnabled()} title={t("i_line_login_todo")}>
              LINE Login
            </button>
          </>
        )}
      </form>
    </div>
  );
}
