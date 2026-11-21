import React from "react";
import Link from "next/link";
import { dictionary, makeT, translate } from "../../../../i18n";
import { incomeReportCopy } from "../../../../i18n/lanes/brand-v3-report";
import { formatDate } from "../../../../server/format";
import { reportMoney } from "../../../../server/b3-income-report-format";
import type { IncomeReport, IncomeReportInput, IncomeReportLine } from "../../../../server/b3-income-report";
import { can } from "../../../../server/perms";
import type { Session } from "../../../../server/types";
import { ReportDrawing } from "./report-drawing";
const styles = Object.fromEntries(["report", "heading", "lead", "filters", "columns", "card", "tableWrap", "amount", "source", "deposit", "empty", "pagination", "skeleton"].map(key => [key, `v3-income-report-${key}`]));

export function reportHref(input: IncomeReportInput, cursor?: string, exportCsv = false) {
  const params = new URLSearchParams();
  for (const key of ["mode", "month", "from", "to", "property", "owner"] as const) if (input[key]) params.set(key, input[key]!);
  if (cursor) params.set("cursor", cursor);
  return `/m/reports${exportCsv ? "/export" : ""}?${params}`;
}
export function ReportSkeleton() {
  return <div className={styles.report} aria-busy="true" data-testid="report-skeleton">
    <div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} />
  </div>;
}
export function IncomeReportView({ session, input, data }: { session: Session; input: IncomeReportInput; data: IncomeReport }) {
  const c = incomeReportCopy(session.locale), t = makeT(session.locale), ready = data.state === "ready";
  const filters = ready ? { ...input, mode: data.period.mode, month: data.period.month, from: data.period.start, to: data.period.end } : input;
  const money = (minor: string, currency: string) => reportMoney(minor, currency, session.locale);
  const date = (value: string) => formatDate(value, session.locale, session.calendar, dictionary(session.locale));
  const period = ready ? data.period.mode === "month" ? data.period.month : `${date(data.period.start)} – ${date(data.period.end)}` : "";
  const choices = ready ? data.choices : { properties: [], owners: [] };
  const source = (row: IncomeReportLine) => <details className={styles.source}>
    <summary>{c.source}</summary>
    <dl><dt>{c.sourceId}</dt><dd>{row.sourceId}</dd><dt>{c.date}</dt><dd>{date(row.date)}</dd>
      {row.paidOn && <><dt>{c.paidOn}</dt><dd>{date(row.paidOn)}</dd></>}
      {row.leaseId && <><dt>{c.lease}</dt><dd>{row.leaseId}</dd></>}
      {row.serviceMonthStart && <><dt>{c.serviceMonth}</dt><dd>{date(row.serviceMonthStart)}</dd></>}
      <dt>{c.item}</dt><dd>{c[row.kind]} · {row.item}</dd><dt>{c.amount}</dt><dd>{money(row.sourceAmountMinor, row.currency)}</dd></dl>
    {row.kind === "expense" && can(session, "exp.add") && <Link href={`/m/expenses/${row.sourceId}`}>{c.source}</Link>}
  </details>;
  const table = (rows: IncomeReportLine[]) => <div className={styles.tableWrap}><table>
    <thead><tr>{[c.date, c.item, c.property, c.owner, c.amount, c.sourceId].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.key} data-testid="report-v3-line" data-kind={row.kind}>
      <td>{date(row.date)}</td><td>{c[row.kind]} · {row.item}</td><td>{row.property}</td><td>{row.owner || "—"}</td>
      <td className={styles.amount}>{money(row.amountMinor, row.currency)}</td><td>{source(row)}</td>
    </tr>)}</tbody>
  </table></div>;
  return <div className={styles.report} data-testid="report-v3">
    <header className={styles.heading}><h1>{c.title}</h1>
      {ready && data.count > 0 && can(session, "reports.export") && <Link className="btn" href={reportHref(filters, undefined, true)} data-testid="report-export">{c.export}</Link>}
    </header>
    {ready && data.count > 0 && <div className={styles.lead}>{data.totals.map(total => <p key={total.currency} data-testid="report-v3-total">
      {translate(c, "lead", { period, income: money(total.incomeMinor, total.currency), expense: money(total.expenseMinor, total.currency), net: money(total.netMinor, total.currency) })}
    </p>)}<p>{c.hint}</p></div>}
    <form method="get" action="/m/reports" className={styles.filters} data-testid="report-filters">
      <label>{c.period}<select name="mode" defaultValue={filters.mode ?? "month"}>
        <option value="month">{t("i_report_month")}</option><option value="range">{t("i_report_custom")}</option>
      </select></label>
      <label>{t("i_report_month")}<input name="month" type="month" defaultValue={filters.month ?? ""} /></label>
      <label>{t("i_report_from")}<input name="from" type="date" defaultValue={filters.from ?? ""} /></label>
      <label>{t("i_report_to")}<input name="to" type="date" defaultValue={filters.to ?? ""} /></label>
      <label>{c.property}<select name="property" defaultValue={filters.property ?? ""}>
        <option value="">{t("i_report_all_properties")}</option>
        {input.property && !choices.properties.some(choice => choice.id === input.property) && <option value={input.property}>{input.property}</option>}
        {choices.properties.map(choice => <option value={choice.id} key={choice.id}>{choice.name}</option>)}
      </select></label>
      <label>{c.owner}<select name="owner" defaultValue={filters.owner ?? ""}>
        <option value="">{t("i_report_all_owners")}</option>
        {input.owner && !choices.owners.some(choice => choice.id === input.owner) && <option value={input.owner}>{input.owner}</option>}
        {choices.owners.map(choice => <option value={choice.id} key={choice.id}>{choice.name}</option>)}
      </select></label>
      <button className="btn o" type="submit">{t("i_filter_apply")}</button>
    </form>
    {!ready ? <div role="alert" className={styles.card}><p>{c.failed}</p><Link href={reportHref(input, input.cursor)}>{c.retry}</Link></div>
      : data.count === 0 ? <div className={styles.empty}><ReportDrawing /><p>{c.empty}</p></div>
      : <div className={styles.columns}><section className={styles.card}>{table(data.rows.filter(row => row.kind === "income" || row.kind === "expense"))}</section>
        <aside className={styles.card}><h2>{c.separate}</h2>
          {(["deposit", "earlyRent", "prepayment"] as const).map(kind => <section key={kind} data-testid={`report-separate-${kind}`}>
            <h3>{kind === "earlyRent" ? c.earlyRentHeading : c[kind]}</h3>
            {kind === "earlyRent" && <p>{c.serviceMonthHint}</p>}
            {data.totals.map(total => <p key={total.currency}>{c[kind]} {money(total[kind === "deposit" ? "depositMinor" : kind === "earlyRent" ? "earlyRentMinor" : "prepaymentMinor"], total.currency)}</p>)}
            {data.rows.filter(row => row.kind === kind).map(row => <div key={row.key} className={styles.deposit} data-kind={kind}>
              <p>{date(row.date)} · {row.property} · {row.owner || "—"}</p><p>{row.item} · {money(row.amountMinor, row.currency)}</p>
              {row.leaseId && <p>{c.lease} · {row.leaseId}</p>}
              {row.serviceMonthStart && <p>{c.serviceMonth} · {date(row.serviceMonthStart)}</p>}
              {source(row)}
            </div>)}
          </section>)}
          <p>{c.tax}</p>
        </aside></div>}
    {ready && (input.cursor || data.nextCursor) && <nav className={styles.pagination}>
      {input.cursor && <Link href={reportHref(filters)}>{c.back}</Link>}
      {data.nextCursor && <Link href={reportHref(filters, data.nextCursor)}>{c.next}</Link>}
    </nav>}
  </div>;
}
