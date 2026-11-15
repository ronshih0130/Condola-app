import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import { tenantOneCopy } from "../../../../i18n/lanes/brand-v3-tenant-one";
import type { TenantOneResult, TenantOneReady } from "../../../../server/b3-tenant-one";
import { displaySampleName } from "../../../../server/sandbox-data";
import { statusKey } from "../../../ui";
import { EmptyState } from "../../../empty-state";
import { RoleAvatar } from "../../role-avatar";
import { TenantsLoading } from "./tenants";

export const TenantOneLoading = TenantsLoading;
export function tenantOneLead(data: TenantOneReady, locale: Locale) {
  // With multiple active leases, avoid making one unit look like the only home.
  const active = data.leases.filter(l => l.status==="active");
  const lease = active.length===1 ? active[0] : null;
  if (!lease?.endDate || !lease.place) return displaySampleName(data.name);
  const values = { name:displaySampleName(data.name),unit:displaySampleName(lease.place),date:lease.endDate };
  return tenantOneCopy(locale).lead.replace(/\{(name|unit|date)\}/g,(_,key:keyof typeof values) => values[key]);
}

export function TenantOneView({ data,locale,id,canAddLease=false }: {
  data: TenantOneResult | { state: "forbidden" }; locale: Locale; id: string; canAddLease?: boolean;
}) {
  const c = tenantsCopy(locale), d = tenantOneCopy(locale), t = makeT(locale);
  if (data.state!=="ready") return <section className="v3-tenants"><h1>{c.title}</h1>
    {data.state==="forbidden" ? <p role="status">{c.permission}</p> : <div role="alert"><p>{c.failed}</p>
      <Link className="btn" href={`/m/tenants/${encodeURIComponent(id)}`}>{c.retry}</Link></div>}</section>;
  return <section className="v3-tenants v3-tenant-one" data-testid="v3-tenant-one">
    <header className="v3-tenants-lead"><RoleAvatar role="t" locale={locale} decorative /><h1>{tenantOneLead(data,locale)}</h1></header>
    <section className="v3-tenants-card v3-tenant-one-contact" aria-labelledby="tenant-contact-title">
      <h2 id="tenant-contact-title">{d.contact}</h2>
      <dl>
        {data.canViewContact && <div><dt>{c.phone}</dt><dd>{data.phone ? <>
          <span className="num">{data.phone}</span>
          {data.mobileRequired && data.legacyPhoneNotice && <><span className="v3-tenants-tooltip" tabIndex={0} aria-describedby="tenant-phone-tip">
            <span className="v3-tenants-badge">{c.unverified}</span><span role="tooltip" id="tenant-phone-tip">{c.unverifiedTip}</span>
          </span><p className="v3-tenant-one-source">{c.staff}</p></>}
        </> : c.absent}</dd></div>}
        <div><dt>{c.line}</dt><dd>{data.lineLinked ? c.joined : c.notJoined}</dd></div>
        {data.canViewContact && <div><dt>{d.email}</dt><dd>{data.email || c.absent}</dd></div>}
      </dl>
    </section>
    {data.canViewContact && data.mobileRequired && <aside className="v3-tenant-one-note"><p>{d.note}</p></aside>}
    {/* MGT-76 change / pending / history controls intentionally absent: this
        checkout has no such action or reader. Never wire B-015's immediate
        name/email/phone editor into the OTP design or invent a send path. */}
    {!data.leases.length ? <div className="v3-tenants-card v3-tenants-empty"><EmptyState id="TENID" locale={locale} />
      {canAddLease && <Link className="btn" href="/m/leases/new">{t("es_TENID_action")}</Link>}
    </div> : <section className="v3-tenants-card v3-tenant-one-leases" aria-labelledby="tenant-leases-title">
      <h2 id="tenant-leases-title">{t("i_nav_leases")}</h2>
      <ul>{data.leases.map(lease => <li key={lease.id}>
        <Link href={`/m/leases/${lease.id}`}>{displaySampleName(lease.place)}</Link>
        <span>{t(statusKey(lease.status))}</span>
        {lease.endDate && <span>{t("i_end_date")} <span className="num">{lease.endDate}</span></span>}
      </li>)}</ul>
    </section>}
  </section>;
}
