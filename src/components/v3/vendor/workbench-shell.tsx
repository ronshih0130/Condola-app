"use client";

import React, { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { ownStatusCopy } from "../../../i18n/lanes/brand-v3-own-status";
import { vendorTokenCopy } from "../../../i18n/lanes/brand-v3-vendor-token";
import { vendorWorkbenchCopy } from "../../../i18n/lanes/brand-v3-vendor-workbench";
import { VENDOR_WORKBENCH } from "../../../lib/vendor-workbench-paths";
import { ShellV3, type ShellEntry } from "../shell/shared-shell";


/**
 * OV-SH-PHONE / OV-SH-DESK / OV-SH-MORE / OV-SH-ME / OV-SH-NONAME / OV-SH-ORG for a signed-in vendor (B-063).
 * Phone tabs: workbench, jobs, the V-RECV tab, more; desktop areas: the same three plus 我的帳號. OV-SH-NOTI: a signed-in vendor has
 * no notification page today (the existing one is token-only), so the bell and the 通知 tab are not shown.
 * OV-SH-MORE (`ven-more`): 我的帳號 opens the existing B-026 account page; 登入與歸戶 stays hidden until a page
 * for it is live. The context line is plain text (OV-SH-ORG): no company switch for vendors.
 */
export function vendorShellNavigation(locale: Locale) {
  const token = vendorTokenCopy(locale), own = ownStatusCopy(locale), copy = vendorWorkbenchCopy(locale);
  const areas: ShellEntry[] = [
    { id: "home", href: VENDOR_WORKBENCH.home, label: token.workbench, icon: "tool" },
    { id: "jobs", href: VENDOR_WORKBENCH.jobs, label: copy.jobsTab, icon: "doc" },
    { id: "payments", href: VENDOR_WORKBENCH.payments, label: own.vendorTab, icon: "coin" },
  ];
  const more: ShellEntry[] = [{ id: "account", href: VENDOR_WORKBENCH.account, label: makeT(locale)("i_account"), icon: "user" }];
  return { areas, more };
}

export function vendorShellCurrent(path: string) {
  const clean = path.split(/[?#]/)[0].replace(/\/$/, "") || "/";
  if (clean === VENDOR_WORKBENCH.home) return "home";
  for (const id of ["jobs", "payments", "account"] as const) {
    const href = VENDOR_WORKBENCH[id];
    if (clean === href || clean.startsWith(`${href}/`)) return id;
  }
  return undefined;
}

/** Page titles: V-HOME 工作台 (its lead, see the copy lane), V-JOBS 工單, V-RECV its own-status list title, 我的帳號. */
export function vendorShellTitle(current: ReturnType<typeof vendorShellCurrent>, locale: Locale) {
  if (current === "jobs") return vendorWorkbenchCopy(locale).jobsTab;
  if (current === "payments") return ownStatusCopy(locale).vendorListTitle;
  if (current === "account") return makeT(locale)("i_account");
  return vendorTokenCopy(locale).workbench;
}

export function VendorShellV3({ children, locale, name, company }: { children: ReactNode; locale: Locale; name: string; company: string }) {
  const path = usePathname() || VENDOR_WORKBENCH.home;
  const token = vendorTokenCopy(locale);
  const navCopy = brandV3NavigationCopy(locale);
  const { areas, more } = vendorShellNavigation(locale);
  const current = vendorShellCurrent(path);
  const tabs: ShellEntry[] = [...areas, { id: "more", href: "", label: navCopy.more, icon: "more" }];
  const t = makeT(locale);
  return <>
    {/* eslint-disable-next-line @next/next/no-css-tags -- ON-only vendor workbench stylesheet, scoped like the other v3 page sheets */}
    <link rel="stylesheet" href="/brand/v3/vendor.css" />
    <ShellV3 areas={[...areas, ...more]} tabs={tabs} path={path} currentId={current} moreOn={current === "account"} moreEntries={more}
      locale={locale} name={name} party="v" company={company} brand={token.brand}
      context={(name.trim() ? token.context : token.contextNoName).replace("{name}", name.trim()).replace("{company}", company)}
      title={vendorShellTitle(current, locale)}
      menuContext={brandV3ShellCopy(locale).menuContext.replace("{role}", brandV3Copy(locale).v).replace("{company}", company)}
      account={<Link role="menuitem" className="shell-account" data-testid="avatar-account" href={VENDOR_WORKBENCH.account}>{t("i_account")}</Link>}>
      {children}
    </ShellV3>
  </>;
}
