import React from "react";
import Link from "next/link";
import { dictionary, makeT, type Locale } from "../../../../i18n";
import { brandV3OwnerHomeCopy, brandV3OwnerStateCopy } from "../../../../i18n/lanes/brand-v3";
import { brandV3OwnerDecidedCopy } from "../../../../i18n/lanes/brand-v3-owner-decided";
import { repairApprovalCopy } from "../../../../i18n/repair-approval";
import { cursorParam, type DecidedCursor, type DecidedLine, type DecidedTicket, type Decision } from "../../../../server/b093-owner-decided";
import { formatDate } from "../../../../server/format";
import { ownerEstimateAmount } from "../../../../server/owner-home-v3";
import { displaySampleName } from "../../../../server/sandbox-data";
import type { CalendarMode } from "../../../../server/types";
import { Illustration } from "../../illustrations";

/** RO-DECIDED (更多 › 核准紀錄). Read-only: no solid primary on the list or the view (OWN-35). */
export const DECIDED_HREF = "/o/decided";
export const decidedTicketHref = (ticketId: string) => `/o/approvals/${encodeURIComponent(ticketId)}`;
export const decidedPageHref = (after?: DecidedCursor | null) => after ? `${DECIDED_HREF}?after=${encodeURIComponent(cursorParam(after))}` : DECIDED_HREF;
const TONE: Record<Decision, string> = { approved: "decided-approved", rejected: "decided-rejected", more_information: "decided-info" };
// The app's existing ticket status labels (components/ui.tsx, /v/[token]).
const STATUS: Record<string, string> = {
  open: "i_st_open", triaged: "i_st_triaged", assigned: "i_st_assigned", in_progress: "i_st_progress",
  on_hold: "i_st_hold", resolved: "i_st_resolved", closed: "i_st_closed", cancelled: "i_st_cancelled",
};
type View = { locale: Locale; calendar: CalendarMode };
const day = (value: string, { locale, calendar }: View) => formatDate(value, locale, calendar, dictionary(locale));
const amount = (row: { amountMinor: string; currency: string; minorUnit: number }) => ownerEstimateAmount(row.amountMinor, row.currency, row.minorUnit);
const Title = ({ locale }: { locale: Locale }) => <h2 className="decided-sr">{brandV3OwnerDecidedCopy(locale).title}</h2>;
function Result({ decision, locale }: { decision: Decision; locale: Locale }) {
  return <span className={`decided-badge ${TONE[decision]}`}>{brandV3OwnerDecidedCopy(locale).result[decision]}</span>;
}

/** GS-02 loading: skeletons only, never a number, count or NT$0. */
export function DecidedLoading({ locale, detail = false }: { locale: Locale; detail?: boolean }) {
  return <section className="v3-owner-decided" aria-busy="true" data-testid={detail ? "owner-decided-detail-loading" : "owner-decided-loading"}>
    <Title locale={locale} />
    <div className="decided-card" aria-hidden="true">{[0, 1, 2].map(i => <div className="decided-skeleton" key={i}><span /><span /></div>)}</div>
  </section>;
}
/** GS-02 read error in place, with an outline retry (the list has no solid primary). */
export function DecidedError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const state = brandV3OwnerStateCopy(locale);
  return <section className="v3-owner-decided" data-testid="owner-decided-error">
    <Title locale={locale} />
    <div className="decided-card" role="alert"><p>{state.error}</p><a className="owner-action" href={retryHref}>{state.retry}</a></div>
  </section>;
}
/** GS-03 / B1-NOPERM: drawing 26, one sentence, one primary back home. No record is named. */
export function DecidedNoPerm({ locale }: { locale: Locale }) {
  const copy = brandV3OwnerDecidedCopy(locale);
  return <section className="v3-owner-decided decided-noperm" data-testid="owner-decided-noperm">
    <Title locale={locale} />
    <Illustration name="26" /><p>{copy.noPerm}</p>
    <Link className="owner-action owner-primary" href="/o">{copy.home}</Link>
  </section>;
}

/** OWN-35-AC1 / AC3: newest first; 物件・項目, 金額, date, result; empty sentence (PR-023). */
export function DecidedListView({ rows, next, ...view }: View & { rows: DecidedLine[]; next: DecidedCursor | null }) {
  const copy = brandV3OwnerDecidedCopy(view.locale);
  return <section className="v3-owner-decided" data-testid="owner-decided-list">
    <Title locale={view.locale} />
    {rows.length ? <div className="decided-card"><ul className="decided-lines">{rows.map(row => <li key={row.versionId}>
      <Link className="decided-line" href={decidedTicketHref(row.ticketId)} data-testid="owner-decided-line">
        <span className="decided-main"><b>{displaySampleName(row.property)}・{row.item}</b>
          <span className="decided-sub"><span className="num">{amount(row)}</span>・<time dateTime={row.decidedOn}>{day(row.decidedOn, view)}</time></span></span>
        <Result decision={row.decision} locale={view.locale} />
      </Link></li>)}</ul></div>
      : <div className="decided-card decided-empty" data-testid="owner-decided-empty"><p>{copy.empty}</p></div>}
    {next ? <nav className="decided-pager" aria-label={copy.title}>
      <Link className="owner-action" href={decidedPageHref(next)} data-testid="owner-decided-next">{makeT(view.locale)("i_search_next")}</Link>
    </nav> : null}
  </section>;
}

/** OWN-35-AC2: version, scope, the owner's reason (if any) and the repair's later progress. Read-only. */
export function DecidedTicketView({ detail, ...view }: View & { detail: DecidedTicket }) {
  const home = brandV3OwnerHomeCopy(view.locale), existing = repairApprovalCopy(view.locale);
  const t = makeT(view.locale);
  return <section className="v3-owner-decided" data-testid="owner-decided-detail">
    <h2>{displaySampleName(detail.property)}・{detail.item}</h2>
    <dl className="decided-facts"><dt>{home.status}</dt><dd data-testid="owner-decided-status">{STATUS[detail.status] ? t(STATUS[detail.status]) : "—"}</dd></dl>
    {detail.versions.map(version => <article className="decided-card decided-version" key={version.versionId} data-testid="owner-decided-version">
      <h3>{home.versionNumber.replace("{n}", version.versionNo)}</h3>
      <dl className="decided-facts">
        <dt>{home.amount}</dt><dd className="num">{amount(version)}</dd>
        <dt>{existing.decision}</dt><dd><Result decision={version.decision} locale={view.locale} /></dd>
        <dt>{existing.decidedAt}</dt><dd><time dateTime={version.decidedOn}>{day(version.decidedOn, view)}</time></dd>
        <dt>{existing.scope}</dt><dd className="decided-text">{version.workScope}</dd>
        {version.reason ? <><dt>{home.reason}</dt><dd className="decided-text">{version.reason}</dd></> : null}
      </dl>
    </article>)}
    <Link className="owner-text-link" href={DECIDED_HREF}>{brandV3OwnerDecidedCopy(view.locale).title}</Link>
  </section>;
}
