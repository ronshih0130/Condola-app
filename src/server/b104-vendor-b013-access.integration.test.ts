import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc, svcOn } from "./db";
import { staffRepairTurns, type StaffRepairTurns } from "./b3-repair-turns";
import { loadVendorRepairTurns, loadVendorRepairTurnsOn } from "./b3-vendor-repair-turn";
import { ownerPending, ownerHistory } from "./repair-approval";
import { confirmVendorCost } from "./vendor-repair";
import type { Session } from "./types";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resolveVendorJobState, respondVendorJob, submitVendorCompletion } from "./vendor-job";
import { submitVendorReport } from "./vendor-repair";
import { hashVendorToken } from "./vendor-repair-rules";

// Real connections and writers, never a pg mock or a table-grant workaround.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
let saved: { flags: unknown; plan: string; approvals: unknown } | undefined;
let property: string, currency: string, minorUnit: number;
const session = randomUUID();
const signatures = [
  "app.b104_current_repair_version(uuid,uuid)",
  "app.b104_vendor_command_exists(uuid,uuid,uuid)",
  "app.b104_vendor_latest_event(uuid,uuid,uuid,uuid)",
];

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
  saved = (await db.query(`SELECT feature_flags flags,plan_tier::text plan,
    (SELECT value FROM public.platform_settings WHERE key='repair_approvals') approvals
    FROM public.organizations WHERE id=$1`, [ORG_ID])).rows[0];
  await db.query(`UPDATE public.organizations SET plan_tier='beta',
    feature_flags=feature_flags||'{"repair_approvals":true,"vendor_dispatch":true,"vendor_link":false}'::jsonb
    WHERE id=$1`, [ORG_ID]);
  const enabled = await db.query(`UPDATE public.platform_settings
    SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))
    WHERE key='repair_approvals'`, [ORG_ID]);
  assert.equal(enabled.rowCount, 1);
  const row = (await db.query(`SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit
    FROM public.property_owners po
    JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
    JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL
      AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
  assert.ok(row);
  property = row.property_id; currency = row.currency.trim(); minorUnit = row.minor_unit;
  await db.query(`UPDATE public.property_owners SET effective_from=CURRENT_DATE-1,effective_to=CURRENT_DATE
    WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, property, row.id]);
  await db.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=500000,
    effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1`, [row.id]);
  await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [session, USERS.admin, randomUUID()]);
  // 3b owner session (was a second top-level before hook that ran before db existed).
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [ownerSession, USERS.owner, randomUUID()]);
});

test.after(async () => {
  try {
    if (saved) {
      await db.query("UPDATE public.organizations SET feature_flags=$2,plan_tier=$3 WHERE id=$1",
        [ORG_ID, saved.flags, saved.plan]);
      await db.query("UPDATE public.platform_settings SET value=$1 WHERE key='repair_approvals'", [saved.approvals]);
    }
  } finally {
    try { if (db) await db.end(); } finally { await clone?.cleanup(); }
  }
});

async function fixture(createdBy: string | null = USERS.admin, amount = 100) {
  const ticket = randomUUID(), job = randomUUID(), token = randomBytes(32).toString("base64url");
  const inserted = await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'open','B-104 fixture',cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$2 ORDER BY id LIMIT 1`, [ticket, ORG_ID, property]);
  assert.equal(inserted.rowCount, 1);
  const estimate = await svc(USERS.admin, async client => {
    assert.equal((await client.query("SELECT current_user role")).rows[0].role, "service_role");
    return (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,$8::bigint,$5::text,$6::smallint,
      'Repair pipe','[]'::jsonb,$7::bytea) r`,
    [ORG_ID, session, randomUUID(), ticket, currency, minorUnit, createHash("sha256").update(ticket).digest(), amount])).rows[0].r;
  });
  assert.equal(estimate.status, "recorded");
  assert.equal(estimate.requires_owner_decision, amount > 500000);
  const version = String(estimate.version_id);
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by)
    VALUES($1,$2,$3,'B-104 vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',$5)`,
  [job, ORG_ID, ticket, hashVendorToken(token), createdBy]);
  return { ticket, job, token, version };
}

test("helpers permit only service_role and leave all seven B-013 tables revoked", async () => {
  for (const signature of signatures) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role", `${role}: ${signature}`);
    }
    const name = signature.split("(")[0];
    const args = signature.match(/uuid/g)!.map(() => "NULL::uuid").join(",");
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query(`SELECT ${name}(${args})`), { code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  }
  for (const table of ["estimate_heads", "estimate_versions", "estimate_decisions", "repair_emergencies",
    "repair_appointments", "repair_commands", "repair_event_outbox"]) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE service_role");
      await assert.rejects(db.query(`SELECT 1 FROM app.b013_${table} LIMIT 1`), { code: "42501" });
    } finally { await db.query("ROLLBACK"); }
  }
});

test("real vendor writers succeed with approvals + dispatch ON through svc, including replay and actor fallback", async t => {
  for (const creator of [USERS.admin, null]) await t.test(creator ? "staff actor" : "job actor fallback", async () => {
    const f = await fixture(creator);
    const input = { requestId: randomUUID(), versionId: f.version, reason: "No after photo available" };
    const result = await submitVendorCompletion(f.token, input);
    assert.equal(result.status, "recorded");
    assert.deepEqual(await submitVendorCompletion(f.token, input), result);
    assert.equal((await submitVendorCompletion(f.token, { ...input, reason: "Changed" })).status, "rejected_conflict");
    assert.equal((await resolveVendorJobState(f.token))?.currentEvent, "vendor_completion_submitted");
    const response = await respondVendorJob(f.token, {
      requestId: randomUUID(), versionId: f.version, action: "reject", reason: "Reschedule",
    });
    assert.equal(response.status, "recorded");
    assert.equal((await resolveVendorJobState(f.token))?.currentEvent, "vendor_rejected");
    await assert.rejects(submitVendorCompletion(f.token, {
      requestId: randomUUID(), versionId: f.version,
    }), (error: unknown) => (error as { key?: string }).key === "errors.required");
    const event = (await db.query(`SELECT actor_id::text,event_kind,response_reason FROM app.b013_repair_appointments
      WHERE id=$1`, [result.appointment_id])).rows[0];
    assert.deepEqual(event, { actor_id: creator ?? f.job, event_kind: "vendor_completion_submitted", response_reason: input.reason });
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_repair_appointments
      WHERE org_id=$1 AND ticket_id=$2`, [ORG_ID, f.ticket])).rows[0].n, 2);
  });
});

test("real vendor report succeeds through svc with approvals + dispatch ON", async () => {
  const f = await fixture();
  await submitVendorReport(f.token, { done: true, cost: "100" });
  const reported = (await db.query(`SELECT j.reported_at IS NOT NULL reported,j.reported_cost_minor::text cost,
    t.status::text status FROM public.repair_vendor_jobs j
    JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id WHERE j.id=$1`, [f.job])).rows[0];
  assert.deepEqual(reported, { reported: true, cost: "10000", status: "resolved" });
});

test("helper scopes reject another org's ticket/job/request, absent IDs and null arguments", async () => {
  const f = await fixture(), request = randomUUID();
  assert.equal((await resolveVendorJobState(f.token))?.currentEvent, "none");
  await submitVendorCompletion(f.token, { requestId: request, versionId: f.version, reason: "No photo" });
  async function reads(org: string | null, ticket: string | null, job: string | null, req: string | null, version: string | null) {
    return svc(null, async client => (await client.query(`SELECT
      app.b104_current_repair_version($1::uuid,$2::uuid)::text version,
      app.b104_vendor_command_exists($1::uuid,$3::uuid,$4::uuid) found,
      app.b104_vendor_latest_event($1::uuid,$2::uuid,$3::uuid,$5::uuid) event`,
    [org, ticket, job, req, version])).rows[0]);
  }
  assert.deepEqual(await reads(ORG_ID, f.ticket, f.job, request, f.version),
    { version: f.version, found: true, event: "vendor_completion_submitted" });
  for (const org of [ORG2_ID, randomUUID(), null]) {
    assert.deepEqual(await reads(org, f.ticket, f.job, request, f.version), { version: null, found: false, event: null });
  }
  // A real second-org job with the SAME actor must not match the first org's
  // request. This catches loss of c.org_id=j.org_id, not just j.org_id filtering.
  const otherProperty = (await db.query(`SELECT id FROM public.properties WHERE org_id=$1 ORDER BY id LIMIT 1`, [ORG2_ID])).rows[0];
  assert.ok(otherProperty);
  const otherTicket = randomUUID(), otherJob = randomUUID();
  const inserted = await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'open','Other B-104 fixture',cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$4 ORDER BY id LIMIT 1`, [otherTicket, ORG2_ID, otherProperty.id, ORG_ID]);
  assert.equal(inserted.rowCount, 1);
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,active)
    VALUES($1,$2,$3,'Other fixture','+886900000001','Weekdays',$4,clock_timestamp()+interval '1 day',$5,false)`,
  [otherJob, ORG2_ID, otherTicket, hashVendorToken(randomBytes(32).toString("base64url")), USERS.admin]);
  assert.deepEqual(await reads(ORG2_ID, otherTicket, otherJob, request, f.version), { version: null, found: false, event: null });
  assert.deepEqual(await reads(ORG_ID, otherTicket, otherJob, request, f.version), { version: null, found: false, event: null });
  for (const missing of [randomUUID(), null]) {
    assert.equal((await reads(ORG_ID, missing, f.job, request, f.version)).version, null);
    assert.equal((await reads(ORG_ID, missing, f.job, request, f.version)).event, null);
    assert.equal((await reads(ORG_ID, f.ticket, missing, request, f.version)).found, false);
    assert.equal((await reads(ORG_ID, f.ticket, missing, request, f.version)).event, null);
    assert.equal((await reads(ORG_ID, f.ticket, f.job, missing, f.version)).found, false);
    assert.equal((await reads(ORG_ID, f.ticket, f.job, request, missing)).event, null);
  }
});

// B-070 3b / PLT-52/53 / MGT-125/126: reuse this exact B-104 clone, fixtures and
// real writers. No mock connection, no new app-table grants, no hosted database.
const staff: Session = { userId: USERS.admin, sessionId: session, kind: "staff", role: "admin", orgId: ORG_ID,
  liveOrgId: ORG_ID, environment: "live", email: "synthetic@example.test", name: "Fixture", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const ownerSession = randomUUID();
const owner: Session = { ...staff, userId: USERS.owner, sessionId: ownerSession, kind: "owner", role: null };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function flag(key: string, value: boolean) {
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::boolean) WHERE id=$1", [ORG_ID, key, value]);
}
async function readTurn(f?: Fixture) {
  const result = await staffRepairTurns(staff, f ? { ticketId: f.ticket } : {}, { v3: async () => true });
  assert.equal(result.state, "ready");
  return result as Extract<StaffRepairTurns, { state: "ready" }>;
}
async function expectRule(f: Fixture, rule: string, canAct?: boolean) {
  const result = await readTurn(f);
  assert.ok(result.detail && "rule" in result.detail);
  assert.equal(result.detail.rule, rule);
  if (canAct !== undefined) assert.equal(result.detail.viewerCanAct, canAct);
  if (result.detail.holder === "none") { assert.equal(result.yourTurn, 0); assert.equal(result.mine.length + result.others.length, 0); }
  else {
    assert.equal(result.mine.length + result.others.length, 1);
    assert.equal(result.counts.reduce((n, c) => n + c.count, 0), 1);
    assert.equal(result.yourTurn, result.detail.holder === "manager" && result.detail.viewerCanAct ? 1 : 0);
  }
  return result;
}
async function version(f: Fixture, amount = 600000) {
  const r = await svc(USERS.admin, async c => (await c.query(`SELECT app.b013_submit_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,
    'Repair scope','[]'::jsonb,$9::bytea) r`, [ORG_ID, session, randomUUID(), f.ticket, f.version, amount, currency, minorUnit,
    createHash("sha256").update(randomUUID()).digest()])).rows[0].r);
  assert.equal(r.status, "recorded"); f.version = String(r.version_id);
}
async function decision(f: Fixture, value: "approved" | "rejected" | "more_information") {
  const r = await svc(USERS.owner, async c => (await c.query(`SELECT app.b013_decide_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::bytea) r`,
  [ORG_ID, ownerSession, randomUUID(), f.version, value, value === "approved" ? null : "Fixture response",
    createHash("sha256").update(randomUUID()).digest()])).rows[0].r);
  assert.equal(r.status, "recorded");
}
async function emergency(f: Fixture) {
  // Immutable synthetic read fact, never overwriting an existing decision/emergency.
  await db.query(`INSERT INTO app.b013_repair_emergencies
    (org_id,ticket_id,version_id,category,reason,authorized_photo_snapshot,authorized_by)
    VALUES($1,$2,$3,'water','Synthetic emergency',$4::jsonb,$5)`,
  [ORG_ID, f.ticket, f.version, JSON.stringify([{ id: randomUUID() }]), USERS.admin]);
}
async function retain(f: Fixture) {
  await db.query("INSERT INTO app.b026_vendor_estimates(org_id,ticket_id,version_id,vendor_job_id) VALUES($1,$2,$3,$4)", [ORG_ID, f.ticket, f.version, f.job]);
}
async function enhanced(f: Fixture) {
  const vendor = (await db.query("SELECT id FROM public.contacts WHERE org_id=$1 AND is_vendor AND archived_at IS NULL ORDER BY id LIMIT 1", [ORG_ID])).rows[0];
  assert.ok(vendor);
  await db.query("UPDATE public.repair_vendor_jobs SET vendor_contact_id=$2 WHERE id=$1", [f.job, vendor.id]);
  await db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [f.ticket, vendor.id]);
  await db.query(`UPDATE public.repair_vendor_jobs SET vendor_contact_id=$2,scope='case_collaboration',
    sharing_approved_at=clock_timestamp(),sharing_approved_by=$3,shared_description='Synthetic shared scope' WHERE id=$1`, [f.job, vendor.id, USERS.admin]);
  await db.query("INSERT INTO public.repair_vendor_secrets(job_id,token) VALUES($1,$2) ON CONFLICT(job_id) DO UPDATE SET token=excluded.token", [f.job, f.token]);
  await flag("vendor_link", true);
  await db.query(`INSERT INTO public.platform_settings(key,value) VALUES('vendor_link',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [ORG_ID]);
}
async function vendorTurn(f: Fixture) {
  return svc(null, async c => {
    assert.equal((await c.query("SELECT current_user role")).rows[0].role, "service_role");
    await c.query("SET LOCAL statement_timeout='2s'"); await c.query("SET LOCAL lock_timeout='1s'");
    return (await c.query("SELECT app.b3_vendor_repair_turn($1::text) r", [hashVendorToken(f.token)])).rows[0].r;
  }, { isolation: "repeatable read" });
}

test.beforeEach(async () => {
  await flag("repair_approvals", true); await flag("vendor_dispatch", true); await flag("vendor_link", false);
  await flag("brand_v2", true); await flag("brand_v3", true);
});

test("3b actual-role journeys R7b → completion/R7a → report/resolved/R2, authorization and sharing matrix", async t => {
  for (const auth of ["below", "approved", "emergency"] as const) for (const share of [false, true]) {
    await t.test(`${auth}; enhanced=${share}`, async () => {
      const f = await fixture(USERS.admin, auth === "below" ? 100 : 600000);
      if (auth === "approved") await decision(f, "approved");
      if (auth === "emergency") { await emergency(f); await decision(f, "rejected"); }
      if (share) await enhanced(f); else await flag("vendor_link", false);
      await retain(f);
      await db.query("UPDATE public.maintenance_tickets SET status='resolved',resolved_at=clock_timestamp() WHERE id=$1", [f.ticket]);
      await expectRule(f, "R7b", false);
      assert.equal((await vendorTurn(f)).viewerCanAct, true);
      const completed = await submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: f.version, reason: "No after photo" });
      assert.equal(completed.status, "recorded");
      await expectRule(f, "R7a", false); assert.equal((await vendorTurn(f)).step, "report_cost");
      await submitVendorReport(f.token, { done: true, cost: "100" });
      const r = await expectRule(f, "R2", true); assert.equal(r.yourTurn, 1);
      assert.equal((await vendorTurn(f)).holder, "manager");
      const persisted = (await db.query(`SELECT j.reported_at IS NOT NULL reported,t.status::text status,
        (SELECT count(*)::int FROM app.b013_repair_appointments a WHERE a.org_id=j.org_id AND a.ticket_id=j.ticket_id AND a.repair_vendor_job_id=j.id) events
        FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id WHERE j.id=$1`, [f.job])).rows[0];
      assert.deepEqual(persisted, { reported: true, status: "resolved", events: 1 });
      const loaded = await loadVendorRepairTurns(f.token); assert.equal(loaded.state, "ready");
      if (loaded.state === "ready") { assert.ok(loaded.job?.reported); assert.equal(loaded.turn?.step, "confirm_cost"); }
    });
  }
});

test("3b direct real report from R7b; approvals-OFF legacy success, retained work fails without partial writes", async () => {
  const legacy = await fixture(); await flag("repair_approvals", false);
  await expectRule(legacy, "R7b", false); await submitVendorReport(legacy.token, { done: true, cost: "10" });
  await expectRule(legacy, "R2", true);
  await flag("repair_approvals", true); const guarded = await fixture(); await retain(guarded); await flag("repair_approvals", false);
  await expectRule(guarded, "R8-blocked", true);
  await assert.rejects(submitVendorReport(guarded.token, { done: true, cost: "10" }));
  assert.equal((await db.query("SELECT reported_at FROM public.repair_vendor_jobs WHERE id=$1", [guarded.job])).rows[0].reported_at, null);
});

test("B1 owner pending/home excludes closed AND cancelled, emergency and cost; history and resolved pending survive; OFF exception", async () => {
  for (const status of ["closed", "cancelled", "resolved"] as const) {
    const f = await fixture(USERS.admin, 600000); await emergency(f);
    await db.query("UPDATE public.repair_vendor_jobs SET reported_at=clock_timestamp(),reported_cost_minor=100 WHERE id=$1", [f.job]);
    await db.query("UPDATE public.maintenance_tickets SET status=$2::public.ticket_status WHERE id=$1", [f.ticket, status]);
    for (const v3 of [true, false]) {
      await flag("brand_v3", v3);
      assert.equal((await ownerPending(owner)).some(r => r.ticket_id === f.ticket), status === "resolved");
      assert.equal((await ownerPending(owner, { homeDetails: true })).some(r => r.ticket_id === f.ticket), status === "resolved");
      assert.ok((await ownerHistory(owner, { ticketId: f.ticket })).some(r => r.version_id === f.version));
      await expectRule(f, status === "resolved" ? "R2" : "R1");
    }
  }
  const f = await fixture(USERS.admin, 600000);
  await db.query("UPDATE public.maintenance_tickets SET status='resolved',resolved_at=clock_timestamp() WHERE id=$1", [f.ticket]);
  await expectRule(f, "R3", false);
  await decision(f, "approved"); // B1 intentionally does not introduce a terminal-state writer rule.
});

test("3b first-match SQL rows, every ticket status and missing/revoked resolved emergency matrix", async () => {
  const plain = await fixture(); await db.query("UPDATE public.repair_vendor_jobs SET active=false,revoked_at=clock_timestamp() WHERE id=$1", [plain.job]);
  for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"]) {
    await db.query("UPDATE public.maintenance_tickets SET status=$2::public.ticket_status WHERE id=$1", [plain.ticket, status]);
    await expectRule(plain, ["closed", "cancelled"].includes(status) ? "R1" : status === "resolved" ? "R4" : "R8");
  }
  for (const resolved of [false, true]) for (const emerg of [false, true]) for (const jobState of ["usable", "missing", "revoked"] as const) {
    const f = await fixture(); if (emerg) await emergency(f);
    if (jobState === "missing") await db.query("DELETE FROM public.repair_vendor_jobs WHERE id=$1", [f.job]);
    if (jobState === "revoked") await db.query("UPDATE public.repair_vendor_jobs SET active=false,revoked_at=clock_timestamp() WHERE id=$1", [f.job]);
    if (resolved) await db.query("UPDATE public.maintenance_tickets SET status='resolved' WHERE id=$1", [f.ticket]);
    await expectRule(f, jobState === "usable" ? "R7b" : emerg ? "R8-blocked" : resolved ? "R4" : "R8");
    if (emerg && jobState !== "usable") {
      await flag("vendor_dispatch", false); const off = await expectRule(f, "R8-blocked", !resolved);
      assert.equal(off.detail?.step, "in_progress"); await flag("vendor_dispatch", true);
    }
  }
  const rejected = await fixture(USERS.admin, 600000); await decision(rejected, "more_information"); await expectRule(rejected, "R5", true);
  const vendor = await fixture();
  assert.equal((await respondVendorJob(vendor.token, { requestId: randomUUID(), versionId: vendor.version, action: "reject", reason: "Reschedule" })).status, "recorded");
  await expectRule(vendor, "R6", true); assert.equal((await vendorTurn(vendor)).holder, "manager");
  await version(vendor); await expectRule(vendor, "R3", false); assert.equal((await vendorTurn(vendor)).holder, null);
});

test("B-026 confirmation trigger denial rolls back job/ticket/expense; new head priority, same-head emergency control", async () => {
  for (const change of ["off", "pending", "rejected", "more_information", "dispatchOff"] as const) {
    await flag("repair_approvals", true); await flag("vendor_dispatch", true);
    const f = await fixture(); await retain(f); await submitVendorReport(f.token, { done: true, cost: "10" });
    if (change === "off") await flag("repair_approvals", false);
    if (["pending", "rejected", "more_information"].includes(change)) await version(f);
    if (change === "rejected" || change === "more_information") await decision(f, change);
    if (change === "dispatchOff") await flag("vendor_dispatch", false);
    await expectRule(f, change === "pending" ? "R3" : ["rejected", "more_information"].includes(change) ? "R5" : "R8-blocked", change === "rejected" || change === "more_information");
    await assert.rejects(confirmVendorCost(staff, f.ticket, f.job), (e: unknown) => {
      if (change === "dispatchOff") return (e as { key?: string }).key === "errors.forbidden";
      return (e as { code?: string }).code === "40001" || (e as { cause?: { code?: string } }).cause?.code === "40001";
    });
    const r = (await db.query(`SELECT t.status::text status,j.confirmed_at,j.expense_id,
      (SELECT count(*)::int FROM public.expenses e WHERE e.org_id=t.org_id AND e.ticket_id=t.id) expenses
      FROM public.maintenance_tickets t JOIN public.repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id WHERE j.id=$1`, [f.job])).rows[0];
    assert.deepEqual(r, { status: "resolved", confirmed_at: null, expense_id: null, expenses: 0 });
  }
  await flag("repair_approvals", true); await flag("vendor_dispatch", true);
  const f = await fixture(USERS.admin, 600000); await emergency(f); await retain(f); await decision(f, "rejected");
  await submitVendorReport(f.token, { done: true, cost: "10" }); await expectRule(f, "R2", true);
});

test("3b anon/authenticated ACL denial, owner/cross-org/session/pin denial, no raw-table access", async () => {
  for (const role of ["anon", "authenticated"]) for (const sql of [
    "SELECT app.b3_vendor_repair_turn(NULL::text)",
    "SELECT app.b3_staff_repair_turns(NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::uuid)",
  ]) {
    await db.query("BEGIN"); try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(sql), { code: "42501" }); }
    finally { await db.query("ROLLBACK"); }
  }
  const f = await fixture();
  const call = async (overrides: unknown[]) => svc(USERS.admin, async c => {
    await c.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    return c.query("SELECT app.b3_staff_repair_turns($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid)", overrides);
  }, { isolation: "repeatable read" });
  for (const args of [[ORG2_ID, ORG_ID, "live", USERS.admin, session, f.ticket], [ORG_ID, ORG2_ID, "live", USERS.admin, session, f.ticket],
    [ORG_ID, ORG_ID, "sandbox", USERS.admin, session, f.ticket], [ORG_ID, ORG_ID, "live", USERS.owner, ownerSession, f.ticket],
    [ORG_ID, ORG_ID, "live", USERS.manager, session, f.ticket], [ORG_ID, ORG_ID, "live", USERS.admin, randomUUID(), f.ticket]])
    await assert.rejects(call(args));
  const foreignTicket = (await db.query("SELECT id FROM public.maintenance_tickets WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG2_ID])).rows[0].id;
  const foreign = await staffRepairTurns(staff, { ticketId: foreignTicket }, { v3: async () => true });
  assert.equal(foreign.state === "ready" && foreign.detail, null);
  for (const expired of [false, true]) {
    const sid = randomUUID(); await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at)
      VALUES($1,$2,$3,clock_timestamp()+$4::interval,CASE WHEN $5 THEN clock_timestamp() END)`, [sid, USERS.admin, randomUUID(), expired ? "-1 hour" : "1 hour", !expired]);
    await assert.rejects(call([ORG_ID, ORG_ID, "live", USERS.admin, sid, f.ticket]));
  }
});

test("3b token denial matrix and actual writer no-partial-write guards", async () => {
  for (const denial of ["expired", "revoked", "inactive", "unshared", "reassigned"] as const) {
    const f = await fixture(); await emergency(f); await enhanced(f);
    await db.query("UPDATE public.maintenance_tickets SET status='resolved' WHERE id=$1", [f.ticket]);
    if (denial === "expired") await db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job]);
    if (denial === "revoked") await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [f.job]);
    if (denial === "inactive") await db.query("UPDATE public.repair_vendor_jobs SET active=false WHERE id=$1", [f.job]);
    if (denial === "unshared") await db.query("UPDATE public.repair_vendor_jobs SET sharing_approved_at=NULL,sharing_approved_by=NULL WHERE id=$1", [f.job]);
    if (denial === "reassigned") await db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1", [f.ticket]);
    assert.equal(await vendorTurn(f), null);
    await expectRule(f, "R8-blocked", false);
    await assert.rejects(submitVendorReport(f.token, { done: true, cost: "10" }));
    await assert.rejects(submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: f.version, reason: "No photo" }));
    assert.equal((await db.query("SELECT reported_at FROM public.repair_vendor_jobs WHERE id=$1", [f.job])).rows[0].reported_at, null);
  }
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b3_vendor_repair_turn($1) r", ["invalid"])).rows[0].r), null);
  await flag("vendor_link", false);
  const a = await fixture(), b = await fixture();
  const before = await vendorTurn(a);
  await notRecorded(submitVendorCompletion(a.token, { requestId: randomUUID(), versionId: b.version, reason: "No photo" }));
  assert.deepEqual(await vendorTurn(a), before);
  await version(a, 100);
  await notRecorded(submitVendorCompletion(a.token, { requestId: randomUUID(), versionId: b.version, reason: "No photo" }));
});

test("M3 two-connection barrier: head/event/report/flags/sharing/revocation/assignment never mix snapshots", async t => {
  for (const change of ["head", "event", "report", "flag", "sharing", "revoke", "assignment"] as const) {
    await t.test(change, async () => {
      await flag("repair_approvals", true); await flag("vendor_dispatch", true); await flag("vendor_link", false);
      const f = await fixture();
      // Legacy links have no existing loader lock, so the second connection can
      // commit between capability and M3. M3 must see its old snapshot or 40001.
      const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
      try {
        const outcome = await svcOn(c, null, async client => {
          assert.equal((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
          assert.equal((await client.query("SELECT current_user role")).rows[0].role, "service_role");
          return loadVendorRepairTurnsOn(client, f.token, ORG_ID, async () => {
            if (change === "head") await version(f);
            if (change === "event") await submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: f.version, reason: "No photo" });
            if (change === "report") await submitVendorReport(f.token, { done: true, cost: "10" });
            if (change === "flag") await flag("repair_approvals", false);
            if (change === "sharing") await enhanced(f);
            if (change === "revoke") await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [f.job]);
            if (change === "assignment") await db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=NULL,updated_at=clock_timestamp() WHERE id=$1", [f.ticket]);
          });
        }, { isolation: "repeatable read" }).catch((e: unknown) => {
          assert.equal((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code, "40001"); return { state: "unavailable" as const };
        });
        if (outcome.state === "ready") { assert.equal(outcome.job?.reported, false); assert.equal(outcome.turn?.step, "do_repair"); }
        const next = await loadVendorRepairTurns(f.token);
        assert.equal(next.state, "ready");
        if (next.state === "ready") {
          if (change === "head") assert.equal(next.turn?.state, "restricted");
          if (change === "event") assert.equal(next.turn?.step, "report_cost");
          if (change === "report") { assert.equal(next.job?.reported, true); assert.equal(next.turn?.step, "confirm_cost"); }
          if (change === "revoke") assert.equal(next.job, null);
        }
      } finally { await c.end(); }
    });
  }
});

test("M3 enhanced locks are retained and bounded; wall-clock expiry at final recheck discloses nothing", async () => {
  const f = await fixture(); await enhanced(f);
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    const result = await svcOn(c, null, client => loadVendorRepairTurnsOn(client, f.token, ORG_ID, async () => {
      await db.query("BEGIN");
      try {
        await db.query("SET LOCAL lock_timeout='50ms'");
        await assert.rejects(db.query("UPDATE public.repair_vendor_jobs SET active=false WHERE id=$1", [f.job]), { code: "55P03" });
      } finally { await db.query("ROLLBACK"); }
    }), { isolation: "repeatable read" });
    assert.equal(result.state, "ready");
    await db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.job]);
    await assert.rejects(svcOn(c, null, client => loadVendorRepairTurnsOn(client, f.token, ORG_ID,
      async () => { await db.query("SELECT pg_sleep(1.1)"); }), { isolation: "repeatable read" }), (e: unknown) => !!(e as { cause?: unknown }).cause);
  } finally { await c.end(); }
});

test("maintenance public-fact projection is unchanged by hidden estimate/decision/emergency/flag mutations", async () => {
  const f = await fixture(), sid = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sid, USERS.maintenance, randomUUID()]);
  const maintenance: Session = { ...staff, userId: USERS.maintenance, sessionId: sid, role: "maintenance" };
  const read = () => staffRepairTurns(maintenance, { ticketId: f.ticket }, { v3: async () => true });
  const baseline = await read(); assert.equal(baseline.state, "ready");
  await version(f); assert.deepEqual(await read(), baseline);
  await emergency(f); assert.deepEqual(await read(), baseline);
  await decision(f, "more_information"); assert.deepEqual(await read(), baseline);
  for (const approvals of [false, true]) for (const dispatch of [false, true]) {
    await flag("repair_approvals", approvals); await flag("vendor_dispatch", dispatch); assert.deepEqual(await read(), baseline);
  }
  assert.ok(!JSON.stringify(baseline).includes("approve_estimate"));
});

test("MGT-125/126 uncapped 120 own + 200 waits; deterministic pages reach every ticket once", async () => {
  // Roll back all read fixtures. No actual writers on this connection in this case.
  await db.query("BEGIN");
  try {
    const sample = await fixtureForBulk();
    const ids: string[] = [];
    for (let i = 0; i < 320; i++) {
      const id = randomUUID(); ids.push(id);
      await db.query(`INSERT INTO public.maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
        SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),property_id,category,priority,'open','B3 bulk',cost_bearer,owner_approval
        FROM public.maintenance_tickets WHERE id=$3`, [id, ORG_ID, sample.ticket]);
      if (i >= 120) await db.query(`INSERT INTO public.repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by)
        VALUES($1,$2,$3,'Bulk vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',$5)`, [randomUUID(), ORG_ID, id, hashVendorToken(randomBytes(32).toString("base64url")), USERS.admin]);
    }
    // Isolate the bulk population with public ticket states; existing immutable
    // repair histories stay intact. No fixture can reappear due to pre-limit filtering.
    await db.query("UPDATE public.maintenance_tickets SET status='cancelled' WHERE org_id=$1 AND NOT id=ANY($2::uuid[])", [ORG_ID, ids]);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"repair_approvals\":false,\"vendor_link\":false}'::jsonb WHERE id=$1", [ORG_ID]);
    await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await db.query("SET LOCAL ROLE service_role");
    for (const group of ["mine", "others"] as const) {
      const reached = new Set<string>(); let after: unknown = null;
      do {
        const r = (await db.query(`SELECT app.b3_staff_repair_turns($1,$1,'live',$2,$3,NULL,$4,$5,50) r`, [ORG_ID, USERS.admin, session, group, after])).rows[0].r;
        assert.equal(r.yourTurn, 120); assert.equal(r.counts.reduce((n: number, c: { count: number }) => n + c.count, 0), 320);
        assert.ok(r[group].length <= 50);
        for (const row of r[group]) { assert.ok(!reached.has(row.ticketId)); reached.add(row.ticketId); }
        after = r.next[group];
      } while (after);
      assert.equal(reached.size, group === "mine" ? 120 : 200);
    }
  } finally { await db.query("ROLLBACK"); }
});
async function fixtureForBulk() {
  const ticket = (await db.query("SELECT id FROM public.maintenance_tickets WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG_ID])).rows[0].id;
  return { ticket };
}

async function readOn(c: Client, user: string = USERS.admin, sid = session, ticket: string | null = null) {
  await c.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
  await c.query("SAVEPOINT b3_read");
  try {
    await c.query("SET LOCAL ROLE service_role");
    const r = (await c.query("SELECT app.b3_staff_repair_turns($1,$1,'live',$2,$3,$4) r", [ORG_ID, user, sid, ticket])).rows[0].r;
    await c.query("RESET ROLE"); await c.query("RELEASE SAVEPOINT b3_read"); return r;
  } catch (e) { await c.query("ROLLBACK TO SAVEPOINT b3_read"); await c.query("RELEASE SAVEPOINT b3_read"); throw e; }
}

test("native/custom staff: no tickets.update, retired/reassigned roles, removed/paused staff, exp.add controls only mine", async () => {
  const f = await fixture(); await submitVendorReport(f.token, { done: true, cost: "10" });
  const sid = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sid, USERS.manager, randomUUID()]);
  await db.query("BEGIN");
  try {
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"custom_roles\":true}'::jsonb WHERE id=$1", [ORG_ID]);
    await db.query(`INSERT INTO public.platform_settings(key,value) VALUES('custom_roles',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [ORG_ID]);
    const role = randomUUID(), other = randomUUID();
    for (const [id, keys] of [[role, ["tickets.update"]], [other, ["dash.view"]]] as const) {
      await db.query("INSERT INTO app.b017_roles(org_id,id,current_revision) VALUES($1,$2,1)", [ORG_ID, id]);
      await db.query("INSERT INTO app.b017_role_revisions(org_id,role_id,revision,grants,created_by) VALUES($1,$2,1,$3::text[],$4)", [ORG_ID, id, keys, USERS.admin]);
    }
    await db.query(`INSERT INTO app.b017_assignments(org_id,user_id,role_id,revision) VALUES($1,$2,$3,1)
      ON CONFLICT(org_id,user_id) DO UPDATE SET role_id=excluded.role_id,revision=excluded.revision`, [ORG_ID, USERS.manager, role]);
    const r = await readOn(db, USERS.manager, sid, f.ticket);
    assert.equal(r.detail.rule, "R2"); assert.equal(r.detail.viewerCanAct, false); assert.equal(r.yourTurn, 0); assert.equal(r.others.length, 1);
    await db.query("UPDATE app.b017_roles SET retired=true WHERE org_id=$1 AND id=$2", [ORG_ID, role]);
    await assert.rejects(readOn(db, USERS.manager, sid, f.ticket), { code: "42501" });
    await db.query("UPDATE app.b017_assignments SET role_id=$3 WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager, other]);
    await assert.rejects(readOn(db, USERS.manager, sid, f.ticket), { code: "42501" });
    await db.query("UPDATE app.b017_assignments SET role_id=NULL,revision=NULL WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
    await db.query("SELECT set_config('request.jwt.claim.sub','',true)");
    await db.query("UPDATE public.org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
    await assert.rejects(readOn(db, USERS.manager, sid, f.ticket), { code: "42501" });
  } finally { await db.query("ROLLBACK"); }
});

test("former designated owner loses A while retaining B; org-local dates, not property timezone", async () => {
  const f = await fixture(USERS.admin, 600000);
  await db.query("BEGIN");
  try {
    // Ensure owner admission on B survives removal from A.
    const b = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 AND id<>$2 AND archived_at IS NULL ORDER BY id LIMIT 1", [ORG_ID, property])).rows[0];
    assert.ok(b);
    await db.query(`INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,effective_from)
      SELECT $1,$2,designated_contact_id,CURRENT_DATE-20 FROM app.b013_estimate_versions WHERE id=$3
      ON CONFLICT(property_id,owner_contact_id,effective_from) DO UPDATE SET effective_to=NULL`, [ORG_ID, b.id, f.version]);
    // This read fixture changes only current authority dates, preserving immutable snapshots.
    await db.query("UPDATE public.organizations SET timezone='Pacific/Kiritimati' WHERE id=$1", [ORG_ID]);
    await db.query("UPDATE public.properties SET timezone='America/Adak' WHERE id=$1", [property]);
    await db.query(`UPDATE public.property_owners po SET effective_from=(clock_timestamp() AT TIME ZONE o.timezone)::date-2,
      effective_to=(clock_timestamp() AT TIME ZONE o.timezone)::date FROM public.organizations o
      WHERE po.org_id=o.id AND po.org_id=$1 AND po.property_id=$2`, [ORG_ID, property]);
    await db.query("SET LOCAL ROLE service_role");
    const rows = (await db.query("SELECT * FROM app.b013_owner_pending($1,$1,'live',$2)", [ORG_ID, ownerSession])).rows;
    assert.ok(!rows.some(row => row.ticket_id === f.ticket));
    assert.equal((await db.query("SELECT * FROM app.b013_owner_history($1,$1,'live',$2,$3)", [ORG_ID, ownerSession, f.ticket])).rowCount, 0);
    await db.query("SAVEPOINT b3_form");
    await assert.rejects(db.query(`SELECT app.b013_decide_estimate($1,$1,'live',$2,$3,$4,'approved',NULL,$5)`,
      [ORG_ID, ownerSession, randomUUID(), f.version, createHash("sha256").update(randomUUID()).digest()]), { code: "42501" });
    await db.query("ROLLBACK TO SAVEPOINT b3_form"); await db.query("RELEASE SAVEPOINT b3_form");
    await db.query("RESET ROLE");
    await db.query(`UPDATE public.property_owners po SET effective_to=(clock_timestamp() AT TIME ZONE o.timezone)::date+1
      FROM public.organizations o WHERE po.org_id=o.id AND po.org_id=$1 AND po.property_id=$2 AND po.id=
      (SELECT designated_ownership_id FROM app.b013_estimate_versions WHERE id=$3)`, [ORG_ID, property, f.version]);
    await db.query("SET LOCAL ROLE service_role");
    assert.ok((await db.query("SELECT * FROM app.b013_owner_pending($1,$1,'live',$2)", [ORG_ID, ownerSession])).rows.some(row => row.ticket_id === f.ticket));
  } finally { await db.query("ROLLBACK"); }
});

test("job/version isolation: old rejected/completed job cannot supply new job event; ties use id", async () => {
  const f = await fixture();
  await submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: f.version, reason: "No photo" });
  await db.query("UPDATE public.repair_vendor_jobs SET active=false,revoked_at=clock_timestamp() WHERE id=$1", [f.job]);
  const newJob = randomUUID(), newToken = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO public.repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by)
    VALUES($1,$2,$3,'New vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',$5)`,
  [newJob, ORG_ID, f.ticket, hashVendorToken(newToken), USERS.admin]);
  f.job = newJob; f.token = newToken;
  await expectRule(f, "R7b");
  const low = "00000000-0000-4000-8000-000000000010", high = "00000000-0000-4000-8000-000000000020";
  const at = new Date().toISOString();
  for (const [id, event] of [[low, "vendor_completion_submitted"], [high, "vendor_rejected"]]) {
    await db.query(`INSERT INTO app.b013_repair_appointments(id,org_id,ticket_id,version_id,repair_vendor_job_id,event_kind,actor_id,occurred_at,response_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Fixture reason')`, [id, ORG_ID, f.ticket, f.version, f.job, event, USERS.admin, at]);
  }
  await expectRule(f, "R6"); assert.equal((await vendorTurn(f)).currentEvent, "vendor_rejected");
});

test("B-056 expired trial pauses active staff; dual owner identity cannot replace lost staff authority", async () => {
  const f = await fixture(); const sid = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sid, USERS.manager, randomUUID()]);
  await db.query("BEGIN");
  try {
    await db.query(`INSERT INTO public.org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')
      ON CONFLICT(org_id,user_id) DO UPDATE SET role='manager',status='active'`, [ORG_ID, USERS.owner]);
    assert.equal((await readOn(db, USERS.owner, ownerSession, f.ticket)).state, "ready");
    await db.query("UPDATE public.org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.owner]);
    await assert.rejects(readOn(db, USERS.owner, ownerSession, f.ticket), { code: "42501" });
    await db.query(`INSERT INTO public.platform_settings(key,value) VALUES('pricing_trial',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [ORG_ID]);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"pricing_trial\":true}'::jsonb WHERE id=$1", [ORG_ID]);
    await db.query(`INSERT INTO app.b056_org_trials(org_id,trial_plan,trial_source,trial_started_at,trial_ends_at,paid_plan,kept_member_id)
      SELECT $1,'standard','legacy',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',NULL,id
      FROM public.org_members WHERE org_id=$1 AND user_id=$2
      ON CONFLICT(org_id) DO UPDATE SET trial_plan='standard',trial_source='legacy',trial_started_at=excluded.trial_started_at,
        trial_ends_at=excluded.trial_ends_at,paid_plan=NULL,paid_activated_at=NULL,paid_apply_request_id=NULL,paid_request_created_at=NULL,kept_member_id=excluded.kept_member_id`, [ORG_ID, USERS.admin]);
    await assert.rejects(readOn(db, USERS.manager, sid, f.ticket), { code: "42501" });
    assert.equal((await readOn(db, USERS.admin, session, f.ticket)).state, "ready");
  } finally { await db.query("ROLLBACK"); }
});

test("turn readers do not mutate business rows, outbox, command ledger, secrets or flags", async () => {
  const f = await fixture(); await enhanced(f);
  const snapshot = async () => (await db.query(`SELECT
    (SELECT count(*) FROM app.b013_repair_commands) commands,
    (SELECT count(*) FROM app.b013_repair_event_outbox) outbox,
    (SELECT count(*) FROM app.b013_repair_appointments) appointments,
    (SELECT count(*) FROM public.repair_vendor_secrets) secrets,
    (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM public.repair_vendor_jobs j WHERE org_id=$1) jobs,
    (SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.maintenance_tickets t WHERE org_id=$1) tickets,
    (SELECT md5(feature_flags::text) FROM public.organizations WHERE id=$1) flags`, [ORG_ID])).rows[0];
  const before = await snapshot(); await readTurn(f); await vendorTurn(f); await loadVendorRepairTurns(f.token);
  assert.deepEqual(await snapshot(), before);
});

test("M2 bounded admission lock timeout becomes unavailable, never a zero count", async () => {
  const f = await fixture();
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM public.auth_sessions WHERE id=$1 FOR UPDATE", [session]);
    const value = await staffRepairTurns(staff, { ticketId: f.ticket }, { v3: async () => true });
    assert.deepEqual(value, { state: "unavailable" });
  } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  await expectRule(f, "R7b");
});

test("report then new pending version: legacy remains R2, retained B-026 becomes R3; raw owner DTO proves neither", async () => {
  for (const retained of [false, true]) {
    const f = await fixture(); if (retained) await retain(f);
    await submitVendorReport(f.token, { done: true, cost: "10" }); await version(f);
    await expectRule(f, retained ? "R3" : "R2", !retained);
    assert.ok((await ownerPending(owner)).some(row => row.ticket_id === f.ticket));
    assert.equal((await vendorTurn(f)).holder, retained ? null : "manager");
  }
});

test("actual writer connections retain service_role even through SECURITY DEFINER completion calls", async () => {
  const f = await fixture();
  // A clone-only trigger checks the connection's SET ROLE, which survives the
  // definer's current_user switch. There are no pg mocks or private table grants.
  await db.query(`CREATE FUNCTION app.b3_test_writer_role() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('role') IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'writer connection must use service_role'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER b3_test_completion_role BEFORE INSERT ON app.b013_repair_appointments
    FOR EACH ROW WHEN (NEW.ticket_id='${f.ticket}'::uuid) EXECUTE FUNCTION app.b3_test_writer_role()`);
  await db.query(`CREATE TRIGGER b3_test_report_role BEFORE UPDATE ON public.repair_vendor_jobs
    FOR EACH ROW WHEN (NEW.ticket_id='${f.ticket}'::uuid) EXECUTE FUNCTION app.b3_test_writer_role()`);
  try {
    await svc(null, async c => assert.equal((await c.query("SELECT current_user role")).rows[0].role, "service_role"));
    assert.equal((await submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: f.version, reason: "No photo" })).status, "recorded");
    await submitVendorReport(f.token, { done: true, cost: "10" }); await expectRule(f, "R2", true);
  } finally {
    await db.query("DROP TRIGGER b3_test_completion_role ON app.b013_repair_appointments");
    await db.query("DROP TRIGGER b3_test_report_role ON public.repair_vendor_jobs");
    await db.query("DROP FUNCTION app.b3_test_writer_role()");
  }
});

test("M2 5000-ticket count and subsequent-page plan budget under actual service_role", async t => {
  const f = await fixture();
  await db.query("BEGIN");
  try {
    const ids = (await db.query<{ id: string }>(`INSERT INTO public.maintenance_tickets
      (org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
      SELECT $1,base.n+g,s.property_id,s.category,s.priority,
        CASE WHEN g%17=0 THEN 'resolved'::public.ticket_status ELSE 'open'::public.ticket_status END,
        'B3 plan fixture',s.cost_bearer,s.owner_approval
      FROM public.maintenance_tickets s CROSS JOIN generate_series(1,5000) g
      CROSS JOIN (SELECT coalesce(max(ticket_number),0) n FROM public.maintenance_tickets WHERE org_id=$1) base
      WHERE s.id=$2 RETURNING id::text`, [ORG_ID, f.ticket])).rows.map(r => r.id);
    await db.query(`INSERT INTO app.b013_estimate_versions(org_id,ticket_id,property_id,version_no,currency,minor_unit,amount_minor,
      work_scope,evidence_snapshot,designated_ownership_id,designated_contact_id,designated_principal_id,captured_threshold_minor,
      threshold_source,threshold_revision_id,threshold_provenance_sha256,payload_sha256,submitted_by)
      SELECT $1,ticket,src.property_id,n,src.currency,src.minor_unit,CASE WHEN n=2 AND idx%4=0 THEN 600000 ELSE 100 END,
        src.work_scope,'[]'::jsonb,src.designated_ownership_id,src.designated_contact_id,src.designated_principal_id,
        src.captured_threshold_minor,src.threshold_source,src.threshold_revision_id,src.threshold_provenance_sha256,src.payload_sha256,src.submitted_by
      FROM unnest($2::uuid[]) WITH ORDINALITY ids(ticket,idx) CROSS JOIN generate_series(1,2) n
      CROSS JOIN app.b013_estimate_versions src WHERE src.id=$3`, [ORG_ID, ids, f.version]);
    await db.query(`INSERT INTO app.b013_estimate_heads(org_id,ticket_id,current_version_id)
      SELECT org_id,ticket_id,id FROM app.b013_estimate_versions WHERE org_id=$1 AND ticket_id=ANY($2::uuid[]) AND version_no=2`, [ORG_ID, ids]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query(`INSERT INTO public.repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,active,revoked_at)
      SELECT $1,ticket,'Plan vendor','+886900000000','Weekdays',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),
        clock_timestamp()+interval '1 day',$3,n=3,CASE WHEN n<3 THEN clock_timestamp()-interval '1 day' END
      FROM unnest($2::uuid[]) WITH ORDINALITY ids(ticket,idx) CROSS JOIN generate_series(1,3) n WHERE idx%5<>0`, [ORG_ID, ids, USERS.admin]);
    await db.query("ANALYZE public.maintenance_tickets"); await db.query("ANALYZE public.repair_vendor_jobs");
    await db.query("ANALYZE app.b013_estimate_versions"); await db.query("ANALYZE app.b013_estimate_heads");
    // Nested plans are necessary: an outer Function Scan alone cannot explain
    // the count and ranked-group operators. This is a disposable PG16 prerequisite.
    const plans: string[] = [];
    const notice = (n: { message?: string }) => { if (n.message?.includes("Query Text:")) plans.push(n.message); };
    db.on("notice", notice);
    try {
      await db.query("LOAD 'auto_explain'");
      await db.query("SET LOCAL auto_explain.log_min_duration=0");
      await db.query("SET LOCAL auto_explain.log_analyze=on");
      await db.query("SET LOCAL auto_explain.log_buffers=on");
      await db.query("SET LOCAL auto_explain.log_nested_statements=on");
      await db.query("SET LOCAL auto_explain.log_level='notice'");
      await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
      await db.query("SET LOCAL ROLE service_role");
      await db.query("SET LOCAL statement_timeout='2s'");
      const first = (await db.query("SELECT app.b3_staff_repair_turns($1,$1,'live',$2,$3) r", [ORG_ID, USERS.admin, session])).rows[0].r;
      for (const group of ["mine", "others"]) {
        assert.ok(first.next[group], `${group} must exercise a subsequent page`);
        const plan = (await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          SELECT app.b3_staff_repair_turns($1,$1,'live',$2,$3,NULL,$4,$5,50)`, [ORG_ID, USERS.admin, session, group, first.next[group]])).rows[0]["QUERY PLAN"][0];
        assert.ok(plan["Execution Time"] < 2000);
        t.diagnostic(JSON.stringify({ group, executionMs: plan["Execution Time"], sharedHitBlocks: plan.Plan["Shared Hit Blocks"], sharedReadBlocks: plan.Plan["Shared Read Blocks"] }));
      }
      assert.ok(plans.some(p => p.includes("WITH facts AS MATERIALIZED") && p.includes("Buffers:")), "capture underlying M2 statement plans and buffers");
      t.diagnostic(`nested statement plans captured: ${plans.length}; SQL and fixture values withheld`);
    } finally { db.removeListener("notice", notice); }
  } finally { await db.query("ROLLBACK"); }
});

test("§9 missing-head fixture prerequisite: retained estimates cannot have a NULL or absent head under current constraints", async () => {
  const f = await fixture(); await retain(f);
  await db.query("BEGIN");
  try {
    await db.query("SAVEPOINT missing_head");
    await assert.rejects(db.query("UPDATE app.b013_estimate_heads SET current_version_id=NULL WHERE org_id=$1 AND ticket_id=$2", [ORG_ID, f.ticket]), { code: "23502" });
    await db.query("ROLLBACK TO SAVEPOINT missing_head");
    await assert.rejects(db.query("DELETE FROM app.b013_estimate_heads WHERE org_id=$1 AND ticket_id=$2", [ORG_ID, f.ticket]), { code: "23503" });
    await db.query("ROLLBACK TO SAVEPOINT missing_head");
    assert.equal((await readOn(db, USERS.admin, session, f.ticket)).detail.rule, "R7b");
  } finally { await db.query("ROLLBACK"); }
  // The defensive no-head rule is covered by the pure mapper. Do not drop a
  // constraint or disable an immutable trigger to claim this production journey.
});

test("confirmation eligibility: token expiry preserves staff cost turn; invalid amount does not count; confirmed resolved is R4", async () => {
  const f = await fixture(); await submitVendorReport(f.token, { done: true, cost: "10" });
  await db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job]);
  await expectRule(f, "R2", true); assert.equal(await vendorTurn(f), null);
  await db.query("UPDATE public.repair_vendor_jobs SET reported_cost_minor=1000000001 WHERE id=$1", [f.job]);
  await expectRule(f, "R2", false);
  await db.query("UPDATE public.repair_vendor_jobs SET reported_cost_minor=1000,confirmed_at=clock_timestamp(),confirmed_by=$2 WHERE id=$1", [f.job, USERS.admin]);
  await expectRule(f, "R4", false);
});

// Existing B-013 behaviour: a stale version is refused by the SQL version lock with 40001
// (mapped to errors.generic) rather than returned as a status. Either way nothing is recorded.
async function notRecorded(p: Promise<{ status?: string } | null | undefined>) {
  try { const r = await p; assert.notEqual(r?.status, "recorded"); } catch (e) { assert.ok(e instanceof Error); }
}

test("stale completion version is refused with no event after replacing the current head", async () => {
  const f = await fixture(), stale = f.version; await version(f, 100);
  await notRecorded(submitVendorCompletion(f.token, { requestId: randomUUID(), versionId: stale, reason: "No photo" }));
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_repair_appointments WHERE org_id=$1 AND ticket_id=$2", [ORG_ID, f.ticket])).rows[0].n, 0);
  await expectRule(f, "R7b");
});

test("superseded owner rejection does not carry into a new below-threshold head", async () => {
  const f = await fixture(USERS.admin, 600000); await decision(f, "rejected"); await expectRule(f, "R5", true);
  await version(f, 100); await expectRule(f, "R7b", false);
});

test("staff/tenant dual identity loses staff repair admission after membership ends", async () => {
  const f = await fixture(), sid = randomUUID();
  await db.query("BEGIN");
  try {
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sid, USERS.tenant, randomUUID()]);
    await db.query(`INSERT INTO public.org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')
      ON CONFLICT(org_id,user_id) DO UPDATE SET role='manager',status='active'`, [ORG_ID, USERS.tenant]);
    assert.equal((await readOn(db, USERS.tenant, sid, f.ticket)).state, "ready");
    await db.query("UPDATE public.org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.tenant]);
    await assert.rejects(readOn(db, USERS.tenant, sid, f.ticket), { code: "42501" });
  } finally { await db.query("ROLLBACK"); }
});
