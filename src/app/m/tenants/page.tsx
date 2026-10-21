import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { listLeases } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const leases = await listLeases(session);
  return (
    <>
      <PageHeader title={t("i_tenants_title")} />
      <div className="card">
        <table className="t rf">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("i_space")}</th>
              <th>{t("i_status")}</th>
            </tr>
          </thead>
          <tbody>
            {leases.map((lease) => (
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
    </>
  );
}
