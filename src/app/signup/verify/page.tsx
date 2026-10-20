import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { actionChangeSignupEmail, actionResendSignup } from "@/server/signup-actions";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; dev?: string; resent?: string; error?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const email = params.email || "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        <ol className="steps" data-testid="signup-steps">
          <li className="on">1</li>
          <li className="on">2</li>
          <li>3</li>
          <li>4</li>
        </ol>
        <p className="small muted">{t("i_signup_step", { n: 2 })}</p>
        <h1>{t("i_signup_verify_title")}</h1>
        <p data-testid="verify-body">{t("i_signup_verify_body", { email })}</p>
        {params.resent === "1" ? <div className="alert ok">{t("i_signup_resent")}</div> : null}
        {params.error === "duplicate" ? (
          <div className="alert bad" data-testid="signup-duplicate">
            <p>{t("i_signup_dup")}</p>
            <p>
              <a href="/login">{t("i_sign_in")}</a>
              {" · "}
              <a href="/forgot">{t("i_forgot")}</a>
            </p>
          </div>
        ) : null}
        {params.dev ? (
          <p>
            <a href={`/signup/confirm?token=${encodeURIComponent(params.dev)}`} data-testid="verify-dev-link">
              {t("i_signup_dev_link")}
            </a>
          </p>
        ) : null}
        <form action={actionResendSignup}>
          <input type="hidden" name="email" value={email} />
          <button className="btn" type="submit" data-testid="signup-resend">
            {t("i_signup_resend")}
          </button>
        </form>
        <form action={actionChangeSignupEmail} className="col" style={{ marginTop: 16 }}>
          <h2 className="h3">{t("i_signup_change_email")}</h2>
          <input type="hidden" name="email" value={email} />
          <div className="fg">
            <label className="f">{t("i_password")}</label>
            <input className="inp" name="password" type="password" data-testid="change-password" />
          </div>
          <div className="fg">
            <label className="f">{t("i_email_label")}</label>
            <input className="inp" name="nextEmail" type="email" data-testid="change-email" />
          </div>
          <button className="btn" type="submit">
            {t("i_signup_change_email")}
          </button>
        </form>
        <p className="small">
          <a href="/login">{t("i_sign_in")}</a>
        </p>
      </div>
    </div>
  );
}
