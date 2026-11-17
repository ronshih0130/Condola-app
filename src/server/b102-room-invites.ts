import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { requireStaffInviteRoom, requireStaffInviteUnit, mutateStaffInvite } from "./b040-staff-ui";
import { brandV3ReadForOrg } from "./brand-v3";
import { tx } from "./db";
import { FlowError } from "./errors";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { currentRoomInvite, staffCanManage, unitLineInviteOn } from "./unit-line-invite";

/**
 * B-102 INV-ROOM (MGT-147-AC2, FE-ROOMINV): 「一次邀請全部房間」 lists every live room of one by_room unit with its own
 * invite link, for the manager to copy or print. Nothing is sent. Like the M4 panel, opening the list issues a
 * room's invite when it has none. brand_v3 only; anything else is a 404.
 */
export type RoomInviteLine = { roomId: string; label: string; path: string };
export async function staffAllRoomInvites(session: Session, unitId: string): Promise<{ unitLabel: string; rooms: RoomInviteLine[] }> {
  if (!staffCanManage(session)) throw new FlowError("errors.forbidden");
  session = await guardEffectiveSession(session, "leases.edit");
  if (!(await unitLineInviteOn(session.orgId)) || !(await brandV3ReadForOrg(session.orgId)) || !isUuid(unitId)) throw new FlowError("errors.notFound");
  await requireStaffInviteUnit(session, unitId);
  const unit = await tx(session.userId, c => withEffectiveAuthority(c, session, "leases.edit", async () => {
    const u = await c.query<{ label: string }>("SELECT label FROM public.units WHERE org_id = $1 AND id = $2 AND rental_mode = 'by_room' AND archived_at IS NULL", [session.orgId, unitId]);
    if (u.rowCount !== 1) return null;
    const rooms = await c.query<{ id: string; label: string }>(
      "SELECT id::text, label FROM public.rooms WHERE org_id = $1 AND unit_id = $2 AND archived_at IS NULL ORDER BY label, id", [session.orgId, unitId]);
    return { label: u.rows[0].label, rooms: rooms.rows };
  }), { orgId: session.orgId, environment: session.environment }, { readOnly: true });
  if (!unit) throw new FlowError("errors.notFound");
  const lines: RoomInviteLine[] = [];
  for (const room of unit.rooms) {
    // Each room is admitted on its own (live room of this live by_room unit) before its invite is issued or read.
    const target = await requireStaffInviteRoom(session, room.id);
    if (target.unitId !== unitId) throw new FlowError("errors.notFound");
    await mutateStaffInvite(session, unitId, { action: "issue" }, room.id);
    const invite = await currentRoomInvite(session, unitId, room.id);
    if (!invite) throw new Error("room invite missing after issue");
    lines.push({ roomId: room.id, label: room.label, path: invite.path });
  }
  return { unitLabel: unit.label, rooms: lines };
}
