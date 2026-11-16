import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { brandLease, brandLeases, type LeasesInput } from "./b3-leases";
import { leaseDetail, searchLeases } from "./queries";
import { FlowError } from "./errors";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Mac only: clone the fully migrated local disposable DB. No migration, seed,
// transport or provider runs. Fixture rows exist solely in the disposable clone.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
const saved = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
// 2030-06-01 in America/Los_Angeles (the fixture property's calendar).
const ON = { v3: async () => true, now: () => new Date("2030-06-01T19:00:00.000Z") };
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
test.before(async () => {
  clone = await cloneTestDatabase(); process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
test.after(async () => {
  await db?.end(); await clone?.cleanup();
  if (saved === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = saved;
});
type Role = "admin" | "manager" | "accountant" | "maintenance";
async function fixture(name: string) {
  const org = (await db.query(`INSERT INTO organizations(name,country_code,default_currency,timezone)
    VALUES($1,'US','USD','America/Los_Angeles') RETURNING id::text`, [name])).rows[0].id as string;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const user = randomUUID(), sid = randomUUID();
    await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data,email_confirmed_at,role,aud)
      VALUES($1,$2,'{}',now(),'authenticated','authenticated')`, [user, `${user}@example.test`]);
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,$3::org_role,'active')", [org, user, role]);
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sid, user, randomUUID()]);
    staff[role] = { userId: user, sessionId: sid, orgId: org, liveOrgId: org, environment: "live", kind: "staff", role, locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
  }
  const property = (await db.query(`INSERT INTO properties(org_id,name,country_code,currency,timezone)
    VALUES($1,$2,'US','USD','America/Los_Angeles') RETURNING id::text`, [org, `${name} property`])).rows[0].id as string;
  return { org, staff, property };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function lease(f: Fixture, n: number, status: string, start: string, end: string | null, tenant = true) {
  const unit = (await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,'whole_unit') RETURNING id::text`,
    [f.org, f.property, `Unit ${String(n).padStart(3, "0")}`])).rows[0].id as string;
  const id = (await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor,due_day,created_at)
    VALUES($1,$2,$3,$3,$4::lease_status,'imported',$5,$6,'USD',120000,240000,5,now() + make_interval(secs => $7)) RETURNING id::text`,
    [f.org, f.property, unit, status, start, end, n])).rows[0].id as string;
  if (tenant) {
    const contact = (await db.query("INSERT INTO contacts(org_id,display_name,is_tenant,phone_e164) VALUES($1,$2,true,'+19995550100') RETURNING id::text",
      [f.org, `Person ${String(n).padStart(3, "0")}`])).rows[0].id as string;
    await db.query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')", [f.org, id, contact]);
  }
  return id;
}
async function read(s: Session, input: LeasesInput = {}) {
  const result = await brandLeases(s, input, ON); assert.equal(result.state, "ready"); if (result.state !== "ready") assert.fail("reader unavailable"); return result;
}

test("R3-LIST: legacy population and order, uncapped counts, 50-row pages, search, 60-day window on the property calendar", async () => {
  const f = await fixture("B071 list");
  const ids: string[] = [];
  for (let n = 0; n < 52; n++) ids.push(await lease(f, n, "active", "2030-01-01", "2031-12-31"));
  const soon = await lease(f, 60, "active", "2030-01-01", "2030-07-31");        // day 60: 即將到期
  const today = await lease(f, 61, "active", "2029-06-01", "2030-06-01");       // today, property calendar
  const later = await lease(f, 62, "active", "2030-01-01", "2030-08-01");       // day 61: not yet
  const ended = await lease(f, 63, "ended", "2029-01-01", "2030-06-10");        // not active
  await lease(f, 64, "active", "2030-01-01", "2031-01-01", false);              // no primary tenant: not listed (legacy)
  const legacy = await searchLeases(f.staff.manager, { limit: 100 });
  const a = await read(f.staff.manager);
  assert.equal(a.total, legacy.total); assert.equal(a.total, 56); assert.equal(a.rows.length, 50); assert.equal(a.hasNext, true);
  const b = await read(f.staff.manager, { page: "2" });
  assert.deepEqual([...a.rows, ...b.rows].map(r => r.id), legacy.rows.map(r => r.id));
  const by = new Map([...a.rows, ...b.rows].map(r => [r.id, r]));
  assert.equal(by.get(soon)?.endingSoon, true); assert.equal(by.get(today)?.endingSoon, true);
  assert.equal(by.get(later)?.endingSoon, false); assert.equal(by.get(ended)?.endingSoon, false); assert.equal(by.get(ids[0])?.endingSoon, false);
  const place = await read(f.staff.admin, { q: "Unit 060" }); assert.deepEqual(place.rows.map(r => r.id), [soon]); assert.equal(place.total, 56);
  const name = await read(f.staff.admin, { q: "Person 061" }); assert.deepEqual(name.rows.map(r => r.id), [today]);
  const literal = await read(f.staff.admin, { q: "%_" }); assert.equal(literal.filteredCount, 0); assert.equal(literal.total, 56);
  for (const r of a.rows) assert.deepEqual(Object.keys(r).sort(), ["endDate", "endingSoon", "id", "place", "status", "tenant"]);
});
test("P-ACC: list 403, lease page read only; P-MNT: both 403", async () => {
  const f = await fixture("B071 roles");
  const id = await lease(f, 1, "active", "2030-01-01", "2031-01-01");
  await assert.rejects(brandLeases(f.staff.accountant, {}, ON), denied);
  await assert.rejects(brandLeases(f.staff.maintenance, {}, ON), denied);
  await assert.rejects(brandLease(f.staff.maintenance, id, ON), denied);
  const acc = await brandLease(f.staff.accountant, id, ON);
  assert.equal(acc.state, "ready"); if (acc.state !== "ready") assert.fail();
  assert.deepEqual(Object.keys(acc).sort(), ["currency", "depositMinor", "dueDay", "endDate", "id", "place", "rentMinor", "startDate", "state", "status", "tenant"]);
  // A forged session role does not lift the accountant's membership.
  await assert.rejects(brandLeases({ ...f.staff.accountant, role: "manager" }, {}, ON), denied);
});
test("lease page matches the existing leaseDetail fields", async () => {
  const f = await fixture("B071 parity");
  const id = await lease(f, 2, "active", "2030-02-01", null);
  const v3 = await brandLease(f.staff.manager, id, ON);
  const legacy = await leaseDetail(f.staff.manager, id);
  assert.equal(v3.state, "ready"); if (v3.state !== "ready" || !legacy) assert.fail();
  assert.deepEqual([v3.tenant, v3.place, v3.status, v3.startDate, v3.endDate, v3.currency.trim(), v3.rentMinor, v3.depositMinor, v3.dueDay],
    [legacy.lease.tenant, legacy.lease.place, legacy.lease.status, legacy.lease.start_date, legacy.lease.end_date, legacy.lease.currency.trim(),
      legacy.lease.rent, legacy.lease.deposit, legacy.lease.due_day]);
  assert.deepEqual(await brandLease(f.staff.manager, randomUUID(), ON), { state: "not_found" });
});
test("cross-org: another company's staff never see or open this company's leases", async () => {
  const a = await fixture("B071 org A"), b = await fixture("B071 org B");
  const id = await lease(a, 1, "active", "2030-01-01", "2031-01-01");
  await lease(b, 2, "active", "2030-01-01", "2031-01-01");
  for (const role of ["admin", "manager", "accountant"] as const)
    assert.deepEqual(await brandLease(b.staff[role], id, ON), { state: "not_found" }, role);
  const listB = await read(b.staff.admin); assert.equal(listB.total, 1); assert.ok(!listB.rows.some(r => r.id === id));
  // A session pointed at org A without org A membership is refused before any data.
  const forged = { ...b.staff.admin, orgId: a.org, liveOrgId: a.org };
  await assert.rejects(brandLeases(forged, {}, ON), denied);
  await assert.rejects(brandLease(forged, id, ON), denied);
});
