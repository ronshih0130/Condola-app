import React from "react";
import Link from "next/link";
import type { Locale } from "../../../../i18n";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import type { TenantsInput, TenantsResult } from "../../../../server/b3-tenants";
import { displaySampleName } from "../../../../server/sandbox-data";
import { RoleAvatar } from "../../role-avatar";
import { EmptyState } from "../../../empty-state";
import { EmptyIllustration } from "../../../empty-illustration";

export function tenantsHref(input: TenantsInput = {}) {
  const p = new URLSearchParams();
  if (input.q) p.set("q",input.q);
  if (input.filter==="missing") p.set("filter","missing");
  if (input.cursor) p.set("cursor",input.cursor);
  return `/m/tenants${p.size ? `?${p}` : ""}`;
}
export function TenantsLoading({ locale }: { locale: Locale }) {
  return <section className="v3-tenants" aria-busy="true" aria-label={tenantsCopy(locale).loading}>
    {[0,1,2,3].map(n => <div className="v3-tenants-skeleton" key={n} aria-hidden="true" />)}
  </section>;
}
export function TenantsView({ data,locale,params,canInvite=false }: {
  data: TenantsResult | { state:"forbidden" }; locale: Locale; params: TenantsInput; canInvite?: boolean;
}) {
  const c = tenantsCopy(locale);
  if (data.state!=="ready") return <section className="v3-tenants"><h1>{c.title}</h1>
    {data.state==="forbidden" ? <p role="status">{c.permission}</p> : <div role="alert"><p>{c.failed}</p>
      <Link className="btn" href={tenantsHref({q:params.q,filter:params.filter})}>{c.retry}</Link></div>}</section>;
  const { q,rows,canViewPhone,mobileRequired } = data;
  const filter = mobileRequired ? data.filter : "all";
  const base = { q,filter };
  const searchLabel = canViewPhone ? c.search : c.searchPrivate;
  return <section className="v3-tenants" data-testid="v3-tenant-list">
    <p className="v3-tenants-crumb">{c.area} › {c.title}</p>
    <header className="v3-tenants-lead"><h1>{canViewPhone
      ? (mobileRequired ? c.lead : c.leadOff).replace("{n}",String(data.total)).replace("{k}",String(data.missing))
      : <>{c.all} <span className="num">{data.total}</span></>}</h1></header>
    <div className="v3-tenants-card">
      <div className="v3-tenants-toolbar">
        <form action="/m/tenants" role="search" className="v3-tenants-search">
          <label className="sr-only" htmlFor="v3-tenant-search">{searchLabel}</label>
          <input id="v3-tenant-search" name="q" type="search" defaultValue={q} placeholder={searchLabel} maxLength={80} />
          {filter==="missing" && <input type="hidden" name="filter" value="missing" />}
          <button className="btn" type="submit">{c.submit}</button>
          {q && <Link className="btn" href={tenantsHref({filter})}>{c.clearSearch}</Link>}
        </form>
        <nav className="v3-tenants-chips" aria-label={c.title}>
          <Link className="btn" href={tenantsHref({q})} aria-current={filter==="all" ? "page" : undefined}>{c.all} <span className="num">{data.total}</span></Link>
          {canViewPhone && mobileRequired && <Link className="btn" href={tenantsHref({q,filter:"missing"})} aria-current={filter==="missing" ? "page" : undefined}>{c.missing.replace("{n}",String(data.missing))}</Link>}
        </nav>
      </div>
      {!rows.length ? q ? <section className="v3-tenants-empty" role="status">
        <EmptyIllustration name="search" /><h2>{c.noResult}</h2><p>{c.noResultHint}</p>
        <Link className="btn" href={tenantsHref({filter})}>{c.clearSearch}</Link>
      </section> : filter==="missing" ? <section className="v3-tenants-empty" role="status">
        <EmptyIllustration name="people" /><h2>{c.emptyFilter}</h2><Link className="btn" href="/m/tenants">{c.clearFilter}</Link>
      </section> : data.total===0 ? <div className="v3-tenants-empty">
        <EmptyState id="TEN" locale={locale} />
        {canInvite ? <Link className="btn" href="/m/units">{c.invite}</Link> : <p>{c.permission}</p>}
      </div> : <div className="v3-tenants-empty"><Link className="btn" href={tenantsHref(base)}>{c.first}</Link></div> :
      <table className="v3-tenants-table"><thead><tr><th scope="col">{c.title}</th><th scope="col">{c.unit}</th>
        {canViewPhone && <th scope="col">{c.phone}</th>}<th scope="col">{c.line}</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><Link className="v3-tenants-row-link" href={`/m/tenants/${row.id}`}><RoleAvatar role="t" locale={locale} decorative />
            <strong>{displaySampleName(row.name)}</strong></Link></td>
          <td data-label={c.unit}>{row.place ? displaySampleName(row.place) : c.absent}</td>
          {canViewPhone && <td data-label={c.phone}>{row.phone ? <><span className="num">{row.phone}</span>
            {mobileRequired && <span className="v3-tenants-badges">{!row.verified && <span className="v3-tenants-tooltip" tabIndex={0} aria-describedby={`phone-tip-${row.id}`}>
              <span className="v3-tenants-badge">{c.unverified}</span>
              <span role="tooltip" id={`phone-tip-${row.id}`}>{c.unverifiedTip}</span></span>}
              {row.staffUpdated && <span className="v3-tenants-badge">{c.staff}</span>}</span>}
            {mobileRequired && row.duplicateName && <span className="v3-tenants-badges">{c.duplicate.replace("{name}",displaySampleName(row.duplicateName))}</span>}</> : c.absent}</td>}
          <td data-label={c.line}>{row.lineLinked ? c.joined : c.notJoined}</td>
        </tr>)}</tbody>
      </table>}
    </div>
    {(params.cursor || data.nextCursor) && <nav className="v3-tenants-pager" aria-label={c.title}>
      {params.cursor && <Link className="btn" href={tenantsHref(base)}>{c.first}</Link>}
      {data.nextCursor && <Link className="btn" href={tenantsHref({...base,cursor:data.nextCursor})}>{c.next}</Link>}
    </nav>}
  </section>;
}
