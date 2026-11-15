import { archiveCopy } from "../i18n/record-archive";
import { makeT, type Locale } from "../i18n";
import { brandV3NavigationCopy, type NavigationCopyKey } from "../i18n/lanes/brand-v3";
import { can, noPermHref, type PermKey } from "./perms";
import type { Session } from "./types";

type Visibility = PermKey | "any" | "admin";
export type NavV3Link = { key: string; href: string; perm: Visibility };
export type ManagerAreaV3 = NavV3Link & {
  id: string; icon: "today" | "chat" | "box" | "doc" | "coin" | "tool" | "gear" | "more";
  links: readonly NavV3Link[];
};
const link = (key: string, href: string, perm: Visibility): NavV3Link => ({ key, href, perm });

/** Approved B-043 AREAS, in fixed order. This model never reads the database. */
export const MANAGER_AREAS_V3: readonly ManagerAreaV3[] = [
  { id: "today", icon: "today", ...link("i_today", "/m", "dash.view"), links: [] },
  { id: "messages", icon: "chat", ...link("i_nav_msg", "/m/messages", "messages.send"), links: [] },
  { id: "properties", icon: "box", ...link("v3.properties", "/m/properties", "props.view"), links: [
    link("i_nav_props", "/m/properties", "props.view"), link("i_nav_units", "/m/units", "props.view"),
    link("i_nav_tenants", "/m/tenants", "props.view"), link("i_nav_owners", "/m/owners", "props.view"),
    link("archive.archive", "/m/archive", "props.view"),
  ] },
  { id: "leases", icon: "doc", ...link("i_nav_leases", "/m/leases", "props.view"), links: [] },
  { id: "money", icon: "coin", ...link("v3.money", "/m/rent", "stmt.view"), links: [
    link("i_nav_rent", "/m/rent", "stmt.view"), link("i_nav_inbox", "/m/payments", "pay.record"),
    link("i_nav_bank", "/m/bank", "bank.reconcile"), link("i_nav_stmt", "/m/statements", "stmt.view"),
    link("i_nav_expenses", "/m/expenses", "exp.add"), link("i_nav_reports", "/m/reports", "reports.export"),
    link("i_nav_close", "/m/close", "month.close"),
  ] },
  { id: "maintenance", icon: "tool", ...link("v3.maintenance", "/m/tickets", "any"), links: [] },
  { id: "settings", icon: "gear", ...link("i_sec_set", "/m/settings", "any"), links: [
    link("i_nav_settings", "/m/settings", "settings.edit"), link("i_nav_team", "/m/team", "team.manage"),
    link("v3.roles", "/m/roles", "team.manage"), link("i_nav_notify", "/m/notify", "settings.edit"),
    link("i_nav_audit", "/m/audit", "admin"), link("i_nav_pricing", "/m/upgrade", "settings.edit"),
    link("v3.import", "/m/import", "props.edit"), link("i_account", "/m/account", "any"),
  ] },
];

function permitted(session: Session, item: NavV3Link) {
  if (session.kind !== "staff" || !session.role) return false;
  // The existing archive reader additionally guards props.edit for custom authority.
  if (item.href === "/m/archive" && session.customRole && !can(session, "props.edit")) return false;
  // 角色權限: the approved design files it under team.manage; the page itself admits settings.edit.
  if (item.href === "/m/roles") return can(session, "team.manage") && can(session, "settings.edit");
  if (item.perm === "admin") return session.role === "admin" && !noPermHref(item.href, session);
  if (item.perm === "any") return item.href !== "/m/tickets" || !noPermHref(item.href, session);
  return can(session, item.perm);
}
export function areasFor(session: Session): ManagerAreaV3[] {
  return MANAGER_AREAS_V3.filter(area => permitted(session, area)).flatMap(area => {
    const links = area.links.filter(item => permitted(session, item));
    return area.links.length && !links.length ? [] : [{ ...area, links, href: links[0]?.href ?? area.href }];
  });
}
export function roleHomeV3(kind: Session["kind"], role: Session["role"]) {
  if (kind === "tenant") return "/t";
  if (kind === "owner") return "/o";
  if (role === "accountant") return "/m/payments";
  if (role === "admin" || role === "manager") return "/m";
  return "/m/tickets";
}
/**
 * Where this staff session lands under brand_v3 (MGT-48/49): the role's landing when the
 * effective session can open it; otherwise the first area it can open; otherwise 我的帳號,
 * which every staff member can open. Never a page that sends the user to /m/noperm.
 */
export function landingV3(session: Session) {
  if (session.kind !== "staff") return roleHomeV3(session.kind, session.role);
  const opens = (href: string) => !noPermHref(href, session);
  const preferred = roleHomeV3(session.kind, session.role);
  if (opens(preferred)) return preferred;
  for (const area of areasFor(session)) if (opens(area.href)) return area.href;
  return "/m/account";
}
export function tabsFor(session: Session): ManagerAreaV3[] {
  const areas = areasFor(session);
  if (areas.length <= 5) return areas;
  let tabs = areas.slice(0, 4);
  const landing = areas.find(area => area.id === areaForPath(landingV3(session))?.id);
  if (landing && !tabs.includes(landing)) tabs = [...tabs.slice(0, 3), landing];
  return [...tabs, { id: "more", icon: "more", ...link("v3.more", "/m/more", "any"), links: [] }];
}

export const NO_AREA_PATHS_V3 = ["/m/noperm", "/m/admin", "/m/more"] as const;
export function pathWithin(path: string, href: string) { return path === href || (href !== "/m" && path.startsWith(`${href}/`)); }
const cleanPath = (path: string) => path.split(/[?#]/)[0].replace(/\/$/, "") || "/";
export function areaForPath(pathname: string): ManagerAreaV3 | null {
  const path = cleanPath(pathname);
  if (NO_AREA_PATHS_V3.some(href => pathWithin(path, href))) return null;
  if (pathWithin(path, "/m/notifications")) return MANAGER_AREAS_V3[0];
  if (pathWithin(path, "/m/handover")) return MANAGER_AREAS_V3[3];
  return MANAGER_AREAS_V3.find(area => area.links.length
    ? area.links.some(item => pathWithin(path, item.href)) : pathWithin(path, area.href)) ?? null;
}
export function navLabel(key: string, locale: Locale) {
  if (key === "archive.archive") return archiveCopy(locale).archive;
  return key.startsWith("v3.") ? brandV3NavigationCopy(locale)[key.slice(3) as NavigationCopyKey] : makeT(locale)(key);
}
/** No invented detail-page titles: only approved area/sub-page names. */
export function crumbsForAreas(pathname: string, areas: readonly ManagerAreaV3[], locale: Locale): string[] {
  const path = cleanPath(pathname);
  if (path === "/m/more") return [brandV3NavigationCopy(locale).more];
  const area = areas.find(item => item.id === areaForPath(path)?.id);
  if (!area) return [];
  const sub = area.links.find(item => pathWithin(path, item.href));
  return [navLabel(area.key, locale), ...(sub && path !== area.href ? [navLabel(sub.key, locale)] : [])];
}
export function crumbFor(pathname: string, session: Session) {
  return crumbsForAreas(pathname, areasFor(session), session.locale);
}
