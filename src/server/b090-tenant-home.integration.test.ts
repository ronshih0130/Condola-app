import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as governance from "./b017-custom-role-governance";
import * as consentModule from "./consent";
import * as db from "./db";
import * as errors from "./errors";
import * as money from "./money";
import * as payNote from "./pay-note";
import * as repairRules from "./repair-rules";
import * as historyRules from "./tenant-payment-history-rules";
import * as monthlyDue from "./tenant-monthly-due-rules";
import { tenantHomeView } from "./b090-tenant-home";
import { tenantHomeRead } from "./b090-tenant-home-reader";
import { buildStoredConsent } from "./consent";
import { confirmPayment } from "./domain";
import { query } from "./db";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-090 slice 1, RT-HOME (TEN-54), re-land (PENDING-RON PR-043). The 首頁 facts are read only for the tenant's own
// selected lease, through the v3-only reader (b090-tenant-home-reader.ts) and the existing tenant repair reader.
// Waiting reports count lease-wide, a co-tenant's included (PR-042 (1) = a, the B-087 limit). The shared
// tenantPaymentHistory reader is checked against origin/main's on a real database. Synthetic data only.

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
async function addInvoice(l: L, due: string, period: string, amount: number) {
  const id = (await query<{ id: string }>(`INSERT INTO invoices (org_id, property_id, lease_id, invoice_number, currency, due_date, period_start, status) VALUES ($1, $2, $3, $4, 'TWD', $5, $6, 'open') RETURNING id::text`,
    [l.o.orgId, l.o.property, l.lease, randomUUID(), due, period])).rows[0].id;
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor) VALUES ($1, $2, 1, 'rent', 'Synthetic rent', $3, $4)`, [l.o.orgId, id, amount, amount]);
  return id;
}
async function manager(orgId: string): Promise<Session> {
  const userId = await user("manager");
  await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager'::org_role, 'active')`, [orgId, userId]);
  return { userId, sessionId: await sessionRow(userId), email: "", name: "manager", kind: "staff", role: "manager", orgId, liveOrgId: orgId, environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
}
let minute = 0;
async function report(l: L, t: Tenant, amount: number, status: "submitted" | "rejected" = "submitted") {
  return (await query<{ id: string }>(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, rejected_reason)
     VALUES ($1, $2, $3, $4, 'TWD', $5, '2090-01-10', 'bank_transfer', $6::payment_status, 'tenant_portal', $7, $8::timestamptz, $9) RETURNING id::text`,
    [l.o.orgId, l.o.property, l.lease, t.contact, amount, status, t.userId, new Date(Date.UTC(2090, 0, 10, 0, minute++)).toISOString(), status === "rejected" ? "Synthetic reason" : null])).rows[0].id;
}
async function home(t: Tenant, lease: string) {
  const h = await tenantHomeRead(t.s, lease);
  assert.equal(h.state, "ready", `home ${h.state}`);
  if (h.state !== "ready") throw new Error("no home facts");
  return h.facts;
}
let ticketNo = 1;
const ticket = (l: L, status: string, title: string) => query(
  `INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, lease_id, title, status) VALUES ($1, $2, $3, $4, $5, $6::ticket_status)`,
  [l.o.orgId, ticketNo++, l.o.property, l.lease, title, status]);

test("TEN-54-AC1 / PR-042 (1) = a: the lease's waiting reports are summed, a co-tenant's included; another lease's never", async () => {
  const o = await makeOrg();
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const shared = await makeLease(o, [alice, bob]);
  const other = await makeLease(o, [stranger]);
  assert.deepEqual(await home(alice, shared.lease), { pendingMinor: 0, nextDue: { month: "2090-03", dueOn: "2090-03-05" }, overdue: null, paidMonth: null });
  await report(shared, alice, 1_000_000);
  await report(shared, alice, 100, "rejected");
  await report(shared, bob, 350_000);
  await report(other, stranger, 1_850_000);
  // Rejected reports never count; another lease's never count; both co-tenants see the same lease-wide sum.
  assert.equal((await home(alice, shared.lease)).pendingMinor, 1_350_000);
  assert.equal((await home(bob, shared.lease)).pendingMinor, 1_350_000);
  assert.equal((await home(stranger, other.lease)).pendingMinor, 1_850_000);
  const view = await tenantHomeView(alice.s, shared.lease);
  assert.deepEqual(view.state === "ready" && view.headline, { kind: "partial", month: "2090-03", restMinor: 500_000 });
  assert.equal(view.state === "ready" && view.waiting, true);
  // The co-tenant's report closes the gap: both tenants read 已回報 with the lease's waiting total (the 繳款 page's 還差 is 0).
  await report(shared, bob, 500_000);
  for (const t of [alice, bob]) {
    const full = await tenantHomeView(t.s, shared.lease);
    assert.deepEqual(full.state === "ready" && full.headline, { kind: "reported", amountMinor: 1_850_000 });
    assert.equal(full.state === "ready" && full.waiting, true);
  }
  // Only a co-tenant has reported: 首頁 still counts it (還差 = owed minus the lease's waiting reports).
  const solo = await makeLease(o, [alice, bob]);
  await report(solo, bob, 850_000);
  const coOnly = await tenantHomeView(alice.s, solo.lease);
  assert.deepEqual(coOnly.state === "ready" && coOnly.headline, { kind: "partial", month: "2090-03", restMinor: 1_000_000 });
  // not a party to the other lease, or a session of another org for the same person: nothing is read
  assert.equal((await tenantHomeRead(alice.s, other.lease)).state, "unavailable");
  assert.equal((await tenantHomeView(alice.s, other.lease)).state, "error");
  const elsewhere = await makeOrg();
  await makeTenant(elsewhere.orgId, alice.userId);
  assert.equal((await tenantHomeRead({ ...alice.s, orgId: elsewhere.orgId, liveOrgId: elsewhere.orgId }, shared.lease)).state, "unavailable");
  // The shared reader is unchanged: its own (TEN-51) waiting stays the caller's own newest report.
  const plain = await tenantPaymentHistory(alice.s, shared.lease, { view: "current", turn: true });
  assert.equal(plain.state === "ready" && "home" in plain, false);
  assert.deepEqual(plain.state === "ready" && plain.turn?.waiting, { amountMinor: 1_000_000, currency: "TWD" });
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

test("PLT-51 / TEN-54-AC1: settled through the staff confirmation path; an older paid month beside an open one is never 已繳清", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const staff = await manager(o.orgId);
  const l = await makeLease(o, [t], { due: "2090-02-05", period: "2090-02-01", amount: 1_000_000 });
  await addInvoice(l, "2090-03-05", "2090-03-01", 1_850_000);
  // February is reported and confirmed by staff (the app's confirmPayment); March stays open.
  const feb = await report(l, t, 1_000_000);
  const reported = await tenantHomeView(t.s, l.lease);
  assert.deepEqual(reported.state === "ready" && reported.headline, { kind: "partial", month: "2090-02", restMinor: 1_850_000 });
  await confirmPayment(staff, feb);
  assert.equal((await query<{ status: string }>(`SELECT status::text FROM invoices WHERE id = $1`, [l.invoice])).rows[0].status, "paid");
  const f = await home(t, l.lease);
  assert.deepEqual({ paidMonth: f.paidMonth, nextDue: f.nextDue, pendingMinor: f.pendingMinor }, { paidMonth: "2090-02", nextDue: { month: "2090-03", dueOn: "2090-03-05" }, pendingMinor: 0 });
  const mixed = await tenantHomeView(t.s, l.lease);
  assert.equal(mixed.state, "ready");
  assert.notEqual(mixed.state === "ready" && mixed.headline.kind, "paid", "an older paid invoice next to an open one is not 已繳清");
  assert.deepEqual(mixed.state === "ready" && mixed.headline, { kind: "due", month: "2090-03", amountMinor: 1_850_000, dueOn: "2090-03-05" }, "March is still owed: 待繳");
  // March reported and confirmed too: now the whole bill is settled by confirmed payments → 已繳清 with its month.
  const mar = await report(l, t, 1_850_000);
  const waiting = await tenantHomeView(t.s, l.lease);
  assert.deepEqual(waiting.state === "ready" && waiting.headline, { kind: "reported", amountMinor: 1_850_000 });
  await confirmPayment(staff, mar);
  const settled = await tenantHomeView(t.s, l.lease);
  assert.deepEqual(settled.state === "ready" && settled.headline, { kind: "paid", month: "2090-03" });
  assert.equal(settled.state === "ready" && settled.waiting, false);
  const read = await tenantHomeRead(t.s, l.lease);
  assert.deepEqual(read.state === "ready" && read.bill, { state: "paid", overdue: false, balanceMinor: 0, paidMinor: 0, currency: "TWD" });
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

// ---------- PR-043: the shared reader runs origin/main's exact statements on a real database ----------
const BASE = "a0aa278e3e92732b066fdbd74bd8f7430d76df0b";
function historyFrom(source: string, log: unknown[][]) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const spy = (c: { query: (...a: unknown[]) => unknown }) => new Proxy(c, { get(target, key, receiver) {
    if (key !== "query") return Reflect.get(target, key, receiver);
    return (sql: unknown, params?: unknown) => { log.push([sql, params ?? null]); return target.query(sql, params); };
  } });
  const mocks: Record<string, unknown> = {
    "@/server/b017-custom-role-governance": governance, "./consent": consentModule, "./errors": errors, "./money": money, "./pay-note": payNote,
    "./repair-rules": repairRules, "./tenant-payment-history-rules": historyRules, "./tenant-monthly-due-rules": monthlyDue,
    "./db": { ...db, tx: (userId: string, fn: (c: never) => Promise<unknown>, ...rest: unknown[]) => (db.tx as (...a: unknown[]) => Promise<unknown>)(userId, (c: never) => fn(spy(c) as never), ...rest) },
  };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => { if (name in mocks) return mocks[name]; throw new Error(`Unmocked dependency: ${name}`); }, exports);
  return exports.tenantPaymentHistory as typeof tenantPaymentHistory;
}

test("PR-043 / OQ-107: on a real database the shared tenantPaymentHistory reader issues origin/main's statements and parameters", async () => {
  const before = execFileSync("git", ["show", `${BASE}:src/server/tenant-payment-history.ts`], { encoding: "utf8" });
  const now = readFileSync("src/server/tenant-payment-history.ts", "utf8");
  const o = await makeOrg(), gateOff = await makeOrg(false);
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId), carol = await makeTenant(gateOff.orgId);
  const l = await makeLease(o, [alice, bob], { due: "2090-02-05", period: "2090-02-01", amount: 1_000_000 });
  await addInvoice(l, "2090-03-05", "2090-03-01", 1_850_000);
  const first = await report(l, alice, 400_000);
  await report(l, bob, 200_000);
  await report(l, alice, 50, "rejected");
  const off = await makeLease(gateOff, [carol]);
  const runs: [Tenant, string, Parameters<typeof tenantPaymentHistory>[2]][] = [
    [alice, l.lease, { view: "current" }], [alice, l.lease, { view: "current", turn: true }], [bob, l.lease, { view: "current", turn: true }],
    [alice, l.lease, { view: "current", reportId: first }], [alice, l.lease, { view: "current", cursor: first }], [alice, l.lease, { view: "ended" }],
    [carol, off.lease, { view: "current" }], [carol, l.lease, { view: "current" }],
  ];
  for (const [t, lease, options] of runs) {
    const baseLog: unknown[][] = [], headLog: unknown[][] = [];
    const baseResult = await historyFrom(before, baseLog)(t.s, lease, { ...options });
    const headResult = await historyFrom(now, headLog)(t.s, lease, { ...options });
    const label = JSON.stringify(options);
    assert.ok(baseLog.length > 0, label);
    assert.deepEqual(headLog, baseLog, label);
    assert.deepEqual(headResult, baseResult, label);
    for (const [sql] of headLog) if (String(sql).includes("FROM public.invoices WHERE")) assert.doesNotMatch(String(sql), /period_start/);
  }
});
