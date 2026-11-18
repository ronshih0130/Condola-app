import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";
import { ownerUnit } from "./b092-owner-unit";

// B-092 RO-UNIT (OWN-33-AC2/AC4) on a cloned disposable database: the real gateway through service_role, PR-015
// org-local current-owner admission, unauthorised-space refusal (42501), the name/phone switches, the six-month
// window on the property's date and the open-repair scope. Synthetic data only.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });
const v3 = async () => true;
const FN = "app.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid)";
const TODAY = "(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date";
const MONTH = (k: number) => `(date_trunc('month',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')) - interval '${k} months')::date`;
const monthKey = async (k: number) => (await query<{ m: string }>(`SELECT to_char(${MONTH(k)},'YYYY-MM') m`)).rows[0].m;

async function person(org: string, owner = true) {
  const user = randomUUID();
  await query("INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')", [user, `${randomUUID()}@example.test`]);
  const sessionId = await withClient(c => insertTestAuthSession(c, user));
  const contact = (await query<{ id: string }>("INSERT INTO contacts(org_id,user_id,is_owner,display_name) VALUES($1,$2,$3,'Synthetic owner') RETURNING id::text", [org, user, owner])).rows[0].id;
  const s: Session = { userId: user, sessionId, orgId: org, liveOrgId: org, kind: "owner", role: null, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null, email: "", name: "Synthetic" };
  return { s, contact, user };
}
async function own(property: string, contact: string, opts: { from?: string; to?: string | null; phone?: boolean } = {}) {
  await query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,effective_to,can_view_tenant_phone) VALUES($1,$2,$3,$4::date,$5::date,$6)",
    [ORG_ID, property, contact, opts.from ?? "2000-01-01", opts.to ?? null, opts.phone ?? false]);
}
async function lease(p: string, unit: string, room: string | null, opts: { name: string; status?: string; start?: string; end?: string } ) {
  const l = (await query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$4,$5,$6,'imported',$7::date,$8::date,'TWD',1850000) RETURNING id::text`,
    [ORG_ID, p, unit, room ? null : unit, room, opts.status ?? "active", opts.start ?? "2001-01-01", opts.end ?? "2099-12-31"])).rows[0].id;
  const phone = `+8869${String(randomInt(10_000_000, 99_999_999))}`;
  const tenant = (await query<{ id: string }>("INSERT INTO contacts(org_id,is_tenant,display_name,phone_e164) VALUES($1,true,$2,$3) RETURNING id::text", [ORG_ID, opts.name, phone])).rows[0].id;
  await query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')", [ORG_ID, l, tenant]);
  return { id: l, phone };
}
/** One invoice for the month k months before this one (property date), due `dueOffset` days from today. */
async function invoice(p: string, l: string, k: number, opts: { total: number; confirmed?: number; dueOffset: number; status?: string }) {
  const inv = (await query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,period_start,period_end,status)
    VALUES($1,$2,$3,$4,'TWD',${TODAY} + $5::int,${MONTH(k)},(${MONTH(k)} + interval '1 month - 1 day')::date,$6) RETURNING id::text`,
    [ORG_ID, p, l, randomUUID(), opts.dueOffset, opts.status ?? "open"])).rows[0].id;
  await query("INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',$3::bigint,$3::bigint)", [ORG_ID, inv, opts.total]);
  if (opts.confirmed) {
    const pay = (await query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,'TWD',$4,${TODAY},'bank_transfer','confirmed','manager_entry',$5,now()) RETURNING id::text`, [ORG_ID, p, l, opts.confirmed, USERS.admin])).rows[0].id;
    await query("INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor) VALUES($1,$2,$3,$4)", [ORG_ID, pay, inv, opts.confirmed]);
  }
}
async function ticket(p: string, unit: string | null, room: string | null, title: string, status: string, ageDays: number) {
  return (await query<{ id: string }>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,unit_id,room_id,status,title,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now() - make_interval(days => $8)) RETURNING id::text`,
    [ORG_ID, randomInt(1_000_000, 2_000_000_000), p, unit, room, status, title, ageDays])).rows[0].id;
}
async function fixture() {
  const p = (await query<{ id: string }>("INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text", [ORG_ID, `B092U ${randomUUID().slice(0, 6)}`])).rows[0].id;
  const unit = async (label: string, mode: "whole_unit" | "by_room") => (await query<{ id: string }>("INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,$4) RETURNING id::text", [ORG_ID, p, label, mode])).rows[0].id;
  const whole = await unit("1F", "whole_unit"), split = await unit("2F", "by_room");
  const room = async (label: string) => (await query<{ id: string }>("INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,$3) RETURNING id::text", [ORG_ID, split, label])).rows[0].id;
  const [ra, rb, rx] = [await room("A"), await room("B"), await room("X")];
  await query("UPDATE rooms SET archived_at = now() WHERE id = $1", [rx]);
  const lw = await lease(p, whole, null, { name: "陳怡君" });
  const la = await lease(p, split, ra, { name: "周小姐" });
  return { p, whole, split, ra, rb, rx, lw, la };
}

test("privileges: service-only definer; anon/authenticated cannot execute", async () => {
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await query<{ ok: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, FN])).rows[0].ok, role === "service_role", role);
  assert.deepEqual((await query("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = $1::regprocedure", [FN])).rows[0],
    { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
});

test("OWN-33-AC2: whole unit — tenant, term, rent; six-month window on the property's date; current lease only", async () => {
  const f = await fixture(), o = await person(ORG_ID);
  await own(f.p, o.contact);
  await invoice(f.p, f.lw.id, 0, { total: 1000000, confirmed: 400000, dueOffset: 5 });  // partial
  await invoice(f.p, f.lw.id, 1, { total: 1000000, confirmed: 1000000, dueOffset: -20 }); // paid
  await invoice(f.p, f.lw.id, 2, { total: 1000000, confirmed: 300000, dueOffset: -40 });  // overdue (no remaining)
  await invoice(f.p, f.lw.id, 3, { total: 1000000, dueOffset: -60, status: "draft" });    // draft: month absent
  await invoice(f.p, f.lw.id, 5, { total: 1000000, dueOffset: 10 });                      // nothing confirmed, not due: none
  await invoice(f.p, f.lw.id, 6, { total: 1000000, confirmed: 1000000, dueOffset: -150 }); // outside the window
  await invoice(f.p, f.lw.id, -1, { total: 1000000, dueOffset: 30 });                     // next month: outside the window
  // Another (ended) lease of the same unit, and the room's lease: their invoices never show here.
  const old = await lease(f.p, f.whole, null, { name: "前租客", status: "ended", start: "2000-01-01", end: "2000-12-31" });
  await invoice(f.p, old.id, 4, { total: 1000000, dueOffset: -90 });
  await invoice(f.p, f.la.id, 4, { total: 1000000, dueOffset: -90 });
  const res = await ownerUnit(o.s, f.whole, null, { v3 });
  assert.equal(res.state, "ready", JSON.stringify(res)); if (res.state !== "ready") return;
  const u = res.unit;
  assert.deepEqual([u.space, u.vacant, u.tenant, u.phone, u.startDate, u.endDate, u.rentMinor, u.currency], ["1F", false, "陳怡君", null, "2001-01-01", "2099-12-31", "1850000", "TWD"]);
  assert.deepEqual(u.months, [
    { month: await monthKey(0), status: "partial", remainingMinor: "600000" },
    { month: await monthKey(1), status: "paid", remainingMinor: null },
    { month: await monthKey(2), status: "overdue", remainingMinor: null },
    { month: await monthKey(5), status: "none", remainingMinor: null },
  ]);
  assert.ok(!/email|@/.test(JSON.stringify(u)), "never an email");
});

test("OWN-33-AC2: room panel; open repairs only (max five, newest first) of this space; vacant room", async () => {
  const f = await fixture(), o = await person(ORG_ID);
  await own(f.p, o.contact);
  const keep = [];
  for (let i = 0; i < 6; i++) keep.push(await ticket(f.p, f.whole, null, `Synthetic whole ${i}`, ["open", "triaged", "assigned", "in_progress", "on_hold", "open"][i], i + 1));
  for (const st of ["resolved", "closed", "cancelled"]) await ticket(f.p, f.whole, null, `Done ${st}`, st, 0);
  const roomOpen = await ticket(f.p, f.split, f.ra, "Synthetic room A", "assigned", 2);
  await ticket(f.p, f.split, f.rb, "Synthetic room B", "open", 1);
  await ticket(f.p, f.split, null, "Synthetic 2F common", "open", 1);
  await ticket(f.p, f.split, f.ra, "Room A resolved", "resolved", 0);
  const whole = await ownerUnit(o.s, f.whole, null, { v3 });
  assert.equal(whole.state, "ready"); if (whole.state !== "ready") return;
  assert.deepEqual(whole.unit.repairs.map(r => r.id), keep.slice(0, 5), "newest five open tickets of the whole unit only");
  assert.deepEqual(whole.unit.repairs.map(r => r.status), ["open", "triaged", "assigned", "in_progress", "on_hold"]);
  const room = await ownerUnit(o.s, f.split, f.ra, { v3 });
  assert.equal(room.state, "ready"); if (room.state !== "ready") return;
  assert.deepEqual([room.unit.space, room.unit.tenant, room.unit.vacant], ["2F A", "周小姐", false]);
  assert.deepEqual(room.unit.repairs, [{ id: roomOpen, title: "Synthetic room A", status: "assigned" }], "only this room's open ticket");
  const vacant = await ownerUnit(o.s, f.split, f.rb, { v3 });
  assert.deepEqual(vacant, { state: "ready", unit: { property: room.unit.property, space: "2F B", vacant: true, tenant: null, phone: null,
    startDate: null, endDate: null, rentMinor: null, currency: null, months: [], repairs: [] } });
});

test("MGT-138 / phone rule: name hidden → tenant null; phone only when the company switch AND the owner's row allow it", async () => {
  const f = await fixture(), o = await person(ORG_ID);
  await own(f.p, o.contact);
  const original = (await query<{ s: unknown }>("SELECT settings s FROM organizations WHERE id = $1", [ORG_ID])).rows[0].s;
  const set = async (patch: Record<string, boolean>) =>
    query("UPDATE organizations SET settings = (coalesce(settings,'{}'::jsonb) - 'show_tenant_name' - 'show_tenant_phone') || $2::jsonb WHERE id = $1", [ORG_ID, JSON.stringify(patch)]);
  const row = async (can: boolean) => query("UPDATE property_owners SET can_view_tenant_phone = $2 WHERE property_id = $1", [f.p, can]);
  const read = async () => { const r = await ownerUnit(o.s, f.whole, null, { v3 }); assert.equal(r.state, "ready"); return r.state === "ready" ? r.unit : null; };
  try {
    await set({ show_tenant_name: false });
    assert.equal((await read())?.tenant, null);
    await set({ show_tenant_phone: true }); await row(true);
    assert.deepEqual([(await read())?.phone, (await read())?.tenant], [f.lw.phone, "陳怡君"], "both switches on");
    await set({ show_tenant_phone: true }); await row(false);
    assert.equal((await read())?.phone, null, "company on, owner row off");
    await set({ show_tenant_phone: false }); await row(true);
    assert.equal((await read())?.phone, null, "company off, owner row on");
    await set({}); await row(true);
    assert.equal((await read())?.phone, null, "company default (unset) is off");
  } finally {
    await query("UPDATE organizations SET settings = $2::jsonb WHERE id = $1", [ORG_ID, original === null ? null : JSON.stringify(original)]);
  }
});

test("OWN-33-AC4 / PR-015: unauthorised spaces are forbidden — another owner's unit, wrong shape, archived room, former / non / other-org owners", async () => {
  const f = await fixture(), g = await fixture();
  const o = await person(ORG_ID);
  await own(f.p, o.contact);
  assert.equal((await ownerUnit(o.s, g.whole, null, { v3 })).state, "forbidden", "another property's unit");
  assert.equal((await ownerUnit(o.s, f.whole, f.ra, { v3 })).state, "forbidden", "a whole unit with a room");
  assert.equal((await ownerUnit(o.s, f.split, null, { v3 })).state, "forbidden", "a by_room unit without a room");
  assert.equal((await ownerUnit(o.s, f.split, f.rx, { v3 })).state, "forbidden", "an archived room");
  assert.equal((await ownerUnit(o.s, f.split, g.ra, { v3 })).state, "forbidden", "a room of another unit");
  assert.equal((await ownerUnit(o.s, randomUUID(), null, { v3 })).state, "forbidden", "an unknown unit");
  const today = (await query<{ d: string }>(`SELECT ${TODAY}::text d`)).rows[0].d;
  const former = await person(ORG_ID), future = await person(ORG_ID), notOwner = await person(ORG_ID, false);
  await own(g.p, former.contact, { to: today }); await own(g.p, future.contact, { from: "2099-01-01" }); await own(g.p, notOwner.contact);
  for (const who of [former, future, notOwner]) assert.equal((await ownerUnit(who.s, g.whole, null, { v3 })).state, "forbidden");
  // Another org's owner: admitted in its own org (ORG2), never for this org's unit.
  const other = await person(ORG2_ID);
  const p2 = (await query<{ id: string }>("INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'B092U coast','TW','TWD','Asia/Taipei') RETURNING id::text", [ORG2_ID])).rows[0].id;
  const u2 = (await query<{ id: string }>("INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'C1','whole_unit') RETURNING id::text", [ORG2_ID, p2])).rows[0].id;
  await query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,'2000-01-01')", [ORG2_ID, p2, other.contact]);
  const mine = await ownerUnit(other.s, u2, null, { v3 });
  assert.deepEqual([mine.state, mine.state === "ready" && mine.unit.vacant], ["ready", true], "its own vacant unit is readable");
  assert.equal((await ownerUnit(other.s, f.whole, null, { v3 })).state, "forbidden", "this org's unit from ORG2");
  assert.equal((await ownerUnit({ ...other.s, orgId: ORG_ID, liveOrgId: ORG_ID }, f.whole, null, { v3 })).state, "forbidden", "pointed at this org");
  const staff = { ...o.s, userId: USERS.admin, sessionId: await withClient(c => insertTestAuthSession(c, USERS.admin)), kind: "staff" as const, role: "admin" as const };
  assert.equal((await ownerUnit(staff, f.whole, null, { v3 })).state, "forbidden");
  assert.equal((await ownerUnit(o.s, f.whole, null, { v3: async () => false })).state, "off");
  // Direct gateway: a unit the actor does not own is 42501 (403), not an empty object.
  await assert.rejects(withClient(async c => { await c.query("BEGIN"); try {
    await c.query("SET LOCAL ROLE service_role"); await c.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await c.query("SELECT app.b092_owner_unit($1,$1,'live',$2,$3,NULL)", [ORG_ID, o.s.sessionId, g.whole]);
  } finally { await c.query("ROLLBACK"); } }), (e: unknown) => (e as { code?: string }).code === "42501");
});
