import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { PropertyWizard } from "@/components/property-wizard";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { loadOrgCountry } from "@/server/org-country";
import { listOwners } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewPropertyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), "props.edit");
  const t = makeT(session.locale);
  const params = await searchParams;
  if (session.role !== "admin" && session.role !== "manager") {
    return <div className="alert bad" data-testid="forbidden">{t("i_forbidden")}</div>;
  }
  const [owners, country] = await Promise.all([listOwners(session), loadOrgCountry(session.orgId)]);
  return (
    <>
      <PageHeader title={t("s_aed91da")} crumb={t("s_e03a6ec")} />
      <ErrorBanner t={t} error={params.error} />
      <PropertyWizard owners={owners} currency={country.currency} callingCode={country.callingCode} />
    </>
  );
}
