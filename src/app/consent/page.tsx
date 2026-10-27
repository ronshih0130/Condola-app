import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { ConsentGateForm } from "@/components/consent-check";
import { actionAcceptReconsent } from "@/server/consent-actions";
import { consentCoversCurrent, readConsent } from "@/server/consent";
import { consentNextPath } from "@/server/consent-gate";
import { roleHome } from "@/server/perms";
import { readSignupIdentity } from "@/server/signup";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ReconsentPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  const identity = await readSignupIdentity();
  if (!identity) redirect("/login");
  const session = await readSession();
  const next = consentNextPath(params.next || "", session ? roleHome(session.kind, session.role) : "/signup/firm");
  if (session && (session.kind === "owner" || session.kind === "tenant")) {
    redirect(`/consent/portal?next=${encodeURIComponent(next)}`);
  }
  if (consentCoversCurrent(await readConsent(identity.user_id))) redirect(next);
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
      <ConsentGateForm action={actionAcceptReconsent} variant="service" next={next} error={params.error} titleKey="i_reconsent_title" />
    </div>
  );
}
