import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tenantLeaseTerms, tenantRepairView } from "./b090-tenant-lease-repair";
import { buildStoredConsent } from "./consent";
import { query } from "./db";
import { tenantLeaseMoney, tenantLeases } from "./queries";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-090 slice 3: RT-REPAIR (TEN-56-AC4/AC5) and RT-LEASE (TEN-57-AC1), read parts. No query is added: the views
// compose the existing tenant readers (tenantRepairs, ticketDetail, tenantLeaseMoney) under the tenant's own RLS.
// This proves a tenant sees only their own lease's repairs and terms, across leases and orgs. Synthetic data only.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

async function user(tag: string) {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud) VALUES ($1, $2, '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [id, `${tag}.${id}@example.test`]);
  return id;
}
async function sessionRow(userId: string) {
  const id = randomUUID();
  await query(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [id, userId, randomUUID()]);
  return id;
}
type Org = { orgId: string; property: string };
async function makeOrg(): Promise<Org> {
  const tag = `b090s3.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency) VALUES ($1, 'TW', 'TWD') RETURNING id::text`, [tag])).rows[0].id;
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId, `${tag} 樓`])).rows[0].id;
  return { orgId, property };
}
type Tenant = { s: Session; contact: string; userId: string };
async function makeTenant(orgId: string, existingUser?: string): Promise<Tenant> {
  const userId = existingUser ?? await user("tenant");
  const consent = buildStoredConsent("signup");
  if (!existingUser) await query(`INSERT INTO consents (user_id, accepted_at, terms_version, privacy_version, source) VALUES ($1, $2, $3, $4, $5)`, [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, is_tenant, display_name) VALUES ($1, $2, true, 'Synthetic tenant') RETURNING id::text`, [orgId, userId])).rows[0].id;
  const s: Session = { userId, sessionId: await sessionRow(userId), email: "", name: "Synthetic", kind: "tenant", role: null, orgId, liveOrgId: orgId, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null, consent };
  return { s, contact, userId };
}
let seq = 0;
async function makeLease(o: Org, parties: Tenant[], dueDay = 5) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode) VALUES ($1, $2, $3, 'by_room') RETURNING id::text`, [o.orgId, o.property, `F${seq++}`])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'A') RETURNING id::text`, [o.orgId, unit])).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases (org_id, property_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, due_day)
     VALUES ($1, $2, $3, $4, 'active', 'imported', '2026-05-01', '2027-04-30', 'TWD', 1850000, 3700000, $5) RETURNING id::text`, [o.orgId, o.property, unit, room, dueDay])).rows[0].id;
  for (const [i, t] of parties.entries()) await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, $4)`, [o.orgId, lease, t.contact, i === 0 ? "primary" : "co_tenant"]);
  return { lease, o };
}
type L = Awaited<ReturnType<typeof makeLease>>;
let ticketNo = 1;
async function ticket(l: L, status: string, title: string, extra: { description?: string; completedOn?: string } = {}) {
  const id = (await query<{ id: string }>(
    `INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, lease_id, title, description, status, vendor_name, currency, estimated_cost_minor, completed_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7::ticket_status, 'Synthetic vendor', 'TWD', 450000, $8::date) RETURNING id::text`,
    [l.o.orgId, ticketNo++, l.o.property, l.lease, title, extra.description ?? null, status, extra.completedOn ?? null])).rows[0].id;
  await query(`INSERT INTO ticket_comments (org_id, ticket_id, body, is_internal) VALUES ($1, $2, 'Synthetic reply', false), ($1, $2, 'Synthetic internal note', true)`, [l.o.orgId, id]);
  return id;
}

test("TEN-56-AC4: a tenant lists and opens only their own lease's repairs; internal notes, costs and the vendor never reach the view", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), roommate = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const shared = await makeLease(o, [alice, roommate]);
  const other = await makeLease(o, [stranger]);
  const leak = await ticket(shared, "assigned", "浴室天花板滴水", { description: "越來越嚴重" });
  const done = await ticket(shared, "closed", "燈泡", { completedOn: "2026-11-16" });
  const theirs = await ticket(other, "open", "別人的報修");

  const list = await tenantRepairView(alice.s, shared.lease, undefined);
  assert.equal(list.state, "list");
  assert.deepEqual(list.state === "list" && list.repairs.map(r => [r.title, r.stage]).sort(), [["浴室天花板滴水", "dispatched"], ["燈泡", "done"]].sort());

  const view = await tenantRepairView(alice.s, shared.lease, leak);
  assert.equal(view.state, "progress");
  if (view.state !== "progress") return;
  assert.deepEqual([view.repair.title, view.repair.description, view.repair.stage], ["浴室天花板滴水", "越來越嚴重", "dispatched"]);
  assert.deepEqual(view.comments.map(c => c.body), ["Synthetic reply"], "RLS and the view both drop internal notes");
  const json = JSON.stringify(view);
  for (const hidden of ["450000", "Synthetic vendor", "Synthetic internal note"]) assert.ok(!json.includes(hidden), hidden);

  const closed = await tenantRepairView(alice.s, shared.lease, done);
  assert.deepEqual(closed.state === "progress" && closed.repair.steps.at(-1), { id: "done", state: "done", current: true, date: "2026-11-16" });
  // a co-tenant on the same lease sees the same repair (one lease, shared)
  assert.equal((await tenantRepairView(roommate.s, shared.lease, leak)).state, "progress");

  // another lease's repair through my lease: the list, never its detail
  assert.equal((await tenantRepairView(alice.s, shared.lease, theirs)).state, "list");
  // my session against another lease: nothing of theirs is listed or opened
  const foreign = await tenantRepairView(alice.s, other.lease, theirs);
  assert.deepEqual(foreign.state === "list" && foreign.repairs, []);
  // and the stranger never sees mine
  const strangerView = await tenantRepairView(stranger.s, shared.lease, leak);
  assert.deepEqual(strangerView.state === "list" && strangerView.repairs, []);
  // the same person signed in to another org sees nothing of this org
  const elsewhere = await makeOrg();
  const alias = await makeTenant(elsewhere.orgId, alice.userId);
  const cross = await tenantRepairView(alias.s, shared.lease, leak);
  assert.equal(cross.state, "list", "the list, not an error or the progress page");
  assert.deepEqual(cross.state === "list" && cross.repairs, []);
});

test("TEN-57-AC1: lease terms (物件／租期／租金／繳租日／押金) come from the tenant's own lease only", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const mine = await makeLease(o, [alice], 5);
  const theirs = await makeLease(o, [stranger], 10);
  const money = await tenantLeaseMoney(alice.s, mine.lease);
  assert.ok(money);
  const terms = tenantLeaseTerms(money!);
  assert.deepEqual({ ...terms, place: "" }, { place: "", start: "2026-05-01", end: "2027-04-30", rentMinor: 1_850_000, depositMinor: 3_700_000, currency: "TWD", dueDay: 5 });
  assert.match(terms.place, /樓 F\d+ A$/);
  assert.equal(await tenantLeaseMoney(alice.s, theirs.lease), null, "another tenant's lease is not readable");
  // The page reads terms only for a lease from the session's own tenantLeases list (selectedLease). That picker spans
  // every firm the same person rents from (by design: app.my_tenant_leases), so it is keyed by the person, never by
  // another tenant: the stranger's list and reads never include this lease.
  assert.deepEqual((await tenantLeases(alice.s)).map(l => l.lease_id), [mine.lease]);
  assert.deepEqual((await tenantLeases(stranger.s)).map(l => l.lease_id), [theirs.lease]);
  assert.equal(await tenantLeaseMoney(stranger.s, mine.lease), null);
  const elsewhere = await makeOrg();
  const outsider = await makeTenant(elsewhere.orgId);
  assert.deepEqual(await tenantLeases(outsider.s), []);
  assert.equal(await tenantLeaseMoney(outsider.s, mine.lease), null, "a tenant of another org reads nothing");
});
