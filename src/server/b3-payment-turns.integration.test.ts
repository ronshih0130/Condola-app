import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, PAYMENT_TURN_LIST_LIMIT, staffPaymentTurns, tenantPaymentTurn } from "./b3-payment-turns";
import { governCustomRole, guardEffectiveSession } from "./b017-custom-role-governance";
import { buildStoredConsent } from "./consent";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// Brand 3.0 Batch 3a (B-070): whose turn, payments only. Spec: condola-hub
// 20-build/specs/BRAND-3.0-batch3a-payments-spec.md r4 §6. Stories: PLT-53, MGT-125, MGT-126,
// TEN-51. Synthetic orgs, users and payments only; no outbound.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let historySetting: unknown;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  historySetting = (await query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'tenant_payment_history'`)).rows[0]?.value ?? null;
});
test.after(async () => {
  if (historySetting === null) await query(`DELETE FROM platform_settings WHERE key = 'tenant_payment_history' AND value->>'b3a_test' = 'true'`);
  else await query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'tenant_payment_history'`, [JSON.stringify(historySetting)]);
  await db?.end();
});

const ON = { v3: async () => true };
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
type Role = "admin" | "manager" | "accountant" | "maintenance";
type Org = { orgId: string; property: string; staff: Record<Role, Session>; outsider: string };

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
const staffSession = async (userId: string, role: Role, orgId: string, liveOrgId = orgId, environment: "live" | "sandbox" = "live"): Promise<Session> =>
  ({ userId, sessionId: await sessionRow(userId), email: "", name: role, kind: "staff", role, orgId, liveOrgId, environment, locale: "en", calendar: "gregorian", leaseId: null });

async function makeOrg(): Promise<Org> {
  const tag = `b3a.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency) VALUES ($1, 'TW', 'TWD') RETURNING id::text`, [tag])).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user(role);
    await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')`, [orgId, id, role]);
    staff[role] = await staffSession(id, role, orgId);
  }
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId, `${tag} 樓`])).rows[0].id;
  return { orgId, property, staff, outsider: await user("outsider") };
}

type Tenant = { s: Session; contact: string; userId: string };
async function makeTenant(orgId: string, existingUser?: string): Promise<Tenant> {
  const userId = existingUser ?? await user("tenant");
  const consent = buildStoredConsent("signup");
  await query(`INSERT INTO consents (user_id, accepted_at, terms_version, privacy_version, source) VALUES ($1, $2, $3, $4, $5)`, [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const contact = (await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, is_tenant, display_name) VALUES ($1, $2, true, 'Synthetic tenant') RETURNING id::text`, [orgId, userId])).rows[0].id;
  const s: Session = { userId, sessionId: await sessionRow(userId), email: "", name: "Synthetic", kind: "tenant", role: null, orgId, liveOrgId: orgId, environment: "live", locale: "en", calendar: "gregorian", leaseId: null, consent };
  return { s, contact, userId };
}

let labelSeq = 0;
/** A lease with one open invoice of NT$1,000 (so it has an open balance). */
async function makeLease(o: Org, parties: Tenant[], opts: { orgId?: string; property?: string } = {}) {
  const orgId = opts.orgId ?? o.orgId, property = opts.property ?? o.property;
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label, rental_mode) VALUES ($1, $2, $3, 'by_room') RETURNING id::text`, [orgId, property, `F${labelSeq++}`])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms (org_id, unit_id, label) VALUES ($1, $2, 'A') RETURNING id::text`, [orgId, unit])).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases (org_id, property_id, unit_id, target_room_id, status, esign_status, start_date, end_date, currency, rent_amount_minor)
     VALUES ($1, $2, $3, $4, 'active', 'imported', '2090-01-01', '2090-12-31', 'TWD', 0) RETURNING id::text`, [orgId, property, unit, room])).rows[0].id;
  for (const [i, t] of parties.entries()) {
    await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, $4)`, [orgId, lease, t.contact, i === 0 ? "primary" : "co_tenant"]);
  }
  const invoice = (await query<{ id: string }>(`INSERT INTO invoices (org_id, property_id, lease_id, invoice_number, currency, due_date, status) VALUES ($1, $2, $3, $4, 'TWD', '2090-03-01', 'open') RETURNING id::text`, [orgId, property, lease, randomUUID()])).rows[0].id;
  await query(`INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, unit_amount_minor, amount_minor) VALUES ($1, $2, 1, 'rent', 'Synthetic rent', 100000, 100000)`, [orgId, invoice]);
  return { lease, invoice, orgId, property };
}
type L = Awaited<ReturnType<typeof makeLease>>;
let minute = 0;
/** A payment row in the given state. Direct insert: payment_results_v2 is OFF, so no event is required. */
async function pay(l: L, t: Tenant | null, status: "submitted" | "confirmed" | "rejected" | "reversed", opts: { source?: string; amount?: number; at?: string; confirmer?: string } = {}) {
  const at = opts.at ?? new Date(Date.UTC(2090, 0, 10, 0, minute++)).toISOString();
  const done = status === "confirmed" || status === "reversed";
  return (await query<{ id: string }>(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source,
                           submitted_by, submitted_at, confirmed_by, confirmed_at, rejected_reason)
     VALUES ($1, $2, $3, $4, 'TWD', $5, '2090-01-10', 'bank_transfer', $6::payment_status, $7::payment_source,
             $8, $9::timestamptz, $10, CASE WHEN $10::uuid IS NULL THEN NULL ELSE $9::timestamptz END, $11) RETURNING id::text`,
    [l.orgId, l.property, l.lease, t?.contact ?? null, opts.amount ?? 50000, status, opts.source ?? "tenant_portal",
     t?.userId ?? null, at, done ? (opts.confirmer ?? t?.userId ?? null) : null, status === "rejected" ? "Synthetic reason" : null])).rows[0].id;
}
const settle = (l: L) => query(`UPDATE invoices SET status = 'paid', paid_minor = total_minor WHERE id = $1`, [l.invoice]);
async function ready(s: Session, deps: Parameters<typeof staffPaymentTurns>[1] = ON) {
  const r = await staffPaymentTurns(s, deps);
  assert.equal(r.state, "ready");
  if (r.state !== "ready") throw new Error("not ready");
  return r;
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("PLT-53 rules P1–P5: holder, step, since and exactness; a staff-entered payment is never a matter", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const [a, b, c, d, e] = [await makeLease(o, [t]), await makeLease(o, [t]), await makeLease(o, [t]), await makeLease(o, [t]), await makeLease(o, [t])];
  const p1 = await pay(a, t, "submitted", { at: "2090-01-05T03:00:00.000Z", amount: 3200000 });
  const p2 = await pay(b, t, "rejected");
  const p3 = await pay(c, t, "rejected"); await settle(c); // rejected, nothing owed any more
  await pay(d, t, "confirmed");
  await pay(e, t, "reversed");
  await pay(e, null, "confirmed", { source: "manager_entry", confirmer: o.staff.admin.userId });
  const r = await ready(o.staff.accountant);
  assert.deepEqual(r.counts, [{ holder: "manager", step: "confirm_payment", count: 1 }, { holder: "tenant", step: "re_report", count: 1 }]);
  assert.equal(r.yourTurn, 1);
  assert.deepEqual(ids(r.mine), [p1]);
  assert.deepEqual(ids(r.others), [p2]);
  assert.ok(!ids([...r.mine, ...r.others]).includes(p3));
  const m = r.mine[0];
  assert.deepEqual({ rule: m.rule, holder: m.holder, step: m.step, since: m.since, sinceExact: m.sinceExact, timezone: m.timezone, amountMinor: m.amountMinor, currency: m.currency, leaseId: m.leaseId, tenantName: m.tenantName },
    { rule: "P1", holder: "manager", step: "confirm_payment", since: "2090-01-05T03:00:00.000000Z", sinceExact: true, timezone: "Asia/Taipei", amountMinor: 3200000, currency: "TWD", leaseId: a.lease, tenantName: "Synthetic tenant" });
  assert.match(m.place, /樓 A$/);
  const t2 = r.others[0];
  assert.deepEqual({ rule: t2.rule, holder: t2.holder, step: t2.step, sinceExact: t2.sinceExact }, { rule: "P2", holder: "tenant", step: "re_report", sinceExact: false });
});

test("PLT-53 P2 edges: unrelated confirmed payment keeps it; a pending report, a zero balance or a newer rejection clears it", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  // rejected, then an unrelated confirmed payment, balance still open → still P2
  const a = await makeLease(o, [t]); const a1 = await pay(a, t, "rejected"); await pay(a, t, "confirmed");
  // rejected, then a new pending report → the rejected one is finished, the new one is P1
  const b = await makeLease(o, [t]); const b1 = await pay(b, t, "rejected"); const b2 = await pay(b, t, "submitted");
  // rejected, balance paid to zero → finished
  const c = await makeLease(o, [t]); const c1 = await pay(c, t, "rejected"); await settle(c);
  // two rejected reports → only the more recently submitted one
  const d = await makeLease(o, [t]); const d1 = await pay(d, t, "rejected"); const d2 = await pay(d, t, "rejected");
  // a pending report sent BEFORE the other report was rejected → no P2 (r3 tightening, OQ-036)
  const e = await makeLease(o, [t]); const e1 = await pay(e, t, "submitted"); const e2 = await pay(e, t, "rejected");
  const r = await ready(o.staff.manager);
  assert.deepEqual(ids(r.others).sort(), [a1, d2].sort());
  assert.deepEqual(ids(r.mine).sort(), [b2, e1].sort());
  for (const gone of [b1, c1, d1, e2]) assert.ok(!ids([...r.mine, ...r.others]).includes(gone));
});

test("MGT-125-AC1 / A3: counts are taken before the list limit, oldest first, from one snapshot", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const l = await makeLease(o, [t]);
  await query(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at)
     SELECT $1, $2, $3, $4, 'TWD', 1000 + n, '2090-01-10', 'bank_transfer', 'submitted', 'tenant_portal', $5, '2090-02-01T00:00:00Z'::timestamptz + n * interval '1 minute'
       FROM generate_series(1, 120) n`, [o.orgId, o.property, l.lease, t.contact, t.userId]);
  await pay(l, t, "confirmed"); await pay(l, t, "reversed");
  const r = await ready(o.staff.admin);
  assert.equal(r.yourTurn, 120);
  assert.equal(r.mine.length, PAYMENT_TURN_LIST_LIMIT);
  assert.deepEqual(r.mine.map((m) => m.amountMinor), Array.from({ length: 50 }, (_, i) => 1001 + i), "oldest first");
  assert.equal(r.others.length, 0);

  // Another connection rejects a report between the reader's count and list statements. A native
  // accountant gets no snapshot from effectiveReadOptions, so the reader must ask for it itself.
  const o2 = await makeOrg();
  const t2 = await makeTenant(o2.orgId);
  const l2 = await makeLease(o2, [t2]);
  const only = await pay(l2, t2, "submitted");
  let options: unknown;
  const racing: typeof tx = (userId, fn, scope, opts) => {
    options = opts;
    return tx(userId, async (client) => {
      const run = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
        const out = await run(...a);
        if (a[0] === COUNTS_SQL_FOR_TEST) await query(`UPDATE payments SET status = 'rejected', rejected_reason = 'race' WHERE id = $1`, [only]);
        return out;
      };
      return fn(client);
    }, scope, opts);
  };
  const raced = await ready(o2.staff.accountant, { ...ON, transaction: racing });
  assert.deepEqual(options, { isolation: "repeatable read", readOnly: true });
  assert.equal(raced.yourTurn, 1);
  assert.deepEqual(ids(raced.mine), [only], "the list describes the same state as the count");
  assert.equal((await ready(o2.staff.accountant)).yourTurn, 0, "the next read sees the rejection");
});

test("PLT-53-AC6 / A1: only staff with pay.record are admitted; a refusal is errors.forbidden, never an empty list", async () => {
  const o = await makeOrg();
  const other = await makeOrg();
  const t = await makeTenant(o.orgId);
  const l = await makeLease(o, [t]);
  const p = await pay(l, t, "submitted");
  for (const role of ["admin", "manager", "accountant"] as const) assert.deepEqual(ids((await ready(o.staff[role])).mine), [p], role);
  await assert.rejects(staffPaymentTurns(o.staff.maintenance, ON), forbidden, "native maintenance");
  await assert.rejects(staffPaymentTurns(t.s, ON), forbidden, "tenant session");
  await assert.rejects(staffPaymentTurns({ ...t.s, kind: "owner" }, ON), forbidden, "owner session");
  // The session check comes first and by itself: no transaction is opened for a refused session,
  // and a session that does not say "staff with pay.record" is refused even when the database
  // would call the user an active admin (assertPerm, not only app.has_role).
  let opened = 0;
  const counting: typeof tx = (...a) => { opened += 1; return tx(...a); };
  for (const refused of [o.staff.maintenance, t.s, { ...o.staff.admin, kind: "tenant" as const, role: null }, { ...o.staff.admin, role: "maintenance" as const }]) {
    await assert.rejects(staffPaymentTurns(refused as Session, { ...ON, transaction: counting }), forbidden);
  }
  assert.equal(opened, 0, "refused before any transaction");
  // a member of another org with a session scoped to this org: the database check refuses
  await assert.rejects(staffPaymentTurns({ ...other.staff.admin, orgId: o.orgId, liveOrgId: o.orgId }, ON), forbidden, "cross-org session");
  // and their own org never shows this org's matter
  assert.equal((await ready(other.staff.admin)).yourTurn, 0);
});

test("PLT-53-AC6 / A1 with custom roles ON: stmt.view without pay.record gets nothing; pay.record gets the matters", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const p = await pay(await makeLease(o, [t]), t, "submitted");
  await query(`UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.admin.userId]);
  const savedEnv = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const saved = (await query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'custom_roles'`)).rows[0]?.value ?? null;
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}'::jsonb WHERE id = $1`, [o.orgId]);
    const memberId = async (s: Session) => (await query<{ id: string }>(`SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`, [o.orgId, s.userId])).rows[0].id;
    const give = async (s: Session, grants: string[]) => {
      const created = await governCustomRole(o.staff.admin, { operation: "create", grants, requestId: randomUUID() });
      assert.ok(created.roleId);
      await governCustomRole(o.staff.admin, { operation: "assign", roleId: created.roleId!, memberId: await memberId(s), requestId: randomUUID() });
    };
    await give(o.staff.accountant, ["stmt.view", "dash.view"]);
    await give(o.staff.manager, ["pay.record", "dash.view"]);
    await assert.rejects(staffPaymentTurns(o.staff.accountant, ON), forbidden, "custom role with stmt.view only");
    const r = await ready(o.staff.manager);
    assert.equal(r.yourTurn, 1);
    assert.deepEqual(ids(r.mine), [p]);
    // an unassigned native role in the same org is unaffected
    assert.deepEqual(ids((await ready(o.staff.admin)).mine), [p]);
  } finally {
    if (savedEnv === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedEnv;
    if (saved === null) await query(`DELETE FROM platform_settings WHERE key = 'custom_roles'`);
    else await query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'custom_roles'`, [JSON.stringify(saved)]);
    await query(`UPDATE organizations SET feature_flags = feature_flags - 'custom_roles' WHERE id = $1`, [o.orgId]);
  }
});

test("PLT-53-AC6: a suspended staff member who is still a tenant of a lease here is refused, not shown their own lease's reports", async () => {
  const o = await makeOrg();
  const both = await makeTenant(o.orgId, o.staff.manager.userId); // the manager is also a lease party
  const l = await makeLease(o, [both]);
  const own = await pay(l, both, "submitted");
  const elsewhere = await pay(await makeLease(o, [await makeTenant(o.orgId)]), null, "submitted");
  assert.deepEqual(ids((await ready(o.staff.manager)).mine).sort(), [own, elsewhere].sort(), "as active staff: every matter of the org");
  await query(`UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.manager.userId]);
  // the tenant policy alone would still return the row to this person:
  const visible = await tx(o.staff.manager.userId, async (c) => (await c.query(`SELECT 1 FROM payments WHERE id = $1`, [own])).rowCount, { orgId: o.orgId, environment: "live" });
  assert.equal(visible, 1, "tenant_payments_read still shows the row");
  await assert.rejects(staffPaymentTurns(o.staff.manager, ON), forbidden);
});

test("PLT-53 environment: live and sandbox stay apart; sandbox-only membership does not admit the live parent; a wrong pin is refused", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  const live = await pay(await makeLease(o, [t]), t, "submitted");
  const sandboxId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id) VALUES ('b3a sandbox', 'TW', 'TWD', 'sandbox', $1) RETURNING id::text`, [o.orgId])).rows[0].id;
  const sbProperty = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, 'b3a sb', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [sandboxId])).rows[0].id;
  const sbTenant = await makeTenant(sandboxId);
  const sb = await pay(await makeLease(o, [sbTenant], { orgId: sandboxId, property: sbProperty }), sbTenant, "submitted");
  const admin = o.staff.admin;
  assert.deepEqual(ids((await ready(admin)).mine), [live]);
  assert.deepEqual(ids((await ready({ ...admin, orgId: sandboxId, environment: "sandbox" })).mine), [sb]);
  // wrong environment for the selected org
  await assert.rejects(staffPaymentTurns({ ...admin, orgId: sandboxId, environment: "live" }, ON), forbidden);
  await assert.rejects(staffPaymentTurns({ ...admin, environment: "sandbox" }, ON), forbidden);
  // membership recorded on the sandbox org only does not admit the live parent
  const sbOnly = await user("sbonly");
  await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [sandboxId, sbOnly]);
  await assert.rejects(staffPaymentTurns(await staffSession(sbOnly, "admin", o.orgId), ON), forbidden);
});

test("database-level denial of the reader's own SQL: anon is denied; a pinned non-member is not staff and reads nothing", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  await pay(await makeLease(o, [t]), t, "submitted");
  for (const sql of [COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST]) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      await assert.rejects(db.query(sql, sql === LISTS_SQL_FOR_TEST ? [o.orgId, 50] : [o.orgId]), (e: unknown) => {
        const err = e as { code?: string; message?: string };
        return err.code === "42501" && /^permission denied for table (payments|invoices)$/.test(err.message ?? "");
      });
    } finally { await db.query("ROLLBACK"); }
  }
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true), set_config('app.active_org_id', $2, true), set_config('app.env', 'live', true)`, [o.outsider, o.orgId]);
    await db.query("SET LOCAL ROLE authenticated");
    assert.equal((await db.query(`SELECT app.has_role($1::uuid, '{admin,manager,accountant}'::org_role[]) AS ok`, [o.orgId])).rows[0].ok, false);
    assert.equal((await db.query(COUNTS_SQL_FOR_TEST, [o.orgId])).rowCount, 0);
    assert.equal((await db.query(LISTS_SQL_FOR_TEST, [o.orgId, 50])).rowCount, 0);
  } finally { await db.query("ROLLBACK"); }
});

test("MGT-125-AC4 / PLT-46: with brand_v3 OFF the reader opens no transaction and sends no business query", async () => {
  const o = await makeOrg();
  let opened = 0;
  const counting: typeof tx = (...a) => { opened += 1; return tx(...a); };
  assert.deepEqual(await staffPaymentTurns(o.staff.admin, { v3: async () => false, transaction: counting }), { state: "off" });
  assert.equal(opened, 0);
  // even a session that would be refused is simply "off": nothing is evaluated
  assert.deepEqual(await staffPaymentTurns(o.staff.maintenance, { v3: async () => false, transaction: counting }), { state: "off" });
  assert.equal(opened, 0);
  // the real lookup: a synthetic org has no brand_v3 flag
  assert.deepEqual(await staffPaymentTurns(o.staff.admin), { state: "off" });
  await ready(o.staff.admin, { ...ON, transaction: counting });
  assert.equal(opened, 1);
});

test("MGT-125-AC3: a statement timeout after an earlier statement succeeded is 'unavailable', never zero", async () => {
  const o = await makeOrg();
  const t = await makeTenant(o.orgId);
  await pay(await makeLease(o, [t]), t, "submitted");
  const seen = { counts: 0, lists: 0, cancelled: null as { code?: string; message?: string } | null };
  const slow: typeof tx = (userId, fn, scope, opts) => tx(userId, async (client) => {
    const run = client.query.bind(client) as (...a: unknown[]) => Promise<{ rows: unknown[] }>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      if (a[0] === LISTS_SQL_FOR_TEST) {
        seen.lists += 1;
        // longer than the reader's own 2-second statement timeout, which must cancel it
        try { await run("SELECT pg_sleep(30)"); } catch (e) { seen.cancelled = e as { code?: string; message?: string }; throw e; }
      }
      const out = await run(...a);
      if (a[0] === COUNTS_SQL_FOR_TEST) { seen.counts += 1; assert.equal((out.rows as { count: number }[])[0]?.count, 1, "the count statement succeeded first"); }
      return out;
    };
    return fn(client);
  }, scope, opts);
  const started = Date.now();
  assert.deepEqual(await staffPaymentTurns(o.staff.admin, { ...ON, transaction: slow }), { state: "unavailable" });
  assert.deepEqual({ counts: seen.counts, lists: seen.lists }, { counts: 1, lists: 1 }, "counts completed, then the list statement was reached");
  assert.equal(seen.cancelled?.code, "57014");
  assert.match(seen.cancelled?.message ?? "", /statement timeout/);
  assert.ok(Date.now() - started < 20_000, "cancelled by the statement timeout, long before the 30-second sleep");
  // a refusal inside the same path is still a refusal, not "unavailable"
  await assert.rejects(staffPaymentTurns(o.staff.maintenance, { ...ON, transaction: slow }), forbidden);
});

test("MGT-125-AC3: a failure during admission is 'unavailable'; a refusal during admission is still a refusal", async () => {
  const o = await makeOrg();
  let opened = 0;
  const counting: typeof tx = (...a) => { opened += 1; return tx(...a); };
  // the flag lookup fails operationally: unavailable, not "off" and not an exception
  assert.deepEqual(await staffPaymentTurns(o.staff.admin, { v3: async () => { throw new Error("flag lookup failed"); }, transaction: counting }), { state: "unavailable" });
  assert.equal(opened, 0);
  // the transaction failing to start
  assert.deepEqual(await staffPaymentTurns(o.staff.admin, { ...ON, transaction: (async () => { throw new Error("no connection"); }) as unknown as typeof tx }), { state: "unavailable" });
  // a FlowError that is not a refusal does not escape either
  assert.deepEqual(await staffPaymentTurns(o.staff.admin, { ...ON, transaction: (async () => { throw new FlowError("errors.notFound"); }) as unknown as typeof tx }), { state: "unavailable" });

  // The real custom-role lookup (guardEffectiveSession → a database read) failing operationally.
  // Custom roles are switched on for this org, and the session carries a session id the database
  // cannot parse, so the lookup itself raises; nothing is injected into the reader.
  await query(`UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.admin.userId]);
  const savedEnv = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const saved = (await query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'custom_roles'`)).rows[0]?.value ?? null;
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await query(`INSERT INTO platform_settings (key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
    await query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}'::jsonb WHERE id = $1`, [o.orgId]);
    opened = 0;
    await ready(o.staff.admin, { ...ON, transaction: counting }); // positive control: the lookup works with a real session id
    assert.equal(opened, 1);
    const broken = { ...o.staff.admin, sessionId: "not-a-uuid" };
    await assert.rejects(guardEffectiveSession(broken, "pay.record"), (e: unknown) => !(e instanceof FlowError && e.key === "errors.forbidden"), "the lookup fails with a non-refusal error");
    assert.deepEqual(await staffPaymentTurns(broken, { ...ON, transaction: counting }), { state: "unavailable" });
    assert.equal(opened, 1, "no payment-turn transaction was opened after the failed lookup");
  } finally {
    if (savedEnv === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedEnv;
    if (saved === null) await query(`DELETE FROM platform_settings WHERE key = 'custom_roles'`);
    else await query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'custom_roles'`, [JSON.stringify(saved)]);
    await query(`UPDATE organizations SET feature_flags = feature_flags - 'custom_roles' WHERE id = $1`, [o.orgId]);
  }
  // and the unmodified path still works
  assert.equal((await ready(o.staff.admin)).yourTurn, 0);
});

async function enableHistory(orgId: string) {
  await query(
    `INSERT INTO platform_settings (key, value) VALUES ('tenant_payment_history', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text), 'b3a_test', true))
     ON CONFLICT (key) DO UPDATE SET value = jsonb_set(jsonb_set(platform_settings.value, '{enabled}', 'true'::jsonb),
       '{allowed_org_ids}', coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))`, [orgId]);
  await query(`UPDATE organizations SET feature_flags = feature_flags || '{"tenant_payment_history":true}'::jsonb WHERE id = $1`, [orgId]);
}
async function turnOf(t: Tenant, lease: string, options: { view?: "current" | "ended"; reportId?: string; cursor?: string } = {}) {
  const h = await tenantPaymentHistory(t.s, lease, { view: options.view ?? "current", ...(options.reportId ? { reportId: options.reportId } : {}), ...(options.cursor ? { cursor: options.cursor } : {}), turn: true });
  assert.equal(h.state, "ready", `history ${h.state}`);
  if (h.state !== "ready") throw new Error("not ready");
  assert.ok(h.turn, "turn summary present when asked");
  return { summary: h.turn!, line: tenantPaymentTurn(h), history: h };
}

test("TEN-51-AC1/AC2: the tenant summary does not depend on the page, the cursor or reportId", async () => {
  const o = await makeOrg(); await enableHistory(o.orgId);
  const t = await makeTenant(o.orgId);
  // one rejected report, then 55 confirmed ones, balance still open → re-report, although the rejection is off the first page
  const a = await makeLease(o, [t]);
  await pay(a, t, "rejected", { at: "2090-01-01T00:00:00Z" });
  await query(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, confirmed_by, confirmed_at)
     SELECT $1, $2, $3, $4, 'TWD', 10, '2090-01-10', 'bank_transfer', 'confirmed', 'tenant_portal', $5, '2090-01-02T00:00:00Z'::timestamptz + n * interval '1 minute', $5, now()
       FROM generate_series(1, 55) n`, [o.orgId, o.property, a.lease, t.contact, t.userId]);
  const ra = await turnOf(t, a.lease);
  assert.equal(ra.history.reports.length, 50);
  assert.ok(ra.history.reports.every((r) => r.status === "confirmed"), "the rejected report is not on the page");
  assert.deepEqual(ra.summary, { waiting: null, reReport: true });
  assert.deepEqual(ra.line, { kind: "your_turn", step: "re_report" });

  // a pending report older than 55 newer confirmed ones, page opened on an old confirmed report → waiting, with the pending amount
  const b = await makeLease(o, [t]);
  const pending = await pay(b, t, "submitted", { at: "2090-01-01T00:00:00Z", amount: 3200000 });
  const old = await pay(b, t, "confirmed", { at: "2090-01-01T00:01:00Z" });
  await query(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, confirmed_by, confirmed_at)
     SELECT $1, $2, $3, $4, 'TWD', 10, '2090-01-10', 'bank_transfer', 'confirmed', 'tenant_portal', $5, '2090-01-02T00:00:00Z'::timestamptz + n * interval '1 minute', $5, now()
       FROM generate_series(1, 55) n`, [o.orgId, o.property, b.lease, t.contact, t.userId]);
  const first = await turnOf(t, b.lease);
  assert.ok(!first.history.reports.some((r) => r.id === pending), "the pending report is beyond the first page");
  assert.deepEqual(first.line, { kind: "waiting", amountMinor: 3200000, currency: "TWD" });
  const byId = await turnOf(t, b.lease, { reportId: old });
  assert.deepEqual(byId.history.reports.map((r) => r.id), [old]);
  assert.deepEqual(byId.line, { kind: "waiting", amountMinor: 3200000, currency: "TWD" });
});

test("TEN-51-AC1/AC2: the summary is the same on page two (cursor) as on page one", async () => {
  const o = await makeOrg(); await enableHistory(o.orgId);
  const t = await makeTenant(o.orgId);
  const bulk = (lease: string, from: string) => query(
    `INSERT INTO payments (org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method, status, source, submitted_by, submitted_at, confirmed_by, confirmed_at)
     SELECT $1, $2, $3, $4, 'TWD', 10, '2090-01-10', 'bank_transfer', 'confirmed', 'tenant_portal', $5, $6::timestamptz + n * interval '1 minute', $5, now()
       FROM generate_series(1, 60) n`, [o.orgId, o.property, lease, t.contact, t.userId, from]);
  // waiting: the NEWEST report is pending, so on page two it lies above the cursor
  const a = await makeLease(o, [t]);
  await bulk(a.lease, "2090-01-02T00:00:00Z");
  const newest = await pay(a, t, "submitted", { at: "2090-06-01T00:00:00Z", amount: 4100000 });
  const page1 = await turnOf(t, a.lease);
  assert.equal(page1.history.reports[0].id, newest);
  assert.ok(page1.history.nextCursor, "there is a second page");
  const page2 = await turnOf(t, a.lease, { cursor: page1.history.nextCursor! });
  assert.ok(page2.history.reports.length > 0 && !page2.history.reports.some((r) => r.id === newest), "page two does not contain the pending report");
  assert.notDeepEqual(page2.history.reports.map((r) => r.id), page1.history.reports.map((r) => r.id));
  assert.deepEqual(page1.summary, { waiting: { amountMinor: 4100000, currency: "TWD" }, reReport: false });
  assert.deepEqual(page2.summary, page1.summary, "same summary on both pages");
  assert.deepEqual(page2.line, page1.line);
  // re-report: the NEWEST report is the rejected one, also above the cursor on page two
  const b = await makeLease(o, [t]);
  await bulk(b.lease, "2090-01-02T00:00:00Z");
  const rejected = await pay(b, t, "rejected", { at: "2090-06-01T00:00:00Z" });
  const q1 = await turnOf(t, b.lease);
  assert.equal(q1.history.reports[0].id, rejected);
  const q2 = await turnOf(t, b.lease, { cursor: q1.history.nextCursor! });
  assert.ok(!q2.history.reports.some((r) => r.id === rejected));
  assert.deepEqual(q1.summary, { waiting: null, reReport: true });
  assert.deepEqual(q2.summary, q1.summary);
});

test("TEN-51-AC2: zero balance, a pending report and an ended lease show no 「輪到你」", async () => {
  const o = await makeOrg(); await enableHistory(o.orgId);
  const t = await makeTenant(o.orgId);
  const a = await makeLease(o, [t]); await pay(a, t, "rejected");
  assert.deepEqual((await turnOf(t, a.lease)).summary, { waiting: null, reReport: true });
  await settle(a);
  assert.deepEqual((await turnOf(t, a.lease)).summary, { waiting: null, reReport: false }, "nothing owed");
  const b = await makeLease(o, [t]); await pay(b, t, "rejected"); await pay(b, t, "submitted", { amount: 700 });
  assert.deepEqual((await turnOf(t, b.lease)).summary, { waiting: { amountMinor: 700, currency: "TWD" }, reReport: false });
  const c = await makeLease(o, [t]); await pay(c, t, "rejected");
  await query(`UPDATE leases SET status = 'ended' WHERE id = $1`, [c.lease]);
  const ended = await turnOf(t, c.lease, { view: "ended" });
  assert.equal(ended.history.lease.canReport, false);
  assert.deepEqual(ended.summary, { waiting: null, reReport: false }, "an ended lease cannot be re-reported");
  assert.equal(ended.line, null);
});

test("TEN-51 co-tenants: the lease-wide rule decides; only the submitter of that report sees 「輪到你」", async () => {
  const o = await makeOrg(); await enableHistory(o.orgId);
  const alice = await makeTenant(o.orgId), bob = await makeTenant(o.orgId);
  const l = await makeLease(o, [alice, bob]);
  await pay(l, alice, "rejected"); // older
  const bobs = await pay(l, bob, "rejected"); // newer: the lease's P2 report
  assert.equal((await turnOf(alice, l.lease)).summary.reReport, false);
  assert.equal((await turnOf(bob, l.lease)).summary.reReport, true);
  // staff see exactly one tenant-turn matter for the lease, and it is Bob's
  assert.deepEqual(ids((await ready(o.staff.accountant)).others), [bobs]);
  // Bob re-reports: neither is asked again, and only Bob is "waiting"
  await pay(l, bob, "submitted", { amount: 900 });
  const a2 = await turnOf(alice, l.lease), b2 = await turnOf(bob, l.lease);
  assert.deepEqual(a2.summary, { waiting: null, reReport: false });
  assert.deepEqual(b2.summary, { waiting: { amountMinor: 900, currency: "TWD" }, reReport: false });
  assert.equal(a2.line, null);
  assert.equal((await ready(o.staff.accountant)).others.length, 0);
});

test("TEN-51-AC4: no turn from another lease or another org; without turn:true the loader returns no summary", async () => {
  const o = await makeOrg(); await enableHistory(o.orgId);
  const mine = await makeTenant(o.orgId), stranger = await makeTenant(o.orgId);
  const x = await makeLease(o, [mine]);
  const y = await makeLease(o, [stranger]); await pay(y, stranger, "rejected"); await pay(y, stranger, "submitted");
  assert.deepEqual((await turnOf(mine, x.lease)).summary, { waiting: null, reReport: false });
  // not a party to lease Y: the loader admits nothing at all
  assert.equal((await tenantPaymentHistory(mine.s, y.lease, { view: "current", turn: true })).state, "unavailable");
  // a session of another org for the same person
  const other = await makeOrg(); await enableHistory(other.orgId);
  assert.equal((await tenantPaymentHistory({ ...mine.s, orgId: other.orgId, liveOrgId: other.orgId }, x.lease, { view: "current", turn: true })).state, "unavailable");
  const plain = await tenantPaymentHistory(mine.s, x.lease, { view: "current" });
  assert.equal(plain.state, "ready");
  assert.equal("turn" in plain, false, "nothing is added unless the page asks for it");
  assert.equal(tenantPaymentTurn(plain), null);
});
