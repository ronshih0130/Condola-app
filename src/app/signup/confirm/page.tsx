import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { ConfirmHash, ConfirmSupabaseHash, ConfirmToken } from "@/components/confirm-token";
import { actionResendSignup } from "@/server/signup-actions";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; expired?: string; token_hash?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const token = params.token || "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        {params.token_hash && params.expired !== "1" ? (
          <>
            <p data-testid="confirm-pending">{t("i_signup_confirming")}</p>
            <ConfirmSupabaseHash tokenHash={params.token_hash} />
          </>
        ) : token && params.expired !== "1" ? (
          <>
            <p data-testid="confirm-pending">{t("i_signup_confirming")}</p>
            <ConfirmToken token={token} />
          </>
        ) : (
          <>
            <ConfirmHash />
            <h1>{t("i_signup_expired")}</h1>
            <div className="alert warn" data-testid="signup-expired">
              {t("i_signup_expired")}
            </div>
            <form action={actionResendSignup} className="col">
              <div className="fg">
                <label className="f">{t("i_email_label")}</label>
                <input className="inp" name="email" type="email" data-testid="expired-email" />
              </div>
              <button className="btn pri" type="submit">
                {t("i_signup_resend")}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
