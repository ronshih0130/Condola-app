import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, RENTAL_TURN_LIST_LIMIT, staffRentalTurns } from "./b3-rental-turns";
import { governCustomRole } from "./b017-custom-role-governance";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Synthetic fixtures only. Run on the Mac's disposable, fully migrated PostgreSQL 16 DB.
// No migration application, outbound work or provider calls in this suite.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const TODAY = "2030-05-01";
const ON = { v3: async () => true, now: () => new Date(`${TODAY}T04:00:00Z`) };
const date = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const savedSettings = new Map<string, unknown>();
const savedMoveOut = process.env.MOVE_OUT_NOTICE_ENABLED;
const savedCustom = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
let db: Client;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  for (const key of ["today_home", "today_dash", "move_out_notice", "custom_roles"]) {
    const row = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0];
    if (row) savedSettings.set(key, row.value);
  }
  process.env.MOVE_OUT_NOTICE_ENABLED = "true";
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = "";
});
test.after(async () => {
  try {
    for (const key of ["today_home", "today_dash", "move_out_notice", "custom_roles"]) {
      if (savedSettings.has(key)) await query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(savedSettings.get(key))]);
      else await query("DELETE FROM platform_settings WHERE key = $1", [key]);
    }
  } finally {
    if (savedMoveOut === undefined) delete process.env.MOVE_OUT_NOTICE_ENABLED; else process.env.MOVE_OUT_NOTICE_ENABLED = savedMoveOut;
    if (savedCustom === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedCustom;
    await db?.end();
  }
});

type Role = "admin" | "manager" | "accountant" | "maintenance";
type Org = { orgId: string; property: string; staff: Record<Role, Session> };
async function user() {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
    VALUES ($1, $2, '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [id, `${id}@example.test`]);
  return id;
}
async function staffSession(userId: string, orgId: string, role: Role): Promise<Session> {
  const sessionId = randomUUID();
  await query(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId, liveOrgId: orgId, environment: "live", kind: "staff", role,
    locale: "en", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
}
async function enable(orgId: string) {
  await query(`UPDATE organizations SET feature_flags = feature_flags ||
    '{"today_home":true,"today_dash":true,"today_dash_vacant":true,"move_out_notice":true}'::jsonb WHERE id = $1`, [orgId]);
  for (const key of ["today_home", "today_dash", "move_out_notice"]) {
    await query(`INSERT INTO platform_settings (key, value) VALUES ($1, jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($2::text)))
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('enabled', true, 'allowed_org_ids',
        coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($2::text))`, [key, orgId]);
  }
}
async function makeOrg(): Promise<Org> {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency)
    VALUES ('Rental turns synthetic', 'TW', 'TWD') RETURNING id::text`)).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user();
    await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')`, [orgId, id, role]);
    staff[role] = await staffSession(id, orgId, role);
  }
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, 'Synthetic property', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId])).rows[0].id;
  await enable(orgId);
  return { orgId, property, staff };
}
type Space = { orgId: string; property: string; unit: string; id: string; kind: "unit" | "room" };
let sequence = 0;
async function space(o: Org, kind: Space["kind"] = "room", created = date(-100)): Promise<Space> {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode, created_at)
    VALUES ($1, $2, $3, $4::rental_mode, $5::date::timestamp AT TIME ZONE 'Asia/Taipei') RETURNING id::text`,
  [o.orgId, o.property, `U${sequence++}`, kind === "room" ? "by_room" : "whole_unit", created])).rows[0].id;
  const id = kind === "unit" ? unit : (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label, created_at)
    VALUES ($1, $2, 'A', $3::date::timestamp AT TIME ZONE 'Asia/Taipei') RETURNING id::text`, [o.orgId, unit, created])).rows[0].id;
  return { orgId: o.orgId, property: o.property, unit, id, kind };
}
type LeaseOptions = {
  status?: "draft" | "pending_signature" | "active" | "ended" | "terminated" | "cancelled";
  start?: string; end?: string | null; moved?: string | null; terminated?: string | null;
  renewal?: "none" | "reminder_sent" | "offered" | "renewed" | "declined" | "month_to_month";
  previous?: string | null; id?: string;
};
async function lease(s: Space, opts: LeaseOptions = {}) {
  return (await query<{ id: string }>(`INSERT INTO leases
    (id, org_id, property_id, unit_id, target_room_id, target_unit_id, status, esign_status, start_date, end_date,
     moved_out_on, terminated_on, renewal_status, previous_lease_id, currency, rent_amount_minor)
    VALUES ($1, $2, $3, $4, $5, $6, $7::lease_status, 'imported', $8::date, $9::date, $10::date, $11::date,
      $12::renewal_status, $13, 'TWD', 0) RETURNING id::text`,
  [opts.id ?? randomUUID(), s.orgId, s.property, s.unit, s.kind === "room" ? s.id : null, s.kind === "unit" ? s.id : null,
    opts.status ?? "active", opts.start ?? date(-100), opts.end === undefined ? date(30) : opts.end,
    opts.moved ?? null, opts.terminated ?? null, opts.renewal ?? "none", opts.previous ?? null])).rows[0].id;
}
async function ready(s: Session, extra: Parameters<typeof staffRentalTurns>[1] = {}) {
  const r = await staffRentalTurns(s, { ...ON, ...extra });
  assert.equal(r.state, "ready");
  if (r.state !== "ready") throw new Error("not ready");
  return r;
}
const targets = (r: Awaited<ReturnType<typeof ready>>) => r.mine.map(x => x.targetId);
async function mark(orgId: string, table: string, id: string) {
  await query("INSERT INTO sample_marks (org_id, entity_table, entity_id) VALUES ($1, $2, $3)", [orgId, table, id]);
}

test("R2 vacancy: room/whole targets, future pending/active occupancy, drafts/cancellations and no duplicate count", async () => {
  const o = await makeOrg();
  const a = await space(o), b = await space(o, "unit");
  // Two rooms of one unit: a lease reserves only its actual target, not the containing unit.
  const sibling = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'B') RETURNING id::text`, [o.orgId, a.unit])).rows[0].id;
  await lease({ ...a, id: sibling }, { status: "pending_signature", start: date(90), end: date(120) });
  await lease(a, { status: "draft" }); await lease(a, { status: "cancelled" });
  const pendingUnit = await space(o, "unit");
  await lease(pendingUnit, { status: "pending_signature", start: date(90), end: date(120) });
  const futureActive = await space(o); await lease(futureActive, { start: date(90), end: date(120) });
  // Divided units with zero rooms do not become synthetic spaces.
  await query(`INSERT INTO units (org_id, property_id, label, rental_mode) VALUES ($1, $2, 'empty divided', 'by_room')`, [o.orgId, o.property]);
  const r = await ready(o.staff.manager);
  assert.deepEqual(r.counts, { vacant: 2, renewalAsk: 0, earlyVacancy: 0 });
  assert.deepEqual(targets(r).sort(), [a.id, b.id].sort());
  for (const row of r.mine) {
    assert.equal(row.date, date(-100)); assert.equal(row.dayNumber, 100);
    assert.equal(row.leaseId, null); assert.equal(row.tenantName, null);
    assert.equal(row.targetKind, row.targetId === a.id ? "room" : "unit");
    assert.match(row.place, row.targetId === a.id ? /^Synthetic property U\d+ A$/ : /^Synthetic property U\d+$/);
  }
  // A source resolution clears the row on the next read.
  await lease(a, { status: "pending_signature", start: date(1), end: date(70) });
  assert.deepEqual(targets(await ready(o.staff.manager)), [b.id]);
});

test("R2 archived property, unit and room exclude vacancy and current lease matters", async () => {
  for (const [ancestor, kind] of [
    ["properties", "room"], ["units", "room"], ["rooms", "room"], ["properties", "unit"], ["units", "unit"],
  ] as const) {
    const o = await makeOrg();
    const a = await space(o, kind), b = await space(o, kind), c = await space(o, kind);
    await lease(b); await lease(c, { renewal: "declined" });
    const ids = ancestor === "properties" ? [o.property] : ancestor === "units" ? [a.unit, b.unit, c.unit] : [a.id, b.id, c.id];
    // The identifier comes from the closed test enum, never request data.
    await query(`UPDATE ${ancestor} SET archived_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
    const r = await ready(o.staff.admin);
    assert.deepEqual(r.counts, { vacant: 0, renewalAsk: 0, earlyVacancy: 0 }); assert.deepEqual(r.mine, []);
  }
});

test("R2 historical fallback priority, latest fallback/start/id tie, missing and contradictory dates", async () => {
  const o = await makeOrg();
  const cases: [Space, string | null][] = [];
  const moved = await space(o); cases.push([moved, date(-20)]);
  await lease(moved, { status: "ended", end: date(-10), moved: date(-20), terminated: date(-5) });
  const ended = await space(o); cases.push([ended, date(-10)]);
  await lease(ended, { status: "terminated", end: date(-10), terminated: date(-5) });
  const terminated = await space(o); cases.push([terminated, date(-5)]);
  await lease(terminated, { status: "terminated", end: null, terminated: date(-5) });
  const missing = await space(o); cases.push([missing, null]);
  await lease(missing, { status: "ended", end: null });
  const future = await space(o); cases.push([future, null]);
  await lease(future, { status: "ended", end: date(10) });
  const beforeStart = await space(o); cases.push([beforeStart, null]);
  await lease(beforeStart, { status: "terminated", moved: date(-101), end: date(-1) });
  const latest = await space(o); cases.push([latest, date(-3)]);
  await lease(latest, { status: "ended", start: date(-300), end: date(-3) });
  await lease(latest, { status: "ended", start: date(-100), end: date(-20) });
  await lease(latest, { status: "ended", start: date(-2), end: null });
  await lease(latest, { status: "cancelled", end: date(-1) });
  // Same departure: latest start wins; a departure before that start is unusable.
  const tie = await space(o); cases.push([tie, null]);
  await lease(tie, { status: "ended", start: date(-20), end: date(-10) });
  await lease(tie, { status: "ended", start: date(-5), end: null, moved: date(-10) });
  const fresh = await space(o, "unit", TODAY); cases.push([fresh, TODAY]);
  const futureCreated = await space(o, "unit", date(1)); cases.push([futureCreated, null]);
  const r = await ready(o.staff.admin);
  assert.equal(r.counts.vacant, cases.length);
  for (const [s, expected] of cases) {
    const row = r.mine.find(x => x.targetId === s.id)!;
    assert.equal(row.date, expected, s.id);
    assert.equal(row.dayNumber, expected === null ? null : (Date.parse(TODAY) - Date.parse(expected)) / 86_400_000);
  }
  // Unknown ages sort last; known vacancy ages sort oldest first, then target UUID.
  const expected = [...r.mine].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.targetId.localeCompare(b.targetId));
  assert.deepEqual(r.mine, expected);
});

test("R3 renewal: inclusive day 0/60, excludes day 61/past/open-ended/future-start/terminated; every enum", async () => {
  const o = await makeOrg(); const included: string[] = [];
  for (const offset of [-1, 0, 60, 61]) {
    const s = await space(o); const id = await lease(s, { end: date(offset) });
    if (offset === 0 || offset === 60) included.push(id);
  }
  for (const renewal of ["none", "reminder_sent", "offered", "renewed", "declined", "month_to_month"] as const) {
    const s = await space(o); const id = await lease(s, { renewal });
    if (renewal === "none" || renewal === "reminder_sent") included.push(id);
  }
  await lease(await space(o), { end: null });
  await lease(await space(o), { start: date(1) });
  await lease(await space(o), { terminated: date(-1) });
  const r = await ready(o.staff.manager);
  assert.equal(r.counts.vacant, 0);
  assert.deepEqual(r.mine.filter(x => x.kind === "renewal_ask").map(x => x.leaseId).sort(), included.sort());
  assert.equal(r.counts.renewalAsk, 4); assert.equal(r.counts.earlyVacancy, 1, "declined goes to early vacancy");
  assert.deepEqual(r.mine.filter(x => x.kind === "renewal_ask").map(x => x.dayNumber), [0, 30, 30, 60]);
});

test("R4 early vacancy: future notice only, declined fallback, day 0/60/61, actual dates and inconsistent active occupancy", async () => {
  const o = await makeOrg(); const expected = new Map<string, string>();
  for (const day of [-1, 0, 1, 60, 61]) {
    const s = await space(o); await lease(s, { moved: date(day), end: date(90) });
    if (day === 1 || day === 60) expected.set(s.id, date(day));
  }
  for (const day of [-1, 0, 60, 61]) {
    const s = await space(o, "unit"); await lease(s, { renewal: "declined", end: date(day) });
    if (day === 0 || day === 60) expected.set(s.id, date(day));
  }
  // A recorded actual departure cannot fall back to a future end date, even if declined.
  await lease(await space(o), { moved: date(-1), renewal: "declined" });
  await lease(await space(o), { moved: TODAY, renewal: "declined" });
  await lease(await space(o), { renewal: "declined", end: null });
  const openNotice = await space(o); await lease(openNotice, { end: null, moved: date(10) }); expected.set(openNotice.id, date(10));
  const priority = await space(o); await lease(priority, { renewal: "declined", moved: date(15), end: date(5) }); expected.set(priority.id, date(15));
  await lease(await space(o), { start: date(2), moved: date(10) });
  await lease(await space(o), { terminated: date(-1), moved: date(10) });
  const r = await ready(o.staff.admin);
  assert.deepEqual(r.counts, { vacant: 0, renewalAsk: 0, earlyVacancy: expected.size });
  assert.equal(new Set(targets(r)).size, r.mine.length);
  for (const row of r.mine) assert.equal(row.date, expected.get(row.targetId));
  // Actual ended/terminated source, unlike merely passed moved_out_on, becomes vacant.
  const left = await space(o); await lease(left, { status: "ended", end: date(-1), moved: date(-2) });
  assert.equal((await ready(o.staff.admin)).counts.vacant, 1);
});

test("R3/R4 successor must match target, active/pending status and start strictly after end; links alone do not suffice", async () => {
  for (const renewal of ["none", "declined"] as const) {
    const o = await makeOrg(); const expected: string[] = [];
    for (const status of ["active", "pending_signature", "draft", "cancelled", "ended", "terminated"] as const) {
      const s = await space(o); const first = await lease(s, { renewal, end: date(10) });
      await lease(s, { status, start: date(11), end: date(100), previous: first });
      if (!["active", "pending_signature"].includes(status)) expected.push(first);
    }
    // Unlinked successor still qualifies.
    const unlinked = await space(o); await lease(unlinked, { renewal, end: date(10) });
    await lease(unlinked, { status: "pending_signature", start: date(11), end: date(100) });
    // A linked lease on another room of the SAME unit cannot suppress this target.
    const wrong = await space(o); const current = await lease(wrong, { renewal, end: date(10) }); expected.push(current);
    const sibling = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'B') RETURNING id::text`, [o.orgId, wrong.unit])).rows[0].id;
    await lease({ ...wrong, id: sibling }, { status: "pending_signature", start: date(11), end: date(100), previous: current });
    // Earlier active interval is not a successor (non-overlap is enforced by the real schema).
    const earlier = await space(o, "unit"); const later = await lease(earlier, { renewal, start: date(-20), end: date(10) }); expected.push(later);
    await lease(earlier, { start: date(-100), end: date(-21) });
    // A same-day occupying successor is impossible: inclusive term exclusion protects
    // the strict > end predicate. Do not disable production constraints to fabricate it.
    await assert.rejects(lease(earlier, { status: "pending_signature", start: date(10), end: date(100) }),
      (e: unknown) => (e as { code?: string }).code === "23P01");
    await lease(earlier, { status: "draft", start: date(10), end: date(100) });
    const r = await ready(o.staff.manager);
    assert.deepEqual(r.mine.map(x => x.leaseId).sort(), expected.sort());
    assert.equal(r.counts.vacant, 0);
  }
});

test("R6 >50 matters: one manager list cap, uncapped per-kind counts, priority/date/stable-ID ordering and primary tenant", async () => {
  const o = await makeOrg(); const expected: { kind: string; leaseId: string | null; targetId: string; date: string }[] = [];
  for (let i = 0; i < 53; i++) {
    const s = await space(o, i % 2 ? "room" : "unit");
    const id = await lease(s, { end: date(i % 3) });
    expected.push({ kind: "renewal_ask", leaseId: id, targetId: s.id, date: date(i % 3) });
    if (i === 0) {
      for (const [role, name] of [["primary", "Primary synthetic"], ["co_tenant", "Co synthetic"]]) {
        const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, $2) RETURNING id::text`, [o.orgId, name])).rows[0].id;
        await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, $4::lease_party_role)`, [o.orgId, id, contact, role]);
      }
    }
  }
  for (let i = 0; i < 3; i++) { const s = await space(o); await lease(s, { renewal: "declined", end: date(i) }); }
  for (let i = 0; i < 54; i++) await space(o, "unit", date(-i));
  const r = await ready(o.staff.admin);
  assert.deepEqual(r.counts, { vacant: 54, renewalAsk: 53, earlyVacancy: 3 });
  assert.equal(r.mine.length, RENTAL_TURN_LIST_LIMIT);
  expected.sort((a, b) => a.date.localeCompare(b.date) || a.leaseId!.localeCompare(b.leaseId!));
  assert.deepEqual(r.mine.map(({ kind, leaseId, targetId, date }) => ({ kind, leaseId, targetId, date })), expected.slice(0, 50));
  assert.ok(r.mine.some(x => x.tenantName === "Primary synthetic"));
  assert.ok(r.mine.every(x => x.tenantName !== "Co synthetic"));
  // After inquiry resolution, early vacancies precede vacancies (also capped together).
  await query(`UPDATE leases SET renewal_status = 'offered' WHERE org_id = $1 AND renewal_status = 'none'`, [o.orgId]);
  const next = await ready(o.staff.admin);
  assert.deepEqual(next.counts, { vacant: 54, renewalAsk: 0, earlyVacancy: 3 });
  assert.equal(next.mine.length, 50);
  assert.deepEqual(next.mine.slice(0, 3).map(x => [x.kind, x.dayNumber]), [["early_vacancy", 0], ["early_vacancy", 1], ["early_vacancy", 2]]);
  assert.ok(next.mine.slice(3).every(x => x.kind === "vacant"));
  assert.equal(next.mine[3].dayNumber, 53, "oldest vacancy first");
});

test("§6 live sample exclusion covers ancestors, leases and tenant names; sandbox reads only selected sandbox data", async () => {
  const o = await makeOrg();
  const real = await space(o, "unit");
  const markedRoom = await space(o); await mark(o.orgId, "rooms", markedRoom.id);
  const markedUnit = await space(o); await mark(o.orgId, "units", markedUnit.unit);
  const markedLease = await space(o); const sampleLease = await lease(markedLease); await mark(o.orgId, "leases", sampleLease);
  const nameSpace = await space(o); const realLease = await lease(nameSpace);
  const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, 'Sample name') RETURNING id::text`, [o.orgId])).rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')`, [o.orgId, realLease, contact]);
  await mark(o.orgId, "contacts", contact);
  const r = await ready(o.staff.admin);
  assert.deepEqual(r.counts, { vacant: 2, renewalAsk: 1, earlyVacancy: 0 });
  assert.deepEqual(targets(r).sort(), [real.id, markedLease.id, nameSpace.id].sort());
  assert.equal(r.mine.find(x => x.leaseId === realLease)?.tenantName, null);

  const sbId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id)
    VALUES ('Rental synthetic sandbox', 'TW', 'TWD', 'sandbox', $1) RETURNING id::text`, [o.orgId])).rows[0].id;
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, 'Sandbox property', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [sbId])).rows[0].id;
  await enable(sbId);
  const sandbox = { ...o, orgId: sbId, property };
  const sbVacant = await space(sandbox), sbRenewal = await space(sandbox), sbEarly = await space(sandbox);
  const renewalId = await lease(sbRenewal); await lease(sbEarly, { renewal: "declined" });
  await mark(sbId, "properties", property); await mark(sbId, "leases", renewalId);
  const session: Session = { ...o.staff.admin, orgId: sbId, environment: "sandbox" };
  const sb = await ready(session);
  assert.deepEqual(sb.counts, { vacant: 1, renewalAsk: 1, earlyVacancy: 1 });
  assert.deepEqual(targets(sb).sort(), [sbVacant.id, sbRenewal.id, sbEarly.id].sort());
  assert.ok(sb.mine.every(x => x.propertyId === property));
  assert.deepEqual(await ready(o.staff.admin), r, "sandbox rows never leak into live");
  await assert.rejects(staffRentalTurns({ ...session, environment: "live" }, ON), denied);
  await assert.rejects(staffRentalTurns({ ...o.staff.admin, environment: "sandbox" }, ON), denied);
  const sbOnly = await user();
  await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [sbId, sbOnly]);
  await assert.rejects(staffRentalTurns(await staffSession(sbOnly, o.orgId, "admin"), ON), denied);
  await mark(o.orgId, "properties", o.property);
  assert.deepEqual((await ready(o.staff.admin)).counts, { vacant: 0, renewalAsk: 0, earlyVacancy: 0 });
});

test("R7 native accountant/maintenance/portal denial precedes transaction; stale suspended membership and cross-org forgery are refused", async () => {
  const o = await makeOrg(), other = await makeOrg();
  const only = await space(o); await space(other, "unit");
  let opened = 0;
  const counting: typeof tx = (...args) => { opened++; return tx(...args); };
  for (const s of [o.staff.accountant, o.staff.maintenance,
    { ...o.staff.manager, kind: "tenant" as const }, { ...o.staff.admin, kind: "owner" as const }]) {
    await assert.rejects(staffRentalTurns(s, { ...ON, transaction: counting }), denied);
  }
  assert.equal(opened, 0);
  assert.deepEqual(targets(await ready(o.staff.manager)), [only.id]);
  // Even a suspended manager who still has tenant RLS access must not be admitted.
  const ownLease = await lease(await space(o));
  const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, is_tenant, display_name)
    VALUES ($1, $2, true, 'Synthetic dual role') RETURNING id::text`, [o.orgId, o.staff.manager.userId])).rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')`, [o.orgId, ownLease, contact]);
  await query(`UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.manager.userId]);
  assert.equal(await tx(o.staff.manager.userId, async c => (await c.query("SELECT id FROM leases WHERE id = $1", [ownLease])).rowCount,
    { orgId: o.orgId, environment: "live" }), 1, "tenant policy alone still exposes the lease");
  await assert.rejects(staffRentalTurns(o.staff.manager, ON), denied);
  await assert.rejects(staffRentalTurns({ ...other.staff.admin, orgId: o.orgId, liveOrgId: o.orgId }, ON), denied);
  assert.ok(!(await ready(other.staff.admin)).mine.some(x => x.targetId === only.id));
});

test("R7 custom roles require both keys and revalidate each inside the read snapshot", async () => {
  const o = await makeOrg(); const vacant = await space(o);
  await query(`UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.admin.userId]);
  const before = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const saved = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'custom_roles'")).rows[0];
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}'::jsonb WHERE id = $1`, [o.orgId]);
    const memberId = (await query<{ id: string }>("SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2", [o.orgId, o.staff.manager.userId])).rows[0].id;
    const created = await governCustomRole(o.staff.admin, { operation: "create", grants: ["props.view"], requestId: randomUUID() });
    assert.ok(created.roleId);
    const roleId = created.roleId!;
    await governCustomRole(o.staff.admin, { operation: "assign", roleId, memberId, requestId: randomUUID() });
    let opened = 0;
    const counting: typeof tx = (...args) => { opened++; return tx(...args); };
    await assert.rejects(staffRentalTurns(o.staff.manager, { ...ON, transaction: counting }), denied);
    assert.equal(opened, 0, "missing leases.edit denied before business transaction");
    await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["leases.edit"], requestId: randomUUID() });
    await assert.rejects(staffRentalTurns(o.staff.manager, { ...ON, transaction: counting }), denied);
    assert.equal(opened, 0, "missing props.view denied before business transaction");
    await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["leases.edit", "props.view"], requestId: randomUUID() });
    // app.b017_effective honours an assignment only at the role's current revision: reassign after a revision.
    await governCustomRole(o.staff.admin, { operation: "assign", roleId, memberId, requestId: randomUUID() });
    const granted = await staffSession(o.staff.manager.userId, o.orgId, "manager");
    assert.deepEqual(targets(await ready(granted)), [vacant.id]);
    assert.deepEqual(targets(await ready(o.staff.admin)), [vacant.id], "unassigned native admin unchanged");
    // Remove each key AFTER admission but BEFORE the reader snapshot, using a separate connection.
    for (const retained of ["props.view", "leases.edit"]) {
      await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: ["leases.edit", "props.view"], requestId: randomUUID() });
      await governCustomRole(o.staff.admin, { operation: "assign", roleId, memberId, requestId: randomUUID() });
      const fresh = await staffSession(o.staff.manager.userId, o.orgId, "manager");
      assert.deepEqual(targets(await ready(fresh)), [vacant.id], "fresh session admitted before the mid-read change");
      const changed: typeof tx = async (...args) => {
        await governCustomRole(o.staff.admin, { operation: "revise", roleId, grants: [retained], requestId: randomUUID() });
        return tx(...args);
      };
      await assert.rejects(staffRentalTurns(fresh, { ...ON, transaction: changed }), denied);
    }
  } finally {
    if (before === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = before;
    if (saved) await query("UPDATE platform_settings SET value = $1::jsonb WHERE key = 'custom_roles'", [JSON.stringify(saved.value)]);
    else await query("DELETE FROM platform_settings WHERE key = 'custom_roles'");
    await query(`UPDATE organizations SET feature_flags = feature_flags - 'custom_roles' WHERE id = $1`, [o.orgId]);
  }
});

test("§6 flag matrix: brand/home/dash OFF avoids business tx; item gates remove only their kind", async () => {
  const o = await makeOrg(); await space(o);
  await lease(await space(o)); await lease(await space(o), { renewal: "declined" });
  let opened = 0;
  const counting: typeof tx = (...args) => { opened++; return tx(...args); };
  assert.deepEqual(await staffRentalTurns(o.staff.admin, { transaction: counting }), { state: "off" }, "real brand flag is absent");
  assert.equal(opened, 0);
  for (const key of ["today_home", "today_dash"]) {
    await query("UPDATE organizations SET feature_flags = feature_flags - $2::text WHERE id = $1", [o.orgId, key]);
    assert.deepEqual(await staffRentalTurns(o.staff.admin, { ...ON, transaction: counting }), { state: "off" });
    await query("UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object($2::text, true) WHERE id = $1", [o.orgId, key]);
  }
  assert.equal(opened, 0);
  for (const key of ["today_home", "today_dash"]) {
    const saved = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0].value;
    try {
      for (const value of [{ enabled: false, allowed_org_ids: [o.orgId] }, { enabled: true, allowed_org_ids: [] }, { enabled: true, allowed_org_ids: [o.orgId, 1] }]) {
        await query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
        assert.deepEqual(await staffRentalTurns(o.staff.admin, { ...ON, transaction: counting }), { state: "off" });
      }
    } finally { await query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(saved)]); }
  }
  assert.equal(opened, 0);
  assert.deepEqual((await ready(o.staff.admin)).counts, { vacant: 1, renewalAsk: 1, earlyVacancy: 1 });
  await query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_dash_vacant":"true"}'::jsonb WHERE id = $1`, [o.orgId]);
  assert.deepEqual((await ready(o.staff.admin)).counts, { vacant: 0, renewalAsk: 1, earlyVacancy: 1 }, "string true is off");
  await query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_dash_vacant":false,"move_out_notice":false}'::jsonb WHERE id = $1`, [o.orgId]);
  assert.deepEqual((await ready(o.staff.admin)).counts, { vacant: 0, renewalAsk: 1, earlyVacancy: 0 });
  await query(`UPDATE organizations SET feature_flags = feature_flags || '{"move_out_notice":true}'::jsonb WHERE id = $1`, [o.orgId]);
  const oldMove = process.env.MOVE_OUT_NOTICE_ENABLED;
  try {
    process.env.MOVE_OUT_NOTICE_ENABLED = "false";
    assert.equal((await ready(o.staff.admin)).counts.earlyVacancy, 0);
  } finally { process.env.MOVE_OUT_NOTICE_ENABLED = oldMove; }
  const move = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'move_out_notice'")).rows[0].value;
  try {
    await query(`UPDATE platform_settings SET value = '{"enabled":true,"allowed_org_ids":[]}'::jsonb WHERE key = 'move_out_notice'`);
    assert.equal((await ready(o.staff.admin)).counts.earlyVacancy, 0);
  } finally { await query("UPDATE platform_settings SET value = $1::jsonb WHERE key = 'move_out_notice'", [JSON.stringify(move)]); }
});

test("§6 actual SELECT denial for anon/non-member/cross-org, not just helper denial; repeatable read and read-only enforced", async () => {
  const o = await makeOrg(), other = await makeOrg(); await space(o); await lease(await space(o));
  const params = [o.orgId, TODAY, "live", true, true];
  for (const sql of [COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST]) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query(sql, sql === LISTS_SQL_FOR_TEST ? [...params, 50] : params), (e: unknown) => (e as { code?: string }).code === "42501");
    } finally { await db.query("ROLLBACK"); }
    // Current member of another org, pinned there, asks for this org's business set.
    const rows = await tx(other.staff.admin.userId, async c => (await c.query(sql, sql === LISTS_SQL_FOR_TEST ? [...params, 50] : params)).rows,
      { orgId: other.orgId, environment: "live" }, { isolation: "repeatable read", readOnly: true });
    assert.deepEqual(rows, []);
  }
  const outsider = await user();
  await assert.rejects(staffRentalTurns(await staffSession(outsider, o.orgId, "admin"), ON), denied);
  const probe: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    assert.equal((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    assert.equal((await c.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
    assert.equal((await c.query("SELECT current_user AS role")).rows[0].role, "authenticated");
    return fn(c);
  }, scope, opts);
  await ready(o.staff.admin, { transaction: probe });
});

test("§6 a real statement timeout after counts yields unavailable rather than partial counts", async () => {
  const o = await makeOrg(); await space(o);
  let counted = false; let code: string | undefined;
  const slow: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      if (args[0] === LISTS_SQL_FOR_TEST) {
        assert.ok(counted);
        try { await run("SELECT pg_sleep(30)"); } catch (e) { code = (e as { code?: string }).code; throw e; }
      }
      const result = await run(...args);
      if (args[0] === COUNTS_SQL_FOR_TEST) { assert.deepEqual(result.rows, [{ kind: "vacant", count: 1 }]); counted = true; }
      return result;
    };
    return fn(c);
  }, scope, opts);
  assert.deepEqual(await staffRentalTurns(o.staff.admin, { ...ON, transaction: slow }), { state: "unavailable" });
  assert.equal(code, "57014");
});

test("§6 counts and list retain one snapshot across a concurrent source resolution", async () => {
  const o = await makeOrg(); const s = await space(o); const id = await lease(s);
  let resolved = false;
  const interleaved: typeof tx = (userId, fn, scope, opts) => tx(userId, async c => {
    const run = c.query.bind(c) as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
    (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await run(...args);
      if (args[0] === COUNTS_SQL_FOR_TEST) {
        assert.deepEqual(result.rows, [{ kind: "renewal_ask", count: 1 }]);
        await query(`UPDATE leases SET renewal_status = 'offered' WHERE id = $1`, [id]);
        resolved = true;
      }
      return result;
    };
    return fn(c);
  }, scope, opts);
  const r = await ready(o.staff.admin, { transaction: interleaved });
  assert.ok(resolved); assert.equal(r.counts.renewalAsk, 1); assert.equal(r.mine[0]?.leaseId, id);
  assert.deepEqual((await ready(o.staff.admin)).counts, { vacant: 0, renewalAsk: 0, earlyVacancy: 0 });
});

test("R6 early-vacancy count also remains uncapped above fifty", async () => {
  const o = await makeOrg();
  for (let i = 0; i < 51; i++) await lease(await space(o), { renewal: "declined", end: date(i) });
  const r = await ready(o.staff.admin);
  assert.deepEqual(r.counts, { vacant: 0, renewalAsk: 0, earlyVacancy: 51 });
  assert.equal(r.mine.length, 50);
  assert.deepEqual(r.mine.map(x => x.dayNumber), Array.from({ length: 50 }, (_, i) => i));
});

test("MGT-101-AC3 rent lost: room base rent, else unit base rent, else previous lease rent; none omits the money", async () => {
  const o = await makeOrg();
  const room = await space(o, "room"); const unitOnly = await space(o, "room"); const fromLease = await space(o, "unit"); const none = await space(o, "unit");
  await query("UPDATE rooms SET base_rent_minor = 900000 WHERE id = $1", [room.id]);
  await query("UPDATE units SET base_rent_minor = 1200000 WHERE id = $1", [room.unit]);       // room rent wins over unit rent
  await query("UPDATE units SET base_rent_minor = 800000 WHERE id = $1", [unitOnly.unit]);    // room has none → unit rent
  const previous = await lease(fromLease, { status: "ended", start: date(-400), end: date(-40) });
  await query("UPDATE leases SET rent_amount_minor = 1500000 WHERE id = $1", [previous]);
  const r = await ready(o.staff.admin);
  const rent = (id: string) => { const row = r.mine.find(m => m.kind === "vacant" && m.targetId === id); assert.ok(row, id); return [row!.rentMinor, row!.rentCurrency]; };
  assert.deepEqual(rent(room.id), ["900000", "TWD"]);
  assert.deepEqual(rent(unitOnly.id), ["800000", "TWD"]);
  assert.deepEqual(rent(fromLease.id), ["1500000", "TWD"]);
  assert.deepEqual(rent(none.id), [null, null], "no rent source: omitted, never zero");
  for (const row of r.mine.filter(m => m.kind !== "vacant")) assert.deepEqual([row.rentMinor, row.rentCurrency], [null, null]);
});
