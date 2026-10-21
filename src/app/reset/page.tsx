import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { PendingSubmit } from "@/components/pending-submit";
import { actionVerifyRecovery } from "@/server/auth-actions";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ResetLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; expired?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const tokenHash = params.token_hash || "";
  const ready = Boolean(tokenHash) && params.type === "recovery" && params.expired !== "1";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        <h1>{t("i_reset_title")}</h1>
        {ready ? (
          <>
            <p data-testid="reset-hint">{t("i_reset_continue_hint")}</p>
            <form action={actionVerifyRecovery} className="col">
              <input type="hidden" name="token_hash" value={tokenHash} />
              <input type="hidden" name="type" value="recovery" />
              <PendingSubmit className="btn pri block" idle={t("i_reset_continue")} pending={t("i_signup_sending")} testId="reset-continue" />
            </form>
          </>
        ) : (
          <div className="alert bad" data-testid="reset-expired">
            {t("i_reset_expired")}
          </div>
        )}
        <p className="small">
          <a href="/forgot">{t("i_forgot")}</a>
        </p>
      </div>
    </div>
  );
}
