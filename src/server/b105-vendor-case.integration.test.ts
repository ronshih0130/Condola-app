import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import React from "react";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { confirmVendorCasePhoto, decideVendorCase, loadVendorCase, type VendorCase } from "./b105-vendor-case";
import { hashVendorToken } from "./vendor-repair-rules";

// Real connections, gateways and writers; no pg mock and no table-grant workaround.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const session = randomUUID();
const KEYS = ["vendor_job_v3", "vendor_link", "repair_approvals"] as const;
let property: string, currency: string, minorUnit: number;
type Fixture = { org: string; ticket: string; job: string; token: string; contact: string };

async function setPlatform(key: string, orgs: string[], enabled = true) {
  await db.query(`INSERT INTO public.platform_settings(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify({ enabled, allowed_org_ids: orgs })]);
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
  // Both orgs carry every org flag; only ORG_ID is on the platform allowlists (cross-org denial below).
  await db.query(`UPDATE public.organizations SET plan_tier='beta', feature_flags=feature_flags||
    '{"vendor_dispatch":true,"vendor_link":true,"brand_v2":true,"brand_v3":true,"vendor_job_v3":true,"repair_approvals":true}'::jsonb
    WHERE id=ANY($1::uuid[])`, [[ORG_ID, ORG2_ID]]);
  for (const name of KEYS) await setPlatform(name, [ORG_ID]);
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
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

async function fixture(org = ORG_ID): Promise<Fixture> {
  const ticket = randomUUID(), job = randomUUID(), token = randomBytes(32).toString("base64url");
  const contact = (await db.query(`INSERT INTO public.contacts(org_id,is_vendor,display_name,phone_e164,vendor_trade)
    VALUES($1,true,$2,'+886900000001','plumbing') RETURNING id`, [org, `B-105 vendor ${job.slice(0, 8)}`])).rows[0].id as string;
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

/** A stored vendor upload row (bytes are not needed by these gateways). */
async function photo(f: Fixture, opts: { vendorJob?: string | null; internal?: boolean; name?: string } = {}) {
  const file = randomUUID();
  await db.query(`INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
    VALUES($1,$2,'ticket-photos-private',$3,$4,'image/jpeg',100)`,
  [file, f.org, `org/${f.org}/tickets/${f.ticket}/${file}.jpg`, opts.name ?? `${file.slice(0, 6)}.jpg`]);
  return (await db.query(`INSERT INTO public.ticket_attachments(org_id,ticket_id,file_id,is_internal,vendor_job_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id::text`, [f.org, f.ticket, file, opts.internal ?? false,
    opts.vendorJob === undefined ? f.job : opts.vendorJob])).rows[0].id as string;
}

async function ready(token: string): Promise<VendorCase> {
  const loaded = await loadVendorCase(token);
  assert.equal(loaded?.state, "ready");
  return (loaded as { value: VendorCase }).value;
}
const decisions = async (job: string) => (await db.query("SELECT * FROM app.b105_vendor_job_decisions WHERE vendor_job_id=$1", [job])).rows;
const phaseOf = async (id: string) => (await db.query("SELECT phase FROM public.ticket_attachments WHERE id=$1", [id])).rows[0].phase as string | null;
const phaseCall = (token: string, id: string, phase = "before") => svc(null, client =>
  client.query("SELECT app.b105_vendor_photo_phase($1,false,$2::uuid,$3) r", [hashVendorToken(token), id, phase]));
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
/** svc wraps database errors; the gateway's refusal is SQLSTATE 42501 underneath. */
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501";
const accept = (token: string, agreedOn: string | null = null, requestId = randomUUID()) =>
  decideVendorCase(token, { requestId, decision: "accepted", agreedOn, reason: null });

test("gateways are service-only and the private table is revoked from every API role", async () => {
  for (const signature of ["app.b105_vendor_case(text,boolean)", "app.b105_vendor_decide(text,boolean,uuid,text,date,text)", "app.b105_vendor_photo_phase(text,boolean,uuid,text)"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok, role === "service_role", `${role} ${signature}`);
    }
  }
  for (const signature of ["app.b105_enabled(uuid,boolean)", "app.b105_vendor_write_job(text,boolean)"]) {
    assert.equal((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') ok", [signature])).rows[0].ok, false);
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    await db.query("BEGIN");
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(db.query("SELECT 1 FROM app.b105_vendor_job_decisions"), { code: "42501" });
    } finally { await db.query("ROLLBACK"); }
  }
});

test("flag OFF: no case (the page keeps V-TOKEN) and every writer refuses without a row", async () => {
  const f = await fixture();
  const id = await photo(f);
  await setPlatform("vendor_job_v3", [ORG_ID], false);
  try {
    assert.equal(await loadVendorCase(f.token), null);
    await assert.rejects(accept(f.token), notFound);
    await assert.rejects(phaseCall(f.token, id), refused);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"brand_v3\":false}'::jsonb WHERE id=$1", [ORG_ID]);
    await setPlatform("vendor_job_v3", [ORG_ID]);
    assert.equal(await loadVendorCase(f.token), null, "brand_v3 OFF disables the case too");
  } finally {
    await setPlatform("vendor_job_v3", [ORG_ID]);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"brand_v3\":true}'::jsonb WHERE id=$1", [ORG_ID]);
  }
  assert.deepEqual(await decisions(f.job), []);
  assert.equal(await phaseOf(id), null);
  assert.equal((await ready(f.token)).decision, null);
});

test("token-only scope: one job's own non-internal uploads; never another job, ticket or the tenant's photos", async () => {
  const a = await fixture(), b = await fixture();
  const own = await photo(a, { name: "own.jpg" });
  await photo(a, { vendorJob: null, name: "tenant.jpg" });
  await photo(a, { internal: true, name: "internal.jpg" });
  await photo(b, { name: "other-ticket.jpg" });
  const old = randomUUID();
  await db.query(`INSERT INTO public.repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,revoked_at,active)
    VALUES($1,$2,$3,'Old','+886900000002','x',$4,clock_timestamp()+interval '1 day',clock_timestamp(),false)`,
  [old, ORG_ID, a.ticket, hashVendorToken(randomBytes(32).toString("base64url"))]);
  await photo(a, { vendorJob: old, name: "old-job.jpg" });
  const value = await ready(a.token);
  assert.deepEqual(value.photos.map(p => [p.id, p.name, p.phase, p.viewable]), [[own, "own.jpg", "after", true]]);
  assert.equal(value.company, (await db.query("SELECT name FROM public.organizations WHERE id=$1", [ORG_ID])).rows[0].name);
  // B's token cannot tag A's photo, and A's decision never lands on B.
  await accept(b.token);
  await assert.rejects(phaseCall(b.token, own), refused);
  assert.equal(await phaseOf(own), null);
  assert.deepEqual(await decisions(a.job), []);
});

test("accept and decline are idempotent per job, keep the first decision, and validate MGT-104-AC4", async () => {
  const f = await fixture();
  await db.query("UPDATE public.maintenance_tickets SET scheduled_on=DATE '2026-11-20' WHERE id=$1", [f.ticket]);
  assert.deepEqual(await accept(f.token, "2026-11-19"), { status: "rejected_invalid" });
  assert.deepEqual(await decisions(f.job), [], "an invalid date writes nothing");
  const request = randomUUID();
  assert.deepEqual(await accept(f.token, "2026-11-21", request), { status: "recorded", decision: "accepted", replayed: false });
  assert.deepEqual(await accept(f.token, "2026-11-21", request), { status: "recorded", decision: "accepted", replayed: true });
  assert.deepEqual(await accept(f.token, "2026-11-30"), { status: "recorded", decision: "accepted", replayed: true });
  assert.deepEqual(await decideVendorCase(f.token, { requestId: randomUUID(), decision: "declined", agreedOn: null, reason: null }), { status: "rejected_conflict" });
  const rows = await decisions(f.job);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "accepted"); assert.equal(rows[0].request_id, request);
  assert.equal(rows[0].agreed_completion_on.toISOString().slice(0, 10) <= "2026-11-21", true);
  const value = await ready(f.token);
  assert.equal(value.decision, "accepted"); assert.equal(value.agreedCompletionOn, "2026-11-21"); assert.equal(value.scheduledOn, "2026-11-20");

  const g = await fixture();
  const declined = randomUUID();
  const first = await decideVendorCase(g.token, { requestId: declined, decision: "declined", agreedOn: null, reason: null });
  assert.deepEqual(first, { status: "recorded", decision: "declined", replayed: false });
  assert.deepEqual(await decideVendorCase(g.token, { requestId: declined, decision: "declined", agreedOn: null, reason: null }), { ...first, replayed: true });
  assert.deepEqual(await accept(g.token), { status: "rejected_conflict" });
  const h = await fixture();
  await decideVendorCase(h.token, { requestId: randomUUID(), decision: "declined", agreedOn: null, reason: "這週排不出時間" });
  assert.equal((await decisions(h.job))[0].decline_reason, "這週排不出時間");
  assert.equal((await decisions(g.job))[0].decline_reason, null, "the reason is optional (GS-49)");
  assert.equal((await ready(g.token)).decision, "declined");
  // A declined job has no photo writes.
  const id = await photo(g);
  await assert.rejects(phaseCall(g.token, id), refused);
  await assert.rejects(confirmVendorCasePhoto(g.token, "after", { path: "x", fileName: "x.jpg", mime: "image/jpeg", size: 1, uploadToken: "x" }), notFound);
});

test("revoked, expired, unshared, reassigned and cross-org links are denied with no writes", async () => {
  const cases: [string, (f: Fixture) => Promise<unknown>][] = [
    ["revoked", f => db.query("UPDATE public.repair_vendor_jobs SET revoked_at=clock_timestamp(),active=false WHERE id=$1", [f.job])],
    ["expired", f => db.query("UPDATE public.repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.job])],
    ["unshared", f => db.query("UPDATE public.repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1", [f.job])],
    ["reassigned", f => db.query("UPDATE public.maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1", [f.ticket])],
  ];
  for (const [name, mutate] of cases) {
    const f = await fixture();
    const id = await photo(f);
    await mutate(f);
    assert.equal(await loadVendorCase(f.token), null, name);
    await assert.rejects(accept(f.token), notFound, name);
    await assert.rejects(decideVendorCase(f.token, { requestId: randomUUID(), decision: "declined", agreedOn: null, reason: null }), notFound, name);
    await assert.rejects(phaseCall(f.token, id), refused, name);
    assert.deepEqual(await decisions(f.job), [], name);
    assert.equal(await phaseOf(id), null, name);
  }
  // ORG2 has every org flag but is not on the platform allowlists.
  const other = await fixture(ORG2_ID);
  const id = await photo(other);
  assert.equal(await loadVendorCase(other.token), null);
  await assert.rejects(accept(other.token), notFound);
  await assert.rejects(phaseCall(other.token, id), refused);
  assert.deepEqual(await decisions(other.job), []);
  assert.equal(await phaseOf(id), null);
  await assert.rejects(accept(randomBytes(32).toString("base64url")), notFound, "unknown token");
});

test("RV-JOB-WAIT: an accepted job whose current estimate needs the owner reports that version", async () => {
  const f = await fixture();
  await accept(f.token);
  assert.equal((await ready(f.token)).ownerWaitVersion, null);
  const estimate = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,$8::bigint,$5::text,$6::smallint,
      'Repair ceiling','[]'::jsonb,$7::bytea) r`,
  [ORG_ID, session, randomUUID(), f.ticket, currency, minorUnit, createHash("sha256").update(f.ticket).digest(), 600000])).rows[0].r);
  assert.equal(estimate.status, "recorded"); assert.equal(estimate.requires_owner_decision, true);
  const value = await ready(f.token);
  assert.equal(value.ownerWaitVersion, 1);
  // Below the threshold nothing waits for the owner.
  const g = await fixture();
  await accept(g.token);
  await svc(USERS.admin, client => client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,100::bigint,$5::text,$6::smallint,'Small','[]'::jsonb,$7::bytea)`,
  [ORG_ID, session, randomUUID(), g.ticket, currency, minorUnit, createHash("sha256").update(g.ticket).digest()]));
  assert.equal((await ready(g.token)).ownerWaitVersion, null);
});

test("RV-PHOTOS tags only after 接單 and only this job's upload; after close every photo write is refused (GS-51)", async () => {
  const f = await fixture();
  const id = await photo(f);
  await assert.rejects(phaseCall(f.token, id), refused, "no photo writes before 接單");
  await accept(f.token);
  const result = (await phaseCall(f.token, id)).rows[0].r;
  assert.deepEqual(result, { status: "recorded" });
  assert.deepEqual((await phaseCall(f.token, id)).rows[0].r, { status: "recorded" }, "same set again is a replay");
  await assert.rejects(phaseCall(f.token, id, "after"), refused, "a tagged photo never moves sets");
  assert.deepEqual((await phaseCall(f.token, id, "during")).rows[0].r, { status: "rejected_invalid" });
  assert.equal(await phaseOf(id), "before");
  assert.deepEqual((await ready(f.token)).photos.map(p => p.phase), ["before"]);

  const after = await photo(f);
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  const closed = await ready(f.token);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.photos.map(p => [p.phase, p.viewable]), [["before", false], ["after", false]]);
  await assert.rejects(phaseCall(f.token, after), refused);
  await assert.rejects(accept(f.token), notFound);
  await assert.rejects(confirmVendorCasePhoto(f.token, "after", { path: "x", fileName: "x.jpg", mime: "image/jpeg", size: 1, uploadToken: "x" }), notFound);
  assert.equal(await phaseOf(after), null);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.ticket_attachments WHERE ticket_id=$1", [f.ticket])).rows[0].n, 2);
  // A staff-shared photo stays visible after close.
  await db.query("INSERT INTO public.repair_vendor_job_shared_photos(org_id,job_id,attachment_id,approved_by) VALUES($1,$2,$3,$4)", [ORG_ID, f.job, after, USERS.admin]);
  assert.deepEqual((await ready(f.token)).photos.map(p => p.viewable), [false, true]);
  // GS-29: a reopen keeps the same link; the case is writable again.
  await db.query("UPDATE public.maintenance_tickets SET status='in_progress' WHERE id=$1", [f.ticket]);
  assert.equal((await ready(f.token)).closed, false);
});

/** Renders the real server pages outside Next with the request cookie store they read. */
async function render(page: "job" | "photos", token: string, phase?: string) {
  (globalThis as Record<string, unknown>).React ??= React;
  const [{ workAsyncStorage }, { workUnitAsyncStorage }, { RequestCookies }, { RequestCookiesAdapter }, { AppRouterContext }, { renderToReadableStream }] = await Promise.all([
    import("next/dist/server/app-render/work-async-storage.external"), import("next/dist/server/app-render/work-unit-async-storage.external"),
    import("next/dist/server/web/spec-extension/cookies"), import("next/dist/server/web/spec-extension/adapters/request-cookies"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"), import("react-dom/server.edge")]);
  const Page = page === "job" ? (await import("../app/v/[token]/page")).default : (await import("../app/v/[token]/photos/page")).default;
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: "condola_locale=zh-TW" })));
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return workAsyncStorage.run({ route: `/v/[token]${page === "job" ? "" : "/photos"}` } as never, () => workUnitAsyncStorage.run({ type: "private-cache", cookies } as never, async () => {
    const element = await (Page as (p: unknown) => Promise<React.ReactElement>)({ params: Promise.resolve({ token }), searchParams: Promise.resolve(phase ? { phase } : {}) });
    const stream = await renderToReadableStream(React.createElement(AppRouterContext.Provider, { value: router as never }, element));
    await stream.allReady;
    return new Response(stream).text();
  }));
}

test("real pages: RV-JOB-ACCEPT replaces the V-TOKEN content; RV-PHOTOS-CLOSED has no upload; OFF keeps V-TOKEN", async () => {
  const f = await fixture();
  const html = await render("job", f.token);
  for (const text of ["派了這一件給你，下一步：決定要不要接。", "待接單", "約定完工日", "接受工單", "不接受", "不接這一件？", "確定不接", "v-token-tabs"]) assert.ok(html.includes(text), text);
  for (const legacy of ["vendor-submit", "vendor-propose", "vendor-reject", "vendor-complete", "v-token-warning", "回報進度"]) assert.ok(!html.includes(legacy), legacy);
  await assert.rejects(render("photos", f.token), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/, "no photo page before 接單");
  await accept(f.token);
  await photo(f, { name: "天花板_修好.jpg" });
  const open = await render("photos", f.token);
  assert.ok(open.includes("上傳處理後照片") && open.includes("天花板_修好.jpg") && open.includes(" › 照片"));
  await db.query("UPDATE public.maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  const closed = await render("photos", f.token);
  assert.ok(closed.includes("這一案已結案，照片不能再改。要補照片，請") && closed.includes("重開這一案。"));
  assert.doesNotMatch(closed, /type="file"|上傳處理/);
  await setPlatform("vendor_job_v3", [ORG_ID], false);
  try {
    const g = await fixture();
    const legacy = await render("job", g.token);
    assert.ok(legacy.includes("v-token-v3") && !legacy.includes("待接單"));
    await assert.rejects(render("photos", g.token), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  } finally { await setPlatform("vendor_job_v3", [ORG_ID]); }
});
