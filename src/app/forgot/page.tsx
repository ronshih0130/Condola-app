import { cookies } from "next/headers";
import { makeT } from "@/i18n";
import { ClearResetFlash } from "@/components/clear-reset-flash";
import { actionForgot } from "@/server/auth-actions";
import { RESET_FLASH_COOKIE, resetFlashDisplay } from "@/server/reset-flash";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ForgotPage() {
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const jar = await cookies();
  const flash = resetFlashDisplay(jar.get(RESET_FLASH_COOKIE)?.value);
  return (
    <div className="auth-wrap">
      <form className="card pad" action={actionForgot}>
        <h1>{t("i_forgot")}</h1>
        {flash.email ? (
          <>
            <div className="alert info" data-testid="forgot-sent">
              {t("i_forgot_sent", { email: flash.email })}
            </div>
            {flash.clearCookie ? <ClearResetFlash /> : null}
          </>
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
