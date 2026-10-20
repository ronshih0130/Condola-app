import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { PasswordFields } from "@/components/password-field";
import { actionReset } from "@/server/auth-actions";
import { describeReset } from "@/server/auth";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ResetPage({
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
  const state = query.error === "expired" ? "expired" : await describeReset(token);
  const error =
    query.error === "weak" ? t("i_pw_weak") : query.error === "mismatch" ? t("i_pw_mismatch") : query.error === "expired" ? t("i_reset_expired") : "";
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <form className="card pad" action={actionReset}>
        <h1>{t("i_reset_title")}</h1>
        {state === "expired" ? (
          <div className="alert bad" data-testid="reset-expired">
            {t("i_reset_expired")}
          </div>
        ) : (
          <>
            {error ? <div className="alert bad">{error}</div> : null}
            <input type="hidden" name="token" value={token} />
            <PasswordFields />
            <button className="btn pri block" type="submit" data-testid="reset-submit">
              {t("i_save_password")}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
