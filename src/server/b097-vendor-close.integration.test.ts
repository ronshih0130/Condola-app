import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import React from "react";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { completeVendorCase, loadVendorDone, staffReopenRepair } from "./b097-vendor-close";
import { vendorTenantPhone } from "./b098-vendor-phone";
import { buildStoredConsent } from "./consent";
import { loadVendorCase } from "./b105-vendor-case";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";
import { POST as completeRoute } from "../app/api/vendor-jobs/case-complete/route";
import { POST as reopenRoute } from "../app/api/repairs/reopen/route";

// B-097 / B-098 on a cloned disposable database: the real app.b097_* / app.b098_* gateways, the real B-105 admission,
// the real routes and pages. Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… (never staging).
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const read = (path: string) => readFileSync(path, "utf8");
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const ORG_FLAGS = { vendor_dispatch: true, vendor_link: true, brand_v2: true, brand_v3: true, vendor_job_v3: true };
const staffCred = randomUUID();
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin", kind: "staff",
  name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
let property = "", currency = "", minorUnit = 0;
let lease: { id: string; property: string; unit: string | null; room: string | null; tenant: string; phone: string };
const brandEnv = process.env.BRAND_V2;
type Q = Pick<Client, "query">;
type Fixture = { org: string; ticket: string; job: string; token: string; contact: string };

async function setPlatform(key: string, value: unknown, client: Q = db) {
  await client.query(`INSERT INTO public.platform_settings(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
}
const ON = { enabled: true, allowed_org_ids: [ORG_ID] };
async function orgFlags(org: string, patch: Record<string, unknown>, client: Q = db) {
  await client.query("UPDATE public.organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
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
  await db.query("UPDATE public.organizations SET plan_tier='beta' WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
  for (const org of [ORG_ID, ORG2_ID]) await orgFlags(org, ORG_FLAGS);
  for (const k of ["vendor_job_v3", "vendor_link"]) await setPlatform(k, ON);
  // A property with one current owner and an approval threshold (as in the B-105 test), so estimates can be submitted.
  const owned = (await db.query(`SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit
    FROM public.property_owners po
    JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
    JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL
      AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
  assert.ok(owned);
  property = owned.property_id; currency = owned.currency.trim(); minorUnit = owned.minor_unit;
  await db.query(`UPDATE public.property_owners SET effective_from=CURRENT_DATE-1,effective_to=CURRENT_DATE
    WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, property, owned.id]);
  await db.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=500000,
    effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1`, [owned.id]);
  await orgFlags(ORG_ID, { repair_approvals: true }); await setPlatform("repair_approvals", ON);
  const row = (await db.query(`SELECT l.id,l.property_id,l.unit_id,l.target_room_id,c.id contact,c.phone_e164
    FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary'
    JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL AND c.phone_e164 IS NOT NULL
    WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`, [ORG_ID])).rows[0];
  assert.ok(row, "a seeded lease with a primary tenant phone");
  lease = { id: row.id, property: row.property_id, unit: row.unit_id, room: row.target_room_id, tenant: row.contact, phone: row.phone_e164 };
  await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
    [admin.sessionId, USERS.admin, hash(staffCred)]);
  const consent = buildStoredConsent("portal");
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [USERS.admin, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
});

test.after(async () => {
  if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

async function vendorContact(org: string) {
  return (await db.query(`INSERT INTO public.contacts(org_id,is_vendor,display_name,phone_e164,vendor_trade)
    VALUES($1,true,$2,'+886900000097','plumbing') RETURNING id::text`, [org, `B-097 vendor ${randomUUID().slice(0, 8)}`])).rows[0].id as string;
}
/** A case-collaboration job on a fresh ticket; `tenant` puts the ticket on the seeded lease, reported by its tenant. */
async function fixture(opts: { org?: string; accept?: boolean; tenant?: boolean; contact?: string } = {}): Promise<Fixture> {
  const org = opts.org ?? ORG_ID;
  const ticket = randomUUID(), job = randomUUID(), token = newVendorToken();
  const contact = opts.contact ?? await vendorContact(org);
  const place = org === ORG_ID ? (opts.tenant ? lease.property : property)
    : (await db.query("SELECT id FROM public.properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1", [org])).rows[0].id;
  const inserted = await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,unit_id,room_id,lease_id,reported_by_contact_id,category,priority,status,title,cost_bearer,owner_approval,assigned_vendor_contact_id)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,$6,$7,$8,$9,category,priority,'assigned','浴室天花板滴水',cost_bearer,owner_approval,$4
    FROM public.maintenance_tickets WHERE org_id=$5 ORDER BY id LIMIT 1`,
  [ticket, org, place, contact, ORG_ID, opts.tenant ? lease.unit : null, opts.tenant ? lease.room : null,
    opts.tenant ? lease.id : null, opts.tenant ? lease.tenant : null]);
  assert.equal(inserted.rowCount, 1);
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,
     scope,sharing_approved_at,sharing_approved_by,shared_description,vendor_contact_id)
    VALUES($1,$2,$3,'B-097 vendor','+886900000097','平日白天',$4,clock_timestamp()+interval '1 day',NULL,
     'case_collaboration',clock_timestamp(),NULL,'浴室天花板滴水',$5)`, [job, org, ticket, hashVendorToken(token), contact]);
  await db.query("INSERT INTO public.repair_vendor_secrets(job_id,token) VALUES($1,$2)", [job, token]);
  const f = { org, ticket, job, token, contact };
  if (opts.accept !== false) await decide(f, "accepted");
  return f;
}
async function decide(f: Fixture, decision: "accepted" | "declined") {
  await db.query("INSERT INTO app.b105_vendor_job_decisions(vendor_job_id,org_id,ticket_id,decision,request_id) VALUES($1,$2,$3,$4,$5)",
    [f.job, f.org, f.ticket, decision, randomUUID()]);
}
/** An attachment as written by B-105 (explicit set) or before B-105 (NULL phase), or another kind of photo. */
async function photo(f: Fixture, phase: "before" | "during" | "after" | null, opts: { job?: string | null; internal?: boolean; name?: string } = {}) {
  const file = randomUUID(), path = `org/${f.org}/tickets/${f.ticket}/${file}.jpg`;
  await db.query(`INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
    VALUES($1,$2,'ticket-photos-private',$3,$4,'image/jpeg',100)`, [file, f.org, path, opts.name ?? `${phase ?? "legacy"}-${file.slice(0, 6)}.jpg`]);
  return (await db.query(`INSERT INTO public.ticket_attachments(org_id,ticket_id,file_id,is_internal,vendor_job_id,phase)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`, [f.org, f.ticket, file, opts.internal ?? false,
    opts.job === undefined ? f.job : opts.job, phase])).rows[0].id as string;
}
const sqlComplete = (token: string, note: string | null = null, request: string | null = randomUUID()) => svc(null, async client => {
  assert.equal((await client.query("SELECT current_user r")).rows[0].r, "service_role");
  return (await client.query("SELECT app.b097_vendor_complete($1,false,$2::uuid,$3) r", [hashVendorToken(token), request, note])).rows[0].r;
});
const complete = (f: Fixture, note: string | null = null, requestId = randomUUID()) => completeVendorCase(f.token, { requestId, note });
const reopen = (ticketId: string, reason = "租客說還在滴水", requestId = randomUUID(), session = admin) =>
  staffReopenRepair(session, { ticketId, requestId, reason });
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
/** A gateway refusal as seen through svc(): the 42501 survives as the code or the cause's code. */
const sqlRefused = (error: unknown) => ((error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code) === "42501";
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
/** A staff estimate on the ticket (B-013): amount over 500000 minor units needs the owner. Returns the version id. */
async function estimate(f: Fixture, amount: number) {
  const r = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,$7::bigint,$5::text,$6::smallint,'Repair ceiling','[]'::jsonb,$8::bytea) r`,
  [ORG_ID, admin.sessionId, randomUUID(), f.ticket, currency, minorUnit, amount, createHash("sha256").update(f.ticket + amount).digest()])).rows[0].r)
    .catch((error: { cause?: unknown }) => {
      const cause = error.cause as Record<string, unknown> | undefined;
      throw new Error(`b013_submit_estimate: ${cause ? JSON.stringify(cause, Object.getOwnPropertyNames(cause)) : String(error)}`);
    });
  assert.equal(r.status, "recorded");
  return String(r.version_id);
}
/** Every outbound queue: notifications, deliveries and attempts, push reservations and claims, LINE and mail logs. */
const OUTBOUND = ["app.b013_repair_event_outbox", "app.b014_report_delivery_events", "app.b028_delivery_attempt_events", "app.b028_delivery_attempts",
  "app.b028_delivery_on_transitions", "app.b028_notification_event_recipients", "app.b028_notification_events", "app.b033_push_fallbacks",
  "app.b033_push_reservations", "app.b033_org_push_budgets", "app.b037_rent_push_claims", "app.b038_repair_pushes", "public.deliveries",
  "public.email_log", "public.line_push_usage", "public.messages", "public.notifications"];
async function outbound() {
  const out: Record<string, string> = {};
  for (const table of OUTBOUND) {
    out[table] = (await db.query(`SELECT count(*)::text||':'||md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const status = async (ticket: string) => (await db.query("SELECT status::text s FROM public.maintenance_tickets WHERE id=$1", [ticket])).rows[0].s as string;
const SNAPSHOT = ["app.b097_completions", "app.b097_requests", "public.maintenance_tickets", "public.ticket_comments", "public.audit_log",
  "app.b105_vendor_job_decisions", "public.ticket_attachments", "public.repair_vendor_jobs"];
async function snapshot(client: Q = db) {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT) {
    out[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const post = (body: unknown, headers: Record<string, string> = {}) => completeRoute(new Request(`${origin}/api/vendor-jobs/case-complete`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin, "content-type": "application/json", ...headers } }));

test("privileges: four service-only gateways, both private tables revoked with RLS on", async () => {
  const gateways = ["app.b097_vendor_done_view(text,boolean)", "app.b097_vendor_complete(text,boolean,uuid,text)",
    "app.b097_staff_reopen(uuid,uuid,text,uuid,boolean,uuid,uuid,text)", "app.b098_vendor_tenant_phone(text,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of gateways) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok, role === "service_role", `${role} ${signature}`);
    }
    for (const table of ["app.b097_completions", "app.b097_requests"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) ok", [role, table, privilege])).rows[0].ok, false, `${role} ${table} ${privilege}`);
      }
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(`SELECT 1 FROM ${table}`), { code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0].relrowsecurity, true);
    }
  }
  const fns = (await db.query(`SELECT proname,prosecdef,provolatile,proconfig FROM pg_proc
    WHERE pronamespace='app'::regnamespace AND proname ~ '^b09[78]_' ORDER BY 1`)).rows;
  assert.deepEqual(fns.map(f => f.proname), ["b097_reopen_open", "b097_staff_reopen", "b097_supersede_completion", "b097_vendor_complete", "b097_vendor_done_view", "b098_vendor_tenant_phone"]);
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const helper of ["app.b097_reopen_open(app.b097_completions,timestamptz)", "app.b097_supersede_completion()"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, helper])).rows[0].ok, false, `${role} ${helper}`);
    }
  }
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='b097_supersede_completion'
    AND tgrelid='public.maintenance_tickets'::regclass AND tgenabled='O'`)).rows[0].n, 1);
  for (const fn of fns) assert.deepEqual([fn.prosecdef, fn.provolatile, fn.proconfig], [true, "v", ["search_path=pg_catalog, pg_temp"]], fn.proname);
});

test("送出完工: one explicit after-photo closes the repair; completion, status note, audit and ledger rows; the B-105 case reads closed", async () => {
  const f = await fixture();
  await photo(f, "before");
  const after = await photo(f, "after", { name: "天花板_修好.jpg" });
  const queues = await outbound();
  const view = await loadVendorDone(f.token);
  assert.deepEqual(view?.afterPhotos.map(p => p.name), ["天花板_修好.jpg"]);
  assert.equal(view?.closed, false); assert.equal(view?.accepted, true);
  const request = randomUUID();
  const result = await complete(f, "  更換防水層，已測試不再滴水。  ", request);
  assert.equal(result.status, "recorded");
  if (result.status !== "recorded") return;
  assert.equal(result.replayed, false);
  assert.equal(Date.parse(result.reopenUntil) - Date.parse(result.closedAt), 168 * 3600 * 1000, "7 days = 168 hours");
  const ticket = (await db.query("SELECT status::text,closed_at,resolved_at,completed_on::text FROM public.maintenance_tickets WHERE id=$1", [f.ticket])).rows[0];
  assert.equal(ticket.status, "closed"); assert.ok(ticket.closed_at && ticket.resolved_at && ticket.completed_on);
  const done = (await db.query("SELECT vendor_job_id::text job,note,after_photo_ids::text[] ids,from_status,reopened_at FROM app.b097_completions WHERE ticket_id=$1", [f.ticket])).rows;
  assert.deepEqual(done, [{ job: f.job, note: "更換防水層，已測試不再滴水。", ids: [after], from_status: "assigned", reopened_at: null }]);
  assert.deepEqual((await db.query("SELECT status_from::text,status_to::text,author_user_id FROM public.ticket_comments WHERE ticket_id=$1", [f.ticket])).rows,
    [{ status_from: "assigned", status_to: "closed", author_user_id: null }]);
  const audit = (await db.query("SELECT actor_role,event_type,request_id,new_row FROM public.audit_log WHERE event_type='vendor_completion_closed' AND row_id=$1", [f.ticket])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_role, "vendor"); assert.equal(audit[0].request_id, request);
  assert.equal(audit[0].new_row.afterPhotos, 1); assert.equal(audit[0].new_row.vendorJobId, f.job);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_requests WHERE request_id=$1 AND kind='complete' AND actor_id=$2", [request, f.job])).rows[0].n, 1);
  const read = await loadVendorCase(f.token);
  assert.equal(read?.state === "ready" && read.value.closed, true, "B-105 sees the case closed (GS-51 read only)");
  assert.equal((await loadVendorDone(f.token))?.closed, true);
  // No outbound of any kind: every queue is unchanged by the close and by a reopen (in-app only; PR-022 keeps LINE OFF).
  assert.equal((await reopen(f.ticket)).status, "reopened");
  assert.deepEqual(await outbound(), queues);
  // A NUL in the note is invalid input, never a server error (it can never reach a PostgreSQL text value).
  assert.deepEqual(await completeVendorCase(f.token, { requestId: randomUUID(), note: "a\u0000b" }), { status: "rejected_invalid" });
  assert.deepEqual(await staffReopenRepair(admin, { ticketId: f.ticket, requestId: randomUUID(), reason: "a\u0000b" }), { status: "rejected_invalid" });
  assert.equal((await post({ token: f.token, requestId: randomUUID(), note: "a\u0000b" })).status, 400);
});

test("LPQ-25 item 3: only the explicit 處理後 set of this job counts; a legacy NULL-phase, before, internal or other job's photo does not", async () => {
  const f = await fixture();
  // An earlier (revoked) vendor job on the same repair: its photos are not this job's.
  const earlier = randomUUID();
  await db.query(`INSERT INTO public.repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,
    scope,sharing_approved_at,vendor_contact_id,active,revoked_at)
    VALUES($1,$2,$3,'earlier','+886900000098','x',$4,clock_timestamp()+interval '1 day','case_collaboration',clock_timestamp(),$5,false,clock_timestamp())`,
  [earlier, f.org, f.ticket, hashVendorToken(newVendorToken()), f.contact]);
  await photo(f, "before");
  await photo(f, null);
  await photo(f, "after", { internal: true });
  await photo(f, "after", { job: earlier });
  await photo(f, "during");
  await photo(f, null, { job: null, name: "tenant.jpg" });
  const before = await snapshot();
  assert.deepEqual(await complete(f), { status: "rejected_no_photo" });
  assert.deepEqual(await snapshot(), before, "refused with no write and no reservation");
  assert.deepEqual((await loadVendorDone(f.token))?.afterPhotos, [], "RV-DONE lists none of them");
  const request = randomUUID();
  assert.deepEqual(await complete(f, null, request), { status: "rejected_no_photo" });
  await photo(f, "after");
  assert.equal((await complete(f, null, request)).status, "recorded", "the same request id works after an upload (not reserved)");
});

test("idempotent: a replay returns the first answer even after close; another payload or another vendor's job under the id is a conflict", async () => {
  const f = await fixture(), g = await fixture();
  await photo(f, "after"); await photo(g, "after");
  const request = randomUUID();
  const first = await complete(f, "ok", request);
  assert.equal(first.status, "recorded");
  const after = await snapshot();
  assert.deepEqual(await complete(f, "ok", request), { ...first, replayed: true });
  assert.deepEqual(await complete(f, "other", request), { status: "rejected_conflict" });
  assert.deepEqual(await complete(g, "ok", request), { status: "rejected_conflict" }, "another job cannot reuse the id");
  assert.deepEqual(await complete(f, "ok"), { status: "rejected_closed" }, "a new request on a closed case");
  assert.deepEqual(await snapshot(), after);
  assert.deepEqual(await sqlComplete(f.token, "x".repeat(501)), { status: "rejected_invalid" });
  assert.deepEqual(await sqlComplete(f.token, "a\u0007b"), { status: "rejected_invalid" });
  assert.deepEqual(await sqlComplete(f.token, "ok", null), { status: "rejected_invalid" });
  assert.deepEqual(await snapshot(), after);
});

test("denials write nothing: pending or declined case, revoked, expired, reassigned and cross-org links, document and share tokens, every gate OFF", async () => {
  const deny = async (label: string, token: string) => {
    const before = await snapshot();
    await assert.rejects(completeVendorCase(token, { requestId: randomUUID(), note: null }), notFound, `${label}: complete`);
    await assert.rejects(sqlComplete(token), sqlRefused, `${label}: SQL`);
    assert.equal(await vendorTenantPhone(token), null, `${label}: phone`);
    assert.deepEqual(await snapshot(), before, `${label}: no writes`);
  };
  const pending = await fixture({ accept: false }); await photo(pending, "after");
  await deny("not yet accepted", pending.token);
  const declined = await fixture({ accept: false }); await decide(declined, "declined"); await photo(declined, "after");
  await deny("declined", declined.token);
  const revoked = await fixture(); await photo(revoked, "after");
  await db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [revoked.job]);
  await deny("revoked link", revoked.token);
  const expired = await fixture(); await photo(expired, "after");
  await db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.job]);
  await deny("expired link", expired.token);
  const reassigned = await fixture({ tenant: true }); await photo(reassigned, "after");
  await db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [reassigned.ticket, await vendorContact(ORG_ID)]);
  await deny("the previous vendor after reassignment", reassigned.token);
  const foreign = await fixture({ org: ORG2_ID }); await photo(foreign, "after");
  await deny("another org not on the platform allowlist", foreign.token);
  await deny("an unknown token", newVendorToken());
  // A B-025 document token and a B-110 share token are never case bearers.
  const f = await fixture({ tenant: true }); await photo(f, "after");
  const documentToken = newVendorToken(), shareToken = newVendorToken();
  // A real, valid B-025 document bearer for this very job and the vendor's profile: a different token domain.
  const profile = (await db.query(`INSERT INTO public.vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164,address,qualification_attested_at)
    VALUES($1,$2,'B097','individual','B-097 vendor','+886900000097','台北市信義區信義路二段 97 號',now()) RETURNING id::text`, [ORG_ID, f.contact])).rows[0].id;
  await db.query(`INSERT INTO public.vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"B-097"}'::jsonb,clock_timestamp()+interval '1 day',$6)`,
  [ORG_ID, f.ticket, f.job, profile, hashVendorToken(documentToken), USERS.admin]);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.vendor_document_grants WHERE token_hash=$1 AND expires_at>now()", [hashVendorToken(documentToken)])).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.repair_vendor_jobs WHERE token_hash=$1", [hashVendorToken(documentToken)])).rows[0].n, 0,
    "the document token is not a job token");
  await db.query(`INSERT INTO app.case_shares(org_id,ticket_id,vendor_job_id,token_hash,token,created_by_kind,created_by)
    VALUES($1,$2,$3,$4,$5,'vendor',NULL)`, [ORG_ID, f.ticket, f.job, createHash("sha256").update(shareToken, "utf8").digest("hex"), shareToken]);
  await deny("a live B-025 document token for this job", documentToken);
  await deny("a share-link token", shareToken);
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["vendor_job_v3 org off", () => orgFlags(ORG_ID, { vendor_job_v3: false }), () => orgFlags(ORG_ID, { vendor_job_v3: true })],
    ["vendor_job_v3 platform off", () => setPlatform("vendor_job_v3", { ...ON, enabled: false }), () => setPlatform("vendor_job_v3", ON)],
    ["vendor_job_v3 platform without the org", () => setPlatform("vendor_job_v3", { enabled: true, allowed_org_ids: [ORG2_ID] }), () => setPlatform("vendor_job_v3", ON)],
    ["vendor_link platform off", () => setPlatform("vendor_link", { ...ON, enabled: false }), () => setPlatform("vendor_link", ON)],
    ["vendor_link org off", () => orgFlags(ORG_ID, { vendor_link: false }), () => orgFlags(ORG_ID, { vendor_link: true })],
    ["brand_v3 off", () => orgFlags(ORG_ID, { brand_v3: false }), () => orgFlags(ORG_ID, { brand_v3: true })],
    ["brand_v2 off (env unset)", () => orgFlags(ORG_ID, { brand_v2: false }), () => orgFlags(ORG_ID, { brand_v2: true })],
    ["vendor_dispatch off", () => orgFlags(ORG_ID, { vendor_dispatch: false }), () => orgFlags(ORG_ID, { vendor_dispatch: true })],
  ];
  for (const [label, apply, restore] of gates) {
    await apply();
    try { await deny(label, f.token); } finally { await restore(); }
  }
  // Gates restored: the same bearer works.
  assert.equal((await vendorTenantPhone(f.token))?.phone, lease.phone);
  assert.equal((await complete(f)).status, "recorded");
});

test("7-day rule: staff reopen within 168 hours with a reason; after that refused; only a vendor close is reopenable; audited and idempotent", async () => {
  const f = await fixture(); await photo(f, "after");
  assert.equal((await complete(f)).status, "recorded");
  const request = randomUUID();
  assert.deepEqual(await reopen(f.ticket, "  租客說還在滴水  ", request), { status: "reopened", replayed: false });
  assert.equal(await status(f.ticket), "in_progress");
  const row = (await db.query("SELECT reopened_by::text by,reopen_reason,reopen_request::text req FROM app.b097_completions WHERE ticket_id=$1", [f.ticket])).rows;
  assert.deepEqual(row, [{ by: USERS.admin, reopen_reason: "租客說還在滴水", req: request }]);
  const t = (await db.query("SELECT closed_at,resolved_at,completed_on FROM public.maintenance_tickets WHERE id=$1", [f.ticket])).rows[0];
  assert.deepEqual(t, { closed_at: null, resolved_at: null, completed_on: null });
  const audit = (await db.query("SELECT actor_user_id::text,actor_role,reason FROM public.audit_log WHERE event_type='repair_reopened' AND row_id=$1", [f.ticket])).rows;
  assert.deepEqual(audit, [{ actor_user_id: USERS.admin, actor_role: "staff", reason: "租客說還在滴水" }]);
  assert.deepEqual((await db.query("SELECT status_from::text,status_to::text,author_user_id::text FROM public.ticket_comments WHERE ticket_id=$1 ORDER BY created_at", [f.ticket])).rows.at(-1),
    { status_from: "closed", status_to: "in_progress", author_user_id: USERS.admin });
  const after = await snapshot();
  assert.deepEqual(await reopen(f.ticket, "租客說還在滴水", request), { status: "reopened", replayed: true }, "replay after the reopen");
  assert.deepEqual(await reopen(f.ticket, "另一個原因", request), { status: "rejected_conflict" });
  assert.deepEqual(await reopen(f.ticket), { status: "rejected_state" }, "not closed any more");
  assert.deepEqual(await snapshot(), after);
  // The vendor page shows it open again and the vendor can close it again (a new completion).
  assert.equal((await loadVendorDone(f.token))?.closed, false);
  assert.equal((await complete(f)).status, "recorded");
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_completions WHERE ticket_id=$1", [f.ticket])).rows[0].n, 2);
  // The 168-hour boundary: one minute left reopens; at or past it is refused with no write.
  // Moves the current close (the completion and the ticket's own close time together) so its window ends `minutes` from now.
  const shift = async (minutes: number) => {
    const until = (await db.query("SELECT clock_timestamp()+make_interval(mins=>$1) t", [minutes])).rows[0].t;
    await db.query(`UPDATE app.b097_completions SET closed_at=$2::timestamptz-interval '168 hours',reopen_until=$2
      WHERE ticket_id=$1 AND reopened_at IS NULL AND superseded_at IS NULL`, [f.ticket, until]);
    await db.query("UPDATE public.maintenance_tickets SET closed_at=$2::timestamptz-interval '168 hours' WHERE id=$1", [f.ticket, until]);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_completions WHERE ticket_id=$1 AND reopened_at IS NULL AND superseded_at IS NULL", [f.ticket])).rows[0].n, 1);
  };
  await shift(-1);
  const expired = await snapshot();
  assert.deepEqual(await reopen(f.ticket), { status: "rejected_expired" });
  assert.deepEqual(await snapshot(), expired);
  await shift(1);
  assert.equal((await reopen(f.ticket)).status, "reopened");
  // A staff close (no vendor completion) is not reopenable here, and the refusal writes nothing.
  const staffClosed = await fixture();
  await db.query("UPDATE public.maintenance_tickets SET status='closed',closed_at=now() WHERE id=$1", [staffClosed.ticket]);
  const staffSnap = await snapshot();
  assert.deepEqual(await reopen(staffClosed.ticket), { status: "rejected_state" });
  assert.deepEqual(await snapshot(), staffSnap, "staff close: no write");
  const g = await fixture(); await photo(g, "after"); await complete(g);
  const closed = await snapshot();
  for (const bad of ["", "   ", "x".repeat(501), "a\u0007b", null]) {
    const result = await svc(USERS.admin, async client => (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,$6) r",
      [ORG_ID, ORG_ID, admin.sessionId, g.ticket, randomUUID(), bad])).rows[0].r);
    assert.deepEqual(result, { status: "rejected_invalid" }, JSON.stringify(bad));
  }
  assert.deepEqual(await snapshot(), closed);
});

test("reopen denials write nothing: no tickets.update seat, revoked staff session, another org, gate OFF", async () => {
  const f = await fixture(); await photo(f, "after"); await complete(f);
  const before = await snapshot();
  const revokedSession: Session = { ...admin, sessionId: randomUUID() };
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',clock_timestamp())",
    [revokedSession.sessionId, USERS.admin, hash(randomUUID())]);
  await assert.rejects(reopen(f.ticket, "r", randomUUID(), revokedSession), forbidden, "revoked staff session: errors.forbidden");
  const foreign: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [foreign.sessionId, USERS.coastAdmin, hash(randomUUID())]);
  await assert.rejects(svc(USERS.coastAdmin, async client => (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,'r') r",
    [ORG2_ID, ORG2_ID, foreign.sessionId, f.ticket, randomUUID()])).rows[0].r), sqlRefused, "another org's staff");
  await assert.rejects(svc(USERS.coastAdmin, async client => (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,'r') r",
    [ORG_ID, ORG_ID, foreign.sessionId, f.ticket, randomUUID()])).rows[0].r), sqlRefused, "a non-member naming this org");
  const tenantUser = (await db.query("SELECT user_id::text u FROM public.contacts WHERE id=$1", [lease.tenant])).rows[0].u;
  if (tenantUser) {
    const tenantSession = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [tenantSession, tenantUser, hash(randomUUID())]);
    await assert.rejects(svc(tenantUser, async client => (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,'r') r",
      [ORG_ID, ORG_ID, tenantSession, f.ticket, randomUUID()])).rows[0].r), sqlRefused, "a tenant");
  }
  await assert.rejects(svc(null, async client => (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,'r') r",
    [ORG_ID, ORG_ID, admin.sessionId, f.ticket, randomUUID()])).rows[0].r), sqlRefused, "no signed-in caller");
  assert.deepEqual(await snapshot(), before);
  await orgFlags(ORG_ID, { vendor_job_v3: false });
  try {
    const off = await snapshot();
    await assert.rejects(reopen(f.ticket), forbidden, "gate off");
    assert.deepEqual(await snapshot(), off);
  } finally { await orgFlags(ORG_ID, { vendor_job_v3: true }); }
  assert.equal((await reopen(f.ticket)).status, "reopened", "the real admin still can");
});

test("current close only: a later staff close, cancel or reopen another way supersedes the vendor completion; a cancelled repair with a live completion is refused", async () => {
  // Reopened another way (status back to in_progress), then closed again by staff: the old completion is superseded.
  const f = await fixture(); await photo(f, "after"); await complete(f);
  await db.query("UPDATE public.maintenance_tickets SET status='in_progress',closed_at=NULL WHERE id=$1", [f.ticket]);
  await db.query("UPDATE public.maintenance_tickets SET status='closed',closed_at=clock_timestamp() WHERE id=$1", [f.ticket]);
  assert.ok((await db.query("SELECT superseded_at FROM app.b097_completions WHERE ticket_id=$1", [f.ticket])).rows[0].superseded_at);
  let before = await snapshot();
  assert.deepEqual(await reopen(f.ticket), { status: "rejected_state" }, "a later staff close cannot reuse the old vendor completion");
  assert.deepEqual(await snapshot(), before);
  // Closed again by a path that keeps closed_at (coalesce) after a status round trip: still superseded on the way out.
  const k = await fixture(); await photo(k, "after"); await complete(k);
  await db.query("UPDATE public.maintenance_tickets SET status='in_progress' WHERE id=$1", [k.ticket]);
  await db.query("UPDATE public.maintenance_tickets SET status='closed',closed_at=coalesce(closed_at,now()) WHERE id=$1", [k.ticket]);
  before = await snapshot();
  assert.deepEqual(await reopen(k.ticket), { status: "rejected_state" }, "same closed_at, but the close was left and re-entered");
  assert.deepEqual(await snapshot(), before);
  // Cancelled after the vendor close: superseded, refused, no write.
  const g = await fixture(); await photo(g, "after"); await complete(g);
  await db.query("UPDATE public.maintenance_tickets SET status='cancelled' WHERE id=$1", [g.ticket]);
  before = await snapshot();
  assert.deepEqual(await reopen(g.ticket), { status: "rejected_state" }, "cancelled");
  assert.deepEqual(await snapshot(), before, "cancelled: no write");
  // A cancelled repair that still has a live (not superseded) completion row: the gateway's own status check refuses it.
  const h = await fixture(); await photo(h, "after");
  await db.query("UPDATE public.maintenance_tickets SET status='cancelled',closed_at=clock_timestamp() WHERE id=$1", [h.ticket]);
  await db.query(`INSERT INTO app.b097_completions(org_id,ticket_id,vendor_job_id,request_id,after_photo_ids,from_status,closed_at,reopen_until)
    SELECT $1,$2,$3,$4,ARRAY[a.id],'assigned',t.closed_at,t.closed_at+interval '168 hours'
    FROM public.ticket_attachments a JOIN public.maintenance_tickets t ON t.id=a.ticket_id WHERE a.ticket_id=$2 LIMIT 1`, [ORG_ID, h.ticket, h.job, randomUUID()]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_completions WHERE ticket_id=$1 AND reopened_at IS NULL AND superseded_at IS NULL", [h.ticket])).rows[0].n, 1);
  before = await snapshot();
  assert.deepEqual(await reopen(h.ticket), { status: "rejected_state" }, "cancelled with a live completion");
  assert.deepEqual(await snapshot(), before, "cancelled with a live completion: no write");
  // b097's own close and reopen never supersede their own completion.
  const v = await fixture(); await photo(v, "after"); await complete(v);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_completions WHERE ticket_id=$1 AND superseded_at IS NULL", [v.ticket])).rows[0].n, 1);
  assert.equal((await reopen(v.ticket)).status, "reopened");
});

test("the 168-hour cutoff is exclusive, proven at a pinned instant: 1 ms before is open, exactly at and 1 ms after are not", async () => {
  const f = await fixture(); await photo(f, "after"); await complete(f);
  const c = (await db.query("SELECT * FROM app.b097_completions WHERE ticket_id=$1", [f.ticket])).rows[0];
  const open = async (offset: string) => (await db.query(`SELECT app.b097_reopen_open(c, c.closed_at + interval '168 hours' + $2::interval) ok
    FROM app.b097_completions c WHERE c.id=$1`, [c.id, offset])).rows[0].ok as boolean;
  assert.equal(await open("-1 millisecond"), true, "1 ms before");
  assert.equal(await open("0"), false, "exactly at closed_at + 168 hours");
  assert.equal(await open("1 millisecond"), false, "1 ms after");
  assert.equal(await open("-168 hours"), true, "right at the close");
  assert.equal((await db.query("SELECT app.b097_reopen_open(c, NULL) ok FROM app.b097_completions c WHERE c.id=$1", [c.id])).rows[0].ok, false);
  // The gateway decides with that helper on one clock reading: the boundary crossing mid-statement is rejected_expired, never 23514.
  assert.match(read("supabase/migrations/20261116250000_b097_vendor_close.sql"), /now_at:=clock_timestamp\(\);\n IF NOT app\.b097_reopen_open\(c,now_at\) THEN RETURN '\{"status":"rejected_expired"\}'::jsonb; END IF;/);
  assert.match(read("supabase/migrations/20261116250000_b097_vendor_close.sql"), /SET reopened_at=now_at,/);
});

test("authority: a native admin / manager whose custom role lacks tickets.update is refused by the SQL gateway itself; replays after losing authority are refused", async () => {
  const f = await fixture(); await photo(f, "after"); await complete(f);
  const managerSession = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [managerSession, USERS.manager, hash(randomUUID())]);
  const call = (user: string, session: string, request = randomUUID(), ticket = f.ticket, reason = "r") => svc(user, async client =>
    (await client.query("SELECT app.b097_staff_reopen($1,$2,'live',$3,false,$4,$5::uuid,$6) r", [ORG_ID, ORG_ID, session, ticket, request, reason])).rows[0].r);
  const allow = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const role = randomUUID();
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([ORG_ID]);
    await orgFlags(ORG_ID, { custom_roles: true });
    await setPlatform("custom_roles", ON);
    await db.query("BEGIN");
    try {
      await db.query("INSERT INTO app.b017_roles(org_id,id,current_revision) VALUES($1,$2,1)", [ORG_ID, role]);
      await db.query("INSERT INTO app.b017_role_revisions(org_id,role_id,revision,grants,created_by) VALUES($1,$2,1,$3::text[],$4)", [ORG_ID, role, ["props.view", "tenants.contact"], USERS.admin]);
      await db.query(`INSERT INTO app.b017_assignments(org_id,user_id,role_id,revision) VALUES($1,$2,$3,1)
        ON CONFLICT(org_id,user_id) DO UPDATE SET role_id=excluded.role_id,revision=excluded.revision`, [ORG_ID, USERS.manager, role]);
      await db.query("COMMIT");
    } catch (e) { await db.query("ROLLBACK"); throw e; }
    const before = await snapshot();
    await assert.rejects(call(USERS.manager, managerSession), sqlRefused, "native manager, custom role without tickets.update");
    assert.deepEqual(await snapshot(), before);
  } finally {
    if (allow === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = allow;
    await db.query("UPDATE app.b017_assignments SET role_id=NULL,revision=NULL WHERE org_id=$1 AND role_id=$2", [ORG_ID, role]);
    await db.query("UPDATE app.b017_roles SET retired=true WHERE org_id=$1 AND id=$2", [ORG_ID, role]);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags-'custom_roles' WHERE id=$1", [ORG_ID]);
    await setPlatform("custom_roles", { enabled: false, allowed_org_ids: [] });
  }
  // Native manager (custom roles off): admitted. Then the same request id is replayed after authority is lost.
  const request = randomUUID();
  assert.deepEqual(await call(USERS.manager, managerSession, request), { status: "reopened", replayed: false });
  assert.deepEqual(await call(USERS.manager, managerSession, request), { status: "reopened", replayed: true });
  const losses: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["seat changed to accountant", () => db.query("UPDATE public.org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]),
      () => db.query("UPDATE public.org_members SET role='manager' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager])],
    ["membership suspended", () => db.query("UPDATE public.org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]),
      () => db.query("UPDATE public.org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager])],
    ["session revoked", () => db.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [managerSession]),
      () => db.query("UPDATE public.auth_sessions SET revoked_at=NULL WHERE id=$1", [managerSession])],
    ["vendor_job_v3 off", () => orgFlags(ORG_ID, { vendor_job_v3: false }), () => orgFlags(ORG_ID, { vendor_job_v3: true })],
  ];
  for (const [label, lose, restore] of losses) {
    await lose();
    try {
      const before = await snapshot();
      await assert.rejects(call(USERS.manager, managerSession, request), sqlRefused, `replay after: ${label}`);
      assert.deepEqual(await snapshot(), before, label);
    } finally { await restore(); }
  }
  assert.deepEqual(await call(USERS.manager, managerSession, request), { status: "reopened", replayed: true }, "authority restored");
});

test("vendor replays of recorded request ids are refused after revocation, reassignment, expiry and gate changes; concurrent reservation", { timeout: 120000 }, async () => {
  const losses: [string, (f: Fixture) => Promise<unknown>][] = [
    ["link revoked", f => db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [f.job])],
    ["link expired", f => db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job])],
    ["vendor reassigned", async f => db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [f.ticket, await vendorContact(ORG_ID)])],
    ["decision withdrawn", f => db.query("DELETE FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1", [f.job])],
  ];
  for (const [label, lose] of losses) {
    const f = await fixture(); await photo(f, "after");
    const request = randomUUID();
    assert.equal((await complete(f, "ok", request)).status, "recorded");
    await lose(f);
    const before = await snapshot();
    await assert.rejects(complete(f, "ok", request), notFound, `replay after: ${label}`);
    assert.deepEqual(await snapshot(), before, label);
  }
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["vendor_job_v3 off", () => orgFlags(ORG_ID, { vendor_job_v3: false }), () => orgFlags(ORG_ID, { vendor_job_v3: true })],
    ["vendor_link platform off", () => setPlatform("vendor_link", { ...ON, enabled: false }), () => setPlatform("vendor_link", ON)],
    ["brand_v3 off", () => orgFlags(ORG_ID, { brand_v3: false }), () => orgFlags(ORG_ID, { brand_v3: true })],
  ];
  const f = await fixture(); await photo(f, "after");
  const request = randomUUID();
  assert.equal((await complete(f, "ok", request)).status, "recorded");
  for (const [label, off, on] of gates) {
    await off();
    try {
      const before = await snapshot();
      await assert.rejects(complete(f, "ok", request), notFound, `replay with ${label}`);
      assert.deepEqual(await snapshot(), before, label);
    } finally { await on(); }
  }
  assert.equal((await complete(f, "ok", request) as { replayed?: boolean }).replayed, true, "gates restored: the replay answers");
  // Two vendors' cases race for one request id: exactly one recorded, one rejected_conflict, no 23505.
  const a = await fixture(), b = await fixture(); await photo(a, "after"); await photo(b, "after");
  const shared = randomUUID();
  const lock = await holder();
  let runs: Promise<Outcome>[] = [];
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b097/request/'||$1::text||'/'||$2::text,0))", [ORG_ID, shared]);
    runs = [complete(a, null, shared), complete(b, null, shared)].map(p => p.then(result => ({ result }), error => ({ error })));
    await waitForBlocked(lock, "b097_vendor_complete", 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const outcomes = await Promise.all(runs.map(r => settle(r)));
  assert.ok(outcomes.every(o => !o.error), JSON.stringify(outcomes.map(o => String(o.error))));
  assert.deepEqual(outcomes.map(o => o.result!.status).sort(), ["recorded", "rejected_conflict"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b097_requests WHERE org_id=$1 AND request_id=$2", [ORG_ID, shared])).rows[0].n, 1);
  const loser = outcomes[0].result!.status === "rejected_conflict" ? a : b;
  assert.equal(await status(loser.ticket), "assigned", "the loser's repair stays open");
});

test("B-098 phone: assigned vendor on an open accepted case only; not before accepting, after a decline or close, for another vendor, or on a share link", async () => {
  const f = await fixture({ tenant: true, accept: false });
  assert.equal(await vendorTenantPhone(f.token), null, "before 接單");
  await decide(f, "accepted");
  assert.deepEqual(await vendorTenantPhone(f.token), { phone: lease.phone });
  // Another vendor's live case on another ticket of the same tenant only sees it through its own assignment.
  const g = await fixture({ tenant: true });
  assert.deepEqual(await vendorTenantPhone(g.token), { phone: lease.phone });
  const plain = await fixture();
  assert.deepEqual(await vendorTenantPhone(plain.token), { phone: null }, "no lease / reporter: admitted, no phone");
  // The reporter must be a tenant party of the ticket's lease.
  const stranger = await fixture({ tenant: true });
  await db.query("UPDATE public.maintenance_tickets SET reported_by_contact_id=$2 WHERE id=$1", [stranger.ticket, await vendorContact(ORG_ID)]);
  assert.deepEqual(await vendorTenantPhone(stranger.token), { phone: null }, "a vendor contact as reporter");
  const tenantContact = async (phone: string) => (await db.query(`INSERT INTO public.contacts(org_id,is_tenant,display_name,phone_e164)
    VALUES($1,true,$2,$3) RETURNING id::text`, [ORG_ID, `B-098 tenant ${randomUUID().slice(0, 6)}`, phone])).rows[0].id as string;
  const otherLease = (await db.query("SELECT id FROM public.leases WHERE org_id=$1 AND id<>$2 ORDER BY id LIMIT 1", [ORG_ID, lease.id])).rows[0]?.id as string;
  assert.ok(otherLease, "a second seeded lease");
  const elsewhere = await tenantContact("+886911000981");
  await db.query("INSERT INTO public.lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')", [ORG_ID, otherLease, elsewhere]);
  const onOther = await fixture({ tenant: true });
  await db.query("UPDATE public.maintenance_tickets SET reported_by_contact_id=$2 WHERE id=$1", [onOther.ticket, elsewhere]);
  assert.deepEqual(await vendorTenantPhone(onOther.token), { phone: null }, "a tenant of a different lease");
  const guarantor = await tenantContact("+886911000982");
  await db.query("INSERT INTO public.lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'guarantor')", [ORG_ID, lease.id, guarantor]);
  const byGuarantor = await fixture({ tenant: true });
  await db.query("UPDATE public.maintenance_tickets SET reported_by_contact_id=$2 WHERE id=$1", [byGuarantor.ticket, guarantor]);
  assert.deepEqual(await vendorTenantPhone(byGuarantor.token), { phone: null }, "a guarantor of the ticket's lease");
  // A live share of an OPEN, accepted case whose assigned vendor does get the phone: the share page never shows it.
  const live = await fixture({ tenant: true });
  assert.deepEqual(await vendorTenantPhone(live.token), { phone: lease.phone });
  const openShare = newVendorToken(), openHash = createHash("sha256").update(openShare, "utf8").digest("hex");
  await db.query(`INSERT INTO app.case_shares(org_id,ticket_id,vendor_job_id,token_hash,token,created_by_kind,created_by)
    VALUES($1,$2,$3,$4,$5,'vendor',NULL)`, [ORG_ID, live.ticket, live.job, openHash, openShare]);
  await orgFlags(ORG_ID, { vendor_docs_v3: true, vendor_documents: true });
  await setPlatform("vendor_docs_v3", ON); await setPlatform("vendor_documents", ON);
  try {
    const view = await svc(null, async client => (await client.query("SELECT app.b110_share_view($1,false) r", [openHash])).rows[0].r);
    assert.ok(view, "the share page renders for this open case");
    const text = JSON.stringify(view);
    assert.ok(!text.includes(lease.phone) && !text.includes(lease.phone.slice(4)), "open-case share view has no tenant phone");
    const { loadShareView } = await import("./b110-case-share");
    assert.doesNotMatch(JSON.stringify(await loadShareView(openShare)), new RegExp(lease.phone.slice(4)), "share page data has no phone");
  } finally {
    await orgFlags(ORG_ID, { vendor_docs_v3: false, vendor_documents: false });
    for (const k of ["vendor_docs_v3", "vendor_documents"]) await setPlatform(k, { enabled: false, allowed_org_ids: [] });
  }
  // Close: gone for the vendor; a B-110 share view never carries it.
  await photo(f, "after");
  assert.equal((await complete(f)).status, "recorded");
  assert.equal(await vendorTenantPhone(f.token), null, "after close");
  const shareToken = newVendorToken(), shareHash = createHash("sha256").update(shareToken, "utf8").digest("hex");
  await db.query(`INSERT INTO app.case_shares(org_id,ticket_id,vendor_job_id,token_hash,token,created_by_kind,created_by)
    VALUES($1,$2,$3,$4,$5,'vendor',NULL)`, [ORG_ID, f.ticket, f.job, shareHash, shareToken]);
  await orgFlags(ORG_ID, { vendor_docs_v3: true, vendor_documents: true });
  await setPlatform("vendor_docs_v3", ON); await setPlatform("vendor_documents", ON);
  try {
    const shareView = await svc(null, async client => (await client.query("SELECT app.b110_share_view($1,false) r", [shareHash])).rows[0].r);
    assert.equal(shareView?.state, "ok", "the share link is live for this closed case");
    const text = JSON.stringify(shareView);
    assert.ok(!text.includes(lease.phone) && !text.includes(lease.phone.slice(4)), "share view has no tenant phone");
    assert.equal(await vendorTenantPhone(shareToken), null, "the share token is not a case bearer");
  } finally {
    await orgFlags(ORG_ID, { vendor_docs_v3: false, vendor_documents: false });
    for (const k of ["vendor_docs_v3", "vendor_documents"]) await setPlatform(k, { enabled: false, allowed_org_ids: [] });
  }
  // Reopen: the assigned vendor sees it again; a declined or reassigned vendor never does.
  assert.equal((await reopen(f.ticket)).status, "reopened");
  assert.deepEqual(await vendorTenantPhone(f.token), { phone: lease.phone });
  await db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [g.ticket, await vendorContact(ORG_ID)]);
  assert.equal(await vendorTenantPhone(g.token), null, "after reassignment");
  const declined = await fixture({ tenant: true, accept: false }); await decide(declined, "declined");
  assert.equal(await vendorTenantPhone(declined.token), null, "declined");
  assert.equal(await vendorTenantPhone(newVendorToken()), null);
  assert.equal(await vendorTenantPhone("not-a-token"), null);
});

/** Waits until `n` backends in THIS test database are blocked by the holder's own PID while running `fn`. */
async function waitForBlocked(lock: Client, fn: string, n = 1) {
  const holderPid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  for (let i = 0; i < 100; i++) {
    const blocked = (await db.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`, [holderPid, `%${fn}%`])).rows[0].n;
    if (blocked >= n) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`expected ${n} ${fn} blocked by ${holderPid}`);
}
async function holder() {
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='5s'");
  return client;
}
type Outcome = { result?: { status: string }; error?: unknown };
const settle = (pending: Promise<Outcome>, ms = 15000) => Promise.race([pending, new Promise<Outcome>(resolve => {
  setTimeout(() => resolve({ error: new Error(`still waiting after ${ms}ms`) }), ms).unref();
})]);

/**
 * One blocked 送出完工 per case: the holder takes `lock`, the save queues behind it, the holder applies `change`
 * (nothing for the positive control) and commits. The expected state is read through the holder after the change.
 */
async function blockedComplete(label: string, lock: (c: Client, f: Fixture) => Promise<unknown>,
  change: ((c: Client, f: Fixture) => Promise<unknown>) | null, expect: string, setup?: (f: Fixture) => Promise<unknown>, tenant = true) {
  // Estimate cases need the owner-held property (a lease's property may have no signed-in owner to decide).
  const f = await fixture({ tenant });
  if (setup) await setup(f); else await photo(f, "after");
  const client = await holder();
  let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
  try {
    await lock(client, f);
    pending = complete(f).then(result => ({ result }), error => ({ error }));
    await waitForBlocked(client, "b097_vendor_complete");
    if (change) await change(client, f);
    expected = await snapshot(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
  const outcome = await settle(pending!);
  if (expect === "recorded") {
    assert.equal(outcome.result?.status, "recorded", `${label}: ${String(outcome.error)}`);
    return;
  }
  if (expect === "refused") assert.ok(notFound(outcome.error), `${label}: ${JSON.stringify(outcome.result ?? String(outcome.error))}`);
  else assert.deepEqual(outcome.result, { status: expect }, `${label}: ${String(outcome.error)}`);
  assert.deepEqual(await snapshot(), expected, `${label}: nothing written after the change`);
}

test("lock races with real holders: a change committed while 送出完工 waits on any lock target is seen by the decision", { timeout: 240000 }, async () => {
  const lockOrg = (c: Client) => c.query("SELECT 1 FROM public.organizations WHERE id=$1 FOR UPDATE", [ORG_ID]);
  const lockSwitch = (c: Client) => c.query("SELECT 1 FROM public.platform_settings WHERE key='vendor_job_v3' FOR UPDATE");
  const lockTicket = (c: Client, f: Fixture) => c.query("SELECT 1 FROM public.maintenance_tickets WHERE id=$1 FOR UPDATE", [f.ticket]);
  const lockJob = (c: Client, f: Fixture) => c.query("SELECT 1 FROM public.repair_vendor_jobs WHERE id=$1 FOR UPDATE", [f.job]);
  const lockDecision = (c: Client, f: Fixture) => c.query("SELECT 1 FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1 FOR UPDATE", [f.job]);
  const lockPhotos = (c: Client, f: Fixture) => c.query("SELECT 1 FROM public.ticket_attachments WHERE ticket_id=$1 FOR UPDATE", [f.ticket]);
  try {
    await blockedComplete("org row: positive control", lockOrg, null, "recorded");
    await blockedComplete("org row: vendor_job_v3 off", lockOrg, c => orgFlags(ORG_ID, { vendor_job_v3: false }, c), "refused");
    await orgFlags(ORG_ID, { vendor_job_v3: true });
    await blockedComplete("org row: brand_v3 off", lockOrg, c => orgFlags(ORG_ID, { brand_v3: false }, c), "refused");
    await orgFlags(ORG_ID, { brand_v3: true });
    await blockedComplete("switch row: positive control", lockSwitch, null, "recorded");
    await blockedComplete("switch row: platform off", lockSwitch, c => setPlatform("vendor_job_v3", { ...ON, enabled: false }, c), "refused");
    await setPlatform("vendor_job_v3", ON);
    await blockedComplete("ticket row: positive control", lockTicket, null, "recorded");
    await blockedComplete("ticket row: reassigned to another vendor", lockTicket, async (c, f) => c.query(
      "UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [f.ticket, await vendorContact(ORG_ID)]), "refused");
    await blockedComplete("ticket row: closed by staff", lockTicket, (c, f) => c.query(
      "UPDATE public.maintenance_tickets SET status='closed',closed_at=now() WHERE id=$1", [f.ticket]), "rejected_closed");
    await blockedComplete("job row: positive control", lockJob, null, "recorded");
    await blockedComplete("job row: link revoked", lockJob, (c, f) => c.query(
      "UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [f.job]), "refused");
    await blockedComplete("job row: link expired", lockJob, (c, f) => c.query(
      "UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp() WHERE id=$1", [f.job]), "refused");
    await blockedComplete("decision row: positive control", lockDecision, null, "recorded");
    await blockedComplete("decision row: decision withdrawn", lockDecision, (c, f) => c.query(
      "DELETE FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1", [f.job]), "refused");
    await blockedComplete("photo row: positive control", lockPhotos, null, "recorded");
    await blockedComplete("photo row: the only after-photo removed", lockPhotos, (c, f) => c.query(
      "DELETE FROM public.ticket_attachments WHERE ticket_id=$1", [f.ticket]), "rejected_no_photo");
    await blockedComplete("photo row: the only after-photo made internal", lockPhotos, (c, f) => c.query(
      "UPDATE public.ticket_attachments SET is_internal=true WHERE ticket_id=$1", [f.ticket]), "rejected_no_photo");
    // A photo that appears while the save waits on an earlier lock is found and locked by the later photo probe.
    await blockedComplete("ticket row: an after-photo inserted during the wait", lockTicket, async (c, f) => {
      const file = randomUUID();
      await c.query(`INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
        VALUES($1,$2,'ticket-photos-private',$3,'late.jpg','image/jpeg',100)`, [file, f.org, `org/${f.org}/tickets/${f.ticket}/${file}.jpg`]);
      await c.query(`INSERT INTO public.ticket_attachments(org_id,ticket_id,file_id,is_internal,vendor_job_id,phase)
        VALUES($1,$2,$3,false,$4,'after')`, [f.org, f.ticket, file, f.job]);
    }, "recorded", async () => undefined);
  } finally {
    await orgFlags(ORG_ID, { vendor_job_v3: true, brand_v3: true });
    await setPlatform("vendor_job_v3", ON);
  }
});

test("lock races for 重開: a staff session revoked or a gate turned off while the reopen waits is refused with no write", { timeout: 120000 }, async () => {
  const lockTicket = (c: Client, f: Fixture) => c.query("SELECT 1 FROM public.maintenance_tickets WHERE id=$1 FOR UPDATE", [f.ticket]);
  const lockOrg = (c: Client) => c.query("SELECT 1 FROM public.organizations WHERE id=$1 FOR UPDATE", [ORG_ID]);
  const lockDone = (c: Client, f: Fixture) => c.query("SELECT 1 FROM app.b097_completions WHERE ticket_id=$1 FOR UPDATE", [f.ticket]);
  const run = async (label: string, lock: (c: Client, f: Fixture) => Promise<unknown>,
    change: ((c: Client, f: Fixture, session: string) => Promise<unknown>) | null, expect: "reopened" | "refused" | "rejected_expired",
    prepare?: (f: Fixture) => Promise<unknown>) => {
    const f = await fixture(); await photo(f, "after"); await complete(f);
    if (prepare) await prepare(f);
    const sessionId = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionId, USERS.admin, hash(randomUUID())]);
    const client = await holder();
    let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
    try {
      await lock(client, f);
      pending = reopen(f.ticket, "r", randomUUID(), { ...admin, sessionId }).then(result => ({ result }), error => ({ error }));
      await waitForBlocked(client, "b097_staff_reopen");
      if (change) await change(client, f, sessionId);
      expected = await snapshot(client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
    const outcome = await settle(pending!);
    if (expect === "reopened") { assert.equal(outcome.result?.status, "reopened", `${label}: ${String(outcome.error)}`); return; }
    if (expect === "refused") assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result ?? String(outcome.error))}`);
    else assert.deepEqual(outcome.result, { status: expect }, `${label}: ${String(outcome.error)}`);
    assert.deepEqual(await snapshot(), expected, label);
  };
  const revoke = (c: Client, _f: Fixture, session: string) => c.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [session]);
  await run("ticket row: positive control", lockTicket, null, "reopened");
  await run("ticket row: staff session revoked", lockTicket, revoke, "refused");
  await run("org row: positive control", lockOrg, null, "reopened");
  await run("org row: staff session revoked", lockOrg, revoke, "refused");
  try {
    await run("org row: vendor_job_v3 off by the holder", lockOrg, c => orgFlags(ORG_ID, { vendor_job_v3: false }, c), "refused");
  } finally { await orgFlags(ORG_ID, { vendor_job_v3: true }); }
  await run("completion row: positive control", lockDone, null, "reopened");
  // The window closes while the reopen waits: set it to end 1.5 s from now (completion and ticket together), hold, and
  // release after it has passed. One clock reading after the locks decides: rejected_expired, never a 23514.
  await run("completion row: the 7 days run out during the wait", lockDone, async () => {
    await new Promise(resolve => setTimeout(resolve, 1700));
  }, "rejected_expired", async f => {
    const until = (await db.query("SELECT clock_timestamp()+interval '1500 milliseconds' t")).rows[0].t;
    await db.query(`UPDATE app.b097_completions SET closed_at=$2::timestamptz-interval '168 hours',reopen_until=$2
      WHERE ticket_id=$1 AND reopened_at IS NULL AND superseded_at IS NULL`, [f.ticket, until]);
    await db.query("UPDATE public.maintenance_tickets SET closed_at=$2::timestamptz-interval '168 hours' WHERE id=$1", [f.ticket, until]);
  });
});

test("phone under locks: a reassignment and reporter change committed while the read waits never shows the new reporter's phone to the former vendor", { timeout: 120000 }, async () => {
  const newReporter = (await db.query(`INSERT INTO public.contacts(org_id,is_tenant,display_name,phone_e164) VALUES($1,true,'B-098 new reporter','+886911000983') RETURNING id::text`, [ORG_ID])).rows[0].id;
  await db.query("INSERT INTO public.lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')", [ORG_ID, lease.id, newReporter]);
  const run = async (label: string, lock: (c: Client, f: Fixture) => Promise<unknown>, change: ((c: Client, f: Fixture) => Promise<unknown>) | null) => {
    const f = await fixture({ tenant: true });
    const client = await holder();
    let pending: Promise<{ result?: { phone: string | null } | null; error?: unknown }> | undefined;
    try {
      await lock(client, f);
      pending = vendorTenantPhone(f.token).then(result => ({ result }), error => ({ error }));
      await waitForBlocked(client, "b098_vendor_tenant_phone");
      if (change) await change(client, f);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
    const outcome = await Promise.race([pending!, new Promise<{ error: Error }>(r => setTimeout(() => r({ error: new Error("still waiting") }), 15000).unref())]);
    assert.ok(!("error" in outcome && outcome.error), `${label}: ${String((outcome as { error?: unknown }).error)}`);
    return (outcome as { result: { phone: string | null } | null }).result;
  };
  const lockTicket = (c: Client, f: Fixture) => c.query("SELECT 1 FROM public.maintenance_tickets WHERE id=$1 FOR UPDATE", [f.ticket]);
  const lockReporter = (c: Client) => c.query("SELECT 1 FROM public.contacts WHERE id=$1 FOR UPDATE", [lease.tenant]);
  const lockDecision = (c: Client, f: Fixture) => c.query("SELECT 1 FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1 FOR UPDATE", [f.job]);
  const lockParty = (c: Client) => c.query("SELECT 1 FROM public.lease_parties WHERE lease_id=$1 AND contact_id=$2 FOR UPDATE", [lease.id, lease.tenant]);
  assert.deepEqual(await run("ticket row: positive control", lockTicket, null), { phone: lease.phone });
  assert.equal(await run("ticket row: reassigned and reporter changed together", lockTicket, async (c, f) => c.query(
    "UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=$2,reported_by_contact_id=$3 WHERE id=$1", [f.ticket, await vendorContact(ORG_ID), newReporter])), null);
  assert.deepEqual(await run("ticket row: reporter changed only (still this vendor's job)", lockTicket, (c, f) => c.query(
    "UPDATE public.maintenance_tickets SET reported_by_contact_id=$2 WHERE id=$1", [f.ticket, newReporter])), { phone: "+886911000983" });
  assert.deepEqual(await run("decision row: positive control", lockDecision, null), { phone: lease.phone });
  assert.equal(await run("decision row: decision withdrawn", lockDecision, (c, f) => c.query("DELETE FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1", [f.job])), null);
  assert.deepEqual(await run("reporter row: positive control", lockReporter, null), { phone: lease.phone });
  const original = lease.phone;
  try {
    assert.deepEqual(await run("reporter row: phone changed", lockReporter, c => c.query("UPDATE public.contacts SET phone_e164='+886911000984' WHERE id=$1", [lease.tenant])),
      { phone: "+886911000984" }, "the reporter's own new number, never a stale pairing");
  } finally { await db.query("UPDATE public.contacts SET phone_e164=$2 WHERE id=$1", [lease.tenant, original]); }
  assert.deepEqual(await run("lease-party row: positive control", lockParty, null), { phone: lease.phone });
  try {
    assert.deepEqual(await run("lease-party row: made a guarantor", lockParty, c => c.query(
      "UPDATE public.lease_parties SET role='guarantor' WHERE lease_id=$1 AND contact_id=$2", [lease.id, lease.tenant])), { phone: null });
  } finally { await db.query("UPDATE public.lease_parties SET role='primary' WHERE lease_id=$1 AND contact_id=$2", [lease.id, lease.tenant]); }
});

test("lock races on the estimate head (送出完工) and the caller's user row (重開), each with a positive control", { timeout: 120000 }, async () => {
  // Estimate head: a recorded small estimate is current; while the save waits on the head, the head is pointed at an
  // over-threshold version still waiting for the owner, so the decision sees the work is not allowed.
  const lockHead = (c: Client, f: Fixture) => c.query("SELECT 1 FROM app.b013_estimate_heads WHERE ticket_id=$1 FOR UPDATE", [f.ticket]);
  // Two real B-013 versions: v1 small (allowed), v2 over the threshold (waiting for the owner). The head is set back to v1
  // before the race; while the save waits on the head, the holder points it at v2, so the decision sees the work is not
  // allowed. (A full estimate revision would also need the ticket, which the waiting save already holds: that
  // interleaving cannot happen, it is serialized after the save.)
  type WithVersions = Fixture & { v1?: string; v2?: string };
  const withVersions = async (f: WithVersions) => {
    await photo(f, "after");
    f.v1 = await estimate(f, 100);
    const r = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
        $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$7::uuid,600000::bigint,$5::text,$6::smallint,'Bigger repair','[]'::jsonb,$8::bytea) r`,
    [ORG_ID, admin.sessionId, randomUUID(), f.ticket, currency, minorUnit, f.v1, createHash("sha256").update(f.ticket + "big").digest()])).rows[0].r);
    assert.equal(r.status, "recorded"); assert.equal(r.requires_owner_decision, true);
    f.v2 = String(r.version_id);
    await db.query("UPDATE app.b013_estimate_heads SET current_version_id=$2 WHERE ticket_id=$1", [f.ticket, f.v1]);
  };
  await blockedComplete("estimate head: positive control", lockHead, null, "recorded", withVersions, false);
  await blockedComplete("estimate head: pointed at the version waiting for the owner", lockHead, (c, f) => c.query(
    "UPDATE app.b013_estimate_heads SET current_version_id=$2 WHERE ticket_id=$1", [f.ticket, (f as WithVersions).v2]), "rejected_state", withVersions, false);
  // The caller's auth.users row (the status note's author FK): a membership suspended during that wait is refused.
  const run = async (label: string, change: ((c: Client) => Promise<unknown>) | null) => {
    const f = await fixture(); await photo(f, "after"); await complete(f);
    const sessionId = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionId, USERS.manager, hash(randomUUID())]);
    const manager: Session = { ...admin, userId: USERS.manager, sessionId, role: "manager" };
    const client = await holder();
    let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
    try {
      await client.query("SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE", [USERS.manager]);
      pending = reopen(f.ticket, "r", randomUUID(), manager).then(result => ({ result }), error => ({ error }));
      await waitForBlocked(client, "b097_staff_reopen");
      if (change) await change(client);
      expected = await snapshot(client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
    const outcome = await settle(pending!);
    if (!change) { assert.equal(outcome.result?.status, "reopened", `${label}: ${String(outcome.error)}`); return; }
    assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result ?? String(outcome.error))}`);
    assert.deepEqual(await snapshot(), expected, label);
  };
  await run("user row: positive control", null);
  try {
    await run("user row: membership suspended", c => c.query("UPDATE public.org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]));
  } finally { await db.query("UPDATE public.org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]); }
});

test("route: token body only; 400 invalid, 404 not admitted, 422 no photo, 200 recorded and replay, 409 conflict; reopen route needs a staff session", async () => {
  const f = await fixture();
  const body = { token: f.token, requestId: randomUUID(), note: null };
  assert.equal((await post(body, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ ...body, extra: 1 })).status, 400);
  assert.equal((await post({ ...body, note: "x".repeat(501) })).status, 400);
  assert.equal((await post("{nope")).status, 400);
  assert.equal((await post({ ...body, pad: "x".repeat(5000) })).status, 413);
  assert.equal((await post({ ...body, token: newVendorToken() })).status, 404);
  assert.equal((await post(body)).status, 422);
  await photo(f, "after");
  const ok = await post(body);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal((await ok.json()).status, "recorded");
  assert.equal((await (await post(body)).json()).replayed, true);
  assert.equal((await post({ ...body, note: "changed" })).status, 409);
  // 重開 route: no session is 401; a real admin session cookie with consent reopens.
  const jar = new Map<string, string>();
  const cookieSpy = mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
    set: () => {}, delete: () => {}, has: (key: string) => jar.has(key), getAll: () => [...jar].map(([name, value]) => ({ name, value })) }) as never);
  const headerSpy = mock.method(nextHeaders, "headers", async () => new Headers({ origin }) as never);
  try {
    const reopenPost = (payload: unknown, headers: Record<string, string> = {}) => reopenRoute(new Request(`${origin}/api/repairs/reopen`, {
      method: "POST", body: JSON.stringify(payload), headers: { origin, "content-type": "application/json", ...headers } }));
    const payload = { ticketId: f.ticket, requestId: randomUUID(), reason: "還在滴水" };
    assert.equal((await reopenPost(payload)).status, 401, "no session");
    assert.equal((await reopenPost(payload, { origin: "https://evil.test" })).status, 403);
    // Signed-in, consented users without an admin / manager tickets.update seat get 403 with no write (MGT-146-AC4).
    const consent = buildStoredConsent("portal");
    const before = await snapshot();
    for (const [label, user] of [["accountant", USERS.accountant], ["maintenance", USERS.maintenance], ["tenant", USERS.tenant], ["owner", USERS.owner]] as const) {
      const cred = randomUUID();
      await db.query("INSERT INTO public.auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [user, hash(cred)]);
      await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [user, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
      jar.set("condola_session", cred); jar.set("condola_org", ORG_ID);
      const denied = await reopenPost({ ...payload, requestId: randomUUID() });
      assert.equal(denied.status, 403, `${label}: an authenticated caller without the seat gets 403`);
    }
    assert.deepEqual(await snapshot(), before, "denied reopen posts wrote nothing");
    jar.set("condola_session", staffCred); jar.set("condola_org", ORG_ID);
    assert.equal((await reopenPost({ ...payload, reason: "" })).status, 400);
    const response = await reopenPost(payload);
    assert.equal(response.status, 200, "a real admin session with consent reopens");
    assert.deepEqual(await response.json(), { status: "reopened", replayed: false });
    assert.equal(await status(f.ticket), "in_progress");
  } finally { cookieSpy.mock.restore(); headerSpy.mock.restore(); }
});

/** Renders a server page outside Next with the request cookie store it reads (as in the B-105 test). */
async function render(Page: unknown, token: string) {
  (globalThis as Record<string, unknown>).React ??= React;
  const [{ workAsyncStorage }, { workUnitAsyncStorage }, { RequestCookies }, { RequestCookiesAdapter }, { AppRouterContext }, { renderToReadableStream }] = await Promise.all([
    import("next/dist/server/app-render/work-async-storage.external"), import("next/dist/server/app-render/work-unit-async-storage.external"),
    import("next/dist/server/web/spec-extension/cookies"), import("next/dist/server/web/spec-extension/adapters/request-cookies"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"), import("react-dom/server.edge")]);
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: "condola_locale=zh-TW" })));
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return workAsyncStorage.run({ route: "/v/[token]" } as never, () => workUnitAsyncStorage.run({ type: "private-cache", cookies } as never, async () => {
    const element = await (Page as (p: unknown) => Promise<React.ReactElement>)({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
    const stream = await renderToReadableStream(React.createElement(AppRouterContext.Provider, { value: router as never }, element));
    await stream.allReady;
    return new Response(stream).text();
  }));
}
const page = async (name: "" | "done" | "time") => (await import(`../app/v/[token]/${name ? `${name}/` : ""}page`)).default;
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/;

test("pages: RV-JOB shows 回報完工 once a 處理前 photo exists; RV-DONE and the RV-TIME phone part exist only on an accepted open case", async () => {
  const f = await fixture({ tenant: true, accept: false });
  await assert.rejects(render(await page("done"), f.token), NOT_FOUND, "RV-DONE before 接單");
  await assert.rejects(render(await page("time"), f.token), NOT_FOUND, "RV-TIME before 接單");
  await decide(f, "accepted");
  assert.doesNotMatch(await render(await page(""), f.token), /vendor-case-report|回報完工/, "no 處理前 photo yet: no primary");
  await photo(f, "before");
  const job = await render(await page(""), f.token);
  assert.match(job, new RegExp(`<a class="v-token-primary v-case-block" href="/v/${f.token}/done" data-testid="vendor-case-report">回報完工</a>`));
  const empty = await render(await page("done"), f.token);
  for (const text of [">回報完工<", "處理後照片", "至少一張", "說明（選填）", "送出就結案，租客會看到「已完成」。", "7 天內可以重開。", ">送出完工<", ">取消<", "上傳處理後照片"]) {
    assert.ok(empty.includes(text), text);
  }
  assert.match(empty, /<button type="submit" class="v-token-primary v-case-block" disabled=""/, "no after-photo: 送出完工 disabled");
  const form = empty.match(/<form[^>]*data-testid="vendor-done"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.equal((form.match(/class="v-token-primary/g) ?? []).length, 1, "one solid button in the form (the upload is an outline)");
  await photo(f, "after", { name: "天花板_修好.jpg" });
  const withPhoto = await render(await page("done"), f.token);
  assert.ok(withPhoto.includes("天花板_修好.jpg"));
  assert.doesNotMatch(withPhoto, /<button type="submit" class="v-token-primary v-case-block" disabled=""/);
  const time = await render(await page("time"), f.token);
  assert.ok(time.includes(">約時間<"));
  assert.ok(time.includes(`href="tel:${lease.phone}"`) && time.includes(">打電話給租客<"));
  assert.doesNotMatch(time, /送出時間|記下電話約好的時間/, "B-095 parts are not drawn yet");
  assert.equal((await complete(f)).status, "recorded");
  await assert.rejects(render(await page("done"), f.token), NOT_FOUND, "closed: no RV-DONE");
  await assert.rejects(render(await page("time"), f.token), NOT_FOUND, "closed: no phone page");
  assert.doesNotMatch(await render(await page(""), f.token), new RegExp(`tel:|${lease.phone.replace("+", "\\+")}`), "closed job page: no phone");
  // OFF: the RV pages do not exist.
  const g = await fixture({ tenant: true }); await photo(g, "before");
  await orgFlags(ORG_ID, { vendor_job_v3: false });
  try {
    for (const name of ["done", "time"] as const) await assert.rejects(render(await page(name), g.token), NOT_FOUND, `${name} OFF`);
    assert.doesNotMatch(await render(await page(""), g.token), /vendor-case-report|tel:/);
  } finally { await orgFlags(ORG_ID, { vendor_job_v3: true }); }
});
