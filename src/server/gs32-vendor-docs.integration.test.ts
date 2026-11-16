import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import React from "react";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { SESSION_COOKIE } from "./auth";
import { ENV_COOKIE, ORG_COOKIE } from "./org-scope";
import { buildStoredConsent } from "./consent";
import { getSession, sessionTokenHash } from "./session";
import { actionCreateVendorDocumentInvite } from "./vendor-document-invite-actions";
import { loadTicketDocuments, vendorDocsV3Brand } from "./gs32-vendor-docs";
import { POST } from "../app/api/vendor-documents/route";
import VendorPage from "../app/v/documents/[token]/page";
import { VendorDocumentsPanel } from "../components/vendor-documents-panel";
import { VendorTokenShell } from "../components/v3/vendor/token-shell";
import { type1IssueBody } from "../components/v3/vendor/vendor-docs-v3";

// Real sessions, actions, SQL gateways and HTTP handlers; only the Next request cookie/header adapter is substituted.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
let sessionToken = "", orgCookie = ORG_ID;
const envKeys = ["APP_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
const seal = readFileSync(new URL("../../public/favicon-32x32.png", import.meta.url));
const sealPaths = new Set<string>();
const assets = createServer((req, res) => {
  if (req.url === "/fonts/DroidSansFallback-subset.ttf") res.end(font);
  else if (sealPaths.has(req.url ?? "")) res.end(seal);
  else { res.statusCode = 404; res.end(); }
});
mock.method(nextHeaders, "cookies", async () => ({ get(name: string) {
  const value = name === SESSION_COOKIE ? sessionToken : name === ORG_COOKIE ? orgCookie : name === ENV_COOKIE ? "live" : name === "condola_locale" ? "zh-TW" : "";
  return value ? { value } : undefined;
} }));
mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/m/tickets" }));

test.before(async () => {
  (globalThis as Record<string, unknown>).React ??= React;
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  await new Promise<void>(resolve => assets.listen(0, "127.0.0.1", resolve));
  const address = assets.address(); assert.ok(address && typeof address !== "string");
  process.env.APP_URL = process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-only";
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='vendor_documents'`, [ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_documents":true,"brand_v2":true,"brand_v3":true,"vendor_docs_v3":true}'::jsonb WHERE id=ANY($1::uuid[])`, [[ORG_ID, ORG2_ID]]);
  await docsFlag([ORG_ID, ORG2_ID]);
});
test.after(async () => {
  await new Promise<void>((resolve, reject) => assets.close(error => error ? reject(error) : resolve()));
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  mock.restoreAll(); await db?.end(); await clone?.cleanup();
});

async function docsFlag(orgs: string[] | null, enabled = true) {
  if (orgs === null) { await db.query("DELETE FROM platform_settings WHERE key='vendor_docs_v3'"); return; }
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('vendor_docs_v3',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [JSON.stringify({ enabled, allowed_org_ids: orgs })]);
}
async function login(userId: string, orgId = ORG_ID) {
  sessionToken = randomUUID(); orgCookie = orgId;
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [userId, sessionTokenHash(sessionToken)]);
  const consent = buildStoredConsent("reconsent");
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)",
    [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  return getSession();
}
async function fixture(kind: "business" | "individual", orgId = ORG_ID) {
  const property = (await db.query("SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL AND address_display IS NOT NULL LIMIT 1", [orgId])).rows[0].id;
  const owner = (await db.query("INSERT INTO contacts(org_id,is_owner,display_name,receipt_title) VALUES($1,true,'Owner fixture','林雅婷') RETURNING id", [orgId])).rows[0].id;
  await db.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)", [orgId, property, owner]);
  const contact = (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'GS-32 Vendor') RETURNING id", [orgId])).rows[0].id;
  const file = randomUUID(), sealPath = `org/${orgId}/tickets/${randomUUID()}/${file}.png`;
  sealPaths.add(`/storage/v1/object/ticket-photos-private/${sealPath}`);
  await db.query("INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,'seal.png','image/png',$4)", [file, orgId, sealPath, seal.length]);
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    VALUES($1,$2,'GS32',$3,'阿榮',CASE WHEN $3='business' THEN '王師傅水電' END,CASE WHEN $3='business' THEN '王' END,CASE WHEN $3='business' THEN '04595257' END,$4,'台北市信義區信義路二段 1 號',now(),CASE WHEN $3='business' THEN $5::uuid END) RETURNING id`,
  [orgId, contact, kind, `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`, file])).rows[0].id;
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    SELECT org_id,id,1,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id FROM vendor_profiles WHERE id=$1`, [profile]);
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','浴室天花板滴水',$3,'TWD',280000,'{"pricing":{"mode":"lump_sum"}}') RETURNING id`, [orgId, property, contact])).rows[0].id;
  await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id)
    VALUES($1,$2,'GS-32 Vendor','+12025550125','Fixture',$3,now()+interval '1 day',$4,$5)`,
  [orgId, ticket, randomUUID().replaceAll("-", "").padEnd(64, "0"), orgId === ORG_ID ? USERS.admin : USERS.coastAdmin, contact]);
  await login(orgId === ORG_ID ? USERS.admin : USERS.coastAdmin, orgId);
  const invite = await actionCreateVendorDocumentInvite({ ticketId: ticket, profileId: profile, buyer: { kind: "owner", contactId: owner } });
  assert.ok(invite.ok);
  return { ticket, profile, token: invite.url.split("/").at(-1)! };
}
const call = (token: string, body: Record<string, unknown>) => POST(new Request("http://127.0.0.1/api/vendor-documents",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) }));
type Element = React.ReactElement<Record<string, unknown>>;
const page = async (token: string, query: Record<string, string> = {}) =>
  await VendorPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(query) }) as Element;
const caseView = (element: Element) => (element.props.caseView as Element).props as { stage: { stage: string; receipt?: { docNo: string }; scans?: unknown[] }; mode: string; uploaded: boolean; brand: { buyerName: string; name: string; company: string } };
const notFound404 = (error: unknown) => String((error as { digest?: string }).digest).includes("404");
const counts = async (ticket: string) => (await db.query(`SELECT (SELECT count(*) FROM vendor_documents WHERE ticket_id=$1)::int docs,
  (SELECT count(*) FROM app.b025_received_marks m JOIN vendor_document_grants g ON g.id=m.grant_id WHERE g.ticket_id=$1)::int marks`, [ticket])).rows[0];

test("OFF in every gate: the B-025 page and the manager reader are unchanged", async () => {
  const f = await fixture("individual");
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["platform row absent", () => docsFlag(null), () => docsFlag([ORG_ID, ORG2_ID])],
    ["platform disabled, org still allowlisted", () => docsFlag([ORG_ID, ORG2_ID], false), () => docsFlag([ORG_ID, ORG2_ID])],
    ["org off the allowlist", () => docsFlag([ORG2_ID]), () => docsFlag([ORG_ID, ORG2_ID])],
    ["org flag false", () => db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_docs_v3":false}' WHERE id=$1`, [ORG_ID]),
      () => db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_docs_v3":true}' WHERE id=$1`, [ORG_ID])],
    ["brand_v3 off", () => db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"brand_v3":false}' WHERE id=$1`, [ORG_ID]),
      () => db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"brand_v3":true}' WHERE id=$1`, [ORG_ID])],
    // Malformed values fail closed.
    ...[{ enabled: "true", allowed_org_ids: [ORG_ID] }, { enabled: 1, allowed_org_ids: [ORG_ID] }, { enabled: true, allowed_org_ids: ORG_ID },
      { enabled: true, allowed_org_ids: { [ORG_ID]: true } }, { enabled: true }, [ORG_ID], "on"].map(value => [`platform value ${JSON.stringify(value)}`,
      () => db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_docs_v3'`, [JSON.stringify(value)]),
      () => docsFlag([ORG_ID, ORG2_ID])] as [string, () => Promise<unknown>, () => Promise<unknown>]),
    ...["\"true\"", "1", "null", "{}"].map(value => [`org flag ${value}`,
      () => db.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{vendor_docs_v3}',$1::jsonb) WHERE id=$2`, [value, ORG_ID]),
      () => db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_docs_v3":true}' WHERE id=$1`, [ORG_ID])] as [string, () => Promise<unknown>, () => Promise<unknown>]),
  ];
  const admin = await login(USERS.admin);
  for (const [label, apply, restore] of gates) {
    await apply();
    try {
      assert.equal((await page(f.token)).type, VendorDocumentsPanel, label);
      assert.equal(await vendorDocsV3Brand(f.token), null, label);
      assert.deepEqual(await loadTicketDocuments(admin, f.ticket), { state: "off" }, label);
    } finally { await restore(); }
  }
  assert.equal((await page(f.token)).type, VendorTokenShell, "restored");
  assert.equal(await vendorDocsV3Brand("x".repeat(43)), null, "unknown grant");
  // B-025 admission OFF: the page keeps its own 404 even with vendor_docs_v3 ON; no v3 state is rendered.
  await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='vendor_documents'`);
  try {
    await assert.rejects(page(f.token), notFound404);
    assert.equal(await vendorDocsV3Brand(f.token), null);
    assert.deepEqual(await loadTicketDocuments(admin, f.ticket), { state: "off" });
  } finally { await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true') WHERE key='vendor_documents'`); }
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_documents":false}' WHERE id=$1`, [ORG_ID]);
  try { await assert.rejects(page(f.token), notFound404); assert.equal(await vendorDocsV3Brand(f.token), null); }
  finally { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_documents":true}' WHERE id=$1`, [ORG_ID]); }
  assert.equal((await page(f.token)).type, VendorTokenShell);
});

test("bearer reader: expired and revoked grants are refused; a poisoned buyer selection discloses no receipt title", async () => {
  const expired = await fixture("individual");
  await db.query("UPDATE vendor_document_grants SET expires_at=now()-interval '1 second' WHERE token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')", [expired.token]);
  assert.equal(await vendorDocsV3Brand(expired.token), null, "expired");
  await assert.rejects(page(expired.token), notFound404, "expired keeps the B-025 404");
  const revoked = await fixture("individual");
  await db.query("UPDATE vendor_document_grants SET revoked_at=now() WHERE token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')", [revoked.token]);
  assert.equal(await vendorDocsV3Brand(revoked.token), null, "revoked");
  await assert.rejects(page(revoked.token), notFound404, "revoked keeps the B-025 404");

  // Owners elsewhere: same org on another property, and another org. Their receipt titles must never appear.
  const otherProperty = (await db.query("SELECT p.id FROM properties p WHERE p.org_id=$1 AND p.archived_at IS NULL AND p.id<>(SELECT property_id FROM maintenance_tickets WHERE id=$2) LIMIT 1", [ORG_ID, expired.ticket])).rows[0].id;
  const elsewhere = (await db.query("INSERT INTO contacts(org_id,is_owner,display_name,receipt_title) VALUES($1,true,'Elsewhere','另一個物件的抬頭') RETURNING id", [ORG_ID])).rows[0].id;
  await db.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)", [ORG_ID, otherProperty, elsewhere]);
  const foreignProperty = (await db.query("SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL LIMIT 1", [ORG2_ID])).rows[0].id;
  const foreign = (await db.query("INSERT INTO contacts(org_id,is_owner,display_name,receipt_title) VALUES($1,true,'Foreign','別家公司的抬頭') RETURNING id", [ORG2_ID])).rows[0].id;
  await db.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)", [ORG2_ID, foreignProperty, foreign]);
  for (const [label, contactId, title] of [["unrelated property", elsewhere, "另一個物件的抬頭"], ["another org", foreign, "別家公司的抬頭"]]) {
    const f = await fixture("individual");
    await db.query("UPDATE vendor_document_grants SET buyer_selection=$2::jsonb WHERE token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')",
      [f.token, JSON.stringify({ kind: "owner", contactId })]);
    const brand = await vendorDocsV3Brand(f.token);
    assert.ok(brand, `${label}: the grant itself is still admitted, so the buyer filter is what is tested`);
    assert.equal(brand.buyerName, null, label);
    assert.ok(!JSON.stringify(brand).includes(title), label);
    const element = await page(f.token).catch(() => null);
    assert.ok(!JSON.stringify(element?.props ?? {}, (_key, value) => typeof value === "function" ? undefined : value).includes(title), `${label}: page`);
  }
});

test("rec-type1-preview: individual issuer previews, then one confirm marks full payment and issues once", async () => {
  const f = await fixture("individual");
  const view = caseView(await page(f.token));
  assert.deepEqual(view.stage, { stage: "type1_preview" });
  assert.equal(view.brand.name, "阿榮"); assert.equal(view.brand.buyerName, "林雅婷");
  assert.deepEqual(await counts(f.ticket), { docs: 0, marks: 0 });
  const body = type1IssueBody(f.token, "2800", () => randomUUID(), "2026-11-16");
  const first = await call(f.token, body); assert.equal(first.status, 200);
  const id = (await first.json()).document.id;
  const retry = await call(f.token, body); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).document.id, id, "a retry of the same body is the same document");
  assert.deepEqual(await counts(f.ticket), { docs: 1, marks: 1 });
  assert.equal((await page(f.token)).type, VendorDocumentsPanel, "issued: the next screens (rec-issued) are VF-3, so B-025 shows it");
});

test("rec-paper-upload: an issued receipt shows its evidence; a paper scan is a sibling card, never a charge", async () => {
  const f = await fixture("business");
  assert.equal((await page(f.token)).type, VendorDocumentsPanel, "business before a receipt: 開給誰 / path are VF-3");
  const issued = await call(f.token, { action: "issue", kind: "receipt", documentDate: "2026-11-16", idempotencyKey: randomUUID(),
    received: { requestId: randomUUID(), amountMinor: "2800" } });
  assert.equal(issued.status, 200, await issued.clone().text());
  const { document } = await issued.json();
  let view = caseView(await page(f.token, { uploaded: "1" }));
  assert.equal(view.stage.stage, "receipt_evidence"); assert.equal(view.stage.receipt?.docNo, document.doc_no);
  assert.deepEqual(view.stage.scans, []); assert.equal(view.uploaded, true);
  assert.equal(caseView(await page(f.token, { paper: "1" })).mode, "paper");
  const before = await counts(f.ticket);
  const scan = await call(f.token, { action: "attach_scan", documentId: document.id, requestId: randomUUID(), mimeType: "application/pdf", base64: Buffer.from("%PDF-fixture").toString("base64") });
  assert.equal(scan.status, 200);
  view = caseView(await page(f.token));
  assert.equal(view.stage.scans?.length, 1);
  assert.deepEqual(await counts(f.ticket), before, "no new document and no new payment");
  // Voiding the receipt leaves no issued receipt, so the drawn state ends (作廢重開 is VF-4).
  assert.equal((await call(f.token, { action: "void", documentId: document.id, reason: "開錯抬頭" })).status, 200);
  assert.equal((await page(f.token)).type, VendorDocumentsPanel);
});

test("DOC-VOID m-docs reader: tickets.update roles only, live first and voided last, org-scoped", async () => {
  const f = await fixture("business");
  const first = await call(f.token, { action: "issue", kind: "receipt", documentDate: "2026-11-16", idempotencyKey: randomUUID(), received: { requestId: randomUUID(), amountMinor: "2800" } });
  assert.equal(first.status, 200, await first.clone().text());
  const voided = (await first.json()).document;
  assert.equal((await call(f.token, { action: "void", documentId: voided.id, reason: "開錯抬頭" })).status, 200);
  const statement = await call(f.token, { action: "issue", kind: "completion_statement", documentDate: "2026-11-16", idempotencyKey: randomUUID() });
  assert.equal(statement.status, 200);
  const admin = await login(USERS.admin);
  const ready = await loadTicketDocuments(admin, f.ticket);
  assert.equal(ready.state, "ready");
  if (ready.state !== "ready") return;
  assert.equal(ready.currency, "TWD");
  assert.deepEqual(ready.documents.map(d => [d.kind, d.status]), [["completion_statement", "issued"], ["receipt", "voided"]]);
  assert.equal(ready.documents[1].docNo, voided.doc_no, "the voided number is kept");
  assert.equal(ready.documents[1].buyerName, "林雅婷");
  assert.equal((await loadTicketDocuments(await login(USERS.manager), f.ticket)).state, "ready");
  for (const user of [USERS.accountant, USERS.maintenance]) assert.deepEqual(await loadTicketDocuments(await login(user), f.ticket), { state: "off" }, user);
  await assert.rejects(loadTicketDocuments(await login(USERS.coastAdmin, ORG2_ID), f.ticket), "another org's ticket is not found");
});
