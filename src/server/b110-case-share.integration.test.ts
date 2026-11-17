import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import CaseSharePage from "../app/s/[token]/page";
import { POST as shareRoute } from "../app/api/vendor-jobs/case-share/route";
import { GET as photoRoute } from "../app/s/[token]/photos/[id]/route";
import { SharePage } from "../components/v3/share/share-page";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { loadSharePhoto, loadShareView, staffCaseShare, staffRevokeCaseShare, vendorCaseShare } from "./b110-case-share";
import { hashVendorToken } from "./vendor-repair-rules";

// B-110 on a cloned disposable database: real B-105 case admission, real app.b110_* gateways, real routes and page.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin", kind: "staff",
  name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const manager: Session = { ...admin, userId: USERS.manager, sessionId: randomUUID(), role: "manager" };
const accountant: Session = { ...admin, userId: USERS.accountant, sessionId: randomUUID(), role: "accountant" };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const ORG_FLAGS = { vendor_dispatch: true, vendor_link: true, brand_v2: true, brand_v3: true, vendor_job_v3: true, vendor_docs_v3: true, vendor_documents: true };
const PLATFORM = ["vendor_job_v3", "vendor_link", "vendor_docs_v3", "vendor_documents"];
type Fixture = { org: string; ticket: string; job: string; token: string; contact: string; profile: string };

async function setPlatform(key: string, orgs: string[], enabled = true) {
  await db.query(`INSERT INTO public.platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, JSON.stringify({ enabled, allowed_org_ids: orgs })]);
}
async function orgFlags(org: string, patch: Record<string, unknown>) {
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
}

// A local stand-in for the photo store, so the real handler can stream bytes; every request is recorded.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const storageHits: string[] = [];
const storage = createServer((req, res) => { storageHits.push(req.url ?? ""); res.setHeader("content-type", "image/jpeg"); res.end(Buffer.from(JPEG)); });
const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
test.before(async () => {
  (globalThis as Record<string, unknown>).React ??= React;
  await new Promise<void>(resolve => storage.listen(0, "127.0.0.1", resolve));
  const address = storage.address(); assert.ok(address && typeof address !== "string");
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`; process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-only";
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true"; process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  await db.query("UPDATE public.organizations SET plan_tier='beta' WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
  for (const org of [ORG_ID, ORG2_ID]) await orgFlags(org, ORG_FLAGS);
  for (const k of PLATFORM) await setPlatform(k, [ORG_ID]);
  for (const s of [admin, manager, accountant, coast]) {
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [s.sessionId, s.userId, randomUUID().replaceAll("-", "").padEnd(64, "0")]);
  }
});
test.after(async () => {
  await new Promise<void>(resolve => storage.close(() => resolve()));
  for (const [key, value] of [["SUPABASE_URL", savedEnv.url], ["SUPABASE_SERVICE_ROLE_KEY", savedEnv.key]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

/** A closed B-105 case with an enhanced vendor link (the vendor's bearer), and that vendor's B-025 profile. */
async function fixture(org = ORG_ID, status = "closed"): Promise<Fixture> {
  const ticket = randomUUID(), job = randomUUID(), token = randomBytes(32).toString("base64url");
  const contact = (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'B-110 Vendor','+886912345678') RETURNING id::text", [org])).rows[0].id;
  const property = (await db.query("SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1", [org])).rows[0].id;
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,status,title,description,assigned_vendor_contact_id,currency)
    VALUES($1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),$3,$4,'浴室天花板滴水','租客 林雅婷 0912-000-111 內部備註',$5,'TWD')`,
  [ticket, org, property, status, contact]);
  await db.query(`INSERT INTO repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,scope,sharing_approved_at,shared_description,vendor_contact_id)
    VALUES($1,$2,$3,'王師傅水電','+886912345678','平日',$4,clock_timestamp()+interval '1 day','case_collaboration',clock_timestamp(),'shared',$5)`,
  [job, org, ticket, hashVendorToken(token), contact]);
  await db.query("INSERT INTO repair_vendor_secrets(job_id,token) VALUES($1,$2)", [job, token]);
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
    VALUES($1,$2,'B110','individual','王師傅水電',$3) RETURNING id::text`, [org, contact, `+8869${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`])).rows[0].id;
  return { org, ticket, job, token, contact, profile };
}
let seq = 0;
async function document(f: Fixture, issuedAt: string, opts: { voidedAt?: string; total?: number } = {}) {
  const id = (await db.query(`INSERT INTO vendor_documents(org_id,vendor_profile_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,issued_at,idempotency_key)
    VALUES($1,$2,$3,'completion_statement',$4,$5,'{"kind":"owner","receipt_title":"林雅婷"}','[]',$6,$7::timestamptz,$8) RETURNING id::text`,
  [f.org, f.profile, f.ticket, ++seq, `CMP-2026-${String(seq).padStart(3, "0")}`, opts.total ?? 5200, issuedAt, randomUUID()])).rows[0].id;
  await db.query("INSERT INTO vendor_document_pdf_bytes(document_id,org_id,bytes,snapshot) VALUES($1,$2,'\\x255044462d'::bytea,'{}')", [id, f.org]);
  if (opts.voidedAt) await db.query("UPDATE vendor_documents SET status='voided',voided_at=$2::timestamptz,void_reason='開錯抬頭' WHERE id=$1", [id, opts.voidedAt]);
  return id;
}
async function photo(f: Fixture, opts: { vendorJob?: string | null; phase?: string | null; approved?: boolean; name: string }) {
  const file = randomUUID();
  await db.query("INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,$4,'image/jpeg',10)",
    [file, f.org, `org/${f.org}/tickets/${f.ticket}/${file}.jpg`, opts.name]);
  const id = (await db.query("INSERT INTO ticket_attachments(org_id,ticket_id,file_id,is_internal,vendor_job_id,phase) VALUES($1,$2,$3,false,$4,$5) RETURNING id::text",
    [f.org, f.ticket, file, opts.vendorJob === undefined ? f.job : opts.vendorJob, opts.phase ?? null])).rows[0].id;
  if (opts.approved) await db.query("INSERT INTO repair_vendor_job_shared_photos(org_id,job_id,attachment_id,approved_by) VALUES($1,$2,$3,$4)", [f.org, f.job, id, USERS.admin]);
  return id;
}
const shareToken = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
const shares = async (ticket: string) => (await db.query("SELECT id::text,token_hash,last_copied_at,revoked_at FROM app.case_shares WHERE ticket_id=$1 ORDER BY created_at", [ticket])).rows;
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
/** The raw gateway answer (not the decoded view). */
const rawView = async (url: string) => (await db.query("SELECT app.b110_share_view($1,false) r", [hashVendorToken(shareToken(url))])).rows[0].r;
/** No-write oracle: every row of every table a B-110 path could touch. */
async function oracle() {
  const out: Record<string, string> = {};
  for (const table of ["app.case_shares", "public.audit_log", "public.files", "public.ticket_attachments"]) {
    out[table] = (await db.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return JSON.stringify(out);
}
const companyOf = async (org: string) => (await db.query("SELECT name FROM organizations WHERE id=$1", [org])).rows[0].name as string;
const H2160 = 2160 * 3600 * 1000;

test("privileges: gateways service-only, helpers unexecutable, case_shares fully revoked with RLS on", async () => {
  const gateways = ["app.b110_vendor_share(text,boolean,text,text)", "app.b110_staff_share(uuid,uuid,text,uuid,boolean,uuid,text,boolean)",
    "app.b110_staff_revoke(uuid,uuid,text,uuid,boolean,uuid)", "app.b110_share_view(text,boolean)", "app.b110_share_photo(text,boolean,uuid)"];
  const helpers = ["app.b110_enabled(uuid,boolean)", "app.b110_expires_at(app.case_shares)", "app.b110_live(app.case_shares,timestamptz)",
    "app.b110_share_for(uuid,uuid,text,uuid,uuid,text,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
      role === "service_role" && gateways.includes(signature), `${role} ${signature}`);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.case_shares',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
    }
    assert.equal((await db.query("SELECT has_any_column_privilege($1,'app.case_shares','SELECT,INSERT,UPDATE,REFERENCES') ok", [role])).rows[0].ok, false);
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.case_shares'::regclass")).rows[0].relrowsecurity, true);
  assert.equal((await db.query("SELECT to_regprocedure('app.b110_share_file(text,boolean,text,uuid)') IS NULL AS gone")).rows[0].gone, true, "no public PDF gateway");
});

test("vendor and staff eligibility: closed case with an issued or voided document, both paths; one link; copy restarts on the same URL", async () => {
  const live = await fixture(ORG_ID, "in_progress");
  await document(live, ago(1));
  const empty = await fixture();
  let before = await oracle();
  assert.deepEqual(await vendorCaseShare(live.token, "check", origin), { eligible: false }, "open case");
  await assert.rejects(vendorCaseShare(live.token, "open", origin), notFound);
  assert.deepEqual(await vendorCaseShare(empty.token, "check", origin), { eligible: false }, "closed, no document");
  await assert.rejects(vendorCaseShare(empty.token, "copy", origin), notFound);
  await assert.rejects(staffCaseShare(admin, live.ticket, true, origin), notFound, "staff: open case");
  await assert.rejects(staffCaseShare(admin, empty.ticket, true, origin), notFound, "staff: closed, no document");
  await assert.rejects(staffCaseShare(admin, empty.ticket, false, origin), notFound, "staff open: closed, no document");
  assert.equal(await oracle(), before, "no writes on any ineligible path");
  const f = await fixture();
  await document(f, ago(10));
  assert.deepEqual(await vendorCaseShare(f.token, "check", origin), { eligible: true });
  const opened = await vendorCaseShare(f.token, "open", origin) as { url: string; expiresAt: string };
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:43123\/s\/[A-Za-z0-9_-]{43}$/);
  let rows = await shares(f.ticket);
  assert.equal(rows.length, 1); assert.equal(rows[0].last_copied_at, null, "opening is not a copy");
  const copied = await vendorCaseShare(f.token, "copy", origin) as { url: string; expiresAt: string };
  assert.equal(copied.url, opened.url, "same URL");
  rows = await shares(f.ticket);
  assert.equal(new Date(copied.expiresAt).getTime(), new Date(rows[0].last_copied_at).getTime() + H2160, "copy instant + 2160 hours");
  const staff = await staffCaseShare(manager, f.ticket, true, origin);
  assert.equal(staff.url, opened.url, "staff and vendor share one link");
  assert.equal((await shares(f.ticket)).length, 1);
  const events = (await db.query("SELECT event_type,actor_role FROM audit_log WHERE table_name='case_shares' AND new_row->>'ticketId'=$1 ORDER BY id", [f.ticket])).rows;
  assert.deepEqual(events.map(e => [e.event_type, e.actor_role]), [["case_share_created", "vendor"], ["case_share_copied", "vendor"], ["case_share_copied", "staff"]]);
  before = await oracle();
});

test("expiry: exactly the latest of copy, issue and void + 2160 hours; refused at the cutoff instant; reopen moves nothing", async () => {
  const f = await fixture();
  const issuedAt = "2026-01-01T00:00:00.123Z";
  const doc = await document(f, issuedAt);
  const { url } = await vendorCaseShare(f.token, "open", origin) as { url: string; expiresAt: string };
  const expiry = async () => new Date((await vendorCaseShare(f.token, "open", origin) as { expiresAt: string }).expiresAt).getTime();
  assert.equal(await expiry(), new Date(issuedAt).getTime() + H2160, "issued + 2160h (never copied)");
  const voidedAt = "2026-02-03T04:05:06.789Z";
  await db.query("UPDATE vendor_documents SET status='voided',voided_at=$2::timestamptz,void_reason='x' WHERE id=$1", [doc, voidedAt]);
  assert.equal(await expiry(), new Date(voidedAt).getTime() + H2160, "a later void wins");
  const laterIssue = "2026-03-01T10:00:00.456Z";
  await document(f, laterIssue);
  assert.equal(await expiry(), new Date(laterIssue).getTime() + H2160, "a later issue wins");
  const copiedAt = "2026-04-01T12:00:00.001Z";
  await db.query("UPDATE app.case_shares SET last_copied_at=$2::timestamptz WHERE ticket_id=$1", [f.ticket, copiedAt]);
  assert.equal(await expiry(), new Date(copiedAt).getTime() + H2160, "a later copy wins");
  // Exact boundary with a pinned instant: at expiry itself the share is not live; 1 ms before, it is. A `<=` vs `<`
  // mistake in either direction fails one of these.
  const live = async (pinned: string) => (await db.query(`SELECT app.b110_live(s,$2::timestamptz) ok FROM app.case_shares s WHERE s.ticket_id=$1`, [f.ticket, pinned])).rows[0].ok;
  const cutoff = new Date(new Date(copiedAt).getTime() + H2160);
  assert.equal(await live(cutoff.toISOString()), false, "at the cutoff instant: expired");
  assert.equal(await live(new Date(cutoff.getTime() - 1).toISOString()), true, "1 ms before: live");
  assert.equal(await live(new Date(cutoff.getTime() + 1).toISOString()), false, "1 ms after: expired");
  await db.query("UPDATE app.case_shares SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE ticket_id=$1", [f.ticket, USERS.admin]);
  assert.equal(await live(new Date(cutoff.getTime() - 1).toISOString()), false, "revoked is never live");
  await db.query("UPDATE app.case_shares SET revoked_at=NULL,revoked_by=NULL WHERE ticket_id=$1", [f.ticket]);
  // The gateways use that same predicate with the clock.
  await db.query("UPDATE app.case_shares SET last_copied_at=clock_timestamp()-interval '2160 hours' WHERE ticket_id=$1", [f.ticket]);
  assert.deepEqual(await rawView(url), { state: "expired", company: await companyOf(ORG_ID) }, "at the cutoff");
  await db.query("UPDATE app.case_shares SET last_copied_at=clock_timestamp()-interval '2160 hours'+interval '5 seconds' WHERE ticket_id=$1", [f.ticket]);
  assert.equal((await rawView(url)).state, "ok", "just before the cutoff");
  const kept = await expiry();
  // GS-29: a reopen and close again change nothing.
  await db.query("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1", [f.ticket]);
  assert.equal((await rawView(url)).state, "ok", "a reopen keeps the link");
  await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  assert.equal(await expiry(), kept);
  // Re-copy: same URL, now + 2160 hours.
  const copied = await vendorCaseShare(f.token, "copy", origin) as { url: string; expiresAt: string };
  assert.equal(copied.url, url);
  const last = (await shares(f.ticket))[0].last_copied_at;
  assert.equal(new Date(copied.expiresAt).getTime(), new Date(last).getTime() + H2160);
});

test("revoke: staff only, closed case only; the old link reads revoked (company only); the next copy is a new link", async () => {
  // Isolation with both orgs fully admitted everywhere.
  for (const k of PLATFORM) await setPlatform(k, [ORG_ID, ORG2_ID]);
  try {
    const f = await fixture();
    await document(f, ago(1));
    const first = await vendorCaseShare(f.token, "copy", origin) as { url: string };
    const own = await fixture(ORG2_ID); await document(own, ago(1));
    assert.ok((await staffCaseShare(coast, own.ticket, true, origin)).url, "positive control: coast in its own org");
    const before = await oracle();
    await assert.rejects(staffRevokeCaseShare(accountant, f.ticket), (e: unknown) => e instanceof FlowError, "accountant");
    await assert.rejects(staffRevokeCaseShare(coast, f.ticket), (e: unknown) => e instanceof FlowError, "another org revoke");
    await assert.rejects(staffCaseShare(coast, f.ticket, true, origin), (e: unknown) => e instanceof FlowError, "another org copy");
    await assert.rejects(staffCaseShare(accountant, f.ticket, true, origin), (e: unknown) => e instanceof FlowError, "accountant copy");
    assert.equal(await oracle(), before, "no writes on denied staff paths");
    // Revoke on a reopened case is refused, with no write.
    await db.query("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1", [f.ticket]);
    const reopened = await oracle();
    await assert.rejects(staffRevokeCaseShare(admin, f.ticket), notFound, "reopened case");
    assert.equal(await oracle(), reopened, "no write on the refused revoke");
    await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
    assert.equal(await staffRevokeCaseShare(admin, f.ticket), "revoked");
    const afterRevoke = await oracle();
    assert.equal(await staffRevokeCaseShare(admin, f.ticket), "none", "idempotent");
    assert.equal(await oracle(), afterRevoke, "a second revoke writes nothing");
    assert.deepEqual(await rawView(first.url), { state: "revoked", company: await companyOf(ORG_ID) });
    const second = await vendorCaseShare(f.token, "copy", origin) as { url: string };
    assert.notEqual(second.url, first.url);
    assert.deepEqual(await rawView(first.url), { state: "revoked", company: await companyOf(ORG_ID) }, "the old one stays revoked");
    assert.equal((await rawView(second.url)).state, "ok");
    const revoked = (await db.query("SELECT event_type,actor_role,actor_user_id::text FROM audit_log WHERE table_name='case_shares' AND event_type='case_share_revoked' AND new_row->>'ticketId'=$1", [f.ticket])).rows;
    assert.deepEqual(revoked, [{ event_type: "case_share_revoked", actor_role: "staff", actor_user_id: USERS.admin }]);
  } finally { for (const k of PLATFORM) await setPlatform(k, [ORG_ID]); }
});

test("content and files: only explicitly 處理後, approved photos and document totals; every other file refused, incl. via expired / revoked links", async () => {
  const f = await fixture();
  const issued = await document(f, ago(4), { total: 5200 });
  const voided = await document(f, ago(6), { voidedAt: ago(5), total: 5300 });
  const after = await photo(f, { phase: "after", approved: true, name: "天花板_修好.jpg" });
  const untagged = await photo(f, { phase: null, approved: true, name: "untagged.jpg" });
  const before = await photo(f, { phase: "before", approved: true, name: "before.jpg" });
  const unapproved = await photo(f, { phase: "after", approved: false, name: "unapproved.jpg" });
  // An approved, 處理後-tagged photo that the tenant (not this vendor job) uploaded: only the vendor-job filter refuses it.
  const tenant = await photo(f, { vendorJob: null, phase: "after", approved: true, name: "tenant.jpg" });
  assert.deepEqual((await db.query("SELECT a.phase,a.vendor_job_id,EXISTS(SELECT 1 FROM repair_vendor_job_shared_photos sp WHERE sp.attachment_id=a.id) approved FROM ticket_attachments a WHERE a.id=$1", [tenant])).rows[0],
    { phase: "after", vendor_job_id: null, approved: true });
  const other = await fixture(); await document(other, ago(1));
  const foreign = await photo(other, { phase: "after", approved: true, name: "foreign.jpg" });
  const { url } = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  const raw = await rawView(url);
  assert.deepEqual(Object.keys(raw).sort(), ["company", "currency", "documents", "photos", "state", "status", "title", "vendor"]);
  assert.deepEqual(raw.photos, [{ id: after, name: "天花板_修好.jpg" }], "untagged, before, unapproved and tenant photos are not shown");
  const seeded = async (docId: string) => (await db.query("SELECT doc_no FROM vendor_documents WHERE id=$1", [docId])).rows[0].doc_no as string;
  assert.deepEqual(raw.documents, [
    { id: issued, kind: "completion_statement", docNo: await seeded(issued), status: "issued", totalMinor: "5200" },
    { id: voided, kind: "completion_statement", docNo: await seeded(voided), status: "voided", totalMinor: "5300" }]);
  // Only document totals: no estimate, expense, confirmed cost, buyer or tenant data.
  assert.doesNotMatch(JSON.stringify(raw), /林雅婷|0912|內部備註|description|buyer|receipt_title|phone|estimate|expense|cost|items|unit_price/);
  const token = shareToken(url);
  assert.match(String((await loadSharePhoto(token, after))?.storage_path), new RegExp(`^org/${f.org}/tickets/${f.ticket}/`));
  for (const [label, id] of [["untagged", untagged], ["before", before], ["unapproved", unapproved], ["tenant", tenant], ["foreign", foreign],
    ["document id", issued], ["random", randomUUID()]] as const) assert.equal(await loadSharePhoto(token, id), null, label);
  // The real public photo handler: bytes for the approved photo, 404 for every refused kind, and storage is
  // asked only for the approved one.
  storageHits.length = 0;
  const get = (photoId: string, shareTok = token) => photoRoute(new Request(`${origin}/s/${shareTok}/photos/${photoId}`), { params: Promise.resolve({ token: shareTok, id: photoId }) });
  const okResponse = await get(after);
  assert.equal(okResponse.status, 200); assert.equal(okResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await okResponse.arrayBuffer()), JPEG);
  for (const [label, photoId] of [["untagged", untagged], ["before", before], ["unapproved", unapproved], ["tenant", tenant], ["foreign", foreign],
    ["document id", issued], ["random", randomUUID()], ["not a uuid", "x"]] as const) {
    const refused = await get(photoId);
    assert.equal(refused.status, 404, label); assert.equal(refused.headers.get("cache-control"), "private, no-store", label);
  }
  assert.equal((await get(after, randomBytes(32).toString("base64url"))).status, 404, "unknown share link");
  assert.equal(storageHits.length, 1, "storage is read only for the approved photo");
  // The legacy document URL is gone: no route module exists for /s/[token]/documents/[id].
  assert.equal(existsSync("src/app/s/[token]/documents"), false);
  await assert.rejects(import("../app/s/[token]/documents/[id]/route" as string));
  // No public PDF anywhere.
  const html = renderToStaticMarkup(await CaseSharePage({ params: Promise.resolve({ token }) }) as React.ReactElement);
  for (const text of ["分享的唯讀頁", "浴室天花板滴水", "已完成", "王師傅水電", "已准許的照片", "天花板_修好.jpg", "完工明細 CMP-", "已作廢", "NT$5,200", "NT$5,300", "<s>"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<button|林雅婷|untagged|before\.jpg|tenant\.jpg|unapproved|\/documents\/|\.pdf|href="\/login/);
  // An expired link serves nothing: a case whose only document is far older than 2160 hours, never copied.
  const g = await fixture(); await document(g, "2025-01-01T00:00:00Z");
  const old = await photo(g, { phase: "after", approved: true, name: "old.jpg" });
  const stale = await vendorCaseShare(g.token, "open", origin) as { url: string };
  const before0 = await oracle();
  assert.deepEqual(await rawView(stale.url), { state: "expired", company: await companyOf(ORG_ID) });
  assert.equal(await loadSharePhoto(shareToken(stale.url), old), null, "expired link");
  assert.equal((await get(old, shareToken(stale.url))).status, 404, "expired link through the handler");
  for (const id of [after, untagged, before, unapproved, tenant, foreign]) await loadSharePhoto(token, id);
  assert.equal(await oracle(), before0, "file reads never write");
  // A revoked link serves nothing.
  await staffRevokeCaseShare(admin, f.ticket);
  assert.equal(await loadSharePhoto(token, after), null, "revoked link");
  assert.equal((await get(after)).status, 404, "revoked link through the handler");
  assert.deepEqual(await rawView(url), { state: "revoked", company: await companyOf(ORG_ID) });
});

test("denials with no writes anywhere: bad bearers, revoked or expired job links, other orgs, every gate; vendor_job_v3 off leaves staff and public", async () => {
  const f = await fixture();
  await document(f, ago(1));
  let { url } = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  let token = shareToken(url);
  const okPhoto = await photo(f, { phase: "after", approved: true, name: "ok.jpg" });
  const before = await oracle();
  for (const bearer of [f.token, randomBytes(32).toString("base64url")]) {
    assert.equal(await loadShareView(bearer), null);
    await assert.rejects(CaseSharePage({ params: Promise.resolve({ token: bearer }) }), (e: unknown) => String((e as { digest?: string }).digest).includes("404"));
    assert.equal(await loadSharePhoto(bearer, okPhoto), null);
  }
  await assert.rejects(vendorCaseShare(token, "copy", origin), notFound, "a share link is not a job link");
  await assert.rejects(vendorCaseShare(token, "check", origin), notFound, "a share link is not a job link (check)");
  assert.equal(await oracle(), before, "bad bearers and share-as-job write nothing, in any table");
  const revokedJob = await fixture(); await document(revokedJob, ago(1));
  await db.query("UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [revokedJob.job]);
  const expiredJob = await fixture(); await document(expiredJob, ago(1));
  await db.query("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiredJob.job]);
  const foreign = await fixture(ORG2_ID); await document(foreign, ago(1));
  const snapshot = await oracle();
  await assert.rejects(vendorCaseShare(revokedJob.token, "copy", origin), notFound, "revoked job link");
  await assert.rejects(vendorCaseShare(expiredJob.token, "check", origin), notFound, "expired job link");
  await assert.rejects(vendorCaseShare(foreign.token, "copy", origin), notFound, "another org");
  await assert.rejects(staffCaseShare(coast, foreign.ticket, true, origin), notFound, "another org's staff, org off the allowlists");
  assert.equal(await oracle(), snapshot, "no writes");
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ...PLATFORM.map(k => [`platform ${k} off`, () => setPlatform(k, [ORG_ID], false), () => setPlatform(k, [ORG_ID])] as [string, () => Promise<unknown>, () => Promise<unknown>]),
    ...Object.keys(ORG_FLAGS).filter(k => k !== "brand_v2").map(k => [`org ${k} off`, () => orgFlags(ORG_ID, { [k]: false }), () => orgFlags(ORG_ID, { [k]: true })] as [string, () => Promise<unknown>, () => Promise<unknown>]),
  ];
  for (const [label, off, on] of gates) {
    await off();
    try {
      const mark = await oracle();
      await assert.rejects(vendorCaseShare(f.token, "copy", origin), notFound, `${label}: vendor`);
      if (label.includes("vendor_job_v3")) {
        // Only the B-105 vendor case is off: the vendor refusal writes nothing; staff and the public link still work.
        assert.equal(await oracle(), mark, `${label}: the vendor refusal writes nothing`);
        assert.equal((await rawView(url)).state, "ok", `${label}: public`);
        assert.ok(await loadSharePhoto(token, okPhoto), `${label}: photo`);
        assert.equal(await oracle(), mark, `${label}: public reads write nothing`);
        assert.equal((await staffCaseShare(admin, f.ticket, false, origin)).url, url, `${label}: staff open`);
        const copied = await staffCaseShare(admin, f.ticket, true, origin);
        assert.equal(copied.url, url, `${label}: staff copy keeps the URL`);
        assert.ok((await shares(f.ticket)).at(-1)!.last_copied_at, `${label}: staff copy recorded`);
        assert.equal(await staffRevokeCaseShare(admin, f.ticket), "revoked", `${label}: staff revoke`);
        assert.deepEqual(await rawView(url), { state: "revoked", company: await companyOf(ORG_ID) }, `${label}: revoked`);
        // Re-issue a link for the remaining gates (staff copy after revoke makes a new one).
        url = (await staffCaseShare(admin, f.ticket, true, origin)).url;
        token = shareToken(url);
      } else {
        assert.equal(await loadShareView(token), null, `${label}: public`);
        assert.equal(await loadSharePhoto(token, okPhoto), null, `${label}: photo`);
        await assert.rejects(staffCaseShare(admin, f.ticket, true, origin), notFound, `${label}: staff copy`);
        await assert.rejects(staffRevokeCaseShare(admin, f.ticket), notFound, `${label}: staff revoke`);
        assert.equal(await oracle(), mark, `${label}: no writes`);
      }
    } finally { await on(); }
  }
  assert.equal((await rawView(url)).state, "ok", "restored");
  assert.equal(JSON.parse(await oracle())["public.files"], JSON.parse(before)["public.files"], "no file rows written by any denial");
});

test("vendor route: same origin, small JSON, check / open / copy; rejected requests write nothing", async () => {
  const f = await fixture();
  await document(f, ago(1));
  const post = (body: unknown, headers: Record<string, string> = {}) => shareRoute(new Request(`${origin}/api/vendor-jobs/case-share`, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin, "content-type": "application/json", ...headers } }));
  const before = await oracle();
  assert.equal((await post({ token: f.token, mode: "revoke" })).status, 400);
  assert.equal((await post({ token: f.token, mode: "copy" }, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post({ token: f.token, mode: "copy" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ token: f.token, mode: "copy", pad: "x".repeat(2000) })).status, 413);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ token: randomBytes(32).toString("base64url"), mode: "copy" })).status, 404);
  assert.deepEqual(await (await post({ token: f.token, mode: "check" })).json(), { eligible: true });
  assert.equal(await oracle(), before, "no writes from rejected requests or the check");
  const opened = await (await post({ token: f.token, mode: "open" })).json();
  assert.match(opened.url, /\/s\//);
  const auditCount = async () => (await db.query("SELECT count(*)::int n FROM audit_log WHERE table_name='case_shares' AND event_type='case_share_copied' AND new_row->>'ticketId'=$1", [f.ticket])).rows[0].n as number;
  const copies = await auditCount();
  const copyResponse = await post({ token: f.token, mode: "copy" });
  assert.equal(copyResponse.status, 200);
  const copied = await copyResponse.json();
  assert.equal(copied.url, opened.url, "the copy keeps the same URL");
  const row = (await shares(f.ticket))[0];
  assert.ok(row.last_copied_at, "last_copied_at recorded");
  assert.equal(new Date(copied.expiresAt).getTime(), new Date(row.last_copied_at).getTime() + H2160, "expiry restarted from this copy");
  assert.ok(new Date(copied.expiresAt).getTime() > new Date(opened.expiresAt).getTime(), "later than the opened expiry");
  assert.equal(await auditCount(), copies + 1, "one copy audit row");
  const expired = renderToStaticMarkup(await SharePage({ locale: "zh-TW", token: "t".repeat(43), view: { state: "expired", company: "安居物業" } }) as React.ReactElement);
  assert.ok(expired.includes("這個分享已過期") && expired.includes("這個連結已過期，文件內容不會再顯示。需要的話請聯絡安居物業。") && expired.includes('data-v3-illustration="26"'));
  assert.doesNotMatch(expired, /<button|<a /);
});
