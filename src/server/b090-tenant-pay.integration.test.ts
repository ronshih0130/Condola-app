import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tenantPayView } from "./b090-tenant-pay";
import { buildStoredConsent } from "./consent";
import { recordPayment } from "./domain";
import { query } from "./db";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53). The 繳款 facts come from the existing tenant payment-history
// reader (`pay: true`) under the tenant's own RLS: the lease-wide waiting total (the B-087 guard's predicate), the
// caller's own last 帳號末五碼, and the property's date. The form posts to the existing recordPayment; the server's
// B-087 guard accepts exactly the rest the page shows. Synthetic data only.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let historySetting: unknown;
const savedBrandV2 = process.env.BRAND_V2;
test.before(async () => {
  delete process.env.BRAND_V2;
  historySetting = (await query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'tenant_payment_history'`)).rows[0]?.value ?? null;
});
test.after(async () => {
  if (savedBrandV2 === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = savedBrandV2;
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
async function makeOrg(opts: { history?: boolean; v3?: boolean } = {}): Promise<Org> {
  const tag = `b090pay.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency) VALUES ($1, 'TW', 'TWD') RETURNING id::text`, [tag])).rows[0].id;
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId, `${tag} 樓`])).rows[0].id;
  if (opts.history !== false) {
    await query(
      `INSERT INTO platform_settings (key, value) VALUES ('tenant_payment_history', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text), 'b090_test', true))
       ON CONFLICT (key) DO UPDATE SET value = jsonb_set(jsonb_set(platform_settings.value, '{enabled}', 'true'::jsonb),
         '{allowed_org_ids}', coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))`, [orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"tenant_payment_history":true}'::jsonb WHERE id = $1`, [orgId]);
  }
  if (opts.v3) await query(`UPDATE organizations SET feature_flags = feature_flags || '{"brand_v2":true,"brand_v3":true}'::jsonb WHERE id = $1`, [orgId]);
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
async function makeLease(o: Org, parties: Tenant[], amount = 1_850_000) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode) VALUES ($1, $2, $3, 'by_room') RETURNING id::text`, [o.orgId, o.property, `F${seq++}`])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'A') RETURNING id::text`, [o.orgId, unit])).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases (org_id, property_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency, rent_amount_minor)
     VALUES ($1, $2, $3, $4, 'active', 'imported', '2020-01-01', '2090-12-31', 'TWD', 0) RETURNING id::text`, [o.orgId, o.property, unit, room])).rows[0].id;
  for (const [i, t] of parties.entries()) await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, $4)`, [o.orgId, lease, t.contact, i === 0 ? "primary" : "co_tenant"]);
  const id = (await query<{ id: string }>(`INSERT INTO invoices (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status) VALUES ($1, $2, $3, $4, 'TWD', '2090-03-05', '2090-03-01', 'open') RETURNING id::text`,
    [o.orgId, o.property, lease, randomUUID()])).rows[0].id;
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor) VALUES ($1, $2, 1, 'rent', 'Synthetic rent', $3, $4)`, [o.orgId, id, amount, amount]);
  return { lease, invoice: id, o };
}
type L = Awaited<ReturnType<typeof makeLease>>;
let minute = 0;
async function report(l: L, t: Tenant, amount: number, status: "submitted" | "rejected" | "confirmed" = "submitted", last5: string | null = null, paidOn = "2090-01-10") {
  return (await query<{ id: string }>(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, rejected_reason, payer_account_last5, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, $4, 'TWD', $5, $6, 'bank_transfer', $7::payment_status, 'tenant_portal', $8, $9::timestamptz, $10, $11,
       CASE WHEN $7 = 'confirmed' THEN $8::uuid END, CASE WHEN $7 = 'confirmed' THEN now() END) RETURNING id::text`,
    [l.o.orgId, l.o.property, l.lease, t.contact, amount, paidOn, status, t.userId, new Date(Date.UTC(2090, 0, 10, 0, minute++)).toISOString(), status === "rejected" ? "Synthetic reason" : null, last5])).rows[0].id;
}
async function pay(t: Tenant, lease: string) {
  const h = await tenantPaymentHistory(t.s, lease, { view: "current", pay: true });
  assert.equal(h.state, "ready", `history ${h.state}`);
  if (h.state !== "ready" || !h.pay) throw new Error("no pay facts");
  return h.pay;
}
const taipeiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("TEN-53-AC4 / AC1: lease-wide waiting total; own last 末五碼 only; the property's date", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const shared = await makeLease(o, [alice, bob]);
  const other = await makeLease(o, [stranger]);
  assert.deepEqual(await pay(alice, shared.lease), { leasePendingMinor: 0, lastLast5: null, today: taipeiToday() }, "nothing stored: no prefill");
  await report(shared, alice, 1_000_000, "submitted", "11111");
  await report(shared, alice, 100, "rejected", "22222");
  await report(shared, alice, 50, "submitted", null);
  await report(shared, bob, 500_000, "submitted", "99999");
  await report(other, stranger, 1_850_000, "submitted", "77777");
  // the B-087 predicate: every waiting tenant report on this lease (a co-tenant's included), never a refused one or another lease's
  assert.equal((await pay(alice, shared.lease)).leasePendingMinor, 1_500_050);
  assert.equal((await pay(bob, shared.lease)).leasePendingMinor, 1_500_050);
  assert.equal((await pay(stranger, other.lease)).leasePendingMinor, 1_850_000);
  // the newest stored 末五碼 the caller typed (a refused report counts as "typed"); a co-tenant's never
  assert.equal((await pay(alice, shared.lease)).lastLast5, "22222");
  assert.equal((await pay(bob, shared.lease)).lastLast5, "99999");
  // nothing is added unless the page asks for it
  const plain = await tenantPaymentHistory(alice.s, shared.lease, { view: "current" });
  assert.equal(plain.state === "ready" && "pay" in plain, false);
});

test("TEN-52 / TEN-53: a tenant reads only their own lease and org", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const mine = await makeLease(o, [alice]), theirs = await makeLease(o, [stranger]);
  await report(theirs, stranger, 1_000, "submitted", "77777");
  assert.equal((await tenantPaymentHistory(alice.s, theirs.lease, { view: "current", pay: true })).state, "unavailable");
  assert.equal((await tenantPayView(alice.s, theirs.lease)).state, "error");
  // the same person with a session in another org reads nothing of this lease
  const elsewhere = await makeOrg();
  await makeTenant(elsewhere.orgId, alice.userId);
  assert.equal((await tenantPaymentHistory({ ...alice.s, orgId: elsewhere.orgId, liveOrgId: elsewhere.orgId }, mine.lease, { view: "current", pay: true })).state, "unavailable");
  assert.equal((await pay(alice, mine.lease)).lastLast5, null, "another tenant's 末五碼 never leaks in");
});

test("TEN-53-AC4: the page's rest is exactly what the server's B-087 guard accepts, through the existing recordPayment", async () => {
  const o = await makeOrg({ v3: true });
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId);
  const l = await makeLease(o, [alice, bob]);
  await report(l, bob, 1_500_000, "submitted", "99999");
  const view = await tenantPayView(alice.s, l.lease);
  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.deepEqual([view.pay.restMinor, view.pay.canReport, view.pay.waiting], [350_000, true, { pendingMinor: 1_500_000, restMinor: 350_000 }]);
  assert.deepEqual(view.account, { kind: "none" }, "no payee account set: 「管理方還沒提供匯款帳戶」");
  // one dollar over the rest: refused by the server (「金額超過還沒回報的部分」), nothing written
  const before = (await query(`SELECT count(*)::int n FROM payments WHERE lease_id = $1`, [l.lease])).rows[0];
  await assert.rejects(recordPayment(alice.s, { leaseId: l.lease, amountMajor: 3_501, paidOn: view.today, last5: "54321", reference: "" }), (e: unknown) => (e as { key?: string }).key === "errors.amountOverUnreported");
  assert.deepEqual((await query(`SELECT count(*)::int n FROM payments WHERE lease_id = $1`, [l.lease])).rows[0], before);
  // exactly the rest: saved as a waiting report with the typed 末五碼 and 備註
  const saved = await recordPayment(alice.s, { leaseId: l.lease, amountMajor: 3_500, paidOn: view.today, last5: "54321", reference: "分兩次匯" });
  assert.equal(saved.status, "submitted");
  const row = (await query<{ amount: string; last5: string; reference: string; status: string; paid_on: string }>(`SELECT amount_minor::text amount, payer_account_last5 last5, reference, status::text, paid_on::text FROM payments WHERE id = $1`, [saved.paymentId])).rows[0];
  assert.deepEqual(row, { amount: "350000", last5: "54321", reference: "分兩次匯", status: "submitted", paid_on: view.today });
  // all reported now: no 「回報已繳」, only the waiting line; the next form would prefill the 末五碼 just used
  const after = await tenantPayView(alice.s, l.lease);
  assert.equal(after.state === "ready" && after.pay.canReport, false);
  assert.deepEqual(after.state === "ready" && after.pay.waiting, { pendingMinor: 1_850_000, restMinor: 0 });
  assert.equal(after.state === "ready" && after.lastLast5, "54321");
  await assert.rejects(recordPayment(alice.s, { leaseId: l.lease, amountMajor: 1, paidOn: view.today, last5: "54321", reference: "" }), (e: unknown) => (e as { key?: string }).key === "errors.amountOverUnreported");
});

test("TEN-52-AC3: 「之前的繳款」 lines are built from the tenant's own reports", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId);
  const l = await makeLease(o, [alice, bob]);
  await report(l, alice, 1_850_000, "confirmed", "11111", "2090-01-04");
  await report(l, alice, 1_850_000, "rejected", "11111", "2090-02-04");
  await report(l, bob, 1_850_000, "confirmed", "99999", "2090-02-05");
  const view = await tenantPayView(alice.s, l.lease);
  assert.deepEqual(view.state === "ready" && view.history.map(h => [h.month, h.status, h.amountMinor, h.reason]), [
    ["2090-02", "rejected", 1_850_000, "Synthetic reason"], ["2090-01", "confirmed", 1_850_000, null],
  ], "a co-tenant's report is not listed as the caller's");
});

test("TEN-52: with tenant_payment_history off the view is 'off' (the existing body renders)", async () => {
  const o = await makeOrg({ history: false });
  const t = await makeTenant(o.orgId);
  const l = await makeLease(o, [t]);
  assert.equal((await tenantPayView(t.s, l.lease)).state, "off");
});
