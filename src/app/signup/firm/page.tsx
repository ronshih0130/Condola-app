import { UnitQrProfile } from "@/components/unit-qr-profile";
import { readUnitQrContext } from "@/server/unit-qr-signup";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { ConsentGateForm } from "@/components/consent-check";
import { FirmSteps } from "@/components/firm-steps";
import { actionAcceptReconsent } from "@/server/consent-actions";
import { consentCoversCurrent, readConsent } from "@/server/consent";
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
  const qr = await readUnitQrContext(null, identity.user_id);
  if (identity.org_id && !qr) redirect("/m");
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  if (!consentCoversCurrent(await readConsent(identity.user_id))) {
    return (
      <div className="auth-wrap">
        <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
        <ConsentGateForm action={actionAcceptReconsent} variant="service" next="/signup/firm" error={params.error} titleKey="i_reconsent_title" />
      </div>
    );
  }
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
      <div className="card pad">
        {qr ? <UnitQrProfile context={qr} locale={prefs.locale} error={params.error} /> : <FirmSteps partnerCode={identity.partner_code || ""} error={params.error} partnerDocuments={await (await import("@/server/partner-consent")).signupPartnerDocuments(prefs.locale)} />}
      </div>
    </div>
  );
}
