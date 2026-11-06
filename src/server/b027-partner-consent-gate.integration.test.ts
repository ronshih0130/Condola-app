import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { changePartnerOverride, type PartnerControlCommand } from "./partner-controls";
import { partnerDocumentConfig } from "./partner-consent-rules";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
const gateKey = "partner_consent_gate";
const approvalKey = "partner_consent_approved_agreements";
const off = { enabled: false, allowed_org_ids: [] };
const on = { enabled: true, allowed_org_ids: [ORG_ID] };
const doc = partnerDocumentConfig.documents.partner_agreement[0];
const approved = { version: doc.version, locale: doc.locale, sha256: doc.sha256 };
const admin: Session = { userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff",
  role: "admin", sessionId: randomUUID(), name: "Synthetic", email: "synthetic@example.test", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const command = (kind: "pricing_hide" | "unit_override", action: "create" | "renew" | "revoke" = "create", revision = 0): PartnerControlCommand =>
  ({ kind, action, unitLimit: kind === "unit_override" ? 20 : null, days: 30, expectedRevision: revision });
const forbidden = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const denied = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "42501";
async function setting(key: string, value: unknown) {
  await query(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, JSON.stringify(value)]);
}
async function configure(gate: unknown = on, optIn: unknown = true) {
  await setting(gateKey, gate);
  await setting("partner_pricing_hide", on);
  await setting("partner_unit_override", on);
  await query(`UPDATE organizations SET feature_flags=feature_flags || $2::jsonb WHERE id=$1`,
    [ORG_ID, JSON.stringify({ partner_pricing_hide: true, partner_unit_override: true, partner_consent_gate: optIn })]);
}
async function approval(value: unknown = approved, org = ORG_ID) { await setting(approvalKey, { [org]: value }); }
async function consent(options: { org?: string; version?: string; hash?: string; locale?: string; type?: string; time?: string } = {}) {
  await query(`INSERT INTO partner_agreement_consents
    (company_id,user_id,doc_type,version,locale,document_sha256,authority_attested,actor_role,consenter_name,consented_at)
    VALUES($1,$2,$3,$4,$5,$6,true,'admin','Synthetic consenter',coalesce($7::timestamptz,clock_timestamp()))`,
    [options.org ?? ORG_ID, USERS.admin, options.type ?? "partner_agreement", options.version ?? doc.version,
      options.locale ?? doc.locale, options.hash ?? doc.sha256, options.time ?? null]);
}
async function snapshot() {
  const tables = (await query<{ schema: string; name: string }>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables
    WHERE schemaname IN ('public','app') ORDER BY 1,2`)).rows;
  const rows = await query(tables.map(({ schema, name }) => {
    assert.match(schema, /^[a-z_]+$/); assert.match(name, /^[a-z0-9_]+$/);
    return `SELECT '${schema}.${name}' AS name,md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${schema}"."${name}" t`;
  }).join(" UNION ALL "));
  return rows.rows.sort((a, b) => a.name.localeCompare(b.name));
}
async function raw(role: string, sql: string, user: string = USERS.admin, org: string = ORG_ID) {
  assert.ok(["service_role", "authenticated", "anon", "none"].includes(role));
  return withClient(async c => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [user, org]);
      if (role !== "none") await c.query(`SET LOCAL ROLE ${role}`);
      return await c.query(sql);
    } finally { await c.query("ROLLBACK"); }
  });
}
const rpc = `SELECT app.b027_change_override('${ORG_ID}','unit_override','create',20,30,0)`;
test.beforeEach(async () => { clone = await cloneTestDatabase(); });
test.afterEach(async () => { await clone?.cleanup(); });

test("B027 consent seed is OFF, approval empty, and seed replay preserves existing configuration", async () => {
  assert.deepEqual((await query(`SELECT value FROM platform_settings WHERE key=$1`, [gateKey])).rows[0].value, off);
  assert.deepEqual((await query(`SELECT value FROM platform_settings WHERE key=$1`, [approvalKey])).rows[0].value, {});
  await configure(); await approval();
  const sql = readFileSync(new URL("../../supabase/migrations/20261106200000_b027_partner_consent_gate.sql", import.meta.url), "utf8");
  const seed = sql.slice(sql.indexOf("INSERT INTO"), sql.indexOf("ON CONFLICT (key) DO NOTHING;") + "ON CONFLICT (key) DO NOTHING;".length);
  const before = await snapshot(); await query(seed); assert.deepEqual(await snapshot(), before);
  // Existing approved metadata matches the unchanged full-text bytes; no new version.
  assert.equal(createHash("sha256").update(readFileSync(doc.source)).digest("hex"), approved.sha256);
});

test("B027 consent OFF matrix preserves legacy create/renew/revoke and writes no consent records", async () => {
  const matrix: [unknown, unknown][] = [
    [off, true], [null, true], [true, true], [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true],
    [{ enabled: true, allowed_org_ids: [ORG_ID, 42] }, true], [{ enabled: true, allowed_org_ids: [ORG_ID, "bad"] }, true],
    [{ enabled: true, allowed_org_ids: ORG_ID }, true], [{ enabled: true, allowed_org_ids: [ORG2_ID] }, true],
    [on, false], [on, "true"], [on, null],
  ];
  let revision = 0;
  for (const [gate, flag] of matrix) {
    await configure(gate, flag);
    const result = await changePartnerOverride(admin, command("unit_override", revision ? "renew" : "create", revision));
    assert.equal(result?.revision, ++revision);
  }
  await query(`DELETE FROM platform_settings WHERE key=$1`, [gateKey]);
  assert.equal((await changePartnerOverride(admin, command("unit_override", "revoke", revision)))?.revoked, true);
  assert.equal((await query(`SELECT count(*)::int AS n FROM partner_agreement_consents`)).rows[0].n, 0);
  assert.deepEqual((await query(`SELECT value FROM platform_settings WHERE key=$1`, [approvalKey])).rows[0].value, {});
});

test("B027 controls OFF stays zero-write even with consent gate ON and no evidence", async () => {
  await configure();
  for (const key of ["partner_pricing_hide", "partner_unit_override"]) await setting(key, off);
  const before = await snapshot();
  for (const kind of ["pricing_hide", "unit_override"] as const)
    for (const action of ["create", "renew", "revoke"] as const)
      assert.equal(await changePartnerOverride(admin, command(kind, action)), null);
  assert.deepEqual(await snapshot(), before);
});

test("B027 ON missing/malformed approval or consent denies server and direct RPC with zero writes", async () => {
  await configure();
  for (const value of [null, {}, { ...approved, version: "" }, { ...approved, sha256: "bad" }, approved]) {
    await approval(value);
    const before = await snapshot();
    for (const kind of ["pricing_hide", "unit_override"] as const)
      await assert.rejects(changePartnerOverride(admin, command(kind)), forbidden);
    await assert.rejects(raw("service_role", rpc), denied);
    assert.deepEqual(await snapshot(), before);
  }
});

test("B027 ON version/hash/locale/type/time mismatch and foreign-company evidence do not cover current approval", async () => {
  await configure(); await approval();
  for (const options of [
    { version: "synthetic-obsolete" }, { hash: "0".repeat(64) }, { locale: "synthetic-other" },
    { type: "privacy" }, { time: "infinity" }, { time: "2099-01-01" }, { org: ORG2_ID },
  ]) {
    await consent(options);
    const before = await snapshot();
    for (const kind of ["pricing_hide", "unit_override"] as const)
      await assert.rejects(changePartnerOverride(admin, command(kind)), forbidden);
    assert.deepEqual(await snapshot(), before);
  }
});

test("B027 valid existing company consent permits both paths; approval changes block renew/revoke atomically", async () => {
  await configure(); await approval(); await consent();
  const evidence = (await query(`SELECT * FROM partner_agreement_consents`)).rows;
  for (const kind of ["pricing_hide", "unit_override"] as const) {
    assert.equal((await changePartnerOverride(admin, command(kind)))?.revision, 1);
    assert.equal((await changePartnerOverride(admin, command(kind, "renew", 1)))?.revision, 2);
  }
  for (const changed of [{ ...approved, version: "synthetic-next" }, { ...approved, sha256: "1".repeat(64) }]) {
    await approval(changed);
    const before = await snapshot();
    for (const kind of ["pricing_hide", "unit_override"] as const)
      for (const action of ["renew", "revoke"] as const)
        await assert.rejects(changePartnerOverride(admin, command(kind, action, 2)), forbidden);
    assert.deepEqual(await snapshot(), before);
  }
  await approval();
  for (const kind of ["pricing_hide", "unit_override"] as const)
    assert.equal((await changePartnerOverride(admin, command(kind, "revoke", 2)))?.revoked, true);
  assert.deepEqual((await query(`SELECT * FROM partner_agreement_consents`)).rows, evidence);
  assert.equal((await query(`SELECT count(*)::int AS n FROM app.b027_partner_override_events`)).rows[0].n, 6);
  assert.equal((await query(`SELECT count(*)::int AS n FROM audit_log WHERE event_type LIKE 'partner_override_%'`)).rows[0].n, 6);
});

test("B027 valid consent does not admit foreign or non-Admin actors, forged roles, missing pins or client RPCs", async () => {
  await configure(); await approval(); await consent();
  const before = await snapshot();
  for (const userId of [USERS.coastAdmin, USERS.manager, USERS.accountant, USERS.maintenance, USERS.tenant]) {
    await assert.rejects(changePartnerOverride({ ...admin, userId }, command("unit_override")), forbidden);
    await assert.rejects(raw("service_role", rpc, userId), denied);
  }
  await assert.rejects(changePartnerOverride({ ...admin, role: "manager" }, command("pricing_hide")), forbidden);
  for (const role of ["authenticated", "anon"]) await assert.rejects(raw(role, rpc), denied);
  await assert.rejects(raw("service_role", rpc, USERS.admin, ORG2_ID), denied);
  await assert.rejects(raw("service_role", rpc, USERS.admin, ""), denied);
  for (const role of ["authenticated", "anon"])
    await assert.rejects(raw(role, `UPDATE platform_settings SET value='{}'::jsonb WHERE key='${approvalKey}'`), denied);
  for (const role of ["service_role", "authenticated", "anon"])
    await assert.rejects(raw(role, `SELECT app.b027_require_partner_consent('${ORG_ID}')`), denied);
  assert.deepEqual(await snapshot(), before);
});

test("B027 existing consent is append-only for owner and API roles: UPDATE DELETE TRUNCATE rejected", async () => {
  await consent();
  const before = await snapshot();
  for (const role of ["none", "service_role", "authenticated", "anon"])
    for (const sql of ["UPDATE partner_agreement_consents SET version='synthetic-forged'", "DELETE FROM partner_agreement_consents", "TRUNCATE partner_agreement_consents"])
      await assert.rejects(raw(role, sql), denied);
  assert.deepEqual(await snapshot(), before);
});

test("B027 sandbox cannot bypass live-company gate and uses live-company approval/evidence", async () => {
  await configure(); await approval();
  const sandbox = randomUUID();
  await query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,created_by,feature_flags)
    SELECT $1,'Synthetic sandbox',country_code,default_currency,timezone,'sandbox',id,created_by,
    '{"partner_unit_override":true,"partner_consent_gate":false}'::jsonb FROM organizations WHERE id=$2`, [sandbox, ORG_ID]);
  await setting("partner_unit_override", { enabled: true, allowed_org_ids: [sandbox] });
  const session = { ...admin, orgId: sandbox, environment: "sandbox" as const };
  const before = await snapshot();
  await assert.rejects(changePartnerOverride(session, command("unit_override")), forbidden);
  assert.deepEqual(await snapshot(), before);
  await consent();
  assert.equal((await changePartnerOverride(session, command("unit_override")))?.revision, 1);
});


test("B027 waiting writers observe committed approval changes and activation of a previously absent gate", async () => {
  await configure(); await approval(); await consent();
  for (const scenario of ["approval", "activation"] as const) {
    if (scenario === "activation") {
      await approval();
      await query(`DELETE FROM platform_settings WHERE key=$1`, [gateKey]);
    }
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect(); await writer.connect();
    let pending: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      if (scenario === "approval") {
        await blocker.query(`UPDATE platform_settings SET value=$2::jsonb WHERE key=$1`,
          [approvalKey, JSON.stringify({ [ORG_ID]: { ...approved, sha256: "2".repeat(64) } })]);
      } else {
        await blocker.query(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb)`, [gateKey, JSON.stringify(on)]);
        // Enabled gate is committed together with a new approval lacking consent.
        await blocker.query(`UPDATE platform_settings SET value=$2::jsonb WHERE key=$1`,
          [approvalKey, JSON.stringify({ [ORG_ID]: { ...approved, version: "synthetic-next" } })]);
      }
      await writer.query("BEGIN");
      await writer.query("SET LOCAL statement_timeout='5s'");
      await writer.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, ORG_ID]);
      const pid = (await writer.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      await writer.query("SET LOCAL ROLE service_role");
      pending = assert.rejects(writer.query(rpc), denied);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await blocker.query(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`, [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, `${scenario}: writer must wait for configuration transaction`);
      await blocker.query("COMMIT");
      await pending;
      assert.equal((await query(`SELECT count(*)::int AS n FROM app.b027_partner_overrides`)).rows[0].n, 0);
      assert.equal((await query(`SELECT count(*)::int AS n FROM app.b027_partner_override_events`)).rows[0].n, 0);
    } finally {
      await blocker.query("ROLLBACK");
      if (pending) await pending;
      await writer.query("ROLLBACK");
      await blocker.end(); await writer.end();
    }
  }
});
