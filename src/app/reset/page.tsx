import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { PasswordFields } from "@/components/password-field";
import { actionReset } from "@/server/auth-actions";
import { describeRecoveryHash } from "@/server/auth";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ResetLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; expired?: string; error?: string }>;
}) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const tokenHash = params.token_hash || "";
  const ready = (await describeRecoveryHash(tokenHash, params.type || "")) === "ready";
  const error =
    params.error === "weak" ? t("i_pw_weak") : params.error === "mismatch" ? t("i_pw_mismatch") : "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        {ready ? (
          <form action={actionReset} className="col">
            <h1>{t("i_reset_title")}</h1>
            {error ? <div className="alert bad">{error}</div> : null}
            <input type="hidden" name="token_hash" value={tokenHash} />
            <input type="hidden" name="type" value="recovery" />
            <PasswordFields />
            <button className="btn pri block" type="submit" data-testid="reset-submit">
              {t("i_reset_save")}
            </button>
          </form>
        ) : (
          <>
            <h1>{t("i_reset_title")}</h1>
            <div className="alert bad" data-testid="reset-expired">
              {t("i_reset_expired")}
            </div>
            <a className="btn pri block" href="/forgot" data-testid="reset-resend">
              {t("i_reset_resend")}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
