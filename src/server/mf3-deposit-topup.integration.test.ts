import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { depositTopupView, recordDepositTopup } from "./mf3-deposit-topup";
import type { Session } from "./types";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

// MF-3 / MGT-151-AC1…AC5 (MO-TOPUP) gateway integration on a cloned disposable database: the real
// SECURITY DEFINER gateways through service_role, never a pg mock or a table grant.
// Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… .
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
let lease: string, otherLease: string, settlement: string;
const RECORD = "app.mf3_topup_record(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,date,text)";
const VIEW = "app.mf3_topup_view(uuid,uuid,text,uuid,text,uuid)";
const sid: Record<string, string> = {};
const v3 = async () => true;
type Kind = Session["kind"];
type Result = Record<string, unknown> & { status: string };
type View = { settlementId: string; leaseId: string; tenant: string | null; currency: string; minorUnit: number; depositMinor: string;
  deductionMinor: string; owedMinor: string; paidMinor: string; entries: { id: string; amountMinor: string; receivedOn: string }[]; canRecord: boolean } | null;
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;
const user = (name: keyof typeof USERS) => USERS[name];

async function flag(on: boolean, org = ORG_ID) {
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('deposit_settlement',$2::boolean) WHERE id=$1`, [org, on]);
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',
    CASE WHEN $1::boolean THEN jsonb_build_array($2::text,$3::text) ELSE '[]'::jsonb END) WHERE key='deposit_settlement'`, [on, ORG_ID, ORG2_ID]);
}
async function record(who: string, input: { request?: string; amount: number | string; on?: string; note?: string | null; lease?: string; settlement?: string; org?: string; pin?: string }): Promise<Result> {
  const org = input.org ?? ORG_ID;
  return svc(null, async client => {
    await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [input.pin ?? org]);
    return (await client.query(`SELECT ${RECORD.split("(")[0]}($1,$1,'live',$2,$3,$4,$5,$6::bigint,$7::date,$8) r`,
      [org, sid[who], input.request ?? randomUUID(), input.lease ?? lease, input.settlement ?? settlement, String(input.amount), input.on ?? "2026-11-20", input.note ?? null])).rows[0].r;
  });
}
async function view(who: string, kind: Kind, target = lease, org = ORG_ID): Promise<View> {
  return svc(null, async client => {
    await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [org]);
    return (await client.query(`SELECT ${VIEW.split("(")[0]}($1,$1,'live',$2,$3,$4) r`, [org, sid[who], kind, target])).rows[0].r;
  }, { isolation: "repeatable read" });
}
const rows = async () => (await db.query("SELECT * FROM app.deposit_settlement_topups WHERE org_id=$1 ORDER BY created_at,id", [ORG_ID])).rows;
const audits = async () => (await db.query(`SELECT actor_user_id,actor_role,row_id,action::text,reason,request_id,new_row FROM public.audit_log
  WHERE table_name='deposit_settlement_topups' ORDER BY id`)).rows;
const session = (who: keyof typeof USERS, kind: Kind, role: Session["role"] = null, org = ORG_ID): Session => ({ kind, role, orgId: org, liveOrgId: org,
  userId: USERS[who], sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: kind === "tenant" ? lease : null });

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
  const leaseOf = async (tenant: string) => (await db.query(`SELECT l.id FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id
    JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND l.status='active' ORDER BY l.id LIMIT 1`, [ORG_ID, tenant])).rows[0]?.id as string;
  lease = await leaseOf(USERS.tenant); otherLease = await leaseOf(USERS.tenant2);
  assert.ok(lease && otherLease && lease !== otherLease);
  // The lease's property is owned by `owner`, not `owner2` (the seed's current owners).
  assert.equal((await db.query(`SELECT count(*)::int n FROM public.leases l JOIN public.property_owners po ON po.org_id=l.org_id AND po.property_id=l.property_id
    JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE l.id=$1 AND c.user_id=$2 AND (po.effective_to IS NULL OR po.effective_to>current_date)`, [lease, USERS.owner2])).rows[0].n, 0);
  // A sent (confirmed) move-out settlement: deposit NT$24,000, deductions NT$27,000 → 應補 NT$3,000 (TWD minor unit 2).
  settlement = (await db.query(`INSERT INTO app.deposit_settlement_records(org_id,lease_id,basis,status,deposit_held_minor,currency,
    confirmed_total_deduction_minor,confirmed_at,created_by) VALUES ($1,$2,'move_out','confirmed',2400000,'TWD',2700000,now(),$3) RETURNING id`, [ORG_ID, lease, USERS.admin])).rows[0].id;
  // The other lease has a draft settlement only: never shown, never writable.
  await db.query(`INSERT INTO app.deposit_settlement_records(org_id,lease_id,basis,status,deposit_held_minor,currency,created_by)
    VALUES ($1,$2,'move_out','draft',2400000,'TWD',$3)`, [ORG_ID, otherLease, USERS.admin]);
  for (const who of Object.keys(USERS)) {
    sid[who] = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], user(who as keyof typeof USERS), randomUUID()]);
  }
  sid.expired = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.expired, USERS.admin, randomUUID()]);
});

test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("ACL: only service_role may EXECUTE; anon and authenticated are denied; the table has no application grant", async () => {
  for (const signature of [RECORD, VIEW]) {
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok, role === "service_role", `${role} ${signature}`);
    const meta = (await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0];
    assert.deepEqual(meta, { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        const args = signature === RECORD ? "NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::bigint,NULL::date,NULL::text"
          : "NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,NULL::uuid";
        await assert.rejects(db.query(`SELECT ${signature.split("(")[0]}(${args})`), { code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.deposit_settlement_topups'::regclass")).rows[0].relrowsecurity, true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    await db.query("BEGIN");
    try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query("SELECT 1 FROM app.deposit_settlement_topups LIMIT 1"), { code: "42501" }); }
    finally { await db.query("ROLLBACK"); }
  }
});

test("flag OFF: no access — the view is empty for everyone and the writer records nothing", async () => {
  await flag(false);
  for (const [who, kind] of [["admin", "staff"], ["tenant", "tenant"], ["owner", "owner"]] as const) assert.equal(await view(who, kind), null);
  assert.deepEqual(await record("admin", { amount: 100000 }), { status: "disabled" });
  // Org flag ON alone (platform switch OFF) is still OFF.
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||'{"deposit_settlement":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  assert.deepEqual(await record("manager", { amount: 100000 }), { status: "disabled" });
  assert.equal(await view("admin", "staff"), null);
  const ts = await recordDepositTopup(session("admin", "staff", "admin"), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100000", receivedOn: "2026-11-20" }, { v3 });
  assert.deepEqual(ts, { ok: false, reason: "off" });
  assert.deepEqual(await depositTopupView(session("tenant", "tenant"), lease, { v3 }), { state: "none" });
  assert.deepEqual(await rows(), []);
  assert.deepEqual(await audits(), []);
  // brand_v3 OFF closes the presentation before any read.
  await flag(true);
  assert.deepEqual(await depositTopupView(session("admin", "staff", "admin"), lease, { v3: async () => false }), { state: "off" });
  assert.deepEqual(await recordDepositTopup(session("admin", "staff", "admin"), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100000", receivedOn: "2026-11-20" }, { v3: async () => false }), { ok: false, reason: "off" });
  assert.deepEqual(await rows(), []);
});

test("MGT-151-AC1/AC2/AC4: staff record; tenant, owner and staff read one version with dated entries; audit written; no method, nothing outbound", async () => {
  await flag(true);
  const outbound = async () => (await db.query(`SELECT (SELECT count(*) FROM public.notifications)::int n,
    (SELECT count(*) FROM public.audit_log)::int a`)).rows[0];
  const before = await outbound();
  const first = await recordDepositTopup(session("admin", "staff", "admin"),
    { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100000", receivedOn: "2026-11-20", note: "  轉帳  " }, { v3 });
  assert.deepEqual(first, { ok: true, paidMinor: "100000", overMinor: "0", replayed: false });
  const accountant = await record("accountant", { amount: 50000, on: "2026-11-22" });
  assert.equal(accountant.status, "recorded");
  const staff = await view("manager", "staff"), tenant = await view("tenant", "tenant"), owner = await view("owner", "owner");
  assert.ok(staff && tenant && owner);
  assert.equal(staff.canRecord, true); assert.equal(tenant.canRecord, false); assert.equal(owner.canRecord, false);
  assert.equal(typeof staff.tenant, "string"); assert.equal(tenant.tenant, null); assert.equal(owner.tenant, null);
  const shared = (v: NonNullable<View>) => ({ ...v, tenant: undefined, canRecord: undefined });
  assert.deepEqual(shared(tenant), shared(staff));
  assert.deepEqual(shared(owner), shared(staff));
  assert.deepEqual({ deposit: staff.depositMinor, deductions: staff.deductionMinor, owed: staff.owedMinor, paid: staff.paidMinor, currency: staff.currency, unit: staff.minorUnit },
    { deposit: "2400000", deductions: "2700000", owed: "300000", paid: "150000", currency: "TWD", unit: 2 });
  assert.deepEqual(staff.entries.map(e => [e.amountMinor, e.receivedOn]), [["100000", "2026-11-20"], ["50000", "2026-11-22"]]);
  for (const entry of staff.entries) assert.deepEqual(Object.keys(entry).sort(), ["amountMinor", "id", "receivedOn"]);
  // TS reader agrees for every party.
  for (const [who, kind, role] of [["accountant", "staff", "accountant"], ["tenant", "tenant", null], ["owner", "owner", null]] as const) {
    const read = await depositTopupView(session(who, kind, role), lease, { v3 });
    assert.equal(read.state, "ready");
    if (read.state === "ready") assert.equal(read.view.paidMinor, "150000");
  }
  const stored = await rows();
  assert.equal(stored.length, 2);
  assert.equal(stored[0].note, "轉帳");
  assert.equal(stored[0].recorded_by, USERS.admin);
  assert.ok(!("method" in stored[0]) && !("account_last5" in stored[0]));
  const audit = await audits();
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(a => [a.actor_user_id, a.actor_role, a.action, a.reason]),
    [[USERS.admin, "admin", "insert", "deposit_topup_recorded"], [USERS.accountant, "accountant", "insert", "deposit_topup_recorded"]]);
  assert.equal(audit[0].row_id, stored[0].id);
  assert.equal(audit[0].request_id, stored[0].request_id);
  assert.deepEqual(audit[0].new_row, { lease_id: lease, settlement_id: settlement, amount_minor: "100000", currency: "TWD", minor_unit: 2, received_on: "2026-11-20", note: "轉帳" });
  const after = await outbound();
  assert.equal(after.n, before.n, "no notification is produced");
  assert.equal(after.a, before.a + 2, "only the two audit rows are added");
});

test("MGT-151-AC3: over the amount owed is saved and reports how much over", async () => {
  await flag(true);
  const paid = BigInt((await view("admin", "staff"))!.paidMinor);
  const result = await record("manager", { amount: 200000, on: "2026-11-25", note: "轉帳" });
  assert.equal(result.status, "recorded");
  assert.equal(result.paidMinor, String(paid + BigInt(200000)));
  assert.equal(result.overMinor, String(paid + BigInt(200000) - BigInt(300000)));
  assert.equal(result.owedMinor, "300000");
  const v = await view("tenant", "tenant");
  assert.equal(v!.paidMinor, String(paid + BigInt(200000)));
  assert.equal(v!.entries.at(-1)!.receivedOn, "2026-11-25");
});

test("MGT-151-AC5: an idempotent retry replays without a second row or audit; another payload under the same key conflicts", async () => {
  await flag(true);
  const request = randomUUID();
  const rowsBefore = (await rows()).length, auditBefore = (await audits()).length;
  const one = await record("admin", { request, amount: 12300, on: "2026-11-26" });
  const two = await record("admin", { request, amount: 12300, on: "2026-11-26" });
  assert.equal(one.status, "recorded"); assert.equal(one.replayed, false);
  assert.equal(two.status, "recorded"); assert.equal(two.replayed, true);
  assert.equal(two.topupId, one.topupId); assert.equal(two.paidMinor, one.paidMinor);
  assert.equal((await rows()).length, rowsBefore + 1);
  assert.equal((await audits()).length, auditBefore + 1);
  assert.deepEqual(await record("admin", { request, amount: 99900, on: "2026-11-26" }), { status: "conflict" });
  assert.deepEqual(await record("manager", { request, amount: 12300, on: "2026-11-26" }), { status: "conflict" });
  // The TS writer passes the same key through.
  const key = randomUUID(), input = { leaseId: lease, settlementId: settlement, requestId: key, amountMinor: "700", receivedOn: "2026-11-27" };
  const a = await recordDepositTopup(session("manager", "staff", "manager"), input, { v3 });
  const b = await recordDepositTopup(session("manager", "staff", "manager"), input, { v3 });
  assert.equal(a.ok && !a.replayed, true); assert.equal(b.ok && b.replayed, true);
  assert.equal((await rows()).length, rowsBefore + 2);
});

test("denials: maintenance, tenant, owner cannot record; wrong tenant/owner, cross-org, revoked session and wrong pins are denied", async () => {
  await flag(true);
  const count = (await rows()).length;
  await assert.rejects(record("maintenance", { amount: 100 }), code("42501"));
  await assert.rejects(view("maintenance", "staff"), code("42501"));
  for (const who of ["tenant", "owner"]) await assert.rejects(record(who, { amount: 100 }), code("42501"));
  // A tenant or owner session asking for the staff view is denied (not a member).
  for (const who of ["tenant", "owner"]) await assert.rejects(view(who, "staff"), code("42501"));
  assert.deepEqual(await recordDepositTopup(session("tenant", "tenant"), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100", receivedOn: "2026-11-20" }, { v3 }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup(session("maintenance", "staff", "maintenance"), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100", receivedOn: "2026-11-20" }, { v3 }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await depositTopupView(session("maintenance", "staff", "maintenance"), lease, { v3 }), { state: "forbidden" });
  await assert.rejects(view("tenant2", "tenant"), code("42501"));
  await assert.rejects(view("owner2", "owner"), code("42501"));
  assert.deepEqual(await depositTopupView(session("tenant2", "tenant"), lease, { v3 }), { state: "forbidden" });
  // Cross-org: another company's admin, against this org (not a member) and through its own org (no such settlement).
  await assert.rejects(record("coastAdmin", { amount: 100 }), code("42501"));
  await assert.rejects(view("coastAdmin", "staff"), code("42501"));
  await flag(true, ORG2_ID);
  assert.deepEqual(await record("coastAdmin", { amount: 100, org: ORG2_ID }), { status: "unavailable" });
  assert.equal(await view("coastAdmin", "staff", lease, ORG2_ID), null);
  assert.deepEqual(await recordDepositTopup(session("coastAdmin", "staff", "admin", ORG2_ID), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "100", receivedOn: "2026-11-20" }, { v3 }), { ok: false, reason: "failed" });
  // Revoked session; transaction pin that does not match the org.
  await assert.rejects(record("expired", { amount: 100 }), code("42501"));
  await assert.rejects(record("admin", { amount: 100, pin: ORG2_ID }), code("42501"));
  await assert.rejects(svc(null, async client => client.query(`SELECT ${RECORD.split("(")[0]}($1,$1,'live',$2,$3,$4,$5,100::bigint,'2026-11-20'::date,NULL)`,
    [ORG_ID, sid.admin, randomUUID(), lease, settlement])), code("42501"));
  assert.equal((await rows()).length, count);
});

test("invalid input and non-owing settlements save nothing", async () => {
  await flag(true);
  const count = (await rows()).length;
  for (const amount of [0, -5]) assert.deepEqual(await record("admin", { amount }), { status: "invalid" });
  assert.deepEqual(await record("admin", { amount: 100, on: "1999-12-31" }), { status: "invalid" });
  assert.deepEqual(await record("admin", { amount: 100, note: "x".repeat(501) }), { status: "invalid" });
  const draft = (await db.query("SELECT id FROM app.deposit_settlement_records WHERE lease_id=$1", [otherLease])).rows[0].id;
  assert.deepEqual(await record("admin", { amount: 100, lease: otherLease, settlement: draft }), { status: "unavailable" });
  assert.deepEqual(await record("admin", { amount: 100, settlement: draft }), { status: "unavailable" });
  assert.equal(await view("admin", "staff", otherLease), null);
  assert.equal(await view("tenant2", "tenant", otherLease), null);
  // A settlement whose deductions do not exceed the deposit owes nothing: no view, no write.
  await db.query("UPDATE app.deposit_settlement_records SET confirmed_total_deduction_minor=2400000 WHERE id=$1", [settlement]);
  try {
    assert.equal(await view("admin", "staff"), null);
    assert.deepEqual(await record("admin", { amount: 100 }), { status: "unavailable" });
  } finally {
    await db.query("UPDATE app.deposit_settlement_records SET confirmed_total_deduction_minor=2700000 WHERE id=$1", [settlement]);
  }
  const ts = await recordDepositTopup(session("admin", "staff", "admin"), { leaseId: lease, settlementId: settlement, requestId: randomUUID(), amountMinor: "0", receivedOn: "2026-11-20" }, { v3 });
  assert.deepEqual(ts, { ok: false, reason: "invalid" });
  assert.equal((await rows()).length, count);
});
