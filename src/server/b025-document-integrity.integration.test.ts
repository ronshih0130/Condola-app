import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createVendorDocumentInvite, issueVendorDocument, previewVendorDocument, resolveVendorDocumentToken, vendorProfileSealOn, type StoredVendorDocument } from "./vendor-receipt";
import { recordReceived, receivedSummary, vendorDocumentHistory, vendorDocumentAction } from "./vendor-documents-gate";
import { svcOn } from "./db";
import { PHOTO_BUCKET } from "./repair-rules";
import type { Session } from "./types";
import { POST } from "../app/api/vendor-documents/route";
import { POST as SCAN } from "../app/api/vendor-documents/scan/route";
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
async function fixture(orgId = ORG_ID) {
  const property = (await db.query(`SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL AND address_display IS NOT NULL LIMIT 1`, [orgId])).rows[0].id;
  const owner = (await db.query(`INSERT INTO contacts(org_id,is_owner,display_name,receipt_title,email) VALUES($1,true,'PRIVATE OWNER','Owner supplied title','private@example.invalid') RETURNING id`, [orgId])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)`, [orgId, property, owner]);
  const contact = (await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'Vendor fixture') RETURNING id`, [orgId])).rows[0].id;
  const file = randomUUID(), sealPath = `org/${orgId}/tickets/${randomUUID()}/${file}.png`;
  sealPaths.add(`/storage/v1/object/${PHOTO_BUCKET}/${sealPath}`);
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,'seal.png','image/png',$5)`, [file, orgId, PHOTO_BUCKET, sealPath, seal.length]);
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    VALUES($1,$2,'B025','business','Vendor fixture','Business','Representative','04595257','+12025550125','Address',now(),$3) RETURNING id`, [orgId, contact, file])).rows[0].id;
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    SELECT org_id,id,1,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id FROM vendor_profiles WHERE id=$1`, [profile]);
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','Fixture repair',$3,'TWD',120000,'{"pricing":{"mode":"lump_sum"}}') RETURNING id`, [orgId, property, contact])).rows[0].id;
  await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id)
    VALUES($1,$2,'Fixture','+12025550125','Fixture',$3,now()+interval '1 day',$4,$5)`, [orgId, ticket, randomUUID().replaceAll("-", "").padEnd(64, "0"), (orgId === ORG_ID ? USERS.admin : USERS.coastAdmin), contact]);
  const admin: Session = { userId: (orgId === ORG_ID ? USERS.admin : USERS.coastAdmin), sessionId: "b025", email: "fixture@example.invalid", name: "Fixture", kind: "staff", role: "admin", orgId: orgId, liveOrgId: orgId, environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
  const invite = await createVendorDocumentInvite(admin, ticket, profile, { kind: "owner", contactId: owner });
  return { ticket, profile, owner, file, grant: invite.grantId, token: invite.url.split("/").at(-1)! };
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


async function domainState() {
  const result: Record<string, unknown> = {};
  for (const table of ["vendor_profiles", "vendor_profile_versions", "vendor_documents", "vendor_document_pdf_bytes", "vendor_document_sequences", "vendor_issuers", "app.b025_profile_seals", "app.b025_paper_scans", "app.b025_received_marks", "audit_log"]) {
    result[table] = (await db.query(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0].hash;
  }
  return result;
}
const trades = [{ name: "Trade work", quantity: "2.5", unit: "hour", unit_price_minor: "480", category: "labor" }];

test("B025 integrity: exact trade totals, version snapshots and sibling scans", async (t) => {
  const f = await fixture(), other = await fixture();
  let first: StoredVendorDocument, second: StoredVendorDocument, original: Buffer, scanId: string;
  await t.test("OFF and malformed flags: full action matrix and direct scan RPC have zero writes", async () => {
    const calls = [
      { action: "context" }, { action: "history" },
      { action: "preview", kind: "receipt", documentDate: "2026-01-01", tradeItems: trades },
      { ...issueFields, idempotencyKey: randomUUID(), received: { requestId: randomUUID(), amountMinor: "1200" }, tradeItems: trades },
      { action: "reissue", documentId: randomUUID(), kind: "receipt", documentDate: "2026-01-01", idempotencyKey: randomUUID() },
      { action: "void", documentId: randomUUID(), reason: "Correction" },
      { action: "mark_received", requestId: randomUUID(), amountMinor: "1200" },
      { action: "update_fixed_data", update: { expectedVersion: 1, display_name: "New" } },
      { action: "attach_scan", documentId: randomUUID(), requestId: randomUUID(), mimeType: "image/png", base64: seal.toString("base64") },
    ];
    const cases = [
      { value: { enabled: false, allowed_org_ids: [ORG_ID] }, org: true },
      { value: { enabled: "true", allowed_org_ids: [ORG_ID] }, org: true },
      { value: { enabled: true, allowed_org_ids: [] }, org: true },
      { value: null, org: true },
      { value: undefined, org: true }, // missing global row, org remains ON
      { value: { enabled: true, allowed_org_ids: [ORG_ID] }, org: false },
      { value: { enabled: true, allowed_org_ids: [ORG_ID] }, org: "true" },
    ];
    for (const { value, org } of cases) {
      await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('vendor_documents',$1::jsonb) WHERE id=$2`, [JSON.stringify(org), ORG_ID]);
      if (value === undefined) await db.query("DELETE FROM platform_settings WHERE key='vendor_documents'");
      else await db.query(`INSERT INTO platform_settings(key,value) VALUES('vendor_documents',$1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(value)]);
      const before = await domainState();
      const direct = { actor: f.token, ticketId: f.ticket, vendorProfileId: f.profile, items: [], totalMinor: 1200,
        documentDate: "2026-01-01", tradeItems: [{ ...trades[0], category: "labor" as const }] };
      await assert.rejects(issueVendorDocument(direct, { idempotencyKey: randomUUID() }));
      await assert.rejects(previewVendorDocument(direct));
      for (const call of calls) assert.equal((await POST(request({ token: f.token, ...call }))).status, 404);
      for (const handler of [PDF, SCAN]) assert.equal((await handler(request({ token: f.token, documentId: randomUUID(), scanId: randomUUID() }))).status, 404);
      await assert.rejects(vendorDocumentAction(f.token, { action: "update_fixed_data", update: { expectedVersion: 1, display_name: "New" } }));
      await assert.rejects(raw("SELECT app.b025_attach_paper_scan($1,$2,$3,$4,'image/png',$5)", [ORG_ID, f.grant, randomUUID(), randomUUID(), seal]), pgCode("42501"));
      await assert.rejects(raw("SELECT * FROM app.b025_store_profile_seal($1,$2,$3,'image/png',$4)", [ORG_ID, f.grant, f.profile, seal]), pgCode("42501"));
      await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,1)", [ORG_ID, f.grant, f.profile]), pgCode("42501"));
      assert.deepEqual(await domainState(), before);
    }
    await flag(true);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"vendor_documents":"true"}'::jsonb WHERE id=$1`, [ORG_ID]);
    const before = await domainState();
    for (const call of calls) assert.equal((await POST(request({ token: f.token, ...call }))).status, 404);
    assert.deepEqual(await domainState(), before);
    await flag(true);
  });
  await t.test("legacy object-backed seals also require a live capability and flags before loading", async () => {
    const access = await svcOn(db, null, (client) => resolveVendorDocumentToken(client, f.token));
    for (const on of [true, false]) {
      await flag(on);
      for (const [userId, orgId, role] of [
        [USERS.accountant, ORG_ID, "accountant"], [USERS.maintenance, ORG_ID, "maintenance"],
        [USERS.manager, ORG_ID, "manager"], [USERS.coastAdmin, ORG2_ID, "admin"],
      ] as const) {
        const actor: Session = { userId, orgId, liveOrgId: orgId, role, sessionId: "test", email: "fixture@example.invalid", name: "Fixture", kind: "staff", environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
        // Deliberately omit tradeItems: legacy preview must not bypass admission.
        await assert.rejects(previewVendorDocument({ actor, ticketId: f.ticket, vendorProfileId: f.profile,
          buyer: { kind: "owner", contactId: f.owner }, items: [{ name: "Work", quantity: 1, unit: "", unit_price_minor: 1200, amount_minor: 1200, category: "service" }],
          totalMinor: 1200, documentDate: "2026-01-01" }));
        await assert.rejects(svcOn(db, userId, (client) => vendorProfileSealOn(client, { ...access, userId, grantId: null })));
      }
      if (!on) await assert.rejects(svcOn(db, null, (client) => vendorProfileSealOn(client, access)));
    }
    await flag(true);
    for (const role of ["anon", "authenticated"])
      await assert.rejects(raw("SELECT app.b025_legacy_seal_path($1,$2,$3,1)", [ORG_ID, f.grant, f.profile], role), pgCode("42501"));
    await assert.rejects(raw("SELECT app.b025_legacy_seal_path($1,$2,$3,1)", [ORG_ID, other.grant, f.profile]), pgCode("42501"));
    await assert.rejects(raw("SELECT app.b025_legacy_seal_path($1,$2,$3,1)", [ORG2_ID, f.grant, f.profile]), pgCode("42501"));
    const loaded = await svcOn(db, null, (client) => vendorProfileSealOn(client, access));
    assert.deepEqual(Buffer.from(loaded!.bytes), seal);
  });
  await t.test("exact quantity/unit reaches preview and PDF; full-payment gate cannot be overridden", async () => {
    const counter = (await db.query("SELECT next_seq FROM vendor_issuers WHERE tax_id='04595257'")).rows[0].next_seq;
    const preview = await POST(request({ token: f.token, ...issueFields, action: "preview", tradeItems: trades }));
    assert.equal(preview.status, 200);
    const body = await preview.json();
    assert.equal(body.document.items[0].quantity, "2.5");
    assert.equal(body.document.items[0].unit_price_minor, "480");
    assert.equal(body.document.items[0].amount_minor, "1200");
    assert.equal(body.document.seq, 0);
    assert.equal((await db.query("SELECT next_seq FROM vendor_issuers WHERE tax_id='04595257'")).rows[0].next_seq, counter);
    assert.equal((await issue(f.token, { tradeItems: [{ ...trades[0], unit_price_minor: "481" }] })).status, 400);
    assert.equal((await issue(f.token, { tradeItems: [{ ...trades[0], quantity: 2.5 }] })).status, 400);
    assert.equal((await issue(f.token, { tradeItems: trades, override: true })).status, 409);
    await recordReceived(f.token, { requestId: randomUUID(), amountMinor: "1199" });
    assert.equal((await issue(f.token, { tradeItems: trades, override: true })).status, 409);
    await recordReceived(f.token, { requestId: randomUUID(), amountMinor: "1" });
    const response = await issue(f.token, { tradeItems: trades }); assert.equal(response.status, 200);
    first = await response.json();
    original = Buffer.from(await (await PDF(request({ token: f.token, documentId: first.document.id }, true))).arrayBuffer());
    assert.equal(original.subarray(0, 5).toString(), "%PDF-");
  });
  await t.test("fixed data plus seal append a version; historical PDFs and snapshots remain byte-identical", async () => {
    const oldVersion = (await db.query("SELECT vendor_profile_version_id FROM vendor_documents WHERE id=$1", [first.document.id])).rows[0].vendor_profile_version_id;
    const newSeal = readFileSync(new URL("../../public/favicon-16x16.png", import.meta.url));
    const update = { expectedVersion: 1, business_name: "Version two business", address: "Version two address", seal: { base64: newSeal.toString("base64"), mimeType: "image/png" } };
    const response = await POST(request({ token: f.token, action: "update_fixed_data", update }));
    assert.equal(response.status, 200); const version = await response.json(); assert.equal(version.version, 2);
    const after = await domainState();
    assert.equal((await POST(request({ token: f.token, action: "update_fixed_data", update }))).status, 400);
    assert.deepEqual(await domainState(), after);
    const oldPdf = await PDF(request({ token: f.token, documentId: first.document.id }, true));
    assert.deepEqual(Buffer.from(await oldPdf.arrayBuffer()), original);
    assert.equal((await db.query("SELECT vendor_profile_version_id FROM vendor_documents WHERE id=$1", [first.document.id])).rows[0].vendor_profile_version_id, oldVersion);
    assert.equal((await POST(request({ token: f.token, action: "void", documentId: first.document.id, reason: "Revision" }))).status, 200);
    const replacement = await issue(f.token, { action: "reissue", documentId: first.document.id });
    assert.equal(replacement.status, 200); second = await replacement.json();
    assert.ok(second.document.seq > first.document.seq);
    assert.notEqual(second.sha256, first.sha256);
    const history = await vendorDocumentHistory(f.token);
    assert.deepEqual(history.map((row) => [row.version, row.issuerName]), [[1, "Business"], [2, "Version two business"]]);
    assert.deepEqual(history[0].items, history[1].items);
    assert.equal(history[0].profileVersionId, oldVersion);
    assert.equal(history[1].profileVersionId, version.id);
    assert.equal(history[0].sha256, first.sha256);
    assert.deepEqual(Buffer.from(await (await PDF(request({ token: f.token, documentId: first.document.id }, true))).arrayBuffer()), original);
    await assert.rejects(raw("UPDATE vendor_documents SET vendor_profile_version_id=$2 WHERE id=$1", [first.document.id, version.id]), pgCode("55000"));
    await assert.rejects(raw("UPDATE vendor_documents SET pdf_sha256=repeat('0',64) WHERE id=$1", [first.document.id]), pgCode("55000"));
    await assert.rejects(raw("UPDATE vendor_profile_versions SET business_name='Changed' WHERE id=$1", [oldVersion]), pgCode("55000"));
    const snapshot = (await db.query("SELECT snapshot FROM vendor_profile_versions WHERE id=$1", [version.id])).rows[0].snapshot;
    assert.deepEqual(Object.keys(snapshot.seal).sort(), ["id", "sha256"]);
    const privateSeal = (await raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, f.grant, f.profile])).rows[0];
    assert.deepEqual(privateSeal.bytes, newSeal);
    assert.equal(privateSeal.sha256, snapshot.seal.sha256);
    const loaded = await svcOn(db, null, async (client) => vendorProfileSealOn(client, await resolveVendorDocumentToken(client, f.token)));
    assert.deepEqual(Buffer.from(loaded!.bytes), newSeal);
    // Replacing the seal again cannot affect either historical PDF or v2 bytes.
    const secondPdf = Buffer.from(await (await PDF(request({ token: f.token, documentId: second.document.id }, true))).arrayBuffer());
    assert.equal((await POST(request({ token: f.token, action: "update_fixed_data", update: {
      expectedVersion: 2, seal: { base64: seal.toString("base64"), mimeType: "image/png" },
    } }))).status, 200);
    assert.deepEqual(Buffer.from(await (await PDF(request({ token: f.token, documentId: second.document.id }, true))).arrayBuffer()), secondPdf);
    assert.deepEqual((await raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, f.grant, f.profile])).rows[0].bytes, newSeal);
    assert.deepEqual(Buffer.from(await (await PDF(request({ token: f.token, documentId: first.document.id }, true))).arrayBuffer()), original);
  });
  await t.test("seal bytes stay private for same-org staff and foreign members, including OFF", async () => {
    const access = await svcOn(db, null, (client) => resolveVendorDocumentToken(client, f.token));
    for (const on of [true, false]) {
      await flag(on);
      for (const [userId, orgId, role] of [
        [USERS.accountant, ORG_ID, "accountant"], [USERS.maintenance, ORG_ID, "maintenance"],
        [USERS.manager, ORG_ID, "manager"], [USERS.coastAdmin, ORG2_ID, "admin"],
      ] as const) {
        async function member<T>(fn: (client: Client) => Promise<T>) {
          await db.query("BEGIN");
          try {
            await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)", [userId, orgId]);
            await db.query("SET LOCAL ROLE authenticated");
            return await fn(db);
          } finally { await db.query("ROLLBACK"); }
        }
        const snapshots = await member((client) => client.query("SELECT snapshot FROM vendor_profile_versions WHERE vendor_profile_id=$1", [f.profile]));
        assert.equal(snapshots.rows.length, orgId === ORG_ID ? 3 : 0);
        for (const { snapshot } of snapshots.rows) {
          assert.equal(snapshot.seal?.base64, undefined);
          if (snapshot.seal) assert.deepEqual(Object.keys(snapshot.seal).sort(), ["id", "sha256"]);
        }
        for (const sql of ["SELECT bytes FROM app.b025_profile_seals", "SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)",
          "SELECT * FROM app.b025_store_profile_seal($1,$2,$3,'image/png',decode('AA==','base64'))"]) {
          await assert.rejects(member((client) => client.query(sql, sql.includes("$1") ? [ORG_ID, f.grant, f.profile] : [])), pgCode("42501"));
        }
        // Even a forged access object containing the real grant cannot turn the
        // low-level loader into an authenticated-role storage proxy.
        await assert.rejects(member((client) => vendorProfileSealOn(client, access)));
        const actor: Session = { userId, orgId, liveOrgId: orgId, role, sessionId: "test", email: "fixture@example.invalid", name: "Fixture", kind: "staff", environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
        await assert.rejects(previewVendorDocument({ actor, ticketId: f.ticket, vendorProfileId: f.profile,
          buyer: { kind: "owner", contactId: f.owner }, items: [], tradeItems: [{ ...trades[0], category: "labor" }], totalMinor: 1200, documentDate: "2026-01-01" }));
        assert.equal((await POST(request({ action: "context", token: userId }))).status, 404);
        assert.equal((await POST(request({ action: "history", token: userId }))).status, 404);
        assert.equal((await PDF(request({ token: userId, documentId: second.document.id }, true))).status, 404);
      }
      if (!on) {
        await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, f.grant, f.profile]), pgCode("42501"));
        await assert.rejects(svcOn(db, null, (client) => vendorProfileSealOn(client, access)));
      }
    }
    await flag(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const sql of ["SELECT * FROM app.b025_profile_seals", "UPDATE app.b025_profile_seals SET bytes=bytes", "DELETE FROM app.b025_profile_seals", "TRUNCATE app.b025_profile_seals"])
        await assert.rejects(raw(sql, [], role), pgCode("42501"));
    }
    for (const sql of ["UPDATE app.b025_profile_seals SET bytes=bytes", "DELETE FROM app.b025_profile_seals", "TRUNCATE app.b025_profile_seals"])
      await assert.rejects(db.query(sql), pgCode("55000"));
    const catalog = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='app.b025_profile_seals'::regclass`)).rows[0];
    assert.equal(catalog.relrowsecurity, true);
    const readers = (await db.query(`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='app.b025_read_profile_seal(uuid,uuid,uuid,integer)'::regprocedure`)).rows[0];
    assert.equal(readers.prosecdef, true);
    assert.ok(readers.proconfig.includes("search_path=pg_catalog, public, app"));
    assert.equal((await db.query("SELECT count(*)::int n FROM vendor_profile_versions WHERE snapshot->'seal' ? 'base64'")).rows[0].n, 0);
    await assert.rejects(raw(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,phone_e164,snapshot)
      VALUES($1,$2,99,'business','Rejected','+12025550125',$3)`, [ORG_ID, f.profile, JSON.stringify({ seal: { base64: seal.toString("base64") } })]), pgCode("23514"));
    await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, other.grant, f.profile]), pgCode("42501"));
    await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG2_ID, f.grant, f.profile]), pgCode("42501"));
  });
  await t.test("scan is an idempotent sibling of the same group, never an electronic replacement or charge", async () => {
    const before = (await db.query("SELECT items,total_minor,pdf_sha256 FROM vendor_documents WHERE id=$1", [second.document.id])).rows[0];
    const payments = await receivedSummary(f.token);
    const input = { token: f.token, action: "attach_scan", documentId: second.document.id, requestId: randomUUID(), mimeType: "image/png", base64: seal.toString("base64") };
    const results = await Promise.all([POST(request(input)), POST(request(input))]);
    assert.equal(results[0].status, 200); assert.equal(results[1].status, 200);
    scanId = (await results[0].json()).id; assert.equal((await results[1].json()).id, scanId);
    assert.equal((await POST(request({ ...input, base64: Buffer.from("not an image").toString("base64") }))).status, 400);
    const history = await vendorDocumentHistory(f.token);
    assert.equal(history[0].scans.length, 1); assert.equal(history[1].scans.length, 1);
    assert.equal(history[1].scans[0].document_group_id, first.document.id);
    assert.equal(history[1].scans[0].id, scanId);
    const downloaded = await SCAN(request({ token: f.token, scanId })); assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), seal);
    assert.deepEqual((await db.query("SELECT items,total_minor,pdf_sha256 FROM vendor_documents WHERE id=$1", [second.document.id])).rows[0], before);
    assert.deepEqual(await receivedSummary(f.token), payments);
    assert.equal((await db.query("SELECT count(*)::int n FROM vendor_documents WHERE ticket_id=$1", [f.ticket])).rows[0].n, 2);
    assert.deepEqual(Buffer.from(await (await PDF(request({ token: f.token, documentId: first.document.id }, true))).arrayBuffer()), original);
    const events = (await db.query("SELECT new_row FROM audit_log WHERE event_type IN ('vendor_fixed_data_version','vendor_paper_scan_attach')")).rows;
    assert.ok(events.length >= 2);
    assert.doesNotMatch(JSON.stringify(events), /Version two|base64|phone_e164|token/);
  });
  await t.test("fixed-data updates are scoped, bounded and concurrent version checks prevent lost updates", async () => {
    const target = await fixture();
    for (const update of [{ expectedVersion: 1, orgId: ORG2_ID }, { expectedVersion: 1, phone_e164: "bad" },
      { expectedVersion: 1, business_name: "" }, { expectedVersion: 1, seal: { base64: "bad", mimeType: "image/png" } }]) {
      const before = await domainState();
      assert.equal((await POST(request({ token: target.token, action: "update_fixed_data", update }))).status, 400);
      assert.deepEqual(await domainState(), before);
    }
    const results = await Promise.all(["First", "Second"].map((display_name) => POST(request({ token: target.token,
      action: "update_fixed_data", update: { expectedVersion: 1, display_name } }))));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    assert.equal((await db.query("SELECT count(*)::int n FROM vendor_profile_versions WHERE vendor_profile_id=$1", [target.profile])).rows[0].n, 2);
  });
  await t.test("cross-org/cross-grant, revoked and expired capabilities denied; private table ACLs", async () => {
    const otherOrg = await fixture(ORG2_ID);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"vendor_documents":true}'::jsonb WHERE id=$1`, [ORG2_ID]);
    await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='vendor_documents'`, [ORG_ID, ORG2_ID]);
    const foreignVersion = (await db.query("SELECT id FROM vendor_profile_versions WHERE vendor_profile_id=$1", [otherOrg.profile])).rows[0].id;
    await assert.rejects(raw(`INSERT INTO vendor_documents(org_id,vendor_profile_id,vendor_profile_version_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,idempotency_key)
      VALUES($1,$2,$3,$4,'completion_statement',99,$5,'{}','[]',1200,$5)`, [ORG_ID, f.profile, foreignVersion, f.ticket, randomUUID()]), pgCode("23514"));
    assert.deepEqual(await vendorDocumentHistory(otherOrg.token), []);
    assert.equal((await PDF(request({ token: otherOrg.token, documentId: first.document.id }, true))).status, 404);
    assert.equal((await SCAN(request({ token: otherOrg.token, scanId }))).status, 403);
    const beforeOther = await domainState();
    assert.equal((await POST(request({ token: otherOrg.token, action: "attach_scan", documentId: first.document.id, requestId: randomUUID(), mimeType: "image/png", base64: seal.toString("base64") }))).status, 403);
    assert.deepEqual(await domainState(), beforeOther);
    assert.deepEqual(await vendorDocumentHistory(other.token), []);
    assert.equal((await SCAN(request({ token: other.token, scanId }))).status, 403);
    assert.equal((await POST(request({ token: other.token, action: "attach_scan", documentId: first.document.id, requestId: randomUUID(), mimeType: "image/png", base64: seal.toString("base64") }))).status, 403);
    for (const org of [ORG2_ID]) {
      await assert.rejects(raw("SELECT * FROM app.b025_paper_scan_history($1,$2,$3)", [org, f.grant, first.document.id]), pgCode("42501"));
      await assert.rejects(raw("SELECT app.b025_attach_paper_scan($1,$2,$3,$4,'image/png',$5)", [org, f.grant, first.document.id, randomUUID(), seal]), pgCode("42501"));
      await assert.rejects(raw("SELECT * FROM app.b025_read_paper_scan($1,$2,$3)", [org, f.grant, scanId]), pgCode("42501"));
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(raw("SELECT * FROM app.b025_paper_scans", [], role), pgCode("42501"));
      if (role !== "service_role") await assert.rejects(raw("SELECT * FROM app.b025_read_paper_scan($1,$2,$3)", [ORG_ID, f.grant, scanId], role), pgCode("42501"));
    }
    for (const sql of ["UPDATE app.b025_paper_scans SET mime_type='application/pdf'", "DELETE FROM app.b025_paper_scans", "TRUNCATE app.b025_paper_scans"]) await assert.rejects(db.query(sql), pgCode("55000"));
    await db.query("UPDATE vendor_document_grants SET revoked_at=now() WHERE id=$1", [f.grant]);
    const before = await domainState();
    await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, f.grant, f.profile]), pgCode("42501"));
    assert.equal((await POST(request({ token: f.token, action: "update_fixed_data", update: { expectedVersion: 2, display_name: "Denied" } }))).status, 404);
    assert.equal((await SCAN(request({ token: f.token, scanId }))).status, 404);
    assert.deepEqual(await domainState(), before);
    await db.query("UPDATE vendor_document_grants SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1", [f.grant]);
    await assert.rejects(raw("SELECT * FROM app.b025_read_profile_seal($1,$2,$3,2)", [ORG_ID, f.grant, f.profile]), pgCode("42501"));
    assert.equal((await POST(request({ token: f.token, action: "history" }))).status, 404);
    await flag(false);
  });
});
