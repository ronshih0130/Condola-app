import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import CaseSharePage from "../app/s/[token]/page";
import { POST as shareRoute } from "../app/api/vendor-jobs/case-share/route";
import { SharePage } from "../components/v3/share/share-page";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { loadShareFile, loadShareView, staffCaseShare, staffRevokeCaseShare, vendorCaseShare, type ShareView } from "./b110-case-share";
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

test.before(async () => {
  (globalThis as Record<string, unknown>).React ??= React;
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
test.after(async () => { try { if (db) await db.end(); } finally { await clone?.cleanup(); } });

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
async function writes(ticket: string) {
  return JSON.stringify({ shares: await shares(ticket),
    audit: (await db.query("SELECT count(*)::int n FROM audit_log WHERE table_name='case_shares' AND new_row->>'ticketId'=$1", [ticket])).rows[0].n });
}
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const view = async (url: string) => loadShareView(shareToken(url)) as Promise<ShareView>;

test("privileges: gateways service-only, helpers unexecutable, case_shares fully revoked with RLS on", async () => {
  const gateways = ["app.b110_vendor_share(text,boolean,text,text)", "app.b110_staff_share(uuid,uuid,text,uuid,boolean,uuid,text,boolean)",
    "app.b110_staff_revoke(uuid,uuid,text,uuid,boolean,uuid)", "app.b110_share_view(text,boolean)", "app.b110_share_file(text,boolean,text,uuid)"];
  const helpers = ["app.b110_enabled(uuid,boolean)", "app.b110_expires_at(app.case_shares)", "app.b110_share_for(uuid,uuid,text,uuid,uuid,text,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
      role === "service_role" && gateways.includes(signature), `${role} ${signature}`);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.case_shares',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
    }
    assert.equal((await db.query("SELECT has_any_column_privilege($1,'app.case_shares','SELECT,INSERT,UPDATE,REFERENCES') ok", [role])).rows[0].ok, false);
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.case_shares'::regclass")).rows[0].relrowsecurity, true);
});

test("vendor: eligible only once closed with a document; open makes one link; each copy restarts 90 days on the same URL", async () => {
  const open = await fixture(ORG_ID, "in_progress");
  await document(open, ago(1));
  assert.deepEqual(await vendorCaseShare(open.token, "check", origin), { eligible: false }, "open case");
  await assert.rejects(vendorCaseShare(open.token, "open", origin), notFound);
  const f = await fixture();
  assert.deepEqual(await vendorCaseShare(f.token, "check", origin), { eligible: false }, "closed, no document");
  await assert.rejects(vendorCaseShare(f.token, "copy", origin), notFound);
  assert.deepEqual(await shares(f.ticket), []);
  await document(f, ago(10));
  assert.deepEqual(await vendorCaseShare(f.token, "check", origin), { eligible: true });
  assert.deepEqual(await shares(f.ticket), [], "check never writes");
  const opened = await vendorCaseShare(f.token, "open", origin) as { url: string; expiresAt: string };
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:43123\/s\/[A-Za-z0-9_-]{43}$/);
  let rows = await shares(f.ticket);
  assert.equal(rows.length, 1); assert.equal(rows[0].last_copied_at, null, "opening is not a copy");
  assert.equal(rows[0].token_hash, hashVendorToken(shareToken(opened.url)));
  const copied = await vendorCaseShare(f.token, "copy", origin) as { url: string; expiresAt: string };
  assert.equal(copied.url, opened.url, "same URL");
  rows = await shares(f.ticket);
  assert.ok(rows[0].last_copied_at);
  assert.ok(Math.abs(new Date(copied.expiresAt).getTime() - (new Date(rows[0].last_copied_at).getTime() + 90 * 86400000)) < 1000);
  const again = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  assert.equal(again.url, opened.url);
  assert.equal((await shares(f.ticket)).length, 1);
  const events = (await db.query("SELECT event_type,actor_role FROM audit_log WHERE table_name='case_shares' AND new_row->>'ticketId'=$1 ORDER BY id", [f.ticket])).rows;
  assert.deepEqual(events.map(e => [e.event_type, e.actor_role]), [["case_share_created", "vendor"], ["case_share_copied", "vendor"], ["case_share_copied", "vendor"]]);
});

test("90 days from the later of the last copy and the last document issued or voided; reopen alone changes nothing", async () => {
  const f = await fixture();
  const doc = await document(f, ago(100));
  const { url } = await vendorCaseShare(f.token, "open", origin) as { url: string };
  assert.equal((await view(url)).state, "expired", "only a 100-day-old document, never copied");
  await db.query("UPDATE app.case_shares SET last_copied_at=$2::timestamptz WHERE ticket_id=$1", [f.ticket, ago(89.99)]);
  assert.equal((await view(url)).state, "ok", "copied 89.99 days ago");
  await db.query("UPDATE app.case_shares SET last_copied_at=$2::timestamptz WHERE ticket_id=$1", [f.ticket, ago(90.001)]);
  assert.equal((await view(url)).state, "expired", "the 90th day has passed");
  // A void later than the last copy restarts the clock from the void.
  await db.query("UPDATE vendor_documents SET status='voided',voided_at=$2::timestamptz,void_reason='x' WHERE id=$1", [doc, ago(5)]);
  assert.equal((await view(url)).state, "ok", "voided 5 days ago");
  // A document issued later than everything else also counts.
  await db.query("UPDATE vendor_documents SET voided_at=$2::timestamptz WHERE id=$1", [doc, ago(95)]);
  assert.equal((await view(url)).state, "expired");
  await document(f, ago(3));
  assert.equal((await view(url)).state, "ok", "issued 3 days ago");
  const before = (await vendorCaseShare(f.token, "open", origin) as { expiresAt: string }).expiresAt;
  // GS-29: reopening and closing again moves nothing.
  await db.query("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1", [f.ticket]);
  assert.equal((await view(url)).state, "ok", "a reopen keeps the link");
  await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [f.ticket]);
  assert.equal((await vendorCaseShare(f.token, "open", origin) as { expiresAt: string }).expiresAt, before);
  // Copy again: same URL, now + 90 days.
  const copied = await vendorCaseShare(f.token, "copy", origin) as { url: string; expiresAt: string };
  assert.equal(copied.url, url);
  assert.ok(new Date(copied.expiresAt).getTime() > Date.now() + 89.9 * 86400000);
});

test("revoke: the old link shows 「這個分享已撤銷」; the next copy makes a new link; staff roles and orgs are checked", async () => {
  const f = await fixture();
  await document(f, ago(1));
  const first = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  const staffOpen = await staffCaseShare(manager, f.ticket, false, origin);
  assert.equal(staffOpen.url, first.url, "staff and vendor share one link per case");
  const before = await writes(f.ticket);
  await assert.rejects(staffRevokeCaseShare(accountant, f.ticket), (e: unknown) => e instanceof FlowError, "accountant");
  await assert.rejects(staffRevokeCaseShare(coast, f.ticket), (e: unknown) => e instanceof FlowError, "another org");
  await assert.rejects(staffCaseShare(coast, f.ticket, true, origin), (e: unknown) => e instanceof FlowError, "another org copy");
  assert.equal(await writes(f.ticket), before, "no writes on denied staff paths");
  assert.equal(await staffRevokeCaseShare(admin, f.ticket), "revoked");
  assert.equal(await staffRevokeCaseShare(admin, f.ticket), "none", "idempotent");
  assert.deepEqual(await view(first.url), { state: "revoked", company: (await db.query("SELECT name FROM organizations WHERE id=$1", [ORG_ID])).rows[0].name });
  const second = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  assert.notEqual(second.url, first.url, "a copy after revoke makes a new link");
  assert.equal((await view(first.url)).state, "revoked", "the old one stays revoked");
  assert.equal((await view(second.url)).state, "ok");
  const staffCopy = await staffCaseShare(admin, f.ticket, true, origin);
  assert.equal(staffCopy.url, second.url);
  const events = (await db.query("SELECT event_type,actor_role,actor_user_id::text FROM audit_log WHERE table_name='case_shares' AND event_type='case_share_revoked' AND new_row->>'ticketId'=$1", [f.ticket])).rows;
  assert.deepEqual(events, [{ event_type: "case_share_revoked", actor_role: "staff", actor_user_id: USERS.admin }]);
  // Staff need a closed case.
  const live = await fixture(ORG_ID, "in_progress");
  await assert.rejects(staffCaseShare(admin, live.ticket, true, origin), notFound);
  assert.deepEqual(await shares(live.ticket), []);
});

test("content: approved 處理後 photos and issued / voided documents only; no buyer, tenant, note or cost", async () => {
  const f = await fixture();
  const issued = await document(f, ago(4), { total: 5200 });
  const voided = await document(f, ago(6), { voidedAt: ago(5), total: 5300 });
  const after = await photo(f, { phase: "after", approved: true, name: "天花板_修好.jpg" });
  const legacy = await photo(f, { phase: null, approved: true, name: "防水層.jpg" });
  await photo(f, { phase: "before", approved: true, name: "before.jpg" });
  await photo(f, { phase: "after", approved: false, name: "unapproved.jpg" });
  await photo(f, { vendorJob: null, approved: true, name: "tenant.jpg" });
  const { url } = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  const v = await view(url);
  assert.equal(v.state, "ok");
  if (v.state !== "ok") return;
  assert.deepEqual(v.photos.map(p => p.id), [after, legacy]);
  assert.deepEqual(v.documents.map(d => [d.id, d.status, d.totalMinor]), [[issued, "issued", "5200"], [voided, "voided", "5300"]]);
  assert.equal(v.vendor, "王師傅水電"); assert.equal(v.title, "浴室天花板滴水"); assert.equal(v.status, "closed");
  const raw = (await db.query("SELECT app.b110_share_view($1,false) r", [hashVendorToken(shareToken(url))])).rows[0].r;
  assert.deepEqual(Object.keys(raw).sort(), ["company", "currency", "documents", "photos", "state", "status", "title", "vendor"]);
  for (const doc of raw.documents) assert.deepEqual(Object.keys(doc).sort(), ["docNo", "id", "kind", "status", "totalMinor"]);
  assert.doesNotMatch(JSON.stringify(raw), /林雅婷|0912|内部|內部備註|description|buyer|receipt_title|phone|before\.jpg|tenant\.jpg|unapproved/);
  // Files: approved photo path and stored PDF; anything else is not served.
  assert.match(String((await loadShareFile(shareToken(url), "photo", after))?.storage_path), new RegExp(`^org/${f.org}/tickets/${f.ticket}/`));
  assert.ok((await loadShareFile(shareToken(url), "document", voided))?.pdf);
  for (const [kind, id] of [["photo", voided], ["document", after], ["photo", randomUUID()]] as const) assert.equal(await loadShareFile(shareToken(url), kind, id), null);
  const other = await fixture();
  const foreignDoc = await document(other, ago(1));
  assert.equal(await loadShareFile(shareToken(url), "document", foreignDoc), null, "another case's document");
  // The page renders exactly this, with no button and no buyer.
  const html = renderToStaticMarkup(await CaseSharePage({ params: Promise.resolve({ token: shareToken(url) }) }) as React.ReactElement);
  for (const text of ["分享的唯讀頁", "浴室天花板滴水", "已完成", "王師傅水電", "已准許的照片", "天花板_修好.jpg", "完工明細 CMP-", "已作廢", "NT$5,200", "<s>"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<button|林雅婷|before\.jpg|tenant\.jpg|unapproved|href="\/login/);
  assert.ok(html.indexOf(issued) < html.indexOf(voided), "voided last");
});

test("denials with no writes: link revoked or expired, foreign or job tokens as share links, other orgs, every gate off", async () => {
  const f = await fixture();
  await document(f, ago(1));
  const { url } = await vendorCaseShare(f.token, "copy", origin) as { url: string };
  const before = await writes(f.ticket);
  // A job link or a random bearer is not a share link.
  for (const bearer of [f.token, randomBytes(32).toString("base64url")]) {
    assert.equal(await loadShareView(bearer), null);
    await assert.rejects(CaseSharePage({ params: Promise.resolve({ token: bearer }) }), (e: unknown) => String((e as { digest?: string }).digest).includes("404"));
  }
  // The share link is not a job link.
  await assert.rejects(vendorCaseShare(shareToken(url), "copy", origin), notFound);
  // Revoked / expired job link: no vendor share.
  const revokedJob = await fixture(); await document(revokedJob, ago(1));
  await db.query("UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [revokedJob.job]);
  await assert.rejects(vendorCaseShare(revokedJob.token, "copy", origin), notFound);
  const expiredJob = await fixture(); await document(expiredJob, ago(1));
  await db.query("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiredJob.job]);
  await assert.rejects(vendorCaseShare(expiredJob.token, "check", origin), notFound);
  assert.deepEqual([...await shares(revokedJob.ticket), ...await shares(expiredJob.ticket)], []);
  // Another org (not allowlisted): nothing.
  const foreign = await fixture(ORG2_ID); await document(foreign, ago(1));
  await assert.rejects(vendorCaseShare(foreign.token, "copy", origin), notFound);
  assert.deepEqual(await shares(foreign.ticket), []);
  // Each gate alone off: the vendor is refused and the existing link reads as no share at all.
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ...PLATFORM.map(k => [`platform ${k} off`, () => setPlatform(k, [ORG_ID], false), () => setPlatform(k, [ORG_ID])] as [string, () => Promise<unknown>, () => Promise<unknown>]),
    ...Object.keys(ORG_FLAGS).filter(k => k !== "brand_v2").map(k => [`org ${k} off`, () => orgFlags(ORG_ID, { [k]: false }), () => orgFlags(ORG_ID, { [k]: true })] as [string, () => Promise<unknown>, () => Promise<unknown>]),
  ];
  for (const [label, off, on] of gates) {
    await off();
    try {
      await assert.rejects(vendorCaseShare(f.token, "copy", origin), notFound, label);
      if (!label.includes("vendor_job_v3")) assert.equal(await loadShareView(shareToken(url)), null, label);
      if (!label.includes("vendor_job_v3")) assert.equal(await loadShareFile(shareToken(url), "document", (await db.query("SELECT id::text FROM vendor_documents WHERE ticket_id=$1 LIMIT 1", [f.ticket])).rows[0].id), null, label);
      if (!label.includes("vendor_job_v3")) await assert.rejects(staffCaseShare(admin, f.ticket, true, origin), notFound, label);
    } finally { await on(); }
  }
  assert.equal(await writes(f.ticket), before, "no writes on any denied path");
  assert.equal((await view(url)).state, "ok", "restored");
});

test("vendor route: same origin, small JSON, check / open / copy; other modes and bodies refused", async () => {
  const f = await fixture();
  await document(f, ago(1));
  const post = (body: unknown, headers: Record<string, string> = {}) => shareRoute(new Request(`${origin}/api/vendor-jobs/case-share`, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin, "content-type": "application/json", ...headers } }));
  assert.deepEqual(await (await post({ token: f.token, mode: "check" })).json(), { eligible: true });
  const opened = await (await post({ token: f.token, mode: "open" })).json();
  assert.match(opened.url, /\/s\//);
  assert.equal((await post({ token: f.token, mode: "revoke" })).status, 400);
  assert.equal((await post({ token: f.token, mode: "copy" }, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post({ token: f.token, mode: "copy", pad: "x".repeat(2000) })).status, 413);
  assert.equal((await post({ token: randomBytes(32).toString("base64url"), mode: "copy" })).status, 404);
  const view = await SharePage({ locale: "zh-TW", token: "t".repeat(43), view: { state: "expired", company: "安居物業" } }) as React.ReactElement;
  const expired = renderToStaticMarkup(view);
  assert.ok(expired.includes("這個分享已過期") && expired.includes("這個連結已過期，文件內容不會再顯示。需要的話請聯絡安居物業。") && expired.includes('data-v3-illustration="26"'));
  assert.doesNotMatch(expired, /<button|<a /);
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
});
