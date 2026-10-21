import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { FirmSteps } from "@/components/firm-steps";
import { readSignupIdentity } from "@/server/signup";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: { absolute: makeT(prefs.locale)("i_login_title") } };
}

export default async function FirmPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const identity = await readSignupIdentity();
  if (!identity) redirect("/signup");
  if (!identity.confirmed) redirect(`/signup/verify?email=${encodeURIComponent(identity.email)}`);
  if (identity.org_id) redirect("/m");
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        <h1>{t("i_signup_kind_title")}</h1>
        <FirmSteps partnerCode={identity.partner_code || ""} error={params.error} />
      </div>
    </div>
  );
}
