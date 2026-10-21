import { makeT } from "@/i18n";
import { PropertyWizard } from "@/components/property-wizard";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { listOwners } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewPropertyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (session.role !== "admin" && session.role !== "manager") {
    return <div className="alert bad" data-testid="forbidden">{t("i_forbidden")}</div>;
  }
  const owners = await listOwners(session);
  return (
    <>
      <PageHeader title={t("s_aed91da")} crumb={t("s_e03a6ec")} />
      <ErrorBanner t={t} error={params.error} />
      <PropertyWizard owners={owners} />
    </>
  );
}
