import Link from "next/link";
import { dictionary, makeT } from "@/i18n";
import { ListPager, ListSearch, listSummary } from "@/components/list-search";
import { Cell, RfTable } from "@/components/rf";
import { PageHeader, statusClass, statusKey } from "@/components/ui";
import { formatDate, moneyLabel } from "@/server/format";
import { searchLeases } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LeasesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await getSession();
  const raw = await searchParams;
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  const result = await searchLeases(session, raw);
  const { rows, q, page, hasNext, total, from, to } = result;
  const summary = listSummary(t, result);
  const money = (minor: string, currency: string) => moneyLabel(Number(minor), currency, session.locale);
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
        <ListSearch action="/m/leases" q={q} label={t("i_search")} placeholder={t("i_search_ph_leases")} clearLabel={t("i_search_clear")} />
        <RfTable testId="lease-list">
          <thead>
            <tr>
              <th>{t("s_74f19b0")}</th>
              <th>{t("i_space")}</th>
              <th>{t("i_term")}</th>
              <th>{t("i_rent_label")}</th>
              <th>{t("i_deposit_label")}</th>
              <th>{t("i_elec")}</th>
              <th>{t("i_status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>{q ? t("i_search_none") : t("i_empty")}</td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.id} className="click">
                <Cell>
                  <Link className="hit" href={`/m/leases/${row.id}`}>
                    {displaySampleName(row.tenant)}
                  </Link>
                </Cell>
                <Cell label={t("i_space")}>{displaySampleName(row.place)}</Cell>
                <Cell label={t("i_term")}>
                  {formatDate(row.start_date, session.locale, session.calendar, dict)} – {formatDate(row.end_date, session.locale, session.calendar, dict)}
                </Cell>
                <Cell label={t("i_rent_label")}>
                  <span data-testid="lease-rent" data-currency={row.currency.trim()}>{money(row.rent, row.currency)}</span>
                </Cell>
                <Cell label={t("i_deposit_label")}>
                  <span data-testid="lease-deposit" data-currency={row.currency.trim()}>{money(row.deposit, row.currency)}</span>
                </Cell>
                <Cell label={t("i_elec")}>
                  {row.electricity === "even"
                    ? t("i_split_even")
                    : row.electricity === "sub_meter"
                      ? t("i_split_sub")
                      : row.electricity === "days_occupied"
                        ? t("i_split_days")
                        : row.electricity === "shared"
                          ? t("i_elec_shared")
                          : row.electricity || t("i_elec_unset")}
                </Cell>
                <Cell label={t("i_status")}>
                  <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
                </Cell>
              </tr>
            ))}
          </tbody>
        </RfTable>
      </div>
      <ListPager
        path="/m/leases"
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
