import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { leaseLifecycleView, recordLeaseNotice, respondLeaseNotice } from "./lease-lifecycle";
import { ownerPortalExtensionsEnabled } from "./owner-portal-access";
import {
  ownerLifecycleDetail, ownerLifecycleItems, ownerMessageThreads, ownerThread, postOwnerMessage, replyOwnerLifecycle,
  staffOwnerLifecycleReplies, staffOwnerThreads,
} from "./owner-replies-messages";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const FLAG = "owner_portal_extensions", RENEWAL = "lease_renewal";
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, staff: Session, tenant: Session;
let A: Session, A2: Session, B: Session, C: Session, D: Session, F: Fixture;

test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  staff = await session(USERS.admin, "staff", "admin");
  await flags(true, true);
  F = await fixture();
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });
test.beforeEach(async () => { await flags(true, true); });

async function session(userId: string, kind: Session["kind"], role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const id = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [id, userId, randomUUID()]);
  return { userId, sessionId: id, orgId, liveOrgId: orgId, environment: "live", kind, role, email: "fixture@example.invalid", name: "Fixture", locale: "en", calendar: "gregorian", leaseId: null };
}
async function setFlag(key: string, on: boolean) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($3::text,$4::text)))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($1::text,$2::boolean) WHERE id=ANY($3::uuid[])`, [key, on, [ORG_ID, ORG2_ID]]);
}
async function flags(portal: boolean, renewal: boolean) { await setFlag(FLAG, portal); await setFlag(RENEWAL, renewal); }
async function user(org: string, name: string, owner: boolean) {
  const id = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [id, `${id}@example.invalid`]);
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,user_id,display_name) VALUES($1,$2,$3,$4) RETURNING id`, [org, owner, id, name])).rows[0].id;
  return { session: await session(id, owner ? "owner" : "tenant", null, org), contact };
}
async function property(org: string) {
  const id = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id`,
    [org, `Synthetic ${randomUUID().slice(0, 8)}`])).rows[0].id;
  const unit = (await db.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'5F') RETURNING id`, [org, id])).rows[0].id;
  return { id, unit };
}
async function own(org: string, prop: string, contact: string, from: string, to: string | null) {
  return (await db.query<{ id: string }>(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,effective_to,ownership_bp) VALUES($1,$2,$3,$4,$5,5000) RETURNING id`,
    [org, prop, contact, from, to])).rows[0].id;
}
async function lease(org: string, p: { id: string; unit: string }, start: string, end: string | null, status = "active") {
  return (await db.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,due_day)
    VALUES($1,$2,$3,$3,$4,$5,$6,'TWD',2000000,1) RETURNING id`, [org, p.id, p.unit, status, start, end])).rows[0].id;
}
async function notice(org: string, leaseId: string, party: "tenant" | "management" | "owner", kind = "non_renewal_notice", version = 1, record = randomUUID()) {
  await db.query(`INSERT INTO app.b012_notice_versions(org_id,lease_id,record_id,version,kind,party,actor_user_id,source,effective_on,body)
    VALUES($1,$2,$3,$4,$5,$6,$7,'self_report','2026-12-31','PRIVATE NOTICE TEXT 0912-000-000')`, [org, leaseId, record, version, kind, party, USERS.admin]);
  return record;
}

async function fixture() {
  const a = await user(ORG_ID, "Owner A", true), a2 = await user(ORG_ID, "Owner A2", true), b = await user(ORG_ID, "Owner B", true);
  const c = await user(ORG_ID, "Owner C", true), d = await user(ORG2_ID, "Owner D", true), t = await user(ORG_ID, "Tenant T", false);
  A = a.session; A2 = a2.session; B = b.session; C = c.session; D = d.session; tenant = t.session;
  const p1 = await property(ORG_ID), p2 = await property(ORG_ID), p3 = await property(ORG_ID), p4 = await property(ORG2_ID);
  const aP1 = await own(ORG_ID, p1.id, a.contact, "2020-01-01", null);   // A current on P1
  await own(ORG_ID, p1.id, a2.contact, "2020-01-01", null);              // A2 co-owner, current on P1
  await own(ORG_ID, p2.id, b.contact, "2020-01-01", null);               // B current on P2
  await own(ORG_ID, p3.id, a.contact, "2019-01-01", "2022-01-01");       // A ended on P3
  await own(ORG_ID, p3.id, c.contact, "2022-01-01", null);               // C current on P3
  await own(ORG2_ID, p4.id, d.contact, "2020-01-01", null);              // D in another org
  const l1 = await lease(ORG_ID, p1, "2024-01-01", null), l2 = await lease(ORG_ID, p2, "2024-01-01", null);
  const l3 = await lease(ORG_ID, p3, "2022-06-01", null), l4 = await lease(ORG2_ID, p4, "2024-01-01", null);
  const l3old = await lease(ORG_ID, p3, "2020-01-01", "2021-12-31", "ended");
  const draft = await lease(ORG_ID, p1, "2027-01-01", null, "draft");
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, l1, t.contact]);
  // n1 on P1: filed by the tenant through B-012, then tenant and company responses through B-012.
  const n1 = randomUUID();
  assert.equal((await recordLeaseNotice(tenant, l1, { recordId: n1, expectedVersion: 0, kind: "non_renewal_notice", source: "self_report",
    occurredOn: null, effectiveOn: "2026-12-31", body: "PRIVATE TENANT NOTICE TEXT" })).state, "recorded");
  assert.equal((await respondLeaseNotice(tenant, l1, { recordId: n1, noticeVersion: 1, expectedVersion: 0, response: "disagree", body: "TENANT RESPONSE BODY" })).state, "recorded");
  assert.equal((await respondLeaseNotice(staff, l1, { recordId: n1, noticeVersion: 1, expectedVersion: 0, response: "agree", body: "COMPANY RESPONSE BODY" })).state, "recorded");
  const n2 = await notice(ORG_ID, l2, "management", "renewal_intent");
  const n3 = await notice(ORG_ID, l3, "tenant", "early_termination_notice");
  const n3old = await notice(ORG_ID, l3old, "tenant");
  const n4 = await notice(ORG2_ID, l4, "tenant");
  const nDraft = await notice(ORG_ID, draft, "management");
  return { p1: p1.id, p2: p2.id, p3: p3.id, p4: p4.id, l1, l4, aP1, n1, n2, n3, n3old, n4, nDraft, aContact: a.contact, a2Contact: a2.contact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function raw(s: Session, sql: string, params: unknown[] = []) {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [s.userId, s.orgId, s.environment]);
    await db.query("SET LOCAL ROLE authenticated"); const result = await db.query(sql, params); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
const denied = (error: unknown) => (error as { code?: string }).code === "42501";
const hash = async (sql: string) => (await db.query(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h, count(*)::int n FROM (${sql}) x`)).rows[0];
async function b023Writes() {
  return {
    replies: await hash(`SELECT * FROM app.b023_owner_lifecycle_replies`),
    threads: await hash(`SELECT * FROM app.b023_owner_threads`),
    requests: await hash(`SELECT * FROM app.b023_owner_message_requests`),
    messages: await hash(`SELECT id, thread_id, body, sender_contact_id, sender_member_id, deleted_at FROM public.messages`),
    message_threads: await hash(`SELECT id, kind, lease_id, property_id, last_message_at FROM public.message_threads`),
  };
}
/** Consent, signature, acknowledgement, confirmation, read and B-012 response state across the schema. */
async function consentFacts() {
  const tables = ["public.consents", "public.partner_agreement_consents", "public.lease_signatures", "public.lease_signature_events",
    "public.esign_signers", "public.esign_audit_events", "public.thread_participants", "public.notifications",
    "app.deposit_settlement_confirmations", "app.b022_report_replies", "app.b012_response_versions", "app.b012_notice_versions",
    "app.b012_replacements", "app.b013_estimate_decisions", "app.b028_center_reads", "app.b028_read_markers", "app.b010_payment_confirmations",
    "app.b023_owner_document_access_events"];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    if (!(await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])).rows[0].ok) continue;
    out[t] = await hash(`SELECT * FROM ${t}`);
  }
  // Flag and authority fixture toggles are themselves audited; everything else must be untouched.
  out.audit_log = await hash(`SELECT * FROM public.audit_log WHERE table_name NOT IN ('organizations','platform_settings','property_owners')`);
  out.leases = await hash(`SELECT id, status, esign_status, signed_at, document_file_id, previous_lease_id FROM leases`);
  return out;
}
const reply = (s: Session, recordId: string, body = "Owner reply text", requestId = randomUUID(), noticeVersion = 1) =>
  replyOwnerLifecycle(s, { recordId, noticeVersion, requestId, body });
const post = (s: Session, propertyId: string, body = "Owner message", requestId = randomUUID()) => postOwnerMessage(s, { propertyId, requestId, body });
const recordIds = async (s: Session) => ((await ownerLifecycleItems(s)) ?? []).map(r => r.record_id).sort();

test("lifecycle items: current authority only; multi-property, co-owner and cross-org isolation; owner-safe projection", async () => {
  assert.deepEqual(await recordIds(A), [F.n1]);
  assert.deepEqual(await recordIds(A2), [F.n1], "co-owner also holds current authority");
  assert.deepEqual(await recordIds(B), [F.n2]);
  assert.deepEqual(await recordIds(C), [F.n3], "successor sees the current lease, not the predecessor-period lease");
  assert.deepEqual(await recordIds(D), [F.n4]);
  const rows = await ownerLifecycleItems(A) ?? [];
  assert.deepEqual(Object.keys(rows[0]).sort(), ["effective_on", "filed_by", "kind", "lease_end", "lease_id", "lease_start", "lease_status", "my_last_reply_at",
    "my_reply_count", "notice_at", "notice_version", "occurred_on", "property_name", "record_id", "room_label", "unit_label"]);
  assert.equal(rows[0].filed_by, "tenant"); assert.equal(rows[0].kind, "non_renewal_notice"); assert.equal(rows[0].notice_version, 1);
  assert.equal((await ownerLifecycleItems(B))?.[0].filed_by, "company", "management is presented as the company");
  const detail = await ownerLifecycleDetail(A, F.n1);
  const serialized = JSON.stringify([rows, detail]);
  for (const secret of ["PRIVATE TENANT NOTICE TEXT", "PRIVATE NOTICE TEXT", "0912", "TENANT RESPONSE BODY", "COMPANY RESPONSE BODY", USERS.admin, tenant.userId]) {
    assert.ok(!serialized.includes(secret), secret);
  }
  for (const [s, id] of [[A, F.n2], [A, F.n3], [A, F.n3old], [A, F.n4], [A, F.nDraft], [B, F.n1], [C, F.n3old], [D, F.n1], [staff, F.n1], [tenant, F.n1]] as const) {
    assert.equal(await ownerLifecycleDetail(s, id), null, `${s.name}:${id}`);
  }
  assert.equal(await ownerLifecycleItems(staff), null);
  assert.equal(await ownerLifecycleItems({ ...A, orgId: ORG2_ID }), null);
  await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_owner_lifecycle_items($1)`, [ORG_ID]), denied);
  await assert.rejects(() => raw({ ...D, orgId: ORG_ID }, `SELECT * FROM app.b023_owner_lifecycle_items($1)`, [ORG_ID]), denied);
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_lifecycle_detail($1,$2)`, [ORG_ID, F.n2]), denied);
});

test("owner reply is a separate record: tenant and company B-012 responses are never overwritten, merged or presented as the owner's", async () => {
  const facts = await consentFacts(), tenantView = await leaseLifecycleView(tenant, F.l1), staffView = await leaseLifecycleView(staff, F.l1);
  assert.deepEqual(tenantView?.responses.map(r => [r.party, r.response, r.body]).sort(), [["management", "agree", "COMPANY RESPONSE BODY"], ["tenant", "disagree", "TENANT RESPONSE BODY"]]);
  const result = await reply(A, F.n1, "  I would like to discuss the notice.  ");
  assert.equal(result.state, "recorded");
  const rows = (await db.query(`SELECT * FROM app.b023_owner_lifecycle_replies WHERE record_id=$1`, [F.n1])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "I would like to discuss the notice."); assert.equal(rows[0].owner_contact_id, F.aContact);
  assert.equal(rows[0].actor_user_id, A.userId); assert.equal(rows[0].notice_version, 1); assert.equal(rows[0].lease_id, F.l1);
  assert.deepEqual(await consentFacts(), facts, "B-012 notices/responses, consents, signatures, confirmations, reads and audit unchanged");
  assert.deepEqual(await leaseLifecycleView(tenant, F.l1), tenantView, "tenant's B-012 view unchanged");
  assert.deepEqual(await leaseLifecycleView(staff, F.l1), staffView, "company's B-012 view unchanged");
  const mine = await ownerLifecycleDetail(A, F.n1);
  assert.ok(mine);
  assert.deepEqual(mine.my_replies.map(r => r.body), ["I would like to discuss the notice."]);
  for (const r of mine.my_replies) assert.deepEqual(Object.keys(r).sort(), ["body", "created_at", "id", "notice_version"]);
  assert.equal(mine.my_reply_count, 1);
  const coOwner = await ownerLifecycleDetail(A2, F.n1);
  assert.deepEqual(coOwner?.my_replies, [], "a co-owner never sees another owner's reply as theirs");
  assert.equal(coOwner?.my_reply_count, 0);
  // Direct table access is closed to API roles.
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_lifecycle_replies`), denied);
  await assert.rejects(() => raw(staff, `INSERT INTO app.b023_owner_lifecycle_replies(org_id,lease_id,record_id,notice_version,owner_contact_id,actor_user_id,request_id,body)
    VALUES($1,$2,$3,1,$4,$5,$6,'x')`, [ORG_ID, F.l1, F.n1, F.aContact, USERS.admin, randomUUID()]), denied);
  await assert.rejects(() => db.query(`UPDATE app.b023_owner_lifecycle_replies SET body='changed' WHERE id=$1`, [rows[0].id]), (e: { code?: string }) => e.code === "55000");
  await assert.rejects(() => db.query(`DELETE FROM app.b023_owner_lifecycle_replies WHERE id=$1`, [rows[0].id]), (e: { code?: string }) => e.code === "55000");
});

test("lifecycle reply is idempotent by request id; conflicting reuse and stale notice versions write nothing", async () => {
  const request = randomUUID();
  const first = await reply(A2, F.n1, "Co-owner reply", request);
  assert.equal(first.state, "recorded");
  const again = await reply(A2, F.n1, "Co-owner reply", request);
  assert.deepEqual(again, { state: "replayed", id: (first as { id: string }).id });
  const before = await b023Writes();
  assert.deepEqual(await reply(A2, F.n1, "Different text", request), { state: "conflict" });
  assert.deepEqual(await reply(A, F.n1, "Co-owner reply", request), { state: "conflict" }, "another owner cannot reuse the request id");
  assert.deepEqual(await reply(A2, F.n1, "   "), { state: "invalid" });
  assert.deepEqual(await reply(A2, F.n1, "x".repeat(2001)), { state: "invalid" });
  assert.deepEqual(await reply(A2, F.n1, "ok", randomUUID(), 0), { state: "invalid" });
  // The tenant revises the notice through B-012: replies to version 1 are now stale.
  assert.equal((await recordLeaseNotice(tenant, F.l1, { recordId: F.n1, expectedVersion: 1, kind: "non_renewal_notice", source: "self_report",
    occurredOn: null, effectiveOn: "2027-01-31", body: "PRIVATE TENANT NOTICE TEXT v2" })).state, "recorded");
  assert.deepEqual(await reply(A2, F.n1, "Late reply"), { state: "stale" });
  assert.deepEqual(await b023Writes(), before, "conflict/invalid/stale wrote nothing");
  assert.deepEqual(await reply(A2, F.n1, "Co-owner reply", request), { state: "replayed", id: (first as { id: string }).id }, "replay stays a replay after the notice changes");
  assert.equal((await reply(A2, F.n1, "Reply to v2", randomUUID(), 2)).state, "recorded");
  assert.equal((await ownerLifecycleItems(A2))?.[0].notice_version, 2);
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.b023_owner_lifecycle_replies WHERE request_id=$1`, [request])).rows[0].n, 1);
});

test("authority ended or session revoked at submit ⇒ denied with zero writes", async () => {
  const before = await b023Writes();
  const revoked = await session(A.userId, "owner", null);
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [revoked.sessionId]);
  assert.deepEqual(await reply(revoked, F.n1), { state: "unavailable" });
  assert.deepEqual(await post(revoked, F.p1), { state: "unavailable" });
  await assert.rejects(() => raw(A, `SELECT app.b023_reply_owner_lifecycle($1,$2,$3,1,$4,'x')`, [ORG_ID, revoked.sessionId, F.n1, randomUUID()]), denied);
  // End A's authority on P1 today (exclusive end at the property-local date).
  await db.query(`UPDATE property_owners SET effective_to=(now() AT TIME ZONE 'Asia/Taipei')::date WHERE id=$1`, [F.aP1]);
  try {
    assert.deepEqual(await reply(A, F.n1), { state: "unavailable" });
    assert.deepEqual(await post(A, F.p1), { state: "unavailable" });
    await assert.rejects(() => raw(A, `SELECT app.b023_reply_owner_lifecycle($1,$2,$3,2,$4,'x')`, [ORG_ID, A.sessionId, F.n1, randomUUID()]), denied);
    await assert.rejects(() => raw(A, `SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, A.sessionId, F.p1, randomUUID()]), denied);
    assert.deepEqual(await recordIds(A), [], "ended authority hides the item");
    assert.equal(await ownerLifecycleDetail(A, F.n1), null);
    assert.equal(await ownerThread(A, F.p1), null);
    assert.ok(!(await ownerMessageThreads(A) ?? []).some(r => r.property_id === F.p1));
    assert.deepEqual(await recordIds(A2), [F.n1], "co-owner's authority is unaffected");
    assert.deepEqual(await b023Writes(), before, "zero writes");
  } finally {
    await db.query(`UPDATE property_owners SET effective_to=NULL WHERE id=$1`, [F.aP1]);
  }
});

test("foreign, cross-org, draft and staff ids are denied with zero writes", async () => {
  const before = await b023Writes();
  for (const foreign of [F.n2, F.n3, F.n3old, F.n4, F.nDraft, randomUUID()]) {
    assert.deepEqual(await reply(A, foreign), { state: "unavailable" }, foreign);
    await assert.rejects(() => raw(A, `SELECT app.b023_reply_owner_lifecycle($1,$2,$3,1,$4,'x')`, [ORG_ID, A.sessionId, foreign, randomUUID()]), denied);
  }
  for (const prop of [F.p2, F.p3, F.p4, randomUUID()]) {
    assert.deepEqual(await post(A, prop), { state: "unavailable" }, prop);
    assert.equal(await ownerThread(A, prop), null);
    await assert.rejects(() => raw(A, `SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, A.sessionId, prop, randomUUID()]), denied);
    await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_thread_messages($1,$2)`, [ORG_ID, prop]), denied);
  }
  assert.deepEqual(await reply(D, F.n1), { state: "unavailable" });
  assert.deepEqual(await reply({ ...A, orgId: ORG2_ID }, F.n4), { state: "unavailable" });
  assert.deepEqual(await post({ ...A, orgId: ORG2_ID }, F.p4), { state: "unavailable" });
  assert.deepEqual(await reply({ ...A, environment: "sandbox" }, F.n1), { state: "unavailable" });
  assert.deepEqual(await reply(staff, F.n1), { state: "unavailable" });
  assert.deepEqual(await post(staff, F.p1), { state: "unavailable" });
  assert.deepEqual(await reply(tenant, F.n1), { state: "unavailable" });
  await assert.rejects(() => raw(staff, `SELECT app.b023_reply_owner_lifecycle($1,$2,$3,1,$4,'x')`, [ORG_ID, staff.sessionId, F.n1, randomUUID()]), denied);
  await assert.rejects(() => raw(staff, `SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, staff.sessionId, F.p1, randomUUID()]), denied);
  await assert.rejects(() => raw({ ...D, orgId: ORG_ID }, `SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, D.sessionId, F.p1, randomUUID()]), denied);
  // Another owner's login session id cannot be borrowed.
  await assert.rejects(() => raw(A, `SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, A2.sessionId, F.p1, randomUUID()]), denied);
  assert.deepEqual(await b023Writes(), before);
  for (const fn of ["b023s2_lock_controls", "b023s2_lock_session", "b023s2_current_properties", "b023s2_lifecycle_scope", "b023s2_immutable"]) {
    const ok = (await db.query(`SELECT bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      unnest(ARRAY['anon','authenticated','service_role']) r WHERE n.nspname='app' AND p.proname=$1`, [fn])).rows[0].ok;
    assert.equal(ok, false, `${fn} is private`);
  }
});

test("messaging: one thread per property/owner on the existing model, thread isolation, company replies via existing staff path, no tenant data", async () => {
  const facts = await consentFacts();
  const listA = await ownerMessageThreads(A) ?? [];
  assert.deepEqual(listA.map(r => r.property_id), [F.p1], "only currently authorized properties (not ended P3, not B's P2)");
  assert.equal(listA[0].thread_id, null, "no thread until the first message");
  assert.deepEqual(Object.keys(listA[0]).sort(), ["last_message_at", "message_count", "property_id", "property_name", "thread_id"]);
  assert.deepEqual(((await ownerMessageThreads(B)) ?? []).map(r => r.property_id), [F.p2]);
  assert.deepEqual(((await ownerMessageThreads(C)) ?? []).map(r => r.property_id), [F.p3]);
  assert.deepEqual(((await ownerMessageThreads(D)) ?? []).map(r => r.property_id), [F.p4]);
  assert.equal(await ownerMessageThreads(staff), null);
  const request = randomUUID();
  const first = await post(A, F.p1, " Hello company ", request);
  assert.equal(first.state, "recorded");
  assert.deepEqual(await post(A, F.p1, "Hello company", request), { state: "replayed", id: (first as { id: string }).id });
  assert.deepEqual(await post(A, F.p1, "Other text", request), { state: "conflict" });
  assert.deepEqual(await post(A, F.p1, "   "), { state: "invalid" });
  const threadA = (await ownerMessageThreads(A))?.[0].thread_id;
  assert.ok(threadA);
  const thread = (await db.query(`SELECT kind::text, lease_id, property_id FROM message_threads WHERE id=$1`, [threadA])).rows[0];
  assert.deepEqual(thread, { kind: "owner_company", lease_id: null, property_id: F.p1 });
  assert.equal((await db.query(`SELECT count(*)::int n FROM messages WHERE thread_id=$1`, [threadA])).rows[0].n, 1, "replay wrote one message");
  assert.equal((await db.query(`SELECT count(*)::int n FROM thread_participants WHERE thread_id=$1`, [threadA])).rows[0].n, 0, "owners are not thread participants");
  // Co-owner gets a separate thread for the same property.
  assert.equal(((await ownerMessageThreads(A2)) ?? [])[0].thread_id, null);
  assert.equal((await post(A2, F.p1, "Co-owner question")).state, "recorded");
  const threadA2 = (await ownerMessageThreads(A2))?.[0].thread_id;
  assert.ok(threadA2 && threadA2 !== threadA);
  assert.equal((await post(A, F.p1, "Second message")).state, "recorded");
  assert.equal(((await ownerMessageThreads(A)) ?? [])[0].thread_id, threadA, "same thread reused");
  // Company reply through the existing staff message path and permissions.
  const { postMessage } = await import("./domain");
  await postMessage(staff, threadA, "Company answer");
  const { threadMessages } = await import("./queries");
  assert.deepEqual((await threadMessages(staff, threadA)).map(m => m.body), ["Hello company", "Second message", "Company answer"], "staff read via existing team policy");
  const viewA = await ownerThread(A, F.p1), viewA2 = await ownerThread(A2, F.p1);
  assert.ok(viewA && viewA2);
  assert.deepEqual(viewA.messages.map(m => [m.sender, m.body]), [["owner", "Hello company"], ["owner", "Second message"], ["company", "Company answer"]]);
  assert.deepEqual(viewA2.messages.map(m => [m.sender, m.body]), [["owner", "Co-owner question"]], "thread isolation between co-owners");
  for (const m of viewA.messages) assert.deepEqual(Object.keys(m).sort(), ["body", "created_at", "edited", "message_id", "sender"]);
  assert.equal((await ownerMessageThreads(A))?.[0].message_count, 3);
  // Deleted and tenant-thread messages never appear; owners cannot read the thread through table RLS.
  const tenantThread = (await db.query<{ id: string }>(`INSERT INTO message_threads(org_id,kind,lease_id,property_id) VALUES($1,'lease',$2,$3) RETURNING id`, [ORG_ID, F.l1, F.p1])).rows[0].id;
  await db.query(`INSERT INTO messages(org_id,thread_id,sender_user_id,body) VALUES($1,$2,$3,'TENANT THREAD PRIVATE 0912')`, [ORG_ID, tenantThread, tenant.userId]);
  const serialized = JSON.stringify([await ownerMessageThreads(A), await ownerThread(A, F.p1)]);
  for (const secret of ["TENANT THREAD PRIVATE", "0912", "Tenant T", tenant.userId, USERS.admin, "Co-owner question"]) assert.ok(!serialized.includes(secret), secret);
  assert.equal((await raw(A, `SELECT count(*)::int n FROM public.messages WHERE thread_id=$1`, [threadA])).rows[0].n, 0, "no direct RLS read for owners");
  assert.equal((await raw(A, `SELECT count(*)::int n FROM public.message_threads WHERE id=$1`, [threadA])).rows[0].n, 0);
  assert.equal((await raw(tenant, `SELECT count(*)::int n FROM public.message_threads WHERE id=ANY($1::uuid[])`, [[threadA, threadA2]])).rows[0].n, 0, "tenants never see owner threads");
  assert.equal((await raw(tenant, `SELECT count(*)::int n FROM public.messages WHERE thread_id=ANY($1::uuid[])`, [[threadA, threadA2]])).rows[0].n, 0);
  await assert.rejects(() => raw(A, `INSERT INTO public.messages(org_id,thread_id,sender_user_id,sender_contact_id,body) VALUES($1,$2,$3,$4,'direct')`, [ORG_ID, threadA, A.userId, F.aContact]));
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_threads`), denied);
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_message_requests`), denied);
  await db.query(`UPDATE messages SET deleted_at=now() WHERE body='Second message'`);
  assert.deepEqual((await ownerThread(A, F.p1))?.messages.map(m => m.body), ["Hello company", "Company answer"]);
  await assert.rejects(() => db.query(`UPDATE app.b023_owner_message_requests SET body_digest=repeat('0',64)`), (e: { code?: string }) => e.code === "55000");
  assert.deepEqual(await consentFacts(), facts, "messaging changed no consent/confirmation/read/participant/audit state");
});

test("staff surfaces: existing admin/manager roles see owner threads and owner replies; other roles, orgs, owners and tenants are denied", async () => {
  const manager = await session(USERS.manager, "staff", "manager"), accountant = await session(USERS.accountant, "staff", "accountant");
  const maintenance = await session(USERS.maintenance, "staff", "maintenance"), coast = await session(USERS.coastAdmin, "staff", "admin", ORG2_ID);
  const threadA = (await ownerMessageThreads(A))?.[0].thread_id, threadA2 = (await ownerMessageThreads(A2))?.[0].thread_id;
  for (const s of [staff, manager]) {
    const rows = await staffOwnerThreads(s);
    assert.ok(rows, s.role ?? "");
    assert.deepEqual(rows.map(r => r.thread_id).sort(), [threadA, threadA2].sort());
    const a = rows.find(r => r.thread_id === threadA);
    assert.equal(a?.owner_name, "Owner A"); assert.equal(a?.property_id, F.p1); assert.equal(a?.preview, "Company answer");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["last_message_at", "owner_name", "preview", "property_id", "property_name", "thread_id"]);
  }
  const { listThreads } = await import("./queries");
  assert.ok(!(await listThreads(staff)).some(t => t.id === threadA || t.id === threadA2), "lease-thread inbox query unchanged");
  const replies = await staffOwnerLifecycleReplies(staff, F.l1);
  assert.ok(replies);
  assert.deepEqual(replies.map(r => [r.owner_name, r.body, r.notice_version]), [
    ["Owner A", "I would like to discuss the notice.", 1], ["Owner A2", "Co-owner reply", 1], ["Owner A2", "Reply to v2", 2]]);
  assert.ok(replies.every(r => r.record_id === F.n1 && r.notice_kind === "non_renewal_notice"));
  assert.deepEqual(await staffOwnerLifecycleReplies(manager, F.l1), replies);
  assert.equal(await staffOwnerLifecycleReplies(staff, randomUUID()), null, "unknown lease id");
  assert.equal(await staffOwnerThreads(accountant), null); assert.equal(await staffOwnerThreads(maintenance), null);
  assert.equal(await staffOwnerLifecycleReplies(accountant, F.l1), null);
  for (const s of [accountant, maintenance, A, tenant, { ...coast, orgId: ORG_ID }]) {
    await assert.rejects(() => raw(s, `SELECT * FROM app.b023_staff_owner_threads($1)`, [ORG_ID]), denied, s.role ?? s.kind);
    await assert.rejects(() => raw(s, `SELECT * FROM app.b023_staff_owner_lifecycle_replies($1,$2)`, [ORG_ID, F.l1]), denied, s.role ?? s.kind);
  }
  assert.equal(await staffOwnerThreads({ ...staff, orgId: ORG2_ID }), null, "staff of org 1 cannot read org 2");
  assert.deepEqual(await staffOwnerThreads(coast), [], "org 2 admin sees only org 2 (no owner threads there)");
  assert.equal(await staffOwnerLifecycleReplies(coast, F.l1), null, "cross-org lease denied");
  await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_staff_owner_lifecycle_replies($1,$2)`, [ORG_ID, F.l4]), denied, "foreign lease id");
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE anon");
    await assert.rejects(() => db.query(`SELECT * FROM app.b023_staff_owner_threads($1)`, [ORG_ID]));
  } finally { await db.query("ROLLBACK"); }
});

test("replay of a deleted message is 'gone'; edited messages are flagged; 30 per rolling 24h volume cap", async () => {
  const request = randomUUID();
  const sent = await post(A, F.p1, "To be removed", request);
  assert.equal(sent.state, "recorded");
  const id = (sent as { id: string }).id;
  await raw(staff, `UPDATE public.messages SET deleted_at=now() WHERE id=$1`, [id]);
  assert.deepEqual(await post(A, F.p1, "To be removed", request), { state: "gone" }, "soft-deleted by staff");
  await raw(staff, `DELETE FROM public.messages WHERE id=$1`, [id]);
  assert.deepEqual(await post(A, F.p1, "To be removed", request), { state: "gone" }, "hard-deleted by staff");
  const original = await post(A, F.p1, "Original wording");
  await raw(staff, `UPDATE public.messages SET body='Tampered wording' WHERE id=$1`, [(original as { id: string }).id]);
  await raw(staff, `UPDATE public.messages SET edited_at=now() WHERE body='Company answer'`);
  const view = await ownerThread(A, F.p1);
  assert.deepEqual(view?.messages.map(m => [m.body, m.edited]), [["Hello company", false], ["Company answer", true], ["Tampered wording", true]]);
  // Cap: A2 already sent 1 message in the last 24h; add 29 more directly.
  const thread = (await ownerMessageThreads(A2))?.[0].thread_id;
  await db.query(`INSERT INTO messages(org_id,thread_id,sender_user_id,sender_contact_id,body) SELECT $1,$2,$3,$4,'bulk '||g FROM generate_series(1,29) g`,
    [ORG_ID, thread, A2.userId, F.a2Contact]);
  const before = await b023Writes();
  assert.deepEqual(await post(A2, F.p1, "One too many"), { state: "rate_limited" });
  assert.deepEqual(await b023Writes(), before, "rate-limited post wrote nothing");
  assert.equal((await post(A, F.p1, "Other owner unaffected")).state, "recorded");
  await db.query(`UPDATE messages SET created_at=now()-interval '25 hours' WHERE thread_id=$1 AND body LIKE 'bulk %'`, [thread]);
  assert.equal((await post(A2, F.p1, "After the window")).state, "recorded");
});

test("OFF matrix: absent/false/malformed global, org not allowed, org flag false ⇒ null/unavailable, no gateway call, zero writes", async () => {
  const before = await b023Writes(), facts = await consentFacts();
  const cases: [string, () => Promise<void>][] = [
    ["absent", async () => { await db.query(`DELETE FROM platform_settings WHERE key=$1`, [FLAG]); }],
    ["enabled false", async () => { await setFlag(FLAG, false); await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":true}' WHERE id=$1`, [ORG_ID]); }],
    ["enabled string", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: "true", allowed_org_ids: [ORG_ID] })]); }],
    ["allowlist not array", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: ORG_ID })]); }],
    ["malformed json", async () => { await db.query(`UPDATE platform_settings SET value='"enabled"' WHERE key=$1`, [FLAG]); }],
    ["org not in allowlist", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: [ORG2_ID] })]); }],
    ["org flag false", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":false}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag string", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":"true"}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag absent", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags-'owner_portal_extensions' WHERE id=$1`, [ORG_ID]); }],
  ];
  for (const [name, apply] of cases) {
    await flags(true, true); await apply();
    assert.equal(await ownerPortalExtensionsEnabled(db, ORG_ID), false, name);
    const spy = mock.method(Client.prototype, "query");
    try {
      assert.equal(await ownerLifecycleItems(A), null, name);
      assert.equal(await ownerLifecycleDetail(A, F.n1), null, name);
      assert.deepEqual(await reply(A, F.n1), { state: "unavailable" }, name);
      assert.equal(await ownerMessageThreads(A), null, name);
      assert.equal(await ownerThread(A, F.p1), null, name);
      assert.deepEqual(await post(A, F.p1), { state: "unavailable" }, name);
      assert.equal(await staffOwnerThreads(staff), null, `${name}: staff inbox renders nothing`);
      assert.equal(await staffOwnerLifecycleReplies(staff, F.l1), null, `${name}: staff lease page renders nothing`);
      assert.equal(spy.mock.calls.some(c => typeof c.arguments[0] === "string" && /app\.b023_/.test(c.arguments[0] as string)), false, name);
    } finally { mock.restoreAll(); }
    for (const [sql, params] of [
      [`SELECT * FROM app.b023_owner_lifecycle_items($1)`, [ORG_ID]], [`SELECT * FROM app.b023_owner_lifecycle_detail($1,$2)`, [ORG_ID, F.n1]],
      [`SELECT app.b023_reply_owner_lifecycle($1,$2,$3,2,$4,'x')`, [ORG_ID, A.sessionId, F.n1, randomUUID()]],
      [`SELECT * FROM app.b023_owner_message_threads($1)`, [ORG_ID]], [`SELECT * FROM app.b023_owner_thread_messages($1,$2)`, [ORG_ID, F.p1]],
      [`SELECT app.b023_post_owner_message($1,$2,$3,$4,'x')`, [ORG_ID, A.sessionId, F.p1, randomUUID()]]] as const) {
      await assert.rejects(() => raw(A, sql, [...params]), denied, `${name}: ${sql}`);
    }
    await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_staff_owner_threads($1)`, [ORG_ID]), denied, name);
    await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_staff_owner_lifecycle_replies($1,$2)`, [ORG_ID, F.l1]), denied, name);
  }
  // lease_renewal (B-012) OFF: lifecycle items are not surfaced; messaging is independent.
  await flags(true, false);
  assert.equal(await ownerLifecycleItems(A), null);
  assert.equal(await ownerLifecycleDetail(A, F.n1), null);
  assert.deepEqual(await reply(A, F.n1, "x", randomUUID(), 2), { state: "unavailable" });
  await assert.rejects(() => raw(A, `SELECT app.b023_reply_owner_lifecycle($1,$2,$3,2,$4,'x')`, [ORG_ID, A.sessionId, F.n1, randomUUID()]), denied);
  assert.deepEqual(await b023Writes(), before, "zero B-023 writes while OFF");
  assert.deepEqual(await consentFacts(), facts);
  assert.ok(await ownerMessageThreads(A), "messaging does not depend on lease_renewal");
  assert.equal(await staffOwnerLifecycleReplies(staff, F.l1), null);
  assert.ok(await staffOwnerThreads(staff));
  await flags(true, true);
  assert.ok((await ownerLifecycleItems(A))?.length, "ON again restores the positive control");
});
