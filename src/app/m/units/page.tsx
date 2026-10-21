import Link from "next/link";
import { makeT } from "@/i18n";
import { ListPager, ListSearch, listSummary } from "@/components/list-search";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
import { can } from "@/server/perms";
import { searchSpaces } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function UnitsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await getSession();
  const raw = await searchParams;
  const t = makeT(session.locale);
  const result = await searchSpaces(session, raw);
  const { rows, q, page, hasNext, total, from, to } = result;
  const summary = listSummary(t, result);
  const editable = can(session.role, "props.edit");
  const roomTypeKey: Record<string, string> = {
    whole_home: "i_whole_home",
    suite: "i_room_split",
    shared_bath: "i_shared",
    studio: "i_studio",
    other: "i_other_room",
  };
  return (
    <>
      <PageHeader
        title={t("i_units_title")}
        actions={
          editable ? (
            <Link className="btn pri" href="/m/units/new" data-testid="new-space">
              + {t("i_space_new")}
            </Link>
          ) : null
        }
      />
      <div className="card">
        <ListSearch action="/m/units" q={q} label={t("i_search")} placeholder={t("i_search_ph_units")} clearLabel={t("i_search_clear")} />
        <table className="t rf" data-testid="space-list">
          <thead>
            <tr>
              <th>{t("i_property_name")}</th>
              <th>{t("i_space_kind")}</th>
              <th>{t("i_floor_unit")}</th>
              <th>{t("i_room_no")}</th>
              <th>{t("i_room_type")}</th>
              <th>{t("i_area_ping")}</th>
              <th>{t("i_base_rent")}</th>
              <th>{t("i_owner")}</th>
              <th>{t("i_elec_method")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10}>{q ? t("i_search_none") : t("i_empty")}</td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={`${row.kind}-${row.id}`} data-testid={`space-row-${row.floor}-${row.room_label ?? "unit"}`}>
                <td>
                  <Link href={`/m/properties/${row.property_id}`}>{displaySampleName(row.property_name)}</Link>
                </td>
                <td data-label={t("i_space_kind")}>{row.kind === "room" ? t("i_space_room") : t("i_space_whole")}</td>
                <td data-label={t("i_floor_unit")}>{displaySampleName(row.floor)}</td>
                <td data-label={t("i_room_no")}>{row.room_label ? displaySampleName(row.room_label) : "—"}</td>
                <td data-label={t("i_room_type")}>{row.room_type ? t(roomTypeKey[row.room_type] ?? "i_other_room") : "—"}</td>
                <td data-label={t("i_area_ping")}>{row.area_value || "—"}</td>
                <td className="num" data-label={t("i_base_rent")}>
                  {row.base_rent_minor ? formatMoney(Number(row.base_rent_minor), row.currency, session.locale) : "—"}
                </td>
                <td data-label={t("i_owner")}>{row.owner_name ? displaySampleName(row.owner_name) : "—"}</td>
                <td data-label={t("i_elec_method")}>
                  {row.electricity_method === "submeter"
                    ? t("i_elec_submeter")
                    : row.electricity_method === "tenant_direct"
                      ? t("i_elec_direct")
                      : "—"}
                </td>
                <td className="r">
                  {editable ? (
                    <Link className="btn sm" href={row.kind === "room" ? `/m/units/room/${row.id}` : `/m/units/whole/${row.id}`}>
                      {t("i_edit")}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager
        path="/m/units"
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
