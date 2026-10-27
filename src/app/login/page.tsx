import { cookies } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthHashForward } from "@/components/auth-hash";
import { AuthBrand } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { BackupCodes } from "@/components/backup-codes";
import { PendingSubmit } from "@/components/pending-submit";
import { BACKUP_COOKIE, backupDisplay } from "@/server/backup";
import { actionLineLogin, actionSecondFactor, actionSignIn } from "@/server/auth-actions";
import { actionResendSignup } from "@/server/signup-actions";
import { CHALLENGE_COOKIE, peekChallenge } from "@/server/auth";
import { appFooterText, footerHasProductLine } from "@/line-copy";
import { demoModeEnabled, lineLoginEnabled, showDemoLineCopy } from "@/server/demo";
import { roleHome } from "@/server/perms";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: { absolute: makeT(prefs.locale)("i_login_title") } };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; step?: string; next?: string; reset?: string; demoReset?: string; email?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const session = await readSession();
  const demoLine = showDemoLineCopy(null);
  const loginFooter = appFooterText(t("i_login_footer"), demoLine);
  if (session && params.step !== "backup") redirect(roleHome(session.kind, session.role));
  const jar = await cookies();
  const challenge = params.step === "2fa" || params.step === "enroll" ? await peekChallenge(jar.get(CHALLENGE_COOKIE)?.value ?? "") : null;
  const backup = params.step === "backup" ? backupDisplay(jar.get(BACKUP_COOKIE)?.value) : null;
  const next = params.next && params.next.startsWith("/") ? params.next : "";
  const errorKey =
    params.error === "locked"
      ? "i_auth_locked"
      : params.error === "disabled"
        ? "i_auth_disabled"
        : params.error === "unavailable"
          ? "i_auth_unavailable"
          : params.error && params.error !== "unconfirmed"
            ? "i_auth_invalid"
            : "";
  return (
    <div className="auth-wrap">
      <AuthHashForward />
      <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
      {params.error === "unconfirmed" ? (
        <form className="card pad" action={actionResendSignup} data-testid="login-unconfirmed">
          <p>{t("i_login_unconfirmed")}</p>
          <input type="hidden" name="email" value={params.email || ""} />
          <PendingSubmit className="btn" idle={t("i_signup_resend")} pending={t("i_signup_sending")} testId="login-resend" />
        </form>
      ) : null}
      <form className="card pad" action={params.step === "2fa" || params.step === "enroll" ? actionSecondFactor : actionSignIn}>
        <h1>{t("i_login_headline")}</h1>
        <p {...(demoLine ? { "data-demo-line": "true" } : {})}>{demoLine ? t("i_login_sub") : t("i_login_sub_live")}</p>
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
            {demoLine && lineLoginEnabled() ? (
              <div data-demo-line="true">
                <button className="btn line block" type="submit" formAction={actionLineLogin} formNoValidate data-testid="line-login">
                  LINE Login
                </button>
                <p className="tiny muted" data-testid="line-demo-note">
                  {t("i_line_demo")}
                </p>
              </div>
            ) : null}
            <p className="small" data-testid="login-invite">
              {t("i_login_invite_lead")}
              <a href="/signup" data-testid="login-signup">{t("i_login_signup")}</a>
              {t("i_login_invite_tail")}
            </p>
            <p className="small" data-testid="login-pricing">
              <a href="/pricing">{t("i_login_pricing")}</a>
            </p>
          </>
        )}
      </form>
      <p className="foot" data-testid="login-footer" {...(footerHasProductLine(loginFooter) ? { "data-demo-line": "true" } : {})}>
        {loginFooter}
      </p>
    </div>
  );
}
