import React from "react";
import type { Locale } from "../../../../i18n";
import { brandV3AcctCopy } from "../../../../i18n/lanes/brand-v3-r5-acct";
import { brandV3NotifyCopy } from "../../../../i18n/lanes/brand-v3-r5-notify";
import { NOTIFY_PAGE_HREF } from "./notify";

/**
 * R5-ACCT (設定 › 我的帳號, MGT-137). Presentation only (server-safe, no hooks, no reads). Two cards from the approved
 * frame — 基本資料 and 登入與安全 — then the footer line. Each 「修改」 or row opens today's existing flow (passed in as
 * a slot: the display-name form, the change-password form, the two-step verification controls, the device list)
 * in a native disclosure; nothing new is built. No solid primary on this page. No company-wide switch is drawn:
 * the 2FA rule is on 團隊 (MGT-133-AC7) and the reminder switches are on 通知設定 (MGT-135).
 */
export const ACCOUNT_PAGE_HREF = "/m/account";
export const ACCOUNT_CSS_HREF = "/brand/v3/settings-account.css";
/** Today's locale mechanism (the SH-ME 繁中／EN pill): the condola_locale cookie route, back to this page. */
export const accountLocaleHref = (locale: Locale) => `/api/demo/locale?set=${locale}&next=${encodeURIComponent(ACCOUNT_PAGE_HREF)}`;
type T = (key: string) => string;

/** MGT-137-AC4 loading: skeletons hold the layout; no values, switches or counts, nothing can be saved. */
export function AccountLoading({ locale }: { locale: Locale }) {
  const copy = brandV3AcctCopy(locale);
  return <div className="v3-acct" aria-busy="true" aria-label={copy.lead} data-testid="account-loading">
    <div className="v3-acct-cards">
      {[3, 6].map(lines => <div className="v3-acct-card" key={lines} aria-hidden="true">
        {Array.from({ length: lines }, (_, line) => <span className="v3-acct-skeleton" key={line} />)}
      </div>)}
    </div>
  </div>;
}
/** Read failure: the GS-02 sentence and an outline retry; no values are shown. */
export function AccountError({ locale }: { locale: Locale }) {
  const copy = brandV3AcctCopy(locale);
  return <div className="v3-acct" data-testid="account-error">
    <section className="v3-acct-card">
      <div role="alert"><p>{copy.readFailed}</p></div>
      <a className="btn" href={ACCOUNT_PAGE_HREF}>{copy.retry}</a>
    </section>
  </div>;
}

function Row({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return <div className="v3-acct-row" data-testid={testId}><span className="v3-acct-k">{label}</span><span className="v3-acct-v">{value}</span></div>;
}
/** A row that opens today's flow below it (native <details>; keyboard and screen readers get it for free). */
function OpenRow({ label, value, testId, open, children }: { label: string; value: React.ReactNode; testId: string; open?: boolean; children: React.ReactNode }) {
  return <details className="v3-acct-more" data-testid={testId} open={open || undefined}>
    <summary className="v3-acct-row"><span className="v3-acct-k">{label}</span><span className="v3-acct-v">{value}</span></summary>
    <div className="v3-acct-panel">{children}</div>
  </details>;
}

export type AccountLayoutProps = {
  locale: Locale; t: T;
  /** Session facts (the caller's own). An empty name stays empty (SH-NONAME). */
  name: string; email: string;
  /** Masked by the database (09xx-•••-xxx); null → the row is omitted. */
  phone: string | null;
  /** null → the app has no staff LINE Login here; the row is omitted. */
  line: boolean | null;
  mfaOn: boolean; deviceCount: number;
  /** Today's display-name form; null when today's page would not offer it (the 「修改」 is then omitted). */
  nameEdit: React.ReactNode | null; nameEditOpen?: boolean;
  /** Today's lines under the name (scope, result, sandbox); shown as they are. */
  basicsNote: React.ReactNode | null;
  password: React.ReactNode; mfa: React.ReactNode; mfaOpen?: boolean; devices: React.ReactNode;
  /** The footer line links to 通知設定, so only roles with personal reminders (admin, manager) get it, as on R5-NOTIFY. */
  footer: boolean;
};

export function AccountLayout(props: AccountLayoutProps) {
  const { locale, t } = props;
  const copy = brandV3AcctCopy(locale);
  const moved = brandV3NotifyCopy(locale);
  return <div className="v3-acct" data-testid="account-v3">
    <div className="v3-acct-cards">
      <section className="v3-acct-card" aria-labelledby="v3-acct-basics" data-card="basics">
        <h2 id="v3-acct-basics">{copy.basics}</h2>
        <div className="v3-acct-rows">
          <Row label={copy.name} value={props.name} testId="account-name" />
          <Row label={copy.email} value={props.email} testId="account-email" />
          {props.phone !== null ? <Row label={copy.phone} value={props.phone} testId="account-phone" /> : null}
        </div>
        {props.basicsNote}
        {props.nameEdit ? <details className="v3-acct-edit" data-testid="account-edit" open={props.nameEditOpen || undefined}>
          <summary className="btn sm">{copy.edit}</summary>
          <div className="v3-acct-panel">{props.nameEdit}</div>
        </details> : null}
      </section>
      <section className="v3-acct-card" aria-labelledby="v3-acct-security" data-card="security">
        <h2 id="v3-acct-security">{copy.security}</h2>
        <div className="v3-acct-rows">
          <OpenRow label={copy.password} value={<span className="v3-acct-act">{copy.edit}</span>} testId="account-password">{props.password}</OpenRow>
          {props.line !== null ? <Row label={copy.line} value={props.line ? copy.linked : copy.notLinked} testId="account-line" /> : null}
          <OpenRow label={copy.mfa} value={props.mfaOn ? copy.mfaOn : copy.mfaOff} testId="account-mfa" open={props.mfaOpen}>{props.mfa}</OpenRow>
          <OpenRow label={copy.devices} value={copy.deviceCount(props.deviceCount)} testId="account-devices">{props.devices}</OpenRow>
          <Row label={copy.language} testId="account-language" value={<span className="v3-acct-pill">
            {(["zh-TW", "en"] as const).map(option => <a key={option} href={accountLocaleHref(option)} lang={option}
              aria-current={option === locale ? "true" : undefined} data-testid={`account-locale-${option}`}>{t(option === "zh-TW" ? "i_lang_zh" : "i_lang_en")}</a>)}
          </span>} />
        </div>
      </section>
    </div>
    {props.footer ? <p className="v3-acct-foot" data-testid="notify-moved">{moved.movedBefore}<a href={NOTIFY_PAGE_HREF}>{moved.movedLink}</a>{moved.movedAfter}</p> : null}
  </div>;
}
