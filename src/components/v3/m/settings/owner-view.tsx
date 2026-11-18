import React from "react";
import type { Locale } from "../../../../i18n";
import { brandV3OwnViewCopy } from "../../../../i18n/lanes/brand-v3-r5-ownview";
import type { OwnerViewCompany, OwnerViewField } from "../../../../server/b073-owner-view";
import type { OwnerViewState } from "./owner-view-state";

/**
 * R5-OWNVIEW (設定 › 規則與資料 › 屋主看得到什麼, MGT-138). Presentation only (server-safe, no hooks): the switch
 * rows are drawn by OwnerViewSwitches on the client. No solid primary: a switch saves on change.
 */
export const OWNER_VIEW_HREF = "/m/settings";
export const NOTIFY_HREF = "/m/notify";

/** MGT-138-AC4 loading: skeletons hold the layout; no switches, nothing can be saved. */
export function OwnerViewLoading({ locale }: { locale: Locale }) {
  const copy = brandV3OwnViewCopy(locale);
  return <div className="v3-ownview" aria-busy="true" aria-label={copy.title} data-testid="owner-view-loading">
    {[0, 1].map(card => <div className="v3-ownview-card" key={card} aria-hidden="true">
      {[0, 1, 2].map(line => <span className="v3-ownview-skeleton" key={line} />)}
    </div>)}
  </div>;
}
/** MGT-138-AC4 read failure: the GS-02 sentence and an outline retry; the switches are hidden. */
export function OwnerViewError({ locale }: { locale: Locale }) {
  const copy = brandV3OwnViewCopy(locale);
  return <div className="v3-ownview" data-testid="owner-view-error">
    <section className="v3-ownview-card" aria-labelledby="v3-ownview-title">
      <h2 id="v3-ownview-title">{copy.title}</h2>
      <div role="alert"><p>{copy.readFailed}</p></div>
      <a className="btn" href={OWNER_VIEW_HREF}>{copy.retry}</a>
    </section>
  </div>;
}

const rows: { field: OwnerViewField; label: "showName" | "showPhone"; sub: "showNameSub" | "showPhoneSub" }[] = [
  { field: "showName", label: "showName", sub: "showNameSub" },
  { field: "showPhone", label: "showPhone", sub: "showPhoneSub" },
];
/** The two switches (role="switch", aria-checked). While a save runs they are aria-disabled and ignore taps. */
export function OwnerViewSwitchRows({ locale, state, onToggle }: { locale: Locale; state: OwnerViewState; onToggle?: (field: OwnerViewField) => void }) {
  const copy = brandV3OwnViewCopy(locale);
  return <div className="v3-ownview-switches" aria-busy={state.saving ? true : undefined}>
    {rows.map(({ field, label, sub }) => <div className="v3-ownview-row" key={field}>
      <span className="v3-ownview-text">
        <b id={`v3-ownview-${field}`}>{copy[label]}</b>
        <span className="v3-ownview-sub" id={`v3-ownview-${field}-sub`}>{copy[sub]}</span>
      </span>
      <button type="button" role="switch" className="v3-ownview-switch" data-field={field}
        aria-checked={state.shown[field]} aria-labelledby={`v3-ownview-${field}`} aria-describedby={`v3-ownview-${field}-sub`}
        aria-disabled={state.saving ? true : undefined} onClick={onToggle ? () => onToggle(field) : undefined}>
        <span className="v3-ownview-knob" aria-hidden="true" />
      </button>
    </div>)}
    {state.error && <p className="v3-ownview-error" role="alert">{copy.saveFailed}</p>}
  </div>;
}

/**
 * The block and the side card 「這一頁的其他設定」. 公司資料 shows only with a company name (統編 only when stored);
 * 管理費規則 is not shown (B-049 is not built); 提醒租客 links to 通知設定.
 */
export function OwnerViewLayout({ locale, company, children }: { locale: Locale; company: OwnerViewCompany; children: React.ReactNode }) {
  const copy = brandV3OwnViewCopy(locale);
  return <div className="v3-ownview" data-testid="owner-view">
    <section className="v3-ownview-card" aria-labelledby="v3-ownview-title">
      <h2 id="v3-ownview-title">{copy.title}</h2>
      <p className="v3-ownview-desc">{copy.description}</p>
      {children}
    </section>
    <section className="v3-ownview-card" aria-labelledby="v3-ownview-others">
      <h2 id="v3-ownview-others">{copy.others}</h2>
      <dl className="v3-ownview-kv">
        {company.name && <div data-row="company"><dt>{copy.company}</dt><dd>{company.taxId ? copy.companyTaxId(company.name, company.taxId) : company.name}</dd></div>}
        <div data-row="notify"><dt>{copy.notify}</dt><dd><a href={NOTIFY_HREF}>{copy.notifyWhere}</a></dd></div>
      </dl>
    </section>
  </div>;
}
