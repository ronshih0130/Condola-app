import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { listProperties } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PropertiesPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const rows = await listProperties(session);
  return (
    <>
      <PageHeader
        title={t("s_e03a6ec")}
        actions={
          <>
            <a className="btn" href="/api/export">
              {t("i_download")}
            </a>
            <Link className="btn pri" href="/m/properties/new">
              + {t("s_aed91da")}
            </Link>
          </>
        }
      />
      <div className="card">
        <table className="t">
          <thead>
            <tr>
              <th>{t("s_f19d4fb")}</th>
              <th>{t("s_d2c40b1")}</th>
              <th>{t("i_room")}</th>
              <th>{t("i_occ")}</th>
              <th>{t("i_owner")}</th>
              <th>{t("i_currency_label")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/m/properties/${row.id}`}>
                    <b>{row.name}</b>
                  </Link>
                  <div className="small muted">{row.address_display}</div>
                </td>
                <td>{row.rental_mode === "by_room" ? t("i_by_room") : t("i_whole_unit")}</td>
                <td>{row.rooms}</td>
                <td>
                  {row.occupied}/{row.rooms}
                </td>
                <td>{row.owner_name}</td>
                <td>{row.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
