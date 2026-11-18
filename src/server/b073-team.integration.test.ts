import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { POST } from "@/app/api/team-security/route";
import { SESSION_COOKIE } from "./auth";
import { buildStoredConsent } from "./consent";
import { ENV_COOKIE } from "./org-scope";
import { sessionTokenHash } from "./session";
import { seatUsage } from "./seats";
import { saveTeamSecurity, teamRead } from "./b073-team";
import { disposableDbUrl } from "./test-disposable-db";
import type { OrgRole, Session } from "./types";

// B-073 / R5-TEAM (MGT-133 AC1, AC4, AC6, AC7, AC8) against a disposable local database. Synthetic data only;
// nothing outbound. The B-056 trial flag is turned on only for the pause case and restored afterwards.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let cookie = "";
let trialSetting: unknown = null;
const realFetch = globalThis.fetch;
let fetchCalls = 0;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  trialSetting = (await db.query("SELECT value FROM platform_settings WHERE key='pricing_trial'")).rows[0]?.value ?? null;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("B073: outbound fetch is forbidden"); }) as typeof fetch;
  mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => key === SESSION_COOKIE ? { value: cookie } : key === ENV_COOKIE ? { value: "live" } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/api/team-security" }));
});
test.after(async () => {
  mock.restoreAll(); globalThis.fetch = realFetch;
  if (trialSetting !== null) await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='pricing_trial'", [JSON.stringify(trialSetting)]);
  await db?.end(); assert.equal(fetchCalls, 0);
});

async function makeOrg(featureFlags: Record<string, unknown> = {}) {
  const tag = `b073t.${randomUUID()}`;
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,country_code,default_currency,plan_tier,settings,feature_flags)
     VALUES ($1,'TW','TWD','beta',$2::jsonb,$3::jsonb) RETURNING id`,
    [tag, JSON.stringify({ require_2fa: false, b073_fixture: "kept" }), JSON.stringify(featureFlags)])).rows[0].id;
  const sessions: Record<string, Session> = {};
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  let day = 10;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as OrgRole[]) {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`${tag}.${role}@example.com`])).rows[0].id;
    users[role] = userId;
    await db.query("INSERT INTO profiles (id, display_name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name",
      [userId, `Synthetic ${role}`, `${tag}.${role}@example.com`]);
    await db.query("INSERT INTO org_members(org_id,user_id,role,status,created_at) VALUES ($1,$2,$3,'active',now() - make_interval(days => $4))", [orgId, userId, role, day--]);
    sessions[role] = { userId, orgId, liveOrgId: orgId, role, sessionId: randomUUID(), kind: "staff", environment: "live", locale: "zh-TW",
      calendar: "gregorian", leaseId: null, name: "Synthetic", email: `${tag}.${role}@example.com` };
    const token = randomUUID();
    tokens[role] = token;
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessions[role].sessionId, userId, sessionTokenHash(token)]);
    const consent = buildStoredConsent("reconsent");
    await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES ($1,$2,$3,$4,$5)",
      [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  }
  await db.query(`INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at) VALUES ($1,'team_member','manager',$2,$3,now()+interval '7 days')`,
    [orgId, `${tag}.invitee@example.com`, randomUUID().replace(/-/g, "").repeat(2)]);
  return { orgId, tag, sessions, tokens, users };
}
const orgRow = async (orgId: string) => (await db.query<{ settings: Record<string, unknown> }>("SELECT settings FROM organizations WHERE id=$1", [orgId])).rows[0];
const audits = async (orgId: string) => (await db.query<{ action: string; n: number }>(
  "SELECT table_name || ':' || row_id AS action, count(*)::int AS n FROM audit_log WHERE org_id=$1 GROUP BY 1 ORDER BY 1", [orgId])).rows;

test("MGT-133-AC8: manager, accountant and maintenance cannot read 團隊 or change the 2FA rule; nothing changes", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  for (const role of ["manager", "accountant", "maintenance"]) {
    assert.deepEqual(await teamRead(sessions[role]), { state: "forbidden" }, role);
    assert.deepEqual(await saveTeamSecurity(sessions[role], { required: true }), { ok: false, status: 403 }, role);
  }
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});

test("MGT-133-AC1/AC4: admin sees every colleague (4 active + 1 invited); used = seats.ts; no pause with pricing_trial OFF", async () => {
  const { orgId, tag, sessions } = await makeOrg();
  const read = await teamRead(sessions.admin);
  assert.equal(read.state, "ready");
  if (read.state !== "ready") return;
  assert.deepEqual(read.rows.map(row => [row.role, row.status]).sort(), [["accountant", "active"], ["admin", "active"], ["maintenance", "active"], ["manager", "active"], ["manager", "invited"]]);
  const invited = read.rows.find(row => row.status === "invited")!;
  assert.equal(invited.name, `${tag}.invitee@example.com`); assert.equal(invited.inviteLive, true);
  assert.equal(read.rows.find(row => row.role === "admin")!.self, true);
  assert.equal(read.seats.used, (await seatUsage(orgId)).used);
  assert.equal(read.seats.used, 5);
  assert.deepEqual(read.security, { required: false });
});

test("MGT-133-AC6: after a trial ends (B-056 ON), the kept admin sees the others as 暫停 and the team at its Free limit", async () => {
  const { orgId, sessions, users } = await makeOrg({ pricing_trial: true });
  await db.query(`UPDATE platform_settings SET value = jsonb_build_object('enabled', true,
      'allowed_org_ids', coalesce(value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text)) WHERE key = 'pricing_trial'`, [orgId]);
  await db.query(`INSERT INTO app.b056_org_trials (org_id, trial_plan, trial_source, trial_started_at, trial_ends_at)
     VALUES ($1, 'standard', 'settings', now() - interval '30 days', clock_timestamp() - interval '1 hour')`, [orgId]);
  try {
    const read = await teamRead(sessions.admin);
    assert.equal(read.state, "ready");
    if (read.state !== "ready") return;
    const byUser = (role: string) => read.rows.find(row => row.role === role && row.status !== "invited");
    assert.equal(byUser("admin")?.status, "active", "the kept admin");
    for (const role of ["manager", "accountant", "maintenance"]) assert.equal(byUser(role)?.status, "paused", role);
    assert.ok(users.manager);
    // Paused members still count (seats.ts counts status 'active'); the effective plan is Free (1).
    assert.deepEqual([read.seats, read.full], [{ used: 5, limit: 1 }, true]);
  } finally {
    await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{allowed_org_ids}', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(value->'allowed_org_ids') x WHERE x <> to_jsonb($1::text)), '[]'::jsonb)) WHERE key='pricing_trial'`, [orgId]);
  }
});

const post = (token: string, body: unknown, origin = "http://localhost") => {
  cookie = token;
  return POST(new Request("http://localhost/api/team-security", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
};

test("MGT-133-AC7/AC8 HTTP: non-admins 403; admin turns the company 2FA rule on with the existing require_2fa audit row", async () => {
  const { orgId, tokens, sessions } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  for (const role of ["manager", "accountant", "maintenance"]) assert.equal((await post(tokens[role], { required: true })).status, 403, role);
  assert.equal((await post(tokens.admin, { required: true }, "http://evil.example")).status, 403);
  assert.equal((await post(tokens.admin, { required: "on" })).status, 400);
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
  const res = await post(tokens.admin, { required: true });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { required: true });
  assert.deepEqual((await orgRow(orgId)).settings, { ...before.settings, require_2fa: true });
  const added = (await audits(orgId)).map(row => ({ ...row, n: row.n - (auditBefore.find(b => b.action === row.action)?.n ?? 0) })).filter(row => row.n);
  assert.deepEqual(added, [{ action: "auth_events:require_2fa", n: 1 }]);
  const read = await teamRead(sessions.admin);
  assert.deepEqual(read.state === "ready" && read.security, { required: true });
  assert.deepEqual(await saveTeamSecurity(sessions.admin, { required: false }), { ok: true, required: false });
  assert.equal((await orgRow(orgId)).settings.require_2fa, false);
});
