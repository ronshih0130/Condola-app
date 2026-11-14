import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { tx } from "./db";
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

// Classified inventory of every function anon/authenticated can effectively EXECUTE whose body
// reads org_members (catalog has_function_privilege: direct, PUBLIC and inherited grants).
const PREDICATE_APPLIED = ["app.b010_confirmation_audit", "app.b010_lock_payment_context", "app.b017_denied_orgs", "app.has_role", "app.is_member"];
const STATUS_AGNOSTIC_DENY_ONLY = ["app.b027_any_org_member"]; // used only as NOT any_org_member
const VIA_IS_MEMBER = ["app.prop04_my_consent_records"]; // calls app.is_member; its inline read matches m.id/user only

test("inventory: every API-executable function that reads org_members is classified and carries the predicate", async () => {
  const rows = (await db.query<{ fn: string; src: string }>(
    `SELECT n.nspname || '.' || p.proname AS fn, p.prosrc AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'extensions')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
        AND p.prosrc ~* 'org_members'
      ORDER BY 1`)).rows;
  const known = new Set([...PREDICATE_APPLIED, ...STATUS_AGNOSTIC_DENY_ONLY, ...VIA_IS_MEMBER]);
  assert.deepEqual(rows.map((r) => r.fn).filter((f) => !known.has(f)), [], "unclassified inline-membership function");
  for (const r of rows) {
    const activeTests = r.src.match(/m\.status\s*=\s*'active'/g)?.length ?? 0;
    const guarded = r.src.match(/m\.status\s*=\s*'active'\s+AND NOT app\.b056_member_paused\(m\.org_id, m\.user_id\)/g)?.length ?? 0;
    if (PREDICATE_APPLIED.includes(r.fn)) {
      assert.ok(activeTests > 0, `${r.fn} lost its active-membership test`);
      assert.equal(guarded, activeTests, `${r.fn}: every m.status='active' test carries the pause predicate`);
    } else if (STATUS_AGNOSTIC_DENY_ONLY.includes(r.fn)) {
      assert.equal(/status/i.test(r.src), false, `${r.fn} became status-aware; reclassify it`);
    } else {
      assert.match(r.src, /app\.is_member\(/, `${r.fn} must gate through app.is_member`);
      assert.equal(activeTests, 0, `${r.fn} gained an inline active test; reclassify it`);
    }
  }
  const usage = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_policies WHERE qual ~ 'b027_any_org_member' AND qual !~ 'NOT app\\.b027_any_org_member'`)).rows[0].n;
  assert.equal(usage, 0, "b027_any_org_member is only ever used negated");
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
        await assert.rejects(db.query(`SELECT ${name(f.sig)}(${f.args})`),
          (e: { code?: string }) => e.code === "42501", `${role} → ${f.sig}`);
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
