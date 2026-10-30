import { redirect } from "next/navigation";
import { PartnerConsentScreen } from "@/components/partner-consent-form";
import { actionSignOut } from "@/server/auth-actions";
import { actionAcceptReconsent } from "@/server/consent-actions";
import { consentCoversCurrent } from "@/server/consent";
import { readPartnerState } from "@/server/partner-consent";
import { roleHome } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PartnerConsentPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  if (session.kind !== "staff") redirect(roleHome(session.kind, session.role));
  if (!consentCoversCurrent(session.consent ?? null)) redirect("/consent?next=%2Fpartner-consent");
  const state = session.partnerConsent ?? await readPartnerState(session);
  if (!state.active || !state.required) redirect("/m");
  const params = await searchParams;
  return (
    <PartnerConsentScreen
      locale={session.locale}
      documents={state.admin ? state.documents : []}
      admin={state.admin}
      action={actionAcceptReconsent}
      logout={actionSignOut}
      error={params.error}
    />
  );
}
