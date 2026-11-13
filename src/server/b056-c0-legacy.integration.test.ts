import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";

// B-056 C-0 legacy classifier (MGT-96-AC4: a legacy trial counts as the org's one trial).
// Synthetic orgs in a disposable PG only.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db?.end(); });

let seq = 0;
async function org(settings: object, opts: { requested?: boolean } = {}) {
  const tag = `b056c0.${Date.now().toString(36)}.${seq++}`;
  const admin = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`${tag}@example.com`])).rows[0].id;
  const id = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, settings) VALUES ($1, 'TW', 'TWD', $2::jsonb) RETURNING id`,
    [tag, JSON.stringify(settings)])).rows[0].id;
  await db.query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [id, admin]);
  if (opts.requested) await db.query(`INSERT INTO upgrade_requests (org_id, user_id, tier, units, note) VALUES ($1, $2, 'standard', 3, 'offline')`, [id, admin]);
  return { id, admin };
}
async function classify(orgId: string, actor: string) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const r = (await db.query<{ c: string }>("SELECT app.b056_classify_legacy($1, $2) AS c", [orgId, actor])).rows[0].c;
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
const row = async (orgId: string) => (await db.query(
  `SELECT trial_plan, trial_source, trial_started_at, legacy_class,
          to_char(trial_ends_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') AS ends_taipei, trial_ends_at <= now() AS ended
     FROM app.b056_org_trials WHERE org_id = $1`, [orgId])).rows[0];
const audits = async (orgId: string) => Number((await db.query(`SELECT count(*) FROM audit_log WHERE org_id = $1 AND table_name = 'b056_org_trials'`, [orgId])).rows[0].count);

test("C-0: never trialled → class row only; the admin can still start one trial later", async () => {
  const o = await org({});
  assert.equal(await classify(o.id, o.admin), "never_trialled");
  const r = await row(o.id);
  assert.equal(r.legacy_class, "never_trialled");
  assert.equal(r.trial_plan, null);
  assert.equal(await audits(o.id), 1);
});

test("C-0: a future legacy trialUntil is kept as the one trial, ending 00:00 Taipei the next day (never shorter)", async () => {
  const o = await org({ plan: { tier: "pro", trialUntil: "2099-03-10T15:30:00Z" } }); // 2099-03-10 23:30 Taipei
  assert.equal(await classify(o.id, o.admin), "active_legacy_trial");
  const r = await row(o.id);
  assert.deepEqual([r.trial_plan, r.trial_source, r.trial_started_at, r.legacy_class, r.ends_taipei, r.ended],
    ["pro", "legacy", null, "active_legacy_trial", "2099-03-11 00:00", false]);
  const s = await org({ plan: { tier: "standard", trialUntil: "2099-03-10T16:30:00Z" } }); // 2099-03-11 00:30 Taipei
  await classify(s.id, s.admin);
  assert.equal((await row(s.id)).ends_taipei, "2099-03-12 00:00");
});

test("C-0: past trialUntil, a paid-looking tier, an upgrade request or an unreadable date → trial used, not paid", async () => {
  const cases: [object, { requested?: boolean }, string][] = [
    [{ plan: { tier: "standard", trialUntil: "2026-01-01T00:00:00Z" } }, {}, "standard"],
    [{ plan: { tier: "business" } }, {}, "pro"],
    [{ plan: { tier: "pro", trialUntil: null } }, {}, "pro"],
    [{}, { requested: true }, "standard"],
    [{ plan: { trialUntil: "not a date" } }, {}, "standard"],
  ];
  for (const [settings, opts, plan] of cases) {
    const o = await org(settings, opts);
    assert.equal(await classify(o.id, o.admin), "trial_used_not_paid", JSON.stringify(settings));
    const r = await row(o.id);
    assert.deepEqual([r.trial_plan, r.trial_source, r.legacy_class, r.ended], [plan, "legacy", "trial_used_not_paid", true], JSON.stringify(settings));
  }
});

test("C-0 is idempotent and never overwrites a B-056 trial or a paid record", async () => {
  const o = await org({ plan: { tier: "pro", trialUntil: "2026-01-01T00:00:00Z" } });
  assert.equal(await classify(o.id, o.admin), "trial_used_not_paid");
  const first = await row(o.id);
  assert.equal(await classify(o.id, o.admin), "trial_used_not_paid");
  assert.deepEqual(await row(o.id), first);
  assert.equal(await audits(o.id), 1);

  const started = await org({});
  await db.query(`INSERT INTO app.b056_org_trials (org_id, trial_plan, trial_source, trial_started_at, trial_ends_at)
                  VALUES ($1, 'standard', 'settings', now(), now() + interval '3 months')`, [started.id]);
  assert.equal(await classify(started.id, started.admin), "b056_trial");
  assert.equal((await row(started.id)).legacy_class, null);
  assert.equal(await audits(started.id), 0);
});

test("C-0 privileges: EXECUTE for service_role only; unknown org refused", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await db.query(`SELECT has_function_privilege($1, 'app.b056_classify_legacy(uuid, uuid)', 'EXECUTE') AS h`, [role])).rows[0].h, false);
  }
  assert.equal((await db.query(`SELECT has_function_privilege('service_role', 'app.b056_classify_legacy(uuid, uuid)', 'EXECUTE') AS h`)).rows[0].h, true);
  await assert.rejects(classify("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000"), /b056_forbidden/);
});
