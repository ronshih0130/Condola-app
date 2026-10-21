import { FlowError } from "./errors";
import type { OrgRole, Session } from "./types";

/**
 * Permission matrix from the design prototype (`PERMS` in the clickable spec).
 * The roles screen, the nav, and server actions all read this table.
 * The prototype uses `maint`; the database enum value is `maintenance`.
 */
export const ROLE_KEYS = ["admin", "manager", "accountant", "maintenance"] as const satisfies readonly OrgRole[];

export const PERMS = [
  ["dash.view", "pm_dash", ["admin", "manager", "accountant"]],
  ["props.view", "pm_props_view", ["admin", "manager", "accountant"]],
  ["props.edit", "pm_props_edit", ["admin", "manager"]],
  ["leases.edit", "pm_leases_edit", ["admin", "manager"]],
  ["tenants.contact", "pm_tenants_contact", ["admin", "manager", "maintenance"]],
  ["pay.record", "pm_pay_record", ["admin", "manager", "accountant"]],
  ["pay.reverse", "pm_pay_reverse", ["admin", "accountant"]],
  ["bank.reconcile", "pm_bank", ["admin", "accountant"]],
  ["stmt.view", "pm_stmt_view", ["admin", "manager", "accountant"]],
  ["stmt.generate", "pm_stmt_gen", ["admin", "accountant"]],
  ["exp.add", "pm_exp_add", ["admin", "manager", "accountant"]],
  ["month.close", "pm_close", ["admin", "accountant"]],
  ["tickets.update", "pm_tickets", ["admin", "manager", "maintenance"]],
  ["messages.send", "pm_messages", ["admin", "manager"]],
  ["reports.export", "pm_export_reports", ["admin", "manager", "accountant"]],
  ["team.manage", "pm_team", ["admin"]],
  ["settings.edit", "pm_settings", ["admin"]],
  ["data.export", "pm_export_all", ["admin"]],
] as const;

export type PermKey = (typeof PERMS)[number][0];

const PERM_ROLES = Object.fromEntries(PERMS.map(([key, , roles]) => [key, roles])) as unknown as Record<
  PermKey,
  readonly OrgRole[]
>;

export function can(role: OrgRole | null | undefined, key: PermKey) {
  if (!role) return false;
  return PERM_ROLES[key].includes(role);
}

export function assertPerm(session: Session, key: PermKey) {
  if (session.kind !== "staff" || !can(session.role, key)) throw new FlowError("errors.forbidden");
}

export function rolesFor(key: PermKey): readonly OrgRole[] {
  return PERM_ROLES[key];
}

/** Sidebar entries. Admin sees 17, including 操作紀錄. Empty sections are dropped by the caller. */
export const MANAGER_NAV = [
  {
    section: "i_sec_rentals",
    links: [
      { href: "/m", key: "i_nav_dash", perm: "dash.view" },
      { href: "/m/properties", key: "i_nav_props", perm: "props.view" },
      { href: "/m/owners", key: "i_nav_owners", perm: "props.view" },
      { href: "/m/units", key: "i_nav_units", perm: "props.view" },
      { href: "/m/tenants", key: "i_nav_tenants", perm: "props.view" },
      { href: "/m/leases", key: "i_nav_leases", perm: "props.view" },
    ],
  },
  {
    section: "i_sec_acct",
    links: [
      { href: "/m/rent", key: "i_nav_rent", perm: "stmt.view" },
      { href: "/m/payments", key: "i_nav_inbox", perm: "pay.record" },
      { href: "/m/bank", key: "i_nav_bank", perm: "bank.reconcile" },
      { href: "/m/statements", key: "i_nav_stmt", perm: "stmt.view" },
      { href: "/m/close", key: "i_nav_close", perm: "month.close" },
    ],
  },
  {
    section: "i_sec_ops",
    links: [
      { href: "/m/tickets", key: "i_nav_tickets" },
      { href: "/m/messages", key: "i_nav_msg", perm: "messages.send" },
    ],
  },
  {
    section: "i_sec_set",
    links: [
      { href: "/m/team", key: "i_nav_team", perm: "team.manage" },
      { href: "/m/audit", key: "i_nav_audit", admin: true },
      { href: "/m/notify", key: "i_nav_notify", perm: "settings.edit" },
      { href: "/m/settings", key: "i_nav_settings", perm: "settings.edit" },
    ],
  },
] as const;

export type NavLink = { href: string; key: string; perm?: PermKey; admin?: boolean };

export function visibleNav(role: OrgRole | null): { section: string; links: NavLink[] }[] {
  if (!role) return [];
  return MANAGER_NAV.map((section) => ({
    section: section.section,
    links: section.links.filter((link) => {
      if ("admin" in link && link.admin) return role === "admin";
      return !("perm" in link) || can(role, link.perm);
    }),
  })).filter((section) => section.links.length > 0);
}

/** 操作紀錄 is org-admin only. It is not one of the 18 prototype permission rows. */
export function requiresAdmin(pathname: string) {
  const path = pathname.split("?")[0] || "/";
  return path === "/m/audit" || path.startsWith("/m/audit/");
}

/**
 * Where to send someone who cannot open this path.
 * Prototype routes use their permission key (`props.edit`, `settings.edit`).
 * 操作紀錄 is not the settings screen, so it names the admin role instead.
 */
export function noPermHref(pathname: string, role: OrgRole | null) {
  if (requiresAdmin(pathname)) return role === "admin" ? null : "/m/noperm?need=admin";
  const perm = permForPath(pathname);
  if (perm && !can(role, perm)) return `/m/noperm?need=${perm}`;
  return null;
}

export function navCount(role: OrgRole | null) {
  return visibleNav(role).reduce((sum, section) => sum + section.links.length, 0);
}

/** Where a signed-in person lands. Maintenance does not get the money dashboard. */
export function roleHome(kind: "staff" | "tenant" | "owner", role: OrgRole | null) {
  if (kind === "tenant") return "/t";
  if (kind === "owner") return "/o";
  if (can(role, "dash.view")) return "/m";
  return "/m/tickets";
}

const ROUTE_PERM: { prefix: string; perm: PermKey; exact?: boolean }[] = [
  { prefix: "/m/properties/new", perm: "props.edit" },
  { prefix: "/m/leases/new", perm: "leases.edit" },
  { prefix: "/m/owners", perm: "props.view", exact: true },
  { prefix: "/m/owners", perm: "props.edit" },
  { prefix: "/m/units/new", perm: "props.edit" },
  { prefix: "/m/units/room", perm: "props.edit" },
  { prefix: "/m/units/whole", perm: "props.edit" },
  { prefix: "/m/properties", perm: "props.view" },
  { prefix: "/m/units", perm: "props.view" },
  { prefix: "/m/tenants", perm: "props.view" },
  { prefix: "/m/leases", perm: "props.view" },
  { prefix: "/m/rent", perm: "stmt.view" },
  { prefix: "/m/payments", perm: "pay.record" },
  { prefix: "/m/bank", perm: "bank.reconcile" },
  { prefix: "/m/statements", perm: "stmt.view" },
  { prefix: "/m/close", perm: "month.close" },
  { prefix: "/m/messages", perm: "messages.send" },
  { prefix: "/m/team", perm: "team.manage" },
  { prefix: "/m/notify", perm: "settings.edit" },
  { prefix: "/m/settings", perm: "settings.edit" },
  { prefix: "/m", perm: "dash.view", exact: true },
];

export function permForPath(pathname: string): PermKey | null {
  const path = pathname.split("?")[0] || "/";
  if (/^\/m\/properties\/[^/]+\/edit\/?$/.test(path)) return "props.edit";
  for (const route of ROUTE_PERM) {
    if (route.exact) {
      if (path === route.prefix) return route.perm;
      continue;
    }
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) return route.perm;
  }
  return null;
}
