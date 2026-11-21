"use client";

import React, { useId, useRef, type CSSProperties, type ReactNode } from "react";
import type { Locale } from "../../../i18n";
import { vendorTokenCopy } from "../../../i18n/lanes/brand-v3-vendor-token";
import { ownStatusCopy } from "../../../i18n/lanes/brand-v3-own-status";
import type { VendorTokenBrand } from "../../../server/vendor-token-brand";
import { ShellIcon } from "../shell/icon";
import { WaitMark } from "../wait-mark";
import baseTokens from "../../../brand/v2/tokens.json";
import brandTokens from "../../../brand/v3/tokens.json";

// Bearer pages have no session org in RootLayout. Scope canonical tokens here instead
// of mutating the document brand using an unrelated signed-in session or client effect.
const tokens = Object.fromEntries(
  [baseTokens.color, baseTokens.font, baseTokens.size, baseTokens.space, baseTokens.radius,
    baseTokens.shadow, baseTokens.layout, brandTokens.color, brandTokens.radius]
    .flatMap(group => Object.entries(group).map(([key, entry]) => [`--${key}`, entry.value])),
) as CSSProperties;

export type VendorTokenShellProps = {
  locale: Locale; context: VendorTokenBrand; title: string; address: string; window: string;
  status: string; reported: boolean; canReport: boolean; children: ReactNode;
  notificationHref: string | null;
  loginEntry?: ReactNode;
  /** B-105 (vendor_job_v3): RV case content replaces the V-TOKEN job content; bar, tabs and sheet stay. */
  caseView?: ReactNode;
};

export function VendorTokenShell({ locale, context, title, address, window, status, reported, canReport, notificationHref, loginEntry, caseView, children }: VendorTokenShellProps) {
  const copy = vendorTokenCopy(locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const sheetTitle = useId();
  const sheetBody = useId();
  const reportId = useId();
  const tabs = [
    { label: copy.workbench, icon: "tool" as const },
    { label: ownStatusCopy(locale).vendorTab, icon: "coin" as const },
    { label: copy.notifications, icon: "bell" as const },
  ];
  function open() { dialog.current?.showModal(); }
  function close() { dialog.current?.close(); }
  return <div className="v-token-v3" data-testid="v-token-v3" style={tokens}>
    {/* ON-only asset; every rule is scoped to this shell (including the legacy-header exclusion). */}
    {/* eslint-disable-next-line @next/next/no-css-tags -- bearer-org ON-only stylesheet, like RootLayout */}
    <link rel="stylesheet" href="/brand/v3/vendor-token.css" />
    <header className="v-token-bar">
      <div><strong>{copy.brand}</strong><p>{(context.name.trim() ? copy.context : copy.contextNoName)
        .replace("{name}", context.name).replace("{company}", context.company)}</p></div>
      {notificationHref ? <a className="v-token-bell" href={notificationHref} aria-label={copy.notifications}><ShellIcon name="bell" /></a> : null}
    </header>
    <main className="v-token-main">
      {caseView ?? <>
      <div className="v-token-lead"><h1>{copy.title}</h1></div>
      <p className="v-token-warning" role="status">{copy.off}</p>
      <section className="v-token-card" aria-labelledby={`${reportId}-title`}>
        <h2 id={`${reportId}-title`}>{[context.property, title].filter(Boolean).join("・") || copy.title}</h2>
        <dl>
          <div><dt>{copy.status}</dt><dd>{reported ? <WaitMark /> : null}{status}</dd></div>
          <div><dt>{copy.address}</dt><dd>{address}</dd></div>
          <div><dt>{copy.appointment}</dt><dd>{window}</dd></div>
        </dl>
        <p>{copy.hint}</p>
        {canReport ? <a className="v-token-primary" href={`#${reportId}`}>{copy.report}</a> : null}
        {loginEntry}
      </section>
      <div className="v-token-existing" id={reportId} tabIndex={-1}>{children}</div>
      </>}
    </main>
    <nav className="v-token-tabs" aria-label={copy.navigation}>
      {tabs.map(tab => tab.icon === "bell" && notificationHref ? <a key={tab.icon} href={notificationHref}>
        <ShellIcon name={tab.icon} /><span>{tab.label}</span>
      </a> : <button key={tab.icon} type="button" onClick={open} aria-haspopup="dialog">
        <ShellIcon name={tab.icon} /><span>{tab.label}</span>
      </button>)}
    </nav>
    <dialog ref={dialog} className="v-token-sheet" aria-labelledby={sheetTitle} aria-describedby={sheetBody}>
      <h2 id={sheetTitle}>{copy.sheetTitle}</h2><p id={sheetBody}>{copy.sheetBody}</p>
      <button className="v-token-primary" type="button" onClick={close} autoFocus>{copy.back}</button>
      {loginEntry}
    </dialog>
  </div>;
}
