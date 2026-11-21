import React from "react";
import type { Locale } from "../../../../i18n";
import { brandV3NotifyCopy } from "../../../../i18n/lanes/brand-v3-r5-notify";
import type { NotifyBlock, NotifyField } from "../../../../server/b073-notify-settings";
import type { NotifyState } from "./notify-state";

/**
 * R5-NOTIFY (設定 › 通知設定, MGT-135). Presentation only (server-safe, no hooks): the switch rows are drawn by
 * NotifySwitches on the client. No solid primary: a switch saves on change. No manager LINE or Email push option.
 */
export const NOTIFY_PAGE_HREF = "/m/notify";
export const NOTIFY_CSS_HREF = "/brand/v3/settings-notify.css";
type Copy = ReturnType<typeof brandV3NotifyCopy>;
type Key = keyof Copy;

/** MGT-135-AC5 loading: skeletons hold the layout; no switches, nothing can be saved. */
export function NotifyLoading({ locale }: { locale: Locale }) {
  const copy = brandV3NotifyCopy(locale);
  return <div className="v3-notify" aria-busy="true" aria-label={copy.lead} data-testid="notify-loading">
    <div className="v3-notify-blocks">
      {[0, 1].map(card => <div className="v3-notify-card" key={card} aria-hidden="true">
        {[0, 1, 2].map(line => <span className="v3-notify-skeleton" key={line} />)}
      </div>)}
    </div>
  </div>;
}
/** Read failure: the GS-02 sentence and an outline retry; the switches are hidden. */
export function NotifyError({ locale }: { locale: Locale }) {
  const copy = brandV3NotifyCopy(locale);
  return <div className="v3-notify" data-testid="notify-error">
    <section className="v3-notify-card">
      <div role="alert"><p>{copy.readFailed}</p></div>
      <a className="btn" href={NOTIFY_PAGE_HREF}>{copy.retry}</a>
    </section>
  </div>;
}

const ROWS: Record<NotifyBlock, { field: NotifyField; label: Key; sub: Key }[]> = {
  me: [{ field: "leaseExpiry", label: "mineLease", sub: "mineLeaseSub" }, { field: "rentOverdue", label: "mineOverdue", sub: "mineOverdueSub" }],
  tenant: [{ field: "leaseExpiry", label: "tenantLease", sub: "tenantLeaseSub" }, { field: "rentOverdue", label: "tenantOverdue", sub: "tenantOverdueSub" }],
};
/** One block's two switches (role="switch", aria-checked). While a save runs they are aria-disabled and ignore taps. */
export function NotifySwitchRows({ locale, block, state, onToggle }: { locale: Locale; block: NotifyBlock; state: NotifyState; onToggle?: (field: NotifyField) => void }) {
  const copy = brandV3NotifyCopy(locale);
  return <div className="v3-notify-switches" aria-busy={state.saving ? true : undefined}>
    {ROWS[block].map(({ field, label, sub }) => {
      const id = `v3-notify-${block}-${field}`;
      return <div className="v3-notify-row" key={field}>
        <span className="v3-notify-text">
          <b id={id}>{copy[label] as string}</b>
          <span className="v3-notify-sub" id={`${id}-sub`}>{copy[sub] as string}</span>
        </span>
        <button type="button" role="switch" className="v3-notify-switch" data-block={block} data-field={field}
          aria-checked={state.shown[field]} aria-labelledby={id} aria-describedby={`${id}-sub`}
          aria-disabled={state.saving ? true : undefined} onClick={onToggle ? () => onToggle(field) : undefined}>
          <span className="v3-notify-knob" aria-hidden="true" />
        </button>
      </div>;
    })}
    {state.error && <p className="v3-notify-error" role="alert">{copy.saveFailed}</p>}
  </div>;
}

/**
 * The page body: 「寄給我的」 always; 「寄給租客的」 only when `tenant` is given (admin, MGT-135-AC4); the footer line.
 * Children are the switch rows (client) for each block.
 */
export function NotifyLayout({ locale, mine, tenant }: { locale: Locale; mine: React.ReactNode; tenant: React.ReactNode | null }) {
  const copy = brandV3NotifyCopy(locale);
  return <div className="v3-notify" data-testid="notify-settings">
    <div className="v3-notify-blocks">
      <section className="v3-notify-card" aria-labelledby="v3-notify-mine" data-block="me">
        <h2 id="v3-notify-mine">{copy.mine}</h2>
        {mine}
      </section>
      {tenant ? <section className="v3-notify-card" aria-labelledby="v3-notify-tenant" data-block="tenant">
        <h2 id="v3-notify-tenant">{copy.tenant}</h2>
        <p className="v3-notify-desc">{copy.tenantNote}</p>
        {tenant}
      </section> : null}
    </div>
    <p className="v3-notify-foot">{copy.footer}</p>
  </div>;
}

/** MGT-135-AC2: the one line the old places (我的帳號) show instead of their switches. */
export function NotifyMovedLine({ locale }: { locale: Locale }) {
  const copy = brandV3NotifyCopy(locale);
  return <p className="card pad" data-testid="notify-moved">{copy.movedBefore}<a href={NOTIFY_PAGE_HREF}>{copy.movedLink}</a>{copy.movedAfter}</p>;
}
