import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { loadFirmNoticeContact } from "./id-docs";
import { FlowError } from "./errors";
import { can } from "./perms";
import { archiveAncestry, admitLeaseArchiveAncestry } from "./record-archive-admission";
import { listLeases, propertyDetail, type SpaceRow } from "./queries";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { currentInvite, existingLoginHash, hashInviteToken, includeOnLease, issueInvite, listBindings, removeBinding, rotateInvite, staffCanManage, unitLineInviteOn } from "./unit-line-invite";

export type InviteBinding = { id: string; name: string; displayName: string; method: "line" | "email"; joinedAt: string; joinedAtLabel?: string; pending: boolean };
export type StaffInviteData = {
  unitId: string; firm: string; place: string; locale: Session["locale"];
  invite: { path: string; expiresAt: string; fingerprint: string } | null;
  bindings: InviteBinding[];
  leases: { id: string; label: string }[];
};
export { staffInvitePath } from "../lib/staff-invite";

export async function staffInviteVisible(session: Session): Promise<boolean> {
  if (!staffCanManage(session)) return false;
  try {
    session = await guardEffectiveSession(session, "leases.edit");
    return can(session, "leases.edit") && await unitLineInviteOn(session.orgId);
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return false;
    throw error;
  }
}

/** The supplied ID identifies a resource, never an organization. No new SQL. */
export async function requireStaffInviteUnit(session: Session, unitId: string) {
  if (!staffCanManage(session)) throw new FlowError("errors.forbidden");
  session = await guardEffectiveSession(session, "leases.edit");
  if (!(await unitLineInviteOn(session.orgId))) throw new FlowError("errors.notFound");
  if (!isUuid(unitId)) throw new FlowError("errors.forbidden");
  try {
    const unit = await tx(session.userId, c => withEffectiveAuthority(c, session, "leases.edit", () =>
      archiveAncestry(c, session.orgId, { kind: "unit", id: unitId })),
    { orgId: session.orgId, environment: session.environment }, { readOnly: true });
    if (unit.propertyArchived || unit.unitArchived) throw new FlowError("errors.forbidden");
    return unit;
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.notFound") throw new FlowError("errors.forbidden");
    throw error;
  }
}

export async function staffInviteEntries(session: Session, rows: Pick<SpaceRow, "id" | "kind">[]) {
  session = await guardEffectiveSession(session, "leases.edit");
  if (!await staffInviteVisible(session)) return [];
  const ids = await tx(session.userId, async c => withEffectiveAuthority(c, session, "leases.edit", async () => {
    const result: { rowId: string; unitId: string }[] = [];
    for (const row of rows) {
      const a = await archiveAncestry(c, session.orgId, { kind: row.kind === "room" ? "room" : "unit", id: row.id });
      if (a.unitId && !a.propertyArchived && !a.unitArchived && !a.roomArchived) result.push({ rowId: row.id, unitId: a.unitId });
    }
    return result;
  }), { orgId: session.orgId, environment: session.environment }, { readOnly: true });
  const invites = new Map<string, Awaited<ReturnType<typeof currentInvite>>>();
  for (const { unitId } of ids) if (!invites.has(unitId)) invites.set(unitId, await currentInvite(session, unitId));
  // No raw path/token leaves this U0 reader.
  return ids.map(({ rowId, unitId }) => {
    const invite = invites.get(unitId);
    return { rowId, unitId, bound: invite?.bound ?? 0, expiresAt: invite?.expires_at.toISOString() ?? null };
  });
}

export async function staffInviteLive(session: Session, unitId: string) {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  const invite = await currentInvite(session, unitId);
  const rows = await listBindings(session, unitId);
  const bindings: InviteBinding[] = rows.filter(r => r.status === "pending" || r.status === "lease_linked").map(r => ({
    id: String(r.id), name: String(r.entered_name || r.display_name || ""), displayName: String(r.display_name || ""),
    method: r.line_identity_hash === existingLoginHash(String(r.user_id)) ? "email" : "line",
    joinedAt: new Date(String(r.bound_at)).toISOString(), pending: r.status === "pending",
  }));
  return { bindings, bound: bindings.length, cap: 4,
    expiresAt: invite?.expires_at.toISOString() ?? null,
    fingerprint: invite ? hashInviteToken(invite.token) : null };
}

async function unitLeases(session: Session, unitId: string) {
  const leases = (await listLeases(session)).filter(l => l.status === "active" || l.status === "pending_signature");
  return tx(session.userId, async c => withEffectiveAuthority(c, session, "leases.edit", async () => {
    const result: StaffInviteData["leases"] = [];
    for (const lease of leases) {
      // The existing admission checks org, unit/room ancestry and archive state.
      try {
        const target = await admitLeaseArchiveAncestry(c, session.orgId, lease.id);
        if (target.unit_id === unitId) result.push({ id: lease.id, label: `${lease.place} · ${lease.start_date}${lease.end_date ? ` — ${lease.end_date}` : ""}` });
      } catch (error) { if (!(error instanceof FlowError && error.key === "errors.notFound")) throw error; }
    }
    return result;
  }), { orgId: session.orgId, environment: session.environment });
}

export async function staffInviteData(session: Session, unitId: string, withLeases = false): Promise<StaffInviteData> {
  session = await guardEffectiveSession(session, "leases.edit");
  const unit = await requireStaffInviteUnit(session, unitId);
  const property = await propertyDetail(session, unit.propertyId);
  const label = [...(property?.wholes ?? []), ...(property?.byRoomUnits ?? [])].find(u => u.id === unitId)?.label;
  if (!property || label === undefined) throw new FlowError("errors.forbidden");
  const firm = await loadFirmNoticeContact(session);
  const live = await staffInviteLive(session, unitId);
  const invite = await currentInvite(session, unitId);
  return { unitId, firm: firm.name, place: `${property.property.name} ${label}`, locale: session.locale,
    invite: invite ? { path: invite.path, expiresAt: invite.expires_at.toISOString(), fingerprint: hashInviteToken(invite.token) } : null,
    bindings: live.bindings.map(binding => ({ ...binding, joinedAtLabel: new Intl.DateTimeFormat(session.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(binding.joinedAt)) })), leases: withLeases ? await unitLeases(session, unitId) : [] };
}

export type StaffInviteCommand = { action: "issue" | "rotate" | "remove" | "include"; bindingId?: string; bindingIds?: string[]; leaseId?: string };
export async function mutateStaffInvite(session: Session, unitId: string, input: StaffInviteCommand): Promise<void> {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  if (input.action === "issue") {
    if (!await currentInvite(session, unitId)) {
      try { await issueInvite(session, unitId); }
      catch (error) { if (!await currentInvite(session, unitId)) throw error; }
    }
  } else if (input.action === "rotate") {
    await rotateInvite(session, unitId);
  } else if (input.action === "remove" || input.action === "include") {
    const bindings = await listBindings(session, unitId);
    const active = bindings.filter(b => b.status === "pending" || b.status === "lease_linked");
    if (input.action === "remove") {
      if (!active.some(b => b.id === input.bindingId)) throw new FlowError("errors.forbidden");
      await removeBinding(session, input.bindingId!);
    } else {
      const ids = input.bindingIds;
      if (!isUuid(input.leaseId ?? "") || !Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length ||
          ids.some(id => !isUuid(id) || !active.some(b => b.id === id && b.status === "pending"))) throw new FlowError("errors.forbidden");
      const leases = await unitLeases(session, unitId);
      if (!leases.some(l => l.id === input.leaseId)) throw new FlowError("errors.forbidden");
      // The existing SQL function repeats org/unit/lease checks under the unit lock.
      await includeOnLease(session, input.leaseId!, unitId, ids);
    }
  } else throw new FlowError("errors.invalid");
}

/** Shared page/API loader. Authorization precedes any automatic issuance. */
export async function staffInvitePage(session: Session, unitId: string, view: string[]) {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  const screens: Record<string, import("../lib/staff-invite").InviteScreen> = {
    "": "panel", qr: "qr", print: "print", rotate: "rotate", tenants: "tenants",
    remove: "remove", lease: "lease", rotated: "panel", removed: "tenants", saved: "tenants",
  };
  const key = view[0] ?? "", screen = screens[key];
  if (!screen || view.length > 2 || (view.length === 2 && !["remove", "lease"].includes(key)) ||
      (view[1] && !isUuid(view[1]))) throw new FlowError("errors.notFound");
  if (["panel", "qr", "print"].includes(screen)) await mutateStaffInvite(session, unitId, { action: "issue" });
  const data = await staffInviteData(session, unitId, screen === "lease");
  if (screen === "remove" && !data.bindings.some(b => b.id === view[1])) throw new FlowError("errors.forbidden");
  if (screen === "lease" && view[1] && !data.leases.some(l => l.id === view[1])) throw new FlowError("errors.forbidden");
  const opts: import("../lib/staff-invite").InviteOptions = {
    bindingId: screen === "remove" ? view[1] : undefined, leaseId: screen === "lease" ? view[1] : undefined,
    notice: key === "rotated" || key === "removed" || key === "saved" ? key : undefined,
  };
  return { data, screen, opts };
}
