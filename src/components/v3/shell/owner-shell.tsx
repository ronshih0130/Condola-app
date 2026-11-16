"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3OwnerShellCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { pathWithin, type OwnerNavigationV3 } from "../../../server/nav-v3";
import { ShellV3, type ShellEntry } from "./shared-shell";

export function OwnerShellV3({ children, locale, name, firm, navigation, canSwitchToTenant = false }: {
  children: ReactNode; locale: Locale; name: string; firm: string; navigation: OwnerNavigationV3; canSwitchToTenant?: boolean;
}) {
  const path = usePathname() || "/o";
  const copy = brandV3OwnerShellCopy(locale);
  const navCopy = brandV3NavigationCopy(locale);
  const party = brandV3Copy(locale).o;
  const areas = [...navigation.areas, ...navigation.more];
  // B-093: under brand_v3 /o/approvals/[ticketId] is the 核准紀錄 read-only view.
  const current = areas.find(area => area.href === "/o" ? path === "/o" : pathWithin(path, area.href))
    ?? (pathWithin(path, "/o/approvals") ? areas.find(area => area.id === "decided") : undefined);
  const tabs: ShellEntry[] = [...navigation.areas];
  if (navigation.more.length) tabs.push({ id: "more", href: "", label: navCopy.more, icon: "more" });
  return <ShellV3 areas={areas} tabs={tabs} path={path} currentId={current?.id}
    moreOn={navigation.more.some(item => item.id === current?.id)} moreEntries={navigation.more}
    locale={locale} name={name} party="o" company={firm}
    brand={navCopy.brandParty.replace("{brand}", makeT(locale)("i_brand")).replace("{party}", party)}
    context={(name.trim() ? copy.context : copy.contextNoName).replace("{name}", name).replace("{company}", firm)}
    title={current?.label ?? copy.home}
    menuContext={brandV3ShellCopy(locale).menuContext.replace("{role}", party).replace("{company}", firm)}
    menuExtra={canSwitchToTenant ? <a className="shell-account" role="menuitem" data-testid="switch-role" href="/t">{makeT(locale)("i_switch_role_tenant")}</a> : null}
    notification={navigation.areas.find(area => area.id === "notifications")}>
    {children}
  </ShellV3>;
}
