import { makeT } from "@/i18n";
import { actionForgot } from "@/server/auth-actions";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return (
    <div className="auth-wrap">
      <form className="card pad" action={actionForgot}>
        <h1>{t("i_forgot")}</h1>
        {params.sent === "1" ? (
          <div className="alert info" data-testid="forgot-sent">
            {t("i_forgot_sent")}
          </div>
        ) : (
          <>
            <div className="fg">
              <label className="f">{t("i_email_label")}</label>
              <input className="inp" name="email" type="email" data-testid="forgot-email" />
            </div>
            <button className="btn pri block" type="submit">
              {t("i_send_reset")}
            </button>
          </>
        )}
        <p className="small">
          <a href="/login">{t("i_sign_in")}</a>
        </p>
      </form>
    </div>
  );
}
