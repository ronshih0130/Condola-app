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
        <table className="t">
          <tbody>
            {leases.map((lease) => (
              <tr key={lease.id}>
                <td>
                  <Link href={`/m/leases/${lease.id}`}>{lease.tenant}</Link>
                </td>
                <td>{lease.place}</td>
                <td>{t(lease.status === "active" ? "i_st_active" : "i_st_pending")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
