import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";

// B-042 PR-1 (narrowed) schema. Stories: MGT-36-AC5, MGT-44-AC1 (Ron 01:34 PT: only share /
// copy / QR / print count). Synthetic data only. room_type 'unspecified' ships in PR-4a.
// Fix-forward from the CEO GO on PR-1 (20261114100000_b042_fix_forward.sql): the session pin is
// required, today_dash requires today_home, and anon / authenticated calls are denied.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const MIGRATION = readFileSync(new URL("../../supabase/migrations/20261113220000_b042_today_home_schema.sql", import.meta.url), "utf8");
const FIX_FORWARD = readFileSync(new URL("../../supabase/migrations/20261114100000_b042_fix_forward.sql", import.meta.url), "utf8");
const FUNCTIONS = [
  "app.b042_flag_on(text, uuid)",
  "app.b042_session_pin_ok(uuid)",
  "app.b042_record_first_login(uuid, uuid)",
  "app.b042_first_login_seen(uuid, uuid)",
  "app.b042_record_invite_share(uuid, uuid, text, uuid, text)",
  "app.b042_org_invite_shared(uuid)",
];
const TABLES = ["app.b042_first_logins", "app.b042_invite_shares"];

let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db?.end(); });

let seq = 0;
async function makeOrg(flagOn: boolean) {
  const tag = `b042.${Date.now().toString(36)}.${seq++}`;
  const [admin, manager, accountant, outsider] = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
     SELECT gen_random_uuid(), $1 || '.' || n || '@example.com', '{}'::jsonb, now(), 'authenticated', 'authenticated'
       FROM generate_series(1, 4) n RETURNING id`, [tag])).rows.map((r) => r.id);
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, feature_flags)
     VALUES ($1, 'TW', 'TWD', $2::jsonb) RETURNING id`,
    [tag, JSON.stringify(flagOn ? { today_home: true } : {})])).rows[0].id;
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'manager', 'active'), ($1, $4, 'accountant', 'active')`,
    [orgId, admin, manager, accountant]);
  if (flagOn) {
    await db.query(`UPDATE platform_settings SET value = jsonb_build_object('enabled', true,
       'allowed_org_ids', coalesce(value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($1::text)) WHERE key = 'today_home'`, [orgId]);
  }
  const prop = (await db.query<{ id: string }>(
    `INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei') RETURNING id`, [orgId, `${tag}-p`])).rows[0].id;
  const unit = (await db.query<{ id: string }>(`INSERT INTO units (org_id, property_id, label) VALUES ($1, $2, '1F') RETURNING id`, [orgId, prop])).rows[0].id;
  return { orgId, admin, manager, accountant, outsider, unit, prop };
}
let unitSeq = 0;
const newUnit = async (orgId: string, prop: string) =>
  (await db.query<{ id: string }>(`INSERT INTO units (org_id, property_id, label) VALUES ($1, $2, $3) RETURNING id`, [orgId, prop, `U${unitSeq++}`])).rows[0].id;
async function secret(orgId: string, unitId: string, opts: { revoked?: boolean; expired?: boolean } = {}) {
  return (await db.query<{ id: string }>(
    `INSERT INTO app.unit_invite_secrets (org_id, unit_id, token_hash, expires_at, revoked_at)
     VALUES ($1, $2, md5(random()::text), now() + CASE WHEN $3 THEN interval '-1 day' ELSE interval '14 days' END, CASE WHEN $4 THEN now() END) RETURNING id`,
    [orgId, unitId, !!opts.expired, !!opts.revoked])).rows[0].id;
}
type Pin = { env?: string; org?: string };
async function asService<T>(sql: string, params: unknown[] = [], pin?: Pin): Promise<T[]> {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE service_role");
    if (pin?.env !== undefined) await db.query(`SELECT set_config('app.env', $1, true)`, [pin.env]);
    if (pin?.org !== undefined) await db.query(`SELECT set_config('app.active_org_id', $1, true)`, [pin.org]);
    const r = await db.query(sql, params);
    await db.query("COMMIT");
    return r.rows as T[];
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
// Recorders run pinned to the live org, as pinOrg does in the app. Pass a pin to override; {} = no pin.
const livePin = (orgId: string): Pin => ({ env: "live", org: orgId });
const share = (o: { orgId: string }, actor: string, sec: string, channel = "copy", kind = "unit", pin: Pin = livePin(o.orgId)) =>
  asService<{ r: boolean }>("SELECT app.b042_record_invite_share($1,$2,$3,$4,$5) AS r", [o.orgId, actor, kind, sec, channel], pin).then((x) => x[0].r);
const shared = (orgId: string) => asService<{ r: boolean }>("SELECT app.b042_org_invite_shared($1) AS r", [orgId]).then((x) => x[0].r);

test("PR-1: flags seeded OFF; tables definer-only; EXECUTE service_role only; room_type unchanged", async () => {
  assert.match(MIGRATION, /'today_home', '\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb/);
  assert.match(MIGRATION, /'today_dash', '\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb/);
  const values = (await db.query<{ v: string }>(`SELECT unnest(enum_range(NULL::room_type))::text AS v`)).rows.map((r) => r.v);
  assert.equal(values.includes("unspecified"), false, "the enum value ships with PR-4a and its readers");
  for (const t of TABLES) {
    const r = (await db.query(`SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = $1::regclass`, [t])).rows[0];
    assert.deepEqual(r, { rls: true, force: true }, t);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        assert.equal((await db.query(`SELECT has_table_privilege($1, $2, $3) AS h`, [role, t, p])).rows[0].h, false, `${role} ${p} ${t}`);
      }
    }
  }
  for (const f of FUNCTIONS) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS h`, [role, f])).rows[0].h, false, `${role} ${f}`);
    }
    assert.equal((await db.query(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS h`, [f])).rows[0].h, true, f);
    const cfg = (await db.query(`SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [f])).rows[0].proconfig ?? [];
    assert.ok(cfg.includes("search_path=pg_catalog, pg_temp"), f);
  }
});

test("flag gate: OFF / not allowlisted / org flag missing / mixed allowlist → recorders refuse, readers false", async () => {
  const off = await makeOrg(false);
  const sec = await secret(off.orgId, off.unit);
  await assert.rejects(share(off, off.admin, sec), /b042_disabled/);
  await assert.rejects(asService("SELECT app.b042_record_first_login($1,$2)", [off.orgId, off.admin], livePin(off.orgId)), /b042_disabled/);
  assert.equal(await shared(off.orgId), false);
  // org flag on, not allowlisted (another org keeps the global switch on)
  await makeOrg(true);
  await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_home":true}' WHERE id = $1`, [off.orgId]);
  assert.equal((await asService<{ r: boolean }>("SELECT app.b042_flag_on('today_home', $1) AS r", [off.orgId]))[0].r, false);
  // unknown key is never on
  assert.equal((await asService<{ r: boolean }>("SELECT app.b042_flag_on('pricing_trial', $1) AS r", [off.orgId]))[0].r, false);
  // mixed-type allowlist admits nobody
  const on = await makeOrg(true);
  const before = (await db.query(`SELECT value FROM platform_settings WHERE key = 'today_home'`)).rows[0].value;
  await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{allowed_org_ids}', (value->'allowed_org_ids') || '[1]'::jsonb) WHERE key = 'today_home'`);
  try {
    assert.equal((await asService<{ r: boolean }>("SELECT app.b042_flag_on('today_home', $1) AS r", [on.orgId]))[0].r, false);
  } finally {
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'today_home'`, [before]);
  }
  assert.equal((await asService<{ r: boolean }>("SELECT app.b042_flag_on('today_home', $1) AS r", [on.orgId]))[0].r, true);
});

test("MGT-36-AC5: first sign-in recorded once per user per live org; members only; sandbox refused", async () => {
  const o = await makeOrg(true);
  const rec = (u: string, org = o.orgId) => asService<{ r: boolean }>("SELECT app.b042_record_first_login($1,$2) AS r", [org, u], livePin(org)).then((x) => x[0].r);
  const seen = (u: string) => asService<{ r: boolean }>("SELECT app.b042_first_login_seen($1,$2) AS r", [o.orgId, u]).then((x) => x[0].r);
  assert.equal(await seen(o.manager), false);
  assert.equal(await rec(o.manager), true);
  assert.equal(await rec(o.manager), false);
  assert.equal(await seen(o.manager), true);
  assert.equal(await seen(o.admin), false);
  await assert.rejects(rec(o.outsider), /b042_forbidden/);
  // a sandbox org of this live firm, with the same admin as an active member: refused even with the flag on
  const sbOrg = (await db.query<{ id: string }>(
    `INSERT INTO organizations (name, country_code, default_currency, environment, live_org_id, feature_flags)
     VALUES ('b042 sandbox', 'TW', 'TWD', 'sandbox', $1, '{"today_home":true}'::jsonb) RETURNING id`, [o.orgId])).rows[0].id;
  await db.query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [sbOrg, o.admin]);
  await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{allowed_org_ids}', (value->'allowed_org_ids') || jsonb_build_array($1::text)) WHERE key = 'today_home'`, [sbOrg]);
  const sb = { org_id: sbOrg, user_id: o.admin };
  await assert.rejects(rec(sb.user_id, sb.org_id), /b042_forbidden/);
});

test("MGT-44-AC1: a share/copy/QR/print of a live invite by admin or manager counts once per channel", async () => {
  const o = await makeOrg(true);
  const sec = await secret(o.orgId, o.unit);
  assert.equal(await shared(o.orgId), false);
  assert.equal(await share(o, o.manager, sec, "copy"), true);
  assert.equal(await share(o, o.admin, sec, "copy"), false);
  for (const c of ["line", "qr", "print"]) assert.equal(await share(o, o.admin, sec, c), true);
  assert.equal(await shared(o.orgId), true);
  assert.equal(Number((await db.query(`SELECT count(*) FROM app.b042_invite_shares WHERE org_id = $1`, [o.orgId])).rows[0].count), 4);
});

test("MGT-44-AC1 refusals: wrong role, outsider, other org's secret, revoked/expired secret, room kind, open/unknown channel", async () => {
  const o = await makeOrg(true);
  const other = await makeOrg(true);
  const sec = await secret(o.orgId, o.unit);
  await assert.rejects(share(o, o.accountant, sec), /b042_forbidden/);
  await assert.rejects(share(o, o.outsider, sec), /b042_forbidden/);
  await assert.rejects(share(o, other.admin, sec), /b042_forbidden/);
  await assert.rejects(share(other, other.admin, sec), /b042_not_found/);
  await assert.rejects(share(o, o.admin, await secret(o.orgId, await newUnit(o.orgId, o.prop), { revoked: true })), /b042_not_found/);
  await assert.rejects(share(o, o.admin, await secret(o.orgId, await newUnit(o.orgId, o.prop), { expired: true })), /b042_not_found/);
  await assert.rejects(share(o, o.admin, sec, "copy", "room"), /b042_invalid_target/);
  for (const c of ["open", "email", "", "LINE"]) await assert.rejects(share(o, o.admin, sec, c), /b042_invalid_channel/);
  assert.equal(await shared(o.orgId), false);
});

test("PR-1 boundary: no outbound, no change to B-040/B-028/funnel/existing tables, no deletes", () => {
  const sql = MIGRATION.replace(/--.*$/gm, "");
  for (const banned of [/ALTER\s+TYPE/i, /\bNOTIFY\b/i, /pg_notify/i, /\bnet\.http/i, /ALTER\s+TABLE\s+(public\.|app\.)?(organizations|properties|units|rooms|org_members|unit_invite_secrets|unit_bindings|funnel_events|usage_events|b028_)/i, /\bDELETE\s+FROM\b/i, /\bDROP\b/i, /CREATE\s+OR\s+REPLACE/i]) {
    assert.doesNotMatch(sql, banned);
  }
  for (const word of ["房東", "房客", "收款", "收租"]) assert.equal(MIGRATION.includes(word), false);
});

test("Codex PR-1 r1: sample data never counts — sample unit, sample property, sample secret, sample member", async () => {
  const o = await makeOrg(true);
  const mark = (table: string, id: string) => db.query(`INSERT INTO sample_marks (org_id, entity_table, entity_id) VALUES ($1, $2, $3)`, [o.orgId, table, id]);
  const u1 = await newUnit(o.orgId, o.prop);
  await mark("units", u1);
  await assert.rejects(share(o, o.admin, await secret(o.orgId, u1)), /b042_sample/);
  const p2 = (await db.query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone) VALUES ($1, 'sample-p', 'TW', 'TWD', 'Asia/Taipei') RETURNING id`, [o.orgId])).rows[0].id;
  await mark("properties", p2);
  await assert.rejects(share(o, o.admin, await secret(o.orgId, await newUnit(o.orgId, p2))), /b042_sample/);
  const s3 = await secret(o.orgId, await newUnit(o.orgId, o.prop));
  await mark("unit_invite_secrets", s3);
  await assert.rejects(share(o, o.admin, s3), /b042_sample/);
  assert.equal(await shared(o.orgId), false);
  const memberId = (await db.query(`SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.manager])).rows[0].id;
  await mark("org_members", memberId);
  await assert.rejects(asService("SELECT app.b042_record_first_login($1,$2)", [o.orgId, o.manager], livePin(o.orgId)), /b042_forbidden/);
  await assert.rejects(share(o, o.manager, await secret(o.orgId, await newUnit(o.orgId, o.prop))), /b042_forbidden/);
});

test("Codex PR-1 r1: a transaction pinned to sandbox or to another org cannot record for this live org", async () => {
  const o = await makeOrg(true);
  const other = await makeOrg(true);
  const sec = await secret(o.orgId, o.unit);
  await assert.rejects(share(o, o.admin, sec, "copy", "unit", { env: "sandbox", org: o.orgId }), /b042_forbidden/);
  await assert.rejects(share(o, o.admin, sec, "copy", "unit", { env: "live", org: other.orgId }), /b042_forbidden/);
  await assert.rejects(asService("SELECT app.b042_record_first_login($1,$2)", [o.orgId, o.admin], { env: "sandbox", org: o.orgId }), /b042_forbidden/);
  await assert.rejects(asService("SELECT app.b042_record_first_login($1,$2)", [o.orgId, o.admin], { env: "live", org: other.orgId }), /b042_forbidden/);
  assert.equal(await shared(o.orgId), false);
  // pinned to this live org: allowed
  assert.equal(await share(o, o.admin, sec, "copy", "unit", { env: "live", org: o.orgId }), true);
});

// ---- Fix-forward (CEO GO on #143; B-042-design-r3-final.md "Fix-forward carried into PR-4a") ----

test("fix-forward: the migration replaces two functions only — no table, policy, enum or flag change", () => {
  assert.equal((FIX_FORWARD.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
  assert.match(FIX_FORWARD, /CREATE OR REPLACE FUNCTION app\.b042_flag_on\(p_key text, p_org uuid\) RETURNS boolean/);
  assert.match(FIX_FORWARD, /CREATE OR REPLACE FUNCTION app\.b042_session_pin_ok\(p_org uuid\) RETURNS boolean/);
  const code = FIX_FORWARD.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /CREATE TABLE|ALTER TABLE|DROP |DELETE |TRUNCATE|CREATE POLICY|ALTER TYPE|INSERT INTO|UPDATE /i);
  assert.doesNotMatch(code, /unspecified/);
  assert.doesNotMatch(code, /GRANT [^;]*\b(anon|authenticated|PUBLIC)\b/i);
});

test("fix-forward 1: the session pin is required — no pin, half a pin or an empty pin is refused", async () => {
  const o = await makeOrg(true);
  const sec = await secret(o.orgId, o.unit);
  const first = (pin: Pin) => asService<{ r: boolean }>("SELECT app.b042_record_first_login($1,$2) AS r", [o.orgId, o.admin], pin);
  const pins: Pin[] = [{}, { env: "live" }, { org: o.orgId }, { env: "", org: o.orgId }, { env: "live", org: "" }, { env: "LIVE", org: o.orgId }];
  for (const pin of pins) {
    await assert.rejects(share(o, o.admin, sec, "copy", "unit", pin), /b042_forbidden/, JSON.stringify(pin));
    await assert.rejects(first(pin), /b042_forbidden/, JSON.stringify(pin));
  }
  assert.equal(await shared(o.orgId), false);
  assert.equal(Number((await db.query(`SELECT count(*) FROM app.b042_first_logins WHERE org_id = $1`, [o.orgId])).rows[0].count), 0);
  // the helper itself never returns NULL (a NULL would slip past "IF NOT ...")
  const ok = (org: string | null, pin: Pin) =>
    asService<{ r: boolean | null }>("SELECT app.b042_session_pin_ok($1::uuid) AS r", [org], pin).then((x) => x[0].r);
  assert.equal(await ok(o.orgId, {}), false);
  assert.equal(await ok(null, livePin(o.orgId)), false);
  assert.equal(await ok(o.orgId, { env: "sandbox", org: o.orgId }), false);
  assert.equal(await ok(o.orgId, livePin(o.orgId)), true);
  // pinned to this live org: both recorders work
  assert.equal((await first(livePin(o.orgId)))[0].r, true);
  assert.equal(await share(o, o.admin, sec), true);
});

test("fix-forward 2: today_dash is on only when today_home is also on for the org", async () => {
  const on = (key: string | null, org: string | null) =>
    asService<{ r: boolean | null }>("SELECT app.b042_flag_on($1, $2::uuid) AS r", [key, org]).then((x) => x[0].r);
  const dashBefore = (await db.query(`SELECT value FROM platform_settings WHERE key = 'today_dash'`)).rows[0].value;
  const homeBefore = (await db.query(`SELECT value FROM platform_settings WHERE key = 'today_home'`)).rows[0].value;
  const o = await makeOrg(true); // today_home fully on for this org
  const dashOnly = await makeOrg(false); // will get today_dash everywhere, today_home nowhere
  try {
    await db.query(`UPDATE platform_settings SET value = jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text, $2::text)) WHERE key = 'today_dash'`, [o.orgId, dashOnly.orgId]);
    // home on, dash allowlisted but the org flag is missing → dash off
    assert.equal(await on("today_home", o.orgId), true);
    assert.equal(await on("today_dash", o.orgId), false);
    await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_dash":true}' WHERE id = ANY($1::uuid[])`, [[o.orgId, dashOnly.orgId]]);
    assert.equal(await on("today_dash", o.orgId), true);
    // dash fully on, home missing at every layer → dash off
    assert.equal(await on("today_home", dashOnly.orgId), false);
    assert.equal(await on("today_dash", dashOnly.orgId), false);
    // home org flag on but home not allowlisted for this org → still off
    await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_home":true}' WHERE id = $1`, [dashOnly.orgId]);
    assert.equal(await on("today_dash", dashOnly.orgId), false);
    // turning today_home off for the org (org flag) turns today_dash off with it
    await db.query(`UPDATE organizations SET feature_flags = feature_flags - 'today_home' WHERE id = $1`, [o.orgId]);
    assert.equal(await on("today_dash", o.orgId), false);
    await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_home":"true"}' WHERE id = $1`, [o.orgId]);
    assert.equal(await on("today_dash", o.orgId), false, "a string is not boolean true");
    await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"today_home":true}' WHERE id = $1`, [o.orgId]);
    assert.equal(await on("today_dash", o.orgId), true);
    // with BOTH flags fully on for this org: an unknown or NULL key, or a NULL org, is still off (never NULL)
    await db.query(`UPDATE organizations SET feature_flags = feature_flags || '{"pricing_trial":true,"today":true}' WHERE id = $1`, [o.orgId]);
    for (const key of ["pricing_trial", "today", "today_home ", "TODAY_HOME", "", null]) assert.equal(await on(key, o.orgId), false, String(key));
    assert.equal(await on("today_home", null), false);
    assert.equal(await on("today_dash", null), false);
    // an allowlist that is not an array admits nobody and does not raise (object, string, number, JSON null, missing)
    const homeOn = (await db.query(`SELECT value FROM platform_settings WHERE key = 'today_home'`)).rows[0].value;
    for (const bad of [`{"${o.orgId}":true}`, `"${o.orgId}"`, "1", "null"]) {
      await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{allowed_org_ids}', $1::jsonb) WHERE key = 'today_home'`, [bad]);
      assert.equal(await on("today_home", o.orgId), false, bad);
      assert.equal(await on("today_dash", o.orgId), false, bad);
    }
    await db.query(`UPDATE platform_settings SET value = value - 'allowed_org_ids' WHERE key = 'today_home'`);
    assert.equal(await on("today_home", o.orgId), false);
    for (const whole of [`"on"`, "true", "[]", "null"]) {
      await db.query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'today_home'`, [whole]);
      assert.equal(await on("today_home", o.orgId), false, whole);
      assert.equal(await on("today_dash", o.orgId), false, whole);
    }
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'today_home'`, [homeOn]);
    assert.equal(await on("today_dash", o.orgId), true);
    // global today_home switch off → dash off for everyone
    await db.query(`UPDATE platform_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE key = 'today_home'`);
    assert.equal(await on("today_dash", o.orgId), false);
    assert.equal(await on("today_home", o.orgId), false);
  } finally {
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'today_dash'`, [dashBefore]);
    await db.query(`UPDATE platform_settings SET value = $1 WHERE key = 'today_home'`, [homeBefore]);
  }
});

test("fix-forward 3: anon and authenticated actually calling each app.b042_* function are denied", async () => {
  const o = await makeOrg(true);
  const sec = await secret(o.orgId, o.unit);
  const calls: [string, string, unknown[]][] = [
    ["b042_flag_on", "SELECT app.b042_flag_on('today_home', $1)", [o.orgId]],
    ["b042_session_pin_ok", "SELECT app.b042_session_pin_ok($1)", [o.orgId]],
    ["b042_record_first_login", "SELECT app.b042_record_first_login($1, $2)", [o.orgId, o.admin]],
    ["b042_first_login_seen", "SELECT app.b042_first_login_seen($1, $2)", [o.orgId, o.admin]],
    ["b042_record_invite_share", "SELECT app.b042_record_invite_share($1, $2, 'unit', $3, 'copy')", [o.orgId, o.admin, sec]],
    ["b042_org_invite_shared", "SELECT app.b042_org_invite_shared($1)", [o.orgId]],
  ];
  assert.deepEqual(calls.map((c) => `app.${c[0]}`), FUNCTIONS.map((f) => f.slice(0, f.indexOf("("))));
  // The refusal must be the grant on this very object (or on its schema), not an error raised
  // from inside the function body or by a table it reads.
  const denied = (object: string, kind: "function" | "table") => (e: unknown) => {
    const err = e as { code?: string; message?: string };
    assert.equal(err.code, "42501", `${object}: ${err.message}`);
    assert.match(err.message ?? "", new RegExp(`^permission denied for (schema app|${kind} ${object})$`), object);
    return true;
  };
  for (const role of ["anon", "authenticated"]) {
    for (const [name, sql, params] of calls) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        // pinned and signed in as the org's own admin: the denial is the grant, not the data
        await db.query(`SELECT set_config('app.env', 'live', true), set_config('app.active_org_id', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [o.orgId, o.admin]);
        await assert.rejects(db.query(sql, params), denied(name, "function"), `${role}: ${sql}`);
      } finally {
        await db.query("ROLLBACK");
      }
    }
    for (const t of TABLES) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query(`SELECT count(*) FROM ${t}`), denied(t.slice(4), "table"), `${role}: ${t}`);
      } finally {
        await db.query("ROLLBACK");
      }
    }
  }
  assert.equal(await shared(o.orgId), false);
  assert.equal(Number((await db.query(`SELECT count(*) FROM app.b042_first_logins WHERE org_id = $1`, [o.orgId])).rows[0].count), 0);
});
