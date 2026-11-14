import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { tx } from "./db";
import { FlowError } from "./errors";
import { resolveStaffOrg } from "./org-scope";
import { disposableDbUrl } from "./test-disposable-db";

// B-056 PR-3a: the pause predicate in SQL before materialisation (r3-final #4), the
// catalog-enumerated inline-membership inventory, attempted-call denial for every app.b056_*
// function (#139 GO fix-forward) and org FK ON DELETE RESTRICT. Stories: MGT-99-AC1, MGT-99-AC5.
// Synthetic orgs/users only; no outbound.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});
test.after(async () => {
  await setGlobalFlag(false);
  await db?.end();
});

async function setGlobalFlag(enabled: boolean) {
  await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{enabled}', to_jsonb($1::boolean)) WHERE key = 'pricing_trial'`, [enabled]);
}

type Org = { orgId: string; sandboxId: string; a1: string; a2: string; mgr: string; a1Member: string; a2Member: string };
let seq = 0;
/** Live org (+ linked sandbox) with admins a1 (earliest), a2 and a manager; flag ON for the org. */
async function makeOrg(opts: { flagOn?: boolean; endsInMs?: number | null } = {}): Promise<Org> {
  const flagOn = opts.flagOn ?? true;
  const tag = `b056p.${Date.now().toString(36)}.${seq++}`;
  const users = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     SELECT gen_random_uuid(), $1 || '.' || n || '@example.com', '{}'::jsonb, now(), 'authenticated', 'authenticated'
       FROM generate_series(1, 3) n ORDER BY n RETURNING id`, [tag])).rows.map((r) => r.id);
  const [a1, a2, mgr] = users;
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, feature_flags)
     VALUES ($1, 'TW', 'TWD', $2::jsonb) RETURNING id`,
    [tag, JSON.stringify(flagOn ? { pricing_trial: true } : {})])).rows[0].id;
  const sandboxId = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id)
     VALUES ($1 || ' sandbox', 'TW', 'TWD', 'sandbox', $2) RETURNING id`, [tag, orgId])).rows[0].id;
  const a1Member = (await db.query<{ id: string }>(
    `INSERT INTO org_members (org_id, user_id, role, status, created_at) VALUES ($1, $2, 'admin', 'active', now() - interval '3 days') RETURNING id`,
    [orgId, a1])).rows[0].id;
  const a2Member = (await db.query<{ id: string }>(
    `INSERT INTO org_members (org_id, user_id, role, status, created_at) VALUES ($1, $2, 'admin', 'active', now() - interval '2 days') RETURNING id`,
    [orgId, a2])).rows[0].id;
  await db.query(`INSERT INTO org_members (org_id, user_id, role, status, created_at) VALUES ($1, $2, 'manager', 'active', now() - interval '1 day')`, [orgId, mgr]);
  if (flagOn) {
    await db.query(
      `UPDATE platform_settings SET value = jsonb_build_object('enabled', true,
         'allowed_org_ids', coalesce(value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text))
       WHERE key = 'pricing_trial'`, [orgId]);
  }
  const endsInMs = opts.endsInMs === undefined ? -3_600_000 : opts.endsInMs;
  if (endsInMs !== null) {
    await db.query(
      `INSERT INTO app.b056_org_trials (org_id, trial_plan, trial_source, trial_started_at, trial_ends_at)
       VALUES ($1, 'standard', 'settings', now() - interval '15 days', clock_timestamp() + ($2::double precision * interval '1 millisecond'))`,
      [orgId, endsInMs]);
  }
  return { orgId, sandboxId, a1, a2, mgr, a1Member, a2Member };
}

/** app.is_member / app.has_role as the signed-in persona (tx() = authenticated, org pinned). */
async function access(userId: string, orgId: string, environment: "live" | "sandbox" = "live") {
  return tx(userId, async (c) => (await c.query<{ member: boolean; admin: boolean }>(
    `SELECT app.is_member($1) AS member, app.has_role($1, '{admin}') AS admin`, [orgId])).rows[0], { orgId, environment });
}
const paused = async (orgId: string, userId: string) =>
  (await db.query<{ p: boolean }>(`SELECT app.b056_member_paused($1, $2) AS p`, [orgId, userId])).rows[0].p;

test("trial ended: only the earliest-joined active admin keeps membership; others are paused", async () => {
  const o = await makeOrg();
  assert.deepEqual(await access(o.a1, o.orgId), { member: true, admin: true });
  assert.deepEqual(await access(o.a2, o.orgId), { member: false, admin: false });
  assert.deepEqual(await access(o.mgr, o.orgId), { member: false, admin: false });
  assert.deepEqual([await paused(o.orgId, o.a1), await paused(o.orgId, o.a2), await paused(o.orgId, o.mgr)], [false, true, true]);
});

test("before 00:00 Taipei of the end date nobody is paused; the boundary is trial_ends_at itself", async () => {
  const o = await makeOrg({ endsInMs: 86_400_000 });
  assert.deepEqual(await access(o.a2, o.orgId), { member: true, admin: true });
  assert.equal(await paused(o.orgId, o.mgr), false);
  await db.query(`UPDATE app.b056_org_trials SET trial_ends_at = clock_timestamp() WHERE org_id = $1`, [o.orgId]);
  assert.equal(await paused(o.orgId, o.mgr), true);
});

test("flag OFF (global or per org) makes the predicate a constant false and helpers unchanged", async () => {
  const o = await makeOrg();
  await setGlobalFlag(false);
  try {
    assert.equal(await paused(o.orgId, o.a2), false);
    assert.deepEqual(await access(o.a2, o.orgId), { member: true, admin: true });
  } finally {
    await setGlobalFlag(true);
  }
  await db.query(`UPDATE organizations SET feature_flags = '{}'::jsonb WHERE id = $1`, [o.orgId]);
  assert.equal(await paused(o.orgId, o.a2), false);
  assert.deepEqual(await access(o.mgr, o.orgId), { member: true, admin: false });
  const off = await makeOrg({ flagOn: false });
  assert.equal(await paused(off.orgId, off.a2), false);
});

test("no trial row, never_trialled row, or a paid plan: nobody is paused", async () => {
  const none = await makeOrg({ endsInMs: null });
  assert.equal(await paused(none.orgId, none.a2), false);
  await db.query(`INSERT INTO app.b056_org_trials (org_id, legacy_class) VALUES ($1, 'never_trialled')`, [none.orgId]);
  assert.equal(await paused(none.orgId, none.a2), false);
  const o = await makeOrg();
  assert.equal(await paused(o.orgId, o.a2), true);
  const req = (await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO pricing_apply_requests (org_id, user_id, company_name, phone, units, plan, status, paid_received_on)
     VALUES ($1, $2, 'synthetic', '0000', 1, 'standard', 'activated', current_date) RETURNING id, created_at`, [o.orgId, o.a1])).rows[0];
  await db.query(
    `UPDATE app.b056_org_trials SET paid_plan = 'standard', paid_activated_at = now(), paid_apply_request_id = $2,
       paid_request_created_at = $3, paid_activated_by = $4 WHERE org_id = $1`, [o.orgId, req.id, req.created_at, o.a1]);
  assert.equal(await paused(o.orgId, o.a2), false);
  assert.deepEqual(await access(o.mgr, o.orgId), { member: true, admin: false });
});

test("a persisted kept_member_id wins over the derived earliest admin", async () => {
  const o = await makeOrg();
  await db.query(`UPDATE app.b056_org_trials SET kept_member_id = $2 WHERE org_id = $1`, [o.orgId, o.a2Member]);
  assert.deepEqual([await paused(o.orgId, o.a1), await paused(o.orgId, o.a2)], [true, false]);
  assert.deepEqual(await access(o.a1, o.orgId), { member: false, admin: false });
  // the kept member must belong to the same org (composite FK)
  const other = await makeOrg();
  await assert.rejects(
    db.query(`UPDATE app.b056_org_trials SET kept_member_id = $2 WHERE org_id = $1`, [other.orgId, o.a1Member]),
    (e: { code?: string }) => e.code === "23503");
});

test("the live-org pause applies inside the linked sandbox", async () => {
  const o = await makeOrg();
  assert.deepEqual(await access(o.a1, o.sandboxId, "sandbox"), { member: true, admin: true });
  assert.deepEqual(await access(o.a2, o.sandboxId, "sandbox"), { member: false, admin: false });
  // a sandbox-only membership row does not escape the live-org pause
  await db.query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [o.sandboxId, o.mgr]);
  assert.deepEqual(await access(o.mgr, o.sandboxId, "sandbox"), { member: false, admin: false });
  assert.equal(await paused(o.sandboxId, o.a1), false);
});

test("session resolution (resolveStaffOrg) drops a paused membership on the next request", async () => {
  const o = await makeOrg();
  assert.equal((await resolveStaffOrg(db, o.a1, o.orgId, null))?.orgId, o.orgId);
  assert.equal(await resolveStaffOrg(db, o.a2, o.orgId, null), null);
  assert.equal(await resolveStaffOrg(db, o.mgr, o.orgId, null), null);
  await db.query(`UPDATE app.b056_org_trials SET trial_ends_at = clock_timestamp() + interval '1 day' WHERE org_id = $1`, [o.orgId]);
  assert.equal((await resolveStaffOrg(db, o.mgr, o.orgId, null))?.orgId, o.orgId);
});

test("persisted status remains authoritative: a suspended kept admin is not resurrected", async () => {
  const o = await makeOrg();
  await db.query(`UPDATE org_members SET status = 'suspended' WHERE id = $1`, [o.a1Member]);
  // a1 is suspended, so the earliest ACTIVE admin (a2) is now the kept one
  assert.deepEqual(await access(o.a1, o.orgId), { member: false, admin: false });
  assert.deepEqual(await access(o.a2, o.orgId), { member: true, admin: true });
});

// Classified inventory (r3-final #4, Codex PR-3a r1): every function that anon/authenticated
// can effectively EXECUTE (direct, PUBLIC, inherited) or reach — through calls from those
// functions or from triggers on tables those roles can write — and whose body reads
// org_members. Expected guarded counts are per function, so any new inline check fails here.
const PREDICATE_APPLIED: Record<string, number> = {
  "app.is_member": 2, "app.has_role": 1, "app.b010_confirmation_audit": 1, "app.b010_lock_payment_context": 2,
  "app.b017_denied_orgs": 2, "app.b008_capture_first_period": 1, "app.b017_effective": 1,
  "app.b017_invite_guard": 2, "app.b017_member_guard": 1, "app.b027_scope": 1,
};
// Membership used only to EXCLUDE staff from owner/tenant paths: a paused member stays excluded.
const STAFF_EXCLUSION_ONLY = ["app.b027_any_org_member", "app.b022_my_owner_contact", "app.b022_reply_statement"];
// Last-usable-native-admin invariant (raises when none would remain); not an access grant.
const INVARIANT_ONLY = ["app.b017_preserve_admin"];
// Gate through app.is_member; their inline reads match m.id/user only.
const VIA_IS_MEMBER = ["app.prop04_my_consent_records"];
// No active-membership test of their own (lock, bootstrap, read-only lookups), or the predicate itself.
const NO_ACTIVE_TEST_OK = (src: string) => !/status\s*=\s*'active'/i.test(src);

const REACHABLE_SQL = `
WITH RECURSIVE fn AS (
  SELECT p.oid, n.nspname, p.proname, n.nspname || '.' || p.proname AS q, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'app')),
roots AS (
  SELECT oid FROM fn WHERE has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE')
  UNION
  SELECT t.tgfoid FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND (
     has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('authenticated', c.oid, 'DELETE')
     OR has_table_privilege('anon', c.oid, 'INSERT') OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'))),
edges AS (
  SELECT a.oid AS src, b.oid AS dst FROM fn a JOIN fn b ON a.oid <> b.oid
   AND (a.prosrc ~ ('\\m' || b.nspname || '\\.' || b.proname || '\\s*\\(')
        OR (b.nspname = 'public' AND a.prosrc ~ ('(^|[^.\\w])' || b.proname || '\\s*\\(')))),
reach AS (
  SELECT oid FROM roots
  UNION
  SELECT e.dst FROM reach r JOIN edges e ON e.src = r.oid)
SELECT DISTINCT f.q AS fn, f.prosrc AS src FROM reach r JOIN fn f ON f.oid = r.oid
 WHERE f.prosrc ~* 'org_members' ORDER BY 1`;

test("inventory: every API-reachable function that reads org_members is classified and carries the predicate", async () => {
  const rows = (await db.query<{ fn: string; src: string }>(REACHABLE_SQL)).rows;
  const fns = rows.map((r) => r.fn);
  for (const f of [...Object.keys(PREDICATE_APPLIED), "app.b027_scope", "app.b017_effective"]) assert.ok(fns.includes(f), `${f} not found reachable`);
  const known = new Set([...Object.keys(PREDICATE_APPLIED), ...STAFF_EXCLUSION_ONLY, ...INVARIANT_ONLY, ...VIA_IS_MEMBER, "app.b056_member_paused"]);
  const unclassified = rows.filter((r) => !known.has(r.fn) && !NO_ACTIVE_TEST_OK(r.src)).map((r) => r.fn);
  assert.deepEqual(unclassified, [], "unclassified API-reachable inline active-membership function");
  for (const r of rows) {
    const guarded = r.src.match(/status\s*=\s*'active'\s+AND NOT app\.b056_member_paused\(/g)?.length ?? 0;
    if (r.fn in PREDICATE_APPLIED) {
      assert.equal(guarded, PREDICATE_APPLIED[r.fn], `${r.fn}: guarded active-membership tests`);
    } else if (VIA_IS_MEMBER.includes(r.fn)) {
      assert.match(r.src, /app\.is_member\(/, `${r.fn} must gate through app.is_member`);
      assert.equal(/status\s*=\s*'active'/i.test(r.src), false, `${r.fn} gained an inline active test; reclassify it`);
    } else if (STAFF_EXCLUSION_ONLY.includes(r.fn)) {
      assert.equal(guarded, 0, `${r.fn} must not treat a paused member as non-staff`);
    }
  }
  const usage = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_policies WHERE qual ~ 'b027_any_org_member' AND qual !~ 'NOT app\\.b027_any_org_member'`)).rows[0].n;
  assert.equal(usage, 0, "b027_any_org_member is only ever used negated");
});

test("indirect paths: a paused member is refused by b027_read_controls and gets no b017 permissions", async () => {
  const o = await makeOrg();
  const read = (userId: string) => tx(userId, async (c) => (await c.query(`SELECT app.b027_read_controls($1) AS r`, [o.orgId])).rows[0].r, { orgId: o.orgId, environment: "live" });
  assert.ok(await read(o.a1));
  // tx() maps the function's 42501 to FlowError errors.forbidden
  const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
  await assert.rejects(read(o.a2), forbidden);
  await assert.rejects(read(o.mgr), forbidden);
  const eff = async (userId: string) => (await db.query<{ e: string[] | null }>(`SELECT app.b017_effective($1, $2) AS e`, [o.orgId, userId])).rows[0].e;
  assert.notEqual(await eff(o.a1), null);
  assert.equal(await eff(o.a2), null);
  assert.equal(await eff(o.mgr), null);
});

test("C-0 legacy trial_used_not_paid org: non-kept members are paused once the flag is ON", async () => {
  const o = await makeOrg({ endsInMs: null });
  await db.query(
    `INSERT INTO app.b056_org_trials (org_id, trial_plan, trial_source, trial_ends_at, legacy_class)
     VALUES ($1, 'standard', 'legacy', now() - interval '30 days', 'trial_used_not_paid')`, [o.orgId]);
  assert.deepEqual([await paused(o.orgId, o.a1), await paused(o.orgId, o.a2), await paused(o.orgId, o.mgr)], [false, true, true]);
});

test("app.b056_member_paused is definer-only, pinned and non-recursive", async () => {
  const f = (await db.query<{ secdef: boolean; config: string[]; src: string; vol: string }>(
    `SELECT prosecdef AS secdef, proconfig AS config, prosrc AS src, provolatile AS vol FROM pg_proc WHERE oid = 'app.b056_member_paused(uuid,uuid)'::regprocedure`)).rows[0];
  assert.equal(f.secdef, true);
  assert.deepEqual(f.config, ["search_path=pg_catalog, pg_temp"]);
  assert.equal(/is_member|has_role|b017_|current_member|auth\.uid/.test(f.src), false, "no call back into RLS helpers");
  const grants = (await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
    `SELECT has_function_privilege('anon', 'app.b056_member_paused(uuid,uuid)', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'app.b056_member_paused(uuid,uuid)', 'EXECUTE') AS auth,
            has_function_privilege('service_role', 'app.b056_member_paused(uuid,uuid)', 'EXECUTE') AS svc`)).rows[0];
  assert.deepEqual(grants, { anon: false, auth: false, svc: true });
});

test("attempted calls: anon and authenticated calling any app.b056_* function get permission denied", async () => {
  const fns = (await db.query<{ sig: string; args: string }>(
    `SELECT p.oid::regprocedure::text AS sig,
            coalesce((SELECT string_agg('NULL::' || format_type(t, NULL), ', ' ORDER BY i)
                        FROM unnest(p.proargtypes) WITH ORDINALITY AS a(t, i)), '') AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname LIKE 'b056\\_%' ORDER BY 1`)).rows;
  assert.ok(fns.length >= 6, "expected the B-056 function set");
  const name = (sig: string) => sig.slice(0, sig.indexOf("("));
  for (const role of ["anon", "authenticated"]) {
    for (const f of fns) {
      await db.query("BEGIN");
      try {
        await db.query(`SELECT set_config('request.jwt.claim.sub', gen_random_uuid()::text, true)`);
        await db.query(`SET LOCAL ROLE ${role}`);
        // ACL denial (function EXECUTE, or schema USAGE for anon), not an exception raised inside the
        // function (e.g. classify_legacy raises 42501 for a missing org)
        await assert.rejects(db.query(`SELECT ${name(f.sig)}(${f.args})`),
          (e: { code?: string; message?: string }) => e.code === "42501" && /^permission denied for (function|schema) /.test(e.message ?? ""), `${role} → ${f.sig}`);
      } finally {
        await db.query("ROLLBACK");
      }
    }
  }
});

test("#139 fix-forward: deleting an org that has B-056 trial facts is refused (ON DELETE RESTRICT)", async () => {
  const o = await makeOrg();
  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM organizations WHERE id = $1`, [o.sandboxId]);
    await db.query("SAVEPOINT d");
    await assert.rejects(db.query(`DELETE FROM organizations WHERE id = $1`, [o.orgId]),
      (e: { code?: string; constraint?: string }) => e.code === "23503" && e.constraint === "b056_org_trials_org_id_fkey");
    await db.query("ROLLBACK TO d");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.b056_org_trials WHERE org_id = $1`, [o.orgId])).rows[0].n, 1);
  } finally {
    await db.query("ROLLBACK");
  }
  const fk = (await db.query<{ action: string }>(
    `SELECT confdeltype AS action FROM pg_constraint WHERE conname = 'b056_org_trials_org_id_fkey' AND conrelid = 'app.b056_org_trials'::regclass`)).rows[0];
  assert.equal(fk.action, "r");
});
