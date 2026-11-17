import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";
import { acceptBind, currentInvite, currentRoomInvite, includeOnLease, issueInvite, issueRoomInvite, rotateInvite } from "./unit-line-invite";
import { mutateStaffInvite, requireStaffInviteRoom, staffInviteLive, staffRoomInviteEntries } from "./b040-staff-ui";
import { staffAllRoomInvites } from "./b102-room-invites";

// B-102 INV-ROOM (MGT-147) on a cloned disposable database: real gateways, real triggers. Synthetic data only.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });
test.beforeEach(async () => { await query("DELETE FROM app.unit_invite_attempts"); });

const isFlow = (key: string) => (e: unknown) => e instanceof FlowError && e.key === key;
const sqlCode = (code: string) => (e: unknown) => String((e as Error).message).includes(code);
async function flags(invite: boolean, v3: boolean) {
  await query(`INSERT INTO platform_settings(key, value) VALUES ('unit_line_invite', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(invite ? { enabled: true, allowed_org_ids: [ORG_ID] } : { enabled: false, allowed_org_ids: [] })]);
  await query(`UPDATE organizations SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || jsonb_build_object('unit_line_invite', $2::boolean, 'brand_v2', $3::boolean, 'brand_v3', $3::boolean) WHERE id = $1`, [ORG_ID, invite, v3]);
}
async function admin(): Promise<Session> {
  const sessionId = await withClient(c => insertTestAuthSession(c, USERS.admin));
  return { userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, kind: "staff", role: "admin", environment: "live",
    locale: "zh-TW", calendar: "gregorian", leaseId: null, email: "synthetic@example.test", name: "Synthetic" };
}
/** A by_room unit with rooms A, B, C (C archived) and a whole_unit unit, in a seed property of ORG_ID. */
async function fixture() {
  const { id: property, currency } = (await query<{ id: string; currency: string }>("SELECT id::text, currency::text FROM properties WHERE org_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1", [ORG_ID])).rows[0];
  const unit = (await query<{ id: string }>("INSERT INTO units(org_id, property_id, label, rental_mode) VALUES ($1,$2,$3,'by_room') RETURNING id::text", [ORG_ID, property, `B102-${randomUUID().slice(0, 8)}`])).rows[0].id;
  const whole = (await query<{ id: string }>("INSERT INTO units(org_id, property_id, label, rental_mode) VALUES ($1,$2,$3,'whole_unit') RETURNING id::text", [ORG_ID, property, `B102W-${randomUUID().slice(0, 8)}`])).rows[0].id;
  const room = async (label: string) => (await query<{ id: string }>("INSERT INTO rooms(org_id, unit_id, label) VALUES ($1,$2,$3) RETURNING id::text", [ORG_ID, unit, label])).rows[0].id;
  const a = await room("A"), b = await room("B"), c = await room("C");
  await query("UPDATE rooms SET archived_at = now() WHERE id = $1", [c]);
  const lease = async (roomId: string) => (await query<{ id: string }>(
    "INSERT INTO leases(org_id, property_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency, rent_amount_minor) VALUES ($1,$2,$3,$4,'active','imported','2090-01-01','2090-12-31',$5,0) RETURNING id::text",
    [ORG_ID, property, unit, roomId, currency])).rows[0].id;
  return { property, unit, whole, a, b, c, leaseA: await lease(a), leaseB: await lease(b) };
}
const accept = (unitId: string, token: string, n: number | string) => acceptBind({ orgId: ORG_ID, unitId, token, lineSub: `b102-${n}-${randomUUID()}`, displayName: `Synthetic ${n}` });
async function liveSecrets(unit: string) {
  return (await query<{ room_id: string | null }>("SELECT room_id::text FROM app.unit_invite_secrets WHERE unit_id = $1 AND revoked_at IS NULL ORDER BY room_id::text NULLS FIRST", [unit])).rows.map(r => r.room_id);
}

test("privileges: the room gateway is service-only; replaced functions keep service-only EXECUTE", async () => {
  for (const fn of ["app.unit_line_issue_room(uuid,uuid,uuid,text,uuid)", "app.unit_line_issue(uuid,uuid,text,uuid)", "app.unit_line_accept(uuid,uuid,text,uuid,text,text,text,uuid,text)", "app.unit_line_include_on_lease(uuid,uuid,uuid,uuid[])"])
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal((await query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') ok", [role, fn])).rows[0].ok, role === "service_role", `${role} ${fn}`);
});

test("MGT-147-AC1: one live invite per room, separate from the unit invite; unit issue/rotate never revoke a room's, and the unit reader never returns one", async () => {
  await flags(true, true);
  const staff = await admin(), f = await fixture();
  const ra = await issueRoomInvite(staff, f.unit, f.a), rb = await issueRoomInvite(staff, f.unit, f.b);
  assert.notEqual(ra.token, rb.token);
  assert.equal(await currentInvite(staff, f.unit), null, "the unit invite reader ignores room secrets");
  const unitInvite = await issueInvite(staff, f.unit);
  await rotateInvite(staff, f.unit);
  assert.deepEqual(await liveSecrets(f.unit), [null, ...[f.a, f.b].sort()], "one live unit invite and one per room");
  assert.equal((await currentRoomInvite(staff, f.unit, f.a))?.token, ra.token);
  assert.notEqual((await currentInvite(staff, f.unit))?.token, unitInvite.token, "rotate replaced the unit invite only");
  // Rotating a room replaces only that room's invite.
  const ra2 = await issueRoomInvite(staff, f.unit, f.a);
  assert.equal((await currentRoomInvite(staff, f.unit, f.a))?.token, ra2.token);
  assert.equal((await currentRoomInvite(staff, f.unit, f.b))?.token, rb.token);
  await assert.rejects(accept(f.unit, ra.token, "old"), isFlow("errors.revoked"));
});

test("gateway refusals: whole_unit unit, archived room, room of another unit, other org, flag OFF", async () => {
  await flags(true, true);
  const staff = await admin(), f = await fixture(), g = await fixture();
  await assert.rejects(issueRoomInvite(staff, f.whole, f.a), isFlow("errors.not_found"));
  await assert.rejects(issueRoomInvite(staff, f.unit, f.c), isFlow("errors.not_found"), "archived room");
  await assert.rejects(issueRoomInvite(staff, f.unit, g.a), isFlow("errors.not_found"), "room of another unit");
  const direct = (org: string) => withClient(c => c.query("SELECT app.unit_line_issue_room($1,$2,$3,$4,$5)", [org, f.unit, f.a, randomUUID().replace(/-/g, "").padEnd(64, "0"), USERS.admin]));
  await assert.rejects(direct(ORG2_ID), sqlCode("flag_off"), "another org has no invite flag");
  await flags(false, true);
  await assert.rejects(direct(ORG_ID), sqlCode("flag_off"));
  await assert.rejects(issueRoomInvite(staff, f.unit, f.a), isFlow("errors.notFound"));
  assert.equal((await query("SELECT 1 FROM app.unit_invite_secrets WHERE room_id IN ($1,$2)", [f.a, g.a])).rowCount, 0, "nothing written");
});

test("MGT-147-AC1/AC3: accepting a room invite binds that room; 4 seats per room, other rooms and the unit invite unaffected", async () => {
  await flags(true, true);
  const staff = await admin(), f = await fixture();
  const ra = await issueRoomInvite(staff, f.unit, f.a), rb = await issueRoomInvite(staff, f.unit, f.b), unit = await issueInvite(staff, f.unit);
  for (let i = 0; i < 4; i++) await accept(f.unit, ra.token, `a${i}`);
  await assert.rejects(accept(f.unit, ra.token, "a5"), isFlow("errors.seat_cap"));
  await accept(f.unit, rb.token, "b1");
  for (let i = 0; i < 4; i++) await accept(f.unit, unit.token, `u${i}`);
  const counts = (await query<{ room_id: string | null; n: string }>("SELECT room_id::text, count(*)::text n FROM app.unit_bindings WHERE unit_id = $1 AND status IN ('pending','lease_linked') GROUP BY room_id", [f.unit])).rows;
  assert.deepEqual(Object.fromEntries(counts.map(r => [r.room_id ?? "unit", r.n])), { [f.a]: "4", [f.b]: "1", unit: "4" });
  assert.equal((await currentRoomInvite(staff, f.unit, f.a))?.bound, 4);
  assert.equal((await currentRoomInvite(staff, f.unit, f.b))?.bound, 1);
  assert.equal((await currentInvite(staff, f.unit))?.bound, 4);
  // The DB trigger enforces the per-room cap on direct writes too.
  const b1 = (await query<{ id: string }>("SELECT id::text FROM app.unit_bindings WHERE unit_id = $1 AND room_id = $2", [f.unit, f.b])).rows[0].id;
  await assert.rejects(query("UPDATE app.unit_bindings SET room_id = $2 WHERE id = $1", [b1, f.a]), sqlCode("seat_cap"));
  // A room archived after its invite was issued stops accepting.
  await query("UPDATE rooms SET archived_at = now() WHERE id = $1", [f.b]);
  await assert.rejects(accept(f.unit, rb.token, "b2"), isFlow("errors.not_found"));
});

test("include: a room's tenants join only a lease of that room (room_mismatch, nothing written); the right lease links them", async () => {
  await flags(true, true);
  const staff = await admin(), f = await fixture();
  const ra = await issueRoomInvite(staff, f.unit, f.a);
  const bound = await accept(f.unit, ra.token, "inc");
  const parties = async () => (await query("SELECT 1 FROM lease_parties WHERE lease_id IN ($1,$2)", [f.leaseA, f.leaseB])).rowCount;
  const before = await parties();
  await assert.rejects(includeOnLease(staff, f.leaseB, f.unit, [bound.bindingId]), isFlow("errors.room_mismatch"));
  assert.equal(await parties(), before);
  assert.equal((await query<{ status: string }>("SELECT status::text FROM app.unit_bindings WHERE id = $1", [bound.bindingId])).rows[0].status, "pending");
  await includeOnLease(staff, f.leaseA, f.unit, [bound.bindingId]);
  assert.deepEqual((await query<{ status: string; lease_id: string }>("SELECT status::text, lease_id::text FROM app.unit_bindings WHERE id = $1", [bound.bindingId])).rows[0], { status: "lease_linked", lease_id: f.leaseA });
});

test("staff UI admission: room invites exist only under brand_v3 for live rooms of by_room units; panels and lists are per room", async () => {
  const staff = await admin(), f = await fixture();
  await flags(true, false);
  await assert.rejects(requireStaffInviteRoom(staff, f.a), isFlow("errors.notFound"), "brand_v3 OFF");
  assert.deepEqual(await staffRoomInviteEntries(staff, [{ id: f.a, kind: "room" }]), []);
  await assert.rejects(staffAllRoomInvites(staff, f.unit), isFlow("errors.notFound"));
  await flags(true, true);
  assert.deepEqual(await requireStaffInviteRoom(staff, f.a), { unitId: f.unit, propertyId: f.property });
  for (const bad of [f.c, randomUUID(), "not-a-uuid"]) await assert.rejects(requireStaffInviteRoom(staff, bad), isFlow("errors.notFound"), bad);
  await mutateStaffInvite(staff, f.unit, { action: "issue" }, f.a);
  const ra = await currentRoomInvite(staff, f.unit, f.a);
  await accept(f.unit, ra!.token, "ui");
  const live = await staffInviteLive(staff, f.unit, f.a);
  assert.equal(live.bindings.length, 1);
  assert.equal((await staffInviteLive(staff, f.unit, f.b)).bindings.length, 0, "another room's panel never shows this tenant");
  assert.equal((await staffInviteLive(staff, f.unit)).bindings.length, 0, "the unit panel never shows room tenants");
  const entries = await staffRoomInviteEntries(staff, [{ id: f.a, kind: "room" }, { id: f.b, kind: "room" }, { id: f.c, kind: "room" }, { id: f.whole, kind: "whole_unit" }]);
  assert.deepEqual(entries.map(e => [e.roomId, e.bound]), [[f.a, 1], [f.b, 0]]);
  const all = await staffAllRoomInvites(staff, f.unit);
  assert.deepEqual(all.rooms.map(r => r.label), ["A", "B"], "archived room C is not listed");
  assert.ok(all.rooms.every(r => /^\/join\/[A-Za-z0-9_-]{43}$/.test(r.path)));
  assert.equal(all.rooms[0].path, `/join/${ra!.token}`, "opening the list never replaces an existing room invite");
  await assert.rejects(staffAllRoomInvites(staff, f.whole), isFlow("errors.notFound"));
});
