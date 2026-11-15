import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { ConsentGateForm } from "@/components/consent-check";
import { actionAcceptPortalConsent } from "@/server/consent-actions";
import { consentCoversCurrent, readConsent } from "@/server/consent";
import { consentNextPath } from "@/server/consent-gate";
import { roleHomeForSession } from "@/server/role-home-v3";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PortalConsentPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  const session = await readSession();
  if (!session) redirect("/login");
  const next = consentNextPath(params.next || "", await roleHomeForSession(session));
  if (session.kind !== "owner" && session.kind !== "tenant") {
    redirect(`/consent?next=${encodeURIComponent(next)}`);
  }
  if (consentCoversCurrent(await readConsent(session.userId))) redirect(next);
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
      <ConsentGateForm action={actionAcceptPortalConsent} variant="portal" next={next} error={params.error} titleKey="i_portal_consent_title" />
    </div>
  );
}
