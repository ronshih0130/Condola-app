import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { leasesCopy } from "../../../../i18n/lanes/brand-v3-leases";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import type { LeaseListRow, LeasesInput, LeasesResult } from "../../../../server/b3-leases";
import { displaySampleName } from "../../../../server/sandbox-data";
import { statusKey } from "../../../ui";
import { EmptyIllustration } from "../../../empty-illustration";

export function leasesHref(input: LeasesInput = {}) {
  const p = new URLSearchParams();
  if (input.q) p.set("q", input.q);
  if (input.page && input.page !== "1") p.set("page", input.page);
  return `/m/leases${p.size ? `?${p}` : ""}`;
}
/** 進行中 for an active lease (plus 即將到期); other lease states keep their existing labels. */
export function leaseStatusLabels(row: Pick<LeaseListRow, "status" | "endingSoon">, locale: Locale) {
  const c = leasesCopy(locale);
  if (row.status !== "active") return [makeT(locale)(statusKey(row.status))];
  return row.endingSoon ? [c.endingSoon, c.active] : [c.active];
}
/** MGT-112-AC7: skeletons in the loaded positions, never a count or an amount. */
export function LeasesLoading({ locale }: { locale: Locale }) {
  return <section className="v3-leases" aria-busy="true" aria-label={tenantsCopy(locale).loading}>
    {[0, 1, 2, 3].map(n => <div className="v3-leases-skeleton" key={n} aria-hidden="true" />)}
  </section>;
}
function Search({ q, locale }: { q: string; locale: Locale }) {
  const t = makeT(locale), c = leasesCopy(locale);
  return <form action="/m/leases" role="search" className="v3-leases-search">
    <label className="sr-only" htmlFor="v3-lease-search">{t("i_search")}</label>
    <input id="v3-lease-search" name="q" type="search" defaultValue={q} placeholder={t("i_search_ph_leases")} maxLength={80} />
    <button className="btn" type="submit">{t("i_search")}</button>
    {q && <Link className="btn" href={leasesHref()}>{c.clearSearch}</Link>}
  </form>;
}
export function LeasesView({ data, locale, params, canCreate = false }: {
  data: LeasesResult | { state: "forbidden" }; locale: Locale; params: LeasesInput; canCreate?: boolean;
}) {
  const c = leasesCopy(locale), t = makeT(locale);
  const title = <h1 className="sr-only">{t("i_nav_leases")}</h1>;
  // R3-LIST's own 403 (each package keeps its own): no button.
  if (data.state === "forbidden") return <section className="v3-leases" data-testid="v3-lease-list">{title}
    <div className="v3-leases-card v3-leases-empty" role="status"><h2>{c.permission}</h2><p>{c.permissionHint}</p></div></section>;
  const q = data.state === "ready" ? data.q : String(params.q ?? "").trim().slice(0, 80);
  if (data.state !== "ready") return <section className="v3-leases" data-testid="v3-lease-list">{title}
    <div className="v3-leases-card"><div className="v3-leases-toolbar"><Search q={q} locale={locale} /></div>
      {/* MGT-112-AC8: in place, the typed search is kept. */}
      <div className="v3-leases-empty" role="alert"><p>{c.failed}</p>
        <Link className="btn" href={leasesHref({ q, page: params.page })}>{c.retry}</Link></div></div></section>;
  const { rows, page } = data;
  return <section className="v3-leases" data-testid="v3-lease-list">{title}
    <div className="v3-leases-card">
      {data.total > 0 && <div className="v3-leases-toolbar"><Search q={q} locale={locale} /></div>}
      {!rows.length ? data.total === 0 && !q ? <div className="v3-leases-empty">
        <EmptyIllustration name="doc" /><h2>{c.empty}</h2><p>{c.emptyHint}</p>
        {canCreate && <Link className="btn pri" href="/m/leases/new">{c.create}</Link>}
      </div> : q ? <div className="v3-leases-empty" role="status">
        <EmptyIllustration name="search" /><h2>{c.noResult}</h2><p>{c.noResultHint}</p>
        <Link className="btn" href={leasesHref()}>{c.clearSearch}</Link>
      </div> : <div className="v3-leases-empty"><Link className="btn" href={leasesHref({ q })}>{t("i_search_prev")}</Link></div> :
      <table className="v3-leases-table"><thead><tr>
        <th scope="col">{t("i_nav_leases")}</th><th scope="col">{t("i_status")}</th><th scope="col"><span className="sr-only">{c.view}</span></th>
      </tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><Link className="v3-leases-row-link" href={`/m/leases/${row.id}`}>
            <strong>{displaySampleName(row.tenant)}</strong><span>{displaySampleName(row.place)}</span></Link></td>
          <td data-label={t("i_status")}><span className="v3-leases-badges">
            {leaseStatusLabels(row, locale).map(label => <span className="v3-leases-badge" key={label}>{label}</span>)}</span></td>
          <td><Link className="btn v3-leases-action" href={`/m/leases/${row.id}`}>{c.view}</Link></td>
        </tr>)}</tbody>
      </table>}
    </div>
    {(page > 1 || data.hasNext) && <nav className="v3-leases-pager" aria-label={t("i_nav_leases")}>
      {page > 1 && <Link className="btn" href={leasesHref({ q, page: String(page - 1) })}>{t("i_search_prev")}</Link>}
      {data.hasNext && <Link className="btn" href={leasesHref({ q, page: String(page + 1) })}>{t("i_search_next")}</Link>}
    </nav>}
  </section>;
}
