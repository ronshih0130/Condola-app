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
import { hashVendorToken } from "./vendor-repair-rules";

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
  // Real persisted bearer tokens: a vendor job link for A's own contact and a B-025 document link for A's profile.
  const jobToken = randomBytes(32).toString("base64url"), documentToken = randomBytes(32).toString("base64url");
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id)
    SELECT $1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),id,'closed','B-112 bearer',$2
    FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, contactA])).rows[0].id;
  const job = (await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id,sharing_approved_at)
    VALUES($1,$2,'B-112 A','+886912345678','x',$3,clock_timestamp()+interval '1 day',$4,$5,clock_timestamp()) RETURNING id::text`,
  [ORG_ID, ticket, hashVendorToken(jobToken), USERS.admin, contactA])).rows[0].id;
  await db.query(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"B-112"}'::jsonb,clock_timestamp()+interval '1 day',$6)`,
  [ORG_ID, ticket, job, profileA, hashVendorToken(documentToken), USERS.admin]);
  assert.equal((await db.query("SELECT count(*)::int n FROM repair_vendor_jobs WHERE token_hash=$1 AND active", [hashVendorToken(jobToken)])).rows[0].n, 1);
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
  await deny("a live vendor job token as the session cookie", jobToken);
  await deny("a live document token as the session cookie", documentToken);
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

/** Waits until `n` backends in THIS test database are blocked by the holder's own PID while running the B-112 writer. */
async function waitForBlocked(lock: Client, n: number) {
  const holderPid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  for (let i = 0; i < 100; i++) {
    const blocked = (await db.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%b112_save_vendor_address%'`, [holderPid])).rows[0].n;
    if (blocked >= n) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`expected ${n} save(s) blocked by ${holderPid}`);
}
async function holder() {
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query("BEGIN");
  return client;
}
const writes = async (profileId: string) => JSON.stringify({
  profile: (await db.query("SELECT current_version,address FROM vendor_profiles WHERE id=$1", [profileId])).rows,
  versions: (await db.query("SELECT count(*)::int n FROM vendor_profile_versions WHERE vendor_profile_id=$1", [profileId])).rows,
  ledger: (await db.query("SELECT count(*)::int n FROM app.b112_address_saves WHERE vendor_profile_id=$1", [profileId])).rows,
  audit: (await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_account_address' AND row_id=$1", [profileId])).rows,
});

test("binding changed while a save waits on the profile lock: refused with no write (each element alone)", async () => {
  const vendorC = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b112c@example.test',now())", [vendorC]);
  const spare = await vendorContact(ORG_ID, "B-112 spare");
  const account = (await db.query("SELECT * FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA])).rows[0];
  assert.equal(account.user_id, vendorA);
  const cases: [string, (c: Client) => Promise<unknown>, () => Promise<unknown>][] = [
    ["account reassigned to another user", c => c.query("UPDATE app.b026_vendor_accounts SET user_id=$3 WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA, vendorC]),
      () => db.query("UPDATE app.b026_vendor_accounts SET user_id=$3 WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA, vendorA])],
    ["account revoked (row removed)", c => c.query("DELETE FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA]),
      () => db.query("INSERT INTO app.b026_vendor_accounts SELECT * FROM jsonb_populate_record(NULL::app.b026_vendor_accounts,$1::jsonb)", [JSON.stringify(account)])],
    ["contact archived", c => c.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactA]),
      () => db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contactA])],
    ["contact no longer a vendor", c => c.query("UPDATE contacts SET is_vendor=false,is_owner=true WHERE id=$1", [contactA]),
      () => db.query("UPDATE contacts SET is_vendor=true,is_owner=false WHERE id=$1", [contactA])],
  ];
  // The profile↔contact link itself cannot move: the existing issuer-identity guard refuses it outright.
  await assert.rejects(db.query("UPDATE vendor_profiles SET contact_id=$2 WHERE id=$1", [profileA, spare]), /vendor issuing identity is immutable/);
  for (const [label, mutate, restore] of cases) {
    const lock = await holder();
    await lock.query("SELECT 1 FROM vendor_profiles WHERE id=$1 FOR UPDATE", [profileA]);
    const { current_version: version } = await versionOf(profileA);
    const before = await writes(profileA);
    const pending = save(credA, ORG_ID, version, "77 號").then(result => ({ result }), error => ({ error }));
    try {
      await waitForBlocked(lock, 1);
      await mutate(lock);
      await lock.query("COMMIT");
    } catch (error) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { await lock.end(); }
    const outcome = await pending as { result?: unknown; error?: unknown };
    assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result)}`);
    await restore();
    const after = JSON.parse(await writes(profileA)), expected = JSON.parse(before);
    assert.deepEqual(after, expected, `${label}: no writes`);
    assert.equal((await save(credA, ORG_ID, version, `${80 + cases.findIndex(c => c[0] === label)} 號`)).status, "recorded", `${label}: restored binding saves again`);
  }
});

test("two vendors sharing one request id in parallel: exactly one recorded, one rejected_conflict, no 23505", async () => {
  const request = randomUUID();
  const lock = await holder();
  await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b112/address/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
  const [a, b] = [await versionOf(profileA), await versionOf(profileB)];
  const before = { a: await writes(profileA), b: await writes(profileB) };
  const runs = [save(credA, ORG_ID, a.current_version, "31 號", request), save(credB, ORG_ID, b.current_version, "32 號", request)]
    .map(p => p.then(result => ({ result }), error => ({ error })));
  try { await waitForBlocked(lock, 2); } finally { await lock.query("COMMIT"); await lock.end(); }
  const outcomes = await Promise.all(runs) as { result?: { status: string }; error?: unknown }[];
  assert.ok(outcomes.every(o => !o.error), JSON.stringify(outcomes.map(o => String(o.error))));
  assert.deepEqual(outcomes.map(o => o.result!.status).sort(), ["recorded", "rejected_conflict"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b112_address_saves WHERE org_id=$1 AND request_id=$2", [ORG_ID, request])).rows[0].n, 1);
  const loser = outcomes[0].result!.status === "rejected_conflict" ? "a" : "b";
  assert.equal(await writes(loser === "a" ? profileA : profileB), before[loser], "the loser wrote nothing");
});

test("route: body capped while streaming, Content-Length over the cap refused unread, expectedVersion bounded", async () => {
  const cookie = `condola_session=${credA}; condola_org=${ORG_ID}`;
  const before = await snapshot();
  const big = JSON.stringify({ requestId: randomUUID(), expectedVersion: 1, parts: parts("1 號"), pad: "x".repeat(5000) });
  assert.equal((await post(JSON.parse(big), cookie)).status, 413, "over the cap");
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024).fill(32)); } });
  const streamed = await saveRoute(new Request(`${origin}/api/vendor-account/address`, { method: "POST", body: endless, duplex: "half",
    headers: { origin, "content-type": "application/json", cookie } } as RequestInit));
  assert.equal(streamed.status, 413); assert.ok(pulled <= 6, `stopped after ${pulled} chunks`);
  const oversized = new Request(`${origin}/api/vendor-account/address`, { method: "POST", body: "{}",
    headers: { origin, "content-type": "application/json", "content-length": "999999", cookie } });
  const declared = await saveRoute(oversized);
  assert.equal(declared.status, 413);
  assert.equal(oversized.bodyUsed, false, "a declared oversize is refused without reading the body");
  const { current_version: version } = await versionOf(profileA);
  for (const expectedVersion of [2147483648, 0, -1, 1.5, "2"]) {
    assert.equal((await post({ requestId: randomUUID(), expectedVersion, parts: parts("1 號") }, cookie)).status, 400, String(expectedVersion));
  }
  for (const bad of ["\u0085", "\u2028", "\u2029", "\u009f"]) {
    assert.equal((await post({ requestId: randomUUID(), expectedVersion: version, parts: parts(`1${JSON.parse(`"${bad}"`)}號`) }, cookie)).status, 400, bad);
    assert.deepEqual(await sqlSave(hash(credA), ORG_ID, version, `台北市信義區信義路 1${JSON.parse(`"${bad}"`)}號`), { status: "rejected_invalid" }, `SQL ${bad}`);
  }
  assert.deepEqual(await snapshot(), before);
});

test("a save waiting on the idempotency lock is refused if the session or any gate changes during the wait", async () => {
  const revocable = randomUUID();
  const sessionId = (await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id", [vendorA, hash(revocable)])).rows[0].id;
  const cases: [string, () => Promise<unknown>, () => Promise<unknown>, string][] = [
    ["session revoked", () => db.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sessionId]), async () => {}, revocable],
    ["vendor_workbench off", () => flags({ vendor_workbench: false }), () => flags({ vendor_workbench: true }), credA],
    ["brand_v3 off", () => flags({ brand_v3: false }), () => flags({ brand_v3: true }), credA],
    ["B-026 org flag off", () => flags({ vendor_account: false }), () => flags({ vendor_account: true }), credA],
    ["B-026 platform off", () => accountGate(false), () => accountGate(true), credA],
  ];
  for (const [label, change, restore, cred] of cases) {
    const request = randomUUID();
    const lock = await holder();
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b112/address/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
    const { current_version: version } = await versionOf(profileA);
    const before = await writes(profileA);
    const pending = save(cred, ORG_ID, version, `${60 + cases.findIndex(c => c[0] === label)} 號`, request).then(result => ({ result }), error => ({ error }));
    try {
      await waitForBlocked(lock, 1);
      await change();
    } finally {
      // The holder leaves no ledger row: the waiting save must still be refused on its own admission.
      await lock.query("ROLLBACK"); await lock.end();
    }
    const outcome = await pending as { result?: unknown; error?: unknown };
    try {
      assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result)}`);
      assert.equal(await writes(profileA), before, `${label}: no writes`);
      assert.equal((await db.query("SELECT count(*)::int n FROM app.b112_address_saves WHERE request_id=$1", [request])).rows[0].n, 0, label);
    } finally { await restore(); }
  }
  assert.equal((await vendorAddressView(credA, ORG_ID))?.profileId, profileA, "every gate restored");
});
