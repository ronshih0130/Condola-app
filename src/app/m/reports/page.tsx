import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { archiveCopy } from "@/i18n/record-archive";
import { makeT } from "@/i18n";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { FlowError } from "@/server/errors";
import { moneyLabel } from "@/server/format";
import { loadIncomeExpense, reportFilterOptions, reportPeriod, type ReportPeriod, type ReportRow } from "@/server/income-expense";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

function queryString(period: ReportPeriod, property: string, owner: string) {
  const params = new URLSearchParams();
  params.set("mode", period.mode);
  if (period.mode === "month") params.set("month", period.month);
  if (period.mode === "range") {
    params.set("from", period.start);
    params.set("to", period.end);
  }
  if (property) params.set("property", property);
  if (owner) params.set("owner", owner);
  return params.toString();
}

export default async function IncomeExpenseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; month?: string; from?: string; to?: string; property?: string; owner?: string; error?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const choices = await reportFilterOptions(session);
  let errorKey = params.error;
  let rows: ReportRow[] = [];
  let period: ReportPeriod = {
    mode: params.mode === "range" ? "range" : "month",
    month: params.month ?? "",
    start: params.from ?? "",
    end: params.to ?? "",
  };
  try {
    period = reportPeriod({ mode: params.mode, month: params.month, from: params.from, to: params.to });
    rows = await loadIncomeExpense(session, {
      start: period.start,
      end: period.end,
      propertyId: params.property,
      ownerId: params.owner,
    });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.reportRange") errorKey = error.key;
    else throw error;
  }
  const property = params.property ?? "";
  const owner = params.owner ?? "";
  const exportHref = `/m/reports/export?${queryString(period, property, owner)}`;
  return (
    <>
      <PageHeader
        title={t("i_nav_reports")}
        actions={
          <Link className="btn" href={exportHref} data-testid="report-export">
            {t("i_report_export")}
          </Link>
        }
      />
      <p className="small muted">{t("i_report_hint")}</p>
      {period.start && period.end ? (
        <p className="small" data-testid="report-period">
          {t("i_report_period", { start: period.start, end: period.end })}
        </p>
      ) : null}
      <ErrorBanner t={t} error={errorKey} />
      <form className="card pad" method="get" id="report-filters" data-testid="report-filters" style={{ margin: "16px 0", maxWidth: 960 }}>
        <div className="row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <div className="fg" style={{ minWidth: 140 }}>
            <label className="f">{t("i_report_mode")}</label>
            <select className="inp" name="mode" data-testid="report-mode" defaultValue={period.mode}>
              <option value="month">{t("i_report_month")}</option>
              <option value="range">{t("i_report_custom")}</option>
            </select>
          </div>
          <div className="fg" style={{ minWidth: 160 }}>
            <label className="f">{t("i_report_month")}</label>
            <input className="inp" type="month" name="month" data-testid="report-month" defaultValue={period.month} />
          </div>
          <div className="fg" style={{ minWidth: 160 }}>
            <label className="f">{t("i_report_from")}</label>
            <input className="inp" type="date" name="from" data-testid="report-from" defaultValue={params.from ?? ""} />
          </div>
          <div className="fg" style={{ minWidth: 160 }}>
            <label className="f">{t("i_report_to")}</label>
            <input className="inp" type="date" name="to" data-testid="report-to" defaultValue={params.to ?? ""} />
          </div>
          <div className="fg" style={{ minWidth: 180 }}>
            <label className="f">{t("i_col_property")}</label>
            <select className="inp" name="property" data-testid="report-property" defaultValue={property}>
              <option value="">{t("i_report_all_properties")}</option>
              {choices.properties.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.archiveState === "archived" ? ` (${archiveCopy(session.locale).archived})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="fg" style={{ minWidth: 180 }}>
            <label className="f">{t("i_owner")}</label>
            <select className="inp" name="owner" data-testid="report-owner" defaultValue={owner}>
              <option value="">{t("i_report_all_owners")}</option>
              {choices.owners.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit" data-testid="report-apply">
            {t("i_filter_apply")}
          </button>
        </div>
      </form>
      <div className="card">
        {rows.length === 0 ? (
          <ManagementEmptyState session={session} page="RPT" />
        ) : (
          <RfTable testId="report-list">
            <thead>
              <tr>
                <th>{t("i_col_property")}</th>
                <th>{t("i_owner")}</th>
                <th>{t("i_report_currency")}</th>
                <th className="num">{t("i_report_income")}</th>
                <th className="num">{t("i_report_expense")}</th>
                <th className="num">{t("i_report_net")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const total = !row.property_id;
                const label = total ? t("i_report_total") : displaySampleName(row.property_name ?? "");
                return (
                  <tr
                    key={`${row.currency}-${row.property_id ?? "total"}`}
                    data-testid="report-row"
                    data-total={total ? "true" : "false"}
                    data-currency={row.currency}
                  >
                    <Cell label={t("i_col_property")}>{label}</Cell>
                    <Cell label={t("i_owner")}>{row.owner_name || "—"}</Cell>
                    <Cell label={t("i_report_currency")}>{row.currency}</Cell>
                    <Cell label={t("i_report_income")} className="num">
                      {moneyLabel(row.income_minor, row.currency, session.locale)}
                    </Cell>
                    <Cell label={t("i_report_expense")} className="num">
                      {moneyLabel(row.expense_minor, row.currency, session.locale)}
                    </Cell>
                    <Cell label={t("i_report_net")} className="num">
                      {moneyLabel(row.net_minor, row.currency, session.locale)}
                    </Cell>
                  </tr>
                );
              })}
            </tbody>
          </RfTable>
        )}
      </div>
    </>
  );
}
