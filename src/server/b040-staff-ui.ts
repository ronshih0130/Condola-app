import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { loadFirmNoticeContact } from "./id-docs";
import { FlowError } from "./errors";
import { can } from "./perms";
import { archiveAncestry, admitLeaseArchiveAncestry } from "./record-archive-admission";
import { listLeases, propertyDetail, type SpaceRow } from "./queries";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { brandV3ReadForOrg } from "./brand-v3";
import { currentInvite, currentRoomInvite, ensureRoomInvite, existingLoginHash, hashInviteToken, includeOnLease, issueInvite, issueRoomInvite, listBindings, removeBinding, rotateInvite, staffCanManage, unitLineInviteOn } from "./unit-line-invite";

export type InviteBinding = { id: string; name: string; displayName: string; method: "line" | "email"; joinedAt: string; joinedAtLabel?: string; pending: boolean };
export type StaffInviteData = {
  unitId: string; roomId?: string | null; firm: string; place: string; locale: Session["locale"];
  invite: { path: string; expiresAt: string; fingerprint: string } | null;
  bindings: InviteBinding[];
  leases: { id: string; label: string }[];
};
export { staffInvitePath, staffRoomInvitePath } from "../lib/staff-invite";

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

/**
 * B-102 INV-ROOM (MGT-147): a room invite exists only under brand_v3, for a live room of a live by_room unit. The
 * room id is the only input; the unit comes from the room's own ancestry. Anything else is a 404 (not a 403), so
 * room invites stay invisible while the flag is OFF.
 */
export async function requireStaffInviteRoom(session: Session, roomId: string): Promise<{ unitId: string; propertyId: string }> {
  if (!staffCanManage(session)) throw new FlowError("errors.forbidden");
  session = await guardEffectiveSession(session, "leases.edit");
  if (!(await unitLineInviteOn(session.orgId)) || !(await brandV3ReadForOrg(session.orgId))) throw new FlowError("errors.notFound");
  if (!isUuid(roomId)) throw new FlowError("errors.notFound");
  const target = await tx(session.userId, c => withEffectiveAuthority(c, session, "leases.edit", async () => {
    const a = await archiveAncestry(c, session.orgId, { kind: "room", id: roomId });
    if (!a.unitId || a.propertyArchived || a.unitArchived || a.roomArchived || a.mode !== "by_room") return null;
    return { unitId: a.unitId, propertyId: a.propertyId };
  }), { orgId: session.orgId, environment: session.environment }, { readOnly: true }).catch(error => {
    if (error instanceof FlowError && error.key === "errors.notFound") return null;
    throw error;
  });
  if (!target) throw new FlowError("errors.notFound");
  await requireStaffInviteUnit(session, target.unitId);
  return target;
}

/** B-102: R2-PROP room rows of by_room units, each with its own invite (bound counts are per room). */
export async function staffRoomInviteEntries(session: Session, rows: Pick<SpaceRow, "id" | "kind">[]) {
  session = await guardEffectiveSession(session, "leases.edit");
  if (!await staffInviteVisible(session) || !(await brandV3ReadForOrg(session.orgId))) return [];
  const result: { rowId: string; unitId: string; roomId: string; bound: number; expiresAt: string | null }[] = [];
  for (const row of rows.filter(r => r.kind === "room")) {
    let target: { unitId: string } | null = null;
    try { target = await requireStaffInviteRoom(session, row.id); }
    catch (error) { if (error instanceof FlowError && (error.key === "errors.notFound" || error.key === "errors.forbidden")) continue; throw error; }
    const invite = await currentRoomInvite(session, target.unitId, row.id);
    result.push({ rowId: row.id, unitId: target.unitId, roomId: row.id, bound: invite?.bound ?? 0, expiresAt: invite?.expires_at.toISOString() ?? null });
  }
  return result;
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

export async function staffInviteLive(session: Session, unitId: string, roomId: string | null = null) {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  const invite = roomId ? await currentRoomInvite(session, unitId, roomId) : await currentInvite(session, unitId);
  const rows = await listBindings(session, unitId);
  // B-102: a target's tenants are its own bindings only (room bindings per room; unit bindings have no room).
  const bindings: InviteBinding[] = rows.filter(r => (r.status === "pending" || r.status === "lease_linked") && (r.room_id ?? null) === roomId).map(r => ({
    id: String(r.id), name: String(r.entered_name || r.display_name || ""), displayName: String(r.display_name || ""),
    method: r.line_identity_hash === existingLoginHash(String(r.user_id)) ? "email" : "line",
    joinedAt: new Date(String(r.bound_at)).toISOString(), pending: r.status === "pending",
  }));
  return { bindings, bound: bindings.length, cap: 4,
    expiresAt: invite?.expires_at.toISOString() ?? null,
    fingerprint: invite ? hashInviteToken(invite.token) : null };
}

async function unitLeases(session: Session, unitId: string, roomId: string | null = null) {
  const leases = (await listLeases(session)).filter(l => l.status === "active" || l.status === "pending_signature");
  return tx(session.userId, async c => withEffectiveAuthority(c, session, "leases.edit", async () => {
    const result: StaffInviteData["leases"] = [];
    for (const lease of leases) {
      // The existing admission checks org, unit/room ancestry and archive state.
      try {
        const target = await admitLeaseArchiveAncestry(c, session.orgId, lease.id);
        // B-102: a room's tenants join only a lease that targets that room (the SQL refuses any other: room_mismatch).
        if (target.unit_id === unitId && (roomId === null || target.target_room_id === roomId)) result.push({ id: lease.id, label: `${lease.place} · ${lease.start_date}${lease.end_date ? ` — ${lease.end_date}` : ""}` });
      } catch (error) { if (!(error instanceof FlowError && error.key === "errors.notFound")) throw error; }
    }
    return result;
  }), { orgId: session.orgId, environment: session.environment });
}

export async function staffInviteData(session: Session, unitId: string, withLeases = false, roomId: string | null = null): Promise<StaffInviteData> {
  session = await guardEffectiveSession(session, "leases.edit");
  const unit = await requireStaffInviteUnit(session, unitId);
  const property = await propertyDetail(session, unit.propertyId);
  const label = [...(property?.wholes ?? []), ...(property?.byRoomUnits ?? [])].find(u => u.id === unitId)?.label;
  const room = roomId ? property?.rooms.find(r => r.id === roomId) : undefined;
  if (!property || label === undefined || (roomId && !room)) throw new FlowError("errors.forbidden");
  const firm = await loadFirmNoticeContact(session);
  const live = await staffInviteLive(session, unitId, roomId);
  const invite = roomId ? await currentRoomInvite(session, unitId, roomId) : await currentInvite(session, unitId);
  return { unitId, roomId, firm: firm.name, place: room ? `${property.property.name} ${label} ${room.label}` : `${property.property.name} ${label}`, locale: session.locale,
    invite: invite ? { path: invite.path, expiresAt: invite.expires_at.toISOString(), fingerprint: hashInviteToken(invite.token) } : null,
    bindings: live.bindings.map(binding => ({ ...binding, joinedAtLabel: new Intl.DateTimeFormat(session.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(binding.joinedAt)) })), leases: withLeases ? await unitLeases(session, unitId, roomId) : [] };
}

export type StaffInviteCommand = { action: "issue" | "rotate" | "remove" | "include"; bindingId?: string; bindingIds?: string[]; leaseId?: string };
export async function mutateStaffInvite(session: Session, unitId: string, input: StaffInviteCommand, roomId: string | null = null): Promise<void> {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  const current = () => roomId ? currentRoomInvite(session, unitId, roomId) : currentInvite(session, unitId);
  if (input.action === "issue") {
    // B-102: a room's get-or-create is atomic in SQL, so concurrent openings never revoke each other's link.
    if (roomId) await ensureRoomInvite(session, unitId, roomId);
    else if (!await current()) {
      try { await issueInvite(session, unitId); }
      catch (error) { if (!await current()) throw error; }
    }
  } else if (input.action === "rotate") {
    if (roomId) await issueRoomInvite(session, unitId, roomId); else await rotateInvite(session, unitId);
  } else if (input.action === "remove" || input.action === "include") {
    const bindings = await listBindings(session, unitId);
    const active = bindings.filter(b => (b.status === "pending" || b.status === "lease_linked") && (b.room_id ?? null) === roomId);
    if (input.action === "remove") {
      if (!active.some(b => b.id === input.bindingId)) throw new FlowError("errors.forbidden");
      await removeBinding(session, input.bindingId!);
    } else {
      const ids = input.bindingIds;
      if (!isUuid(input.leaseId ?? "") || !Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length ||
          ids.some(id => !isUuid(id) || !active.some(b => b.id === id && b.status === "pending"))) throw new FlowError("errors.forbidden");
      const leases = await unitLeases(session, unitId, roomId);
      if (!leases.some(l => l.id === input.leaseId)) throw new FlowError("errors.forbidden");
      // The existing SQL function repeats org/unit/lease checks under the unit lock.
      await includeOnLease(session, input.leaseId!, unitId, ids);
    }
  } else throw new FlowError("errors.invalid");
}

/** Shared page/API loader. Authorization precedes any automatic issuance. */
export async function staffInvitePage(session: Session, unitId: string, view: string[], roomId: string | null = null) {
  session = await guardEffectiveSession(session, "leases.edit");
  await requireStaffInviteUnit(session, unitId);
  const screens: Record<string, import("../lib/staff-invite").InviteScreen> = {
    "": "panel", qr: "qr", print: "print", rotate: "rotate", tenants: "tenants",
    remove: "remove", lease: "lease", rotated: "panel", removed: "tenants", saved: "tenants",
  };
  const key = view[0] ?? "", screen = screens[key];
  if (!screen || view.length > 2 || (view.length === 2 && !["remove", "lease"].includes(key)) ||
      (view[1] && !isUuid(view[1]))) throw new FlowError("errors.notFound");
  if (["panel", "qr", "print"].includes(screen)) await mutateStaffInvite(session, unitId, { action: "issue" }, roomId);
  const data = await staffInviteData(session, unitId, screen === "lease", roomId);
  if (screen === "remove" && !data.bindings.some(b => b.id === view[1])) throw new FlowError("errors.forbidden");
  if (screen === "lease" && view[1] && !data.leases.some(l => l.id === view[1])) throw new FlowError("errors.forbidden");
  const opts: import("../lib/staff-invite").InviteOptions = {
    bindingId: screen === "remove" ? view[1] : undefined, leaseId: screen === "lease" ? view[1] : undefined,
    notice: key === "rotated" || key === "removed" || key === "saved" ? key : undefined,
  };
  return { data, screen, opts };
}

/** B-102: the room page loader; the room id alone decides the unit. */
export async function staffRoomInvitePage(session: Session, roomId: string, view: string[]) {
  session = await guardEffectiveSession(session, "leases.edit");
  const { unitId } = await requireStaffInviteRoom(session, roomId);
  return staffInvitePage(session, unitId, view, roomId);
}
