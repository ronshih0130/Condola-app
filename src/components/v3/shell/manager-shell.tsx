"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { areaForPath, crumbsForAreas, navLabel, type ManagerAreaV3 } from "../../../server/nav-v3";
import type { OrgRole } from "../../../server/types";
import { ResetButton } from "../../chrome";
import { ShellV3, type ShellEntry } from "./shared-shell";

export function ManagerShellV3({ children, areas, tabs, locale, name, role, firm, sandbox, showReset, hasLiveCompany, canSwitchCompany, todayTitle, buildSha, trialBanner }: {
  children: ReactNode; areas: ManagerAreaV3[]; tabs: ManagerAreaV3[];
  locale: Locale; name: string; role: OrgRole | null; firm: string;
  sandbox: boolean; showReset: boolean; hasLiveCompany: boolean; canSwitchCompany: boolean; todayTitle: string; buildSha: string; trialBanner: ReactNode;
}) {
  const path = usePathname() || "/m";
  const t = makeT(locale);
  const copy = brandV3NavigationCopy(locale);
  const current = areas.find(area => area.id === areaForPath(path)?.id);
  const moreOn = path === "/m/more" || Boolean(current && !tabs.some(tab => tab.id === current.id));
  const title = path === "/m" ? todayTitle : crumbsForAreas(path, areas, locale).join(" › ");
  const company = sandbox ? t("i_env_test") : firm;
  const hasName = name.trim() !== "";
  // SH-NONAME (hub screens.md): no name → 「{公司}（{角色}）」, a person icon in the avatar, no name line in the menu.
  const context = (hasName ? copy.context : copy.contextNoName).replace("{company}", company).replace("{name}", name).replace("{role}", role ? t(`i_role_${role}`) : "");
  const brand = copy.brandParty.replace("{brand}", t("i_brand")).replace("{party}", brandV3Copy(locale).m);
  const next = encodeURIComponent(path);
  const shellCopy = brandV3ShellCopy(locale);
  const entry = (area: ManagerAreaV3): ShellEntry => ({ ...area, label: navLabel(area.key, locale), links: area.links.map(item => ({ ...item, label: navLabel(item.key, locale) })) });
  return <ShellV3 areas={areas.map(entry)} tabs={tabs.map(entry)} path={path} currentId={current?.id} moreOn={moreOn}
    locale={locale} name={name} party="m" brand={brand} context={context} company={company} title={title} buildSha={buildSha}
    menuContext={shellCopy.menuContext.replace("{role}", role ? t(`i_role_${role}`) : "").replace("{company}", company)}
    canSwitchCompany={canSwitchCompany}
    account={<Link role="menuitem" className="shell-account" data-testid="avatar-account" href="/m/account">{t("i_account")}</Link>}
    menuExtra={showReset && role === "admin" ? <ResetButton shellMenu /> : null}
    orgMenu={<>
      {hasLiveCompany ? <a role="menuitem" href={`/api/env?set=live&next=${next}`} data-testid="org-pick-live" aria-current={!sandbox ? "true" : undefined}>
        {firm}{!sandbox ? <span aria-hidden="true">✓</span> : null}
      </a> : null}
      <hr role="separator" />
      <a role="menuitem" href={`/api/env?set=sandbox&next=${next}`} data-testid="org-pick-sandbox" aria-current={sandbox ? "true" : undefined}>
        {t("i_env_test")}{sandbox ? <span aria-hidden="true">✓</span> : null}
      </a>
    </>}
    banner={sandbox ? <div className="shell-banner shell-sandbox" role="status" data-testid="env-banner">
      <div><b>{t("i_env_banner_title")}</b><p>{t("i_env_banner_body")}</p></div>
      {hasLiveCompany ? <a href={`/api/env?set=live&next=${next}`} data-testid="env-banner-live">{t("i_env_return_company")}</a> : null}
    </div> : path === "/m" && role === "admin" ? trialBanner : null}>
    {children}
  </ShellV3>;
}
