import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";
import { ownerUnits, type OwnerUnitRow } from "./b092-owner-units";

// B-092 OWN-UNITS (OWN-33-AC1/AC4) on a cloned disposable database: the real gateway through service_role,
// PR-015 org-local current-owner admission, anon / cross-org / former-owner / non-owner denial. Synthetic data only.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });
const v3 = async () => true;
const FN = "app.b092_owner_units(uuid,uuid,text,uuid)";

async function person(org: string, owner = true) {
  const user = randomUUID();
  await query("INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')", [user, `${randomUUID()}@example.test`]);
  const sessionId = await withClient(c => insertTestAuthSession(c, user));
  const contact = (await query<{ id: string }>("INSERT INTO contacts(org_id,user_id,is_owner,display_name) VALUES($1,$2,$3,'Synthetic owner') RETURNING id::text", [org, user, owner])).rows[0].id;
  const s: Session = { userId: user, sessionId, orgId: org, liveOrgId: org, kind: "owner", role: null, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null, email: "", name: "Synthetic" };
  return { s, contact, user };
}
const today = async () => (await query<{ d: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date::text d")).rows[0].d;
async function own(property: string, contact: string, from = "2000-01-01", to: string | null = null) {
  await query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,effective_to) VALUES($1,$2,$3,$4::date,$5::date)", [ORG_ID, property, contact, from, to]);
}
async function tenant(name: string) {
  return (await query<{ id: string }>("INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,$2) RETURNING id::text", [ORG_ID, name])).rows[0].id;
}
/** A lease on a space with one invoice this month (property date) and an optional confirmed payment. */
async function leased(p: string, unit: string, room: string | null, opts: { total: number; confirmed: number; dueOffset: number; name: string }) {
  const l = (await query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$4,$5,'active','imported','2001-01-01','2099-12-31','TWD',$6) RETURNING id::text`, [ORG_ID, p, unit, room ? null : unit, room, opts.total])).rows[0].id;
  await query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')", [ORG_ID, l, await tenant(opts.name)]);
  const inv = (await query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,period_start,period_end,status)
    VALUES($1,$2,$3,$4,'TWD',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date + $5::int,
      date_trunc('month',(clock_timestamp() AT TIME ZONE 'Asia/Taipei'))::date,(date_trunc('month',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')) + interval '1 month - 1 day')::date,'open') RETURNING id::text`,
    [ORG_ID, p, l, randomUUID(), opts.dueOffset])).rows[0].id;
  await query("INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',$3::bigint,$3::bigint)", [ORG_ID, inv, opts.total]);
  if (opts.confirmed > 0) {
    const pay = (await query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,'TWD',$4,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date,'bank_transfer','confirmed','manager_entry',$5,now()) RETURNING id::text`, [ORG_ID, p, l, opts.confirmed, USERS.admin])).rows[0].id;
    await query("INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor) VALUES($1,$2,$3,$4)", [ORG_ID, pay, inv, opts.confirmed]);
  }
  return l;
}
async function fixture() {
  const p = (await query<{ id: string }>("INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text", [ORG_ID, `B092 ${randomUUID().slice(0, 6)}`])).rows[0].id;
  const unit = async (label: string, mode: "whole_unit" | "by_room") => (await query<{ id: string }>("INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,$4) RETURNING id::text", [ORG_ID, p, label, mode])).rows[0].id;
  const whole = await unit("1F", "whole_unit"), split = await unit("2F", "by_room");
  const room = async (label: string) => (await query<{ id: string }>("INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,$3) RETURNING id::text", [ORG_ID, split, label])).rows[0].id;
  const [ra, rb, rc, rd, re] = [await room("A"), await room("B"), await room("C"), await room("D"), await room("E")];
  await query("UPDATE rooms SET archived_at = now() WHERE id = $1", [re]);
  await leased(p, whole, null, { total: 1850000, confirmed: 1850000, dueOffset: 3, name: "陳怡君" });
  await leased(p, split, ra, { total: 1500000, confirmed: 400000, dueOffset: 5, name: "周小姐" });
  await leased(p, split, rb, { total: 2400000, confirmed: 0, dueOffset: -1, name: "王小明" });
  await leased(p, split, rc, { total: 1000000, confirmed: 0, dueOffset: 5, name: "林先生" });
  // Room D: vacant since a lease ended ten days ago on the property's date.
  await query(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$4,'ended','imported','2001-01-01',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date - 10,'TWD',1)`, [ORG_ID, p, split, rd]);
  return { p, whole, split, ra, rb, rc, rd, re };
}
const pick = (rows: OwnerUnitRow[], unit: string, room: string | null) => rows.find(r => r.unitId === unit && r.roomId === room);

test("privileges: service-only definer; anon/authenticated cannot execute", async () => {
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await query<{ ok: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, FN])).rows[0].ok, role === "service_role", role);
  assert.deepEqual((await query("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = $1::regprocedure", [FN])).rows[0],
    { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
});

test("OWN-33-AC1: one line per authorised space with tenant, rent and this month's status on the property's date", async () => {
  const f = await fixture(), o = await person(ORG_ID);
  await own(f.p, o.contact);
  const res = await ownerUnits(o.s, { v3 });
  assert.equal(res.state, "ready"); if (res.state !== "ready") return;
  const rows = res.rows.filter(r => r.propertyId === f.p);
  assert.deepEqual(rows.map(r => r.space), ["1F", "2F A", "2F B", "2F C", "2F D"], "archived room E is absent");
  assert.deepEqual(pick(rows, f.whole, null), { propertyId: f.p, property: rows[0].property, unitId: f.whole, roomId: null, space: "1F", tenant: "陳怡君", rentMinor: "1850000", currency: "TWD", status: "paid", remainingMinor: null, vacantDays: null });
  assert.deepEqual([pick(rows, f.split, f.ra)?.status, pick(rows, f.split, f.ra)?.remainingMinor], ["partial", "1100000"]);
  assert.equal(pick(rows, f.split, f.rb)?.status, "overdue");
  assert.equal(pick(rows, f.split, f.rc)?.status, "none", "not yet due and nothing confirmed: no status wording");
  assert.deepEqual([pick(rows, f.split, f.rd)?.status, pick(rows, f.split, f.rd)?.vacantDays, pick(rows, f.split, f.rd)?.tenant, pick(rows, f.split, f.rd)?.rentMinor], ["vacant", 10, null, null]);
  assert.ok(!JSON.stringify(res.rows).includes("phone"), "never a phone field");
});

test("MGT-138: with the company's name switch off every row reads 「租客」 (tenant null), never a partial mix", async () => {
  const f = await fixture(), o = await person(ORG_ID);
  await own(f.p, o.contact);
  await query("UPDATE organizations SET settings = coalesce(settings,'{}'::jsonb) || '{\"show_tenant_name\":false}'::jsonb WHERE id = $1", [ORG_ID]);
  try {
    const res = await ownerUnits(o.s, { v3 });
    assert.equal(res.state, "ready"); if (res.state !== "ready") return;
    assert.ok(res.rows.length > 0 && res.rows.every(r => r.tenant === null));
  } finally {
    await query("UPDATE organizations SET settings = settings - 'show_tenant_name' WHERE id = $1", [ORG_ID]);
  }
});

test("OWN-33-AC4 / PR-015: former, future and archived owners, non-owner contacts and other properties see nothing of this property", async () => {
  const f = await fixture(), g = await fixture();
  const current = await person(ORG_ID), former = await person(ORG_ID), future = await person(ORG_ID), archived = await person(ORG_ID), notOwner = await person(ORG_ID, false);
  const d = await today();
  await own(f.p, current.contact);
  await own(g.p, former.contact, "2000-01-01", d);
  await own(g.p, future.contact, "2099-01-01");
  await own(g.p, archived.contact); await query("UPDATE contacts SET archived_at = now() WHERE id = $1", [archived.contact]);
  await own(g.p, notOwner.contact);
  const mine = await ownerUnits(current.s, { v3 });
  assert.equal(mine.state, "ready"); if (mine.state !== "ready") return;
  assert.ok(mine.rows.every(r => r.propertyId !== g.p), "another owner's property is absent");
  for (const who of [former, future, archived, notOwner]) {
    const res = await ownerUnits(who.s, { v3 });
    assert.ok(res.state === "forbidden" || (res.state === "ready" && res.rows.every(r => r.propertyId !== g.p)), JSON.stringify(res));
  }
});

test("denial: anon (no session), revoked session, another org's owner, staff, and a wrong env/org tuple", async () => {
  const f = await fixture(), o = await person(ORG_ID), other = await person(ORG2_ID);
  await own(f.p, o.contact);
  const revoked = { ...o.s, sessionId: await withClient(c => insertTestAuthSession(c, o.user)) };
  await query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1", [revoked.sessionId]);
  assert.equal((await ownerUnits(revoked, { v3 })).state, "forbidden");
  assert.equal((await ownerUnits({ ...o.s, sessionId: randomUUID() }, { v3 })).state, "forbidden", "unknown session");
  assert.equal((await ownerUnits({ ...other.s, orgId: ORG_ID, liveOrgId: ORG_ID }, { v3 })).state, "forbidden", "another org's owner pointed at this org");
  const staff = { ...o.s, userId: USERS.admin, sessionId: await withClient(c => insertTestAuthSession(c, USERS.admin)), kind: "staff" as const, role: "admin" as const };
  assert.equal((await ownerUnits(staff, { v3 })).state, "forbidden");
  assert.equal((await ownerUnits(o.s, { v3: async () => false })).state, "off");
  // Direct gateway: the pinned org/env must match the arguments.
  await assert.rejects(withClient(async c => { await c.query("BEGIN"); try {
    await c.query("SET LOCAL ROLE service_role"); await c.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG2_ID]);
    await c.query(`SELECT ${FN.replace("(uuid,uuid,text,uuid)", "")}($1,$1,'live',$2)`, [ORG_ID, o.s.sessionId]);
  } finally { await c.query("ROLLBACK"); } }), (e: unknown) => (e as { code?: string }).code === "42501");
});
