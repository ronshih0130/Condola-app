import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { BackupCodes } from "@/components/backup-codes";
import { BACKUP_COOKIE, backupDisplay } from "@/server/backup";
import { actionLineLogin, actionSecondFactor, actionSignIn } from "@/server/auth-actions";
import { CHALLENGE_COOKIE, peekChallenge } from "@/server/auth";
import { demoModeEnabled, lineLoginEnabled } from "@/server/demo";
import { roleHome } from "@/server/perms";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; step?: string; next?: string; reset?: string; demoReset?: string }> }) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const session = await readSession();
  if (session && params.step !== "backup") redirect(roleHome(session.kind, session.role));
  const jar = await cookies();
  const challenge = params.step === "2fa" || params.step === "enroll" ? await peekChallenge(jar.get(CHALLENGE_COOKIE)?.value ?? "") : null;
  const backup = params.step === "backup" ? backupDisplay(jar.get(BACKUP_COOKIE)?.value) : null;
  const next = params.next && params.next.startsWith("/") ? params.next : "";
  const errorKey =
    params.error === "locked" ? "i_auth_locked" : params.error === "disabled" ? "i_auth_disabled" : params.error ? "i_auth_invalid" : "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <form className="card pad" action={params.step === "2fa" || params.step === "enroll" ? actionSecondFactor : actionSignIn}>
        <h1>{t("i_sign_in")}</h1>
        {params.demoReset === "1" ? (
          <div className="toast" data-testid="reset-toast">
            {t("s_fe71059")}
          </div>
        ) : null}
        {params.reset === "1" ? <div className="alert ok">{t("i_password_updated")}</div> : null}
        {errorKey ? (
          <div className="alert bad" data-testid="login-error">
            {t(errorKey)}
          </div>
        ) : null}
        {params.step === "backup" && backup?.clearCookie ? (
          <>
            <BackupCodes codes={backup.codes} note={t("i_backup_once")} />
            <a className="btn pri" href="/auth/continue">
              {t("i_continue")}
            </a>
          </>
        ) : params.step === "2fa" || params.step === "enroll" ? (
          <>
            <input type="hidden" name="step" value={params.step} />
            <input type="hidden" name="next" value={next} />
            {params.step === "enroll" && challenge?.secret ? (
              <div className="alert info" data-testid="enroll-key">
                <div>{t("i_mfa_enroll")}</div>
                <p className="small">{challenge.otpauth}</p>
                <p>
                  <code>{challenge.secret}</code>
                </p>
              </div>
            ) : (
              <p>{t("i_mfa_prompt")}</p>
            )}
            <div className="fg">
              <label className="f">{t("i_mfa_code")}</label>
              <input className="inp" name="code" data-testid="mfa-code" inputMode="numeric" autoComplete="one-time-code" />
            </div>
            {demoModeEnabled() ? <p className="tiny muted">{t("i_demo_code")}</p> : null}
            <button className="btn pri block" type="submit" data-testid="mfa-submit">
              {t("i_continue")}
            </button>
            <p className="small">
              <a href="/login">{t("i_other_account")}</a>
            </p>
          </>
        ) : (
          <>
            <input type="hidden" name="next" value={next} />
            <div className="fg">
              <label className="f">{t("i_email_label")}</label>
              <input className="inp" name="email" type="email" data-testid="login-email" autoComplete="username" />
            </div>
            <div className="fg">
              <label className="f">{t("i_password")}</label>
              <input className="inp" name="password" type="password" data-testid="login-password" autoComplete="current-password" />
            </div>
            <label className="row" style={{ marginBottom: 12 }}>
              <input type="checkbox" name="remember" /> {t("i_remember")}
            </label>
            <button className="btn pri block" type="submit" data-testid="login-submit">
              {t("i_sign_in")}
            </button>
            <p className="small">
              <a href="/forgot">{t("i_forgot")}</a>
            </p>
            {lineLoginEnabled() ? (
              <button className="btn line block" type="submit" formAction={actionLineLogin} formNoValidate data-testid="line-login">
                LINE Login
              </button>
            ) : (
              <button className="btn line block" type="button" data-testid="line-login" disabled title={t("i_line_login_todo")}>
                LINE Login
              </button>
            )}
            <p className="tiny muted">{lineLoginEnabled() ? t("i_line_demo") : t("i_line_login_todo")}</p>
          </>
        )}
      </form>
    </div>
  );
}
