import React from "react";
import Link from "next/link";
import type { Locale } from "../../../i18n";
import { brandV3OwnerStateCopy } from "../../../i18n/lanes/brand-v3";
import { brandV3OwnerUnitsCopy } from "../../../i18n/lanes/brand-v3-owner-units";
import type { OwnerUnitRow, OwnerUnits } from "../../../server/b092-owner-units";
import { moneyLabel } from "../../../server/format";
import { displaySampleName } from "../../../server/sandbox-data";

/** RO-UNIT (OWN-33-AC2): the read-only panel of one space; a room carries `?room=`. */
export const ownerUnitHref = (row: Pick<OwnerUnitRow, "unitId" | "roomId">) =>
  `/o/units/${encodeURIComponent(row.unitId)}${row.roomId ? `?room=${encodeURIComponent(row.roomId)}` : ""}`;

/**
 * RO-UNITS (OWN-33-AC1/AC4): 「我的物件」, one line per authorised space: place, tenant (or 「租客」 when the company
 * hides names), rent, this month's status. Read-only; never a phone. A status the story does not name shows nothing.
 * Placement: under the v3 首頁 until 總覽 exists (OQ-095).
 */
export function statusText(row: OwnerUnitRow, locale: Locale): string | null {
  const c = brandV3OwnerUnitsCopy(locale);
  if (row.status === "paid") return c.paid;
  if (row.status === "overdue") return c.overdue;
  if (row.status === "partial" && row.remainingMinor && row.currency) return c.partial(moneyLabel(row.remainingMinor, row.currency, locale));
  if (row.status === "vacant" && row.vacantDays !== null) return c.vacant(row.vacantDays);
  return null;
}

export function OwnerUnitsView({ result, locale }: { result: OwnerUnits; locale: Locale }) {
  const c = brandV3OwnerUnitsCopy(locale);
  // OWN-33-AC4: nothing authorised (or not admitted) shows no section; OFF never reaches here.
  if (result.state === "off" || result.state === "forbidden" || (result.state === "ready" && result.rows.length === 0)) return null;
  if (result.state !== "ready") {
    const state = brandV3OwnerStateCopy(locale);
    return <section className="v3-owner-units owner-units card" data-testid="owner-units-error">
      <h2>{c.title}</h2><div role="alert"><p>{state.error}</p><a className="owner-action" href="/o">{state.retry}</a></div>
    </section>;
  }
  return <section className="v3-owner-units owner-units card" data-testid="owner-units">
    <h2>{c.title}</h2>
    <ul className="owner-units-lines">{result.rows.map(row => {
      const status = statusText(row, locale);
      const body = <>
        <span className="owner-units-place">{displaySampleName(`${row.property} ${row.space}`)}</span>
        <span className="owner-units-sub">{row.status === "vacant" ? "—"
          : `${row.tenant === null ? c.tenantHidden : displaySampleName(row.tenant)}・${row.rentMinor && row.currency ? moneyLabel(row.rentMinor, row.currency, locale) : ""}`}</span>
        {status && <span className="owner-units-status">{status}</span>}
      </>;
      // RO-UNIT: a leased line opens its read-only panel (whole row, ≥44px); a vacant line stays plain.
      return <li key={`${row.unitId}:${row.roomId ?? ""}`} className={`owner-units-line owner-units-${row.status}${row.status === "vacant" ? "" : " owner-units-linked"}`}>
        {row.status === "vacant" ? body : <Link className="owner-units-link" href={ownerUnitHref(row)}>{body}</Link>}
      </li>;
    })}</ul>
  </section>;
}

/** Loading (OWN-33-AC4): skeletons only, never an amount. */
export function OwnerUnitsLoading({ locale }: { locale: Locale }) {
  return <section className="v3-owner-units owner-units card" aria-busy="true" data-testid="owner-units-loading">
    <h2>{brandV3OwnerUnitsCopy(locale).title}</h2>
    <div aria-hidden="true">{[0, 1, 2].map(i => <div className="owner-units-skeleton" key={i}><span /><span /></div>)}</div>
  </section>;
}
