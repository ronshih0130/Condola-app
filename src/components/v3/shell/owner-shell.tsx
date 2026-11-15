"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3OwnerShellCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { pathWithin, type OwnerNavigationV3 } from "../../../server/nav-v3";
import { ShellV3, type ShellEntry } from "./shared-shell";

export function OwnerShellV3({ children, locale, name, firm, navigation }: {
  children: ReactNode; locale: Locale; name: string; firm: string; navigation: OwnerNavigationV3;
}) {
  const path = usePathname() || "/o";
  const copy = brandV3OwnerShellCopy(locale);
  const navCopy = brandV3NavigationCopy(locale);
  const party = brandV3Copy(locale).o;
  const areas = [...navigation.areas, ...navigation.more];
  const current = areas.find(area => area.href === "/o" ? path === "/o" : pathWithin(path, area.href));
  const tabs: ShellEntry[] = [...navigation.areas];
  if (navigation.more.length) tabs.push({ id: "more", href: "", label: navCopy.more, icon: "more" });
  return <ShellV3 areas={areas} tabs={tabs} path={path} currentId={current?.id}
    moreOn={navigation.more.some(item => item.id === current?.id)} moreEntries={navigation.more}
    locale={locale} name={name} party="o" company={firm}
    brand={navCopy.brandParty.replace("{brand}", makeT(locale)("i_brand")).replace("{party}", party)}
    context={(name.trim() ? copy.context : copy.contextNoName).replace("{name}", name).replace("{company}", firm)}
    title={current?.label ?? copy.home}
    menuContext={brandV3ShellCopy(locale).menuContext.replace("{role}", party).replace("{company}", firm)}
    notification={navigation.areas.find(area => area.id === "notifications")}>
    {children}
  </ShellV3>;
}
