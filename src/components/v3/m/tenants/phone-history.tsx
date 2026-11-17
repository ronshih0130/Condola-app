import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { phoneHistoryCopy } from "../../../../i18n/lanes/brand-v3-phone-history";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import type { PhoneHistory, PhoneHistoryRow } from "../../../../server/b076a-phone-history";
import { displaySampleName } from "../../../../server/sandbox-data";

/** mgr-history-direct (B-076a): read only; numbers arrive masked from the gateway. */
export const phoneHistoryHref = (id: string, after?: string | null, trail: string[] = []) => {
  const q = new URLSearchParams();
  if (after) q.set("after", after);
  if (after && trail.length) q.set("trail", trail.join("."));
  return `/m/tenants/${encodeURIComponent(id)}/phone-history${q.size ? `?${q}` : ""}`;
};
/** MGT-76-AC13: 「下一頁」 pushes this page's cursor onto the trail; 「上一頁」 (from page 2) pops it. */
export function phoneHistoryPager(id: string, after: string | undefined, trail: string[], next: string | null) {
  return {
    prev: after === undefined ? null : phoneHistoryHref(id, trail[trail.length - 1] ?? null, trail.slice(0, -1)),
    next: next ? phoneHistoryHref(id, next, after === undefined ? [] : [...trail, after]) : null,
  };
}
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** With no profile name the actor reads 「{角色} 直接修改」 (GS-55 confirmed), keeping the role for the audit trail. */
export function phoneHistoryActor(row: Pick<PhoneHistoryRow, "actorRole" | "actorName">, locale: Locale) {
  const role = makeT(locale)(row.actorRole === "admin" ? "i_role_admin" : "i_role_manager");
  return fill(phoneHistoryCopy(locale).by, { role, name: row.actorName ? displaySampleName(row.actorName) : "" }).replace(/\s{2,}/g, " ");
}

export function PhoneHistoryView({ data, id, locale, after, trail = [] }: { data: PhoneHistory; id: string; locale: Locale; after?: string; trail?: string[] }) {
  const c = phoneHistoryCopy(locale), s = tenantsCopy(locale), t = makeT(locale);
  const back = <Link className="btn pri" href={`/m/tenants/${encodeURIComponent(id)}`}>{c.back}</Link>;
  if (data.state === "forbidden") return <section className="v3-tenants v3-phone-history" data-testid="phone-history">
    <h1>{c.title}</h1><p role="status">{s.permission}</p></section>;
  if (data.state !== "ready") return <section className="v3-tenants v3-phone-history" data-testid="phone-history">
    <h1>{c.title}</h1><div role="alert"><p>{s.failed}</p><Link className="btn pri" href={phoneHistoryHref(id, after, trail)}>{s.retry}</Link></div></section>;
  const name = displaySampleName(data.tenant);
  const numbers = (row: PhoneHistoryRow) => `${row.oldMasked ?? c.none} → ${row.newMasked ?? c.none}`;
  const pager = phoneHistoryPager(id, after, trail, data.next);
  return <section className="v3-tenants v3-phone-history" data-testid="phone-history">
    <header className="v3-phone-history-head"><h1>{fill(c.titleWith, { name })}</h1>
      {/* The frame's subtitle only; hidden without a lease/place or with no rows (the empty-state frame has none). */}
      {data.place && data.rows.length ? <p>{fill(c.sub, { name, place: displaySampleName(data.place) })}</p> : null}</header>
    <div className="v3-tenants-card">
      {data.rows.length ? <table className="v3-phone-history-table">
        <thead><tr><th scope="col">{c.time}</th><th scope="col">{c.status}</th><th scope="col">{c.actor}</th><th scope="col">{c.numbers}</th></tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.id} data-testid="phone-history-row">
          <td data-label={c.time}><time className="num" dateTime={row.occurredAt}>{row.at}</time></td>
          <td data-label={c.status}><b>{c.direct}</b></td>
          <td data-label={c.actor}><b>{phoneHistoryActor(row, locale)}</b></td>
          <td data-label={c.numbers} className="num">{numbers(row)}</td>
        </tr>)}</tbody>
      </table> : <p className="v3-phone-history-empty" data-testid="phone-history-empty">{c.empty}</p>}
    </div>
    {/* MGT-76-AC13 (GS-56 = A): 25 a page; 「上一頁」 on the left from page 2, then 「下一頁」. */}
    {pager.prev || pager.next ? <nav className="v3-phone-history-pager" aria-label={c.title}>
      {pager.prev ? <Link className="btn" href={pager.prev} data-testid="phone-history-prev">{t("i_search_prev")}</Link> : null}
      {pager.next ? <Link className="btn" href={pager.next} data-testid="phone-history-next">{t("i_search_next")}</Link> : null}
    </nav> : null}
    <div className="v3-phone-history-actions">{back}</div>
  </section>;
}
