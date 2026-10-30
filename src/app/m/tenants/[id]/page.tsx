import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { tenantDirectoryHistory } from "@/server/tenant-directory";
import { TenantDirectoryDetail, DirectoryUnavailable } from "@/components/tenant-directory";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { AuditHistory } from "@/components/audit-log";
import { PageHeader, statusClass, statusKey } from "@/components/ui";
import { tenantDetail } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ audit?: string; page?:string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  const t = makeT(session.locale);
  const directory=await tenantDirectoryHistory(session,id,query);
  if(directory.state==="enabled") {if(!directory.contact) notFound();return <TenantDirectoryDetail locale={session.locale} result={directory} audit={query.audit}/>;}
  if(directory.state==="unavailable") return <DirectoryUnavailable locale={session.locale} path="/m/tenants"/>;
  const detail = await tenantDetail(session, id);
  if (!detail) notFound();
  return (
    <>
      <PageHeader title={displaySampleName(detail.tenant.name)} crumb={<Link href="/m/tenants">{t("i_tenants_title")}</Link>} />
      <div className="card" data-testid="tenant-leases">
        <div className="hd">
          <h3>{t("i_nav_leases")}</h3>
        </div>
        {detail.leases.length === 0 ? (
          <div className="empty">{t("i_tenant_no_lease")}</div>
        ) : (
          <table className="t rf">
            <thead>
              <tr>
                <th>{t("i_space")}</th>
                <th>{t("i_status")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.leases.map((lease) => (
                <tr key={lease.id}>
                  <td>
                    <Link href={`/m/leases/${lease.id}`}>{displaySampleName(lease.place)}</Link>
                  </td>
                  <td data-label={t("i_status")}>
                    <span className={`chip ${statusClass(lease.status)}`}>{t(statusKey(lease.status))}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AuditHistory table="contacts" rowId={id} cursor={query.audit} path={`/m/tenants/${id}`} />
    </>
  );
}
