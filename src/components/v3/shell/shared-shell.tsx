"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../i18n";
import { brandV3NavigationCopy } from "../../../i18n/lanes/brand-v3";
import { pathWithin } from "../../../server/nav-v3";
import { LocaleLinks, SignOutButton } from "../../chrome";
import { RoleAvatar } from "../role-avatar";
import { ShellIcon } from "./icon";

export type ShellEntry = { id: string; href: string; label: string; icon: React.ComponentProps<typeof ShellIcon>["name"]; links?: { href: string; label: string }[] };
export type ShellV3Props = {
  children: ReactNode; areas: ShellEntry[]; tabs: ShellEntry[]; path: string; currentId?: string; moreOn: boolean;
  locale: Locale; name: string; party: "m" | "o" | "v"; brand: string; context: string; company: string; title: string; menuContext: string;
  canSwitchCompany?: boolean; orgMenu?: ReactNode; account?: ReactNode; menuExtra?: ReactNode; banner?: ReactNode;
  buildSha?: string; notification?: ShellEntry; moreEntries?: ShellEntry[];
};

/** Shared phone/desktop chrome and the single focus-managed menu used by the manager, owner and (B-063) vendor portals. */
export function ShellV3({ children, areas, tabs, path, currentId, moreOn, locale, name, party, brand, context, company, title, menuContext,
  canSwitchCompany, orgMenu, account, menuExtra, banner, buildSha, notification, moreEntries }: ShellV3Props) {
  const t = makeT(locale);
  const copy = brandV3NavigationCopy(locale);
  const hasName = name.trim() !== "";
  const current = areas.find(area => area.id === currentId);
  const [popup, setPopup] = useState<null | { kind: "avatar" | "org" | "more"; top: number; left: number }>(null);
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
  const open = (kind: "avatar" | "org" | "more", button: HTMLButtonElement) => {
    trigger.current = button;
    if (popup) { close(); return; }
    const box = button.getBoundingClientRect();
    const left = kind === "avatar" ? box.right - 320 : box.left;
    setPopup({ kind, top: box.bottom + 8, left: Math.max(8, Math.min(left, window.innerWidth - 328)) });
  };
  const avatar = <button type="button" className="shell-avatar" data-testid="avatar-menu-trigger" aria-label={t("i_account")}
    aria-haspopup="menu" aria-expanded={popup?.kind === "avatar"} aria-controls={popup?.kind === "avatar" ? menuId : undefined}
    onClick={event => open("avatar", event.currentTarget)}>{hasName ? <RoleAvatar role={party} locale={locale} name={name} decorative /> : <span className={`party party-${party} party-name shell-avatar-noname`} data-testid="avatar-noname" aria-hidden="true"><ShellIcon name="user" /></span>}</button>;
  const identity = canSwitchCompany ? <button type="button" className="cap shell-context" data-testid="org-switch"
    aria-haspopup="menu" aria-expanded={popup?.kind === "org"} aria-controls={popup?.kind === "org" ? menuId : undefined}
    onClick={event => open("org", event.currentTarget)}>{context}<span aria-hidden="true"> ▾</span></button> : <div className="cap">{context}</div>;
  const bell = notification ? <Link className="shell-bell" data-testid="shell-bell" href={notification.href} aria-label={notification.label}><ShellIcon name="bell" /></Link> : null;
  return <div data-v3-shell="" className={`v3-shell${party !== "m" ? " v3-owner-shell" : ""}`} data-testid={party === "m" ? "manager-shell-v3" : party === "o" ? "owner-shell-v3" : "vendor-shell-v3"}>
    <header className="appbar navy"><div className="wm">{brand}</div>{identity}{bell}{avatar}</header>
    <aside className="sidebar">
      <div className="side-head"><div className="wm">{brand}</div>{identity}</div>
      <nav className="snav" aria-label={copy.navigation} data-testid="v3-sidebar-nav">
        {areas.map(area => <Fragment key={area.id}>
          <Link href={area.href} data-area={area.id} className={current?.id === area.id ? "on" : undefined} aria-current={current?.id === area.id ? "page" : undefined}>
            <ShellIcon name={area.icon} /><span>{area.label}</span>
          </Link>
          {current?.id === area.id ? area.links?.map(item => <Link key={item.href} href={item.href} className={`sub${pathWithin(path, item.href) ? " on" : ""}`} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{item.label}</Link>) : null}
        </Fragment>)}
      </nav>
    </aside>
    <div className="main shell-content">
      <div className="deskbar"><span className="page-title-desk">{title}</span>{bell}{avatar}</div>
      {party !== "m" ? <div className="shell-phone-lead"><h1>{title}</h1></div> : null}
      {banner}
      {current && (current.links?.length ?? 0) > 1 ? <nav className="subchips" aria-label={current.label}>{current.links?.map(item => <Link key={item.href} href={item.href} className={pathWithin(path, item.href) ? "on" : undefined} aria-current={pathWithin(path, item.href) ? "page" : undefined}>{item.label}</Link>)}</nav> : null}
      {children}
      {buildSha !== undefined ? <p className="foot build-sha" data-testid="build-sha">{buildSha}</p> : null}
    </div>
    {popup ? <>
      <div className={`shell-dim shell-dim-${popup.kind}`} data-testid="shell-dim" aria-hidden="true" onClick={close} />
      <div ref={panel} id={menuId} role="menu" aria-label={popup.kind === "avatar" ? t("i_account") : popup.kind === "more" ? copy.more : company}
        className={`shell-popup shell-popup-${popup.kind}`} data-testid={`${popup.kind}-menu`}
        style={{ "--shell-popup-top": `${popup.top}px`, "--shell-popup-left": `${popup.left}px` } as CSSProperties}
        onClick={event => {
          if ((event.target as HTMLElement).closest("a,button")) {
            // Let native form submission and ResetButton's confirmation run before unmounting.
            window.setTimeout(close, 0);
          }
        }}>
        {popup.kind === "avatar" ? <>
          <div className="shell-menu-heading" role="presentation">{hasName ? <b>{name}</b> : null}<p>{menuContext}</p></div>
          {account}
          <div className="shell-language" role="group" aria-label={t("s_ae41d00")}>
            <span data-testid="avatar-language">{t("s_ae41d00")}</span><LocaleLinks currentLocale={locale} />
          </div>
          <SignOutButton shellMenu />
          {menuExtra}
        </> : popup.kind === "more" ? <>
          <div className="shell-menu-heading" role="presentation"><b>{copy.more}</b></div>
          {moreEntries?.map(item => <Link role="menuitem" key={item.id} href={item.href} className="shell-more-entry" aria-current={currentId === item.id ? "page" : undefined}><ShellIcon name={item.icon} /><span>{item.label}</span></Link>)}
        </> : orgMenu}
      </div>
    </> : null}
    <nav className="tabbar" aria-label={copy.navigation} data-testid="v3-phone-tabs">
      {tabs.map(tab => {
        const active = tab.id === "more" ? moreOn : current?.id === tab.id;
        if (tab.id === "more" && moreEntries) return <button type="button" key={tab.id} data-area="more" className={active || popup?.kind === "more" ? "on" : undefined}
          aria-current={active ? "page" : undefined} aria-haspopup="menu" aria-expanded={popup?.kind === "more"} aria-controls={popup?.kind === "more" ? menuId : undefined}
          onClick={event => open("more", event.currentTarget)}><ShellIcon name={tab.icon} />{tab.label}</button>;
        return <Link key={tab.id} href={tab.href} data-area={tab.id} className={active ? "on" : undefined} aria-current={active ? "page" : undefined}><ShellIcon name={tab.icon} />{tab.label}</Link>;
      })}
    </nav>
  </div>;
}
