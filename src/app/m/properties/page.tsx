import Link from "next/link";
import { makeT } from "@/i18n";
import { SampleTag } from "@/components/sample-tag";
import { PageHeader } from "@/components/ui";
import { isSampleName } from "@/server/sandbox-data";
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
        <table className="t rf" data-testid="property-list">
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
              <tr key={row.id} className="click">
                <td>
                  <Link className="hit" href={`/m/properties/${row.id}`}>
                    <b>{row.name}</b>
                  </Link>{" "}
                  <SampleTag show={isSampleName(row.name)} label={t("i_sample_tag")} />
                  <div className="small muted">{row.address_display}</div>
                </td>
                <td data-label={t("s_d2c40b1")}>{row.rental_mode === "by_room" ? t("i_by_room") : t("i_whole_unit")}</td>
                <td data-label={t("i_room")}>{row.rooms}</td>
                <td data-label={t("i_occ")}>
                  {row.occupied}/{row.rooms}
                </td>
                <td data-label={t("i_owner")}>{row.owner_name}</td>
                <td data-label={t("i_currency_label")}>{row.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
