import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { phoneHistoryCopy } from "../../../../i18n/lanes/brand-v3-phone-history";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import type { PhoneHistory, PhoneHistoryRow } from "../../../../server/b076a-phone-history";
import { displaySampleName } from "../../../../server/sandbox-data";

/** mgr-history-direct (B-076a): read only; numbers arrive masked from the gateway. */
export const phoneHistoryHref = (id: string, after?: string | null) =>
  `/m/tenants/${encodeURIComponent(id)}/phone-history${after ? `?after=${encodeURIComponent(after)}` : ""}`;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** GS-44 frame question (flagged): with no profile name the actor reads 「{角色} 直接修改」, keeping the role for the audit trail. */
export function phoneHistoryActor(row: Pick<PhoneHistoryRow, "actorRole" | "actorName">, locale: Locale) {
  const role = makeT(locale)(row.actorRole === "admin" ? "i_role_admin" : "i_role_manager");
  return fill(phoneHistoryCopy(locale).by, { role, name: row.actorName ? displaySampleName(row.actorName) : "" }).replace(/\s{2,}/g, " ");
}

export function PhoneHistoryView({ data, id, locale }: { data: PhoneHistory; id: string; locale: Locale }) {
  const c = phoneHistoryCopy(locale), s = tenantsCopy(locale), t = makeT(locale);
  const back = <Link className="btn pri" href={`/m/tenants/${encodeURIComponent(id)}`}>{c.back}</Link>;
  if (data.state === "forbidden") return <section className="v3-tenants v3-phone-history" data-testid="phone-history">
    <h1>{c.title}</h1><p role="status">{s.permission}</p></section>;
  if (data.state !== "ready") return <section className="v3-tenants v3-phone-history" data-testid="phone-history">
    <h1>{c.title}</h1><div role="alert"><p>{s.failed}</p><Link className="btn pri" href={phoneHistoryHref(id)}>{s.retry}</Link></div></section>;
  const name = displaySampleName(data.tenant);
  const numbers = (row: PhoneHistoryRow) => `${row.oldMasked ?? c.none} → ${row.newMasked ?? c.none}`;
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
    <div className="v3-phone-history-actions">
      {/* GS-44 frame question (flagged): paging is the shipped 下一頁 (i_search_next); the frame draws no paging. */}
      {data.next ? <Link className="btn" href={phoneHistoryHref(id, data.next)} data-testid="phone-history-next">{t("i_search_next")}</Link> : null}
      {back}
    </div>
  </section>;
}
