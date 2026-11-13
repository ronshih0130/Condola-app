import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";

// B-056 PR-1 schema/RLS (design note condola-hub 20-build/specs/B-056-design.md, PR-1).
// Stories: MGT-96-AC2 (start), MGT-96-AC4 (once only), MGT-97-AC1 (end date), MGT-98-AC2 (per-user
// banner dismissal). Disposable PG only; every org and user here is synthetic.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const MIGRATION = readFileSync(new URL("../../supabase/migrations/20261113200000_b056_trial_engine_schema.sql", import.meta.url), "utf8");
const FUNCTIONS = [
  "app.b056_enabled(uuid)",
  "app.b056_plan_facts(uuid)",
  "app.b056_trial_end(text, timestamptz)",
  "app.b056_start_trial(uuid, uuid, text)",
  "app.b056_dismiss_banner(uuid, uuid, text)",
  "app.b056_banner_dismissed_kinds(uuid, uuid)",
];
const TABLES = ["app.b056_org_trials", "app.b056_banner_dismissals"];

const connect = async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; };
let db: Client;
test.before(async () => { db = await connect(); });
test.after(async () => { await db?.end(); });

type Org = { orgId: string; admin: string; admin2: string; manager: string; suspendedAdmin: string; outsider: string };
let seq = 0;
async function makeOrg(flagOn: boolean): Promise<Org> {
  const tag = `b056.${Date.now().toString(36)}.${seq++}`;
  const users = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     SELECT gen_random_uuid(), $1 || '.' || n || '@example.com', '{}'::jsonb, now(), 'authenticated', 'authenticated'
       FROM generate_series(1, 5) n RETURNING id`, [tag])).rows.map((r) => r.id);
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, feature_flags)
     VALUES ($1, 'TW', 'TWD', $2::jsonb) RETURNING id`,
    [tag, JSON.stringify(flagOn ? { pricing_trial: true } : {})])).rows[0].id;
  const [admin, admin2, manager, suspendedAdmin, outsider] = users;
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role, status, created_at) VALUES
       ($1, $2, 'admin', 'active', now() - interval '3 days'),
       ($1, $3, 'admin', 'active', now() - interval '2 days'),
       ($1, $4, 'manager', 'active', now() - interval '1 day'),
       ($1, $5, 'admin', 'suspended', now())`,
    [orgId, admin, admin2, manager, suspendedAdmin]);
  if (flagOn) await allowOrg(orgId);
  return { orgId, admin, admin2, manager, suspendedAdmin, outsider };
}
async function allowOrg(orgId: string) {
  await db.query(
    `UPDATE platform_settings SET value = jsonb_build_object('enabled', true,
       'allowed_org_ids', coalesce(value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))
     WHERE key = 'pricing_trial'`, [orgId]);
}
/** Run SQL as service_role, the only role granted EXECUTE. */
async function asService<T>(c: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL ROLE service_role");
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r.rows as T[];
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
const start = (c: Client, org: string, actor: string, plan: string) =>
  asService<{ started: boolean; refusal: string | null; trial_ends_at: Date | null }>(c, "SELECT * FROM app.b056_start_trial($1, $2, $3)", [org, actor, plan]).then((r) => r[0]);
const auditCount = async (org: string) =>
  Number((await db.query(`SELECT count(*) FROM audit_log WHERE org_id = $1 AND table_name = 'b056_org_trials'`, [org])).rows[0].count);
const taipeiDay = async (offsetMonths: number) =>
  (await db.query<{ d: string }>(
    `SELECT to_char(((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date + make_interval(months => $1))::date, 'YYYY-MM-DD') AS d`, [offsetMonths])).rows[0].d;

test("PR-1: flag seeded OFF; tables definer-only with RLS forced; EXECUTE only for service_role", async () => {
  const flag = (await db.query(`SELECT value FROM platform_settings WHERE key = 'pricing_trial'`)).rows[0]?.value;
  assert.ok(flag, "pricing_trial seeded");
  // The seed is OFF; other tests may have added allowlisted synthetic orgs, never enabled=false→true for real orgs.
  assert.match(MIGRATION, /'pricing_trial',\s*'\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb/);
  for (const t of TABLES) {
    const r = (await db.query(`SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = $1::regclass`, [t])).rows[0];
    assert.deepEqual(r, { rls: true, force: true }, t);
    for (const role of ["anon", "authenticated", "service_role", "public"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const has = role === "public"
          ? (await db.query(`SELECT has_table_privilege('public', $1, $2) AS h`, [t, p]).catch(() => ({ rows: [{ h: false }] }))).rows[0].h
          : (await db.query(`SELECT has_table_privilege($1, $2, $3) AS h`, [role, t, p])).rows[0].h;
        assert.equal(has, false, `${role} ${p} on ${t}`);
      }
    }
    assert.equal(Number((await db.query(`SELECT count(*) FROM pg_policies WHERE schemaname || '.' || tablename = $1`, [t])).rows[0].count), 0, `${t} has no policies`);
  }
  for (const f of FUNCTIONS) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS h`, [role, f])).rows[0].h, false, `${role} EXECUTE ${f}`);
    }
    assert.equal((await db.query(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS h`, [f])).rows[0].h, true, `service_role EXECUTE ${f}`);
    const def = (await db.query(`SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = $1::regprocedure`, [f])).rows[0];
    assert.ok((def.proconfig ?? []).includes("search_path=pg_catalog, pg_temp"), `${f} pins search_path`);
  }
  // service_role still cannot read the tables directly
  await assert.rejects(asService(db, "SELECT * FROM app.b056_org_trials"), /permission denied/);
});

test("PR-1: global enabled + org flag but NOT on the allowlist stays OFF (Codex PR-1 r1 次要)", async () => {
  await makeOrg(true); // another org on the allowlist, so platform_settings.pricing_trial.enabled is true
  const enabled = (await db.query(`SELECT value->'enabled' = 'true'::jsonb AS on FROM platform_settings WHERE key = 'pricing_trial'`)).rows[0].on;
  assert.equal(enabled, true);
  const outside = await makeOrg(false);
  await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"pricing_trial":true}' WHERE id = $1`, [outside.orgId]);
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [outside.orgId]))[0].e, false);
  await assert.rejects(start(db, outside.orgId, outside.admin, "standard"), /b056_disabled/);
  assert.equal((await asService(db, "SELECT * FROM app.b056_plan_facts($1)", [outside.orgId])).length, 0);
  assert.equal(Number((await db.query(`SELECT count(*) FROM app.b056_org_trials WHERE org_id = $1`, [outside.orgId])).rows[0].count), 0);
  assert.equal(await auditCount(outside.orgId), 0);
});

test("PR-1: flag gate needs enabled=true, the allowlist and the org flag (fail closed)", async () => {
  const off = await makeOrg(false);
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, false);
  await assert.rejects(start(db, off.orgId, off.admin, "pro"), /b056_disabled/);
  assert.equal((await asService(db, "SELECT * FROM app.b056_plan_facts($1)", [off.orgId])).length, 0);
  // allowlisted but org flag missing
  await allowOrg(off.orgId);
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, false);
  // org flag a string, not boolean true
  await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"pricing_trial":"true"}' WHERE id = $1`, [off.orgId]);
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, false);
  await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"pricing_trial":true}' WHERE id = $1`, [off.orgId]);
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, true);
  // a mixed-type allowlist admits nobody, even an org listed as a string
  const before = (await db.query(`SELECT value FROM platform_settings WHERE key = 'pricing_trial'`)).rows[0].value;
  await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{allowed_org_ids}', (value->'allowed_org_ids') || '[1]'::jsonb) WHERE key = 'pricing_trial'`);
  try {
    assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, false);
  } finally {
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'pricing_trial'`, [before]);
  }
  assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, true);
  // global enabled=false switches it off again for every org
  const saved = (await db.query(`SELECT value FROM platform_settings WHERE key = 'pricing_trial'`)).rows[0].value;
  await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE key = 'pricing_trial'`);
  try {
    assert.equal((await asService<{ e: boolean }>(db, "SELECT app.b056_enabled($1) AS e", [off.orgId]))[0].e, false);
  } finally {
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'pricing_trial'`, [saved]);
  }
});

test("MGT-96-AC2 / MGT-97-AC1: an active admin starts a trial; end = 00:00 Asia/Taipei of start day + 3 or 6 months; one audit row", async () => {
  const s = await makeOrg(true);
  const r = await start(db, s.orgId, s.admin, "standard");
  assert.equal(r.started, true);
  assert.equal(r.refusal, null);
  const end = (await db.query<{ d: string; t: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS d, to_char($1::timestamptz AT TIME ZONE 'Asia/Taipei', 'HH24:MI:SS') AS t`, [r.trial_ends_at])).rows[0];
  assert.deepEqual(end, { d: await taipeiDay(3), t: "00:00:00" });
  const facts = (await asService<Record<string, unknown>>(db, "SELECT * FROM app.b056_plan_facts($1)", [s.orgId]))[0];
  assert.equal(facts.trial_plan, "standard");
  assert.equal(facts.trial_source, "settings");
  assert.equal(facts.paid_plan, null);
  assert.ok(facts.as_of instanceof Date);
  assert.equal(await auditCount(s.orgId), 1);
  const a = (await db.query(`SELECT action::text, actor_user_id, row_id, reason FROM audit_log WHERE org_id = $1 AND table_name = 'b056_org_trials'`, [s.orgId])).rows[0];
  assert.deepEqual(a, { action: "insert", actor_user_id: s.admin, row_id: s.orgId, reason: "b056 trial start" });

  const p = await makeOrg(true);
  const rp = await start(db, p.orgId, p.admin, "pro");
  const pd = (await db.query<{ d: string }>(`SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS d`, [rp.trial_ends_at])).rows[0].d;
  assert.equal(pd, await taipeiDay(6));
});

test("MGT-96-AC4: a second start — same plan, other plan, other admin — is refused and writes nothing", async () => {
  const s = await makeOrg(true);
  const first = await start(db, s.orgId, s.admin, "pro");
  for (const [actor, plan] of [[s.admin, "pro"], [s.admin, "standard"], [s.admin2, "standard"]] as const) {
    const again = await start(db, s.orgId, actor, plan);
    assert.equal(again.started, false);
    assert.equal(again.refusal, "trial_used");
    assert.equal(String(again.trial_ends_at), String(first.trial_ends_at));
  }
  const facts = (await asService<Record<string, unknown>>(db, "SELECT * FROM app.b056_plan_facts($1)", [s.orgId]))[0];
  assert.equal(facts.trial_plan, "pro");
  assert.equal(await auditCount(s.orgId), 1);
});

test("MGT-96-AC4: two admins start at the same moment → exactly one trial and one audit", async () => {
  const s = await makeOrg(true);
  const a = await connect();
  const b = await connect();
  try {
    const results = await Promise.all([start(a, s.orgId, s.admin, "standard"), start(b, s.orgId, s.admin2, "pro")]);
    assert.deepEqual(results.map((r) => r.started).sort(), [false, true]);
    assert.equal(results.find((r) => !r.started)?.refusal, "trial_used");
    assert.equal(await auditCount(s.orgId), 1);
  } finally {
    await a.end();
    await b.end();
  }
});

test("MGT-96-AC2: managers, suspended admins, outsiders and admins of another org cannot start", async () => {
  const s = await makeOrg(true);
  const other = await makeOrg(true);
  for (const actor of [s.manager, s.suspendedAdmin, s.outsider, other.admin]) {
    await assert.rejects(start(db, s.orgId, actor, "standard"), /b056_forbidden/);
  }
  await assert.rejects(start(db, s.orgId, s.admin, "premium"), /b056_invalid_plan/);
  await assert.rejects(start(db, s.orgId, s.admin, ""), /b056_invalid_plan/);
  await assert.rejects(start(db, "00000000-0000-0000-0000-000000000000", s.admin, "standard"), /b056_forbidden/);
  assert.equal((await asService<{ trial_plan: string | null }>(db, "SELECT * FROM app.b056_plan_facts($1)", [s.orgId]))[0]?.trial_plan, null);
  assert.equal(await auditCount(s.orgId), 0);
});

test("OQ-B056-09: an org that is already paid (and never trialled) cannot start a trial", async () => {
  const s = await makeOrg(true);
  const req = (await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO pricing_apply_requests (org_id, user_id, company_name, phone, units, plan, status, paid_received_on)
     VALUES ($1, $2, 'synthetic', '0000', 1, 'standard', 'activated', current_date) RETURNING id, created_at`, [s.orgId, s.admin])).rows[0];
  await db.query(
    `INSERT INTO app.b056_org_trials (org_id, paid_plan, paid_activated_at, paid_apply_request_id, paid_request_created_at, paid_activated_by)
     VALUES ($1, 'standard', now(), $2, $3, $4)`, [s.orgId, req.id, req.created_at, s.admin]);
  const r = await start(db, s.orgId, s.admin, "pro");
  assert.deepEqual([r.started, r.refusal], [false, "paid"]);
  assert.equal(await auditCount(s.orgId), 0);
});

test("C-0 legacy row without a trial (never_trialled) may still start once", async () => {
  const s = await makeOrg(true);
  await db.query(`INSERT INTO app.b056_org_trials (org_id, legacy_class) VALUES ($1, 'never_trialled')`, [s.orgId]);
  const r = await start(db, s.orgId, s.admin, "standard");
  assert.equal(r.started, true);
  const a = (await db.query(`SELECT action::text, old_row->>'legacy_class' AS legacy FROM audit_log WHERE org_id = $1 AND table_name = 'b056_org_trials'`, [s.orgId])).rows;
  assert.deepEqual(a, [{ action: "update", legacy: "never_trialled" }]);
  assert.equal((await start(db, s.orgId, s.admin, "standard")).refusal, "trial_used");
});

test("OQ-B056-06: month-end clamp and time-zone independence of the end date", async () => {
  const cases: [string, string, string][] = [
    ["standard", "2026-11-30T01:00:00+08:00", "2027-02-28"],
    ["pro", "2026-08-31T12:00:00+08:00", "2027-02-28"],
    ["standard", "2027-11-30T09:00:00+08:00", "2028-02-29"],
    ["standard", "2026-11-30T23:30:00+08:00", "2027-02-28"], // 15:30 UTC: still 11/30 in Taipei
    ["standard", "2026-11-30T16:30:00Z", "2027-03-01"], // 00:30 Taipei on 12/01
    ["pro", "2026-01-15T00:00:00+08:00", "2026-07-15"],
  ];
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Taipei"]) {
    await db.query(`SET TIME ZONE '${tz}'`);
    try {
      for (const [plan, at, day] of cases) {
        const r = (await db.query<{ d: string; t: string }>(
          `SELECT to_char(e AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS d, to_char(e AT TIME ZONE 'Asia/Taipei', 'HH24:MI:SS') AS t
             FROM app.b056_trial_end($1, $2::timestamptz) e`, [plan, at])).rows[0];
        assert.deepEqual(r, { d: day, t: "00:00:00" }, `${plan} ${at} in ${tz}`);
      }
    } finally {
      await db.query("RESET TIME ZONE");
    }
  }
  await assert.rejects(db.query(`SELECT app.b056_trial_end('premium', now())`), /b056_invalid_plan/);
});

test("MGT-98-AC2: banner dismissal is per user; idempotent; staff of the org only; needs a trial", async () => {
  const s = await makeOrg(true);
  const dismiss = (user: string, kind: string) =>
    asService<{ d: boolean }>(db, "SELECT app.b056_dismiss_banner($1, $2, $3) AS d", [s.orgId, user, kind]).then((r) => r[0].d);
  const kinds = (user: string) =>
    asService<{ k: string[] }>(db, "SELECT app.b056_banner_dismissed_kinds($1, $2) AS k", [s.orgId, user]).then((r) => r[0].k);
  await assert.rejects(dismiss(s.admin, "d14"), /b056_no_trial/);
  await start(db, s.orgId, s.admin, "standard");
  assert.equal(await dismiss(s.admin, "d14"), true);
  assert.equal(await dismiss(s.admin, "d14"), false);
  assert.equal(await dismiss(s.manager, "d3"), true);
  assert.deepEqual(await kinds(s.admin), ["d14"]);
  assert.deepEqual(await kinds(s.admin2), []);
  assert.deepEqual(await kinds(s.manager), ["d3"]);
  await assert.rejects(dismiss(s.outsider, "d14"), /b056_forbidden/);
  await assert.rejects(dismiss(s.suspendedAdmin, "d14"), /b056_forbidden/);
  await assert.rejects(dismiss(s.admin, "d7"), /b056_invalid_banner/);
  const stored = (await db.query(`SELECT d.trial_ends_at = t.trial_ends_at AS same FROM app.b056_banner_dismissals d JOIN app.b056_org_trials t USING (org_id) WHERE d.org_id = $1`, [s.orgId])).rows;
  assert.ok(stored.length === 2 && stored.every((r) => r.same));
});

test("PR-1 boundary: no outbound, no change to existing tables, plan_tier or member_status", () => {
  const sql = MIGRATION.replace(/--.*$/gm, "");
  for (const banned of [/\bNOTIFY\b/i, /pg_notify/i, /\bnet\.http/i, /\bhttp_(get|post)\b/i, /ALTER\s+TABLE\s+(public\.)?(organizations|org_members|pricing_apply_requests|partner_codes)\b/i, /ALTER\s+TYPE/i, /\bDELETE\s+FROM\b/i, /\bDROP\b/i, /plan_tier/i, /UPDATE\s+public\.(organizations|org_members)/i]) {
    assert.doesNotMatch(sql, banned);
  }
  for (const word of ["房東", "房客", "收款", "收租"]) assert.equal(MIGRATION.includes(word), false);
});
