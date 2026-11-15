"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3Copy, brandV3NavigationCopy, brandV3ShellCopy } from "../../../i18n/lanes/brand-v3";
import { areaForPath, crumbsForAreas, navLabel, pathWithin, type ManagerAreaV3 } from "../../../server/nav-v3";
import type { OrgRole } from "../../../server/types";
import { LocaleLinks, ResetButton, SignOutButton } from "../../chrome";
import { RoleAvatar } from "../role-avatar";
import { ShellIcon } from "./icon";

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
  const context = copy.context.replace("{company}", company).replace("{name}", name).replace("{role}", role ? t(`i_role_${role}`) : "");
  const brand = copy.brandParty.replace("{brand}", t("i_brand")).replace("{party}", brandV3Copy(locale).m);
  const next = encodeURIComponent(path);
  const shellCopy = brandV3ShellCopy(locale);
  const [popup, setPopup] = useState<null | { kind: "avatar" | "org"; top: number; left: number }>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const close = useCallback(() => {
    setPopup(null);
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!popup) return;
    const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? []);
    items()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const controls = items();
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const controls = items();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
        controls[nextIndex]?.focus();
      }
    };
    // Lock background scrolling while the phone sheet is open; restore on every exit.
    const overflow = document.body.style.overflow;
    if (window.matchMedia("(max-width: 63.99em)").matches) document.body.style.overflow = "hidden";
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", close);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", close);
    };
  }, [popup, close]);
  const open = (kind: "avatar" | "org", button: HTMLButtonElement) => {
    trigger.current = button;
    if (popup) { close(); return; }
    const box = button.getBoundingClientRect();
    const left = kind === "avatar" ? box.right - 320 : box.left;
    setPopup({ kind, top: box.bottom + 8, left: Math.max(8, Math.min(left, window.innerWidth - 328)) });
  };
  const avatar = <button type="button" className="shell-avatar" data-testid="avatar-menu-trigger" aria-label={t("i_account")}
    aria-haspopup="menu" aria-expanded={popup?.kind === "avatar"} aria-controls={popup?.kind === "avatar" ? menuId : undefined}
    onClick={event => open("avatar", event.currentTarget)}><RoleAvatar role="m" locale={locale} name={locale === "en" ? name.trim().split(/\s+/)[0] : name} decorative /></button>;
  const identity = canSwitchCompany ? <button type="button" className="cap shell-context" data-testid="org-switch"
    aria-haspopup="menu" aria-expanded={popup?.kind === "org"} aria-controls={popup?.kind === "org" ? menuId : undefined}
    onClick={event => open("org", event.currentTarget)}>{context}<span aria-hidden="true"> ▾</span></button> : <div className="cap">{context}</div>;
  return <div className="v3-shell" data-testid="manager-shell-v3">
    <header className="appbar navy"><div className="wm">{brand}</div>{identity}{avatar}</header>
    <aside className="sidebar">
      <div className="side-head"><div className="wm">{brand}</div>{identity}</div>
      <nav className="snav" aria-label={copy.navigation} data-testid="v3-sidebar-nav">
        {areas.map(area => <Fragment key={area.id}>
          <Link href={area.href} data-area={area.id} className={current?.id === area.id ? "on" : undefined} aria-current={current?.id === area.id ? "page" : undefined}>
            <ShellIcon name={area.icon} /><span>{navLabel(area.key, locale)}</span>
          </Link>
          {current?.id === area.id ? area.links.map(item => <Link key={item.href} href={item.href} className={`sub${pathWithin(path, item.href) ? " on" : ""}`} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{navLabel(item.key, locale)}</Link>) : null}
        </Fragment>)}
      </nav>
    </aside>
    <div className="main shell-content">
      <div className="deskbar"><span className="page-title-desk">{title}</span>{avatar}</div>
      {sandbox ? <div className="shell-banner shell-sandbox" role="status" data-testid="env-banner">
        <div><b>{t("i_env_banner_title")}</b><p>{t("i_env_banner_body")}</p></div>
        {hasLiveCompany ? <a href={`/api/env?set=live&next=${next}`} data-testid="env-banner-live">{t("i_env_return_company")}</a> : null}
      </div> : path === "/m" && role === "admin" ? trialBanner : null}
      {current && current.links.length > 1 ? <nav className="subchips" aria-label={navLabel(current.key, locale)}>{current.links.map(item => <Link key={item.href} href={item.href} className={pathWithin(path, item.href) ? "on" : undefined} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{navLabel(item.key, locale)}</Link>)}</nav> : null}
      {children}
      <p className="foot build-sha" data-testid="build-sha">{buildSha}</p>
    </div>
    {popup ? <>
      <div className={`shell-dim shell-dim-${popup.kind}`} data-testid="shell-dim" aria-hidden="true" onClick={close} />
      <div ref={panel} id={menuId} role="menu" aria-label={popup.kind === "avatar" ? t("i_account") : company}
        className={`shell-popup shell-popup-${popup.kind}`} data-testid={popup.kind === "avatar" ? "avatar-menu" : "org-menu"}
        style={{ "--shell-popup-top": `${popup.top}px`, "--shell-popup-left": `${popup.left}px` } as CSSProperties}
        onClick={event => {
          if ((event.target as HTMLElement).closest("a,button")) {
            // Let native form submission and ResetButton's confirmation run before unmounting.
            window.setTimeout(close, 0);
          }
        }}>
        {popup.kind === "avatar" ? <>
          <div className="shell-menu-heading" role="presentation"><b>{name}</b><p>{shellCopy.menuContext.replace("{role}", role ? t(`i_role_${role}`) : "").replace("{company}", company)}</p></div>
          <Link role="menuitem" className="shell-account" data-testid="avatar-account" href="/m/account">{t("i_account")}</Link>
          <div className="shell-language" role="group" aria-label={t("s_ae41d00")}>
            <span data-testid="avatar-language">{t("s_ae41d00")}</span><LocaleLinks currentLocale={locale} />
          </div>
          <SignOutButton shellMenu />
          {showReset && role === "admin" ? <ResetButton shellMenu /> : null}
        </> : <>
          {hasLiveCompany ? <a role="menuitem" href={`/api/env?set=live&next=${next}`} data-testid="org-pick-live" aria-current={!sandbox ? "true" : undefined}>
            {firm}{!sandbox ? <span aria-hidden="true">✓</span> : null}
          </a> : null}
          <hr role="separator" />
          <a role="menuitem" href={`/api/env?set=sandbox&next=${next}`} data-testid="org-pick-sandbox" aria-current={sandbox ? "true" : undefined}>
            {t("i_env_test")}{sandbox ? <span aria-hidden="true">✓</span> : null}
          </a>
        </>}
      </div>
    </> : null}
    <nav className="tabbar" aria-label={copy.navigation} data-testid="v3-phone-tabs">
      {tabs.map(tab => {
        const active = tab.id === "more" ? moreOn : current?.id === tab.id;
        return <Link key={tab.id} href={tab.href} data-area={tab.id} className={active ? "on" : undefined} aria-current={active ? "page" : undefined}><ShellIcon name={tab.icon} />{navLabel(tab.key, locale)}</Link>;
      })}
    </nav>
  </div>;
}
