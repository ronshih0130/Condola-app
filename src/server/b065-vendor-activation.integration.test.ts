import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import React from "react";
import { Client } from "pg";
import { POST as saveRoute } from "../app/api/vendor-account/issuer-type/route";
import VendorWorkbenchAccountPage from "../app/vendor-account/account/page";
import VendorIssuerTypePage from "../app/vendor-account/account/issuer-type/page";
import VendorStampPage from "../app/vendor-account/account/stamp/page";
import { IssuerTypeForm, IssuerTypeRow, StampNotYet } from "../components/v3/vendor/vendor-activation";
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
const vendorA = randomUUID(), vendorB = randomUUID();
const credA = randomUUID(), credB = randomUUID(), staffCred = randomUUID();
let contactA = "", contactB = "", foreignB = "";
const brandEnv = process.env.BRAND_V2;

async function vendorContact(org: string, name: string) {
  return (await db.query("INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,$2,'+886912345678') RETURNING id::text", [org, name])).rows[0].id as string;
}
async function flags(patch: Record<string, unknown>, org = ORG_ID) {
  await db.query("UPDATE organizations SET feature_flags=feature_flags||$2::jsonb WHERE id=$1", [org, JSON.stringify(patch)]);
}
async function accountGate(enabled: boolean) {
  await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_account'", [JSON.stringify({ enabled, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
}
async function activationGate(value: unknown) {
  await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_activation'", [JSON.stringify(value)]);
}
const ACTIVATION_ON = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] };
/** Everything a B-065 writer could change. */
async function snapshot() {
  const out: Record<string, string> = {};
  for (const table of ["app.b065_issuer_types", "public.audit_log", "public.contacts", "public.vendor_profiles"]) {
    out[table] = (await db.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) h FROM ${table} r`)).rows[0].h;
  }
  return out;
}
const save = (cred: string, org: string, issuerType: IssuerType, requestId = randomUUID()) => saveVendorIssuerType(cred, org, { requestId, issuerType });
const sqlSave = (credHash: string, org: string | null, type: string | null, request: string | null = randomUUID()) => svc(null, async client =>
  (await client.query("SELECT app.b065_save_issuer_type($1,$2::uuid,false,$3::uuid,$4) r", [credHash, org, request, type])).rows[0].r);
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
const refused = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501" || (error as { code?: string }).code === "42501";
const declarations = async (contact: string) => (await db.query(
  "SELECT issuer_type,declared_by::text FROM app.b065_issuer_types WHERE contact_id=$1 ORDER BY declared_at,request_id", [contact])).rows;
const writes = async (contact: string) => JSON.stringify({
  rows: (await db.query("SELECT count(*)::int n FROM app.b065_issuer_types WHERE contact_id=$1", [contact])).rows,
  audit: (await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_issuer_type' AND row_id=$1", [contact])).rows,
});
const post = (body: unknown, cookie?: string, headers: Record<string, string> = {}) => saveRoute(new Request(`${origin}/api/vendor-account/issuer-type`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }));

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  delete process.env.BRAND_V2;
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'b065a@example.test',now()),($2,'b065b@example.test',now())", [vendorA, vendorB]);
  for (const [id, user, cred] of [[admin.sessionId, admin.userId, staffCred], [coast.sessionId, coast.userId, randomUUID()], [randomUUID(), vendorA, credA], [randomUUID(), vendorB, credB]]) {
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, user, hash(cred)]);
  }
  const consent = buildStoredConsent("portal");
  for (const user of [vendorA, vendorB, admin.userId]) await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [user, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  // The migration seeds the platform switch OFF.
  assert.deepEqual((await db.query("SELECT value FROM platform_settings WHERE key='vendor_activation'")).rows[0].value, { enabled: false, allowed_org_ids: [] });
  await accountGate(true);
  await activationGate(ACTIVATION_ON);
  for (const org of [ORG_ID, ORG2_ID]) await flags({ vendor_account: true, vendor_dispatch: true, vendor_workbench: true, brand_v2: true, brand_v3: true, vendor_activation: true }, org);
  contactA = await vendorContact(ORG_ID, "B-065 A"); contactB = await vendorContact(ORG_ID, "B-065 B");
  foreignB = await vendorContact(ORG2_ID, "B-065 B in ORG2");
  for (const [session, contact, user, cred] of [[admin, contactA, vendorA, credA], [admin, contactB, vendorB, credB], [coast, foreignB, vendorB, credB]] as const) {
    const invite = await inviteVendorAccount(session, contact, user);
    assert.equal(invite.status, "invited");
    assert.equal((await claimVendorAccount(cred, invite.invitation!)).status, "claimed");
  }
});

test.after(async () => {
  if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("privileges: gateways service-only, helpers unexecutable, the table fully revoked with RLS on; flag seeded OFF", async () => {
  const gateways = ["app.b065_issuer_view(text,uuid,boolean)", "app.b065_save_issuer_type(text,uuid,boolean,uuid,text)"];
  const helpers = ["app.b065_enabled(uuid,boolean)", "app.b065_account_contact(text,uuid,boolean,boolean)"];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [...gateways, ...helpers]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok,
        role === "service_role" && gateways.includes(signature), `${role} ${signature}`);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.b065_issuer_types',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
    }
    assert.equal((await db.query("SELECT has_any_column_privilege($1,'app.b065_issuer_types','SELECT,INSERT,UPDATE,REFERENCES') ok", [role])).rows[0].ok, false);
    await db.query("BEGIN");
    try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query("SELECT 1 FROM app.b065_issuer_types"), { code: "42501" }); }
    finally { await db.query("ROLLBACK"); }
    if (role !== "service_role") {
      await db.query("BEGIN");
      try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query("SELECT app.b065_save_issuer_type(NULL,NULL,false,NULL,NULL)"), { code: "42501" }); }
      finally { await db.query("ROLLBACK"); }
    }
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b065_issuer_types'::regclass")).rows[0].relrowsecurity, true);
  const fns = (await db.query(`SELECT p.proname,p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner) owner FROM pg_proc p
    WHERE p.pronamespace='app'::regnamespace AND p.proname LIKE 'b065\\_%' ORDER BY 1`)).rows;
  assert.equal(fns.length, 4);
  // Ownership (postgres on Supabase) is asserted by scripts/check-function-privileges.sh; locally the owner is the migration role.
  for (const fn of fns) assert.deepEqual([fn.prosecdef, fn.provolatile, fn.proconfig], [true, "v", ["search_path=pg_catalog, pg_temp"]], fn.proname);
});

test("read: never declared is null; each vendor reads only their own contact in an org they hold an account in", async () => {
  assert.equal(await vendorIssuerType(credA, ORG_ID), null);
  assert.equal(await vendorIssuerType(credB, ORG_ID), null);
  assert.equal(await vendorIssuerType(credB, ORG2_ID), null);
  await assert.rejects(vendorIssuerType(credA, ORG2_ID), forbidden, "no account in that org");
  await assert.rejects(vendorIssuerType(staffCred, ORG_ID), forbidden, "a staff session is not a vendor account");
  await assert.rejects(vendorIssuerType("", ORG_ID), forbidden);
});

test("transitions: any type to any other is one row and one audit row; the same type again is unchanged with no write", async () => {
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
    const before = await snapshot();
    assert.deepEqual(await save(credA, ORG_ID, type), { status: "unchanged", issuerType: type });
    assert.deepEqual(await snapshot(), before, `${type} again: no write`);
    previous = type;
  }
  assert.deepEqual((await declarations(contactA)).map(r => r.issuer_type), path, "append-only history; old rows never change");
  assert.ok((await declarations(contactA)).every(r => r.declared_by === vendorA));
  // B's declaration is B's own; A's current type does not move.
  assert.equal((await save(credB, ORG_ID, "invoice_business")).status, "recorded");
  assert.equal(await vendorIssuerType(credA, ORG_ID), "individual");
  assert.equal(await vendorIssuerType(credB, ORG_ID), "invoice_business");
  assert.equal(await vendorIssuerType(credB, ORG2_ID), null, "per org: B in ORG2 has not declared");
  // Invalid values are refused after admission with no write.
  const before = await snapshot();
  for (const bad of ["business", "", "INDIVIDUAL", "invoice_business ", null]) assert.deepEqual(await sqlSave(hash(credA), ORG_ID, bad), { status: "rejected_invalid" }, String(bad));
  assert.deepEqual(await sqlSave(hash(credA), ORG_ID, "exempt_business", null), { status: "rejected_invalid" }, "no request id");
  assert.deepEqual(await snapshot(), before);
  // vendor_profiles is never written by phase A.
  assert.equal((await db.query("SELECT count(*)::int n FROM vendor_profiles WHERE contact_id IN ($1,$2)", [contactA, contactB])).rows[0].n, 0);
});

test("idempotent: a replay is the first answer even with another body; another vendor reusing the id is a conflict with no write", async () => {
  const request = randomUUID();
  const current = await vendorIssuerType(credA, ORG_ID);
  const next: IssuerType = current === "exempt_business" ? "individual" : "exempt_business";
  const first = await save(credA, ORG_ID, next, request);
  assert.deepEqual(first, { status: "recorded", issuerType: next, replayed: false });
  const after = await snapshot();
  assert.deepEqual(await save(credA, ORG_ID, next, request), { ...first, replayed: true });
  assert.deepEqual(await save(credA, ORG_ID, "invoice_business", request), { ...first, replayed: true }, "same request, other type: still the first");
  assert.deepEqual(await save(credB, ORG_ID, "individual", request), { status: "rejected_conflict" }, "another vendor cannot reuse it");
  assert.deepEqual(await snapshot(), after);
  assert.equal(await vendorIssuerType(credA, ORG_ID), next);
  // The same id in another org is a different request (B in ORG2).
  assert.deepEqual(await save(credB, ORG2_ID, "individual", request), { status: "recorded", issuerType: "individual", replayed: false });
});

test("denials write nothing: job token as the cookie, revoked or expired session, staff, other org, unlinked contact, every gate OFF", async () => {
  const jobToken = randomBytes(32).toString("base64url");
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id)
    SELECT $1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),id,'open','B-065 bearer',$2
    FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, contactA])).rows[0].id;
  await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id,sharing_approved_at)
    VALUES($1,$2,'B-065 A','+886912345678','x',$3,clock_timestamp()+interval '1 day',$4,$5,clock_timestamp())`,
  [ORG_ID, ticket, hashVendorToken(jobToken), USERS.admin, contactA]);
  assert.equal((await db.query("SELECT count(*)::int n FROM repair_vendor_jobs WHERE token_hash=$1 AND active", [hashVendorToken(jobToken)])).rows[0].n, 1);
  const revoked = randomUUID(), expired = randomUUID();
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,clock_timestamp()+interval '1 hour',clock_timestamp())", [vendorA, hash(revoked)]);
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()-interval '1 second')", [vendorA, hash(expired)]);
  const target: IssuerType = (await vendorIssuerType(credA, ORG_ID)) === "invoice_business" ? "individual" : "invoice_business";
  const deny = async (label: string, cred: string, org = ORG_ID) => {
    const before = await snapshot();
    await assert.rejects(save(cred, org, target), forbidden, `${label}: save`);
    await assert.rejects(sqlSave(hash(cred), org, target), refused, `${label}: SQL save`);
    await assert.rejects(sqlSave(hash(cred), org, "not-a-type"), refused, `${label}: an invalid body is still refused first`);
    await assert.rejects(vendorIssuerType(cred, org), forbidden, `${label}: read`);
    assert.deepEqual(await snapshot(), before, `${label}: no writes`);
  };
  await deny("a live vendor job token as the session cookie", jobToken);
  await deny("revoked session", revoked);
  await deny("expired session", expired);
  await deny("staff session", staffCred);
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
  // Re-admitted after every gate was restored.
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

test("two vendors sharing one request id in parallel: exactly one recorded, one rejected_conflict, no 23505", async () => {
  const request = randomUUID();
  const lock = await holder();
  const before = { a: await writes(contactA), b: await writes(contactB) };
  const [a, b] = [await vendorIssuerType(credA, ORG_ID), await vendorIssuerType(credB, ORG_ID)];
  let runs: Promise<{ result?: { status: string }; error?: unknown }>[] = [];
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('b065/issuer/'||$1::text||'/'||$2::text,0))", [ORG_ID, request]);
    runs = [save(credA, ORG_ID, a === "exempt_business" ? "individual" : "exempt_business", request),
      save(credB, ORG_ID, b === "exempt_business" ? "individual" : "exempt_business", request)].map(p => p.then(result => ({ result }), error => ({ error })));
    await waitForBlocked(lock, 2);
  } finally { await lock.query("COMMIT").catch(() => undefined); await lock.end(); }
  const outcomes = await Promise.all(runs);
  assert.ok(outcomes.every(o => !o.error), JSON.stringify(outcomes.map(o => String(o.error))));
  assert.deepEqual(outcomes.map(o => o.result!.status).sort(), ["recorded", "rejected_conflict"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b065_issuer_types WHERE org_id=$1 AND request_id=$2", [ORG_ID, request])).rows[0].n, 1);
  const loser = outcomes[0].result!.status === "rejected_conflict" ? "a" : "b";
  assert.equal(await writes(loser === "a" ? contactA : contactB), before[loser], "the loser wrote nothing");
});

test("two saves of one vendor in parallel (different request ids): serialized per org, the later one sees the first", async () => {
  const lock = await holder();
  const current = await vendorIssuerType(credA, ORG_ID);
  const next: IssuerType = current === "invoice_business" ? "individual" : "invoice_business";
  const before = (await declarations(contactA)).length;
  let runs: Promise<{ result?: { status: string }; error?: unknown }>[] = [];
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

test("a save waiting on a lock is refused if the session, the binding or any gate changes during the wait", async () => {
  // A fresh revocable session for each run of the "session revoked" case.
  let revocable = "", sessionId = "";
  const freshSession = async () => {
    revocable = randomUUID();
    sessionId = (await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id", [vendorA, hash(revocable)])).rows[0].id;
    return revocable;
  };
  const account = (await db.query("SELECT * FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA])).rows[0];
  assert.equal(account.user_id, vendorA);
  const A = async () => credA;
  const cases: [string, () => Promise<unknown>, () => Promise<unknown>, () => Promise<string>][] = [
    ["session revoked", () => db.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sessionId]), async () => {}, freshSession],
    ["vendor_activation off", () => flags({ vendor_activation: false }), () => flags({ vendor_activation: true }), A],
    ["vendor_workbench off", () => flags({ vendor_workbench: false }), () => flags({ vendor_workbench: true }), A],
    ["brand_v3 off", () => flags({ brand_v3: false }), () => flags({ brand_v3: true }), A],
    ["B-026 platform off", () => accountGate(false), () => accountGate(true), A],
    ["account revoked (row removed)", () => db.query("DELETE FROM app.b026_vendor_accounts WHERE org_id=$1 AND contact_id=$2", [ORG_ID, contactA]),
      () => db.query("INSERT INTO app.b026_vendor_accounts SELECT * FROM jsonb_populate_record(NULL::app.b026_vendor_accounts,$1::jsonb)", [JSON.stringify(account)]), A],
    ["contact archived", () => db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contactA]), () => db.query("UPDATE contacts SET archived_at=NULL WHERE id=$1", [contactA]), A],
  ];
  for (const key of ["request", "org"] as const) {
    for (const [label, change, restore, credential] of cases) {
      const request = randomUUID(), cred = await credential();
      const current = await vendorIssuerType(credA, ORG_ID);
      const next: IssuerType = current === "exempt_business" ? "individual" : "exempt_business";
      const before = await writes(contactA);
      const lock = await holder();
      let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
      try {
        await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key === "request" ? `b065/issuer/${ORG_ID}/${request}` : `b065/issuer-org/${ORG_ID}`]);
        pending = save(cred, ORG_ID, next, request).then(result => ({ result }), error => ({ error }));
        await waitForBlocked(lock, 1);
        await change();
      } finally { await lock.query("ROLLBACK").catch(() => undefined); await lock.end(); }
      const outcome = await pending!;
      try {
        assert.ok(forbidden(outcome.error), `${key} ${label}: ${JSON.stringify(outcome.result)}`);
        assert.equal(await writes(contactA), before, `${key} ${label}: no writes`);
      } finally { await restore(); }
    }
  }
  assert.equal(typeof (await vendorIssuerType(credA, ORG_ID)), "string", "every gate restored");
});

test("route: account cookie and an open workbench only; strict body; 200 recorded/unchanged/replay, 409 conflict", async () => {
  const cookie = `condola_session=${credA}; condola_org=${ORG_ID}`;
  const current = await vendorIssuerType(credA, ORG_ID);
  const next: IssuerType = current === "individual" ? "exempt_business" : "individual";
  const body = { requestId: randomUUID(), issuerType: next };
  const before = await snapshot();
  assert.equal((await post(body)).status, 403, "no cookie");
  assert.equal((await post(body, `condola_session=${randomBytes(32).toString("base64url")}`)).status, 403, "a token is not a session");
  assert.equal((await post(body, `condola_session=${staffCred}; condola_org=${ORG_ID}`)).status, 403, "staff");
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
  assert.equal(same.status, 200); assert.deepEqual(await same.json(), { status: "unchanged", issuerType: next });
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
  try {
    await save(credA, ORG_ID, (await vendorIssuerType(credA, ORG_ID)) === "exempt_business" ? "individual" : "exempt_business");
    await save(credA, ORG_ID, "exempt_business");
    const before = await snapshot();
    const account = await render("/vendor-account/account", VendorWorkbenchAccountPage);
    const rows = find(account, IssuerTypeRow);
    assert.equal(rows.length, 1); assert.equal(rows[0].props.issuerType, "exempt_business");
    const typePage = await render("/vendor-account/account/issuer-type", VendorIssuerTypePage);
    const forms = find(typePage, IssuerTypeForm);
    assert.equal(forms.length, 1); assert.equal(forms[0].props.current, "exempt_business");
    assert.equal(find(await render("/vendor-account/account/stamp", VendorStampPage), StampNotYet).length, 1, "type 2 has the stamp page");
    assert.deepEqual(await snapshot(), before, "page renders never write");
    for (const other of ["individual", "invoice_business"] as const) {
      await save(credA, ORG_ID, other);
      assert.equal(await render("/vendor-account/account/stamp", VendorStampPage), "404", `${other}: no stamp page`);
      assert.equal(find(await render("/vendor-account/account", VendorWorkbenchAccountPage), IssuerTypeRow)[0].props.issuerType, other);
    }
    await flags({ vendor_activation: false });
    try {
      const off = await snapshot();
      assert.equal(find(await render("/vendor-account/account", VendorWorkbenchAccountPage), IssuerTypeRow).length, 0, "OFF: no row");
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
