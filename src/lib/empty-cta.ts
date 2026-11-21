import type { PermKey } from "@/server/perms";
import { INVITE_PERMS } from "@/server/onboarding-progress-rules";

export const EMPTY_PAGES = ["DASH", "MSG", "PROP", "UNIT", "TEN", "TENID", "LEASE", "PAY", "BANK", "UTIL", "EXP", "STMT", "RPT", "TIX", "OWN", "NOTI", "SRCH"] as const;
export type EmptyPage = typeof EMPTY_PAGES[number];
export type InviteMode = "m4" | "lease" | "no_lease";
/** perm: one key; perms: every listed key is also required (destination route + loaders);
 * customPerms: required only for custom-role sessions (destination guards that are no-ops for native sessions);
 * firm: the destination loads through loadFirm, so it also needs setup.unmappedEntryOk. */
export type EmptyAction = { key: string; href: string; perm?: PermKey; perms?: readonly PermKey[]; customPerms?: readonly PermKey[]; firm?: true };
export type EmptyCta = { primary: EmptyAction | null; links: EmptyAction[]; showAdminHint: boolean };
/** unmappedEntryOk: the session passes the B-017 null-key entry guard (guardEffectiveSession(session, null)),
 * which destinations loading through loadFirm require; assigned custom roles do not.
 * customAuthority: the resolved session carries a B-017 customRole, so keyed destination guards apply. */
export type EmptySetup = { step: 0 | 1 | 2 | 3 | 4; checklistOn: boolean; hasUnits: boolean; inviteMode: InviteMode; inviteHref: string; unmappedEntryOk: boolean; customAuthority: boolean };

export const EMPTY_ACTIONS = {
  company: { key: "es_setup_company", href: "/m/settings", perm: "settings.edit" },
  // /m/units/new, /m/properties[/id/edit] and /m/owners/new also load props.view data (listProperties, listOwners, archive eligibility).
  unit: { key: "es_UNIT_action", href: "/m/units/new", perm: "props.edit", perms: ["props.view"] },
  import: { key: "es_DASH_action", href: "/m/import", perm: "props.edit" },
  manual: { key: "es_DASH_manual", href: "/m/units/new", perm: "props.edit", perms: ["props.view"] },
  // /api/env runs guardEffectiveSession(session, null) (readSession), then redirects to /m (the DASH source page).
  sample: { key: "es_DASH_sample", href: "/api/env?set=sandbox&next=/m", firm: true },
  importLink: { key: "es_PROP_import", href: "/m/import", perm: "props.edit" },
  // B-040 invite permission = what every invite destination enforces (INVITE_PERMS).
  invite: { key: "es_TEN_action", href: "/m/units", perms: INVITE_PERMS },
  // /m/leases/new: route leases.edit + loader listTenants (props.view) + loadFirm (null-key guard).
  lease: { key: "es_LEASE_action", href: "/m/leases/new", perms: INVITE_PERMS, firm: true },
  // /m/rent runs guardEffectiveSession(session, "tenants.contact") unconditionally (manualRemindersEnabled); no-op for native sessions.
  rent: { key: "es_PAY_action", href: "/m/rent", perm: "stmt.view", customPerms: ["tenants.contact"] },
  bank: { key: "es_BANK_action", href: "/m/bank#bank-import", perm: "bank.reconcile" },
  utility: { key: "es_UTIL_action", href: "/m/properties", perm: "props.edit", perms: ["props.view"] },
  expense: { key: "es_EXP_action", href: "/m/expenses/new", perm: "exp.add" },
  range: { key: "es_RPT_action", href: "/m/reports#report-filters" },
  // /m/tickets loads listLeases → guardEffectiveSession(session, "props.view"); no-op for native sessions.
  ticket: { key: "es_TIX_action", href: "/m/tickets#new-ticket", perm: "tickets.update", customPerms: ["props.view"] },
  owner: { key: "es_OWN_action", href: "/m/owners/new", perm: "props.edit", perms: ["props.view"] },
  // /m renders NotificationCenterEntry → centerSessionAdmission → guardEffectiveSession(session, null).
  today: { key: "es_NOTI_action", href: "/m", perm: "dash.view", firm: true },
  clear: { key: "es_SRCH_action", href: "/m" },
  leases: { key: "es_DASH_C_leases", href: "/m/leases", perm: "props.view" },
} satisfies Record<string, EmptyAction>;

export function emptyPageAction(page: EmptyPage): EmptyAction | null {
  const a = EMPTY_ACTIONS;
  return { DASH: null, MSG: a.invite, PROP: a.unit, UNIT: a.unit, TEN: a.invite, TENID: a.lease,
    LEASE: a.lease, PAY: a.rent, BANK: a.bank, UTIL: a.utility, EXP: a.expense, STMT: a.rent,
    RPT: a.range, TIX: a.ticket, OWN: a.owner, NOTI: a.today, SRCH: a.clear }[page];
}

/** One admission rule for every empty-state link: the action's keys, the destination loaders' keys,
 * custom-only destination guards, and the B-017 null-key guard for loadFirm destinations. */
export function emptyActionAllowed(a: EmptyAction | null | undefined, setup: Pick<EmptySetup, "customAuthority" | "unmappedEntryOk">, can: (key: PermKey) => boolean): a is EmptyAction {
  return !!a && (!a.perm || can(a.perm)) && (a.perms ?? []).every(key => can(key))
    && (!setup.customAuthority || (a.customPerms ?? []).every(key => can(key)))
    && (!a.firm || setup.unmappedEntryOk === true);
}

/** MGT-54/55/56: resolve on the server; components receive only permitted actions. */
export function resolveEmptyCta({ page, setup, can, pageAction = emptyPageAction(page) }: {
  page: EmptyPage; setup: EmptySetup; can: (key: PermKey) => boolean; pageAction?: EmptyAction | null;
}): EmptyCta {
  if (page === "SRCH") return { primary: pageAction ?? EMPTY_ACTIONS.clear, links: [], showAdminHint: false };
  const allowed = (a: EmptyAction | null): a is EmptyAction => emptyActionAllowed(a, setup, can);
  const invite = (a: EmptyAction | null) => a?.key === EMPTY_ACTIONS.invite.key
    ? setup.inviteMode === "no_lease" ? EMPTY_ACTIONS.lease : { ...a, href: setup.inviteHref } : a;
  const own = invite(pageAction);
  const next = [EMPTY_ACTIONS.company, EMPTY_ACTIONS.unit, EMPTY_ACTIONS.invite, EMPTY_ACTIONS.invite];
  const target = invite(page === "DASH" && !setup.hasUnits ? EMPTY_ACTIONS.import : page === "MSG" ? EMPTY_ACTIONS.invite
    : setup.checklistOn && setup.step < 4 ? next[setup.step] : own);
  let primary: EmptyAction | null = null;
  const links: EmptyAction[] = [];
  if (target && allowed(target)) {
    primary = target;
    if (own && allowed(own) && own.key !== target.key) links.push(own);
  } else if (own && allowed(own) && own.key !== target?.key) primary = own;
  const showAdminHint = !primary && setup.step < 4;
  if (page === "DASH") {
    if (!setup.hasUnits) {
      if (allowed(EMPTY_ACTIONS.manual)) links.push(EMPTY_ACTIONS.manual);
      if (allowed(EMPTY_ACTIONS.sample)) links.push(EMPTY_ACTIONS.sample);
    } else if (!setup.checklistOn || setup.step < 2 || setup.step === 4) primary = null;
  }
  if ((page === "PROP" || page === "UNIT") && allowed(EMPTY_ACTIONS.importLink)) links.push(EMPTY_ACTIONS.importLink);
  return { primary, links: links.filter(a => a.key !== primary?.key).slice(0, 2), showAdminHint };
}
