import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { buildStoredConsent } from "./consent";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { claimVendorAccount, inviteVendorAccount } from "./vendor-accounts";
import { saveVendorIssuerType, type IssuerType } from "./b065-vendor-activation";
import {
  STAMP_CONSENT_TEXT, consentStampByGrant, consentVendorStamp, receiptStampByGrant, saveStampByGrant, saveVendorStamp, stampPreviewByGrant,
  stampSha256, vendorReceiptStamp, vendorStampView, type StampArtInput, type StampGrantScope,
} from "./b065-stamp";
import { hashVendorToken } from "./vendor-repair-rules";

// VEN-18 (B-065 phase B slice P1) on a cloned disposable database: the real B-026 invite/claim, the real phase A issuer
// type writer, real B-025 document grants and the real app.b065_* stamp gateways. Run: CONDOLA_RLS_DISPOSABLE=YES
// DATABASE_URL=… (never staging).
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
type Q = Pick<Client, "query">;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin", kind: "staff",
  name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const users = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), staff: randomUUID() };
const creds = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), staff: randomUUID(), admin: randomUUID() };
const contacts = { a: "", b: "", c: "", d: "", staff: "", foreignB: "" };
const profiles = { a: "", b: "", c: "", foreignB: "" };
let grantA: StampGrantScope, grantB: StampGrantScope, grantForeignB: StampGrantScope;
const brandEnv = process.env.BRAND_V2;
const ACTIVATION_ON = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] };
const DOCUMENTS_ON = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] };

/** A small canonical stamp fixture (paths only); `n` changes the bytes. P1 needs no production generator. */
const svgFor = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52.8 30"><rect x="0.5" y="0.5" width="51.8" height="29" fill="none" stroke="#B31B1B" stroke-width="0.6"/><path fill="#B31B1B" d="M${n} 2L4 6L2 6Z"/></svg>`;
const artFor = (n: number, inputsSha256: string, extra: Partial<StampArtInput> = {}): StampArtInput =>
  ({ svg: svgFor(n), inputsSha256, fontId: "lxgw-wenkai-tc-1.530-big5", generatorVersion: "d1-1", fallbackCodepoints: [], ...extra });

async function flags(patch: Record<string, unknown>, org = ORG_ID, client: Q = db) {
  await client.query("UPDATE organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
}
async function setting(key: string, value: unknown, client: Q = db) {
  await client.query("INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, JSON.stringify(value)]);
}
const SNAPSHOT_TABLES = ["app.b065_stamp_versions", "app.b065_stamp_consents", "app.b065_stamp_requests", "public.audit_log", "public.vendor_profiles",
  "public.contacts", "app.b065_issuer_types"];
async function snapshot(client: Q = db) {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const versions = async (contact: string) => (await db.query(
  "SELECT version,source,sha256,created_via,created_by::text,grant_id::text,request_id::text FROM app.b065_stamp_versions WHERE contact_id=$1 ORDER BY version", [contact])).rows;
const consents = async (contact: string) => (await db.query(`SELECT v.version,c.kind,c.consent_text,c.via,c.consented_by::text,c.grant_id::text
  FROM app.b065_stamp_consents c JOIN app.b065_stamp_versions v ON v.id=c.stamp_version_id WHERE c.contact_id=$1 ORDER BY v.version`, [contact])).rows;
const ledger = async (request: string, org = ORG_ID) => (await db.query(
  "SELECT actor_id::text,via,grant_id::text,contact_id::text,op,answer FROM app.b065_stamp_requests WHERE org_id=$1 AND request_id=$2", [org, request])).rows;
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501" || (error as { code?: string }).code === "42501";
const inputsSha = async (cred: string, org = ORG_ID) => (await vendorStampView(cred, org)).inputsSha256!;
const save = async (cred: string, n: number, request = randomUUID(), org = ORG_ID) => saveVendorStamp(cred, org, { requestId: request, ...artFor(n, await inputsSha(cred, org)) });
const consentLatest = async (cred: string, request = randomUUID(), org = ORG_ID) =>
  consentVendorStamp(cred, org, { requestId: request, previewedSha256: (await vendorStampView(cred, org)).current!.sha256, art: null });
/** Raw SQL writers, bypassing the TS parsers (shape refusals and hostile payloads). */
const sqlSave = (credHash: string, request: string | null, svg: string | null, inputs: string | null, fallback: number[] | null = [], org: string | null = ORG_ID) =>
  svc(null, async client => (await client.query("SELECT app.b065_save_stamp($1,$2::uuid,false,$3::uuid,$4,$5,'lxgw','d1-1',$6::integer[]) r",
    [credHash, org, request, svg, inputs, fallback])).rows[0].r);
const sqlConsent = (credHash: string, request: string | null, previewed: string | null, svg: string | null = null, inputs: string | null = null, org: string | null = ORG_ID) =>
  svc(null, async client => (await client.query(`SELECT app.b065_consent_stamp($1,$2::uuid,false,$3::uuid,$4,$5,$6,$7,$8,$9::integer[]) r`,
    [credHash, org, request, previewed, svg, inputs, svg ? "lxgw" : null, svg ? "d1-1" : null, svg ? [] : null])).rows[0].r);

async function vendorContact(org: string, name: string) {
  return (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,$2,'+886912345678') RETURNING id::text", [org, name])).rows[0].id as string;
}
async function profile(org: string, contact: string, fields: { kind: "business" | "individual"; display: string; business?: string; rep?: string; phone: string; address?: string }) {
  return (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at)
    VALUES($1,$2,'B065P1',$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id::text`,
  [org, contact, fields.kind, fields.display, fields.business ?? null, fields.rep ?? null, fields.kind === "business" ? "04595257" : null, fields.phone, fields.address ?? null])).rows[0].id as string;
}
/** A real B-025 document link (job + grant) on the profile; returns the raw token and the grant id. */
async function grant(org: string, contact: string, profileId: string, opts: { expiresIn?: string } = {}) {
  const token = randomBytes(32).toString("base64url");
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id)
    SELECT $1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),id,'closed','B-065 stamp',$2
    FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1 RETURNING id::text`, [org, contact])).rows[0].id as string;
  const creator = org === ORG_ID ? USERS.admin : USERS.coastAdmin;
  const job = (await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id,sharing_approved_at)
    VALUES($1,$2,'B-065','+886912345678','x',$3,clock_timestamp()+interval '1 day',$4,$5,clock_timestamp()) RETURNING id::text`,
  [org, ticket, hashVendorToken(randomBytes(32).toString("base64url")), creator, contact])).rows[0].id as string;
  const id = (await db.query(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"B-065"}'::jsonb,clock_timestamp()+$6::interval,$7) RETURNING id::text`,
  [org, ticket, job, profileId, hashVendorToken(token), opts.expiresIn ?? "1 day", creator])).rows[0].id as string;
  return { scope: { token, orgId: org, profileId }, id, ticket, job };
}

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  delete process.env.BRAND_V2;
  for (const [key, id] of Object.entries(users)) await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [id, `b065p1-${key}@example.test`]);
  const sessions: Array<[string, string]> = [[users.a, creds.a], [users.b, creds.b], [users.c, creds.c], [users.d, creds.d], [users.staff, creds.staff], [USERS.admin, creds.admin]];
  for (const [user, cred] of sessions) await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [user, hash(cred)]);
  // The staff sessions that invite the vendors (B-026 checks the inviting session row).
  for (const s of [admin, coast]) await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [s.sessionId, s.userId, hash(randomUUID())]);
  const consent = buildStoredConsent("portal");
  for (const user of [...Object.values(users), USERS.admin]) await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [user, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  await setting("vendor_account", { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] });
  await setting("vendor_activation", ACTIVATION_ON);
  await setting("vendor_documents", DOCUMENTS_ON);
  for (const org of [ORG_ID, ORG2_ID]) {
    await flags({ vendor_account: true, vendor_dispatch: true, vendor_workbench: true, brand_v2: true, brand_v3: true, vendor_activation: true, vendor_documents: true }, org);
  }
  contacts.a = await vendorContact(ORG_ID, "B-065 P1 A"); contacts.b = await vendorContact(ORG_ID, "B-065 P1 B");
  contacts.c = await vendorContact(ORG_ID, "B-065 P1 C (individual profile)"); contacts.d = await vendorContact(ORG_ID, "B-065 P1 D (no profile)");
  contacts.staff = await vendorContact(ORG_ID, "B-065 P1 staff vendor"); contacts.foreignB = await vendorContact(ORG2_ID, "B-065 P1 B in ORG2");
  for (const [session, contact, user, cred] of [[admin, contacts.a, users.a, creds.a], [admin, contacts.b, users.b, creds.b], [admin, contacts.c, users.c, creds.c],
    [admin, contacts.d, users.d, creds.d], [admin, contacts.staff, users.staff, creds.staff], [coast, contacts.foreignB, users.b, creds.b]] as const) {
    const invite = await inviteVendorAccount(session, contact, user);
    assert.equal(invite.status, "invited");
    assert.equal((await claimVendorAccount(cred, invite.invitation!)).status, "claimed");
  }
  // NFC input: 'é' decomposed (e + U+0301) and padded; the canonical inputs must be composed and trimmed.
  profiles.a = await profile(ORG_ID, contacts.a, { kind: "business", display: "安心", business: "  安心水電行 Café ", rep: "王小明", phone: "+886912000001", address: "台北市信義區信義路二段 65 號" });
  profiles.b = await profile(ORG_ID, contacts.b, { kind: "business", display: "好幫手", business: "好幫手工程行", phone: "+886912000002" });
  profiles.c = await profile(ORG_ID, contacts.c, { kind: "individual", display: "陳師傅", phone: "+886912000003" });
  profiles.foreignB = await profile(ORG2_ID, contacts.foreignB, { kind: "business", display: "好幫手", business: "好幫手工程行（海線）", phone: "+886912000004" });
  // Everyone is type 2 (免用統一發票之營業人) except where a test changes it; the staff vendor is declared while not staff.
  for (const [cred, org] of [[creds.a, ORG_ID], [creds.b, ORG_ID], [creds.c, ORG_ID], [creds.d, ORG_ID], [creds.staff, ORG_ID], [creds.b, ORG2_ID]] as const) {
    assert.equal((await saveVendorIssuerType(cred, org, { requestId: randomUUID(), issuerType: "exempt_business" })).status, "recorded");
  }
  await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, users.staff]);
  grantA = (await grant(ORG_ID, contacts.a, profiles.a)).scope;
  grantB = (await grant(ORG_ID, contacts.b, profiles.b)).scope;
  grantForeignB = (await grant(ORG2_ID, contacts.foreignB, profiles.foreignB)).scope;
});

test.after(async () => {
  if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

const GATEWAYS = ["app.b065_stamp_view(text,uuid,boolean)", "app.b065_stamp_preview_by_grant(text,uuid,uuid)", "app.b065_receipt_stamp(text,uuid,boolean)",
  "app.b065_receipt_stamp_by_grant(text,uuid,uuid)", "app.b065_save_stamp(text,uuid,boolean,uuid,text,text,text,text,integer[])",
  "app.b065_save_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,integer[])", "app.b065_consent_stamp(text,uuid,boolean,uuid,text,text,text,text,text,integer[])",
  "app.b065_consent_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,text,integer[])"];
const HELPERS = ["app.b065_svg_canonical(text)", "app.b065_stamp_version_guard()", "app.b065_stamp_consent_guard()", "app.b065_stamp_inputs(public.vendor_profiles)",
  "app.b065_inputs_sha256(jsonb)", "app.b065_inputs_fit(jsonb)", "app.b065_art_meta_ok(text,text,text,integer[])", "app.b065_grant_enabled(uuid)",
  "app.b065_stamp_account(text,uuid,boolean,boolean)", "app.b065_stamp_grant(text,uuid,uuid,boolean)", "app.b065_stamp_locks(uuid,uuid)",
  "app.b065_stamp_state(uuid,uuid,public.vendor_profiles,text)",
  "app.b065_stamp_write(text,text,uuid,uuid,uuid,uuid,public.vendor_profiles,uuid,text,text,text,text,text,integer[])"];
const TABLES = ["app.b065_stamp_versions", "app.b065_stamp_consents", "app.b065_stamp_requests"];

test("VEN-18 privileges: eight service-only gateways, every helper unexecutable, three tables fully revoked with RLS on; anon/authenticated cannot EXECUTE", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...GATEWAYS, ...HELPERS]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role" && GATEWAYS.includes(signature), `${role} ${signature}`);
    }
    for (const table of TABLES) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) ok", [role, table, privilege])).rows[0].ok, false, `${role} ${table} ${privilege}`);
      }
      assert.equal((await db.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') ok", [role, table])).rows[0].ok, false);
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0].relrowsecurity, true, table);
    }
    if (role !== "service_role") {
      for (const call of ["SELECT app.b065_stamp_view(NULL,NULL,false)", "SELECT app.b065_stamp_preview_by_grant(NULL,NULL,NULL)",
        "SELECT app.b065_save_stamp(NULL,NULL,false,NULL,NULL,NULL,NULL,NULL,NULL)", "SELECT app.b065_consent_stamp_by_grant(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
        "SELECT app.b065_receipt_stamp(NULL,NULL,false)", `SELECT 1 FROM ${TABLES[0]}`]) {
        await db.query("BEGIN");
        try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(call), { code: "42501" }, `${role}: ${call}`); }
        finally { await db.query("ROLLBACK"); }
      }
    }
  }
  const fns = (await db.query(`SELECT p.oid::regprocedure::text sig,p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p
    WHERE p.oid = ANY($1::regprocedure[])`, [[...GATEWAYS, ...HELPERS]])).rows;
  assert.equal(fns.length, GATEWAYS.length + HELPERS.length);
  for (const fn of fns) {
    if (fn.sig === "app.b065_svg_canonical(text)") { assert.deepEqual([fn.prosecdef, fn.provolatile], [false, "i"]); continue; }
    const writer = /b065_(save|consent)_stamp/.test(fn.sig);
    assert.deepEqual([fn.prosecdef, fn.provolatile, fn.proconfig], [true, "v", writer ? ["search_path=pg_catalog, pg_temp", "lock_timeout=3s"] : ["search_path=pg_catalog, pg_temp"]], fn.sig);
  }
  // The platform switch is still the phase A seed (OFF) on a fresh database; this clone turned it on for the tests.
  assert.equal((await db.query("SELECT count(*)::int n FROM platform_settings WHERE key='vendor_activation'")).rows[0].n, 1);
});

test("VEN-18-AC6/AC9/AC10 happy path (account): view → save v1 → consent → ready; one input algorithm, NFC and trimmed; audit without art", async () => {
  const empty = await vendorStampView(creds.a, ORG_ID);
  assert.equal(empty.state, "none"); assert.equal(empty.status, "needs_stamp"); assert.equal(empty.current, null); assert.deepEqual(empty.consents, []);
  assert.deepEqual(empty.inputs, { name: "安心水電行 Café", tax_id: "04595257", representative: "王小明", address: "台北市信義區信義路二段 65 號", phone_e164: "+886912000001" });
  assert.equal(empty.inputs!.name, "安心水電行 Café", "NFC composed");
  assert.equal(empty.inputsFit, true);
  const dbSha = (await db.query("SELECT app.b065_inputs_sha256(app.b065_stamp_inputs(p)) s, encode(sha256(convert_to(app.b065_stamp_inputs(p)::text,'UTF8')),'hex') t FROM vendor_profiles p WHERE id=$1", [profiles.a])).rows[0];
  assert.equal(empty.inputsSha256, dbSha.s); assert.equal(dbSha.s, dbSha.t);
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "needs_stamp");
  const request = randomUUID();
  const saved = await saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...artFor(1, empty.inputsSha256!) });
  assert.deepEqual(saved, { status: "recorded", version: 1, sha256: stampSha256(svgFor(1)), replayed: false });
  const stored = (await db.query("SELECT svg,inputs,inputs_sha256,font_id,generator_version,fallback_codepoints,vendor_profile_id::text FROM app.b065_stamp_versions WHERE contact_id=$1", [contacts.a])).rows[0];
  assert.deepEqual(stored, { svg: svgFor(1), inputs: empty.inputs, inputs_sha256: empty.inputsSha256, font_id: "lxgw-wenkai-tc-1.530-big5", generator_version: "d1-1",
    fallback_codepoints: [], vendor_profile_id: profiles.a }, "immutable art bytes plus the printed inputs");
  const generated = await vendorStampView(creds.a, ORG_ID);
  assert.equal(generated.state, "generated"); assert.equal(generated.status, "needs_consent");
  assert.deepEqual({ ...generated.current, createdAt: "" }, { version: 1, source: "generated", sha256: saved.status === "recorded" ? saved.sha256 : "", svg: svgFor(1), sealId: null, consented: false, createdAt: "" });
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "needs_consent");
  const consentRequest = randomUUID();
  assert.deepEqual(await consentLatest(creds.a, consentRequest), { status: "consented", version: 1, sha256: stampSha256(svgFor(1)), replayed: false });
  const consented = await vendorStampView(creds.a, ORG_ID);
  assert.equal(consented.state, "consented"); assert.equal(consented.status, "ready");
  assert.deepEqual(consented.consents.map(c => [c.version, c.kind, c.sha256]), [[1, "consented", stampSha256(svgFor(1))]]);
  const ready = await vendorReceiptStamp(creds.a, ORG_ID);
  assert.equal(ready.status, "ready"); assert.equal(ready.stamp!.version, 1); assert.equal(ready.stamp!.consentRequestId, consentRequest);
  assert.deepEqual(await consents(contacts.a), [{ version: 1, kind: "consented", consent_text: STAMP_CONSENT_TEXT, via: "account", consented_by: users.a, grant_id: null }]);
  const audit = (await db.query(`SELECT event_type,actor_user_id::text,actor_role,new_row,request_id FROM audit_log
    WHERE event_type LIKE 'vendor_stamp_%' AND row_id=$1 ORDER BY id`, [contacts.a])).rows;
  assert.deepEqual(audit, [
    { event_type: "vendor_stamp_generated", actor_user_id: users.a, actor_role: "vendor", new_row: { version: 1, sha256: stampSha256(svgFor(1)), source: "generated" }, request_id: request },
    { event_type: "vendor_stamp_consented", actor_user_id: users.a, actor_role: "vendor", new_row: { version: 1, sha256: stampSha256(svgFor(1)), source: "generated" }, request_id: consentRequest },
  ]);
  assert.deepEqual((await ledger(request))[0], { actor_id: users.a, via: "account", grant_id: null, contact_id: contacts.a, op: "save", answer: saved });
  // Consenting to the already-consented latest again: unchanged, reserved, no second consent.
  const again = randomUUID();
  assert.deepEqual(await consentLatest(creds.a, again), { status: "unchanged", version: 1, sha256: stampSha256(svgFor(1)), replayed: false });
  assert.equal((await consents(contacts.a)).length, 1);
  assert.equal((await ledger(again)).length, 1);
  // The same art for the same inputs again: unchanged, no new version (consent kept).
  assert.equal((await save(creds.a, 1)).status, "unchanged");
  assert.equal((await versions(contacts.a)).length, 1);
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "ready");
});

test("VEN-18 idempotency: exact replay returns the first answer; a retry changing only the SVG bytes (or any other field, or another vendor) is a conflict; nothing written", async () => {
  const sha = await inputsSha(creds.a);
  const request = randomUUID();
  const first = await saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...artFor(10, sha) });
  assert.equal(first.status, "recorded");
  const after = await snapshot();
  assert.deepEqual(await saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...artFor(10, sha) }), { ...first, replayed: true });
  for (const [label, changed] of [["svg bytes only", artFor(11, sha)], ["font", artFor(10, sha, { fontId: "other-font" })], ["generator", artFor(10, sha, { generatorVersion: "d1-2" })],
    ["fallback", artFor(10, sha, { fallbackCodepoints: [0x4e00] })], ["inputs digest", artFor(10, "0".repeat(64))]] as const) {
    assert.deepEqual(await saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...changed }), { status: "rejected_conflict" }, label);
  }
  assert.deepEqual(await saveVendorStamp(creds.b, ORG_ID, { requestId: request, ...artFor(10, await inputsSha(creds.b)) }), { status: "rejected_conflict" }, "another vendor");
  assert.deepEqual(await consentVendorStamp(creds.a, ORG_ID, { requestId: request, previewedSha256: stampSha256(svgFor(10)), art: null }), { status: "rejected_conflict" }, "another op");
  assert.deepEqual(await saveStampByGrant(grantA, { requestId: request, ...artFor(10, sha) }), { status: "rejected_conflict" }, "the same vendor through a document link");
  assert.deepEqual(await snapshot(), after);
  // Replay after a later change: still the first answer, no write.
  assert.equal((await save(creds.a, 12)).status, "recorded");
  const moved = await snapshot();
  assert.deepEqual(await saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...artFor(10, sha) }), { ...first, replayed: true });
  assert.deepEqual(await snapshot(), moved);
  // Consent replay, and a consent retry with other bytes.
  const consentRequest = randomUUID();
  const consented = await consentLatest(creds.a, consentRequest);
  assert.equal(consented.status, "consented");
  assert.deepEqual(await consentVendorStamp(creds.a, ORG_ID, { requestId: consentRequest, previewedSha256: stampSha256(svgFor(12)), art: null }), { ...consented, replayed: true });
  assert.deepEqual(await consentVendorStamp(creds.a, ORG_ID, { requestId: consentRequest, previewedSha256: stampSha256(svgFor(13)), art: artFor(13, sha) }), { status: "rejected_conflict" });
  // The same id in another org is a different request.
  assert.equal((await save(creds.b, 10, request, ORG2_ID)).status, "recorded");
});

test("VEN-18-AC9 consent rules: previewed sha must match the art, latest only (superseded refused), inputs must be current (stale refused); every refusal writes nothing", async () => {
  const sha = await inputsSha(creds.a);
  const v = async () => (await versions(contacts.a)).length;
  const n = await v();
  assert.equal((await save(creds.a, 20)).status, "recorded");
  assert.equal((await save(creds.a, 21)).status, "recorded");
  const before = await snapshot();
  const refusals: Array<[string, () => Promise<unknown>, string]> = [
    ["older version previewed", () => consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(20)), art: null }), "rejected_superseded"],
    ["older art supplied", () => consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(20)), art: artFor(20, sha) }), "rejected_superseded"],
    ["unknown sha, no art", () => consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: "a".repeat(64), art: null }), "rejected_invalid"],
    ["SQL: art whose sha is not the previewed sha", () => sqlConsent(hash(creds.a), randomUUID(), stampSha256(svgFor(21)), svgFor(22), sha), "rejected_invalid"],
    ["SQL: art supplied without the previewed sha", () => sqlConsent(hash(creds.a), randomUUID(), null, svgFor(22), sha), "rejected_invalid"],
    ["SQL: non-canonical art", () => sqlConsent(hash(creds.a), randomUUID(), stampSha256("<svg/>"), "<svg/>", sha), "rejected_invalid"],
    ["new art with a stale inputs digest", () => consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(23)), art: artFor(23, "b".repeat(64)) }), "rejected_stale"],
    ["save with a stale inputs digest", () => saveVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), ...artFor(24, "b".repeat(64)) }), "rejected_stale"],
    ["SQL: save with a <text> element", () => sqlSave(hash(creds.a), randomUUID(), svgFor(25).replace("</svg>", "<text>x</text></svg>"), sha), "rejected_invalid"],
    ["SQL: save with an external reference", () => sqlSave(hash(creds.a), randomUUID(), svgFor(25).replace("<path ", '<path href="https://x.test/a" '), sha), "rejected_invalid"],
    ["SQL: save with unsorted fallback", () => sqlSave(hash(creds.a), randomUUID(), svgFor(25), sha, [0x4e01, 0x4e00]), "rejected_invalid"],
    ["SQL: save without a request id", () => sqlSave(hash(creds.a), null, svgFor(25), sha), "rejected_invalid"],
    ["SQL: save over 512 KiB", () => sqlSave(hash(creds.a), randomUUID(), svgFor(25).replace("</svg>", `<path d="${"M1 1".repeat(131072)}"/></svg>`), sha), "rejected_invalid"],
  ];
  for (const [label, call, status] of refusals) {
    assert.equal(((await call()) as { status: string }).status, status, label);
    assert.deepEqual(await snapshot(), before, `${label}: no write, no reservation`);
  }
  // Stateless preview: unknown art for the current inputs is appended as n+1 and consented in one step.
  const stateless = await consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(26)), art: artFor(26, sha) });
  assert.deepEqual(stateless, { status: "consented", version: n + 3, sha256: stampSha256(svgFor(26)), replayed: false });
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "ready");
  // A profile change after consent makes it stale; consenting to the stale latest is refused; a fresh save then consent is ready.
  await db.query("UPDATE vendor_profiles SET address='台北市信義區信義路二段 66 號' WHERE id=$1", [profiles.a]);
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "stale");
  assert.equal((await vendorStampView(creds.a, ORG_ID)).state, "stale");
  const stale = await snapshot();
  assert.deepEqual(await consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(26)), art: null }), { status: "rejected_stale" },
    "consenting again to the (consented) latest after a profile change is refused as stale");
  assert.deepEqual(await snapshot(), stale);
  assert.equal((await save(creds.a, 27)).status, "recorded");
  await db.query("UPDATE vendor_profiles SET representative_name='王大明' WHERE id=$1", [profiles.a]);
  const beforeStale = await snapshot();
  assert.deepEqual(await consentLatest(creds.a), { status: "rejected_stale" }, "an unconsented latest generated for other inputs");
  assert.deepEqual(await snapshot(), beforeStale);
  assert.notDeepEqual(beforeStale, stale);
  assert.equal((await save(creds.a, 28)).status, "recorded");
  assert.equal((await consentLatest(creds.a)).status, "consented");
  assert.equal((await vendorReceiptStamp(creds.a, ORG_ID)).status, "ready");
});

test("VEN-18 readiness matrix: needs_tax_id (individual profile, no profile) / needs_stamp / needs_consent / stale / ready, account and grant agree", async () => {
  assert.equal((await vendorReceiptStamp(creds.c, ORG_ID)).status, "needs_tax_id", "individual profile: no tax id");
  assert.equal((await vendorReceiptStamp(creds.d, ORG_ID)).status, "needs_tax_id", "no profile");
  assert.equal((await vendorStampView(creds.d, ORG_ID)).inputs, null);
  const before = await snapshot();
  assert.deepEqual(await sqlSave(hash(creds.c), randomUUID(), svgFor(30), "c".repeat(64)), { status: "rejected_invalid", reason: "needs_tax_id" });
  assert.deepEqual(await sqlSave(hash(creds.d), randomUUID(), svgFor(30), "c".repeat(64)), { status: "rejected_invalid", reason: "needs_tax_id" });
  assert.deepEqual(await snapshot(), before);
  // B: needs_stamp → needs_consent → ready → stale, through the grant twins.
  const b = () => receiptStampByGrant(grantB);
  assert.equal((await b()).status, "needs_stamp");
  const preview0 = await stampPreviewByGrant(grantB);
  assert.deepEqual([preview0.status, preview0.latest, preview0.inputsFit], ["needs_stamp", null, true]);
  assert.equal(preview0.inputs!.name, "好幫手工程行");
  const request = randomUUID();
  assert.equal((await saveStampByGrant(grantB, { requestId: request, ...artFor(31, preview0.inputsSha256!) })).status, "recorded");
  assert.deepEqual(await ledger(request), [{ actor_id: null, via: "document_token", grant_id: (await grantId(grantB)), contact_id: contacts.b, op: "save",
    answer: { status: "recorded", version: 1, sha256: stampSha256(svgFor(31)), replayed: false } }]);
  assert.equal((await b()).status, "needs_consent");
  const preview1 = await stampPreviewByGrant(grantB);
  assert.deepEqual([preview1.latest!.svg, preview1.latest!.consented, "versionId" in preview1.latest!, "consents" in preview1], [svgFor(31), false, false, false]);
  assert.equal((await vendorReceiptStamp(creds.b, ORG_ID)).status, "needs_consent", "account and grant agree");
  assert.equal((await consentStampByGrant(grantB, { requestId: randomUUID(), previewedSha256: preview1.latest!.sha256, art: null })).status, "consented");
  assert.deepEqual(await consents(contacts.b), [{ version: 1, kind: "consented", consent_text: STAMP_CONSENT_TEXT, via: "document_token", consented_by: null, grant_id: await grantId(grantB) }]);
  assert.equal((await b()).status, "ready");
  assert.equal((await vendorReceiptStamp(creds.b, ORG_ID)).status, "ready");
  await db.query("UPDATE vendor_profiles SET business_name='好幫手工程有限公司' WHERE id=$1", [profiles.b]);
  assert.equal((await b()).status, "stale");
  assert.equal((await stampPreviewByGrant(grantB)).latest!.consented, true, "the art stays visible while stale");
  assert.equal((await vendorReceiptStamp(creds.b, ORG_ID)).status, "stale");
});
const grantId = async (scope: StampGrantScope) => (await db.query("SELECT id::text FROM vendor_document_grants WHERE token_hash=$1", [hashVendorToken(scope.token)])).rows[0].id as string;

test("VEN-18 isolation: same-org different vendor and cross-org are denied or see only their own stamp; tokens are scoped to their profile", async () => {
  const aView = await vendorStampView(creds.a, ORG_ID), aSha = aView.current!.sha256;
  const bView = await vendorStampView(creds.b, ORG_ID);
  assert.notEqual(bView.current?.sha256, aSha);
  assert.ok(!JSON.stringify(bView).includes(aSha), "B's view never shows A's art or consents");
  const before = await snapshot();
  // B cannot consent to A's art: it is not B's version, and B never sees A's history.
  assert.deepEqual(await consentVendorStamp(creds.b, ORG_ID, { requestId: randomUUID(), previewedSha256: aSha, art: null }), { status: "rejected_invalid" });
  assert.deepEqual(await consentStampByGrant(grantB, { requestId: randomUUID(), previewedSha256: aSha, art: null }), { status: "rejected_invalid" });
  // Tokens: A's token with B's profile, B's token with A's profile, a foreign token in ORG_ID, a token in the wrong org.
  for (const [label, scope] of [["A's token on B's profile", { ...grantA, profileId: profiles.b }], ["B's token on A's profile", { ...grantB, profileId: profiles.a }],
    ["ORG2 token in ORG_ID", { ...grantForeignB, orgId: ORG_ID }], ["A's token in ORG2", { ...grantA, orgId: ORG2_ID }],
    ["A's token on the ORG2 profile", { ...grantA, orgId: ORG2_ID, profileId: profiles.foreignB }], ["an unknown token", { ...grantA, token: randomBytes(32).toString("base64url") }],
    ["a malformed token", { ...grantA, token: "short" }]] as const) {
    await assert.rejects(stampPreviewByGrant(scope), forbidden, `${label}: preview`);
    await assert.rejects(receiptStampByGrant(scope), forbidden, `${label}: readiness`);
    await assert.rejects(saveStampByGrant(scope, { requestId: randomUUID(), ...artFor(40, "d".repeat(64)) }), forbidden, `${label}: save`);
    await assert.rejects(consentStampByGrant(scope, { requestId: randomUUID(), previewedSha256: aSha, art: null }), forbidden, `${label}: consent`);
  }
  // Cross-org: A holds no account in ORG2; B's ORG2 stamp state is separate from B's ORG_ID one.
  await assert.rejects(vendorStampView(creds.a, ORG2_ID), forbidden);
  await assert.rejects(save(creds.a, 41, randomUUID(), ORG2_ID), forbidden);
  const foreign = await stampPreviewByGrant(grantForeignB);
  assert.equal(foreign.inputs!.name, "好幫手工程行（海線）");
  assert.ok(!JSON.stringify(foreign).includes(bView.current?.sha256 ?? "none"));
  // The account session never works as a token and vice versa.
  await assert.rejects(vendorStampView(grantA.token, ORG_ID), forbidden, "a document token as the session");
  await assert.rejects(stampPreviewByGrant({ ...grantA, token: creds.a.replace(/-/g, "") }), forbidden, "a session credential as the token");
  assert.deepEqual(await snapshot(), before);
});

test("VEN-18 refusals write nothing: staff, type 1/3 and undeclared, revoked/expired grant or session, every gate OFF (vendor_activation first)", async () => {
  const sha = await inputsSha(creds.a);
  const persisted = randomUUID();
  assert.equal((await saveVendorStamp(creds.a, ORG_ID, { requestId: persisted, ...artFor(50, sha) })).status, "recorded");
  const deny = async (label: string, cred: string, scope: StampGrantScope = grantA, opts: { account?: boolean; grant?: boolean } = { account: true, grant: true }) => {
    const before = await snapshot();
    if (opts.account) {
      await assert.rejects(vendorStampView(cred, ORG_ID), forbidden, `${label}: view`);
      await assert.rejects(vendorReceiptStamp(cred, ORG_ID), forbidden, `${label}: readiness`);
      await assert.rejects(saveVendorStamp(cred, ORG_ID, { requestId: randomUUID(), ...artFor(51, sha) }), forbidden, `${label}: save`);
      await assert.rejects(saveVendorStamp(cred, ORG_ID, { requestId: persisted, ...artFor(50, sha) }), forbidden, `${label}: a persisted replay does not bypass admission`);
      await assert.rejects(sqlSave(hash(cred), randomUUID(), "not svg", "x"), refused, `${label}: an invalid body is still refused first`);
      await assert.rejects(consentVendorStamp(cred, ORG_ID, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(50)), art: null }), forbidden, `${label}: consent`);
    }
    if (opts.grant) {
      await assert.rejects(stampPreviewByGrant(scope), forbidden, `${label}: grant preview`);
      await assert.rejects(receiptStampByGrant(scope), forbidden, `${label}: grant readiness`);
      await assert.rejects(saveStampByGrant(scope, { requestId: randomUUID(), ...artFor(52, sha) }), forbidden, `${label}: grant save`);
      await assert.rejects(consentStampByGrant(scope, { requestId: randomUUID(), previewedSha256: stampSha256(svgFor(50)), art: null }), forbidden, `${label}: grant consent`);
    }
    assert.deepEqual(await snapshot(), before, `${label}: no writes`);
  };
  await deny("staff session with no vendor account", creds.admin, grantA, { account: true });
  await deny("staff member who also holds a vendor account", creds.staff, grantA, { account: true });
  const declare = async (type: IssuerType) => assert.ok(["recorded", "unchanged"].includes((await saveVendorIssuerType(creds.a, ORG_ID, { requestId: randomUUID(), issuerType: type })).status));
  for (const type of ["individual", "invoice_business"] as const) {
    await declare(type);
    try { await deny(`type ${type}`, creds.a); } finally { await declare("exempt_business"); }
  }
  // Undeclared: a new vendor with a business profile and an account but no declaration.
  const userE = randomUUID(), credE = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b065p1-e@example.test',now())", [userE]);
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [userE, hash(credE)]);
  const consent = buildStoredConsent("portal");
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)", [userE, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const contactE = await vendorContact(ORG_ID, "B-065 P1 E (undeclared)");
  const invite = await inviteVendorAccount(admin, contactE, userE);
  assert.equal((await claimVendorAccount(credE, invite.invitation!)).status, "claimed");
  const profileE = await profile(ORG_ID, contactE, { kind: "business", display: "E", business: "E 行", phone: "+886912000005" });
  await deny("never declared", credE, (await grant(ORG_ID, contactE, profileE)).scope);
  // Grants: revoked, expired.
  const revoked = await grant(ORG_ID, contacts.a, profiles.a);
  await db.query("UPDATE vendor_document_grants SET revoked_at=clock_timestamp() WHERE id=$1", [revoked.id]);
  await deny("revoked grant", creds.a, revoked.scope, { grant: true });
  const expired = await grant(ORG_ID, contacts.a, profiles.a, { expiresIn: "-1 second" });
  await deny("expired grant", creds.a, expired.scope, { grant: true });
  const revokedSession = randomUUID();
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,clock_timestamp()+interval '1 hour',clock_timestamp())", [users.a, hash(revokedSession)]);
  await deny("revoked session", revokedSession, grantA, { account: true });
  const gates: Array<[string, () => Promise<unknown>, () => Promise<unknown>, { account?: boolean; grant?: boolean }]> = [
    ["vendor_activation platform OFF (the seeded state)", () => setting("vendor_activation", { enabled: false, allowed_org_ids: [] }), () => setting("vendor_activation", ACTIVATION_ON), { account: true, grant: true }],
    ["vendor_activation org flag OFF", () => flags({ vendor_activation: false }), () => flags({ vendor_activation: true }), { account: true, grant: true }],
    ["vendor_activation platform org not allowed", () => setting("vendor_activation", { enabled: true, allowed_org_ids: [ORG2_ID] }), () => setting("vendor_activation", ACTIVATION_ON), { account: true, grant: true }],
    ["vendor_activation platform row missing", () => db.query("DELETE FROM platform_settings WHERE key='vendor_activation'"), () => setting("vendor_activation", ACTIVATION_ON), { account: true, grant: true }],
    ["vendor_documents platform OFF", () => setting("vendor_documents", { enabled: false, allowed_org_ids: [] }), () => setting("vendor_documents", DOCUMENTS_ON), { grant: true }],
    ["vendor_documents org flag OFF", () => flags({ vendor_documents: false }), () => flags({ vendor_documents: true }), { grant: true }],
    ["vendor_workbench OFF", () => flags({ vendor_workbench: false }), () => flags({ vendor_workbench: true }), { account: true }],
    ["brand_v3 OFF", () => flags({ brand_v3: false }), () => flags({ brand_v3: true }), { account: true }],
    ["B-026 platform OFF", () => setting("vendor_account", { enabled: false, allowed_org_ids: [] }), () => setting("vendor_account", { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] }), { account: true }],
    ["contact archived", () => db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contacts.a]), () => db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contacts.a]), { account: true, grant: true }],
  ];
  for (const [label, apply, restore, opts] of gates) {
    await apply();
    try { await deny(label, creds.a, grantA, opts); } finally { await restore(); }
  }
  // Every gate restored: both paths admit again, and the persisted id replays.
  assert.equal((await saveVendorStamp(creds.a, ORG_ID, { requestId: persisted, ...artFor(50, sha) })).status, "recorded");
  assert.equal((await stampPreviewByGrant(grantA)).status.length > 0, true);
});

test("VEN-18 schema guards: versions, consents and the ledger are immutable; consent text CHECK; no consent to a superseded version; contiguous versions", async () => {
  for (const table of TABLES) {
    await assert.rejects(db.query(`UPDATE ${table} SET org_id=org_id WHERE org_id=$1`, [ORG_ID]), { code: "55000" }, `${table} update`);
    await assert.rejects(db.query(`DELETE FROM ${table} WHERE org_id=$1`, [ORG_ID]), { code: "55000" }, `${table} delete`);
    await assert.rejects(db.query(`TRUNCATE ${table} CASCADE`), { code: "55000" }, `${table} truncate`);
  }
  const rows = (await db.query("SELECT id::text,version FROM app.b065_stamp_versions WHERE contact_id=$1 ORDER BY version", [contacts.a])).rows;
  assert.ok(rows.length >= 2);
  assert.deepEqual(rows.map(r => r.version), rows.map((_, i) => i + 1), "contiguous from 1");
  const latest = rows[rows.length - 1], older = rows[0];
  const insertConsent = (versionId: string, text: string | null, kind = "consented") => db.query(`INSERT INTO app.b065_stamp_consents(org_id,request_id,stamp_version_id,contact_id,kind,consent_text,consented_by,via)
    VALUES($1,$2,$3,$4,$5,$6,$7,'account')`, [ORG_ID, randomUUID(), versionId, contacts.a, kind, text, users.a]);
  await db.query("BEGIN");
  try {
    await assert.rejects(insertConsent(older.id, STAMP_CONSENT_TEXT), { code: "23514" }, "superseded version");
    await db.query("ROLLBACK"); await db.query("BEGIN");
    for (const text of [null, "我同意", `${STAMP_CONSENT_TEXT} `]) {
      await db.query("SAVEPOINT s");
      await assert.rejects(insertConsent(latest.id, text), { code: "23514" }, `consent text ${text}`);
      await db.query("ROLLBACK TO SAVEPOINT s");
    }
    await db.query("SAVEPOINT s");
    await assert.rejects(insertConsent(latest.id, null, "adopted_upload"), { code: "23514" }, "upload consent on generated art");
    await db.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(db.query(`INSERT INTO app.b065_stamp_versions(org_id,contact_id,vendor_profile_id,version,request_id,source,svg,sha256,inputs,inputs_sha256,font_id,generator_version,created_by,created_via)
      SELECT org_id,contact_id,vendor_profile_id,version+2,gen_random_uuid(),source,svg,sha256,inputs,inputs_sha256,font_id,generator_version,created_by,created_via
      FROM app.b065_stamp_versions WHERE id=$1`, [latest.id]), { code: "23514" }, "a gap in versions");
  } finally { await db.query("ROLLBACK"); }
  await db.query("BEGIN");
  try {
    await assert.rejects(db.query(`INSERT INTO app.b065_stamp_versions(org_id,contact_id,vendor_profile_id,version,request_id,source,svg,sha256,inputs,inputs_sha256,font_id,generator_version,created_by,created_via)
      SELECT org_id,$2,vendor_profile_id,1+(SELECT count(*) FROM app.b065_stamp_versions WHERE contact_id=$2),gen_random_uuid(),source,svg,sha256,inputs,inputs_sha256,font_id,generator_version,created_by,created_via
      FROM app.b065_stamp_versions WHERE id=$1`, [latest.id, contacts.d]), { code: "23514" }, "another vendor's profile under this contact");
  } finally { await db.query("ROLLBACK"); }
  await db.query("BEGIN");
  try {
    await assert.rejects(db.query(`INSERT INTO app.b065_stamp_versions(org_id,contact_id,vendor_profile_id,version,request_id,source,svg,sha256,inputs,inputs_sha256,font_id,generator_version,created_by,created_via)
      SELECT org_id,contact_id,vendor_profile_id,version+1,gen_random_uuid(),source,svg,repeat('0',64),inputs,inputs_sha256,font_id,generator_version,created_by,created_via
      FROM app.b065_stamp_versions WHERE id=$1`, [latest.id]), { code: "23514" }, "sha256 must be the art's digest");
  } finally { await db.query("ROLLBACK"); }
});

/** Waits until `n` backends in this database are blocked by the holder while running a B-065 stamp gateway. */
async function waitForBlocked(lock: Client, n: number) {
  const holderPid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  for (let i = 0; i < 100; i++) {
    const blocked = (await db.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%app.b065\\_%stamp%'`, [holderPid])).rows[0].n;
    if (blocked >= n) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`expected ${n} stamp writer(s) blocked by ${holderPid}`);
}
async function holder() {
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query("BEGIN");
  return client;
}
type Outcome = { result?: { status: string; version?: number }; error?: unknown };
const settle = (p: Promise<unknown>) => p.then(result => ({ result }) as Outcome, error => ({ error }) as Outcome);
const ORG_MUTEX = "SELECT pg_advisory_xact_lock(hashtextextended('b065/stamp-org/'||$1::text,0))";
const WAIT_TEST = { timeout: 120000 };

test("VEN-18 serialization: distinct request ids queue on the per-org mutex → contiguous versions; save vs consent never consents a superseded version", WAIT_TEST, async () => {
  const sha = await inputsSha(creds.a);
  const start = (await versions(contacts.a)).length;
  let lock = await holder();
  let runs: Promise<Outcome>[] = [];
  try {
    await lock.query(ORG_MUTEX, [ORG_ID]);
    runs = [saveVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), ...artFor(60, sha) }), saveVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), ...artFor(61, sha) })].map(settle);
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const saves = await Promise.all(runs);
  assert.deepEqual(saves.map(o => o.result?.status), ["recorded", "recorded"], JSON.stringify(saves.map(o => String(o.error))));
  assert.deepEqual(saves.map(o => o.result!.version).sort(), [start + 1, start + 2]);
  assert.deepEqual((await versions(contacts.a)).map(v => v.version), Array.from({ length: start + 2 }, (_, i) => i + 1));
  // A different org's mutex does not block ORG_ID.
  lock = await holder();
  try {
    await lock.query(ORG_MUTEX, [ORG2_ID]);
    assert.equal((await save(creds.a, 62)).status, "recorded");
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  // Save (queued first) vs a consent to the then-latest art (queued second).
  const latestSha = (await vendorStampView(creds.a, ORG_ID)).current!.sha256;
  lock = await holder();
  try {
    await lock.query(ORG_MUTEX, [ORG_ID]);
    runs = [settle(saveVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), ...artFor(63, sha) }))];
    await waitForBlocked(lock, 1);
    runs.push(settle(consentVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), previewedSha256: latestSha, art: null })));
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const [saved, consented] = await Promise.all(runs);
  assert.equal(saved.result?.status, "recorded");
  assert.equal(consented.result?.status, "rejected_superseded", "the consent ran after the save: its art is no longer the latest");
  assert.equal((await vendorStampView(creds.a, ORG_ID)).status, "needs_consent");
  const consentedVersions = (await consents(contacts.a)).map(c => c.version);
  assert.ok(!consentedVersions.includes(saved.result!.version! - 1), "no consent to the superseded version");
});

test("VEN-18 interleaving: a consent waiting on the profile row sees the committed profile change → rejected_stale, nothing written", WAIT_TEST, async () => {
  const sha = await inputsSha(creds.b);
  assert.equal((await saveVendorStamp(creds.b, ORG_ID, { requestId: randomUUID(), ...artFor(70, sha) })).status, "recorded");
  const previewed = stampSha256(svgFor(70));
  for (const [label, run] of [
    ["account", () => consentVendorStamp(creds.b, ORG_ID, { requestId: randomUUID(), previewedSha256: previewed, art: null })],
    ["grant", () => consentStampByGrant(grantB, { requestId: randomUUID(), previewedSha256: previewed, art: null })],
  ] as const) {
    const lock = await holder();
    let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
    try {
      await lock.query("SELECT 1 FROM vendor_profiles WHERE id=$1 FOR UPDATE", [profiles.b]);
      pending = settle(run());
      await waitForBlocked(lock, 1);
      await lock.query("UPDATE vendor_profiles SET address=coalesce(address,'')||'之一' WHERE id=$1", [profiles.b]);
      expected = await snapshot(lock);
      await lock.query("COMMIT");
    } finally { await lock.end(); }
    const outcome = await pending!;
    assert.deepEqual(outcome.result, { status: "rejected_stale" }, `${label}: ${String(outcome.error)}`);
    assert.deepEqual(await snapshot(), expected, `${label}: no writes`);
  }
  // Positive control: a fresh save for the new inputs, then consent.
  assert.equal((await save(creds.b, 71)).status, "recorded");
  assert.equal((await consentLatest(creds.b)).status, "consented");
});

test("VEN-18 waits: admission changing during a mutex or grant-row wait refuses with no write; two vendors sharing a request id → one recorded, one conflict; a held mutex past 3s is busy", WAIT_TEST, async () => {
  // Session revoked while the save waits on the org mutex.
  const cred = randomUUID();
  const session = (await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id", [users.a, hash(cred)])).rows[0].id;
  const sha = await inputsSha(creds.a);
  const blocked = async (label: string, start: () => Promise<unknown>, during: (c: Client) => Promise<unknown>, restore: () => Promise<unknown>, lockSql = ORG_MUTEX, lockArgs: unknown[] = [ORG_ID]) => {
    const lock = await holder();
    let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
    try {
      await lock.query(lockSql, lockArgs);
      pending = settle(start());
      await waitForBlocked(lock, 1);
      await during(lock);
      expected = await snapshot(lock);
      await lock.query("COMMIT");
    } finally { await lock.end(); }
    const outcome = await pending!;
    try {
      assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result ?? String(outcome.error))}`);
      assert.deepEqual(await snapshot(), expected, `${label}: no writes`);
    } finally { await restore(); }
  };
  await blocked("mutex: session revoked", () => saveVendorStamp(cred, ORG_ID, { requestId: randomUUID(), ...artFor(80, sha) }),
    c => c.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [session]), async () => {});
  await blocked("mutex: vendor_activation turned OFF", () => saveVendorStamp(creds.a, ORG_ID, { requestId: randomUUID(), ...artFor(81, sha) }),
    c => flags({ vendor_activation: false }, ORG_ID, c), () => flags({ vendor_activation: true }));
  await blocked("mutex: declared type 1", () => consentLatest(creds.a),
    () => saveVendorIssuerType(creds.a, ORG_ID, { requestId: randomUUID(), issuerType: "individual" }).then(r => assert.equal(r.status, "recorded")),
    () => saveVendorIssuerType(creds.a, ORG_ID, { requestId: randomUUID(), issuerType: "exempt_business" }));
  const g = await grant(ORG_ID, contacts.a, profiles.a);
  await blocked("grant row: revoked during the wait", () => saveStampByGrant(g.scope, { requestId: randomUUID(), ...artFor(82, sha) }),
    c => c.query("UPDATE vendor_document_grants SET revoked_at=clock_timestamp() WHERE id=$1", [g.id]), async () => {},
    "SELECT 1 FROM vendor_document_grants WHERE id=$1 FOR UPDATE", [g.id]);
  // Two vendors sharing one request id.
  const request = randomUUID();
  const lock = await holder();
  let runs: Promise<Outcome>[] = [];
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/stamp-req/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
    runs = [saveVendorStamp(creds.a, ORG_ID, { requestId: request, ...artFor(83, sha) }), saveVendorStamp(creds.b, ORG_ID, { requestId: request, ...artFor(83, await inputsSha(creds.b)) })].map(settle);
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const outcomes = await Promise.all(runs);
  assert.deepEqual(outcomes.map(o => o.result?.status).sort(), ["recorded", "rejected_conflict"], JSON.stringify(outcomes.map(o => String(o.error))));
  assert.equal((await ledger(request)).length, 1);
  // The mutex held longer than lock_timeout (3s): busy, nothing written, nothing reserved.
  const held = await holder();
  const busyRequest = randomUUID();
  let before: Record<string, string> | undefined;
  try {
    await held.query(ORG_MUTEX, [ORG_ID]);
    before = await snapshot();
    assert.deepEqual(await saveVendorStamp(creds.a, ORG_ID, { requestId: busyRequest, ...artFor(84, sha) }), { status: "busy" });
  } finally { await held.query("COMMIT").catch(() => undefined); await held.end(); }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await ledger(busyRequest), []);
  assert.equal((await saveVendorStamp(creds.a, ORG_ID, { requestId: busyRequest, ...artFor(84, sha) })).status, "recorded", "the same id retries once free");
});
