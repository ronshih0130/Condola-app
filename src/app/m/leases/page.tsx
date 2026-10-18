import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader, statusClass, statusKey } from "@/components/ui";
import { formatDate, formatMoney } from "@/server/format";
import { dictionary } from "@/i18n";
import { listLeases } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LeasesPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  const rows = await listLeases(session);
  return (
    <>
      <PageHeader
        title={t("s_fba85ae")}
        actions={
          <Link className="btn pri" href="/m/leases/new">
            + {t("s_e96eefc")}
          </Link>
        }
      />
      <div className="card">
        <table className="t">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("s_2540915")}</th>
              <th>{t("i_rent_label")}</th>
              <th>{t("i_period")}</th>
              <th>{t("i_status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/m/leases/${row.id}`}>{row.tenant}</Link>
                </td>
                <td className="small">{row.place}</td>
                <td className="num">{formatMoney(Number(row.rent), row.currency, session.locale)}</td>
                <td className="small">
                  {formatDate(row.start_date, session.locale, session.calendar, dict)} – {formatDate(row.end_date, session.locale, session.calendar, dict)}
                </td>
                <td>
                  <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
