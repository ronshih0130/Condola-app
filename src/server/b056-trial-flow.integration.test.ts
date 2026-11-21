import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { withClient } from "./db";
import { FlowError } from "./errors";
import { requestUpgrade } from "./partners";
import { commercialTier, lockSeatOrganization } from "./seats";
import { effectivePlan, startTrial } from "./b056-trial";
import { governCustomRole } from "./b017-custom-role-governance";
import { sessionTokenHash } from "./session";
import { randomUUID } from "node:crypto";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-056 PR-2: resolver, start, seat wiring and the requestUpgrade flag-ON branch.
// Stories: MGT-96-AC2, MGT-96-AC4, MGT-97-AC1, MGT-97-AC2. Synthetic orgs/users only.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let fetchCalls = 0;
const realFetch = globalThis.fetch;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // OQ-B056-13: any network call during these flows fails the test.
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("b056 test: outbound fetch is forbidden"); }) as typeof fetch;
});
test.after(async () => {
  globalThis.fetch = realFetch;
  await db?.end();
  assert.equal(fetchCalls, 0, "B-056 flows made a network call");
});

type Org = { orgId: string; admin: string; manager: string };
let seq = 0;
async function makeOrg(flagOn: boolean, settings: object = {}): Promise<Org> {
  const tag = `b056f.${Date.now().toString(36)}.${seq++}`;
  const [admin, manager] = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     SELECT gen_random_uuid(), $1 || '.' || n || '@example.com', '{}'::jsonb, now(), 'authenticated', 'authenticated'
       FROM generate_series(1, 2) n RETURNING id`, [tag])).rows.map((r) => r.id);
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, plan_tier, settings, feature_flags)
     VALUES ($1, 'TW', 'TWD', 'beta', $2::jsonb, $3::jsonb) RETURNING id`,
    [tag, JSON.stringify(settings), JSON.stringify(flagOn ? { pricing_trial: true } : {})])).rows[0].id;
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'manager', 'active')`,
    [orgId, admin, manager]);
  if (flagOn) {
    await db.query(
      `UPDATE platform_settings SET value = jsonb_build_object('enabled', true,
         'allowed_org_ids', coalesce(value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))
       WHERE key = 'pricing_trial'`, [orgId]);
  }
  return { orgId, admin, manager };
}
function session(userId: string, orgId: string, role: "admin" | "manager"): Session {
  return {
    userId, sessionId: "b056-flow", email: `${userId}@example.com`, name: "B056", kind: "staff", role,
    orgId, liveOrgId: orgId, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null,
  } as Session;
}
const seatLimitOf = (orgId: string) =>
  withClient(async (client) => {
    await client.query("BEGIN");
    try { return (await lockSeatOrganization(client, orgId)).limit; } finally { await client.query("ROLLBACK"); }
  });
const errorKey = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof FlowError ? e.key : String(e); } };

test("flag OFF: legacy behaviour is unchanged (tier, seat limit, requestUpgrade writes settings.plan)", async () => {
  const o = await makeOrg(false, { plan: { tier: "standard", trialUntil: null } });
  assert.equal(await commercialTier(o.orgId), "standard");
  assert.equal(await seatLimitOf(o.orgId), 5);
  assert.equal(await effectivePlan(o.orgId), null);
  const b = await makeOrg(false);
  assert.equal(await commercialTier(b.orgId), "beta");
  assert.equal(await seatLimitOf(b.orgId), null);
  await requestUpgrade(session(b.admin, b.orgId, "admin"), "standard", "");
  const plan = (await db.query(`SELECT settings->'plan'->>'tier' AS tier, settings->'plan'->>'trialUntil' AS until FROM organizations WHERE id = $1`, [b.orgId])).rows[0];
  assert.equal(plan.tier, "standard");
  assert.ok(plan.until);
  assert.equal(await errorKey(startTrial(session(b.admin, b.orgId, "admin"), "standard")), "errors.notFound");
});

test("MGT-96-AC2 / MGT-97-AC1 / MGT-97-AC2: flag ON — Free until a trial starts, then the trial plan drives tier and seats", async () => {
  // legacy settings.plan is ignored while ON (design decision 7)
  const o = await makeOrg(true, { plan: { tier: "pro", trialUntil: "2099-01-01T00:00:00Z" } });
  assert.equal(await commercialTier(o.orgId), "free");
  assert.equal(await seatLimitOf(o.orgId), 1);
  assert.equal((await effectivePlan(o.orgId))?.kind, "free");

  assert.equal(await errorKey(startTrial(session(o.manager, o.orgId, "manager"), "standard")), "errors.forbidden");
  const started = await startTrial(session(o.admin, o.orgId, "admin"), "standard");
  assert.ok(started.endsAt instanceof Date && started.endsAt.getTime() > Date.now());
  assert.equal(await commercialTier(o.orgId), "standard");
  assert.equal(await seatLimitOf(o.orgId), 5);
  const plan = await effectivePlan(o.orgId);
  assert.deepEqual([plan?.kind, plan?.tier, plan?.trial?.plan], ["trial", "standard", "standard"]);

  // MGT-96-AC4: no second trial, not even the other plan
  assert.equal(await errorKey(startTrial(session(o.admin, o.orgId, "admin"), "pro")), "errors.forbidden");

  const p = await makeOrg(true);
  await startTrial(session(p.admin, p.orgId, "admin"), "pro");
  assert.equal(await commercialTier(p.orgId), "pro");
  assert.equal(await seatLimitOf(p.orgId), null);
});

test("MGT-99-AC1 (state only): at 00:00 Asia/Taipei of the end date the org is Free again (lazy)", async () => {
  const o = await makeOrg(true);
  await startTrial(session(o.admin, o.orgId, "admin"), "pro");
  // synthetic fixture: move the end into the past (owner path, disposable DB)
  await db.query(`UPDATE app.b056_org_trials SET trial_started_at = now() - interval '7 months', trial_ends_at = now() - interval '1 second' WHERE org_id = $1`, [o.orgId]);
  const plan = await effectivePlan(o.orgId);
  assert.deepEqual([plan?.kind, plan?.tier, plan?.seatLimit], ["free_after_trial", "free", 1]);
  assert.equal(await commercialTier(o.orgId), "free");
  assert.equal(await seatLimitOf(o.orgId), 1);
  assert.equal(await errorKey(startTrial(session(o.admin, o.orgId, "admin"), "standard")), "errors.forbidden");
});

test("flag ON: requestUpgrade records the request but grants no tier or trial (pay-then-activate)", async () => {
  const o = await makeOrg(true);
  const before = (await db.query(`SELECT settings FROM organizations WHERE id = $1`, [o.orgId])).rows[0].settings;
  await requestUpgrade(session(o.admin, o.orgId, "admin"), "pro", "");
  const after = (await db.query(`SELECT settings FROM organizations WHERE id = $1`, [o.orgId])).rows[0].settings;
  assert.deepEqual(after, before);
  assert.equal(Number((await db.query(`SELECT count(*) FROM upgrade_requests WHERE org_id = $1`, [o.orgId])).rows[0].count), 1);
  assert.equal(await commercialTier(o.orgId), "free");
  assert.equal((await effectivePlan(o.orgId))?.kind, "free");
});

test("start uses the session's live org only and re-checks the admin in SQL", async () => {
  const a = await makeOrg(true);
  const b = await makeOrg(true);
  // admin of A whose session claims org B: SQL refuses (not an admin of B)
  const forged = { ...session(a.admin, b.orgId, "admin") };
  assert.equal(await errorKey(startTrial(forged, "standard")), "errors.forbidden");
  assert.equal((await effectivePlan(b.orgId))?.kind, "free");
});

test("Codex PR-2 r1 阻塞: settings.edit revoked while start waits on the org lock → the trial and its audit roll back", async () => {
  const o = await makeOrg(true);
  const a2 = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`b056race.${Date.now()}@example.com`])).rows[0].id;
  await db.query(`UPDATE org_members SET is_billing_owner = true WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.admin]);
  await db.query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [o.orgId, a2]);
  const savedEnv = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const savedFlag = (await db.query(`SELECT value FROM platform_settings WHERE key = 'custom_roles'`)).rows[0]?.value ?? null;
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
  await db.query(`INSERT INTO platform_settings(key, value) VALUES ('custom_roles', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text)))
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [o.orgId]);
  await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"custom_roles":true}' WHERE id = $1`, [o.orgId]);
  const withSession = async (userId: string): Promise<Session> => {
    const s = session(userId, o.orgId, "admin");
    s.sessionId = randomUUID();
    await db.query(`INSERT INTO auth_sessions(id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [s.sessionId, userId, sessionTokenHash(randomUUID())]);
    return s;
  };
  const owner = await withSession(o.admin);
  const racer = await withSession(a2);
  const lock = new Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  try {
    const full = (await governCustomRole(owner, { operation: "create", grants: ["settings.edit"], requestId: randomUUID() })).roleId!;
    const narrow = (await governCustomRole(owner, { operation: "create", grants: ["props.view"], requestId: randomUUID() })).roleId!;
    const memberId = (await db.query(`SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2`, [o.orgId, a2])).rows[0].id;
    await governCustomRole(owner, { operation: "assign", roleId: full, memberId, requestId: randomUUID() });

    await lock.query("BEGIN");
    await lock.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [o.orgId]);
    const pending = startTrial(racer, "pro").then(() => "ok", (e) => (e instanceof FlowError ? e.key : String(e)));
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      waiting = (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%b056_start_trial%'`)).rows[0].n > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(waiting, "start must be waiting on the organizations lock after passing the pre-check");
    // revoke settings.edit for the racer (fixture DML; bypasses governance triggers that would wait on the same lock)
    await db.query("BEGIN");
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(`UPDATE app.b017_assignments SET role_id = $3, revision = 1 WHERE org_id = $1 AND user_id = $2`, [o.orgId, a2, narrow]);
    await db.query("COMMIT");
    await lock.query("COMMIT");
    assert.equal(await pending, "errors.forbidden");
    assert.equal(Number((await db.query(`SELECT count(*) FROM app.b056_org_trials WHERE org_id = $1 AND trial_plan IS NOT NULL`, [o.orgId])).rows[0].count), 0);
    assert.equal(Number((await db.query(`SELECT count(*) FROM audit_log WHERE org_id = $1 AND table_name = 'b056_org_trials'`, [o.orgId])).rows[0].count), 0);
    // control: the owner (native admin, no custom role) can still start
    assert.ok((await startTrial(owner, "standard")).endsAt instanceof Date);
  } finally {
    await lock.query("ROLLBACK").catch(() => undefined);
    await lock.end();
    if (savedEnv === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST; else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedEnv;
    if (savedFlag === null) await db.query(`UPDATE platform_settings SET value = '{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key = 'custom_roles'`);
    else await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'custom_roles'`, [savedFlag]);
  }
});
