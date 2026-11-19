import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { POST } from "@/app/api/owner-view/route";
// Lauren 2b: withFlagGate routes take Next's (request, context); context is unused by these routes.
const ROUTE_CTX = { params: Promise.resolve({}) };
import { ownerPrivacy, SESSION_COOKIE } from "./auth";
import { buildStoredConsent } from "./consent";
import { ENV_COOKIE } from "./org-scope";
import { sessionTokenHash } from "./session";
import { ownerViewRead, saveOwnerView } from "./b073-owner-view";
import { disposableDbUrl } from "./test-disposable-db";
import type { OrgRole, Session } from "./types";

// B-073 / R5-OWNVIEW (MGT-138-AC1…AC3) against a disposable local database. Synthetic data only; nothing outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let cookie = "";
const realFetch = globalThis.fetch;
let fetchCalls = 0;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("B073: outbound fetch is forbidden"); }) as typeof fetch;
  mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => key === SESSION_COOKIE ? { value: cookie } : key === ENV_COOKIE ? { value: "live" } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/api/owner-view" }));
});
test.after(async () => { mock.restoreAll(); globalThis.fetch = realFetch; await db?.end(); assert.equal(fetchCalls, 0); });

async function makeOrg(featureFlags = { brand_v2: true, brand_v3: true }) {
  const tag = `b073.${randomUUID()}`;
  const settings = { show_tenant_phone: false, require_2fa: false, b073_fixture: "kept" };
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,tax_id,country_code,default_currency,plan_tier,settings,feature_flags)
     VALUES ($1,'04595257','TW','TWD','beta',$2::jsonb,$3::jsonb) RETURNING id`, [tag, JSON.stringify(settings), JSON.stringify(featureFlags)])).rows[0].id;
  const sessions: Record<string, Session> = {};
  const tokens: Record<string, string> = {};
  for (const role of ["admin", "manager", "accountant", "maintenance"] as OrgRole[]) {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`${tag}.${role}@example.com`])).rows[0].id;
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);
    sessions[role] = { userId, orgId, liveOrgId: orgId, role, sessionId: randomUUID(), kind: "staff", environment: "live", locale: "zh-TW",
      calendar: "gregorian", leaseId: null, name: "Synthetic", email: `${tag}.${role}@example.com` };
    const token = randomUUID();
    tokens[role] = token;
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessions[role].sessionId, userId, sessionTokenHash(token)]);
    const consent = buildStoredConsent("reconsent");
    await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES ($1,$2,$3,$4,$5)",
      [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  }
  return { orgId, tag, sessions, tokens };
}
const orgRow = async (orgId: string) => (await db.query<{ settings: Record<string, unknown>; name: string; feature_flags: unknown }>(
  "SELECT settings, name, feature_flags FROM organizations WHERE id=$1", [orgId])).rows[0];
const audits = async (orgId: string) => (await db.query<{ action: string; n: number }>(
  "SELECT table_name || ':' || row_id AS action, count(*)::int AS n FROM audit_log WHERE org_id=$1 GROUP BY 1 ORDER BY 1", [orgId])).rows;

test("MGT-138-AC3: manager, accountant and maintenance are refused (403) and nothing changes", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  for (const role of ["manager", "accountant", "maintenance"]) {
    assert.deepEqual(await saveOwnerView(sessions[role], { field: "showPhone", value: true }), { ok: false, status: 403 }, role);
    assert.deepEqual(await ownerViewRead(sessions[role]), { state: "forbidden" }, role);
  }
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});

test("MGT-138-AC1/AC2: admin reads and saves; only the two privacy keys change, plus the owner_privacy audit row", async () => {
  const { orgId, tag, sessions } = await makeOrg();
  assert.deepEqual(await ownerViewRead(sessions.admin), { state: "ready", privacy: { showName: true, showPhone: false }, company: { name: tag, taxId: "04595257" } });
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showPhone", value: true }), { ok: true, privacy: { showName: true, showPhone: true } });
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showName", value: false }), { ok: true, privacy: { showName: false, showPhone: true } });
  const after = await orgRow(orgId);
  assert.deepEqual(after.settings, { ...before.settings, show_tenant_name: false, show_tenant_phone: true });
  assert.equal(after.name, before.name); assert.deepEqual(after.feature_flags, before.feature_flags);
  // Same company-wide value the owner pages read today.
  assert.deepEqual(await ownerPrivacy(orgId), { showName: false, showPhone: true, name: tag });
  const added = (await audits(orgId)).map(row => ({ ...row, n: row.n - (auditBefore.find(b => b.action === row.action)?.n ?? 0) })).filter(row => row.n);
  assert.deepEqual(added, [{ action: "auth_events:owner_privacy", n: 2 }]);
});

test("MGT-138 race fix: sequential single-key saves keep both values; the other key is never rewritten from a stale read", async () => {
  const { orgId, sessions } = await makeOrg();
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showName", value: false }), { ok: true, privacy: { showName: false, showPhone: false } });
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showPhone", value: true }), { ok: true, privacy: { showName: false, showPhone: true } });
  assert.deepEqual(await ownerPrivacy(orgId).then(({ showName, showPhone }) => ({ showName, showPhone })), { showName: false, showPhone: true });
  // Another admin changes the name key directly after this page loaded; saving the phone switch must not touch it.
  await db.query(`UPDATE organizations SET settings = jsonb_set(settings, '{show_tenant_name}', 'true'::jsonb) WHERE id=$1`, [orgId]);
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showPhone", value: false }), { ok: true, privacy: { showName: true, showPhone: false } });
  const settings = (await orgRow(orgId)).settings;
  assert.equal(settings.show_tenant_name, true, "name kept from the concurrent change");
  assert.equal(settings.show_tenant_phone, false);
  assert.equal(settings.b073_fixture, "kept");
  // The audit row has the setOwnerPrivacy shape, with the resulting both-key state.
  const last = (await db.query<{ new_row: Record<string, unknown> }>(
    "SELECT new_row FROM audit_log WHERE org_id=$1 AND table_name='auth_events' AND row_id='owner_privacy' ORDER BY id DESC LIMIT 1", [orgId])).rows[0].new_row;
  assert.deepEqual(last, { event: "owner_privacy", showName: true, showPhone: false });
});

const post = (token: string, body: unknown, origin = "http://localhost") => {
  cookie = token;
  return POST(new Request("http://localhost/api/owner-view", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), ROUTE_CTX);
};

test("MGT-138 flag OFF: direct save and POST /api/owner-view answer 404 to an admin without changing settings or audits", async () => {
  const { orgId, sessions, tokens } = await makeOrg({ brand_v2: true, brand_v3: false });
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  const input = { field: "showPhone", value: true };
  assert.deepEqual(await saveOwnerView(sessions.admin, input), { ok: false, status: 404 });
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
  const res = await post(tokens.admin, input);
  assert.equal(res.status, 404); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});

test("MGT-138-AC3 HTTP: non-admins get 403 and cross-origin gets 403, with settings and audit rows unchanged", async () => {
  const { orgId, tokens } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  for (const role of ["manager", "accountant", "maintenance"]) {
    const res = await post(tokens[role], { field: "showPhone", value: true });
    assert.equal(res.status, 403, role); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal((await post(tokens.admin, { field: "showPhone", value: true }, "http://evil.example")).status, 403);
  assert.equal((await post(tokens.admin, { field: "showEmail", value: true })).status, 400);
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});

test("MGT-138-AC1 HTTP: admin → 200 and only that key changes, with one owner_privacy audit row", async () => {
  const { orgId, tokens } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  const res = await post(tokens.admin, { field: "showPhone", value: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { privacy: { showName: true, showPhone: true } });
  const after = await orgRow(orgId);
  assert.deepEqual(after.settings, { ...before.settings, show_tenant_phone: true });
  assert.ok(!("show_tenant_name" in after.settings), "the other key is not written");
  const added = (await audits(orgId)).map(row => ({ ...row, n: row.n - (auditBefore.find(b => b.action === row.action)?.n ?? 0) })).filter(row => row.n);
  assert.deepEqual(added, [{ action: "auth_events:owner_privacy", n: 1 }]);
});

test("MGT-138 atomic audit: a failed audit write rolls the settings change back (500, nothing stored)", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  const result = await saveOwnerView(sessions.admin, { field: "showPhone", value: true }, { audit: async (client) => {
    // The UPDATE is visible inside the transaction before the audit fails.
    const inside = (await client.query<{ phone: boolean }>("SELECT (settings->>'show_tenant_phone')::boolean AS phone FROM organizations WHERE id=$1", [orgId])).rows[0];
    assert.equal(inside.phone, true);
    throw new Error("audit insert failed");
  } });
  assert.deepEqual(result, { ok: false, status: 500 });
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});
