import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { POST } from "@/app/api/notify-settings/route";
import { SESSION_COOKIE } from "./auth";
import { buildStoredConsent } from "./consent";
import { ENV_COOKIE } from "./org-scope";
import { sessionTokenHash } from "./session";
import { notifySettingsRead, saveNotifySetting } from "./b073-notify-settings";
import { memberEmailPrefs, orgMailSettings, saveOrgMailSettings } from "./mail-settings";
import { disposableDbUrl } from "./test-disposable-db";
import type { OrgRole, Session } from "./types";

// B-073 / R5-NOTIFY (MGT-135-AC1…AC4) against a disposable local database. Synthetic data only; nothing outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let cookie = "";
const realFetch = globalThis.fetch;
let fetchCalls = 0;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("B073: outbound fetch is forbidden"); }) as typeof fetch;
  mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => key === SESSION_COOKIE ? { value: cookie } : key === ENV_COOKIE ? { value: "live" } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/api/notify-settings" }));
});
test.after(async () => { mock.restoreAll(); globalThis.fetch = realFetch; await db?.end(); assert.equal(fetchCalls, 0); });

const ROLES: OrgRole[] = ["admin", "manager", "accountant", "maintenance"];
async function makeOrg() {
  const tag = `b073n.${randomUUID()}`;
  const settings = { email_tenant_lease_expiry: true, show_tenant_name: true, b073_fixture: "kept" };
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,country_code,default_currency,plan_tier,settings,contact_email)
     VALUES ($1,'TW','TWD','beta',$2::jsonb,'office@example.com') RETURNING id`, [tag, JSON.stringify(settings)])).rows[0].id;
  const sessions: Record<string, Session> = {};
  const tokens: Record<string, string> = {};
  for (const role of ROLES) {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`${tag}.${role}@example.com`])).rows[0].id;
    await db.query("INSERT INTO org_members(org_id,user_id,role,status,email_prefs) VALUES ($1,$2,$3,'active',$4::jsonb)",
      [orgId, userId, role, JSON.stringify({ rent_overdue: true, b073_member: "kept" })]);
    sessions[role] = { userId, orgId, liveOrgId: orgId, role, sessionId: randomUUID(), kind: "staff", environment: "live", locale: "zh-TW",
      calendar: "gregorian", leaseId: null, name: "Synthetic", email: `${tag}.${role}@example.com` };
    const token = randomUUID();
    tokens[role] = token;
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessions[role].sessionId, userId, sessionTokenHash(token)]);
    const consent = buildStoredConsent("reconsent");
    await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES ($1,$2,$3,$4,$5)",
      [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  }
  return { orgId, sessions, tokens };
}
const orgRow = async (orgId: string) => (await db.query<{ settings: Record<string, unknown>; contact_email: string | null; feature_flags: unknown }>(
  "SELECT settings, contact_email::text AS contact_email, feature_flags FROM organizations WHERE id=$1", [orgId])).rows[0];
const memberPrefs = async (orgId: string) => Object.fromEntries((await db.query<{ role: string; email_prefs: Record<string, unknown> }>(
  "SELECT role::text AS role, email_prefs FROM org_members WHERE org_id=$1", [orgId])).rows.map(row => [row.role, row.email_prefs]));
/** Everything a reminder or notification would leave behind (MGT-135-AC3: a save sends nothing). */
const outbound = async () => (await db.query<{ email_log: number; notifications: number; b028: number; b013: number }>(
  `SELECT (SELECT count(*) FROM email_log)::int AS email_log, (SELECT count(*) FROM notifications)::int AS notifications,
          (SELECT count(*) FROM app.b028_notification_events)::int AS b028, (SELECT count(*) FROM app.b013_repair_event_outbox)::int AS b013`)).rows[0];
/**
 * The audit that exists for these writes today: the generic row trigger (fn_audit) on organizations / org_members, in
 * the same statement — the mail-settings writes have no app-level audit row, and these mirror that.
 */
const lastAuditId = async () => (await db.query<{ id: number }>("SELECT coalesce(max(id),0)::int AS id FROM audit_log")).rows[0].id;
const auditSince = async (id: number) => (await db.query<{ table_name: string; row_id: string; action: string }>(
  "SELECT table_name, row_id, action FROM audit_log WHERE id > $1 ORDER BY id", [id])).rows;

test("MGT-135-AC4: non-admins are refused (403) for 寄給租客的; accountant/maintenance also for 寄給我的; nothing is written", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), prefsBefore = await memberPrefs(orgId), sent = await outbound(), audit = await lastAuditId();
  for (const role of ["manager", "accountant", "maintenance"]) for (const field of ["leaseExpiry", "rentOverdue"])
    assert.deepEqual(await saveNotifySetting(sessions[role], { block: "tenant", field, value: false }), { ok: false, status: 403 }, role);
  for (const role of ["accountant", "maintenance"]) {
    assert.deepEqual(await saveNotifySetting(sessions[role], { block: "me", field: "leaseExpiry", value: false }), { ok: false, status: 403 }, role);
    assert.deepEqual(await notifySettingsRead(sessions[role]), { state: "forbidden" }, role);
  }
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await memberPrefs(orgId), prefsBefore);
  assert.deepEqual(await outbound(), sent);
  assert.deepEqual(await auditSince(audit), []);
});

test("MGT-135-AC1 reader: admin sees both blocks, manager only 寄給我的; same values the existing readers return", async () => {
  const { orgId, sessions } = await makeOrg();
  await db.query("UPDATE organizations SET settings = settings || '{\"email_tenant_rent_overdue\": false}'::jsonb WHERE id=$1", [orgId]);
  await db.query("UPDATE org_members SET email_prefs = '{\"lease_expiry\": false}'::jsonb WHERE org_id=$1 AND role='manager'", [orgId]);
  assert.deepEqual(await notifySettingsRead(sessions.admin),
    { state: "ready", me: { leaseExpiry: true, rentOverdue: true }, tenant: { leaseExpiry: true, rentOverdue: false } });
  assert.deepEqual(await notifySettingsRead(sessions.manager), { state: "ready", me: { leaseExpiry: false, rentOverdue: true }, tenant: null });
  const org = await orgMailSettings(orgId);
  assert.deepEqual({ leaseExpiry: org!.tenantLease, rentOverdue: org!.tenantOverdue }, { leaseExpiry: true, rentOverdue: false });
  assert.deepEqual(await memberEmailPrefs(orgId, sessions.manager.userId), { leaseExpiry: false, rentOverdue: true });
});

test("MGT-135-AC1/AC3: admin saves a tenant switch — only that company key changes; nothing is sent; one row-trigger audit", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), prefsBefore = await memberPrefs(orgId), sent = await outbound(), audit = await lastAuditId();
  assert.deepEqual(await saveNotifySetting(sessions.admin, { block: "tenant", field: "rentOverdue", value: false }),
    { ok: true, block: "tenant", toggles: { leaseExpiry: true, rentOverdue: false } });
  const after = await orgRow(orgId);
  assert.deepEqual(after.settings, { ...before.settings, email_tenant_rent_overdue: false });
  assert.equal(after.contact_email, before.contact_email); assert.deepEqual(after.feature_flags, before.feature_flags);
  assert.deepEqual(await memberPrefs(orgId), prefsBefore);
  // The scheduled sender's reader sees the new value.
  assert.equal((await orgMailSettings(orgId))!.tenantOverdue, false);
  assert.deepEqual(await outbound(), sent);
  assert.deepEqual(await auditSince(audit), [{ table_name: "organizations", row_id: orgId, action: "update" }]);
});

test("MGT-135-AC1: a personal switch saves only the caller's own preference, one key", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), prefsBefore = await memberPrefs(orgId), sent = await outbound(), audit = await lastAuditId();
  assert.deepEqual(await saveNotifySetting(sessions.manager, { block: "me", field: "leaseExpiry", value: false, userId: sessions.admin.userId }),
    { ok: true, block: "me", toggles: { leaseExpiry: false, rentOverdue: true } });
  assert.deepEqual(await saveNotifySetting(sessions.admin, { block: "me", field: "rentOverdue", value: false }),
    { ok: true, block: "me", toggles: { leaseExpiry: true, rentOverdue: false } });
  const prefs = await memberPrefs(orgId);
  assert.deepEqual(prefs.manager, { ...prefsBefore.manager, lease_expiry: false });
  assert.deepEqual(prefs.admin, { ...prefsBefore.admin, rent_overdue: false });
  assert.deepEqual(prefs.accountant, prefsBefore.accountant); assert.deepEqual(prefs.maintenance, prefsBefore.maintenance);
  assert.deepEqual(await orgRow(orgId), before, "a personal save never touches the company settings");
  assert.deepEqual(await memberEmailPrefs(orgId, sessions.manager.userId), { leaseExpiry: false, rentOverdue: true });
  assert.deepEqual(await outbound(), sent);
  const rows = await auditSince(audit);
  assert.deepEqual(rows.map(row => [row.table_name, row.action]), [["org_members", "update"], ["org_members", "update"]]);
});

test("MGT-135 atomic single key: a concurrent change to the other key is kept", async () => {
  const { orgId, sessions } = await makeOrg();
  // Another admin changes the overdue key after this page loaded; saving the lease switch must not rewrite it.
  await db.query(`UPDATE organizations SET settings = jsonb_set(settings, '{email_tenant_rent_overdue}', 'false'::jsonb) WHERE id=$1`, [orgId]);
  assert.deepEqual(await saveNotifySetting(sessions.admin, { block: "tenant", field: "leaseExpiry", value: false }),
    { ok: true, block: "tenant", toggles: { leaseExpiry: false, rentOverdue: false } });
  const settings = (await orgRow(orgId)).settings;
  assert.equal(settings.email_tenant_rent_overdue, false); assert.equal(settings.email_tenant_lease_expiry, false); assert.equal(settings.b073_fixture, "kept");
  await db.query(`UPDATE org_members SET email_prefs = jsonb_set(email_prefs, '{rent_overdue}', 'false'::jsonb) WHERE org_id=$1 AND role='manager'`, [orgId]);
  assert.deepEqual(await saveNotifySetting(sessions.manager, { block: "me", field: "leaseExpiry", value: true }),
    { ok: true, block: "me", toggles: { leaseExpiry: true, rentOverdue: false } });
  assert.deepEqual((await memberPrefs(orgId)).manager, { rent_overdue: false, lease_expiry: true, b073_member: "kept" });
});

const post = (token: string, body: unknown, origin = "http://localhost") => {
  cookie = token;
  return POST(new Request("http://localhost/api/notify-settings", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
};

test("MGT-135-AC4 HTTP: non-admins get 403 for 寄給租客的 and cross-origin gets 403, with nothing written", async () => {
  const { orgId, tokens } = await makeOrg();
  const before = await orgRow(orgId), prefsBefore = await memberPrefs(orgId), sent = await outbound(), audit = await lastAuditId();
  for (const role of ["manager", "accountant", "maintenance"]) {
    const res = await post(tokens[role], { block: "tenant", field: "leaseExpiry", value: false });
    assert.equal(res.status, 403, role); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal((await post(tokens.accountant, { block: "me", field: "leaseExpiry", value: false })).status, 403);
  assert.equal((await post(tokens.admin, { block: "tenant", field: "leaseExpiry", value: false }, "http://evil.example")).status, 403);
  assert.equal((await post(tokens.admin, { block: "tenant", field: "contactEmail", value: false })).status, 400);
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await memberPrefs(orgId), prefsBefore);
  assert.deepEqual(await outbound(), sent);
  assert.deepEqual(await auditSince(audit), []);
});

test("MGT-135-AC1 HTTP: admin and manager → 200 with the stored block; nothing outbound", async () => {
  const { orgId, sessions, tokens } = await makeOrg();
  const before = await orgRow(orgId), sent = await outbound();
  const tenant = await post(tokens.admin, { block: "tenant", field: "leaseExpiry", value: false });
  assert.equal(tenant.status, 200); assert.deepEqual(await tenant.json(), { block: "tenant", toggles: { leaseExpiry: false, rentOverdue: true } });
  const mine = await post(tokens.manager, { block: "me", field: "rentOverdue", value: false });
  assert.equal(mine.status, 200); assert.deepEqual(await mine.json(), { block: "me", toggles: { leaseExpiry: true, rentOverdue: false } });
  assert.deepEqual((await orgRow(orgId)).settings, { ...before.settings, email_tenant_lease_expiry: false });
  assert.deepEqual(await memberEmailPrefs(orgId, sessions.manager.userId), { leaseExpiry: true, rentOverdue: false });
  assert.deepEqual(await outbound(), sent);
});

test("MGT-135-AC2: under brand_v3 the 規則與資料 form saves its contact fields and keeps the stored tenant switches", async () => {
  const { orgId, sessions } = await makeOrg();
  await db.query("UPDATE organizations SET settings = settings || '{\"email_tenant_rent_overdue\": false}'::jsonb WHERE id=$1", [orgId]);
  const before = await orgRow(orgId);
  await saveOrgMailSettings(sessions.admin, { tenantLease: null, tenantOverdue: null, contactEmail: "new-office@example.com", contactPhone: "02-0000-0000" });
  const after = await orgRow(orgId);
  assert.deepEqual(after.settings, before.settings, "the switches are not rewritten from an absent checkbox");
  assert.equal(after.contact_email, "new-office@example.com");
  // Flag OFF (both values given) still writes both switches, as before.
  await saveOrgMailSettings(sessions.admin, { tenantLease: false, tenantOverdue: true, contactEmail: "new-office@example.com", contactPhone: "" });
  const off = (await orgRow(orgId)).settings;
  assert.equal(off.email_tenant_lease_expiry, false); assert.equal(off.email_tenant_rent_overdue, true);
});
