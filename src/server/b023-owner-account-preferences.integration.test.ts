import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import { SESSION_COOKIE } from "./auth";
import { actionRevokeOthers, actionRevokeSession } from "./auth-actions";
import { sessionTokenHash } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { ownerPortalExtensionsEnabled } from "./owner-portal-access";
import { ownerAccountView, revokeOwnerSession, saveOwnerProfile, setOwnerNotificationPreference } from "./owner-account";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const FLAG = "owner_portal_extensions";
const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, staff: Session, tenant: Session;
let A: Session, B: Session, D: Session, F: Awaited<ReturnType<typeof fixture>>;

test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  staff = await session(USERS.admin, "staff", "admin");
  await setFlag(true);
  F = await fixture();
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });
test.beforeEach(async () => { await setFlag(true); });

async function session(userId: string, kind: Session["kind"], role: Session["role"], orgId = ORG_ID,
  opts: { ua?: string | null; createdAgo?: string; ip?: string } = {}): Promise<Session> {
  const id = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,user_agent,ip,created_at,last_active_at,expires_at)
    VALUES($1,$2,$3,$4,$5,now()-$6::interval,now()-$6::interval,now()+interval '1 day')`,
    [id, userId, randomUUID(), opts.ua ?? null, opts.ip ?? "198.51.100.7", opts.createdAgo ?? "0 seconds"]);
  return { userId, sessionId: id, orgId, liveOrgId: orgId, environment: "live", kind, role, email: "fixture@example.invalid", name: "Fixture", locale: "en", calendar: "gregorian", leaseId: null };
}
async function setFlag(on: boolean) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($3::text,$4::text)))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [FLAG, on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($1::text,$2::boolean) WHERE id=ANY($3::uuid[])`, [FLAG, on, [ORG_ID, ORG2_ID]]);
}
async function user(org: string, name: string, owner: boolean, email: string | null = null) {
  const id = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [id, `${id}@example.invalid`]);
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,is_tenant,user_id,display_name,email) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [org, owner, !owner, id, name, email])).rows[0].id;
  return { session: await session(id, owner ? "owner" : "tenant", null, org, { ua: UA_MAC }), contact, userId: id };
}

async function fixture() {
  const a = await user(ORG_ID, "Owner A", true, "owner-a@example.invalid"), b = await user(ORG_ID, "Owner B", true);
  const d = await user(ORG2_ID, "Owner D", true), t = await user(ORG_ID, "Tenant T", false);
  A = a.session; B = b.session; D = d.session; tenant = t.session;
  const prop = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'Synthetic P1','TW','TWD','Asia/Taipei') RETURNING id`, [ORG_ID])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,ownership_bp) VALUES($1,$2,$3,'2020-01-01',5000),($1,$2,$4,'2020-01-01',5000)`,
    [ORG_ID, prop, a.contact, b.contact]);
  // A's other devices: a phone (live), an old laptop sign-in (live but stale), a revoked and an expired session (never listed).
  const aPhone = await session(a.userId, "owner", null, ORG_ID, { ua: UA_PHONE, createdAgo: "2 days" });
  const aOld = await session(a.userId, "owner", null, ORG_ID, { ua: null, createdAgo: "1 hour" });
  const aRevoked = await session(a.userId, "owner", null, ORG_ID);
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [aRevoked.sessionId]);
  const aExpired = await session(a.userId, "owner", null, ORG_ID);
  await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1`, [aExpired.sessionId]);
  const bOther = await session(b.userId, "owner", null, ORG_ID, { ua: UA_PHONE });
  return { aContact: a.contact, bContact: b.contact, dContact: d.contact, aPhone, aOld, aRevoked, aExpired, bOther };
}

async function raw(s: Session, sql: string, params: unknown[] = []) {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [s.userId, s.orgId, s.environment]);
    await db.query("SET LOCAL ROLE authenticated"); const result = await db.query(sql, params); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
const denied = (error: unknown) => (error as { code?: string }).code === "42501";
const hash = async (sql: string) => (await db.query(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h, count(*)::int n FROM (${sql}) x`)).rows[0];
async function writes() {
  return {
    revocations: await hash(`SELECT * FROM app.b023_owner_session_revocations`),
    profiles: await hash(`SELECT * FROM app.b023_owner_profile_revisions`),
    prefs: await hash(`SELECT * FROM app.b023_owner_notification_preferences`),
    prefRequests: await hash(`SELECT * FROM app.b023_owner_preference_requests`),
    sessions: await hash(`SELECT id, user_id, revoked_at, expires_at FROM public.auth_sessions`),
    contacts: await hash(`SELECT id, display_name, email, phone_e164, locale, preferred_channel, updated_at FROM public.contacts`),
    audit: await hash(`SELECT id FROM public.audit_log WHERE table_name NOT IN ('organizations','platform_settings')`),
  };
}
const revoke = (s: Session, target: string, requestId = randomUUID()) => revokeOwnerSession(s, { targetSessionId: target, requestId });
const asCurrent = (s: Session, sessionId: string): Session => ({ ...s, sessionId });
async function profile(s: Session) { const v = await ownerAccountView(s); assert.ok(v); return v.profile; }
const live = async (id: string) => (await db.query(`SELECT revoked_at IS NULL AS live FROM auth_sessions WHERE id=$1`, [id])).rows[0].live as boolean;

test("own sessions only: live sessions of the caller, current marker, device text without IP", async () => {
  const view = await ownerAccountView(A);
  assert.ok(view);
  assert.deepEqual(view.sessions.map(s => s.session_id).sort(), [A.sessionId, F.aPhone.sessionId, F.aOld.sessionId].sort());
  assert.equal(view.sessions[0].session_id, A.sessionId, "current session first");
  assert.deepEqual(view.sessions.map(s => s.is_current), [true, false, false]);
  assert.equal(view.sessions[0].recent_auth, true);
  assert.ok(view.sessions.slice(1).every(s => !s.recent_auth), "recent_auth only on the current row");
  for (const s of view.sessions) assert.deepEqual(Object.keys(s).sort(), ["created_at", "device", "is_current", "last_active_at", "recent_auth", "session_id"]);
  const device = (id: string) => view.sessions.find(s => s.session_id === id)?.device;
  assert.equal(device(A.sessionId), "Safari · macOS");
  assert.equal(device(F.aPhone.sessionId), "Chrome · iOS");
  assert.equal(device(F.aOld.sessionId), null, "unknown device");
  assert.ok(!JSON.stringify(view).includes("198.51.100.7"), "no IP");
  assert.ok(!/Mozilla|AppleWebKit|KHTML/.test(JSON.stringify(view)), "no raw user agent");
  const summary = async (ua: string | null) => (await db.query(`SELECT app.b023s3_device($1) AS d`, [ua])).rows[0].d;
  assert.equal(await summary("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0"), "Edge · Windows");
  assert.equal(await summary("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 Line/14.9.0"), "LINE · Android");
  assert.equal(await summary("curl/8.4"), null);
  assert.ok(!view.sessions.some(s => [F.aRevoked.sessionId, F.aExpired.sessionId, B.sessionId, F.bOther.sessionId].includes(s.session_id)));
  const bView = await ownerAccountView(B);
  assert.deepEqual(bView?.sessions.map(s => s.session_id).sort(), [B.sessionId, F.bOther.sessionId].sort());
  assert.equal(await ownerAccountView(F.aRevoked), null, "revoked current session ⇒ null");
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_sessions($1,$2)`, [ORG_ID, B.sessionId]), denied, "borrowed session id");
});

test("revoke: never another user's session or the current one; one other own session; idempotent replay", async () => {
  const before = await writes();
  assert.deepEqual(await revoke(A, B.sessionId), { state: "unavailable" }, "another user's session");
  assert.deepEqual(await revoke(A, F.bOther.sessionId), { state: "unavailable" });
  assert.deepEqual(await revoke(A, randomUUID()), { state: "unavailable" }, "unknown id");
  await assert.rejects(() => raw(A, `SELECT app.b023_revoke_owner_session($1,$2,$3,$4)`, [ORG_ID, A.sessionId, B.sessionId, randomUUID()]), denied);
  assert.deepEqual(await revoke(A, A.sessionId), { state: "current" }, "current session uses normal sign-out");
  assert.deepEqual(await revoke(staff, A.sessionId), { state: "unavailable" }, "staff");
  assert.deepEqual(await revoke(tenant, F.aPhone.sessionId), { state: "unavailable" }, "tenant");
  assert.deepEqual(await writes(), before, "zero writes on denial");
  assert.ok(await live(B.sessionId) && await live(F.bOther.sessionId) && await live(A.sessionId));

  const request = randomUUID();
  assert.deepEqual(await revoke(A, F.aPhone.sessionId, request), { state: "revoked" });
  assert.equal(await live(F.aPhone.sessionId), false);
  assert.ok(await live(A.sessionId) && await live(F.aOld.sessionId), "only the target is revoked");
  const after = await writes();
  assert.equal(after.revocations.n, before.revocations.n + 1);
  assert.equal(after.audit.n, before.audit.n + 1);
  const row = (await db.query(`SELECT * FROM app.b023_owner_session_revocations WHERE request_id=$1`, [request])).rows[0];
  assert.deepEqual([row.acting_session_id, row.target_session_id, row.owner_contact_id], [A.sessionId, F.aPhone.sessionId, F.aContact]);
  const audit = (await db.query(`SELECT event_type, new_row FROM audit_log WHERE table_name='auth_sessions' AND row_id=$1`, [F.aPhone.sessionId])).rows;
  assert.deepEqual(audit, [{ event_type: "owner_session_revoked", new_row: { scope: "one_other_session" } }]);
  assert.deepEqual(await revoke(A, F.aPhone.sessionId, request), { state: "replayed" }, "exact replay");
  assert.deepEqual(await revoke(A, F.aOld.sessionId, request), { state: "conflict" }, "request id reused for another target");
  assert.deepEqual(await revoke(A, F.aPhone.sessionId), { state: "gone" }, "new request for an already signed-out device");
  assert.deepEqual(await writes(), after, "replay/conflict/gone wrote nothing");
  assert.equal(await live(F.aOld.sessionId), true);
  await assert.rejects(() => db.query(`UPDATE app.b023_owner_session_revocations SET created_at=now()`), (e: { code?: string }) => e.code === "55000");
});

test("recent-auth: a stale current session is denied with zero writes; revoked current session denied", async () => {
  const old = asCurrent(A, F.aOld.sessionId);
  const view = await ownerAccountView(old);
  assert.equal(view?.sessions.find(s => s.is_current)?.recent_auth, false);
  const before = await writes();
  assert.deepEqual(await revoke(old, A.sessionId), { state: "reauth_required" });
  assert.deepEqual((await raw(old, `SELECT app.b023_revoke_owner_session($1,$2,$3,$4) AS r`, [ORG_ID, old.sessionId, A.sessionId, randomUUID()])).rows[0].r,
    { state: "reauth_required" });
  assert.deepEqual(await writes(), before, "zero writes");
  assert.equal(await live(A.sessionId), true);
  // Exactly at the boundary: 16 minutes old is stale, 14 minutes old is recent.
  const s16 = await session(A.userId, "owner", null, ORG_ID, { createdAgo: "16 minutes" });
  const s14 = await session(A.userId, "owner", null, ORG_ID, { createdAgo: "14 minutes" });
  assert.deepEqual(await revoke(s16, s14.sessionId), { state: "reauth_required" });
  assert.deepEqual(await revoke(s14, s16.sessionId), { state: "revoked" });
  assert.deepEqual(await revoke(asCurrent(A, F.aRevoked.sessionId), A.sessionId), { state: "unavailable" }, "revoked current session");
  assert.deepEqual(await revoke(asCurrent(A, F.aExpired.sessionId), A.sessionId), { state: "unavailable" }, "expired current session");
  assert.deepEqual(await revoke(s16, s16.sessionId), { state: "unavailable" }, "s16 was revoked above");
  // A completed revoke retried after the recent-auth window is a replay, not reauth_required.
  const sR = await session(A.userId, "owner", null, ORG_ID), sT = await session(A.userId, "owner", null, ORG_ID);
  const retried = randomUUID();
  assert.deepEqual(await revoke(sR, sT.sessionId, retried), { state: "revoked" });
  await db.query(`UPDATE auth_sessions SET created_at=now()-interval '1 hour' WHERE id=$1`, [sR.sessionId]);
  const settled = await writes();
  assert.deepEqual(await revoke(sR, sT.sessionId, retried), { state: "replayed" });
  assert.deepEqual(await revoke(sR, A.sessionId, retried), { state: "conflict" });
  assert.deepEqual(await revoke(sR, A.sessionId), { state: "reauth_required" }, "a new request still needs recent auth");
  assert.deepEqual(await writes(), settled);
});

test("legacy /m/account revoke actions: owner and tenant sessions get no effect (zero writes); staff unchanged", async () => {
  let token: string | null = null;
  mock.method(nextHeaders, "cookies", async () => ({ get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined), delete() {}, set() {} }));
  mock.method(nextHeaders, "headers", async () => new Headers());
  const open = async (userId: string, ago = "1 hour") => {
    const raw = randomUUID(), id = randomUUID();
    await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now()-$4::interval,now()+interval '1 day')`,
      [id, userId, sessionTokenHash(raw), ago]);
    return { raw, id };
  };
  const revokedState = async (userId: string) => hash(`SELECT id, revoked_at FROM auth_sessions WHERE user_id='${userId}'`);
  const form = (id: string) => { const f = new FormData(); f.set("sessionId", id); return f; };
  const redirected = (e: unknown) => String((e as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
  try {
    for (const userId of [USERS.owner, USERS.tenant, A.userId]) {
      const current = await open(userId), other = await open(userId, "2 days");
      token = current.raw;
      const before = await revokedState(userId), auditBefore = await hash(`SELECT id FROM audit_log WHERE event_type IS NOT NULL OR table_name='auth_sessions'`);
      await actionRevokeSession(form(other.id));
      await actionRevokeOthers();
      await actionRevokeSession(form(current.id));
      assert.deepEqual(await revokedState(userId), before, `${userId}: no session revoked`);
      assert.deepEqual(await hash(`SELECT id FROM audit_log WHERE event_type IS NOT NULL OR table_name='auth_sessions'`), auditBefore, `${userId}: no audit`);
      assert.ok(await live(other.id) && await live(current.id));
    }
    // Positive control: staff behaviour is unchanged.
    const current = await open(USERS.admin), other = await open(USERS.admin, "2 days"), third = await open(USERS.admin, "3 days");
    token = current.raw;
    await assert.rejects(() => actionRevokeSession(form(other.id)), redirected);
    assert.equal(await live(other.id), false);
    await assert.rejects(() => actionRevokeOthers(), redirected);
    assert.equal(await live(third.id), false);
    assert.equal(await live(current.id), true);
  } finally { mock.restoreAll(); }
});

test("profile: own contact only; optimistic version; replay/conflict/unchanged; email/phone read-only", async () => {
  const p = await profile(A);
  assert.deepEqual(Object.keys(p).sort(), ["channels", "display_name", "email", "locale", "phone_e164", "preferred_channel", "version"]);
  assert.equal(p.display_name, "Owner A"); assert.equal(p.email, "owner-a@example.invalid");
  assert.deepEqual(p.channels, ["in_app", "email"], "channels limited to addresses the contact has");
  assert.deepEqual((await profile(B)).channels, ["in_app"]);
  const bBefore = (await db.query(`SELECT * FROM contacts WHERE id=$1`, [F.bContact])).rows[0];
  const before = await writes();
  assert.deepEqual(await saveOwnerProfile(B, { requestId: randomUUID(), displayName: "B", locale: "en", channel: "email", version: (await profile(B)).version }), { state: "invalid" }, "no email address ⇒ email channel invalid");
  assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: " ", locale: "en", channel: null, version: p.version }), { state: "invalid" });
  assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: "X", locale: "fr", channel: null, version: p.version }), { state: "invalid" });
  assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: "X", locale: "en", channel: "push", version: p.version }), { state: "invalid" });
  assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: "Owner A", locale: p.locale, channel: null, version: p.version }), { state: "unchanged" });
  assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: "New", locale: "en", channel: null, version: "0".repeat(32) }), { state: "stale" });
  for (const s of [staff, tenant, { ...D, orgId: ORG_ID }]) {
    assert.deepEqual(await saveOwnerProfile(s, { requestId: randomUUID(), displayName: "Hijack", locale: "en", channel: null, version: p.version }), { state: "unavailable" });
  }
  assert.deepEqual(await writes(), before, "zero writes so far");

  const request = randomUUID();
  const input = { requestId: request, displayName: "陳屋主", locale: "zh-TW", channel: "email", version: p.version };
  assert.deepEqual(await saveOwnerProfile(A, input), { state: "recorded" });
  const saved = await profile(A);
  assert.deepEqual([saved.display_name, saved.locale, saved.preferred_channel, saved.email], ["陳屋主", "zh-TW", "email", "owner-a@example.invalid"]);
  assert.notEqual(saved.version, p.version);
  assert.deepEqual(await saveOwnerProfile(A, input), { state: "replayed" }, "exact replay (old version) ⇒ replayed");
  assert.deepEqual(await saveOwnerProfile(A, { ...input, displayName: "Other" }), { state: "conflict" });
  assert.deepEqual(await saveOwnerProfile(A, { ...input, requestId: randomUUID(), displayName: "Third" }), { state: "stale" }, "old version after save");
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.b023_owner_profile_revisions WHERE owner_contact_id=$1`, [F.aContact])).rows[0].n, 1);
  assert.deepEqual((await db.query(`SELECT * FROM contacts WHERE id=$1`, [F.bContact])).rows[0], bBefore, "other owner's contact untouched");
  assert.equal((await profile(B)).display_name, "Owner B");
  await assert.rejects(() => raw(tenant, `SELECT * FROM app.b023_owner_profile($1)`, [ORG_ID]), denied);
  await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_owner_profile($1)`, [ORG_ID]), denied);
  await assert.rejects(() => raw(A, `SELECT app.b023_save_owner_profile($1,$2,$3,'x','en',NULL,$4)`, [ORG_ID, B.sessionId, randomUUID(), saved.version]), denied, "borrowed session");
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_profile($1)`, [ORG2_ID]), denied, "foreign org id");
  await assert.rejects(() => raw(D, `SELECT * FROM app.b023_owner_profile($1)`, [ORG_ID]), denied, "org-2 owner on org 1");
});

test("preferences: default ON, per-owner isolation, idempotent replay, producer helper", async () => {
  const prefs = async (s: Session) => (await ownerAccountView(s))?.preferences.map(p => [p.category, p.enabled]);
  assert.deepEqual(await prefs(A), [["repair_updates", true], ["statement_reports", true]], "defaults preserve current sends");
  assert.deepEqual(await prefs(B), [["repair_updates", true], ["statement_reports", true]]);
  const before = await writes();
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: randomUUID(), category: "repair_updates", enabled: true }), { state: "unchanged" });
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: randomUUID(), category: "rent_due", enabled: false }), { state: "invalid" });
  assert.deepEqual(await setOwnerNotificationPreference(tenant, { requestId: randomUUID(), category: "repair_updates", enabled: false }), { state: "unavailable" });
  assert.deepEqual(await setOwnerNotificationPreference({ ...D, orgId: ORG_ID }, { requestId: randomUUID(), category: "repair_updates", enabled: false }), { state: "unavailable" });
  await assert.rejects(() => raw(A, `SELECT app.b023_set_owner_notification_preference($1,$2,$3,'repair_updates',false)`, [ORG2_ID, A.sessionId, randomUUID()]), denied);
  assert.deepEqual(await writes(), before, "zero writes for unchanged/invalid/denied");
  const request = randomUUID();
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: request, category: "repair_updates", enabled: false }), { state: "recorded" });
  assert.deepEqual(await prefs(A), [["repair_updates", false], ["statement_reports", true]]);
  assert.deepEqual(await prefs(B), [["repair_updates", true], ["statement_reports", true]], "B unaffected");
  const mid = await writes();
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: request, category: "repair_updates", enabled: false }), { state: "replayed" });
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: request, category: "repair_updates", enabled: true }), { state: "conflict" });
  assert.deepEqual(await writes(), mid, "replay/conflict wrote nothing");
  const enabled = async (contact: string, category: string) =>
    (await db.query(`SELECT app.b023_owner_notification_enabled($1,$2,$3) AS on`, [ORG_ID, contact, category])).rows[0].on as boolean;
  assert.equal(await enabled(F.aContact, "repair_updates"), false);
  assert.equal(await enabled(F.aContact, "statement_reports"), true);
  assert.equal(await enabled(F.bContact, "repair_updates"), true);
  await setFlag(false);
  assert.equal(await enabled(F.aContact, "repair_updates"), true, "flag OFF ⇒ current behaviour");
  await setFlag(true);
  assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: randomUUID(), category: "repair_updates", enabled: true }), { state: "recorded" });
  assert.equal(await enabled(F.aContact, "repair_updates"), true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM audit_log WHERE event_type='owner_notification_preference_changed' AND row_id=$1`, [F.aContact])).rows[0].n, 2);
});

test("private helpers and tables are not reachable by API roles", async () => {
  for (const sql of [`SELECT app.b023s3_live_session($1)`, `SELECT app.b023s3_recent(now())`, `SELECT app.b023_owner_notification_enabled($1,$1,'repair_updates')`,
    `SELECT app.b023s3_channels($1,$1)`, `SELECT * FROM app.b023_owner_notification_preferences`, `SELECT * FROM app.b023_owner_session_revocations`,
    `SELECT * FROM app.b023_owner_profile_revisions`, `SELECT * FROM app.b023_owner_preference_requests`]) {
    const params = sql.includes("$1") ? [ORG_ID] : [];
    await assert.rejects(() => raw(A, sql, params), (e: { code?: string }) => e.code === "42501", sql);
  }
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE anon");
    await assert.rejects(() => db.query(`SELECT * FROM app.b023_owner_sessions($1,$2)`, [ORG_ID, A.sessionId]));
  } finally { await db.query("ROLLBACK"); }
});

test("OFF matrix: absent/false/malformed global, org not allowed, org flag false ⇒ null/unavailable, no gateway call, zero writes", async () => {
  const before = await writes();
  const cases: [string, () => Promise<void>][] = [
    ["absent", async () => { await db.query(`DELETE FROM platform_settings WHERE key=$1`, [FLAG]); }],
    ["enabled false", async () => { await setFlag(false); await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":true}' WHERE id=$1`, [ORG_ID]); }],
    ["enabled string", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: "true", allowed_org_ids: [ORG_ID] })]); }],
    ["allowlist not array", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: ORG_ID })]); }],
    ["malformed json", async () => { await db.query(`UPDATE platform_settings SET value='"enabled"' WHERE key=$1`, [FLAG]); }],
    ["org not in allowlist", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: [ORG2_ID] })]); }],
    ["org flag false", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":false}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag string", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":"true"}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag absent", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags-'owner_portal_extensions' WHERE id=$1`, [ORG_ID]); }],
  ];
  const version = (await profile(A)).version;
  for (const [name, apply] of cases) {
    await setFlag(true); await apply();
    assert.equal(await ownerPortalExtensionsEnabled(db, ORG_ID), false, name);
    const spy = mock.method(Client.prototype, "query");
    try {
      assert.equal(await ownerAccountView(A), null, name);
      assert.deepEqual(await revoke(A, F.aOld.sessionId), { state: "unavailable" }, name);
      assert.deepEqual(await saveOwnerProfile(A, { requestId: randomUUID(), displayName: "OFF", locale: "en", channel: null, version }), { state: "unavailable" }, name);
      assert.deepEqual(await setOwnerNotificationPreference(A, { requestId: randomUUID(), category: "statement_reports", enabled: false }), { state: "unavailable" }, name);
      assert.equal(spy.mock.calls.some(c => typeof c.arguments[0] === "string" && /app\.b023_/.test(c.arguments[0] as string)), false, name);
    } finally { mock.restoreAll(); }
    for (const [sql, params] of [
      [`SELECT * FROM app.b023_owner_sessions($1,$2)`, [ORG_ID, A.sessionId]],
      [`SELECT app.b023_revoke_owner_session($1,$2,$3,$4)`, [ORG_ID, A.sessionId, F.aOld.sessionId, randomUUID()]],
      [`SELECT * FROM app.b023_owner_profile($1)`, [ORG_ID]],
      [`SELECT app.b023_save_owner_profile($1,$2,$3,'OFF','en',NULL,$4)`, [ORG_ID, A.sessionId, randomUUID(), version]],
      [`SELECT * FROM app.b023_owner_notification_settings($1)`, [ORG_ID]],
      [`SELECT app.b023_set_owner_notification_preference($1,$2,$3,'statement_reports',false)`, [ORG_ID, A.sessionId, randomUUID()]]] as const) {
      await assert.rejects(() => raw(A, sql, [...params]), denied, `${name}: ${sql}`);
    }
  }
  const after = await writes();
  assert.deepEqual({ ...after, audit: null }, { ...before, audit: null }, "zero B-023 / session / contact writes while OFF");
  assert.equal(after.audit.n, before.audit.n, "no audit rows while OFF");
  await setFlag(true);
  assert.ok(await ownerAccountView(A), "ON again restores the positive control");
  assert.equal(await live(F.aOld.sessionId), true);
});
