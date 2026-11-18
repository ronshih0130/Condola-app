import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tenantHomeView } from "./b090-tenant-home";
import { buildStoredConsent } from "./consent";
import { query } from "./db";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-090 slice 1, RT-HOME (TEN-54). The 首頁 facts are read only for the tenant's own selected lease and own reports,
// through the existing tenant payment-history reader and the existing tenant repair reader. Synthetic data only.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let historySetting: unknown;
test.before(async () => {
  historySetting = (await query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'tenant_payment_history'`)).rows[0]?.value ?? null;
});
test.after(async () => {
  if (historySetting === null) await query(`DELETE FROM platform_settings WHERE key = 'tenant_payment_history' AND value->>'b090_test' = 'true'`);
  else await query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'tenant_payment_history'`, [JSON.stringify(historySetting)]);
});

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
async function makeOrg(enable = true): Promise<Org> {
  const tag = `b090.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency) VALUES ($1, 'TW', 'TWD') RETURNING id::text`, [tag])).rows[0].id;
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId, `${tag} 樓`])).rows[0].id;
  if (enable) {
    await query(
      `INSERT INTO platform_settings (key, value) VALUES ('tenant_payment_history', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text), 'b090_test', true))
       ON CONFLICT (key) DO UPDATE SET value = jsonb_set(jsonb_set(platform_settings.value, '{enabled}', 'true'::jsonb),
         '{allowed_org_ids}', coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))`, [orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"tenant_payment_history":true}'::jsonb WHERE id = $1`, [orgId]);
  }
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
async function makeLease(o: Org, parties: Tenant[], invoice: { due: string; period?: string; amount?: number } = { due: "2090-03-05", period: "2090-03-01" }) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode) VALUES ($1, $2, $3, 'by_room') RETURNING id::text`, [o.orgId, o.property, `F${seq++}`])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'A') RETURNING id::text`, [o.orgId, unit])).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases (org_id, property_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency, rent_amount_minor)
     VALUES ($1, $2, $3, $4, 'active', 'imported', '2020-01-01', '2090-12-31', 'TWD', 0) RETURNING id::text`, [o.orgId, o.property, unit, room])).rows[0].id;
  for (const [i, t] of parties.entries()) await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, $4)`, [o.orgId, lease, t.contact, i === 0 ? "primary" : "co_tenant"]);
  const id = (await query<{ id: string }>(`INSERT INTO invoices (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status) VALUES ($1, $2, $3, $4, 'TWD', $5, $6, 'open') RETURNING id::text`,
    [o.orgId, o.property, lease, randomUUID(), invoice.due, invoice.period ?? null])).rows[0].id;
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor) VALUES ($1, $2, 1, 'rent', 'Synthetic rent', $3, $4)`, [o.orgId, id, invoice.amount ?? 1_850_000, invoice.amount ?? 1_850_000]);
  return { lease, invoice: id, o };
}
type L = Awaited<ReturnType<typeof makeLease>>;
let minute = 0;
async function report(l: L, t: Tenant, amount: number, status: "submitted" | "rejected" = "submitted") {
  await query(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, rejected_reason)
     VALUES ($1, $2, $3, $4, 'TWD', $5, '2090-01-10', 'bank_transfer', $6::payment_status, 'tenant_portal', $7, $8::timestamptz, $9)`,
    [l.o.orgId, l.o.property, l.lease, t.contact, amount, status, t.userId, new Date(Date.UTC(2090, 0, 10, 0, minute++)).toISOString(), status === "rejected" ? "Synthetic reason" : null]);
}
async function home(t: Tenant, lease: string) {
  const h = await tenantPaymentHistory(t.s, lease, { view: "current", home: true });
  assert.equal(h.state, "ready", `history ${h.state}`);
  if (h.state !== "ready" || !h.home) throw new Error("no home facts");
  return h.home;
}
let ticketNo = 1;
const ticket = (l: L, status: string, title: string) => query(
  `INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, lease_id, title, status) VALUES ($1, $2, $3, $4, $5, $6::ticket_status)`,
  [l.o.orgId, ticketNo++, l.o.property, l.lease, title, status]);

test("TEN-54-AC1: own waiting reports are summed; a co-tenant's or another lease's never count", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const shared = await makeLease(o, [alice, bob]);
  const other = await makeLease(o, [stranger]);
  assert.deepEqual(await home(alice, shared.lease), { pendingMinor: 0, nextDue: { month: "2090-03", dueOn: "2090-03-05" }, overdue: null, paidMonth: null });
  await report(shared, alice, 1_500_000);
  await report(shared, alice, 100, "rejected");
  await report(shared, bob, 350_000);
  await report(other, stranger, 1_850_000);
  assert.equal((await home(alice, shared.lease)).pendingMinor, 1_500_000);
  assert.equal((await home(bob, shared.lease)).pendingMinor, 350_000);
  const view = await tenantHomeView(alice.s, shared.lease);
  assert.deepEqual(view.state === "ready" && view.headline, { kind: "partial", month: "2090-03", restMinor: 350_000 });
  assert.equal(view.state === "ready" && view.waiting, true);
  await report(shared, alice, 350_000);
  const full = await tenantHomeView(alice.s, shared.lease);
  assert.deepEqual(full.state === "ready" && full.headline, { kind: "reported", amountMinor: 1_850_000 });
  // not a party to the other lease, or a session of another org for the same person: nothing is read
  assert.equal((await tenantPaymentHistory(alice.s, other.lease, { view: "current", home: true })).state, "unavailable");
  assert.equal((await tenantHomeView(alice.s, other.lease)).state, "error");
  const elsewhere = await makeOrg();
  await makeTenant(elsewhere.orgId, alice.userId);
  assert.equal((await tenantPaymentHistory({ ...alice.s, orgId: elsewhere.orgId, liveOrgId: elsewhere.orgId }, shared.lease, { view: "current", home: true })).state, "unavailable");
  // nothing is added unless the page asks for it
  const plain = await tenantPaymentHistory(alice.s, shared.lease, { view: "current" });
  assert.equal(plain.state === "ready" && "home" in plain, false);
});

test("TEN-54-AC1: overdue days follow the property's date; a confirmed (paid) bill gives 已繳清 with its month", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const late = await makeLease(o, [t], { due: "2020-01-05" });
  const f = await home(t, late.lease);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.deepEqual(f.overdue, { month: "2020-01", days: (Date.parse(`${today}T00:00:00Z`) - Date.parse("2020-01-05T00:00:00Z")) / 86_400_000 });
  const lateView = await tenantHomeView(t.s, late.lease);
  assert.equal(lateView.state === "ready" && lateView.headline.kind, "overdue");
  await query(`UPDATE invoices SET status = 'paid', paid_minor = total_minor WHERE id = $1`, [late.invoice]);
  const paid = await tenantHomeView(t.s, late.lease);
  assert.deepEqual(paid.state === "ready" && paid.headline, { kind: "paid", month: "2020-01" });
});

test("TEN-54-AC2: repair cards come from the tenant's own selected lease only, open ones only", async () => {
  const o = await makeOrg();
  const mine = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const a = await makeLease(o, [mine]), b = await makeLease(o, [stranger]);
  await ticket(a, "open", "浴室天花板滴水");
  await ticket(a, "cancelled", "取消的");
  await ticket(b, "open", "別人的報修");
  const view = await tenantHomeView(mine.s, a.lease);
  assert.equal(view.state, "ready");
  assert.deepEqual(view.state === "ready" && view.repairs.map(r => [r.title, r.step]), [["浴室天花板滴水", "reported"]]);
  const theirs = await tenantHomeView(stranger.s, b.lease);
  assert.deepEqual(theirs.state === "ready" && theirs.repairs.map(r => r.title), ["別人的報修"]);
});

test("TEN-54: with tenant_payment_history off the view is 'off' (the existing body renders)", async () => {
  const o = await makeOrg(false);
  const t = await makeTenant(o.orgId);
  const l = await makeLease(o, [t]);
  assert.equal((await tenantHomeView(t.s, l.lease)).state, "off");
});
