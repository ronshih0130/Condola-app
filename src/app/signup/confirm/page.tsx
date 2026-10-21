import type { Metadata } from "next";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { ConfirmHash } from "@/components/confirm-token";
import { PendingSubmit } from "@/components/pending-submit";
import { actionConfirmSupabaseHash, actionConfirmToken, actionResendSignup } from "@/server/signup-actions";
import { signupVerifyType } from "@/server/signup-gotrue";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: { absolute: makeT(prefs.locale)("i_login_title") } };
}

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; expired?: string; token_hash?: string; type?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const token = params.token || "";
  const tokenHash = params.token_hash || "";
  const verifyType = signupVerifyType(params.type);
  const expired = params.expired === "1";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        {tokenHash && verifyType && !expired ? (
          <>
            <h1>{t("i_signup_confirm_email")}</h1>
            <p data-testid="confirm-hint">{t("i_signup_confirm_hint")}</p>
            <form action={actionConfirmSupabaseHash} className="col">
              <input type="hidden" name="token_hash" value={tokenHash} />
              <input type="hidden" name="type" value={verifyType} />
              <PendingSubmit
                className="btn pri"
                idle={t("i_signup_confirm_email")}
                pending={t("i_signup_confirming")}
                testId="signup-confirm-submit"
              />
            </form>
            <ConfirmHash />
          </>
        ) : token && !expired ? (
          <>
            <h1>{t("i_signup_confirm_email")}</h1>
            <p data-testid="confirm-hint">{t("i_signup_confirm_hint")}</p>
            <form action={actionConfirmToken} className="col">
              <input type="hidden" name="token" value={token} />
              <PendingSubmit
                className="btn pri"
                idle={t("i_signup_confirm_email")}
                pending={t("i_signup_confirming")}
                testId="signup-confirm-submit"
              />
            </form>
            <ConfirmHash />
          </>
        ) : (
          <>
            <ConfirmHash />
            <p data-testid="confirm-pending">{t("i_signup_confirming")}</p>
            <h1>{t("i_signup_expired")}</h1>
            <div className="alert warn" data-testid="signup-expired">
              {t("i_signup_expired")}
            </div>
            <form action={actionResendSignup} className="col">
              <div className="fg">
                <label className="f">{t("i_email_label")}</label>
                <input className="inp" name="email" type="email" required data-testid="expired-email" />
              </div>
              <PendingSubmit className="btn pri" idle={t("i_signup_resend")} pending={t("i_signup_sending")} testId="signup-resend" />
            </form>
          </>
        )}
      </div>
    </div>
  );
}
