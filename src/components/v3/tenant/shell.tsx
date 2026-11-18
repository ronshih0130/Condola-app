"use client";

import React, { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { brandV3TenantHomeCopy } from "../../../i18n/lanes/brand-v3-tenant-home";
import type { TenantShellView } from "../../../server/b090-tenant-shell";
import { ShellV3, type ShellEntry } from "../shell/shared-shell";

/** TEN-55-AC1: 首頁／繳款／報修／訊息／更多. The four links open the existing tenant routes. */
export const TENANT_TABS = [
  { id: "home", href: "/t", icon: "today" },
  { id: "pay", href: "/t/pay", icon: "coin" },
  { id: "repair", href: "/t/repair", icon: "tool" },
  { id: "messages", href: "/t/messages", icon: "chat" },
] as const;

/** The current tab (or 更多 entry) for a path; undefined on pages outside them (e.g. the bell's page). */
export function tenantShellCurrent(path: string, more: readonly { id: string; href: string }[]): string | undefined {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/t";
  if (clean === "/t") return "home";
  const within = (href: string) => { const base = href.split("?")[0]; return clean === base || clean.startsWith(`${base}/`); };
  return TENANT_TABS.slice(1).find(tab => within(tab.href))?.id ?? more.find(entry => within(entry.href))?.id;
}

export function tenantShellContext(view: Pick<TenantShellView, "name" | "place">, locale: Locale) {
  const copy = brandV3TenantHomeCopy(locale), name = view.name.trim(), place = view.place?.trim() ?? "";
  if (name && place) return copy.context.replace("{name}", name).replace("{place}", place);
  if (place) return copy.contextNoName.replace("{place}", place);
  return name ? copy.contextNoPlace.replace("{name}", name) : "";
}

export function TenantShellV3({ children, locale, view }: { children: ReactNode; locale: Locale; view: TenantShellView }) {
  const path = usePathname() || "/t";
  const copy = brandV3TenantHomeCopy(locale);
  const t = makeT(locale);
  const party = brandV3Copy(locale).t;
  const tabs: ShellEntry[] = TENANT_TABS.map(tab => ({ ...tab, label: copy.tabs[tab.id] }));
  const more: ShellEntry[] = view.more;
  const current = tenantShellCurrent(path, more);
  const areas = [...tabs, ...more];
  return <>
    {/* eslint-disable-next-line @next/next/no-css-tags -- ON-only tenant stylesheet, scoped like the other v3 page sheets */}
    <link rel="stylesheet" href="/brand/v3/tenant.css" />
    <ShellV3 areas={areas} tabs={[...tabs, { id: "more", href: "", label: copy.tabs.more, icon: "more" }]} path={path} currentId={current}
      moreOn={more.some(entry => entry.id === current)} moreEntries={more}
      locale={locale} name={view.name} party="t" company={view.company}
      brand={brandV3NavigationCopy(locale).brandParty.replace("{brand}", t("i_brand")).replace("{party}", party)}
      context={tenantShellContext(view, locale)}
      title={areas.find(area => area.id === current)?.label ?? copy.tabs.home}
      // The tenant pages keep their own headings (首頁's sentence is its h1): no second sand heading.
      lead={null}
      menuContext={view.company ? brandV3ShellCopy(locale).menuContext.replace("{role}", party).replace("{company}", view.company) : party}
      menuExtra={view.canSwitchToOwner ? <Link className="shell-account" role="menuitem" data-testid="switch-role" href="/o/statements">{t("i_switch_role_owner")}</Link> : null}
      notification={view.notification ?? undefined}>
      {children}
    </ShellV3>
  </>;
}
