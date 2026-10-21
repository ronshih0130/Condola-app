import Link from "next/link";
import { makeT } from "@/i18n";
import { ListPager, ListSearch, listSummary } from "@/components/list-search";
import { SampleTag } from "@/components/sample-tag";
import { PageHeader } from "@/components/ui";
import { searchProperties } from "@/server/queries";
import { isSampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PropertiesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await getSession();
  const raw = await searchParams;
  const t = makeT(session.locale);
  const result = await searchProperties(session, raw);
  const { rows, q, page, hasNext, total, from, to } = result;
  const summary = listSummary(t, result);
  return (
    <>
      <PageHeader
        title={t("s_e03a6ec")}
        actions={
          <>
            <a className="btn" href="/api/export" data-testid="export-properties">
              {t("s_de922fa")}
            </a>
            <Link className="btn pri" href="/m/properties/new">
              + {t("s_aed91da")}
            </Link>
          </>
        }
      />
      <div className="card">
        <ListSearch
          action="/m/properties"
          q={q}
          label={t("i_search")}
          placeholder={t("i_search_ph_properties")}
          clearLabel={t("i_search_clear")}
        />
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
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>{q ? t("i_search_none") : t("i_empty")}</td>
              </tr>
            ) : null}
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
      <ListPager
        path="/m/properties"
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
