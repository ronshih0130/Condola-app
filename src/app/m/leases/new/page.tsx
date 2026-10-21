import { makeT } from "@/i18n";
import { LeaseWizard } from "@/components/lease-wizard";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { showDemoLineCopy } from "@/server/demo";
import { listTenants, loadFirm, vacantRooms } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewLeasePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (session.role !== "admin" && session.role !== "manager") {
    return <div className="alert bad" data-testid="forbidden">{t("i_forbidden")}</div>;
  }
  const [rooms, tenants, firm] = await Promise.all([vacantRooms(session), listTenants(session), loadFirm(session)]);
  return (
    <>
      <PageHeader title={t("s_c93e6db")} crumb={t("s_fba85ae")} />
      <ErrorBanner t={t} error={params.error} />
      <LeaseWizard rooms={rooms} tenants={tenants} firmLocale={firm.defaultLocale} showLine={showDemoLineCopy(session.environment)} />
    </>
  );
}
