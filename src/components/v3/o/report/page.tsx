import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "@/i18n";
import { brandV3OwnerReportCopy, brandV3OwnerStateCopy } from "@/i18n/lanes/brand-v3";
import { StatementDocument } from "@/components/statement-document";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { OwnerNetLedgerPanel } from "@/components/owner-net-ledger-panel";
import { OwnerReportReplies } from "@/components/owner-report-replies";
import { loadOwnerReport, type OwnerReportData } from "@/server/owner-report-v3";
import type { Session } from "@/server/types";

export function OwnerReportLoading({ locale }: { locale: Locale }) {
  return <section className="v3-owner-report" aria-busy="true" data-testid="owner-report-loading">
    <h2>{makeT(locale)("i_owner_nav_stmt")}</h2><div className="report-skeleton" aria-hidden="true" />
  </section>;
}
export function OwnerReportError({ locale, month }: { locale: Locale; month?: string }) {
  const copy = brandV3OwnerStateCopy(locale);
  return <section className="v3-owner-report" data-testid="owner-report-error">
    <h2>{makeT(locale)("i_owner_nav_stmt")}</h2><p role="alert">{copy.error}</p>
    <a className="btn sec" href={month ? `/o/statements?month=${encodeURIComponent(month)}` : "/o/statements"}>{copy.retry}</a>
  </section>;
}
export async function OwnerReportPage({ session, month }: { session: Session; month: unknown }) {
  let data: OwnerReportData;
  try { data = await loadOwnerReport(session, month); }
  catch { return <OwnerReportError locale={session.locale} month={typeof month === "string" ? month : undefined} />; }
  return <OwnerReportView data={data} locale={session.locale} />;
}
export function OwnerReportView({ data, locale }: { data: OwnerReportData; locale: Locale }) {
  const t = makeT(locale), copy = brandV3OwnerReportCopy(locale);
  if (!data.month) return <section className="v3-owner-report" data-testid="owner-report-empty">
    <h2>{t("i_owner_nav_stmt")}</h2><p>{t("i_statement_empty")}</p>
  </section>;
  const title = (month: string) => copy.title.replace("{month}", locale === "en" ? month : String(Number(month.slice(5))));
  return <section className="v3-owner-report" data-testid="owner-report" data-month={data.month}>
    <header className="report-title-row">
      <h2>{title(data.month)}</h2>
      <nav className="report-month" aria-label={t("i_owner_nav_stmt")}>
        {data.previous && <Link href={`/o/statements?month=${data.previous}`} aria-label={title(data.previous)} data-testid="report-previous">‹</Link>}
        <span className="num">{data.month}</span>
        {data.next && <Link href={`/o/statements?month=${data.next}`} aria-label={title(data.next)} data-testid="report-next">›</Link>}
      </nav>
    </header>
    {data.reports.map(report => <article key={report.id} data-testid="owner-report-item" data-statement-id={report.id}>
      <h3>{[report.properties, report.row.currency].filter(Boolean).join("・")}</h3>
      <p><PdfDownloadButton href={`/api/pdf/statements/${report.id}`} label={t("s_874a842")} failed={t("pdf_failed")} fontFailed={t("pdf_font_missing")} testId="download-statement-pdf" /></p>
      <StatementDocument v2 rentLabel={copy.rent} t={t} locale={locale} row={report.row} lines={report.lines} note={<p className="small">{t("i_actor")}</p>}
        rentSource={report.source ? <details className="report-source" data-testid="report-rent-source">
          <summary>{copy.source}</summary><p>{copy.sourceLine.replace("{n}", String(report.source.count)).replace("{date}", report.source.date)}</p>
        </details> : undefined} />
      {report.ledger && <OwnerNetLedgerPanel view={report.ledger} locale={locale} negativeLabel={t("owner_owes")} />}
      {report.replies && <OwnerReportReplies view={report.replies} locale={locale} />}
    </article>)}
    <p className="small">{copy.note}</p>
  </section>;
}
