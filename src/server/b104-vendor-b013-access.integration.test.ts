import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
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

async function fixture(createdBy: string | null = USERS.admin) {
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
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,100,$5::text,$6::smallint,
      'Repair pipe','[]'::jsonb,$7::bytea) r`,
    [ORG_ID, session, randomUUID(), ticket, currency, minorUnit, createHash("sha256").update(ticket).digest()])).rows[0].r;
  });
  assert.equal(estimate.status, "recorded");
  assert.equal(estimate.requires_owner_decision, false);
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
