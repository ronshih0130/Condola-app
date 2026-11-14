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

// ---- Classified inventory (r3-final #4; Codex PR-3a r1 and r2) ----
// Every function in public/app that anon or authenticated can reach and that reads
// org_members must be listed below with its class, its counts and the md5 of its body. A new
// reader, a changed body, an extra active-membership test, dynamic SQL, or an inline membership
// check in a policy, view or column default fails the inventory until someone reviews it here.
//
// Reach is deliberately over-approximated:
//   roots = functions anon/authenticated can EXECUTE (direct, PUBLIC or inherited)
//         + every trigger function (a reachable definer function may write any table)
//         + every function named in a policy (USING or WITH CHECK), a view or a column default;
//   edges = a call to another public/app function, schema-qualified or not (an unqualified
//           name is resolved against both schemas whatever the caller's search_path is).
type Cls = "predicate" | "staff_exclusion" | "invariant" | "via_is_member" | "not_a_caller_grant";
type Entry = { cls: Cls; active: number; guarded: number; md5: string };
// active  = number of 'active' literals in the body (comments stripped);
// guarded = number of "status = 'active' AND NOT app.b056_member_paused(" tests.
const CLASSIFIED: Record<string, Entry> = {
  // predicate: every test that authorises the ACTING user carries the pause predicate
  "app.is_member(p_org uuid)": { cls: "predicate", active: 2, guarded: 2, md5: "d24486d16914fe4b7a4c8a9aab1fecf2" },
  "app.has_role(p_org uuid, p_roles org_role[])": { cls: "predicate", active: 1, guarded: 1, md5: "01a183769a07bf61f5d33c8c71024114" },
  "app.b008_capture_first_period(p_lease uuid, p_prorate boolean)": { cls: "predicate", active: 1, guarded: 1, md5: "a39ecdf50984eafcc439eb008f7e70b7" },
  "app.b010_confirmation_audit(p_payment uuid)": { cls: "predicate", active: 1, guarded: 1, md5: "db6337b21f0dc78010d4684c7c013ae3" },
  "app.b010_lock_payment_context(p_org uuid, p_live_org uuid, p_environment text, p_session uuid, p_lease uuid, p_role text)": { cls: "predicate", active: 2, guarded: 2, md5: "a2553378dcc73006ef5c7244cee31b67" },
  "app.b015_edit_context(p_org uuid, p_live uuid, p_env text, p_session uuid)": { cls: "predicate", active: 2, guarded: 2, md5: "ef52d8a0379f33de0cd22b89d5a9585e" },
  "app.b017_denied_orgs(p_floor text)": { cls: "predicate", active: 2, guarded: 2, md5: "e40aff661f306fbdeb2f6e6b2ce0e554" },
  "app.b017_effective(p_org uuid, p_user uuid)": { cls: "predicate", active: 1, guarded: 1, md5: "d6e41b74aabf7e2bc14e1bd62a430ad4" },
  "app.b017_invite_guard()": { cls: "predicate", active: 2, guarded: 2, md5: "44abf7792a3c83403d1e837635b8d120" },
  // 1 guarded actor test; the other two literals are NEW.status <> 'active' on the TARGET row
  // (billing-owner protection, grant ceiling), not a test of the acting user.
  "app.b017_member_guard()": { cls: "predicate", active: 3, guarded: 1, md5: "067d179c2ab16d313497a97d269436ae" },
  "app.b027_scope(p_org uuid, p_admin boolean)": { cls: "predicate", active: 1, guarded: 1, md5: "f5ebcacc67dc91f4ad72f962070a4076" },
  "public.esign_version_guard()": { cls: "predicate", active: 1, guarded: 1, md5: "15c662018bb15cd50837e26b38691999" },
  // staff_exclusion: membership is used only to EXCLUDE staff from owner/tenant paths, so a
  // paused member must stay excluded (adding the predicate would weaken these).
  "app.b027_any_org_member(p_org uuid)": { cls: "staff_exclusion", active: 0, guarded: 0, md5: "5766683c4c5d224dd73a07c49bbcf482" },
  "app.b022_my_owner_contact(p_org uuid)": { cls: "staff_exclusion", active: 1, guarded: 0, md5: "779efd07e0eadf8189561187b3887a6e" },
  "app.b022_reply_statement(p_statement uuid, p_owner_only boolean)": { cls: "staff_exclusion", active: 1, guarded: 0, md5: "b6a10112cc493a89186fcf34ab96af27" },
  // invariant: raises when no usable native admin would remain; grants nothing. It calls the
  // guarded app.b017_effective, so a paused admin does not count as usable.
  "app.b017_preserve_admin(p_org uuid)": { cls: "invariant", active: 2, guarded: 0, md5: "0576d01301056b01c6bc012ad8cc61c1" },
  // via_is_member: gated by app.is_member; the inline reads match ids only.
  "app.prop04_my_consent_records()": { cls: "via_is_member", active: 0, guarded: 0, md5: "149f1ab9d94cda1a25c762f9607056c0" },
  // not_a_caller_grant: reads org_members without authorising the acting user.
  "app.b017_member_admission()": { cls: "not_a_caller_grant", active: 0, guarded: 0, md5: "c022b78b4bb8f4a46fa205dfacf36d3c" }, // admission bookkeeping on the member row itself
  "app.b028_center_recipient_valid()": { cls: "not_a_caller_grant", active: 1, guarded: 0, md5: "ce85236ab0b94c8399d520ff22f1aa8d" }, // validates the RECIPIENT of a notification row
  "app.b056_member_paused(p_org uuid, p_user uuid)": { cls: "not_a_caller_grant", active: 1, guarded: 0, md5: "8051a593cf630c80e08c5b5f5a79828d" }, // the predicate itself (kept-member lookup)
  "public.fn_org_bootstrap()": { cls: "not_a_caller_grant", active: 1, guarded: 0, md5: "2a5e6484c926e1728b818b9aa20178e9" }, // inserts the creator's own row with the literal 'active'
};
// Reachable plpgsql functions that run dynamic SQL. Each was read: the statement is a fixed
// LOCK TABLE over regclass arguments and can call no function. Pinned, so a change re-opens it.
const DYNAMIC_SQL_REVIEWED: Record<string, string> = {
  "app.lock_tables_bounded(p_tables regclass[], p_mode text)": "d91a6cac864dc270114628401f7177e7",
  "app.lock_tables_nowait_retry(p_tables regclass[], p_mode text)": "d70bc58a5548db81e8abad1400c2f449",
};
// Policy / view / column-default expressions that read org_members inline. profiles_teammates
// is safe because its subquery runs as the querying user under org_members' own policies
// (pinned in ORG_MEMBERS_POLICIES): a paused user sees only their own row there, so the EXISTS
// can only be true for their own profile.
const INLINE_EXPR_REVIEWED: Record<string, string> = {
  "policy public.profiles.profiles_teammates": "942ba8d308ec3535c57874c6c8893ef5",
};
const ORG_MEMBERS_POLICIES = [
  "members_admin|ALL|app.has_role(org_id, '{admin}'::org_role[])|app.has_role(org_id, '{admin}'::org_role[])",
  "members_read|SELECT|(app.is_member(org_id) OR (user_id = auth.uid()))|",
];

const INVENTORY_SQL = String.raw`
WITH RECURSIVE fn AS (
  SELECT p.oid, n.nspname, p.proname, l.lanname,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS q, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname IN ('public', 'app')),
exprs AS (
  SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname AS src,
         coalesce(qual, '') || '|' || coalesce(with_check, '') AS txt FROM pg_policies
  UNION ALL
  SELECT 'view ' || schemaname || '.' || viewname, definition FROM pg_views WHERE schemaname IN ('public', 'app')
  UNION ALL
  SELECT 'default ' || d.adrelid::regclass || '.' || a.attname, pg_get_expr(d.adbin, d.adrelid)
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'app')),
roots AS (
  SELECT oid FROM fn WHERE has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE')
  UNION
  SELECT t.tgfoid FROM pg_trigger t JOIN fn ON fn.oid = t.tgfoid WHERE NOT t.tgisinternal
  UNION
  SELECT b.oid FROM exprs e JOIN fn b ON e.txt ~ ('(^|[^.\w])(' || b.nspname || '\.)?' || b.proname || '\s*\(')),
edges AS (
  SELECT a.oid AS src, b.oid AS dst FROM fn a JOIN fn b ON a.oid <> b.oid
   AND a.prosrc ~ ('(^|[^.\w])(' || b.nspname || '\.)?' || b.proname || '\s*\(')),
reach AS (
  SELECT oid FROM roots
  UNION
  SELECT e.dst FROM reach r JOIN edges e ON e.src = r.oid)
SELECT 'fn' AS kind, f.q AS name, f.lanname AS lang, md5(f.prosrc) AS md5, f.prosrc AS src
  FROM reach r JOIN fn f ON f.oid = r.oid
UNION ALL
SELECT 'expr', e.src, '', md5(e.txt), e.txt FROM exprs e WHERE e.txt ~* 'org_members'
ORDER BY 1, 2`;

const stripSqlComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Returns one line per problem; an empty list means the inventory holds. */
async function inventoryProblems(): Promise<string[]> {
  const rows = (await db.query<{ kind: string; name: string; lang: string; md5: string; src: string }>(INVENTORY_SQL)).rows;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.filter((x) => x.kind === "fn")) {
    const body = stripSqlComments(r.src);
    if (r.lang === "plpgsql" && /\bexecute\b/i.test(body) && DYNAMIC_SQL_REVIEWED[r.name] !== r.md5) {
      problems.push(`dynamic SQL not reviewed: ${r.name}`);
    }
    if (!/org_members/i.test(body)) continue;
    seen.add(r.name);
    const entry = CLASSIFIED[r.name];
    if (!entry) { problems.push(`unclassified org_members reader: ${r.name}`); continue; }
    const active = body.match(/'active'/g)?.length ?? 0;
    const guarded = body.match(/status\s*=\s*'active'\s+AND NOT app\.b056_member_paused\(/g)?.length ?? 0;
    if (r.md5 !== entry.md5) problems.push(`body changed since review: ${r.name}`);
    if (active !== entry.active || guarded !== entry.guarded) {
      problems.push(`active-membership tests changed: ${r.name} (active ${active}/${entry.active}, guarded ${guarded}/${entry.guarded})`);
    }
    if (entry.cls === "predicate" && guarded < 1) problems.push(`predicate missing: ${r.name}`);
    if (entry.cls === "staff_exclusion" && guarded !== 0) problems.push(`staff exclusion must not use the predicate: ${r.name}`);
    if (entry.cls === "via_is_member" && (!/app\.is_member\(/.test(body) || active !== 0)) problems.push(`must gate through app.is_member only: ${r.name}`);
  }
  for (const name of Object.keys(CLASSIFIED)) if (!seen.has(name)) problems.push(`classified but not found reachable: ${name}`);
  for (const r of rows.filter((x) => x.kind === "expr")) {
    if (INLINE_EXPR_REVIEWED[r.name] !== r.md5) problems.push(`inline org_members check not reviewed: ${r.name}`);
  }
  const memberPolicies = (await db.query<{ p: string }>(
    `SELECT policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') AS p
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_members' ORDER BY 1`)).rows.map((r) => r.p);
  if (JSON.stringify(memberPolicies) !== JSON.stringify(ORG_MEMBERS_POLICIES)) problems.push("org_members policies changed");
  const rls = (await db.query<{ ok: boolean }>(`SELECT relrowsecurity AS ok FROM pg_class WHERE oid = 'public.org_members'::regclass`)).rows[0].ok;
  if (!rls) problems.push("org_members RLS is off");
  const positive = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_policies
      WHERE (coalesce(qual, '') ~ 'b027_any_org_member' AND coalesce(qual, '') !~ 'NOT app\\.b027_any_org_member')
         OR (coalesce(with_check, '') ~ 'b027_any_org_member' AND coalesce(with_check, '') !~ 'NOT app\\.b027_any_org_member')`)).rows[0].n;
  if (positive !== 0) problems.push("b027_any_org_member is used un-negated in a policy");
  return problems;
}

test("inventory: every reachable org_members reader, dynamic statement and inline policy check is classified", async () => {
  assert.deepEqual(await inventoryProblems(), []);
  for (const [name, e] of Object.entries(CLASSIFIED)) {
    if (e.cls === "predicate") assert.ok(e.guarded >= 1, name);
    else assert.equal(e.guarded, 0, name);
  }
});

/** Runs fixture SQL in a transaction that is always rolled back, and returns the problems seen inside it. */
async function problemsWith(fixtureSql: string): Promise<string[]> {
  await db.query("BEGIN");
  try {
    await db.query(fixtureSql);
    return await inventoryProblems();
  } finally {
    await db.query("ROLLBACK");
  }
}
// A definer helper that grants on persisted active membership alone (no pause predicate),
// executable by nobody but its owner.
const PROBE_HELPER = `
  CREATE FUNCTION app.review_probe_helper(p_org uuid, p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT EXISTS (SELECT 1 FROM public.org_members z WHERE z.org_id = p_org AND z.user_id = p_user AND z.status = 'active') $f$;
  REVOKE ALL ON FUNCTION app.review_probe_helper(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;`;

test("inventory negative fixtures (Codex PR-3a r2): each omission class is caught, then rolled back", async () => {
  // 1. unqualified call resolved through the wrapper's search_path
  let p = await problemsWith(`${PROBE_HELPER}
    CREATE FUNCTION public.review_probe_wrapper(p_org uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $f$
    BEGIN RETURN review_probe_helper(p_org, auth.uid()); END $f$;
    GRANT EXECUTE ON FUNCTION public.review_probe_wrapper(uuid) TO authenticated;`);
  assert.deepEqual(p, ["unclassified org_members reader: app.review_probe_helper(p_org uuid, p_user uuid)"]);

  // 2. dynamic call: fails closed on the caller, whatever it builds
  p = await problemsWith(`${PROBE_HELPER}
    CREATE FUNCTION public.review_probe_dyn(p_org uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
    DECLARE r boolean;
    BEGIN EXECUTE format('SELECT %I.%I($1,$2)', 'app', 'review_probe_' || 'helper') INTO r USING p_org, auth.uid(); RETURN r; END $f$;
    GRANT EXECUTE ON FUNCTION public.review_probe_dyn(uuid) TO authenticated;`);
  assert.deepEqual(p, ["dynamic SQL not reviewed: public.review_probe_dyn(p_org uuid)"]);

  // 3. inline membership checks in a policy: USING and WITH CHECK
  p = await problemsWith(`
    CREATE POLICY review_probe_using ON public.profiles FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.org_members z WHERE z.user_id = auth.uid() AND z.status = 'active'));
    CREATE POLICY review_probe_check ON public.profiles FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.org_members z WHERE z.user_id = auth.uid() AND z.status::text = 'active'));`);
  assert.deepEqual(p, [
    "inline org_members check not reviewed: policy public.profiles.review_probe_check",
    "inline org_members check not reviewed: policy public.profiles.review_probe_using",
  ]);

  // 4. a helper reached only from a policy expression (not EXECUTE-granted to anyone)
  p = await problemsWith(`${PROBE_HELPER}
    CREATE POLICY review_probe_fn ON public.profiles FOR SELECT TO authenticated
      USING (app.review_probe_helper(id, auth.uid()));`);
  assert.deepEqual(p, ["unclassified org_members reader: app.review_probe_helper(p_org uuid, p_user uuid)"]);

  // 5. an extra unguarded active-membership test appended to a guarded function
  const scope = (await db.query<{ d: string }>(`SELECT pg_get_functiondef('app.b027_scope(uuid, boolean)'::regprocedure) AS d`)).rows[0].d;
  const needle = "AND (NOT p_admin OR m.role='admin'));";
  assert.equal(scope.split(needle).length, 2, "b027_scope body shape changed; update this fixture");
  p = await problemsWith(scope.replace(needle,
    `AND (NOT p_admin OR m.role='admin')) OR EXISTS (SELECT 1 FROM public.org_members z WHERE z.org_id = p_org AND z.user_id = auth.uid() AND z.status = 'active');`));
  assert.deepEqual(p, [
    "body changed since review: app.b027_scope(p_org uuid, p_admin boolean)",
    "active-membership tests changed: app.b027_scope(p_org uuid, p_admin boolean) (active 2/1, guarded 1/1)",
  ]);

  // 6. a cast spelling of the test in a new API-executable function
  p = await problemsWith(`
    CREATE FUNCTION public.review_probe_cast(p_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
      SELECT EXISTS (SELECT 1 FROM public.org_members z WHERE z.org_id = p_org AND z.user_id = auth.uid() AND z.status::text = ANY (ARRAY['active'])) $f$;
    GRANT EXECUTE ON FUNCTION public.review_probe_cast(uuid) TO authenticated;`);
  assert.deepEqual(p, ["unclassified org_members reader: public.review_probe_cast(p_org uuid)"]);

  // 7. a trigger function on a table the API roles cannot write (a definer function could)
  p = await problemsWith(`
    CREATE FUNCTION app.review_probe_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    BEGIN IF NOT EXISTS (SELECT 1 FROM public.org_members z WHERE z.user_id = auth.uid() AND z.status = 'active') THEN RAISE EXCEPTION 'no'; END IF; RETURN NEW; END $f$;
    REVOKE ALL ON FUNCTION app.review_probe_trg() FROM PUBLIC, anon, authenticated, service_role;
    CREATE TRIGGER review_probe_trg BEFORE INSERT ON public.esign_versions FOR EACH ROW EXECUTE FUNCTION app.review_probe_trg();`);
  assert.deepEqual(p, ["unclassified org_members reader: app.review_probe_trg()"]);

  // 8. a helper reached only from a view
  p = await problemsWith(`${PROBE_HELPER}
    CREATE VIEW public.review_probe_v AS SELECT o.id, app.review_probe_helper(o.id, auth.uid()) AS ok FROM public.organizations o;`);
  assert.deepEqual(p, ["unclassified org_members reader: app.review_probe_helper(p_org uuid, p_user uuid)"]);

  // every fixture was rolled back
  assert.deepEqual(await inventoryProblems(), []);
  assert.equal((await db.query(`SELECT 1 FROM pg_proc WHERE proname LIKE 'review\\_probe\\_%'`)).rowCount, 0);
});

test("the two actor checks surfaced in r3 refuse a paused admin and still accept the kept one", async () => {
  const o = await makeOrg();
  // esign void guard: the paused admin a2 is not "an active admin"; the kept admin a1 is.
  const src = (await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'public.esign_version_guard()'::regprocedure`)).rows[0].s;
  assert.match(src, /m\.role = 'admin' AND m\.status = 'active' AND NOT app\.b056_member_paused\(m\.org_id, m\.user_id\)/);
  const adminOk = async (userId: string) => (await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = $1 AND m.user_id = $2
        AND m.role = 'admin' AND m.status = 'active' AND NOT app.b056_member_paused(m.org_id, m.user_id)) AS ok`, [o.orgId, userId])).rows[0].ok;
  assert.equal(await adminOk(o.a1), true);
  assert.equal(await adminOk(o.a2), false);
  // app.b015_edit_context, called for real: signed in as each user with a live session of their own.
  const editContext = async (userId: string, orgId = o.orgId): Promise<string> => {
    await db.query("BEGIN");
    try {
      const session = (await db.query<{ id: string }>(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, md5(random()::text), now() + interval '1 hour') RETURNING id`, [userId])).rows[0].id;
      await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return (await db.query<{ actor_role: string }>(`SELECT actor_role FROM app.b015_edit_context($1, $1, 'live', $2)`, [orgId, session])).rows[0].actor_role;
    } finally {
      await db.query("ROLLBACK");
    }
  };
  const unavailable = (e: unknown) => (e as { code?: string; message?: string }).code === "42501" && /Directory operation unavailable/.test((e as Error).message);
  assert.equal(await editContext(o.a1), "admin");
  await assert.rejects(editContext(o.a2), unavailable, "paused admin");
  await assert.rejects(editContext(o.mgr), unavailable, "paused manager");
  // not paused while the trial still runs, or with the flag OFF for the org
  await db.query(`UPDATE app.b056_org_trials SET trial_ends_at = clock_timestamp() + interval '1 day' WHERE org_id = $1`, [o.orgId]);
  assert.equal(await editContext(o.a2), "admin");
  assert.equal(await editContext(o.mgr), "manager");
  const off = await makeOrg({ flagOn: false });
  assert.equal(await editContext(off.a2, off.orgId), "admin");
  // another org's admin is still refused here (membership, not the pause, decides that)
  await assert.rejects(editContext(off.a1, o.orgId), unavailable, "cross-org");
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
