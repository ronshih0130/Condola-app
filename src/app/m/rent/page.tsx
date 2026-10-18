import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
import { dashboard } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function RentPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const data = await dashboard(session);
  return (
    <>
      <PageHeader title={t("i_rentroll_title")} />
      <div className="card">
        <table className="t">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("s_2540915")}</th>
              <th className="num">{t("i_open_balance")}</th>
            </tr>
          </thead>
          <tbody>
            {data.owing.map((row) => (
              <tr key={row.lease_id}>
                <td>
                  <Link href={`/m/leases/${row.lease_id}?tab=ledger`}>{row.tenant}</Link>
                </td>
                <td>{row.place}</td>
                <td className="num">{formatMoney(Number(row.balance), row.currency, session.locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
