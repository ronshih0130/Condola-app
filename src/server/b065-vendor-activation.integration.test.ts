import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "pg";
import { POST as saveRoute } from "../app/api/vendor-account/issuer-type/route";
import VendorWorkbenchAccountPage from "../app/vendor-account/account/page";
import VendorIssuerTypePage from "../app/vendor-account/account/issuer-type/page";
import VendorStampPage from "../app/vendor-account/account/stamp/page";
import { IssuerTypeForm, IssuerTypeRow, StampNotYet } from "../components/v3/vendor/vendor-activation";
import { VendorShellV3 } from "../components/v3/vendor/workbench-shell";
import { buildStoredConsent } from "./consent";
import { svc } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { claimVendorAccount, inviteVendorAccount } from "./vendor-accounts";
import { saveVendorIssuerType, vendorIssuerType, type IssuerType } from "./b065-vendor-activation";
import { hashVendorToken } from "./vendor-repair-rules";

// B-065 VF-1 phase A on a cloned disposable database: the real B-026 invite/claim, the real app.b065_* gateways, the
// real route and the real pages. Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… (never staging).
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin", kind: "staff",
  name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const vendorA = randomUUID(), vendorB = randomUUID(), staffVendor = randomUUID();
const credA = randomUUID(), credB = randomUUID(), staffCred = randomUUID(), staffVendorCred = randomUUID();
let contactA = "", contactB = "", foreignB = "", contactS = "";
let jobToken = "", documentToken = "";
const brandEnv = process.env.BRAND_V2;
type Q = Pick<Client, "query">;

async function vendorContact(org: string, name: string) {
  return (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,$2,'+886912345678') RETURNING id::text", [org, name])).rows[0].id as string;
}
async function flags(patch: Record<string, unknown>, org = ORG_ID, client: Q = db) {
  await client.query("UPDATE organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
}
async function accountGate(enabled: boolean) {
  await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_account'", [JSON.stringify({ enabled, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
}
async function activationGate(value: unknown, client: Q = db) {
  await client.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_activation'", [JSON.stringify(value)]);
}
const ACTIVATION_ON = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] };
/** Everything a B-065 writer could change, plus the admission inputs: declarations, ledger, audit, profiles, contacts, accounts. */
const SNAPSHOT_TABLES = ["app.b065_issuer_types", "app.b065_issuer_requests", "public.audit_log", "public.vendor_profiles", "public.contacts",
  "app.b026_vendor_accounts", "public.org_members"];
async function snapshot(client: Q = db) {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const save = (cred: string, org: string, issuerType: IssuerType, requestId: string = randomUUID()) => saveVendorIssuerType(cred, org, { requestId, issuerType });
const sqlSave = (credHash: string, org: string | null, type: string | null, request: string | null = randomUUID()) => svc(null, async client =>
  (await client.query("SELECT app.b065_save_issuer_type($1,$2::uuid,false,$3::uuid,$4) r", [credHash, org, request, type])).rows[0].r);
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501" || (error as { code?: string }).code === "42501";
const declarations = async (contact: string) => (await db.query(
  "SELECT issuer_type,declared_by::text FROM app.b065_issuer_types WHERE contact_id=$1 ORDER BY declared_at,request_id", [contact])).rows;
const ledger = async (request: string) => (await db.query(
  "SELECT actor_id::text,contact_id::text,issuer_type,answer FROM app.b065_issuer_requests WHERE org_id=$1 AND request_id=$2", [ORG_ID, request])).rows;
const writes = async (contact: string) => JSON.stringify({
  rows: (await db.query("SELECT count(*)::int n FROM app.b065_issuer_types WHERE contact_id=$1", [contact])).rows,
  ledger: (await db.query("SELECT count(*)::int n FROM app.b065_issuer_requests WHERE contact_id=$1", [contact])).rows,
  audit: (await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_issuer_type' AND row_id=$1", [contact])).rows,
});
const other = (type: IssuerType | null): IssuerType => type === "exempt_business" ? "individual" : "exempt_business";
const post = (body: unknown, cookie?: string, headers: Record<string, string> = {}) => saveRoute(new Request(`${origin}/api/vendor-account/issuer-type`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }));

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  delete process.env.BRAND_V2;
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b065a@example.test',now()),($2,'b065b@example.test',now()),($3,'b065s@example.test',now())",
    [vendorA, vendorB, staffVendor]);
  for (const [id, user, cred] of [[admin.sessionId, admin.userId, staffCred], [coast.sessionId, coast.userId, randomUUID()], [randomUUID(), vendorA, credA],
    [randomUUID(), vendorB, credB], [randomUUID(), staffVendor, staffVendorCred]]) {
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, user, hash(cred)]);
  }
  const consent = buildStoredConsent("portal");
  for (const user of [vendorA, vendorB, staffVendor, admin.userId]) await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [user, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  // The migration seeds the platform switch OFF.
  assert.deepEqual((await db.query("SELECT value FROM platform_settings WHERE key='vendor_activation'")).rows[0].value, { enabled: false, allowed_org_ids: [] });
  await accountGate(true);
  await activationGate(ACTIVATION_ON);
  for (const org of [ORG_ID, ORG2_ID]) await flags({ vendor_account: true, vendor_dispatch: true, vendor_workbench: true, brand_v2: true, brand_v3: true, vendor_activation: true }, org);
  contactA = await vendorContact(ORG_ID, "B-065 A"); contactB = await vendorContact(ORG_ID, "B-065 B");
  foreignB = await vendorContact(ORG2_ID, "B-065 B in ORG2"); contactS = await vendorContact(ORG_ID, "B-065 staff who is also a vendor");
  for (const [session, contact, user, cred] of [[admin, contactA, vendorA, credA], [admin, contactB, vendorB, credB], [coast, foreignB, vendorB, credB],
    [admin, contactS, staffVendor, staffVendorCred]] as const) {
    const invite = await inviteVendorAccount(session, contact, user);
    assert.equal(invite.status, "invited");
    assert.equal((await claimVendorAccount(cred, invite.invitation!)).status, "claimed");
  }
  // The staff vendor: a real B-026 vendor account in ORG_ID, and an active staff membership of ORG_ID.
  await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, staffVendor]);
  // Real persisted bearer tokens for A: a vendor job link and a B-025 document link on A's vendor profile.
  jobToken = randomBytes(32).toString("base64url"); documentToken = randomBytes(32).toString("base64url");
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id)
    SELECT $1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),id,'closed','B-065 bearer',$2
    FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, contactA])).rows[0].id;
  const job = (await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id,sharing_approved_at)
    VALUES($1,$2,'B-065 A','+886912345678','x',$3,clock_timestamp()+interval '1 day',$4,$5,clock_timestamp()) RETURNING id::text`,
  [ORG_ID, ticket, hashVendorToken(jobToken), USERS.admin, contactA])).rows[0].id;
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164,address,qualification_attested_at)
    VALUES($1,$2,'B065','individual','B-065 A','+886912000065','台北市信義區信義路二段 65 號',now()) RETURNING id::text`, [ORG_ID, contactA])).rows[0].id;
  await db.query(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"B-065"}'::jsonb,clock_timestamp()+interval '1 day',$6)`,
  [ORG_ID, ticket, job, profile, hashVendorToken(documentToken), USERS.admin]);
  assert.equal((await db.query("SELECT count(*)::int n FROM repair_vendor_jobs WHERE token_hash=$1 AND active", [hashVendorToken(jobToken)])).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM vendor_document_grants WHERE token_hash=$1", [hashVendorToken(documentToken)])).rows[0].n, 1);
});

test.after(async () => {
  if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("privileges: gateways service-only, helpers unexecutable, both tables fully revoked with RLS on; flag seeded OFF", async () => {
  const gateways = ["app.b065_issuer_view(text,uuid,boolean)", "app.b065_save_issuer_type(text,uuid,boolean,uuid,text)"];
  const helpers = ["app.b065_enabled(uuid,boolean)", "app.b065_account_contact(text,uuid,boolean,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role" && gateways.includes(signature), `${role} ${signature}`);
    }
    for (const table of ["app.b065_issuer_types", "app.b065_issuer_requests"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) ok", [role, table, privilege])).rows[0].ok, false, `${role} ${table} ${privilege}`);
      }
      assert.equal((await db.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') ok", [role, table])).rows[0].ok, false);
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(`SELECT 1 FROM ${table}`), { code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0].relrowsecurity, true, table);
    }
    if (role !== "service_role") {
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query("SELECT app.b065_save_issuer_type(NULL,NULL,false,NULL,NULL)"), { code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
    }
  }
  const fns = (await db.query(`SELECT p.proname,p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p
    WHERE p.pronamespace='app'::regnamespace AND p.proname IN ('b065_enabled','b065_account_contact','b065_issuer_view','b065_save_issuer_type') ORDER BY 1`)).rows;
  assert.equal(fns.length, 4);
  // Ownership (postgres on Supabase) is asserted by scripts/check-function-privileges.sh; locally the owner is the migration role.
  for (const fn of fns) assert.deepEqual([fn.prosecdef, fn.provolatile, fn.proconfig], [true, "v", ["search_path=pg_catalog, pg_temp"]], fn.proname);
});

test("read: never declared is null; each vendor reads only their own contact in an org they hold an account in", async () => {
  assert.equal(await vendorIssuerType(credA, ORG_ID), null);
  assert.equal(await vendorIssuerType(credB, ORG_ID), null);
  assert.equal(await vendorIssuerType(credB, ORG2_ID), null);
  await assert.rejects(vendorIssuerType(credA, ORG2_ID), forbidden, "no account in that org");
  await assert.rejects(vendorIssuerType(staffCred, ORG_ID), forbidden, "a staff session with no vendor account");
  await assert.rejects(vendorIssuerType(staffVendorCred, ORG_ID), forbidden, "a staff member who also holds a vendor account");
  await assert.rejects(vendorIssuerType("", ORG_ID), forbidden);
});

test("staff refusal is the deciding check: the same bound vendor account is admitted once the membership is removed", async () => {
  const before = await snapshot();
  await assert.rejects(save(staffVendorCred, ORG_ID, "individual"), forbidden);
  assert.deepEqual(await snapshot(), before);
  for (const status of ["invited", "suspended"]) {
    await db.query("UPDATE org_members SET status=$3 WHERE org_id=$1 AND user_id=$2", [ORG_ID, staffVendor, status]);
    await assert.rejects(vendorIssuerType(staffVendorCred, ORG_ID), forbidden, status);
  }
  await db.query("UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, staffVendor]);
  try {
    assert.equal(await vendorIssuerType(staffVendorCred, ORG_ID), null, "same binding, no membership: admitted");
  } finally { await db.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [ORG_ID, staffVendor]); }
  await assert.rejects(vendorIssuerType(staffVendorCred, ORG_ID), forbidden);
});

test("transitions: any type to any other is one row, one ledger row and one audit row; the same type again is unchanged (reserved, no declaration)", async () => {
  const path: IssuerType[] = ["individual", "exempt_business", "invoice_business", "individual", "invoice_business", "exempt_business", "individual"];
  let previous: IssuerType | null = null;
  for (const type of path) {
    const request = randomUUID();
    assert.deepEqual(await save(credA, ORG_ID, type, request), { status: "recorded", issuerType: type, replayed: false }, `${previous}→${type}`);
    assert.equal(await vendorIssuerType(credA, ORG_ID), type);
    const audit = (await db.query(`SELECT actor_user_id::text,actor_role,table_name,row_id,action::text,event_type,old_row,new_row,request_id,org_id::text
      FROM audit_log WHERE event_type='vendor_issuer_type' AND request_id=$1`, [request])).rows;
    assert.deepEqual(audit, [{ actor_user_id: vendorA, actor_role: "vendor", table_name: "contacts", row_id: contactA, action: "update",
      event_type: "vendor_issuer_type", old_row: { issuerType: previous }, new_row: { issuerType: type }, request_id: request, org_id: ORG_ID }]);
    assert.deepEqual(await ledger(request), [{ actor_id: vendorA, contact_id: contactA, issuer_type: type, answer: { status: "recorded", issuerType: type, replayed: false } }]);
    const declared = await declarations(contactA), audits = (await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_issuer_type'")).rows[0].n;
    const same = randomUUID();
    assert.deepEqual(await save(credA, ORG_ID, type, same), { status: "unchanged", issuerType: type, replayed: false });
    assert.deepEqual(await declarations(contactA), declared, `${type} again: no declaration`);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_issuer_type'")).rows[0].n, audits, `${type} again: no audit`);
    assert.deepEqual(await ledger(same), [{ actor_id: vendorA, contact_id: contactA, issuer_type: type, answer: { status: "unchanged", issuerType: type, replayed: false } }],
      "unchanged reserves the request id");
    previous = type;
  }
  assert.deepEqual((await declarations(contactA)).map(r => r.issuer_type), path, "append-only history; old rows never change");
  assert.ok((await declarations(contactA)).every(r => r.declared_by === vendorA));
  // B's declaration is B's own; A's current type does not move.
  assert.equal((await save(credB, ORG_ID, "invoice_business")).status, "recorded");
  assert.equal(await vendorIssuerType(credA, ORG_ID), "individual");
  assert.equal(await vendorIssuerType(credB, ORG_ID), "invoice_business");
  assert.equal(await vendorIssuerType(credB, ORG2_ID), null, "per org: B in ORG2 has not declared");
  // Invalid values are refused after admission with no write and no reservation.
  const before = await snapshot();
  const invalidRequest = randomUUID();
  for (const bad of ["business", "", "INDIVIDUAL", "invoice_business ", null]) assert.deepEqual(await sqlSave(hash(credA), ORG_ID, bad, invalidRequest), { status: "rejected_invalid" }, String(bad));
  assert.deepEqual(await sqlSave(hash(credA), ORG_ID, "exempt_business", null), { status: "rejected_invalid" }, "no request id");
  assert.deepEqual(await snapshot(), before);
  // Phase A never writes vendor_profiles: A's only profile is the fixture's.
  assert.equal((await db.query("SELECT count(*)::int n FROM vendor_profiles WHERE contact_id IN ($1,$2)", [contactA, contactB])).rows[0].n, 1);
});

test("idempotent: replay returns the stored first answer, even after a later change; another payload or vendor under that id is a conflict", async () => {
  const request = randomUUID();
  const next = other(await vendorIssuerType(credA, ORG_ID));
  const first = await save(credA, ORG_ID, next, request);
  assert.deepEqual(first, { status: "recorded", issuerType: next, replayed: false });
  const after = await snapshot();
  assert.deepEqual(await save(credA, ORG_ID, next, request), { ...first, replayed: true });
  assert.deepEqual(await save(credA, ORG_ID, "invoice_business", request), { status: "rejected_conflict" }, "same request, other payload");
  assert.deepEqual(await save(credB, ORG_ID, next, request), { status: "rejected_conflict" }, "another vendor cannot reuse it");
  assert.deepEqual(await snapshot(), after);
  // Change the type under another request, then replay the original: the original answer, no write, current unchanged.
  const later: IssuerType = next === "invoice_business" ? "individual" : "invoice_business";
  assert.equal((await save(credA, ORG_ID, later)).status, "recorded");
  const changed = await snapshot();
  assert.deepEqual(await save(credA, ORG_ID, next, request), { ...first, replayed: true }, "replay after a change is the first answer");
  assert.deepEqual(await snapshot(), changed, "the stale replay writes nothing");
  assert.equal(await vendorIssuerType(credA, ORG_ID), later);
  // An 'unchanged' request is reserved too: after a change its replay is still 'unchanged', and nobody else can claim it.
  const same = randomUUID();
  assert.deepEqual(await save(credA, ORG_ID, later, same), { status: "unchanged", issuerType: later, replayed: false });
  assert.equal((await save(credA, ORG_ID, next)).status, "recorded");
  const moved = await snapshot();
  assert.deepEqual(await save(credA, ORG_ID, later, same), { status: "unchanged", issuerType: later, replayed: true });
  assert.deepEqual(await save(credB, ORG_ID, "individual", same), { status: "rejected_conflict" });
  assert.deepEqual(await save(credA, ORG_ID, "individual", same), { status: "rejected_conflict" });
  assert.deepEqual(await snapshot(), moved);
  assert.equal(await vendorIssuerType(credA, ORG_ID), next, "the replay did not write the stale type");
  // The same id in another org is a different request (B in ORG2).
  assert.deepEqual(await save(credB, ORG2_ID, "individual", request), { status: "recorded", issuerType: "individual", replayed: false });
});

test("denials write nothing, including replays of persisted request ids: tokens as the cookie, revoked/expired session, staff, other org, unlinked contact, every gate OFF", async () => {
  const revoked = randomUUID(), expired = randomUUID();
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,clock_timestamp()+interval '1 hour',clock_timestamp())", [vendorA, hash(revoked)]);
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()-interval '1 second')", [vendorA, hash(expired)]);
  // Persisted request ids from earlier successful saves: A recorded, A unchanged, the staff vendor (admitted while not staff).
  const recordedType = other(await vendorIssuerType(credA, ORG_ID));
  const recordedId = randomUUID(), unchangedId = randomUUID(), staffId = randomUUID();
  assert.equal((await save(credA, ORG_ID, recordedType, recordedId)).status, "recorded");
  assert.equal((await save(credA, ORG_ID, recordedType, unchangedId)).status, "unchanged");
  await db.query("UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, staffVendor]);
  try { assert.equal((await save(staffVendorCred, ORG_ID, "individual", staffId)).status, "recorded"); }
  finally { await db.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [ORG_ID, staffVendor]); }
  const target = other(recordedType);
  const deny = async (label: string, cred: string, org = ORG_ID, persisted: [string, IssuerType][] = [[recordedId, recordedType], [unchangedId, recordedType]]) => {
    const before = await snapshot();
    await assert.rejects(save(cred, org, target), forbidden, `${label}: save`);
    await assert.rejects(sqlSave(hash(cred), org, target), refused, `${label}: SQL save`);
    await assert.rejects(sqlSave(hash(cred), org, "not-a-type"), refused, `${label}: an invalid body is still refused first`);
    for (const [request, type] of persisted) {
      await assert.rejects(save(cred, org, type, request), forbidden, `${label}: an exact replay of persisted ${request} does not bypass admission`);
      await assert.rejects(sqlSave(hash(cred), org, type, request), refused, `${label}: SQL replay of ${request}`);
    }
    await assert.rejects(vendorIssuerType(cred, org), forbidden, `${label}: read`);
    assert.deepEqual(await snapshot(), before, `${label}: no writes`);
  };
  await deny("a live vendor job token as the session cookie", jobToken);
  await deny("a live document token as the session cookie", documentToken);
  await deny("revoked session", revoked);
  await deny("expired session", expired);
  await deny("staff session with no vendor account", staffCred);
  await deny("staff member who also holds a vendor account", staffVendorCred, ORG_ID, [[staffId, "individual"]]);
  await deny("vendor A in an org with no account of theirs", credA, ORG2_ID);
  await assert.rejects(sqlSave("not-a-hash", ORG_ID, target), refused);
  await assert.rejects(sqlSave(hash(credA), null, target), refused);
  const gates: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["vendor_activation org off", () => flags({ vendor_activation: false }), () => flags({ vendor_activation: true })],
    ["vendor_activation org absent", () => db.query("UPDATE organizations SET feature_flags=feature_flags-'vendor_activation' WHERE id=$1", [ORG_ID]), () => flags({ vendor_activation: true })],
    ["vendor_activation org \"true\"", () => flags({ vendor_activation: "true" }), () => flags({ vendor_activation: true })],
    ["vendor_activation platform off", () => activationGate({ ...ACTIVATION_ON, enabled: false }), () => activationGate(ACTIVATION_ON)],
    ["vendor_activation platform org not allowed", () => activationGate({ enabled: true, allowed_org_ids: [ORG2_ID] }), () => activationGate(ACTIVATION_ON)],
    ["vendor_activation platform malformed", () => activationGate({ enabled: true, allowed_org_ids: ORG_ID }), () => activationGate(ACTIVATION_ON)],
    ["vendor_activation platform row missing", () => db.query("DELETE FROM platform_settings WHERE key='vendor_activation'"),
      () => db.query("INSERT INTO platform_settings(key,value) VALUES('vendor_activation',$1::jsonb)", [JSON.stringify(ACTIVATION_ON)])],
    ["vendor_workbench off", () => flags({ vendor_workbench: false }), () => flags({ vendor_workbench: true })],
    ["brand_v3 off", () => flags({ brand_v3: false }), () => flags({ brand_v3: true })],
    ["brand_v2 off (env unset)", () => flags({ brand_v2: false }), () => flags({ brand_v2: true })],
    ["B-026 org flag off", () => flags({ vendor_account: false }), () => flags({ vendor_account: true })],
    ["B-026 platform off", () => accountGate(false), () => accountGate(true)],
    ["contact archived", () => db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactA]), () => db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contactA])],
    ["contact no longer a vendor", () => db.query("UPDATE contacts SET is_vendor=false,is_owner=true WHERE id=$1", [contactA]),
      () => db.query("UPDATE contacts SET is_vendor=true,is_owner=false WHERE id=$1", [contactA])],
    ["vendor A made staff of the org", () => db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, vendorA]),
      () => db.query("DELETE FROM org_members WHERE org_id=$1 AND user_id=$2", [ORG_ID, vendorA])],
  ];
  for (const [label, apply, restore] of gates) {
    await apply();
    try { await deny(label, credA); } finally { await restore(); }
  }
  // The org gate is per org: ORG2 off does not deny ORG_ID.
  await flags({ vendor_activation: false }, ORG2_ID);
  try {
    await assert.rejects(vendorIssuerType(credB, ORG2_ID), forbidden);
    assert.equal(typeof (await vendorIssuerType(credB, ORG_ID)), "string");
  } finally { await flags({ vendor_activation: true }, ORG2_ID); }
  // Re-admitted after every gate was restored; the persisted id still replays its first answer.
  assert.deepEqual(await save(credA, ORG_ID, recordedType, recordedId), { status: "recorded", issuerType: recordedType, replayed: true });
  assert.equal((await save(credA, ORG_ID, target)).status, "recorded");
});

/** Waits until `n` backends in THIS test database are blocked by the holder's own PID while running the B-065 writer. */
async function waitForBlocked(lock: Client, n: number) {
  const holderPid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  for (let i = 0; i < 100; i++) {
    const blocked = (await db.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%b065_save_issuer_type%'`, [holderPid])).rows[0].n;
    if (blocked >= n) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`expected ${n} save(s) blocked by ${holderPid}`);
}
async function holder() {
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query("BEGIN");
  return client;
}
type Outcome = { result?: { status: string }; error?: unknown };
/** A save that is still waiting after `ms` is a failure, never a hang. */
const settle = (pending: Promise<Outcome>, ms = 15000) => Promise.race([pending, new Promise<Outcome>(resolve => {
  setTimeout(() => resolve({ error: new Error(`save still waiting after ${ms}ms`) }), ms).unref();
})]);
const busy = (error: unknown) => (error as { code?: string }).code === "55P03" || (error as { cause?: { code?: string } }).cause?.code === "55P03";
const WAIT_TEST = { timeout: 240000 };

test("two vendors sharing one request id in parallel: exactly one recorded, one rejected_conflict, no 23505", async () => {
  const request = randomUUID();
  const lock = await holder();
  const before = { a: await writes(contactA), b: await writes(contactB) };
  const [a, b] = [await vendorIssuerType(credA, ORG_ID), await vendorIssuerType(credB, ORG_ID)];
  let runs: Promise<Outcome>[] = [];
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/issuer/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
    runs = [save(credA, ORG_ID, other(a), request), save(credB, ORG_ID, other(b), request)].map(p => p.then(result => ({ result }), error => ({ error })));
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const outcomes = await Promise.all(runs);
  assert.ok(outcomes.every(o => !o.error), JSON.stringify(outcomes.map(o => String(o.error))));
  assert.deepEqual(outcomes.map(o => o.result!.status).sort(), ["recorded", "rejected_conflict"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b065_issuer_requests WHERE org_id=$1 AND request_id=$2", [ORG_ID, request])).rows[0].n, 1);
  const loser = outcomes[0].result!.status === "rejected_conflict" ? "a" : "b";
  assert.equal(await writes(loser === "a" ? contactA : contactB), before[loser], "the loser wrote nothing");
});

test("two saves of one vendor in parallel (different request ids): serialized per org, the later one sees the first", async () => {
  const lock = await holder();
  const next: IssuerType = (await vendorIssuerType(credA, ORG_ID)) === "invoice_business" ? "individual" : "invoice_business";
  const before = (await declarations(contactA)).length;
  let runs: Promise<Outcome>[] = [];
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/issuer-org/'||$1::text,0))", [ORG_ID]);
    runs = [save(credA, ORG_ID, next), save(credA, ORG_ID, next)].map(p => p.then(result => ({ result }), error => ({ error })));
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const outcomes = await Promise.all(runs);
  assert.ok(outcomes.every(o => !o.error), JSON.stringify(outcomes.map(o => String(o.error))));
  assert.deepEqual(outcomes.map(o => o.result!.status).sort(), ["recorded", "unchanged"]);
  assert.equal((await declarations(contactA)).length, before + 1);
});

/**
 * One blocked save per case. The holder takes `lock` and the save queues behind it; while it waits, the invalidating
 * changes are applied (`db`: committed at once; `hold`: inside the holder, committed on release). The expected state is
 * read through the holder after every change, i.e. after the admission-invalidating mutation and before release.
 */
async function blockedSave(label: string, lock: (c: Client) => Promise<unknown>, changes: { db?: () => Promise<unknown>; hold?: (c: Client) => Promise<unknown> },
  restore: () => Promise<unknown>, cred = credA, expect: "refused" | "recorded" = "refused") {
  const next = other(await vendorIssuerType(credA, ORG_ID));
  const request = randomUUID();
  const client = await holder();
  let pending: Promise<Outcome> | undefined, expected: Record<string, string> | undefined;
  try {
    await lock(client);
    pending = save(cred, ORG_ID, next, request).then(result => ({ result }), error => ({ error }));
    await waitForBlocked(client, 1);
    // A change that would queue behind the blocked save fails fast instead of hanging the test.
    await db.query("SET lock_timeout='3s'");
    try { await changes.db?.(); } finally { await db.query("RESET lock_timeout"); }
    await client.query("SET LOCAL lock_timeout='3s'");
    await changes.hold?.(client);
    expected = await snapshot(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
  const outcome = await settle(pending!);
  try {
    if (expect === "recorded") {
      // Positive control: the same wait with nothing changed is admitted and writes once.
      assert.deepEqual(outcome.result, { status: "recorded", issuerType: next, replayed: false }, `${label}: ${String(outcome.error)}`);
      assert.equal((await ledger(request)).length, 1, `${label}: reserved`);
      return;
    }
    assert.ok(forbidden(outcome.error), `${label}: ${JSON.stringify(outcome.result ?? String(outcome.error))}`);
    assert.deepEqual(await snapshot(), expected, `${label}: nothing written after the invalidating change`);
    assert.deepEqual(await ledger(request), [], `${label}: request id not reserved`);
  } finally { await restore(); }
}
/** Positive control for one holder: nothing changes during the wait. */
const control = (label: string, lock: (c: Client) => Promise<unknown>) => blockedSave(`${label}: positive control`, lock, {}, async () => {}, credA, "recorded");

test("a save waiting on an advisory lock is refused if the session, the binding or any gate changes during the wait", WAIT_TEST, async () => {
  const fresh = async () => {
    const cred = randomUUID();
    const id = (await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id", [vendorA, hash(cred)])).rows[0].id;
    return { cred, revoke: () => db.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [id]) };
  };
  const account = (await db.query("SELECT * FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA])).rows[0];
  const restoreAccount = () => db.query("INSERT INTO app.b026_vendor_accounts SELECT * FROM jsonb_populate_record(NULL::app.b026_vendor_accounts,$1::jsonb)", [JSON.stringify(account)]);
  // The org declaration key (shared by every save in the org).
  const lock = (c: Client) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/issuer-org/'||$1::text,0))", [ORG_ID]);
  await control("org key", lock);
  const s0 = await fresh();
  await blockedSave("org key: session revoked", lock, { db: s0.revoke }, async () => {}, s0.cred);
  await blockedSave("org key: vendor_activation off", lock, { db: () => flags({ vendor_activation: false }) }, () => flags({ vendor_activation: true }));
  await blockedSave("org key: B-026 platform off", lock, { db: () => accountGate(false) }, () => accountGate(true));
  await blockedSave("org key: account revoked", lock, { db: () => db.query("DELETE FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA]) }, restoreAccount);
  await blockedSave("org key: contact archived", lock, { db: () => db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactA]) },
    () => db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contactA]));
  // The per-request key: hold it for a request the save will use.
  const s = await fresh();
  const next = other(await vendorIssuerType(credA, ORG_ID)), request = randomUUID();
  const before = await writes(contactA);
  const client = await holder();
  let pending: Promise<Outcome> | undefined;
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/issuer/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
    pending = save(s.cred, ORG_ID, next, request).then(result => ({ result }), error => ({ error }));
    await waitForBlocked(client, 1);
    await s.revoke();
  } finally { await client.query("ROLLBACK").catch(() => undefined); await client.end(); }
  assert.ok(forbidden((await settle(pending!)).error), "request key: session revoked");
  assert.equal(await writes(contactA), before);
  assert.equal(typeof (await vendorIssuerType(credA, ORG_ID)), "string", "every gate restored");
});

test("a save waiting on a row lock (organization, platform switch, vendor account, contact, membership) is refused when admission changes during the wait", WAIT_TEST, async () => {
  const fresh = async () => {
    const cred = randomUUID();
    const id = (await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id", [vendorA, hash(cred)])).rows[0].id;
    return { cred, revoke: () => db.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [id]) };
  };
  const account = (await db.query("SELECT * FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA])).rows[0];
  const restoreAccount = async () => {
    await db.query("DELETE FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA]);
    await db.query("INSERT INTO app.b026_vendor_accounts SELECT * FROM jsonb_populate_record(NULL::app.b026_vendor_accounts,$1::jsonb)", [JSON.stringify(account)]);
  };
  const unarchive = () => db.query("UPDATE contacts SET archived_at=NULL,is_vendor=true,is_owner=false WHERE id=$1", [contactA]);
  const lockOrg = (c: Client) => c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [ORG_ID]);
  const lockSwitch = (c: Client) => c.query("SELECT 1 FROM platform_settings WHERE key='vendor_activation' FOR UPDATE");
  const lockAccount = (c: Client) => c.query("SELECT 1 FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2 FOR UPDATE", [ORG_ID, contactA]);
  const lockContact = (c: Client) => c.query("SELECT 1 FROM contacts WHERE id=$1 FOR UPDATE", [contactA]);
  const archive = (c: Q) => c.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactA]);
  const unbind = (c: Q) => c.query("DELETE FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA]);
  const otherUser = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b065x@example.test',now())", [otherUser]);
  const rebind = (c: Q) => c.query("UPDATE app.b026_vendor_accounts SET user_id=$3 WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA, otherUser]);
  const makeStaff = () => db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, vendorA]);
  const unStaff = () => db.query("DELETE FROM org_members WHERE org_id=$1 AND user_id=$2", [ORG_ID, vendorA]);

  // Organization row held FOR UPDATE: the holder turns a gate off itself; the other changes land beside it.
  await control("org row", lockOrg);
  let s = await fresh();
  await blockedSave("org row: session revoked", lockOrg, { db: s.revoke }, async () => {}, s.cred);
  await blockedSave("org row: vendor_activation off by the holder", lockOrg, { hold: c => flags({ vendor_activation: false }, ORG_ID, c) }, () => flags({ vendor_activation: true }));
  await blockedSave("org row: vendor_workbench off by the holder", lockOrg, { hold: c => flags({ vendor_workbench: false }, ORG_ID, c) }, () => flags({ vendor_workbench: true }));
  await blockedSave("org row: brand_v3 off by the holder", lockOrg, { hold: c => flags({ brand_v3: false }, ORG_ID, c) }, () => flags({ brand_v3: true }));
  await blockedSave("org row: account revoked", lockOrg, { db: () => unbind(db) }, restoreAccount);
  await blockedSave("org row: contact archived", lockOrg, { db: () => archive(db) }, unarchive);
  // (A new membership's FK needs the organization row, so the holder adds it.)
  await blockedSave("org row: made staff by the holder", lockOrg, { hold: c => c.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, vendorA]) }, unStaff);
  // Platform switch held FOR UPDATE: the holder turns it off.
  await control("switch row", lockSwitch);
  s = await fresh();
  await blockedSave("switch row: session revoked", lockSwitch, { db: s.revoke }, async () => {}, s.cred);
  await blockedSave("switch row: platform off by the holder", lockSwitch, { hold: c => activationGate({ ...ACTIVATION_ON, enabled: false }, c) }, () => activationGate(ACTIVATION_ON));
  await blockedSave("switch row: org removed from allowed_org_ids by the holder", lockSwitch, { hold: c => activationGate({ enabled: true, allowed_org_ids: [ORG2_ID] }, c) }, () => activationGate(ACTIVATION_ON));
  // Vendor account row held FOR UPDATE: the holder rebinds or removes it.
  await control("account row", lockAccount);
  s = await fresh();
  await blockedSave("account row: session revoked", lockAccount, { db: s.revoke }, async () => {}, s.cred);
  await blockedSave("account row: reassigned to another user by the holder", lockAccount, { hold: rebind }, restoreAccount);
  await blockedSave("account row: removed by the holder", lockAccount, { hold: unbind }, restoreAccount);
  await blockedSave("account row: contact archived", lockAccount, { db: () => archive(db) }, unarchive);
  await blockedSave("account row: made staff", lockAccount, { db: makeStaff }, unStaff);
  // Contact row held FOR UPDATE: the holder archives it or makes it a non-vendor.
  await control("contact row", lockContact);
  s = await fresh();
  await blockedSave("contact row: session revoked", lockContact, { db: s.revoke }, async () => {}, s.cred);
  await blockedSave("contact row: archived by the holder", lockContact, { hold: archive }, unarchive);
  await blockedSave("contact row: no longer a vendor (holder)", lockContact, { hold: c => c.query("UPDATE contacts SET is_vendor=false,is_owner=true WHERE id=$1", [contactA]) }, unarchive);
  await blockedSave("contact row: made staff", lockContact, { db: makeStaff }, unStaff);
  // Membership row held FOR UPDATE (A has a removed membership, which does not refuse): the holder reactivates it.
  await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','removed')", [ORG_ID, vendorA]);
  try {
    const lockMember = (c: Client) => c.query("SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE", [ORG_ID, vendorA]);
    await control("membership row", lockMember);
    s = await fresh();
    await blockedSave("membership row: session revoked", lockMember, { db: s.revoke }, async () => {}, s.cred);
    await blockedSave("membership row: reactivated by the holder", lockMember,
      { hold: c => c.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [ORG_ID, vendorA]) },
      () => db.query("UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, vendorA]));
    // (The binding, contact, organization and switches are already share-locked at this wait, so they cannot change here:
    // a writer queues behind the save, which is ordered first.)
    await assert.rejects((async () => {
      const c = await holder();
      try {
        await c.query("SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE", [ORG_ID, vendorA]);
        const p2 = save(credA, ORG_ID, other(await vendorIssuerType(credA, ORG_ID))).then(result => ({ result }), error => ({ error }));
        await waitForBlocked(c, 1);
        await db.query("SET lock_timeout='1s'");
        try { await unbind(db); } finally { await db.query("RESET lock_timeout"); await c.query("COMMIT"); await settle(p2); }
      } finally { await c.end(); }
    })(), { code: "55P03" }, "membership wait: the binding is already locked by the save");
  } finally { await db.query("DELETE FROM org_members WHERE org_id=$1 AND user_id=$2", [ORG_ID, vendorA]); }
  // Every case was restored: A saves again.
  assert.equal((await save(credA, ORG_ID, other(await vendorIssuerType(credA, ORG_ID)))).status, "recorded");
});

test("regression (r2): a binding inserted while the save waits on the membership lock is not admitted, so a contact lock cannot hold it after admission", WAIT_TEST, async () => {
  const userC = randomUUID(), credC = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b065c@example.test',now())", [userC]);
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [userC, hash(credC)]);
  const consent = buildStoredConsent("portal");
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [userC, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const contactC = await vendorContact(ORG_ID, "B-065 C (bound during the wait)");
  const invite = await inviteVendorAccount(admin, contactC, userC);
  assert.equal(invite.status, "invited");
  // 1. No binding yet; a removed membership row gives the save a membership lock to wait on.
  await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','removed')", [ORG_ID, userC]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE org_id=$1 AND user_id=$2", [ORG_ID, userC])).rows[0].n, 0);
  const request = randomUUID();
  const memberLock = await holder(), contactLock = await holder();
  let pending: Promise<Outcome> | undefined, regressed = false, expected: Record<string, string> | undefined;
  try {
    for (const c of [memberLock, contactLock]) await c.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET lock_timeout='5s'");
    // 2. Hold the membership lock and start a save.
    await memberLock.query("SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE", [ORG_ID, userC]);
    pending = save(credC, ORG_ID, "individual", request).then(result => ({ result }), error => ({ error }));
    await waitForBlocked(memberLock, 1);
    // 3. A real B-026 claim inserts the binding while the save waits.
    assert.equal((await claimVendorAccount(credC, invite.invitation!)).status, "claimed");
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE org_id=$1 AND user_id=$2", [ORG_ID, userC])).rows[0].n, 1);
    // 4. Hold FOR UPDATE on that contact, then release the membership lock.
    await contactLock.query("SELECT 1 FROM contacts WHERE id=$1 FOR UPDATE", [contactC]);
    await memberLock.query("COMMIT");
    const contactPid = (await contactLock.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
    for (let i = 0; i < 100; i++) {
      const done = await Promise.race([pending.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 50))]);
      if (done) break;
      const blocked = (await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
        AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%b065_save_issuer_type%'`, [contactPid])).rows[0].n;
      if (blocked) { regressed = true; break; }
    }
    // The contact holder archives the contact and commits (in the old code the admitted save then wrote after it).
    await contactLock.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactC]);
    expected = await snapshot(contactLock);
    await contactLock.query("COMMIT");
  } catch (error) {
    for (const c of [memberLock, contactLock]) await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.query("RESET lock_timeout");
    await memberLock.end(); await contactLock.end();
  }
  const outcome = await settle(pending!);
  // 5. Refused (or busy), never admitted, nothing written.
  assert.equal(regressed, false, "the save waited on the contact lock after its admission decision");
  assert.ok(forbidden(outcome.error) || busy(outcome.error), JSON.stringify(outcome.result ?? String(outcome.error)));
  assert.deepEqual(await snapshot(), expected, "no writes");
  assert.deepEqual(await ledger(request), []);
  assert.deepEqual(await declarations(contactC), []);
  // Positive control: with the contact live again, the same (now bound) account saves.
  await db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contactC]);
  assert.deepEqual(await save(credC, ORG_ID, "individual", request), { status: "recorded", issuerType: "individual", replayed: false });
});

test("route: account cookie and an open workbench only; strict body; 200 recorded/unchanged/replay, 409 conflict", async () => {
  const cookie = `condola_session=${credA}; condola_org=${ORG_ID}`;
  const next = other(await vendorIssuerType(credA, ORG_ID));
  const body = { requestId: randomUUID(), issuerType: next };
  const before = await snapshot();
  assert.equal((await post(body)).status, 403, "no cookie");
  assert.equal((await post(body, `condola_session=${randomBytes(32).toString("base64url")}; condola_org=${ORG_ID}`)).status, 403, "an unknown token");
  assert.equal((await post(body, `condola_session=${jobToken}; condola_org=${ORG_ID}`)).status, 403, "A's live job token as the session cookie");
  assert.equal((await post(body, `condola_session=${documentToken}; condola_org=${ORG_ID}`)).status, 403, "A's live document token as the session cookie");
  assert.equal((await post(body, `condola_session=${staffCred}; condola_org=${ORG_ID}`)).status, 403, "staff");
  assert.equal((await post(body, `condola_session=${staffVendorCred}; condola_org=${ORG_ID}`)).status, 403, "staff who also holds a vendor account");
  assert.equal((await post(body, cookie, { origin: "https://evil.test" })).status, 403, "cross-origin");
  assert.equal((await post(body, cookie, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ ...body, issuerType: "business" }, cookie)).status, 400);
  assert.equal((await post({ ...body, taxId: "04595257" }, cookie)).status, 400, "no extra fields");
  assert.equal((await post("{not json", cookie)).status, 400);
  assert.equal((await post({ ...body, pad: "x".repeat(2000) }, cookie)).status, 413);
  assert.deepEqual(await snapshot(), before);
  await flags({ vendor_activation: false });
  try {
    const off = await snapshot();
    assert.equal((await post(body, cookie)).status, 403, "gate off");
    assert.deepEqual(await snapshot(), off);
  } finally { await flags({ vendor_activation: true }); }
  const ok = await post(body, cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await ok.json(), { status: "recorded", issuerType: next, replayed: false });
  assert.deepEqual(await (await post(body, cookie)).json(), { status: "recorded", issuerType: next, replayed: true }, "replay");
  const same = await post({ requestId: randomUUID(), issuerType: next }, cookie);
  assert.equal(same.status, 200); assert.deepEqual(await same.json(), { status: "unchanged", issuerType: next, replayed: false });
  assert.equal((await post({ ...body, issuerType: other(next) }, cookie)).status, 409, "same id, other payload");
  assert.equal((await post(body, `condola_session=${credB}; condola_org=${ORG_ID}`)).status, 409, "another vendor reusing the id");
});

type El = React.ReactElement<{ children?: React.ReactNode } & Record<string, unknown>>;
function find(node: React.ReactNode, type: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(child => find(child, type));
  if (!React.isValidElement(node)) return [];
  const el = node as El;
  return [...(el.type === type ? [el] : []), ...find(el.props.children, type)];
}

test("pages: the 開立類型 row on 我的帳號, the type page and the type-2 stamp page exist only while vendor_activation admits the account", async () => {
  const jar = new Map<string, string>([["condola_session", credA], ["condola_org", ORG_ID]]);
  let path = "/vendor-account/account";
  const cookieSpy = mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
    set: () => {}, delete: () => {}, has: (key: string) => jar.has(key), getAll: () => [] }) as never);
  const headerSpy = mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": path }) as never);
  const runtime = globalThis as typeof globalThis & { React?: typeof React }; const previousReact = runtime.React; runtime.React = React;
  const render = async (route: string, page: () => Promise<React.ReactNode>) => {
    path = route;
    try { return await page(); } catch (error) {
      if (String((error as { digest?: string }).digest) === "NEXT_HTTP_ERROR_FALLBACK;404") return "404";
      throw error;
    }
  };
  /** The page body inside the vendor shell, rendered to HTML (the shell itself needs the Next router). */
  const body = (page: React.ReactNode) => {
    const shells = find(page, VendorShellV3);
    assert.equal(shells.length, 1);
    return renderToStaticMarkup(React.createElement(React.Fragment, null, shells[0].props.children));
  };
  try {
    await save(credA, ORG_ID, other(await vendorIssuerType(credA, ORG_ID)));
    await save(credA, ORG_ID, "exempt_business");
    const before = await snapshot();
    const account = await render("/vendor-account/account", VendorWorkbenchAccountPage);
    const rows = find(account, IssuerTypeRow);
    assert.equal(rows.length, 1); assert.equal(rows[0].props.issuerType, "exempt_business");
    const html = body(account);
    for (const text of [">固定資料<", ">開立類型<", "<small>免用統一發票之營業人</small>", "更改類型不會改已開出的舊 PDF。", ">管理印章<"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /回到這一案/, "回到這一案 is not part of this slice (GS-44)");
    const typePage = await render("/vendor-account/account/issuer-type", VendorIssuerTypePage);
    const forms = find(typePage, IssuerTypeForm);
    assert.equal(forms.length, 1); assert.equal(forms[0].props.current, "exempt_business");
    assert.doesNotMatch(body(typePage), /回到這一案/);
    assert.equal(find(await render("/vendor-account/account/stamp", VendorStampPage), StampNotYet).length, 1, "type 2 has the stamp page");
    assert.deepEqual(await snapshot(), before, "page renders never write");
    for (const type of ["individual", "invoice_business"] as const) {
      await save(credA, ORG_ID, type);
      assert.equal(await render("/vendor-account/account/stamp", VendorStampPage), "404", `${type}: no stamp page`);
      const page = await render("/vendor-account/account", VendorWorkbenchAccountPage);
      assert.equal(find(page, IssuerTypeRow)[0].props.issuerType, type);
      assert.doesNotMatch(body(page), /管理印章/, `${type}: no 管理印章`);
    }
    await flags({ vendor_activation: false });
    try {
      const off = await snapshot();
      const page = await render("/vendor-account/account", VendorWorkbenchAccountPage);
      assert.equal(find(page, IssuerTypeRow).length, 0, "OFF: no row");
      assert.doesNotMatch(body(page), /開立類型|管理印章|v-act-/, "OFF: nothing of B-065 in the rendered account page");
      assert.equal(await render("/vendor-account/account/issuer-type", VendorIssuerTypePage), "404");
      assert.equal(await render("/vendor-account/account/stamp", VendorStampPage), "404");
      assert.deepEqual(await snapshot(), off, "page renders never write");
    } finally { await flags({ vendor_activation: true }); }
    jar.set("condola_session", staffCred);
    assert.equal(find(await render("/vendor-account/account/issuer-type", VendorIssuerTypePage), IssuerTypeForm).length, 0, "staff never gets the form");
  } finally {
    cookieSpy.mock.restore(); headerSpy.mock.restore();
    runtime.React = previousReact;
  }
});
