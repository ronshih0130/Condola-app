import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import React from "react";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { confirmVendorCasePhoto, decideVendorCase, loadVendorCase, type VendorCase } from "./b105-vendor-case";
import { issueVendorUploadGrant } from "./ticket-photos";
import { hashVendorToken } from "./vendor-repair-rules";
import { POST as decisionRoute } from "../app/api/vendor-jobs/case-decision/route";

// Real connections, gateways and writers; no pg mock and no table-grant workaround.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const session = randomUUID();
const ORG_FLAGS = { vendor_dispatch: true, vendor_link: true, brand_v2: true, brand_v3: true, vendor_job_v3: true, repair_approvals: true };
let property: string, currency: string, minorUnit: number;
let savedServiceKey: string | undefined;
type Fixture = { org: string; ticket: string; job: string; token: string; contact: string };

async function setPlatform(key: string, orgs: string[], enabled = true) {
  await db.query(`INSERT INTO public.platform_settings(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify({ enabled, allowed_org_ids: orgs })]);
}
async function admitPlatform(orgs: string[]) {
  for (const key of ["vendor_job_v3", "vendor_link", "repair_approvals"]) await setPlatform(key, orgs);
}
async function orgFlags(org: string, patch: Record<string, unknown>) {
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
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
  // Upload grants are HMACs keyed by the service key; a test-only key when the local env has none.
  savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!savedServiceKey) process.env.SUPABASE_SERVICE_ROLE_KEY = randomBytes(32).toString("hex");
  // Both orgs carry every org flag; only ORG_ID is on the platform allowlists unless a test says otherwise.
  await db.query("UPDATE public.organizations SET plan_tier='beta' WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
  for (const org of [ORG_ID, ORG2_ID]) await orgFlags(org, ORG_FLAGS);
  await admitPlatform([ORG_ID]);
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
  if (savedServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

async function vendorContact(org: string) {
  return (await db.query(`INSERT INTO public.contacts(org_id,is_vendor,display_name,phone_e164,vendor_trade)
    VALUES($1,true,$2,'+886900000001','plumbing') RETURNING id::text`, [org, `B-105 vendor ${randomUUID().slice(0, 8)}`])).rows[0].id as string;
}

async function fixture(org = ORG_ID): Promise<Fixture> {
  const ticket = randomUUID(), job = randomUUID(), token = randomBytes(32).toString("base64url");
  const contact = await vendorContact(org);
  const place = org === ORG_ID ? property
    : (await db.query("SELECT id FROM public.properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1", [org])).rows[0].id;
  const inserted = await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval,assigned_vendor_contact_id)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'assigned','浴室天花板滴水',cost_bearer,owner_approval,$4
    FROM public.maintenance_tickets WHERE org_id=$5 ORDER BY id LIMIT 1`, [ticket, org, place, contact, ORG_ID]);
  assert.equal(inserted.rowCount, 1);
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,
     scope,sharing_approved_at,sharing_approved_by,shared_description,vendor_contact_id)
    VALUES($1,$2,$3,'B-105 vendor','+886900000001','平日白天',$4,clock_timestamp()+interval '1 day',NULL,
     'case_collaboration',clock_timestamp(),NULL,'浴室天花板滴水',$5)`, [job, org, ticket, hashVendorToken(token), contact]);
  await db.query("INSERT INTO public.repair_vendor_secrets(job_id,token) VALUES($1,$2)", [job, token]);
  return { org, ticket, job, token, contact };
}

/** A pre-existing attachment written outside B-105 (tenant, internal, another job, or a legacy V-TOKEN upload). */
async function storedPhoto(f: Fixture, opts: { vendorJob?: string | null; internal?: boolean; name?: string } = {}) {
  const file = randomUUID(), path = `org/${f.org}/tickets/${f.ticket}/${file}.jpg`;
  await db.query(`INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
    VALUES($1,$2,'ticket-photos-private',$3,$4,'image/jpeg',100)`, [file, f.org, path, opts.name ?? `${file.slice(0, 6)}.jpg`]);
  const id = (await db.query(`INSERT INTO public.ticket_attachments(org_id,ticket_id,file_id,is_internal,vendor_job_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id::text`, [f.org, f.ticket, file, opts.internal ?? false,
    opts.vendorJob === undefined ? f.job : opts.vendorJob])).rows[0].id as string;
  return { id, file, path };
}

/** app.b105_vendor_attach_photo called directly as service_role. */
async function attachSql(token: string, f: Fixture, phase = "before", file = randomUUID(), path?: string, name = "b105.jpg") {
  return svc(null, async client => {
    assert.equal((await client.query("SELECT current_user r")).rows[0].r, "service_role");
    return (await client.query("SELECT app.b105_vendor_attach_photo($1,false,$2::uuid,$3,$4,'image/jpeg',100,$5) r",
      [hashVendorToken(token), file, path ?? `org/${f.org}/tickets/${f.ticket}/${file}.jpg`, name, phase])).rows[0].r;
  });
}
/** app.b105_vendor_decide called directly as service_role. */
function decideSql(token: string, decision: string, opts: { reason?: string | null; date?: string | null; request?: string } = {}) {
  return svc(null, async client => (await client.query("SELECT app.b105_vendor_decide($1,false,$2::uuid,$3,$4::date,$5) r",
    [hashVendorToken(token), opts.request ?? randomUUID(), decision, opts.date ?? null, opts.reason ?? null])).rows[0].r);
}

async function ready(token: string): Promise<VendorCase> {
  const loaded = await loadVendorCase(token);
  assert.equal(loaded?.state, "ready");
  return (loaded as { value: VendorCase }).value;
}
const decisionRows = async (job: string) => (await db.query(
  "SELECT vendor_job_id,org_id,ticket_id,decision,agreed_completion_on::text,decline_reason,request_id,decided_at::text FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1", [job])).rows;
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
/** svc wraps database errors; a gateway refusal is SQLSTATE 42501 underneath. */
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501";
const accept = (token: string, agreedOn: string | null = null, requestId = randomUUID()) =>
  decideVendorCase(token, { requestId, decision: "accepted", agreedOn, reason: null });
const decline = (token: string, reason: string | null = null, requestId = randomUUID()) =>
  decideVendorCase(token, { requestId, decision: "declined", agreedOn: null, reason });

/** Everything a B-105 writer could change for this ticket. */
async function snapshot(f: Fixture) {
  return JSON.stringify({
    decisions: (await db.query("SELECT * FROM app.b105_vendor_job_decisions WHERE ticket_id=$1 ORDER BY vendor_job_id", [f.ticket])).rows,
    attachments: (await db.query("SELECT id,file_id,phase,vendor_job_id,is_internal FROM public.ticket_attachments WHERE ticket_id=$1 ORDER BY id", [f.ticket])).rows,
    files: (await db.query("SELECT id,storage_path FROM public.files WHERE storage_path LIKE $1 ORDER BY id", [`org/${f.org}/tickets/${f.ticket}/%`])).rows,
  });
}

/** Proven access first: accept, then a successful attach. */
async function admitted(f: Fixture) {
  assert.deepEqual(await accept(f.token), { status: "recorded", decision: "accepted", replayed: false });
  assert.equal((await attachSql(f.token, f)).status, "recorded");
  assert.equal((await ready(f.token)).decision, "accepted");
}

/** Every read and write path refuses, and nothing changes. */
async function assertDenied(f: Fixture, label: string) {
  const before = await snapshot(f);
  assert.equal(await loadVendorCase(f.token), null, label);
  await assert.rejects(accept(f.token), notFound, `${label}: accept`);
  await assert.rejects(decline(f.token, "x"), notFound, `${label}: decline`);
  await assert.rejects(decideSql(f.token, "accepted"), refused, `${label}: SQL accept`);
  await assert.rejects(decideSql(f.token, "declined", { reason: "x" }), refused, `${label}: SQL decline`);
  await assert.rejects(attachSql(f.token, f, "before"), refused, `${label}: attach before`);
  await assert.rejects(attachSql(f.token, f, "after"), refused, `${label}: attach after`);
  assert.equal(await snapshot(f), before, `${label}: no writes`);
}

test("API roles: gateways service-only, internal helpers unexecutable, private table fully revoked with RLS on", async () => {
  const gateways = ["app.b105_vendor_case(text,boolean)", "app.b105_vendor_case_admitted(text,boolean)",
    "app.b105_vendor_decide(text,boolean,uuid,text,date,text)", "app.b105_vendor_attach_photo(text,boolean,uuid,text,text,text,bigint,text)"];
  const helpers = ["app.b105_enabled(uuid,boolean)", "app.b105_read_job(text,boolean)", "app.b105_vendor_write_job(text,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role" && gateways.includes(signature), `${role} EXECUTE ${signature}`);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.b105_vendor_job_decisions',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
    }
    for (const column of (await db.query("SELECT attname FROM pg_attribute WHERE attrelid='app.b105_vendor_job_decisions'::regclass AND attnum>0 AND NOT attisdropped")).rows) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        assert.equal((await db.query("SELECT has_column_privilege($1,'app.b105_vendor_job_decisions',$2,$3) ok", [role, column.attname, privilege])).rows[0].ok,
          false, `${role} ${privilege}(${column.attname})`);
      }
    }
    await db.query("BEGIN");
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(db.query("SELECT 1 FROM app.b105_vendor_job_decisions"), { code: "42501" });
    } finally { await db.query("ROLLBACK"); }
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.column_privileges WHERE table_schema='app' AND table_name='b105_vendor_job_decisions' AND grantee IN ('anon','authenticated','service_role','PUBLIC')")).rows[0].n, 0);
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b105_vendor_job_decisions'::regclass")).rows[0].relrowsecurity, true);
});

test("each gate on its own denies an otherwise admitted bearer, with no writes; restoring it admits again", async () => {
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["org vendor_job_v3 false", () => orgFlags(ORG_ID, { vendor_job_v3: false }), () => orgFlags(ORG_ID, { vendor_job_v3: true })],
    ["org vendor_job_v3 absent (default)", () => db.query("UPDATE public.organizations SET feature_flags=feature_flags-'vendor_job_v3' WHERE id=$1", [ORG_ID]), () => orgFlags(ORG_ID, { vendor_job_v3: true })],
    ["platform vendor_job_v3 at its seeded default", () => db.query("UPDATE public.platform_settings SET value='{\"enabled\":false,\"allowed_org_ids\":[]}'::jsonb WHERE key='vendor_job_v3'"), () => setPlatform("vendor_job_v3", [ORG_ID])],
    ["platform vendor_job_v3 row absent", () => db.query("DELETE FROM public.platform_settings WHERE key='vendor_job_v3'"), () => setPlatform("vendor_job_v3", [ORG_ID])],
    ["platform vendor_job_v3 ON but org not allowlisted", () => setPlatform("vendor_job_v3", [ORG2_ID]), () => setPlatform("vendor_job_v3", [ORG_ID])],
    ["platform vendor_job_v3 disabled, ORG_ID still allowlisted", () => setPlatform("vendor_job_v3", [ORG_ID], false), () => setPlatform("vendor_job_v3", [ORG_ID])],
    ["org vendor_dispatch false", () => orgFlags(ORG_ID, { vendor_dispatch: false }), () => orgFlags(ORG_ID, { vendor_dispatch: true })],
    ["org vendor_link false", () => orgFlags(ORG_ID, { vendor_link: false }), () => orgFlags(ORG_ID, { vendor_link: true })],
    ["platform vendor_link disabled", () => setPlatform("vendor_link", [ORG_ID], false), () => setPlatform("vendor_link", [ORG_ID])],
    ["platform vendor_link ON but ORG_ID off its allowlist", () => setPlatform("vendor_link", [ORG2_ID]), () => setPlatform("vendor_link", [ORG_ID])],
    ["org brand_v3 false", () => orgFlags(ORG_ID, { brand_v3: false }), () => orgFlags(ORG_ID, { brand_v3: true })],
  ];
  for (const [label, apply, restore] of gates) {
    const f = await fixture();
    await admitted(f);
    await apply();
    try { await assertDenied(f, label); } finally { await restore(); }
    assert.equal((await ready(f.token)).decision, "accepted", `${label}: restored`);
  }
});

test("link matrix: each condition alone (revoked, inactive, expired, unshared, wrong scope, reassigned) denies", async () => {
  const cases: [string, (f: Fixture) => Promise<unknown>][] = [
    ["revoked only", f => db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [f.job])],
    ["inactive only", f => db.query("UPDATE public.repair_vendor_jobs SET active=false WHERE id=$1", [f.job])],
    ["expired", f => db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job])],
    ["unshared", f => db.query("UPDATE public.repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1", [f.job])],
    ["reassigned to no vendor", f => db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1", [f.ticket])],
    ["reassigned to another vendor", async f => db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [f.ticket, await vendorContact(f.org)])],
  ];
  for (const [label, mutate] of cases) {
    const f = await fixture();
    await admitted(f);
    const revokedOnly = (await db.query("SELECT active FROM public.repair_vendor_jobs WHERE id=$1", [f.job])).rows[0].active;
    assert.equal(revokedOnly, true);
    await mutate(f);
    await assertDenied(f, label);
  }
  // Wrong scope: the column only allows case_collaboration, so lift the CHECK for this one row in the clone.
  const f = await fixture();
  await admitted(f);
  await db.query("ALTER TABLE public.repair_vendor_jobs DROP CONSTRAINT repair_vendor_jobs_scope_check");
  try {
    await db.query("UPDATE public.repair_vendor_jobs SET scope='legacy_single_job' WHERE id=$1", [f.job]);
    await assertDenied(f, "wrong scope");
  } finally {
    await db.query("UPDATE public.repair_vendor_jobs SET scope='case_collaboration' WHERE id=$1", [f.job]);
    await db.query("ALTER TABLE public.repair_vendor_jobs ADD CONSTRAINT repair_vendor_jobs_scope_check CHECK (scope='case_collaboration')");
  }
  assert.equal((await ready(f.token)).decision, "accepted");
  await assert.rejects(accept(randomBytes(32).toString("base64url")), notFound, "unknown token");
});

test("cross-org: a fully admitted token in another org reads and writes only its own job", async () => {
  await admitPlatform([ORG_ID, ORG2_ID]);
  try {
    const mine = await fixture(), theirs = await fixture(ORG2_ID);
    await admitted(mine); await admitted(theirs);
    const before = await snapshot(mine);
    const view = await ready(theirs.token);
    assert.equal(view.company, (await db.query("SELECT name FROM public.organizations WHERE id=$1", [ORG2_ID])).rows[0].name);
    assert.equal(view.photos.length, 1);
    const target = await storedPhoto(mine, { name: "theirs-cannot-touch.jpg" });
    const beforeTarget = await snapshot(mine);
    assert.notEqual(before, beforeTarget);
    // The path must sit under the bearer's own org and ticket, so another org's object is invalid before any lookup.
    assert.deepEqual(await attachSql(theirs.token, mine, "before", target.file, target.path), { status: "rejected_invalid" }, "existing object in another org");
    assert.deepEqual(await attachSql(theirs.token, mine, "before"), { status: "rejected_invalid" }, "a new path under another org's ticket");
    await decideSql(theirs.token, "declined", { reason: "x" });
    assert.equal(await snapshot(mine), beforeTarget, "nothing in ORG_ID changed");
    await admitPlatform([ORG_ID]);
    await assertDenied(theirs, "ORG2 off the allowlists");
  } finally { await admitPlatform([ORG_ID]); }
});

test("same ticket, accepted token: tenant, internal, another job's and legacy uploads can never be (re)tagged", async () => {
  const f = await fixture();
  await admitted(f);
  const old = randomUUID();
  await db.query(`INSERT INTO public.repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,revoked_at,active)
    VALUES($1,$2,$3,'Old','+886900000002','x',$4,clock_timestamp()+interval '1 day',clock_timestamp(),false)`,
  [old, ORG_ID, f.ticket, hashVendorToken(randomBytes(32).toString("base64url"))]);
  const targets = {
    tenant: await storedPhoto(f, { vendorJob: null, name: "tenant.jpg" }),
    internal: await storedPhoto(f, { internal: true, name: "internal.jpg" }),
    oldJob: await storedPhoto(f, { vendorJob: old, name: "old-job.jpg" }),
    legacyOwn: await storedPhoto(f, { name: "legacy-own.jpg" }),
  };
  const before = await snapshot(f);
  for (const [label, target] of Object.entries(targets)) {
    for (const phase of ["before", "after"]) {
      await assert.rejects(attachSql(f.token, f, phase, target.file, target.path), refused, `${label} by file id + path (${phase})`);
      assert.deepEqual(await attachSql(f.token, f, phase, randomUUID(), target.path), { status: "rejected_invalid" }, `${label} by path with another file id (${phase})`);
      await assert.rejects(attachSql(f.token, f, phase, target.file, `org/${f.org}/tickets/${f.ticket}/${target.file}.png`), refused, `${label} by file id (${phase})`);
    }
  }
  assert.equal(await snapshot(f), before);
  for (const target of Object.values(targets)) {
    assert.equal((await db.query("SELECT phase FROM public.ticket_attachments WHERE id=$1", [target.id])).rows[0].phase, null);
  }
  // Only this job's own non-internal uploads are read; the legacy upload is the 處理後 set (GS-27).
  const names = (await ready(f.token)).photos.map(p => [p.name, p.phase]);
  assert.deepEqual(names, [["b105.jpg", "before"], ["legacy-own.jpg", "after"]]);
});

test("decisions are idempotent per job through the app and the SQL gateway; the first row never changes", async () => {
  // Accept first: replays with a new request id or another date leave the row byte-identical.
  const a = await fixture();
  await db.query("UPDATE public.maintenance_tickets SET scheduled_on=DATE '2026-11-20' WHERE id=$1", [a.ticket]);
  assert.deepEqual(await accept(a.token, "2026-11-19"), { status: "rejected_invalid" }, "MGT-104-AC4");
  assert.deepEqual(await accept(a.token, "2026-02-30"), { status: "rejected_invalid" }, "impossible date: cast error is invalid, not a 500");
  assert.deepEqual(await decisionRows(a.job), []);
  const request = randomUUID();
  assert.deepEqual(await accept(a.token, "2026-11-21", request), { status: "recorded", decision: "accepted", replayed: false });
  const first = await decisionRows(a.job);
  assert.equal(first.length, 1); assert.equal(first[0].agreed_completion_on, "2026-11-21"); assert.equal(first[0].request_id, request);
  assert.deepEqual(await accept(a.token, "2026-11-21", request), { status: "recorded", decision: "accepted", replayed: true });
  assert.deepEqual(await accept(a.token, "2026-11-30"), { status: "recorded", decision: "accepted", replayed: true });
  assert.deepEqual(await decideSql(a.token, "accepted", { date: "2026-12-31" }), { status: "recorded", decision: "accepted", replayed: true });
  assert.deepEqual(await decline(a.token, "late"), { status: "rejected_conflict" });
  assert.deepEqual(await decideSql(a.token, "declined", { reason: "late" }), { status: "rejected_conflict" });
  assert.deepEqual(await decisionRows(a.job), first);

  // Decline first with a reason: other reasons, no reason, and accept never change it.
  const b = await fixture();
  assert.deepEqual(await decline(b.token, "這週排不出時間"), { status: "recorded", decision: "declined", replayed: false });
  const declined = await decisionRows(b.job);
  assert.equal(declined[0].decline_reason, "這週排不出時間");
  assert.deepEqual(await decline(b.token, "另一個原因"), { status: "recorded", decision: "declined", replayed: true });
  assert.deepEqual(await decline(b.token, null), { status: "recorded", decision: "declined", replayed: true });
  assert.deepEqual(await decideSql(b.token, "declined", { reason: "SQL 原因" }), { status: "recorded", decision: "declined", replayed: true });
  assert.deepEqual(await accept(b.token), { status: "rejected_conflict" });
  assert.deepEqual(await decisionRows(b.job), declined);

  // Decline first without a reason (GS-49 optional): a later reason is not added.
  const c = await fixture();
  await decline(c.token, null);
  const bare = await decisionRows(c.job);
  assert.equal(bare[0].decline_reason, null);
  assert.deepEqual(await decline(c.token, "補一個原因"), { status: "recorded", decision: "declined", replayed: true });
  assert.deepEqual(await decisionRows(c.job), bare);
  assert.equal((await ready(c.token)).decision, "declined");
  // A declined job has no photo writes.
  const before = await snapshot(c);
  await assert.rejects(attachSql(c.token, c), refused);
  assert.equal(await snapshot(c), before);
});

test("the decision route answers 400 for impossible dates and 404 for a refused bearer", async () => {
  const f = await fixture();
  const post = (body: unknown) => decisionRoute(new Request("http://localhost/api/vendor-jobs/case-decision", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
  assert.equal((await post({ token: f.token, requestId: randomUUID(), decision: "accepted", agreedOn: "2026-02-30" })).status, 400);
  assert.deepEqual(await decisionRows(f.job), []);
  await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [f.job]);
  assert.equal((await post({ token: f.token, requestId: randomUUID(), decision: "accepted", agreedOn: null })).status, 404);
  assert.deepEqual(await decisionRows(f.job), []);
});

test("RV-JOB-WAIT: an over-threshold current estimate waits for the owner; a recorded small one does not", async () => {
  const f = await fixture();
  await accept(f.token);
  assert.equal((await ready(f.token)).ownerWaitVersion, null);
  const estimate = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,$8::bigint,$5::text,$6::smallint,
      'Repair ceiling','[]'::jsonb,$7::bytea) r`,
  [ORG_ID, session, randomUUID(), f.ticket, currency, minorUnit, createHash("sha256").update(f.ticket).digest(), 600000])).rows[0].r);
  assert.equal(estimate.status, "recorded"); assert.equal(estimate.requires_owner_decision, true);
  assert.equal((await ready(f.token)).ownerWaitVersion, 1);

  const g = await fixture();
  await accept(g.token);
  const small = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,100::bigint,$5::text,$6::smallint,'Small','[]'::jsonb,$7::bytea) r`,
  [ORG_ID, session, randomUUID(), g.ticket, currency, minorUnit, createHash("sha256").update(g.ticket).digest()])).rows[0].r);
  assert.equal(small.status, "recorded");
  assert.equal(small.requires_owner_decision, false);
  const head = (await db.query(`SELECT h.current_version_id::text id, v.version_no, v.requires_owner_decision
    FROM app.b013_estimate_heads h JOIN app.b013_estimate_versions v ON v.org_id=h.org_id AND v.id=h.current_version_id
    WHERE h.org_id=$1 AND h.ticket_id=$2`, [ORG_ID, g.ticket])).rows[0];
  assert.deepEqual(head, { id: String(small.version_id), version_no: "1", requires_owner_decision: false });
  assert.equal((await ready(g.token)).ownerWaitVersion, null);
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
function upload(f: Fixture) {
  const file = randomUUID(), path = `org/${f.org}/tickets/${f.ticket}/${file}.jpg`;
  return { file, path, input: { path, fileName: "修好.jpg", mime: "image/jpeg", size: 2048, uploadToken: issueVendorUploadGrant(hashVendorToken(f.token), f.ticket, path) } };
}

test("confirmVendorCasePhoto: valid credentials attach atomically with the set; close, decline and races leave nothing", async () => {
  let inspected = 0;
  const deps = { inspect: async () => { inspected++; return { size: 2048, mime: "image/jpeg", header: JPEG }; } };
  const f = await fixture();
  await accept(f.token);
  // Control: a valid upload is attached with its set in one write.
  const ok = upload(f);
  const id = await confirmVendorCasePhoto(f.token, "before", ok.input, deps);
  const row = (await db.query(`SELECT a.phase,a.vendor_job_id::text,a.is_internal,f.storage_path,f.size_bytes::int size
    FROM public.ticket_attachments a JOIN public.files f ON f.id=a.file_id WHERE a.id=$1`, [id])).rows[0];
  assert.deepEqual(row, { phase: "before", vendor_job_id: f.job, is_internal: false, storage_path: ok.path, size: 2048 });
  const afterControl = await snapshot(f);
  assert.equal(await confirmVendorCasePhoto(f.token, "before", ok.input, deps), id, "a retry returns the same attachment");
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", ok.input, deps), notFound, "an attached photo never moves sets");
  assert.equal(await snapshot(f), afterControl);
  // Forged grant, another ticket's path.
  const forged = upload(f);
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", { ...forged.input, uploadToken: "forged" }, deps), (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
  const other = await fixture();
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", upload(other).input, deps), (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
  assert.equal(await snapshot(f), afterControl);

  // Race: the link is revoked while the bytes are checked. The single attach write refuses; no file row, no attachment.
  const raced = upload(f);
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", raced.input, { ...deps, inspect: async () => {
    await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [f.job]);
    return { size: 2048, mime: "image/jpeg", header: JPEG };
  } }), notFound);
  assert.equal(await snapshot(f), afterControl, "no orphan file or untagged attachment");
  await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=NULL WHERE id=$1", [f.job]);

  // Closure (GS-51): refused before the bytes are read; nothing changes.
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  const count = inspected;
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", upload(f).input, deps), notFound);
  await assert.rejects(attachSql(f.token, f, "after"), refused);
  assert.equal(inspected, count);
  assert.equal(await snapshot(f), afterControl);

  // Decline: same.
  const d = await fixture();
  await decline(d.token);
  const declinedBefore = await snapshot(d);
  await assert.rejects(confirmVendorCasePhoto(d.token, "after", upload(d).input, deps), notFound);
  assert.equal(await snapshot(d), declinedBefore);
  // Before 接單: same.
  const e = await fixture();
  const pendingBefore = await snapshot(e);
  await assert.rejects(confirmVendorCasePhoto(e.token, "after", upload(e).input, deps), notFound);
  assert.equal(await snapshot(e), pendingBefore);
  // A rejected object is refused with no row and is not deleted by the request (no check-then-delete race).
  const bad = upload(e);
  await accept(e.token);
  const acceptedBefore = await snapshot(e);
  await assert.rejects(confirmVendorCasePhoto(e.token, "after", bad.input, { inspect: async () => ({ size: 2048, mime: "image/png", header: JPEG }) }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.photoType");
  assert.equal(await snapshot(e), acceptedBefore);
  assert.doesNotMatch(readFileSync("src/server/b105-vendor-case.ts", "utf8"), /removeRepairObject|deps\.remove/);
});

test("a closed, undecided job: the SQL decision gateway refuses accept and decline and writes no row", async () => {
  const f = await fixture();
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  assert.equal((await ready(f.token)).decision, null, "still readable, never decided");
  const before = await snapshot(f);
  await assert.rejects(decideSql(f.token, "accepted"), refused, "SQL accept");
  await assert.rejects(decideSql(f.token, "accepted", { date: "2026-12-01" }), refused, "SQL accept with a date");
  await assert.rejects(decideSql(f.token, "declined"), refused, "SQL decline");
  await assert.rejects(decideSql(f.token, "declined", { reason: "結案了" }), refused, "SQL decline with a reason");
  assert.deepEqual(await decisionRows(f.job), []);
  assert.equal(await snapshot(f), before);
});

test("closed case (GS-51): read only with staff-shared photos visible; a reopen keeps the same link (GS-29)", async () => {
  const f = await fixture();
  await admitted(f);
  const legacy = await storedPhoto(f, { name: "legacy.jpg" });
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  const closed = await ready(f.token);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.photos.map(p => [p.phase, p.viewable]), [["before", false], ["after", false]]);
  await assert.rejects(accept(f.token), notFound);
  await db.query("INSERT INTO public.repair_vendor_job_shared_photos(org_id,job_id,attachment_id,approved_by) VALUES($1,$2,$3,$4)", [ORG_ID, f.job, legacy.id, USERS.admin]);
  assert.deepEqual((await ready(f.token)).photos.map(p => p.viewable), [false, true]);
  await db.query("UPDATE public.maintenance_tickets SET status='in_progress' WHERE id=$1", [f.ticket]);
  assert.equal((await ready(f.token)).closed, false);
  assert.equal((await attachSql(f.token, f, "after")).status, "recorded");
});

/** Renders a server page outside Next with the request cookie store it reads. */
async function render(Page: unknown, token: string, phase?: string) {
  (globalThis as Record<string, unknown>).React ??= React;
  const [{ workAsyncStorage }, { workUnitAsyncStorage }, { RequestCookies }, { RequestCookiesAdapter }, { AppRouterContext }, { renderToReadableStream }] = await Promise.all([
    import("next/dist/server/app-render/work-async-storage.external"), import("next/dist/server/app-render/work-unit-async-storage.external"),
    import("next/dist/server/web/spec-extension/cookies"), import("next/dist/server/web/spec-extension/adapters/request-cookies"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"), import("react-dom/server.edge")]);
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: "condola_locale=zh-TW" })));
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return workAsyncStorage.run({ route: "/v/[token]" } as never, () => workUnitAsyncStorage.run({ type: "private-cache", cookies } as never, async () => {
    const element = await (Page as (p: unknown) => Promise<React.ReactElement>)({ params: Promise.resolve({ token }), searchParams: Promise.resolve(phase ? { phase } : {}) });
    const stream = await renderToReadableStream(React.createElement(AppRouterContext.Provider, { value: router as never }, element));
    await stream.allReady;
    return new Response(stream).text();
  }));
}
const jobPage = async () => (await import("../app/v/[token]/page")).default;
const photosPage = async () => (await import("../app/v/[token]/photos/page")).default;
/** The pre-B-105 page (the branch base), with its relative imports pointed at this checkout. */
async function legacyPage() {
  const dir = new URL("../app/v/[token]/", import.meta.url);
  const source = execFileSync("git", ["show", "797c7808:src/app/v/[token]/page.tsx"], { encoding: "utf8" })
    .replace(/from "\.\/([^"]+)"/g, (_, file: string) => `from ${JSON.stringify(fileURLToPath(new URL(file, dir)))}`);
  const file = join(mkdtempSync(join(tmpdir(), "b105-legacy-")), "page.tsx");
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).default;
}

test("OFF parity: with vendor_job_v3 OFF the page is byte-identical to the pre-B-105 page in every state", async () => {
  const legacy = await legacyPage(), current = await jobPage();
  await setPlatform("vendor_job_v3", [ORG_ID], false);
  try {
    const open = await fixture();
    const decided = await fixture();
    await db.query("INSERT INTO app.b105_vendor_job_decisions(vendor_job_id,org_id,ticket_id,decision,request_id) VALUES($1,$2,$3,'declined',$4)", [decided.job, ORG_ID, decided.ticket, randomUUID()]);
    const closed = await fixture();
    await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [closed.ticket]);
    const unshared = await fixture();
    await db.query("UPDATE public.repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1", [unshared.job]);
    for (const [label, f] of Object.entries({ open, decided, closed, unshared })) {
      const expected = await render(legacy, f.token), actual = await render(current, f.token);
      assert.ok(expected.length > 500, label);
      assert.equal(actual, expected, label);
      assert.doesNotMatch(actual, /待接單|vendor-case\.css/, label);
    }
    await assert.rejects(render(await photosPage(), open.token), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  } finally { await setPlatform("vendor_job_v3", [ORG_ID]); }
});

test("ON pages: RV-JOB-ACCEPT replaces the V-TOKEN content; RV-PHOTOS open then closed", async () => {
  const f = await fixture();
  const html = await render(await jobPage(), f.token);
  for (const text of ["派了這一件給你，下一步：決定要不要接。", "待接單", "約定完工日", "接受工單", "不接受", "不接這一件？", "確定不接", "v-token-tabs"]) assert.ok(html.includes(text), text);
  for (const legacy of ["vendor-submit", "vendor-propose", "vendor-reject", "vendor-complete", "v-token-warning", "回報進度"]) assert.ok(!html.includes(legacy), legacy);
  await assert.rejects(render(await photosPage(), f.token), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/, "no photo page before 接單");
  await accept(f.token);
  await attachSql(f.token, f, "after", randomUUID(), undefined, "天花板_修好.jpg");
  const open = await render(await photosPage(), f.token);
  assert.ok(open.includes("上傳處理後照片") && open.includes("天花板_修好.jpg") && open.includes(" › 照片"));
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  const closed = await render(await photosPage(), f.token);
  assert.ok(closed.includes("這一案已結案，照片不能再改。要補照片，請") && closed.includes("重開這一案。"));
  assert.doesNotMatch(closed, /type="file"|上傳處理/);
});
