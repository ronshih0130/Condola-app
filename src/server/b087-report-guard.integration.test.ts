import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { buildStoredConsent } from "./consent";
import { confirmPayment, recordPayment, rejectPayment } from "./domain";
import { ORG_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-087 TEN-DUP (TEN-53-AC4) on a cloned disposable database: the real tenant report path under RLS, a real
// advisory-lock holder for the race, and staff confirm/reject through the real flows. Never a pg mock.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const holders: Client[] = [];
let staff: Session;
const savedBrandV2 = process.env.BRAND_V2;
const over = (e: unknown) => (e as { key?: string }).key === "errors.amountOverUnreported";
const tooHigh = (e: unknown) => (e as { key?: string }).key === "errors.amountTooHigh";

async function tenant() {
  const userId = randomUUID(), sessionId = randomUUID(), consent = buildStoredConsent("signup");
  await db.query("INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')", [userId, `${randomUUID()}@example.test`]);
  await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionId, userId, randomUUID()]);
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)", [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const contact = (await db.query<{ id: string }>("INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic tenant') RETURNING id::text", [ORG_ID, userId])).rows[0].id;
  const s: Session = { userId, sessionId, email: "", name: "Synthetic", kind: "tenant", role: null, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "en", calendar: "gregorian", leaseId: null, consent };
  return { s, contact };
}
/** One active TWD lease with a primary and a co-tenant, and one open NT$1,000 invoice (100000 minor). */
async function lease() {
  const a = await tenant(), b = await tenant();
  const p = (await db.query<{ id: string }>("INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text", [ORG_ID, `B087 ${randomUUID()}`])).rows[0].id;
  const u = (await db.query<{ id: string }>("INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'Floor','by_room') RETURNING id::text", [ORG_ID, p])).rows[0].id;
  const room = (await db.query<{ id: string }>("INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'A') RETURNING id::text", [ORG_ID, u])).rows[0].id;
  const l = (await db.query<{ id: string }>("INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'active','imported','2090-01-01','2090-12-31','TWD',0) RETURNING id::text", [ORG_ID, p, u, room])).rows[0].id;
  await db.query("INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary'),($1,$2,$4,'co_tenant')", [ORG_ID, l, a.contact, b.contact]);
  const inv = (await db.query<{ id: string }>("INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text", [ORG_ID, p, l, randomUUID()])).rows[0].id;
  await db.query("INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',100000,100000)", [ORG_ID, inv]);
  assert.equal((await db.query<{ b: string }>("SELECT balance_minor::text b FROM invoices WHERE id=$1", [inv])).rows[0].b, "100000");
  return { a, b, lease: l, invoice: inv };
}
const report = (s: Session, leaseId: string, amountMajor: number) => recordPayment(s, { leaseId, amountMajor, paidOn: "2090-01-17", last5: "12345", reference: "" });
async function writes(leaseId: string) {
  return (await db.query("SELECT id::text,status::text,amount_minor::text FROM payments WHERE lease_id=$1 ORDER BY id", [leaseId])).rows;
}
async function audits() { return Number((await db.query<{ n: string }>("SELECT count(*)::text n FROM audit_log WHERE table_name='payments'")).rows[0].n); }
async function refusedWithoutWrites(leaseId: string, fn: () => Promise<unknown>, match: (e: unknown) => boolean) {
  const before = await writes(leaseId), audit = await audits();
  await assert.rejects(fn, match);
  assert.deepEqual(await writes(leaseId), before);
  assert.equal(await audits(), audit);
}
async function flags(v2: boolean, v3: boolean) {
  await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('brand_v2',$2::boolean,'brand_v3',$3::boolean) WHERE id=$1", [ORG_ID, v2, v3]);
}

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  delete process.env.BRAND_V2;
  const sessionId = randomUUID();
  await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionId, USERS.admin, randomUUID()]);
  staff = { userId: USERS.admin, sessionId, email: "", name: "staff", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
});
test.after(async () => {
  if (savedBrandV2 === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = savedBrandV2;
  try { for (const h of holders) await h.end().catch(() => undefined); if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("OFF (seed flags, and v3 without effective v2): the legacy rule only — duplicate full reports are still accepted", async () => {
  for (const [v2, v3] of [[false, false], [false, true], [true, false]] as const) {
    await flags(v2, v3);
    const f = await lease();
    await report(f.a.s, f.lease, 1000);
    await report(f.b.s, f.lease, 1000);
    await report(f.a.s, f.lease, 1000);
    assert.equal((await writes(f.lease)).filter((r) => r.status === "submitted").length, 3, `v2=${v2} v3=${v3}`);
    await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 1000.01), tooHigh);
  }
});

test("ON: only the part pending reports do not cover; lease-wide across co-tenants; refused with zero writes", async () => {
  await flags(true, true);
  const f = await lease();
  await report(f.a.s, f.lease, 600);
  await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 400.01), over);
  await refusedWithoutWrites(f.lease, () => report(f.b.s, f.lease, 401), over);
  await report(f.b.s, f.lease, 400);
  await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 0.01), over);
  await refusedWithoutWrites(f.lease, () => report(f.b.s, f.lease, 1), over);
  // The legacy ceiling still answers first when the amount is above the whole open balance.
  await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 1000.01), tooHigh);
  assert.deepEqual((await writes(f.lease)).map((r) => r.amount_minor).sort(), ["40000", "60000"]);
});

test("ON: a rejected report frees its part; a confirmed report leaves the balance and the pending total together", async () => {
  await flags(true, true);
  const f = await lease();
  const first = await report(f.a.s, f.lease, 600);
  const second = await report(f.b.s, f.lease, 400);
  if (!("paymentId" in first) || !("paymentId" in second)) throw Error("missing report");
  await rejectPayment(staff, second.paymentId, "Synthetic: not received");
  await refusedWithoutWrites(f.lease, () => report(f.b.s, f.lease, 401), over);
  const third = await report(f.b.s, f.lease, 400);
  if (!("paymentId" in third)) throw Error("missing report");
  await confirmPayment(staff, first.paymentId);
  // Balance 400 now, pending 400 (third): nothing left to report.
  await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 1), over);
  await rejectPayment(staff, third.paymentId, "Synthetic: not received");
  await report(f.a.s, f.lease, 400);
  await refusedWithoutWrites(f.lease, () => report(f.a.s, f.lease, 1), over);
});

for (const spelling of ["canonical", "upper-case"] as const) test(`ON: two co-tenants racing for the whole balance (${spelling} lease id for one) — the lease lock admits exactly one`, async () => {
  await flags(true, true);
  const f = await lease();
  const other = spelling === "canonical" ? f.lease : f.lease.toUpperCase();
  if (spelling === "upper-case") assert.notEqual(other, f.lease, "the upper-case spelling must differ, or the case is vacuous");
  const h = new Client({ connectionString: process.env.DATABASE_URL }); holders.push(h); await h.connect(); await h.query("BEGIN");
  await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`b087:${ORG_ID}:${f.lease}`]);
  const racing = [report(f.a.s, f.lease, 1000), report(f.b.s, other, 1000)].map((p) => p.then(() => "ok", (e) => (over(e) ? "over" : e)));
  // Both are parked on the held lease lock, so neither has inserted yet.
  for (let i = 0; i < 50 && Number((await db.query<{ n: string }>("SELECT count(*)::text n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n) < 2; i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(Number((await db.query<{ n: string }>("SELECT count(*)::text n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n), 2);
  assert.equal((await writes(f.lease)).length, 0);
  await h.query("COMMIT");
  assert.deepEqual((await Promise.all(racing)).sort(), ["ok", "over"]);
  assert.equal((await writes(f.lease)).length, 1);
});
