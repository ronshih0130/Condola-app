import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { POST as saveRoute } from "../app/api/vendor-account/address/route";
import { buildStoredConsent } from "./consent";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { claimVendorAccount, inviteVendorAccount } from "./vendor-accounts";
import { saveVendorAddress, vendorAddressView, type AddressParts } from "./b112-vendor-address";

// B-112 on a cloned disposable database: the real B-026 invite/claim, the real app.b112_* gateways and the real route.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin", kind: "staff",
  name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const vendorA = randomUUID(), vendorB = randomUUID();
const credA = randomUUID(), credB = randomUUID(), staffCred = randomUUID();
let contactA = "", contactB = "", profileA = "", profileB = "", sealId = "";
const brandEnv = process.env.BRAND_V2;

async function vendorContact(org: string, name: string) {
  return (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,$2,'+886912345678') RETURNING id::text", [org, name])).rows[0].id as string;
}
async function profile(org: string, contact: string, kind: "business" | "individual", address: string, phone: string) {
  return (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at)
    VALUES($1,$2,'B112',$3,'王師傅水電',CASE WHEN $3='business' THEN '王師傅水電行' END,CASE WHEN $3='business' THEN '王' END,
      CASE WHEN $3='business' THEN '04595257' END,$5,$4,now()) RETURNING id::text`, [org, contact, kind, address, phone])).rows[0].id as string;
}
async function flags(patch: Record<string, unknown>, org = ORG_ID) {
  await db.query("UPDATE organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
}
async function accountGate(enabled: boolean) {
  await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_account'", [JSON.stringify({ enabled, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
}
/** Everything a B-112 writer could change. */
async function snapshot() {
  const out: Record<string, string> = {};
  for (const table of ["public.vendor_profiles", "public.vendor_profile_versions", "app.b112_address_saves", "public.audit_log"]) {
    out[table] = (await db.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const parts = (number: string): AddressParts => ({ city: "台北市", district: "信義區", street: "信義路二段", number });
const save = (cred: string, org: string, expectedVersion: number, number: string, requestId = randomUUID()) =>
  saveVendorAddress(cred, org, { requestId, expectedVersion, parts: parts(number) });
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
const sqlSave = (credHash: string, org: string, version: number, address: string, request = randomUUID()) => svc(null, async client =>
  (await client.query("SELECT app.b112_save_vendor_address($1,$2::uuid,false,$3::uuid,$4,$5) r", [credHash, org, request, version, address])).rows[0].r);
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501";
const versionOf = async (id: string) => (await db.query("SELECT current_version,address FROM vendor_profiles WHERE id=$1", [id])).rows[0];
const post = (body: unknown, cookie?: string, headers: Record<string, string> = {}) => saveRoute(new Request(`${origin}/api/vendor-account/address`, {
  method: "POST", body: JSON.stringify(body),
  headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }));

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  delete process.env.BRAND_V2;
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b112a@example.test',now()),($2,'b112b@example.test',now())", [vendorA, vendorB]);
  for (const [id, user, cred] of [[admin.sessionId, admin.userId, staffCred], [coast.sessionId, coast.userId, randomUUID()], [randomUUID(), vendorA, credA], [randomUUID(), vendorB, credB]]) {
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, user, hash(cred)]);
  }
  const consent = buildStoredConsent("portal");
  for (const user of [vendorA, vendorB, admin.userId]) await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [user, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  await accountGate(true);
  for (const org of [ORG_ID, ORG2_ID]) await flags({ vendor_account: true, vendor_dispatch: true, vendor_workbench: true, brand_v2: true, brand_v3: true }, org);
  contactA = await vendorContact(ORG_ID, "B-112 A"); contactB = await vendorContact(ORG_ID, "B-112 B");
  const foreign = await vendorContact(ORG2_ID, "B-112 B in ORG2");
  for (const [session, contact, user, cred] of [[admin, contactA, vendorA, credA], [admin, contactB, vendorB, credB], [coast, foreign, vendorB, credB]] as const) {
    const invite = await inviteVendorAccount(session, contact, user);
    assert.equal(invite.status, "invited");
    assert.equal((await claimVendorAccount(cred, invite.invitation!)).status, "claimed");
  }
  // A: a versioned business profile whose current version holds a seal reference; B: a zero-history individual.
  profileA = await profile(ORG_ID, contactA, "business", "台北市信義區信義路二段 1 號", "+886912000001");
  sealId = (await db.query(`INSERT INTO app.b025_profile_seals(org_id,vendor_profile_id,mime_type,bytes,sha256)
    VALUES($1,$2,'image/png','\\x89504e47'::bytea,encode(sha256('\\x89504e47'::bytea),'hex')) RETURNING id::text`, [ORG_ID, profileA])).rows[0].id;
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,snapshot)
    SELECT org_id,id,1,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,
      jsonb_build_object('confirmation_method','document_token','seal',jsonb_build_object('id',$2::text,'sha256',encode(sha256('\\x89504e47'::bytea),'hex')))
    FROM vendor_profiles WHERE id=$1`, [profileA, sealId]);
  profileB = await profile(ORG_ID, contactB, "individual", "新竹縣竹北市光明六路 10 號", "+886912000002");
});

test.after(async () => {
  if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("privileges: gateways service-only, helpers unexecutable, the ledger fully revoked with RLS on", async () => {
  const gateways = ["app.b112_vendor_address(text,uuid,boolean)", "app.b112_save_vendor_address(text,uuid,boolean,uuid,integer,text)"];
  const helpers = ["app.b112_enabled(uuid,boolean)", "app.b112_account_profile(text,uuid,boolean,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role" && gateways.includes(signature), `${role} ${signature}`);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.b112_address_saves',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
    }
    assert.equal((await db.query("SELECT has_any_column_privilege($1,'app.b112_address_saves','SELECT,INSERT,UPDATE,REFERENCES') ok", [role])).rows[0].ok, false);
    await db.query("BEGIN");
    try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query("SELECT 1 FROM app.b112_address_saves"), { code: "42501" }); }
    finally { await db.query("ROLLBACK"); }
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b112_address_saves'::regclass")).rows[0].relrowsecurity, true);
});

test("read: each vendor sees only their own profile in the org they hold an account in", async () => {
  assert.deepEqual(await vendorAddressView(credA, ORG_ID), { profileId: profileA, version: 1, kind: "business", address: "台北市信義區信義路二段 1 號" });
  assert.deepEqual(await vendorAddressView(credB, ORG_ID), { profileId: profileB, version: 1, kind: "individual", address: "新竹縣竹北市光明六路 10 號" });
  assert.equal(await vendorAddressView(credB, ORG2_ID), null, "an account without a profile shows no card");
  await assert.rejects(vendorAddressView(credA, ORG2_ID), forbidden, "no account in that org");
  await assert.rejects(vendorAddressView(staffCred, ORG_ID), forbidden, "a staff session is not a vendor account");
});

test("save: one new profile version with the seal carried forward, one ledger row, one audit row", async () => {
  const before = await db.query("SELECT * FROM vendor_profile_versions WHERE vendor_profile_id=$1 ORDER BY version", [profileA]);
  const request = randomUUID();
  const result = await save(credA, ORG_ID, 1, "5 號", request);
  assert.deepEqual(result, { status: "recorded", version: 2, address: "台北市信義區信義路二段 5 號", replayed: false });
  assert.deepEqual(await versionOf(profileA), { current_version: 2, address: "台北市信義區信義路二段 5 號" });
  const versions = (await db.query("SELECT * FROM vendor_profile_versions WHERE vendor_profile_id=$1 ORDER BY version", [profileA])).rows;
  assert.deepEqual(versions[0], before.rows[0], "the issued version is untouched (VEN-18-AC6)");
  assert.equal(versions[1].address, "台北市信義區信義路二段 5 號");
  assert.deepEqual(versions[1].snapshot, { confirmation_method: "vendor_account", seal: versions[0].snapshot.seal });
  assert.equal(versions[1].snapshot.seal.id, sealId);
  assert.equal(versions[1].display_name, versions[0].display_name); assert.equal(versions[1].tax_id, versions[0].tax_id);
  const ledger = (await db.query("SELECT user_id::text,vendor_profile_id::text,version,address FROM app.b112_address_saves WHERE request_id=$1", [request])).rows;
  assert.deepEqual(ledger, [{ user_id: vendorA, vendor_profile_id: profileA, version: 2, address: "台北市信義區信義路二段 5 號" }]);
  const audit = (await db.query("SELECT actor_user_id::text,actor_role,table_name,row_id,action::text,event_type,new_row,request_id FROM audit_log WHERE event_type='vendor_account_address' AND row_id=$1", [profileA])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual({ ...audit[0], new_row: undefined }, { actor_user_id: vendorA, actor_role: "vendor", table_name: "vendor_profiles", row_id: profileA,
    action: "update", event_type: "vendor_account_address", new_row: undefined, request_id: request });
  assert.equal(audit[0].new_row.version, 2);

  // Zero-history individual: the first version is written from the live row.
  assert.equal((await save(credB, ORG_ID, 1, "12 號")).status, "recorded");
  const b = (await db.query("SELECT version,snapshot,seal_file_id FROM vendor_profile_versions WHERE vendor_profile_id=$1", [profileB])).rows;
  assert.deepEqual(b, [{ version: 2, snapshot: { confirmation_method: "vendor_account" }, seal_file_id: null }]);
});

test("idempotent: a replay is the first answer; a stale or another vendor's request id writes nothing; unchanged is no write", async () => {
  const { current_version: version } = await versionOf(profileA);
  const request = randomUUID();
  const first = await save(credA, ORG_ID, version, "7 號", request);
  assert.equal(first.status, "recorded");
  const after = await snapshot();
  assert.deepEqual(await save(credA, ORG_ID, version, "7 號", request), { ...first, replayed: true });
  assert.deepEqual(await save(credA, ORG_ID, version, "99 號", request), { ...first, replayed: true }, "same request, other body: still the first");
  assert.deepEqual(await save(credB, ORG_ID, 2, "7 號", request), { status: "rejected_conflict" }, "another vendor cannot reuse it");
  assert.deepEqual(await save(credA, ORG_ID, version, "8 號"), { status: "rejected_stale" });
  assert.deepEqual(await save(credA, ORG_ID, version + 1, "7 號"), { status: "unchanged", version: version + 1, address: "台北市信義區信義路二段 7 號" });
  assert.deepEqual(await sqlSave(hash(credA), ORG_ID, version + 1, "  "), { status: "rejected_invalid" });
  assert.deepEqual(await sqlSave(hash(credA), ORG_ID, version + 1, "台北市\u0007"), { status: "rejected_invalid" });
  assert.deepEqual(await snapshot(), after);
});

test("denials write nothing: token-only bearer, revoked or expired session, staff, other org, and every gate OFF", async () => {
  const jobToken = randomBytes(32).toString("base64url");
  const revoked = randomUUID(), expired = randomUUID();
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,clock_timestamp()+interval '1 hour',clock_timestamp())", [vendorA, hash(revoked)]);
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()-interval '1 second')", [vendorA, hash(expired)]);
  const { current_version: version } = await versionOf(profileA);
  const deny = async (label: string, cred: string, org = ORG_ID) => {
    const before = await snapshot();
    await assert.rejects(save(cred, org, version, "404 號"), forbidden, `${label}: save`);
    await assert.rejects(sqlSave(hash(cred), org, version, "台北市信義區信義路二段 404 號"), refused, `${label}: SQL save`);
    await assert.rejects(vendorAddressView(cred, org), forbidden, `${label}: read`);
    assert.deepEqual(await snapshot(), before, `${label}: no writes`);
  };
  await deny("job token as a credential", jobToken);
  await deny("revoked session", revoked);
  await deny("expired session", expired);
  await deny("staff session", staffCred);
  await deny("vendor A in an org with no account of theirs", credA, ORG2_ID);
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["vendor_workbench off", () => flags({ vendor_workbench: false }), () => flags({ vendor_workbench: true })],
    ["vendor_workbench absent", () => db.query("UPDATE organizations SET feature_flags=feature_flags-'vendor_workbench' WHERE id=$1", [ORG_ID]), () => flags({ vendor_workbench: true })],
    ["vendor_workbench \"true\"", () => flags({ vendor_workbench: "true" }), () => flags({ vendor_workbench: true })],
    ["brand_v3 off", () => flags({ brand_v3: false }), () => flags({ brand_v3: true })],
    ["brand_v2 off (env unset)", () => flags({ brand_v2: false }), () => flags({ brand_v2: true })],
    ["B-026 org flag off", () => flags({ vendor_account: false }), () => flags({ vendor_account: true })],
    ["B-026 platform off", () => accountGate(false), () => accountGate(true)],
  ];
  for (const [label, apply, restore] of gates) {
    await apply();
    try { await deny(label, credA); } finally { await restore(); }
  }
  // Another vendor never reaches A's profile: B's save writes B's own row only.
  const beforeA = await versionOf(profileA);
  const { current_version: bVersion } = await versionOf(profileB);
  assert.equal((await save(credB, ORG_ID, bVersion, "13 號")).status, "recorded");
  assert.deepEqual(await versionOf(profileA), beforeA);
  // Re-admitted after every gate was restored.
  assert.equal((await vendorAddressView(credA, ORG_ID))?.profileId, profileA);
});

test("route: account cookie and an open workbench only; invalid parts are a 400 with no write", async () => {
  const { current_version: version } = await versionOf(profileA);
  const body = { requestId: randomUUID(), expectedVersion: version, parts: parts("21 號") };
  const before = await snapshot();
  assert.equal((await post(body)).status, 403, "no cookie");
  assert.equal((await post(body, `condola_session=${randomBytes(32).toString("base64url")}`)).status, 403, "a token is not a session");
  assert.equal((await post(body, `condola_session=${staffCred}; condola_org=${ORG_ID}`)).status, 403, "staff");
  assert.equal((await post(body, `condola_session=${credA}`, { origin: "https://evil.test" })).status, 403, "cross-origin");
  assert.equal((await post({ ...body, parts: { ...body.parts, city: "火星市" } }, `condola_session=${credA}`)).status, 400);
  assert.equal((await post({ ...body, parts: { ...body.parts, street: "", number: "" } }, `condola_session=${credA}`)).status, 400);
  assert.deepEqual(await snapshot(), before);
  const ok = await post(body, `condola_session=${credA}; condola_org=${ORG_ID}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "recorded", version: version + 1, address: "台北市信義區信義路二段 21 號", replayed: false });
  assert.equal((await post(body, `condola_session=${credA}; condola_org=${ORG_ID}`)).status, 200, "replay");
  assert.equal((await post({ ...body, requestId: randomUUID() }, `condola_session=${credA}; condola_org=${ORG_ID}`)).status, 409, "stale");
});
