import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createVendorDocumentInvite, type StoredVendorDocument } from "./vendor-receipt";
import { recordReceived, receivedSummary, vendorDocumentContext, vendorDocumentsEnabled } from "./vendor-documents-gate";
import { PHOTO_BUCKET } from "./repair-rules";
import type { Session } from "./types";
import { POST } from "../app/api/vendor-documents/route";
import { POST as PDF } from "../app/api/vendor-documents/pdf/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
const envKeys = ["APP_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
const seal = readFileSync(new URL("../../public/favicon-32x32.png", import.meta.url));
// Actual loopback HTTP asset server: no external provider, fetch or DB mocks.
const sealPaths = new Set<string>();
const assets = createServer((req, res) => {
  if (req.url === "/fonts/DroidSansFallback-subset.ttf") res.end(font);
  else if (sealPaths.has(req.url ?? "")) res.end(seal);
  else { res.statusCode = 404; res.end(); }
});

test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  await new Promise<void>((resolve) => assets.listen(0, "127.0.0.1", resolve));
  const address = assets.address(); assert.ok(address && typeof address !== "string");
  process.env.APP_URL = process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-only";
});
test.after(async () => {
  await new Promise<void>((resolve, reject) => assets.close((error) => error ? reject(error) : resolve()));
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  await db?.end(); await clone?.cleanup();
});

async function flag(on: boolean) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='vendor_documents'`, [on, ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('vendor_documents',$1::boolean) WHERE id=$2`, [on, ORG_ID]);
}
async function fixture() {
  const property = (await db.query(`SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL AND address_display IS NOT NULL LIMIT 1`, [ORG_ID])).rows[0].id;
  const owner = (await db.query(`INSERT INTO contacts(org_id,is_owner,display_name,receipt_title,email) VALUES($1,true,'PRIVATE OWNER','Owner supplied title','private@example.invalid') RETURNING id`, [ORG_ID])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)`, [ORG_ID, property, owner]);
  const contact = (await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'Vendor fixture') RETURNING id`, [ORG_ID])).rows[0].id;
  const file = randomUUID(), sealPath = `org/${ORG_ID}/tickets/${randomUUID()}/${file}.png`;
  sealPaths.add(`/storage/v1/object/${PHOTO_BUCKET}/${sealPath}`);
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,'seal.png','image/png',$5)`, [file, ORG_ID, PHOTO_BUCKET, sealPath, seal.length]);
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    VALUES($1,$2,'B025','business','Vendor fixture','Business','Representative','04595257','+12025550125','Address',now(),$3) RETURNING id`, [ORG_ID, contact, file])).rows[0].id;
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    SELECT org_id,id,1,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id FROM vendor_profiles WHERE id=$1`, [profile]);
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','Fixture repair',$3,'TWD',120000,'{"pricing":{"mode":"lump_sum"}}') RETURNING id`, [ORG_ID, property, contact])).rows[0].id;
  await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id)
    VALUES($1,$2,'Fixture','+12025550125','Fixture',$3,now()+interval '1 day',$4,$5)`, [ORG_ID, ticket, randomUUID().replaceAll("-", "").padEnd(64, "0"), USERS.admin, contact]);
  const admin: Session = { userId: USERS.admin, sessionId: "b025", email: "fixture@example.invalid", name: "Fixture", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
  const invite = await createVendorDocumentInvite(admin, ticket, profile, { kind: "owner", contactId: owner });
  return { ticket, profile, owner, grant: invite.grantId, token: invite.url.split("/").at(-1)! };
}
function request(fields: Record<string, unknown>, pdf = false, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/vendor-documents${pdf ? "/pdf" : ""}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(fields),
  });
}
const issueFields = { action: "issue", kind: "receipt", documentDate: "2026-01-01" };
async function issue(token: string, extra: Record<string, unknown> = {}) {
  return POST(request({ token, ...issueFields, idempotencyKey: randomUUID(), ...extra }));
}
async function raw(sql: string, values: unknown[] = [], role = "service_role") {
  await db.query("BEGIN");
  try { await db.query(`SET LOCAL ROLE ${role}`); const result = await db.query(sql, values); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; }
}
function pgCode(code: string) { return (error: unknown) => (error as { code?: string }).code === code; }

test("B-025 token routes, payment gate, lifecycle and privilege boundaries", async (t) => {
  const f = await fixture(), other = await fixture();
  await t.test("OFF and malformed flags fail closed before action validation and write nothing", async () => {
    await flag(false);
    for (const value of [null, { enabled: false, allowed_org_ids: [ORG_ID] }, { enabled: "true", allowed_org_ids: [ORG_ID] }, { enabled: true, allowed_org_ids: ORG_ID }, { enabled: true, allowed_org_ids: [] }]) {
      await db.query("UPDATE platform_settings SET value=$1 WHERE key='vendor_documents'", [JSON.stringify(value)]);
      assert.equal(await vendorDocumentsEnabled(db, ORG_ID), false);
      assert.equal((await db.query("SELECT app.b025_flag_on($1) enabled", [ORG_ID])).rows[0].enabled, false);
      assert.equal(await vendorDocumentContext(f.token), null);
      for (const handler of [POST, PDF]) {
        const response = await handler(request({ token: f.token, action: "invalid" }));
        assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: "not_found" });
      }
      await assert.rejects(raw("SELECT app.b025_record_received($1,$2,$3,10)", [ORG_ID, f.grant, randomUUID()]), pgCode("42501"));
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b025_received_marks")).rows[0].n, 0);
    await flag(true);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"vendor_documents":"true"}'::jsonb WHERE id=$1`, [ORG_ID]);
    assert.equal(await vendorDocumentsEnabled(db, ORG_ID), false);
    assert.equal((await db.query("SELECT app.b025_flag_on($1) enabled", [ORG_ID])).rows[0].enabled, false);
    await flag(true);
    assert.equal((await POST(request({ token: "invalid", action: "issue" }))).status, 404);
    assert.equal((await POST(request({ action: "context" }))).status, 404);
    assert.equal((await POST(request({ token: f.token, action: "context" }, false, { origin: "https://evil.invalid" }))).status, 403);
    assert.equal((await POST(request({}, false, { "content-type": "text/plain" }))).status, 415);
  });
  await t.test("context reveals only buyer kind/title presence; preview consumes no number", async () => {
    const context = await vendorDocumentContext(f.token); assert.ok(context);
    assert.equal(context.totalMinor, "1200"); assert.equal(context.receivedMinor, "0");
    assert.deepEqual(context.buyer, { kind: "owner", titlePresent: true });
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE OWNER|private@example|Owner supplied title/);
    const before = (await db.query("SELECT next_seq FROM vendor_issuers WHERE tax_id='04595257'")).rows[0].next_seq;
    const preview = await POST(request({ token: f.token, ...issueFields, action: "preview" }));
    assert.equal(preview.status, 200); assert.equal((await preview.json()).document.seq, 0);
    assert.equal((await db.query("SELECT next_seq FROM vendor_issuers WHERE tax_id='04595257'")).rows[0].next_seq, before);
    assert.equal((await db.query("SELECT count(*)::int n FROM vendor_documents WHERE ticket_id=$1", [f.ticket])).rows[0].n, 0);
  });
  let first: StoredVendorDocument;
  await t.test("completion first; partial blocks receipt; full allows; retries and scopes", async () => {
    assert.equal((await issue(f.token, { kind: "completion_statement" })).status, 200);
    const requestId = randomUUID();
    const results = await Promise.all([recordReceived(f.token, { requestId, amountMinor: "500" }), recordReceived(f.token, { requestId, amountMinor: "500" })]);
    assert.equal(results[0].id, results[1].id);
    await assert.rejects(recordReceived(f.token, { requestId, amountMinor: "501" }));
    await assert.rejects(recordReceived(other.token, { requestId, amountMinor: "500" }));
    assert.equal((await receivedSummary(other.token)).receivedMinor, "0");
    for (const amountMinor of ["0", "-1", "1.2", "9223372036854775808"]) await assert.rejects(recordReceived(f.token, { requestId: randomUUID(), amountMinor }));
    const blocked = await issue(f.token); assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: "receipt_requires_full_payment" });
    // Caller-supplied scope identifiers are never used to target another grant.
    await POST(request({ token: other.token, action: "mark_received", grantId: f.grant, ticketId: f.ticket, requestId: randomUUID(), amountMinor: "1" }));
    assert.equal((await receivedSummary(f.token)).receivedMinor, "500");
    await recordReceived(f.token, { requestId: randomUUID(), amountMinor: "700" });
    const response = await issue(f.token); assert.equal(response.status, 200); first = await response.json();
    assert.equal(first.document.kind, "receipt");
    assert.equal((await PDF(request({ token: other.token, documentId: first.document.id }, true))).status, 404);
    assert.equal((await POST(request({ token: other.token, action: "void", documentId: first.document.id, reason: "Other issuer" }))).status, 404);
    assert.equal((await vendorDocumentContext(other.token))!.documents.length, 0);
  });
  await t.test("void/reissue keeps immutable PDF bytes and advances number", async () => {
    const pdf = await PDF(request({ token: f.token, documentId: first.document.id }, true));
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("cache-control"), "no-store");
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const original = Buffer.from(await pdf.arrayBuffer()); assert.equal(original.subarray(0, 4).toString(), "%PDF");
    assert.equal((await POST(request({ token: f.token, action: "void", documentId: first.document.id, reason: "Correction" }))).status, 200);
    const replacement = await issue(f.token, { action: "reissue", documentId: first.document.id });
    assert.equal(replacement.status, 200); const next: StoredVendorDocument = await replacement.json();
    assert.ok(next.document.seq > first.document.seq); assert.notEqual(next.document.doc_no, first.document.doc_no);
    assert.equal(next.document.reissued_from, first.document.id);
    const old = await PDF(request({ token: f.token, documentId: first.document.id }, true));
    assert.deepEqual(Buffer.from(await old.arrayBuffer()), original);
  });
  await t.test("one-step mark+issue is atomic and idempotent", async () => {
    const next = await fixture();
    const received = { requestId: randomUUID(), amountMinor: "1200" }, idempotencyKey = randomUUID();
    const bad = await issue(next.token, { received, documentDate: "bad", idempotencyKey });
    assert.equal(bad.status, 400); assert.equal((await receivedSummary(next.token)).receivedMinor, "0");
    const a = await issue(next.token, { received, idempotencyKey }); assert.equal(a.status, 200);
    const b = await issue(next.token, { received, idempotencyKey }); assert.equal(b.status, 200);
    assert.equal((await a.json()).document.id, (await b.json()).document.id);
    assert.equal((await receivedSummary(next.token)).receivedMinor, "1200");
    assert.equal((await receivedSummary(next.token)).marks.length, 1);
  });
  await t.test("DB enforcement, exact bigint, revocation/expiry, private append-only ACL", async () => {
    const next = await fixture();
    const insert = `INSERT INTO vendor_documents(org_id,vendor_profile_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,idempotency_key)
      VALUES($1,$2,$3,'receipt',99,$4,'{}','[]',$5,$4)`;
    const amount = "9007199254740993";
    await recordReceived(next.token, { requestId: randomUUID(), amountMinor: "9007199254740992" });
    await assert.rejects(raw(insert, [ORG_ID, next.profile, next.ticket, randomUUID(), amount]), pgCode("23514"));
    await recordReceived(next.token, { requestId: randomUUID(), amountMinor: "1" });
    assert.equal((await receivedSummary(next.token)).receivedMinor, amount);
    await raw(insert, [ORG_ID, next.profile, next.ticket, randomUUID(), amount]);
    await assert.rejects(raw("SELECT app.b025_record_received($1,$2,$3,1)", [ORG2_ID, next.grant, randomUUID()]), pgCode("42501"));
    await db.query("UPDATE vendor_document_grants SET revoked_at=now() WHERE id=$1", [next.grant]);
    assert.equal((await POST(request({ token: next.token, action: "context" }))).status, 404);
    await assert.rejects(raw("SELECT app.b025_record_received($1,$2,$3,1)", [ORG_ID, next.grant, randomUUID()]), pgCode("42501"));
    await db.query("UPDATE vendor_document_grants SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1", [next.grant]);
    assert.equal((await PDF(request({ token: next.token, documentId: first.document.id }, true))).status, 404);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(raw("SELECT * FROM app.b025_received_marks", [], role), pgCode("42501"));
      await assert.rejects(raw("SELECT app.b025_flag_on($1)", [ORG_ID], role), pgCode("42501"));
      if (role !== "service_role") await assert.rejects(raw("SELECT app.b025_record_received($1,$2,$3,1)", [ORG_ID, f.grant, randomUUID()], role), pgCode("42501"));
    }
    for (const sql of ["UPDATE app.b025_received_marks SET amount_minor=1", "DELETE FROM app.b025_received_marks", "TRUNCATE app.b025_received_marks"]) await assert.rejects(db.query(sql), pgCode("55000"));
    // Flag OFF preserves legacy inserts while new routes remain unavailable.
    await flag(false);
    await raw(insert, [ORG_ID, other.profile, other.ticket, randomUUID(), "99999999"]);
    assert.equal((await issue(other.token)).status, 404);
  });
  await t.test("QA r1: UPDATE cannot turn a statement into a receipt; one-step replay never re-marks; multi-row pricing fails closed", async () => {
    await flag(true);
    const next = await fixture();
    const stmt = (await raw(`INSERT INTO vendor_documents(org_id,vendor_profile_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,idempotency_key)
      VALUES($1,$2,$3,'completion_statement',98,$4,'{}','[]',1200,$4) RETURNING id::text`, [ORG_ID, next.profile, next.ticket, randomUUID()])).rows[0].id;
    await assert.rejects(raw(`UPDATE vendor_documents SET kind='receipt' WHERE id=$1`, [stmt]), pgCode("55000"));
    await assert.rejects(raw(`UPDATE vendor_documents SET total_minor=1 WHERE id=$1`, [stmt]), pgCode("55000"));
    const one = await fixture(), key = randomUUID();
    const first = await issue(one.token, { idempotencyKey: key, received: { requestId: randomUUID(), amountMinor: "1200" } });
    assert.equal(first.status, 200);
    const replay = await issue(one.token, { idempotencyKey: key, received: { requestId: randomUUID(), amountMinor: "1200" } });
    assert.equal(replay.status, 200);
    const summary = await receivedSummary(one.token);
    assert.equal(summary.marks.length, 1); assert.equal(summary.receivedMinor, "1200");
    const multi = await fixture();
    await db.query(`UPDATE maintenance_tickets SET type_fields='{"pricing":{"mode":"per_visit","items":[{"mode":"per_visit","quantity":1},{"mode":"per_visit","quantity":2}]}}' WHERE id=$1`, [multi.ticket]);
    const context = await POST(request({ token: multi.token, action: "context" }));
    assert.equal(context.status, 200);
    assert.equal((await context.json()).itemsUnavailable, true);
    const refused = await issue(multi.token, { kind: "completion_statement" });
    assert.equal(refused.status, 409); assert.equal((await refused.json()).error, "items_unavailable");
  });
});
