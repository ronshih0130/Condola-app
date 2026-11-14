import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { tenantDirectory } from "@/server/tenant-directory";
import { TenantDirectoryList, DirectoryUnavailable } from "@/components/tenant-directory";
import { makeT } from "@/i18n";
import { ListPager, ListSearch, listSummary } from "@/components/list-search";
import { PageHeader } from "@/components/ui";
import { searchTenants } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const raw = await searchParams;
  const t = makeT(session.locale);
  const directory=await tenantDirectory(session,raw);
  if(directory.state==="enabled") return <TenantDirectoryList locale={session.locale} result={directory} empty={<ManagementEmptyState session={session} page={directory.q || directory.page > 1 ? "SRCH" : "TEN"} actionHref={directory.q || directory.page > 1 ? "/m/tenants" : undefined} />}/>;
  if(directory.state==="unavailable") return <DirectoryUnavailable locale={session.locale} path="/m/tenants"/>;
  const result = await searchTenants(session, raw);
  const { rows, q, page, hasNext, total, from, to } = result;
  const summary = listSummary(t, result);
  return (
    <>
      <PageHeader title={t("i_tenants_title")} />
      <div className="card">
        <ListSearch
          action="/m/tenants"
          q={q}
          label={t("i_search")}
          placeholder={t("i_search_ph_tenants")}
          clearLabel={t("i_search_clear")}
        />
        {rows.length === 0 ? <ManagementEmptyState session={session} page={q || page > 1 ? "SRCH" : "TEN"} actionHref={q || page > 1 ? "/m/tenants" : undefined} /> : (
        <table className="t rf" data-testid="tenant-list">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("i_space")}</th>
              <th>{t("i_status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((lease) => (
              <tr key={lease.id} className="click">
                <td>
                  <Link className="hit" href={`/m/tenants/${lease.contact_id}`}>
                    {displaySampleName(lease.tenant)}
                  </Link>
                </td>
                <td data-label={t("i_space")}>
                  <Link href={`/m/leases/${lease.id}`}>{displaySampleName(lease.place)}</Link>
                  {Number(lease.lease_count) > 1 ? (
                    <>
                      {" "}
                      <span data-testid="tenant-lease-more">+{Number(lease.lease_count) - 1}</span>
                    </>
                  ) : null}
                </td>
                <td data-label={t("i_status")}>{t(lease.status === "active" ? "i_st_active" : "i_st_pending")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
      <ListPager
        path="/m/tenants"
        q={q}
        page={page}
        hasNext={hasNext}
        prevLabel={t("i_search_prev")}
        nextLabel={t("i_search_next")}
        summary={summary}
        total={total}
        from={from}
        to={to}
      />
    </>
  );
}
