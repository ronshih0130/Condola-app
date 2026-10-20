import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { SignupForm } from "@/components/signup-form";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        <ol className="steps" data-testid="signup-steps">
          <li className="on">1</li>
          <li>2</li>
          <li>3</li>
          <li>4</li>
        </ol>
        <p className="small muted">{t("i_signup_step", { n: 1 })}</p>
        <h1>{t("i_signup_title")}</h1>
        <SignupForm error={params.error} />
      </div>
    </div>
  );
}
