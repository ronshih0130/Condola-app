import Link from "next/link";
import { makeT } from "@/i18n";
import { ListPager, ListSearch } from "@/components/list-search";
import { PageHeader } from "@/components/ui";
import { searchTenants } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await getSession();
  const raw = await searchParams;
  const t = makeT(session.locale);
  const { rows, q, page, hasNext } = await searchTenants(session, raw);
  return (
    <>
      <PageHeader title={t("i_tenants_title")} />
      <div className="card">
        <ListSearch action="/m/tenants" q={q} label={t("i_search")} placeholder={t("i_search_ph_tenants")} />
        <table className="t rf" data-testid="tenant-list">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("i_space")}</th>
              <th>{t("i_status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>{q ? t("i_search_none") : t("i_empty")}</td>
              </tr>
            ) : null}
            {rows.map((lease) => (
              <tr key={lease.id} className="click">
                <td>
                  <Link className="hit" href={`/m/tenants/${lease.contact_id}`}>
                    {lease.tenant}
                  </Link>
                </td>
                <td data-label={t("i_space")}>
                  <Link href={`/m/leases/${lease.id}`}>{lease.place}</Link>
                </td>
                <td data-label={t("i_status")}>{t(lease.status === "active" ? "i_st_active" : "i_st_pending")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager path="/m/tenants" q={q} page={page} hasNext={hasNext} prevLabel={t("i_search_prev")} nextLabel={t("i_search_next")} />
    </>
  );
}
