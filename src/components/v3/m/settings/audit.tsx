import React from "react";
import { makeT, type Locale } from "../../../../i18n";
import { brandV3AuditCopy, fillAudit } from "../../../../i18n/lanes/brand-v3-r5-audit";
import {
  AUDIT_V3_HREF,
  AUDIT_V3_ITEMS,
  auditV3Href,
  filtered,
  itemLabel,
  type AuditV3Entry,
  type AuditV3Page,
} from "../../../../server/b073-audit";

/**
 * R5-AUDIT (設定 › 操作紀錄 for the whole company, MGT-136 AC2, AC4, AC5). Presentation only (server-safe, no
 * hooks). Filters are a plain GET form (person, two Taipei days, item) with today's 「篩選」 as a text submit; 25
 * plain entries a page with 「{哪一類}・{時間}」 under each; 「上一頁」 from page 2 and 「下一頁」 as text links.
 */

/** MGT-136-AC5 loading: line skeletons; no filters, entries or links. */
export function AuditLoading({ locale }: { locale: Locale }) {
  return <section className="v3-audit" aria-busy="true" aria-label={brandV3AuditCopy(locale).title} data-testid="audit-v3-loading">
    <div className="v3-audit-card" aria-hidden="true">{[0, 1, 2, 3, 4].map(line => <span className="v3-audit-skeleton" key={line} />)}</div>
  </section>;
}

/** MGT-136-AC5 read failure: the GS-02 sentence and 「再試一次」 (the same filters and page again). */
export function AuditError({ locale, retryHref = AUDIT_V3_HREF }: { locale: Locale; retryHref?: string }) {
  const c = brandV3AuditCopy(locale);
  return <section className="v3-audit" aria-label={c.title} data-testid="audit-v3-error">
    <div className="v3-audit-card" role="alert"><p>{c.readFailed}</p><a className="btn" href={retryHref}>{c.retry}</a></div>
  </section>;
}

/** The entry sentence: plain words, or today's labels joined by the frame's 「・」. */
export function entryText(locale: Locale, entry: AuditV3Entry) {
  const c = brandV3AuditCopy(locale);
  let text: string;
  if (entry.plain) {
    const { record, field, from, to, quoted } = entry.plain;
    text = fillAudit(locale, quoted ? c.changedQuoted : c.changed, { who: entry.who, record, field, from, to });
  } else {
    const legacy = entry.legacy!;
    const t = makeT(locale);
    const parts = [`${entry.who ? `${entry.who} ` : ""}${legacy.action}`];
    if (legacy.fields.length) parts.push(legacy.fields.join(t("i_list_sep")));
    parts.push(legacy.record);
    if (legacy.masked) parts.push(legacy.masked);
    text = parts.join(c.sep);
  }
  return entry.reason ? `${text}${fillAudit(locale, c.reason, { reason: entry.reason })}` : text;
}

export function AuditView({ locale, page }: { locale: Locale; page: AuditV3Page }) {
  const c = brandV3AuditCopy(locale);
  const t = makeT(locale);
  const { filters, entries } = page;
  const knownActor = !filters.actorId || page.actors.some(actor => actor.id === filters.actorId);
  return <section className="v3-audit" aria-label={c.title} data-testid="audit-v3">
    <div className="v3-audit-card">
      <form className="v3-audit-filters" action={AUDIT_V3_HREF} method="get" data-testid="audit-v3-filters">
        <select className="inp" name="user" aria-label={t("i_audit_user")} defaultValue={filters.actorId ?? ""}>
          <option value="">{c.allPeople}</option>
          {page.actors.map(actor => <option key={actor.id} value={actor.id}>{actor.name || t("i_audit_member")}</option>)}
          {knownActor ? null : <option value={filters.actorId!}>{t("i_audit_member")}</option>}
        </select>
        <span className="v3-audit-range">
          <input className="inp" type="date" name="from" aria-label={t("i_audit_from")} defaultValue={filters.from ?? ""} />
          <span aria-hidden="true">–</span>
          <input className="inp" type="date" name="to" aria-label={t("i_audit_to")} defaultValue={filters.to ?? ""} />
        </span>
        <select className="inp" name="item" aria-label={c.itemLabel} defaultValue={filters.item ?? ""}>
          <option value="">{c.allItems}</option>
          {AUDIT_V3_ITEMS.map(item => <option key={item.id} value={item.id}>{itemLabel(locale, item.id)}</option>)}
        </select>
        <button className="btn txt" type="submit">{t("i_audit_apply")}</button>
      </form>
      {entries.length === 0
        ? <div className="v3-audit-empty" data-testid="audit-v3-empty">
            <p>{c.noMatch}</p>
            {filtered(filters) ? <a className="btn txt" href={AUDIT_V3_HREF} data-testid="audit-v3-clear">{c.clear}</a> : null}
          </div>
        : <ol className="v3-audit-list" data-testid="audit-v3-list">
            {entries.map(entry => <li className="v3-audit-entry" key={entry.key} data-testid="audit-v3-entry">
              {entryText(locale, entry)}
              <span className="v3-audit-meta">{fillAudit(locale, c.itemTime, { item: entry.item, when: entry.when })}</span>
            </li>)}
          </ol>}
      {page.prev !== null || page.next
        ? <div className="v3-audit-pager">
            {page.prev !== null ? <a className="btn txt" href={auditV3Href(filters, { before: page.prev || null })} data-testid="audit-v3-prev">{c.prev}</a> : null}
            {page.next ? <a className="btn txt" href={auditV3Href(filters, { cursor: page.next })} data-testid="audit-v3-next">{c.next}</a> : null}
          </div>
        : null}
    </div>
  </section>;
}
