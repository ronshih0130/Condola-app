import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import React from "react";
import { Client } from "pg";
import nextHeaders from "next/headers";
import SettingsPage from "@/app/m/settings/page";
import { UsageCard } from "@/components/usage-card";
import { TrialConfirm } from "@/components/b056-trial-confirm";
import { TrialBanner } from "@/components/b056-trial-banner";
import { b056TrialCopy } from "@/i18n/b056-trial";
import { SESSION_COOKIE } from "./auth";
import { ENV_COOKIE } from "./org-scope";
import { buildStoredConsent } from "./consent";
import { sessionTokenHash } from "./session";
import { governCustomRole } from "./b017-custom-role-governance";
import { dismissTrialBanner, startTrial, trialBannerFor, trialCardState } from "./b056-trial";
import { formatTrialDate, previewTrialEnd, trialDaysLeft } from "./b056-trial-rules";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// MGT-96-AC1…AC4 (UI), MGT-97-AC1, MGT-98-AC1/AC2. No signup or outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
let cookie = "";
let fetchCalls = 0;
const realFetch = globalThis.fetch;
let savedFlag: unknown;
test.before(async () => {
  Object.assign(globalThis, { React });
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("B056 UI: outbound fetch is forbidden"); }) as typeof fetch;
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  savedFlag = (await db.query("SELECT value FROM platform_settings WHERE key='pricing_trial'")).rows[0].value;
  mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => key === SESSION_COOKIE ? { value: cookie } : key === ENV_COOKIE ? { value: "live" } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/m/settings" }));
});
test.after(async () => {
  try {
    if (savedFlag !== undefined) await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='pricing_trial'", [JSON.stringify(savedFlag)]);
  } finally {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    await db?.end();
  }
  assert.equal(fetchCalls, 0, "B-056 UI made a network call");
});

type Actor = { session: Session; token: string };
async function makeOrg(flagOn: boolean) {
  const tag = `b056ui.${randomUUID()}`;
  const users = (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
     SELECT gen_random_uuid(), $1 || '.' || n || '@example.com', '{}'::jsonb, now(), 'authenticated', 'authenticated'
       FROM generate_series(1,3) n RETURNING id`, [tag])).rows;
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,country_code,default_currency,plan_tier,settings,feature_flags)
     VALUES ($1,'TW','TWD','beta','{}'::jsonb,$2::jsonb) RETURNING id`,
    [tag, JSON.stringify(flagOn ? { pricing_trial: true } : {})])).rows[0].id;
  const actors: Actor[] = [];
  for (const [i, { id: userId }] of users.entries()) {
    const role = i === 1 ? "manager" : "admin";
    const token = randomUUID();
    const session: Session = { userId, orgId, liveOrgId: orgId, role, sessionId: randomUUID(), kind: "staff", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null, name: "Synthetic", email: `${userId}@example.com` };
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [session.sessionId, userId, sessionTokenHash(token)]);
    const consent = buildStoredConsent("reconsent");
    await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES ($1,$2,$3,$4,$5)",
      [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
    actors.push({ session, token });
  }
  if (flagOn) await db.query(
    `UPDATE platform_settings SET value=jsonb_build_object('enabled',true,
      'allowed_org_ids',coalesce(value->'allowed_org_ids','[]'::jsonb) || jsonb_build_array($1::text))
      WHERE key='pricing_trial'`, [orgId]);
  return { orgId, admin: actors[0], manager: actors[1], admin2: actors[2] };
}

type PageNode = { type?: unknown; props?: Record<string, unknown> };
// Like b027-partner-controls, inspect actual server-component trees. Expand only the
// new pure UI components; unrelated settings components retain their existing boundaries.
function nodes(value: unknown): PageNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as PageNode;
  if (node.type === UsageCard) return nodes(UsageCard(node.props as Parameters<typeof UsageCard>[0]));
  if (node.type === TrialConfirm) return nodes(TrialConfirm(node.props as Parameters<typeof TrialConfirm>[0]));
  return [node, ...nodes(node.props?.children)];
}
function byTestId(value: unknown, id: string) {
  return nodes(value).find((node) => node.props?.["data-testid"] === id);
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" ? text((value as PageNode).props?.children) : "";
}
async function settings(actor: Actor, trial?: string) {
  cookie = actor.token;
  return SettingsPage({ searchParams: Promise.resolve({ trial }) });
}
function assertNoOffer(page: unknown) {
  for (const id of ["trial-start-pro", "trial-start-std", "trial-note", "trial-confirm"]) assert.equal(byTestId(page, id), undefined, id);
}

test("flag OFF: settings has no trial UI and loaders perform only the flag read", async () => {
  const o = await makeOrg(false);
  assertNoOffer(await settings(o.admin, "premium"));
  const queries = mock.method(Client.prototype, "query");
  try {
    assert.equal(await trialCardState(o.admin.session), null);
    assert.equal(await trialBannerFor(o.admin.session), null);
    assert.equal(queries.mock.callCount(), 2);
    for (const call of queries.mock.calls) {
      assert.match(String(call.arguments[0]), /platform_settings/);
      assert.doesNotMatch(String(call.arguments[0]), /app\.b056_/);
    }
  } finally { queries.mock.restore(); }
  assert.equal(await trialCardState({ ...o.admin.session, environment: "sandbox" }), null);
  assert.equal(await trialBannerFor({ ...o.admin.session, environment: "sandbox" }), null);
});

test("Claude review r1 阻塞: a custom-role admin whose role grants settings.edit is never refused by the trial card (flag OFF and ON)", async () => {
  const savedEnv = process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const savedCustomFlag = (await db.query("SELECT value FROM platform_settings WHERE key='custom_roles'")).rows[0]?.value;
  const savedTrialFlag = (await db.query("SELECT value FROM platform_settings WHERE key='pricing_trial'")).rows[0].value;
  try {
    const o = await makeOrg(true);
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([o.orgId]);
    await db.query("UPDATE org_members SET is_billing_owner=true WHERE org_id=$1 AND user_id=$2", [o.orgId, o.admin.session.userId]);
    await db.query(`INSERT INTO platform_settings(key,value)
      VALUES ('custom_roles',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [o.orgId]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"custom_roles":true,"pricing_trial":false}'::jsonb WHERE id=$1`, [o.orgId]);
    // admin2 is a native admin restricted by a custom role that still grants settings.edit
    const roleId = (await governCustomRole(o.admin.session, { operation: "create", grants: ["settings.edit"], requestId: randomUUID() })).roleId!;
    const memberId = (await db.query("SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2", [o.orgId, o.admin2.session.userId])).rows[0].id;
    await governCustomRole(o.admin.session, { operation: "assign", roleId, memberId, requestId: randomUUID() });

    // flag OFF: no throw, nothing B-056 is read
    const queries = mock.method(Client.prototype, "query");
    try {
      assert.equal(await trialCardState(o.admin2.session), null);
      assert.equal(await trialBannerFor(o.admin2.session), null);
      for (const call of queries.mock.calls) assert.doesNotMatch(String(call.arguments[0]), /app\.b056_/);
    } finally { queries.mock.restore(); }

    // flag ON: the card state is returned (offer admin: native admin with settings.edit); banner stays hidden for custom roles
    await db.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{pricing_trial}','true'::jsonb) WHERE id=$1", [o.orgId]);
    const state = await trialCardState(o.admin2.session);
    assert.ok(state);
    assert.equal(state.plan.kind, "free");
    assert.equal(state.offer, "admin");
    assert.equal(await trialBannerFor(o.admin2.session), null);
  } finally {
    if (savedEnv === undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
    else process.env.CUSTOM_ROLES_ORG_ALLOWLIST = savedEnv;
    if (savedCustomFlag === undefined) await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='custom_roles'`);
    else await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='custom_roles'", [JSON.stringify(savedCustomFlag)]);
    await db.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='pricing_trial'", [JSON.stringify(savedTrialFlag)]);
  }
});

test("MGT-96: admin sees both offers; query only selects a dialog; manager sees only the note", async () => {
  const o = await makeOrg(true);
  const page = await settings(o.admin);
  assert.equal(byTestId(page, "trial-start-pro")?.props?.href, "/m/settings?trial=premium");
  assert.equal(byTestId(page, "trial-start-std")?.props?.href, "/m/settings?trial=standard");
  assert.equal(text(byTestId(page, "trial-note")), b056TrialCopy("zh-TW").note_admin);
  assert.equal(byTestId(page, "trial-confirm"), undefined);
  for (const query of ["premium", "pro", "standard"]) {
    const plan = query === "standard" ? "standard" : "pro";
    const before = formatTrialDate(previewTrialEnd(plan, new Date()));
    const dialog = byTestId(await settings(o.admin, query), "trial-confirm");
    assert.ok(dialog);
    assert.ok(text(dialog).includes(plan === "pro" ? "開始進階方案免費試用？" : "開始標準方案免費試用？"));
    const after = formatTrialDate(previewTrialEnd(plan, new Date()));
    assert.ok([before, after].some((date) => text(dialog).includes(date)));
    assert.equal(nodes(dialog).find((n) => n.props?.name === "plan")?.props?.value, plan);
  }
  assert.equal((await trialCardState(o.admin.session))?.plan.kind, "free", "GET confirmation never starts a trial");
  for (const query of ["started", "invalid", ""]) assert.equal(byTestId(await settings(o.admin, query), "trial-confirm"), undefined);
  const manager = await settings(o.manager, "premium");
  assert.equal(text(byTestId(manager, "trial-note")), "請公司管理員開始試用");
  for (const id of ["trial-start-pro", "trial-start-std", "trial-confirm"]) assert.equal(byTestId(manager, id), undefined);
});

test("MGT-97-AC1 / MGT-96-AC4: trial card has paid units and no second offer or dialog", async () => {
  const o = await makeOrg(true);
  const { endsAt } = await startTrial(o.admin.session, "pro");
  const page = await settings(o.admin, "standard");
  assert.equal(text(byTestId(page, "usage-plan")), `目前方案：進階（免費試用中，到 ${formatTrialDate(endsAt)}）`);
  assert.equal(text(byTestId(page, "trial-days-left")), `試用還有 ${trialDaysLeft(endsAt, new Date())} 天`);
  assert.match(text(byTestId(page, "usage-units")), /0 戶/);
  assert.doesNotMatch(text(byTestId(page, "usage-units")), /\/ 5/);
  assert.ok(!nodes(page).some((node) => node.props?.className === "interim-bar"));
  assertNoOffer(page);
});

test("MGT-98-AC1/AC2: d3 banner, dismissal is per user and per threshold; OFF hides it", async () => {
  const o = await makeOrg(true);
  await startTrial(o.admin.session, "pro");
  // Synthetic disposable fixture only, never a production org or a migration.
  const moveEnd = async (days: number) => db.query(
    `UPDATE app.b056_org_trials SET trial_ends_at=(((now() AT TIME ZONE 'Asia/Taipei')::date + $2::int)::timestamp AT TIME ZONE 'Asia/Taipei') WHERE org_id=$1`, [o.orgId, days]);
  await moveEnd(3);
  const banner = await trialBannerFor(o.admin.session);
  assert.ok(banner);
  assert.equal(banner.kind, "d3");
  assert.equal(banner.daysLeft, 3);
  const rendered = TrialBanner({ locale: "zh-TW", banner, next: "/m/settings" });
  assert.ok(text(rendered).includes(`進階試用將在 3 天後（${formatTrialDate(banner.endsAt)}）結束。結束後超過 5 戶的部分會改為唯讀。`));
  assert.equal(byTestId(rendered, "trial-banner-dismiss")?.props?.["aria-label"], "關閉提醒");
  assert.ok(nodes(rendered).some((node) => node.props?.href === "/pricing/apply?plan=pro"));
  await dismissTrialBanner(o.admin.session, "d3");
  assert.equal(await trialBannerFor(o.admin.session), null);
  assert.equal((await trialBannerFor(o.admin2.session))?.kind, "d3");
  await moveEnd(1);
  assert.equal((await trialBannerFor(o.admin.session))?.kind, "d1");
  await db.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{pricing_trial}','false'::jsonb) WHERE id=$1", [o.orgId]);
  assert.equal(await trialBannerFor(o.admin2.session), null);
  assert.equal(fetchCalls, 0);
});

test("display-only banner fails closed on database errors", async () => {
  const o = await makeOrg(true);
  const queries = mock.method(Client.prototype, "query", () => { throw new Error("synthetic DB failure"); });
  try { assert.equal(await trialBannerFor(o.admin.session), null); }
  finally { queries.mock.restore(); }
});
