"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy } from "../../../i18n/lanes/brand-v3";
import { areaForPath, crumbsForAreas, navLabel, pathWithin, type ManagerAreaV3 } from "../../../server/nav-v3";
import type { OrgRole } from "../../../server/types";
import { LocaleLinks, ResetButton, SignOutButton } from "../../chrome";
import { RoleAvatar } from "../role-avatar";
import { ShellIcon } from "./icon";

export function ManagerShellV3({ children, areas, tabs, locale, name, role, firm, sandbox, showReset, buildSha, trialBanner }: {
  children: ReactNode; areas: ManagerAreaV3[]; tabs: ManagerAreaV3[];
  locale: Locale; name: string; role: OrgRole | null; firm: string;
  sandbox: boolean; showReset: boolean; buildSha: string; trialBanner: ReactNode;
}) {
  const path = usePathname() || "/m";
  const t = makeT(locale);
  const copy = brandV3NavigationCopy(locale);
  const current = areas.find(area => area.id === areaForPath(path)?.id);
  const moreOn = path === "/m/more" || Boolean(current && !tabs.some(tab => tab.id === current.id));
  const title = crumbsForAreas(path, areas, locale).join(" › ");
  const company = sandbox ? t("i_sandbox_company") : firm;
  const context = copy.context.replace("{company}", company).replace("{name}", name).replace("{role}", role ? t(`i_role_${role}`) : "");
  const brand = copy.brandParty.replace("{brand}", t("i_brand")).replace("{party}", brandV3Copy(locale).m);
  const next = encodeURIComponent(path);
  const avatar = <RoleAvatar role="m" locale={locale} name={name} decorative />;
  return <div className="v3-shell" data-testid="manager-shell-v3">
    <header className="appbar navy"><div className="wm">{brand}</div><div className="cap">{context}</div>{avatar}</header>
    <aside className="sidebar">
      <div className="side-head"><div className="wm">{brand}</div><div className="cap">{context}</div></div>
      <nav className="snav" aria-label={copy.navigation} data-testid="v3-sidebar-nav">
        {areas.map(area => <Fragment key={area.id}>
          <Link href={area.href} data-area={area.id} className={current?.id === area.id ? "on" : undefined} aria-current={current?.id === area.id ? "page" : undefined}>
            <ShellIcon name={area.icon} /><span>{navLabel(area.key, locale)}</span>
          </Link>
          {current?.id === area.id ? area.links.map(item => <Link key={item.href} href={item.href} className={`sub${pathWithin(path, item.href) ? " on" : ""}`} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{navLabel(item.key, locale)}</Link>) : null}
        </Fragment>)}
      </nav>
      <div className="shell-tools">
        <LocaleLinks />
        <SignOutButton />
        {showReset ? <ResetButton /> : null}
        <details className="org-switch">
          <summary className="org-toggle" data-testid="org-switch">
            <span className="b">{company}</span>
            <span className="org-caret" aria-hidden="true">▾</span>
          </summary>
          <div className="org-menu" data-testid="org-menu">
            <a href={`/api/env?set=live&next=${next}`} data-testid="org-pick-live">{firm}</a>
            <a href={`/api/env?set=sandbox&next=${next}`} data-testid="org-pick-sandbox">{t("i_sandbox_company")}</a>
          </div>
        </details>
        <p className="foot build-sha" data-testid="build-sha">{buildSha}</p>
      </div>
    </aside>
    <div className="main shell-content">
      <div className="deskbar"><span className="page-title-desk">{title}</span>{avatar}</div>
      {trialBanner}
      {current && current.links.length > 1 ? <nav className="subchips" aria-label={navLabel(current.key, locale)}>{current.links.map(item => <Link key={item.href} href={item.href} className={pathWithin(path, item.href) ? "on" : undefined} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{navLabel(item.key, locale)}</Link>)}</nav> : null}
      {children}
    </div>
    <nav className="tabbar" aria-label={copy.navigation} data-testid="v3-phone-tabs">
      {tabs.map(tab => {
        const active = tab.id === "more" ? moreOn : current?.id === tab.id;
        return <Link key={tab.id} href={tab.href} data-area={tab.id} className={active ? "on" : undefined} aria-current={active ? "page" : undefined}><ShellIcon name={tab.icon} />{navLabel(tab.key, locale)}</Link>;
      })}
    </nav>
  </div>;
}
