import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import React from "react";
import { Client } from "pg";
import { ENV_COOKIE } from "./org-scope";
import { countActiveUnits } from "./sandbox";
import { makeT } from "@/i18n";
import nextHeaders from "next/headers";
import PricingPage from "@/app/pricing/page";
import SettingsPage from "@/app/m/settings/page";
import UpgradePage from "@/app/m/upgrade/page";
import { FlowError } from "./errors";
import { SESSION_COOKIE } from "./auth";
import { query, withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { sessionTokenHash } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { changePartnerOverride, readPartnerControls, type PartnerControlCommand } from "./partner-controls";
import { upgradeGate } from "./upgrade-gate";
import { quoteMonthly } from "./billing";
import type { PartnerOverrideKind } from "./partner-controls-rules";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let cookie = "";
let environment = "live";
const sandboxId = randomUUID();
const admin: Session = { userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff",
  role: "admin", sessionId: randomUUID(), name: "Synthetic", email: "synthetic@example.test", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const keys = ["partner_pricing_hide", "partner_unit_override"];
const enabled = { enabled: true, allowed_org_ids: [ORG_ID] };
const off = { enabled: false, allowed_org_ids: [] };
const create = (kind: PartnerOverrideKind): PartnerControlCommand => ({ kind, action: "create", unitLimit: kind === "unit_override" ? 20 : null, days: 30, expectedRevision: 0 });

async function config(platform: unknown, flags: unknown = { partner_pricing_hide: true, partner_unit_override: true }) {
  await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key=ANY($2::text[])`, [JSON.stringify(platform), keys]);
  await query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(flags)]);
}
async function snapshot() {
  // Every application table, including audits and private tables; auth session touch
  // is authentication bookkeeping, platform/org fixture changes happen before this.
  const tables = (await query<{ schema: string; name: string }>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables
    WHERE schemaname IN ('public','app') AND tablename<>'auth_sessions' ORDER BY 1,2`)).rows;
  const result = await query<{ name: string; hash: string }>(tables.map(({ schema, name }) => {
    assert.match(schema, /^[a-z_]+$/); assert.match(name, /^[a-z0-9_]+$/);
    return `SELECT '${schema}.${name}' AS name, md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${schema}"."${name}" t`;
  }).join(" UNION ALL "));
  return result.rows.sort((a, b) => a.name.localeCompare(b.name));
}
async function redirectTo(run: () => Promise<unknown>, location: string) {
  await assert.rejects(run, (e: unknown) => !!e && typeof e === "object" && "digest" in e
    && e.digest === `NEXT_REDIRECT;replace;${location};307;`);
}
function pageTree(value: unknown) {
  return JSON.stringify(value, (key, item) => {
    if (key === "_owner" || key === "_store") return undefined;
    if (key === "type") return typeof item === "string" ? item : typeof item === "function" ? item.name : "component";
    return typeof item === "function" ? item.name : item;
  });
}
type PageNode = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): PageNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as PageNode;
  return [node, ...nodes(node.props?.children)];
}
function byTestId(value: unknown, id: string) {
  return nodes(value).find(n => n.props?.["data-testid"] === id);
}
function calculator(value: unknown) {
  const found = nodes(value).find(n => typeof n.type === "function" && n.type.name === "PricingCalculator");
  assert.ok(found?.props);
  return found.props;
}
function assertUnrelatedSettings(value: unknown) {
  for (const id of ["tenant-lease-mail", "tenant-overdue-mail", "org-contact-email", "idv-retain-days"])
    assert.ok(byTestId(value, id), `${id} remains available`);
  for (const name of ["PartnerConsentHistory", "PayeeSettings"])
    assert.ok(nodes(value).some(n => typeof n.type === "function" && n.type.name === name), `${name} remains mounted`);
}
// Explicit contract read from 42aed1a, not generated from the modified pages.
async function assertLegacyPages() {
  const settings = await SettingsPage({ searchParams: Promise.resolve({}) });
  assertUnrelatedSettings(settings);
  const t = makeT(admin.locale);
  assert.equal(byTestId(settings, "settings-plan")?.props?.children, t("i_settings_plan"));
  assert.equal(byTestId(settings, "sandbox-plan"), undefined);
  const pricing = await PricingPage();
  for (const id of ["price-headline", "price-sub", "price-pending", "price-receipt", "price-faq", "price-footer"])
    assert.ok(byTestId(pricing, id), `legacy pricing includes ${id}`);
  assert.equal(byTestId(pricing, "plan-price-standard")?.props?.children, t("i_price_std_amt"));
  assert.equal(byTestId(pricing, "plan-price-pro")?.props?.children, t("i_price_pro_amt"));
  for (const tier of ["standard", "pro"])
    assert.equal(byTestId(pricing, `plan-upgrade-${tier}`)?.props?.href, "/m/settings");
  assert.equal(calculator(pricing).initialUnits, await countActiveUnits(ORG_ID));
  assert.equal(calculator(pricing).unitOverride, undefined);
  await redirectTo(UpgradePage, "/m/settings");
}
const pages = async () => ({ settings: pageTree(await SettingsPage({ searchParams: Promise.resolve({}) })), pricing: pageTree(await PricingPage()) });
async function raw(userId: string, orgId: string | null, sql: string, params: unknown[] = [], role = "service_role") {
  assert.ok(["authenticated", "anon", "service_role"].includes(role));
  return withClient(async c => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [userId, orgId ?? ""]);
      await c.query(`SET LOCAL ROLE ${role}`);
      return await c.query(sql, params);
    } finally { await c.query("ROLLBACK"); }
  });
}
const denied = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "42501";

test.before(async () => {
  clone = await cloneTestDatabase();
  // TSX runs these real server components outside Next's JSX compiler.
  Object.assign(globalThis, { React });
  cookie = randomUUID();
  await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [admin.sessionId, admin.userId, sessionTokenHash(cookie)]);
  mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => key === SESSION_COOKIE ? { value: cookie } : key === ENV_COOKIE ? { value: environment } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers());
});
test.after(async () => { mock.restoreAll(); await clone?.cleanup(); });

test("B027 seeded settings are OFF and malformed/OFF matrix leaves every domain table and legacy paths unchanged", async () => {
  assert.deepEqual((await query(`SELECT value FROM platform_settings WHERE key=ANY($1::text[]) ORDER BY key`, [keys])).rows, [{ value: off }, { value: off }]);
  await config(off);
  await assertLegacyPages();
  const legacy = await pages();
  await redirectTo(UpgradePage, "/m/settings");
  for (const [platform, flags] of [
    [off, { partner_pricing_hide: true, partner_unit_override: true }],
    [enabled, { partner_pricing_hide: false, partner_unit_override: false }],
    [enabled, { partner_pricing_hide: "true", partner_unit_override: "true" }],
    [{ enabled: "true", allowed_org_ids: [ORG_ID] }, { partner_pricing_hide: true, partner_unit_override: true }],
    [{ enabled: true, allowed_org_ids: [ORG_ID, 42] }, { partner_pricing_hide: true, partner_unit_override: true }],
    [{ enabled: true, allowed_org_ids: [ORG_ID, "bad"] }, { partner_pricing_hide: true, partner_unit_override: true }],
    [{ enabled: true, allowed_org_ids: ORG_ID }, { partner_pricing_hide: true, partner_unit_override: true }],
    [{ enabled: true, allowed_org_ids: [ORG2_ID] }, { partner_pricing_hide: true, partner_unit_override: true }],
    [null, {}],
  ]) {
    // platform_settings.value is NOT NULL; JSON null remains a valid malformed fixture.
    await config(platform, flags);
    const before = await snapshot();
    assert.equal(await changePartnerOverride(admin, create("pricing_hide")), null);
    assert.equal(await changePartnerOverride(admin, create("unit_override")), null);
    assert.deepEqual(await upgradeGate(admin, 4), { redirectTo: null, unitLimit: 4, unitOverride: null });
    await assertLegacyPages();
    assert.deepEqual(await pages(), legacy);
    await redirectTo(UpgradePage, "/m/settings");
    assert.deepEqual(await snapshot(), before);
  }
  // Missing rows are OFF too.
  await query(`DELETE FROM platform_settings WHERE key=ANY($1::text[])`, [keys]);
  const before = await snapshot();
  assert.equal(await changePartnerOverride(admin, create("unit_override")), null);
  assert.deepEqual(await pages(), legacy);
  assert.deepEqual(await snapshot(), before);
  for (const key of keys) await query(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb)`, [key, JSON.stringify(off)]);
});

test("B027 ON hides only the settings plan, redirects upgrade/pricing and applies unit allowance", async () => {
  await config(enabled);
  const hide = await changePartnerOverride(admin, create("pricing_hide"));
  const unit = await changePartnerOverride(admin, create("unit_override"));
  assert.ok(hide && unit);
  for (const page of [UpgradePage, PricingPage]) await redirectTo(page, "/m");
  const settings = await SettingsPage({ searchParams: Promise.resolve({}) });
  assertUnrelatedSettings(settings);
  assert.equal(byTestId(settings, "settings-plan"), undefined);
  assert.equal(byTestId(settings, "sandbox-plan"), undefined);
  const gate = await upgradeGate(admin, 4);
  assert.equal(gate.unitLimit, 20);
  assert.equal(quoteMonthly({ units: 25, tier: "standard", cycle: "month", now: new Date(), unitOverride: gate.unitOverride }).monthly, 150);
  // Independent flags: hiding OFF does not disable the unit term.
  await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='partner_pricing_hide'`, [JSON.stringify(off)]);
  const page = pageTree(await PricingPage());
  assert.match(page, /unitOverride/);
  assert.match(page, /unitLimit\\?":20/);
  await config(enabled);
});

test("B027 OFF uses one read in one implicit transaction, with no private RPC or setup queries", async () => {
  await config(off);
  const queries = mock.method(Client.prototype, "query");
  const connections = mock.method(Client.prototype, "connect");
  try {
    assert.deepEqual(await readPartnerControls(admin), { pricingHide: false, unitOverride: null });
    assert.equal(connections.mock.callCount(), 1);
    assert.equal(queries.mock.callCount(), 1);
    assert.match(String(queries.mock.calls[0].arguments[0]), /^SELECT/);
    assert.doesNotMatch(String(queries.mock.calls[0].arguments[0]), /b027_read_controls|b027_partner_overrides|set_config/);
  } finally {
    queries.mock.restore(); connections.mock.restore();
    await config(enabled);
  }
});

test("B027 sandbox OFF cannot bypass live pricing hide", async () => {
  await query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,created_by)
    SELECT $1,'Synthetic sandbox',country_code,default_currency,timezone,'sandbox',id,created_by FROM organizations WHERE id=$2`, [sandboxId, ORG_ID]);
  environment = "sandbox";
  try {
    assert.deepEqual(await readPartnerControls({ ...admin, orgId: sandboxId, environment: "sandbox" }), { pricingHide: false, unitOverride: null });
    await redirectTo(PricingPage, "/m");
  } finally { environment = "live"; }
});

test("B027 sandbox allowance cannot alter live pricing/usage and live allowance still applies", async () => {
  await config({ enabled: true, allowed_org_ids: [sandboxId] }, {});
  await query(`UPDATE organizations SET feature_flags='{"partner_unit_override":true}' WHERE id=$1`, [sandboxId]);
  const sandboxSession = { ...admin, orgId: sandboxId, environment: "sandbox" as const };
  assert.ok(await changePartnerOverride(sandboxSession, { ...create("unit_override"), unitLimit: 77 }));
  environment = "sandbox";
  try {
    assert.equal((await readPartnerControls(sandboxSession)).unitOverride?.unitLimit, 77);
    const pricing = await PricingPage();
    assert.equal(calculator(pricing).unitOverride, undefined);
    assert.equal(calculator(pricing).initialUnits, await countActiveUnits(ORG_ID));
    assert.equal(byTestId(pricing, "plan-price-standard")?.props?.children, makeT(admin.locale)("i_price_std_amt"));
    await config({ enabled: true, allowed_org_ids: [ORG_ID, sandboxId] }, { partner_unit_override: true });
    const livePricing = await PricingPage();
    assert.equal((calculator(livePricing).unitOverride as { unitLimit: number }).unitLimit, 20);
    assert.equal(calculator(livePricing).initialUnits, await countActiveUnits(ORG_ID));
  } finally { environment = "live"; await config(enabled); }
});

test("B027 synthetic exact term boundaries revert without cleanup writes", async () => {
  for (const kind of ["pricing_hide", "unit_override"] as const) {
    const row = (await query<{ start: string; end: string }>(`SELECT starts_at::text AS start,expires_at::text AS end FROM app.b027_partner_overrides WHERE org_id=$1 AND kind=$2`, [ORG_ID, kind])).rows[0];
    const before = await snapshot();
    const atStart = await readPartnerControls(admin, new Date(row.start));
    const beforeEnd = await readPartnerControls(admin, new Date(Date.parse(row.end) - 1));
    const atEnd = await readPartnerControls(admin, new Date(row.end));
    if (kind === "pricing_hide") {
      assert.equal(atStart.pricingHide, true); assert.equal(beforeEnd.pricingHide, true); assert.equal(atEnd.pricingHide, false);
    } else {
      assert.equal(atStart.unitOverride?.unitLimit, 20); assert.equal(beforeEnd.unitOverride?.unitLimit, 20); assert.equal(atEnd.unitOverride, null);
      assert.equal((await upgradeGate(admin, 4, new Date(row.end))).unitLimit, 4);
    }
    assert.deepEqual(await snapshot(), before);
  }
});

test("B027 global kill and org opt-out revert existing terms and reject renew/revoke with zero writes", async () => {
  for (const [platform, flags] of [[off, { partner_pricing_hide: true, partner_unit_override: true }], [enabled, {}]]) {
    await config(platform, flags);
    const before = await snapshot();
    assert.deepEqual(await readPartnerControls(admin), { pricingHide: false, unitOverride: null });
    for (const action of ["renew", "revoke"] as const) assert.equal(await changePartnerOverride(admin, { ...create("unit_override"), action, expectedRevision: 1 }), null);
    await redirectTo(UpgradePage, "/m/settings");
    assert.ok(await PricingPage()); assert.ok(await SettingsPage({ searchParams: Promise.resolve({}) }));
    assert.deepEqual(await snapshot(), before);
  }
  await config(enabled);
});

test("B027 renewal is at most 30 days from renewal time with immutable actor/revision events and masked audit", async () => {
  const before = await snapshot();
  for (const days of [0, 31, -1]) await assert.rejects(changePartnerOverride(admin, { ...create("unit_override"), action: "renew", days, expectedRevision: 1 }));
  assert.deepEqual(await snapshot(), before);
  const renew = await changePartnerOverride(admin, { ...create("unit_override"), action: "renew", expectedRevision: 1 });
  assert.ok(renew); assert.equal(renew.revision, 2);
  assert.equal(Date.parse(renew.expiresAt) - Date.parse(renew.startsAt), 30 * 86400000);
  assert.ok(Math.abs(Date.parse(renew.startsAt) - Date.now()) < 5000);
  const events = (await query(`SELECT action,actor_user_id,revision FROM app.b027_partner_override_events WHERE org_id=$1 AND kind='unit_override' ORDER BY revision`, [ORG_ID])).rows;
  assert.deepEqual(events, [{ action: "create", actor_user_id: admin.userId, revision: 1 }, { action: "renew", actor_user_id: admin.userId, revision: 2 }]);
  const audit = (await query(`SELECT actor_user_id,actor_role,new_row FROM audit_log WHERE org_id=$1 AND event_type='partner_override_renew'`, [ORG_ID])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, admin.userId); assert.equal(audit[0].actor_role, "admin");
  assert.deepEqual(Object.keys(audit[0].new_row).sort(), ["expires_at", "kind", "revision", "revoked", "starts_at", "unit_limit"]);
  assert.equal(JSON.stringify(audit).includes(admin.email), false);
  await assert.rejects(query(`UPDATE app.b027_partner_override_events SET action='revoke' WHERE org_id=$1`, [ORG_ID]), (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "55000");
  await assert.rejects(query(`DELETE FROM app.b027_partner_override_events WHERE org_id=$1`, [ORG_ID]));
  await assert.rejects(query(`TRUNCATE app.b027_partner_override_events`));
  const saved = await snapshot();
  await assert.rejects(changePartnerOverride(admin, { ...create("unit_override"), action: "renew", expectedRevision: 1 }));
  assert.deepEqual(await snapshot(), saved);
});

test("B027 cross-org, non-Admin, forged role, missing pin and mismatched environment cannot mutate", async () => {
  const before = await snapshot();
  const command = { ...create("unit_override"), action: "renew" as const, expectedRevision: 2 };
  for (const s of [
    { ...admin, userId: USERS.coastAdmin },
    { ...admin, userId: USERS.manager, role: "manager" as const },
    { ...admin, userId: USERS.manager }, // Claimed Admin cannot bypass canonical membership.
    { ...admin, userId: USERS.accountant }, { ...admin, userId: USERS.maintenance },
    { ...admin, userId: USERS.tenant }, { ...admin, environment: "sandbox" as const },
    { ...admin, needsSandbox: true },
  ]) await assert.rejects(changePartnerOverride(s, command), (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
  await assert.rejects(readPartnerControls({ ...admin, userId: USERS.coastAdmin }), (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
  const sql = `SELECT app.b027_change_override($1,'unit_override','renew',20,30,2)`;
  await assert.rejects(raw(USERS.admin, null, sql, [ORG_ID]), denied);
  await assert.rejects(raw(USERS.admin, ORG2_ID, sql, [ORG_ID]), denied);
  await assert.rejects(raw(USERS.manager, ORG_ID, sql, [ORG_ID]), denied);
  await assert.rejects(raw(USERS.admin, ORG_ID, sql, [ORG_ID], "authenticated"), denied);
  assert.deepEqual(await snapshot(), before);
});

test("B027 RLS/private ACLs and pinned definer gateways; anon has no access", async () => {
  const rows = (await query(`SELECT relname,relrowsecurity FROM pg_class WHERE oid IN ('app.b027_partner_overrides'::regclass,'app.b027_partner_override_events'::regclass) ORDER BY relname`)).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.relrowsecurity));
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const table of ["b027_partner_overrides", "b027_partner_override_events"])
      await assert.rejects(raw(USERS.admin, ORG_ID, `SELECT * FROM app.${table}`, [], role), denied);
  }
  await assert.rejects(raw(USERS.admin, ORG_ID, `SELECT app.b027_read_controls($1)`, [ORG_ID], "anon"), denied);
  const functions = (await query(`SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname IN ('b027_change_override','b027_read_controls')`)).rows;
  assert.equal(functions.length, 2);
  assert.ok(functions.every(f => f.prosecdef && f.proconfig.includes("search_path=pg_catalog, public, app")));
});

test("B027 failed application audit rolls back both override and append-only event", async () => {
  await query(`CREATE FUNCTION app.b027_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type='partner_override_renew' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER b027_test_reject_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.b027_test_reject_audit()`);
  try {
    const before = await snapshot();
    await assert.rejects(changePartnerOverride(admin, { ...create("unit_override"), action: "renew", expectedRevision: 2 }),
      (e: unknown) => e instanceof FlowError && e.key === "errors.generic");
    assert.deepEqual(await snapshot(), before);
  } finally {
    await query(`DROP TRIGGER b027_test_reject_audit ON public.audit_log`);
    await query(`DROP FUNCTION app.b027_test_reject_audit()`);
  }
});

test("B027 database constraints reject unbounded units and terms even for the table owner", async () => {
  const before = await snapshot();
  for (const sql of [
    `UPDATE app.b027_partner_overrides SET unit_limit=10001 WHERE kind='unit_override'`,
    `UPDATE app.b027_partner_overrides SET unit_limit=0 WHERE kind='unit_override'`,
    `UPDATE app.b027_partner_overrides SET expires_at=starts_at+interval '720 hours 1 second'`,
    `UPDATE app.b027_partner_overrides SET expires_at=starts_at`,
    `UPDATE app.b027_partner_overrides SET expires_at='infinity'`,
  ]) await assert.rejects(query(sql), (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === (sql.includes("infinity") ? "22008" : "23514"));
  assert.deepEqual(await snapshot(), before);
});

test("B027 revoke immediately reverts the override and appends an event", async () => {
  const revoked = await changePartnerOverride(admin, { ...create("unit_override"), action: "revoke", days: null, expectedRevision: 2 });
  assert.equal(revoked?.revoked, true); assert.equal(revoked?.revision, 3);
  assert.equal((await upgradeGate(admin, 4)).unitLimit, 4);
  assert.equal((await query(`SELECT action FROM app.b027_partner_override_events WHERE org_id=$1 AND kind='unit_override' AND revision=3`, [ORG_ID])).rows[0].action, "revoke");
});

test("B027 explicit 42aed1a OFF contract also preserves sandbox settings and anonymous pricing", async () => {
  await config(off);
  environment = "sandbox";
  const savedCookie = cookie;
  try {
    const settings = await SettingsPage({ searchParams: Promise.resolve({}) });
    assertUnrelatedSettings(settings);
    assert.ok(byTestId(settings, "sandbox-plan"));
    assert.equal(byTestId(settings, "settings-plan"), undefined);
    await redirectTo(UpgradePage, "/m/settings");
    assert.equal(calculator(await PricingPage()).initialUnits, await countActiveUnits(ORG_ID));
    cookie = "";
    const pricing = await PricingPage();
    assert.equal(calculator(pricing).initialUnits, 30);
    assert.equal(calculator(pricing).unitOverride, undefined);
    assert.equal(byTestId(pricing, "price-pending"), undefined);
    for (const tier of ["standard", "pro"])
      assert.equal(byTestId(pricing, `plan-upgrade-${tier}`)?.props?.href, "/signup");
    assert.ok(nodes(pricing).some(n => n.props?.href === "/signup"));
  } finally { cookie = savedCookie; environment = "live"; }
});
